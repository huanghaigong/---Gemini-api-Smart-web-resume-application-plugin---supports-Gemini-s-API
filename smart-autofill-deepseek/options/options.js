// options.js
const DEFAULTS = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-v4-flash",
  timeoutMs: 180000,
  maxTokens: 8192,
  temperature: 0.1,
  showFab: true,
  overwriteFilled: false,
  highlightFilled: true,
  defaultCompany: "",
  defaultPosition: ""
};

const $ = (id) => document.getElementById(id);

async function loadAll() {
  const data = await chrome.storage.local.get(["settings", "resumeText"]);
  const s = { ...DEFAULTS, ...(data.settings || {}) };
  $("apiKey").value = s.apiKey || "";
  $("baseUrl").value = s.baseUrl || DEFAULTS.baseUrl;
  $("model").value = s.model || DEFAULTS.model;
  $("maxTokens").value = s.maxTokens ?? DEFAULTS.maxTokens;
  $("timeoutMs").value = s.timeoutMs ?? DEFAULTS.timeoutMs;
  $("temperature").value = s.temperature ?? DEFAULTS.temperature;
  $("defaultCompany").value = s.defaultCompany || "";
  $("defaultPosition").value = s.defaultPosition || "";
  $("showFab").checked = s.showFab !== false;
  $("overwriteFilled").checked = !!s.overwriteFilled;
  $("highlightFilled").checked = s.highlightFilled !== false;
  $("resumeText").value = data.resumeText || "";
}

function collectSettings() {
  return {
    apiKey: $("apiKey").value.trim(),
    baseUrl: $("baseUrl").value.trim() || DEFAULTS.baseUrl,
    model: $("model").value.trim() || DEFAULTS.model,
    maxTokens: parseInt($("maxTokens").value, 10) || DEFAULTS.maxTokens,
    timeoutMs: parseInt($("timeoutMs").value, 10) || DEFAULTS.timeoutMs,
    temperature: parseFloat($("temperature").value) || 0,
    defaultCompany: $("defaultCompany").value.trim(),
    defaultPosition: $("defaultPosition").value.trim(),
    showFab: $("showFab").checked,
    overwriteFilled: $("overwriteFilled").checked,
    highlightFilled: $("highlightFilled").checked
  };
}

function setStatus(el, text, ok) {
  el.textContent = text;
  el.className = "conn-status " + (ok ? "ok" : "err");
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4000);
}

// 自定义接口地址时，在用户点击手势内申请跨域权限
async function ensurePermission(baseUrl) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch (e) {
    alert("接口地址格式不正确：" + baseUrl);
    return false;
  }
  if (/\.deepseek\.com$/.test(new URL(baseUrl).hostname) || new URL(baseUrl).hostname === "api.deepseek.com") {
    return true; // manifest 已内置授权
  }
  const has = await chrome.permissions.contains({ origins: [origin + "/*"] });
  if (has) return true;
  return await chrome.permissions.request({ origins: [origin + "/*"] });
}

$("saveBtn").addEventListener("click", async () => {
  const s = collectSettings();
  const allowed = await ensurePermission(s.baseUrl);
  if (!allowed) {
    setStatus($("connStatus"), "未授予接口域名权限，保存中止", false);
    return;
  }
  await chrome.storage.local.set({ settings: s });
  setStatus($("connStatus"), "已保存", true);
});

$("testBtn").addEventListener("click", async () => {
  // 先保存再测试
  const s = collectSettings();
  const allowed = await ensurePermission(s.baseUrl);
  if (!allowed) { setStatus($("connStatus"), "未授予接口域名权限", false); return; }
  await chrome.storage.local.set({ settings: s });
  setStatus($("connStatus"), "正在测试（推理模型可能需要数十秒）...", true);
  $("testBtn").disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: "test_connection" });
    if (r && r.success) setStatus($("connStatus"), "连接成功，接口与密钥可用", true);
    else setStatus($("connStatus"), "连接失败：" + (r && r.error || "未知错误"), false);
  } catch (e) {
    setStatus($("connStatus"), "连接失败：" + e.message, false);
  } finally {
    $("testBtn").disabled = false;
  }
});

async function saveResume() {
  await chrome.storage.local.set({ resumeText: $("resumeText").value });
  setStatus($("resumeStatus"), "简历已保存到本地", true);
}
$("saveResumeBtn").addEventListener("click", saveResume);
let resumeTimer = null;
$("resumeText").addEventListener("input", () => {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(saveResume, 800);
});

$("savePrefBtn").addEventListener("click", async () => {
  const cur = await chrome.storage.local.get(["settings"]);
  const merged = { ...DEFAULTS, ...(cur.settings || {}), ...collectSettings() };
  await chrome.storage.local.set({ settings: merged });
  const el = document.createElement("span");
  const btn = $("savePrefBtn");
  const old = btn.textContent;
  btn.textContent = "已保存";
  setTimeout(() => (btn.textContent = old), 1500);
});

loadAll();
