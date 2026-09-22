// background.js —— service worker
// 负责：读取配置、调用 Gemini 官方接口（generateContent）、把 AI 结果返回给内容脚本
// 数据（API Key、简历）只保存在 chrome.storage.local，不上传到除模型服务商外的任何服务器。

const DEFAULT_SETTINGS = {
  apiKey: "",
  relayToken: "",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  model: "gemini-3.6-flash",
  fallbackModels: "gemini-3.5-flash, gemini-3.5-flash-lite",
  // Gemini 生成类任务给足超时与输出 token
  timeoutMs: 180000,
  maxTokens: 8192,
  temperature: 0.1
};

async function getSettings() {
  const stored = await chrome.storage.local.get(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

// 若用户改用第三方兼容地址，需动态申请该域名的跨域权限
async function ensureOriginPermission(baseUrl) {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch (e) {
    throw new Error("接口地址（Base URL）格式不正确：" + baseUrl);
  }
  const ok = await chrome.permissions.contains({ origins: [origin + "/*"] });
  if (ok) return;
  // service worker 中无法弹窗申请，交由 options 页申请；这里给出明确错误
  throw new Error(
    `缺少对 ${origin} 的访问权限。请在「设置」页保存接口地址以自动授权，或使用默认的 https://generativelanguage.googleapis.com/v1beta`
  );
}

const SYSTEM_PROMPT = `你是一个专业的网申简历自动填写助手。
用户会给你一段 JSON，字段含义：
- resume：用户的简历原文（Markdown 或纯文本），是填写信息的唯一事实来源
- company：投递的公司（可能为空）
- position：投递的职位（可能为空）
- fields：当前网页表单中待填写的字段数组，每个字段含：
  - id：字段唯一标识（原样回填，不可改动）
  - label：字段的中文标签 / 附近提示文字
  - type：字段类型，取值 text | textarea | email | tel | number | date | month | select | radio | checkbox | contenteditable
  - placeholder：输入框占位提示（可能为空）
  - name：表单元素 name 属性（可能为空）
  - options：select / radio / checkbox 的可选项文本数组（其他类型为空）
  - required：是否必填

你的任务：依据简历，为每一个字段给出最合适的填写值，并严格遵守：
1. 只输出一个 JSON 对象，不要输出任何解释、前后缀或 markdown 代码块。格式为：
   {"values":[{"id":"字段id","value":"填写值"}]}
2. value 一律为字符串。
3. radio / checkbox：value 必须从 options 给出的选项原文中挑选最匹配的一项（完全照抄选项文字）；checkbox 若需要选中多个，用英文逗号连接多个选项原文。select（下拉框）：若 options 非空，从中照抄最匹配的选项原文；若 options 为空数组（很多网站下拉是点击后才动态加载选项，扫描时取不到），仍要依据 label 和简历给出最可能的标准选项值（例如学历/学历层次给"本科/硕士/博士"、性别给"男/女"、是否服从调剂给"是/否"、期望工作城市给具体城市名），系统会在网页真实展开的选项中自动匹配。以上确实无法判断时填空字符串。
4. 文本类（text/textarea/contenteditable）：从简历中提取对应内容；自我介绍、求职意向、技能、项目描述等长文本，结合 company/position 做有针对性的组织，但不得虚构简历中不存在的经历、学校、公司、证书、成绩。
5. 日期类（date/month）：date 输出 YYYY-MM-DD，month 输出 YYYY-MM；简历只有“2021.09”这类年月时，date 类型补成该月 1 号（2021-09-01）；至今的经历结束日期留空。
6. number：只输出数字，不要单位；身高只填厘米数字、体重只填公斤数字。
7. tel：只输出 11 位手机号，去掉 +86、空格和横线；email 输出纯邮箱。
8. 简历中确实没有、也无法合理推断的信息（如紧急联系人、政治面貌、身份证号、详细门牌号），value 设为空字符串 ""，严禁编造。
9. 性别、学历、学位、毕业院校、专业、毕业时间、入学时间、邮箱、手机号等必须与简历完全一致。
10. fields 中的每一个 id 都必须出现在 values 中；不要新增 id。`;

function extractJson(text) {
  if (!text || typeof text !== "string") {
    throw new Error("模型返回内容为空");
  }
  let s = text.trim();
  // 去掉可能的 ```json 包裹
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 截取第一个 { 到最后一个 }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    s = s.slice(start, end + 1);
  }
  return JSON.parse(s);
}

// 组装 Gemini 原生 generateContent 请求
function buildGeminiBody({ systemPrompt, userPayload, settings }) {
  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [
      {
        role: "user",
        parts: [{ text: JSON.stringify(userPayload) }]
      }
    ],
    generationConfig: {
      temperature: settings.temperature,
      maxOutputTokens: settings.maxTokens
    }
  };
}

