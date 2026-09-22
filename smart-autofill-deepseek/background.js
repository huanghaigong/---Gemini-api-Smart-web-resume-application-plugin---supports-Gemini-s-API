// background.js —— service worker
// 负责：读取配置、调用 DeepSeek 兼容接口、把 AI 结果返回给内容脚本
// 数据（API Key、简历）只保存在 chrome.storage.local，不上传到除模型服务商外的任何服务器。

const DEFAULT_SETTINGS = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-v4-flash",
  // 推理模型思考较慢，填写类任务给足超时与 token
  timeoutMs: 180000,
  maxTokens: 8192,
  temperature: 0.1
};

async function getSettings() {
  const stored = await chrome.storage.local.get(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

// 若用户改用第三方中转地址，需动态申请该域名的跨域权限
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
    `缺少对 ${origin} 的访问权限。请在「设置」页保存接口地址以自动授权，或使用默认的 https://api.deepseek.com/v1`
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

async function callDeepSeek({ fields, resume, company, position }) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error("尚未配置 API Key，请点击扩展图标进入「设置」填写 DeepSeek API Key。");
  }
  await ensureOriginPermission(settings.baseUrl);

  const userPayload = {
    company: company || "",
    position: position || "",
    resume: resume || "",
    fields: fields || []
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs || 180000);

  let httpStatus = 0;
  let respText = "";
  try {
    const url = settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + settings.apiKey
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(userPayload) }
        ],
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        stream: false
      }),
      signal: controller.signal
    });
    httpStatus = resp.status;
    respText = await resp.text();
    if (!resp.ok) {
      let detail = respText;
      try {
        const j = JSON.parse(respText);
        detail = j.error?.message || j.message || respText;
      } catch (e) {}
      throw new Error(`模型接口返回 ${httpStatus}：${detail}`);
    }
    const data = JSON.parse(respText);
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    let content = msg && (msg.content || "");
    // 推理模型可能把预算消耗在 reasoning_content 上导致 content 为空
    if (!content || !content.trim()) {
      throw new Error(
        "模型正式回答为空（可能是推理模型的输出 token 额度被思考过程占满）。请在设置中把 max_tokens 调大（建议 8192 以上）后重试。"
      );
    }
    const parsed = extractJson(content);
    if (!parsed || !Array.isArray(parsed.values)) {
      throw new Error("模型返回的 JSON 结构不正确，缺少 values 数组。");
    }
    return {
      success: true,
      values: parsed.values,
      usage: data.usage || null,
      model: data.model || settings.model
    };
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("调用模型超时（超过 " + Math.round((settings.timeoutMs || 180000) / 1000) + " 秒），请稍后重试或减小页面字段数量。");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 测试连通性（设置页使用）
async function testConnection() {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("尚未填写 API Key");
  await ensureOriginPermission(settings.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const url = settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + settings.apiKey
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: "user", content: "ping，请只回复 pong" }],
        max_tokens: 256,
        stream: false
      }),
      signal: controller.signal
    });
    const text = await resp.text();
    if (!resp.ok) {
      let detail = text;
      try { detail = JSON.parse(text).error?.message || text; } catch (e) {}
      throw new Error(`接口返回 ${resp.status}：${detail}`);
    }
    return { success: true };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "open_options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }
  if (message && message.type === "autofill_match") {
    callDeepSeek(message.payload || {})
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