// 解析 Gemini 返回文本（candidates[].content.parts[].text 拼接）
function parseGeminiText(data) {
  const candidates = data && data.candidates;
  if (!Array.isArray(candidates) || !candidates.length) {
    const msg = data && data.error && data.error.message ? data.error.message : "模型未返回候选结果";
    throw new Error("模型接口返回异常：" + msg);
  }
  const parts = (candidates[0].content && candidates[0].content.parts) || [];
  return parts.map((p) => p.text || "").join("");
}

// ---------- 自动重试：应对 Gemini 高峰期临时过载（429/5xx）----------
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;          // 最多尝试次数（含首次）
const RETRY_BASE_DELAY_MS = 2000; // 首次退避 2s，之后翻倍

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RetryableError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RetryableError";
    this.status = status;
  }
}

// fn(attempt) 内抛 RetryableError / AbortError / 网络错误时按退避重试
async function withRetry(fn) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const retryable =
        err instanceof RetryableError ||
        err.name === "AbortError" ||
        err.name === "TypeError";
      if (!retryable || attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
    }
  }
  throw lastError;
}

// 发送一次 generateContent 请求（指定 model），返回 { status, text }
async function fetchGemini(settings, model, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = settings.baseUrl.replace(/\/+$/, "");
    const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
    const headers = { "Content-Type": "application/json" };
    // 直连模式：携带自己的 Gemini Key
    if (settings.apiKey) headers["x-goog-api-key"] = settings.apiKey;
    // 中转模式：携带中转令牌（Cloudflare Worker 按 RELAY_TOKEN 校验）
    if (settings.relayToken) headers["x-relay-token"] = settings.relayToken;
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await resp.text();
    return { status: resp.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function httpErrorDetail(status, text) {
  let detail = text;
  try {
    const j = JSON.parse(text);
    detail = j.error?.message || j.message || text;
  } catch (e) {}
  return `模型接口返回 ${status}：${detail}`;
}

// ---------- 多模型自动切换 ----------
// 主模型繁忙 / 不可用时，按顺序自动尝试备用模型

function resolveModelList(settings) {
  const list = [];
  const push = (s) => {
    const m = (s || "").trim();
    if (m && !list.includes(m)) list.push(m);
  };
  push(settings.model);
  String(settings.fallbackModels || "")
    .split(/[,，;；\s]+/)
    .forEach(push);
  return list.slice(0, 5);
}

// 判断某个模型失败后是否值得换下一个模型（繁忙/超时/模型名错误才换；密钥类错误不换）
function isModelFallbackError(err) {
  if (err instanceof RetryableError) return true;
  const msg = (err && err.message) || "";
  return /模型接口返回 (400|404)/.test(msg);
}

// 尝试单个模型：内部先自动重试，返回 { ok, result?, error?, model }
async function tryModel(model, settings, body, timeoutMs, parseOk) {
  try {
    const result = await withRetry(async () => {
      const { status, text } = await fetchGemini(settings, model, body, timeoutMs);
      if (!(status >= 200 && status < 300)) {
        const detail = httpErrorDetail(status, text);
        if (RETRYABLE_STATUS.has(status)) throw new RetryableError(detail, status);
        throw new Error(detail);
      }
      return parseOk(JSON.parse(text), model);
    });
    return { ok: true, result, model };
  } catch (error) {
    return { ok: false, error, model };
  }
}

function formatFinalError(err, model, timeoutMs) {
  if (err instanceof RetryableError) {
    return new Error(
      `模型 ${model} 当前繁忙（${err.status}），已自动重试 ${MAX_RETRIES} 次仍失败：${err.message.replace(/^模型接口返回 \d+：/, "")}。请稍后再试，或在「设置」中更换其他可用模型。`
    );
  }
  if (err.name === "AbortError") {
    return new Error("调用模型超时（超过 " + Math.round(timeoutMs / 1000) + " 秒），请稍后重试或减小页面字段数量。");
  }
  if (/模型接口返回 404/.test(err.message || "")) {
    return new Error(`模型 ${model} 不可用（404）。请在「设置」中核对模型名称，或填写备用模型。`);
  }
  return err;
}

// 顺序尝试主模型 + 备用模型
async function tryModels(settings, body, timeoutMs, parseOk) {
  const models = resolveModelList(settings);
  let lastErr = null;
  let lastModel = settings.model;
  for (const model of models) {
    const attempt = await tryModel(model, settings, body, timeoutMs, parseOk);
    if (attempt.ok) return attempt;
    lastErr = attempt.error;
    lastModel = model;
    // 没有更多模型，或该错误不值得换模型（如 Key 无效），则停止
    if (model === models[models.length - 1]) break;
    if (!isModelFallbackError(attempt.error)) break;
  }
  throw formatFinalError(lastErr, lastModel, timeoutMs);
}

async function callGemini({ fields, resume, company, position }) {
  const settings = await getSettings();
  if (!settings.apiKey && !settings.relayToken) {
    throw new Error("尚未配置 API Key 或中转令牌，请点击扩展图标进入「设置」填写 Gemini API Key（或中转令牌 + 中转接口地址）。");
  }
  await ensureOriginPermission(settings.baseUrl);

  const userPayload = {
    company: company || "",
    position: position || "",
    resume: resume || "",
    fields: fields || []
  };
  const body = buildGeminiBody({ systemPrompt: SYSTEM_PROMPT, userPayload, settings });
  const timeoutMs = settings.timeoutMs || 180000;

  const attempt = await tryModels(settings, body, timeoutMs, (data, model) => {
    const content = parseGeminiText(data);
    if (!content || !content.trim()) {
      throw new Error(
        "模型正式回答为空（可能是输出 token 额度被用尽或内容被安全策略拦截）。请在设置中把 maxOutputTokens 调大（建议 8192 以上）后重试。"
      );
    }
    const parsed = extractJson(content);
    if (!parsed || !Array.isArray(parsed.values)) {
      throw new Error("模型返回的 JSON 结构不正确，缺少 values 数组。");
    }
    return {
      success: true,
      values: parsed.values,
      usage: data.usageMetadata || null,
      model: data.modelVersion || model
    };
  });

  return attempt.result;
}

// 测试连通性（设置页使用，同样带自动重试与模型切换）
async function testConnection() {
  const settings = await getSettings();
  if (!settings.apiKey && !settings.relayToken) throw new Error("尚未填写 API Key 或中转令牌");
  await ensureOriginPermission(settings.baseUrl);
  const body = {
    contents: [{ role: "user", parts: [{ text: "ping，请只回复 pong" }] }],
    generationConfig: { maxOutputTokens: 256 }
  };
  const attempt = await tryModels(settings, body, 30000, (data) => {
    const content = parseGeminiText(data);
    if (!content || !content.trim()) {
      throw new Error("模型返回内容为空（可能被安全策略拦截），请稍后重试。");
    }
    return { success: true, reply: content };
  });
  return attempt.result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "open_options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }
  if (message && message.type === "autofill_match") {
    callGemini(message.payload || {})
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true; // 异步响应
  }
  if (message && message.type === "test_connection") {
    testConnection()
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true;
  }
  if (message && message.type === "get_settings") {
    getSettings()
      .then((s) => sendResponse({ success: true, settings: { ...s, apiKey: s.apiKey ? "***" : "" } }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
