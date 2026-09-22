// popup.js
const $ = (id) => document.getElementById(id);

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const data = await chrome.storage.local.get(["settings", "resumeText"]);
  const s = data.settings || {};
  const hasKey = !!s.apiKey;
  const hasRelay = !!s.relayToken;
  const hasResume = !!(data.resumeText && data.resumeText.trim());

  $("keyStatus").innerHTML = (hasKey || hasRelay)
    ? '<span class="dot ok"></span>' + (hasKey ? "API Key 已配置" : "中转令牌已配置")
    : '<span class="dot no"></span>未配置 API Key（点下方「设置」）';
  $("resumeStatus").innerHTML = hasResume
    ? '<span class="dot ok"></span>简历已录入（' + data.resumeText.trim().length + ' 字）'
    : '<span class="dot no"></span>尚未录入简历（点下方「设置」）';

  $("company").value = s.defaultCompany || "";
  $("position").value = s.defaultPosition || "";
  $("showFab").checked = s.showFab !== false;

  $("fillBtn").disabled = (!hasKey && !hasRelay) || !hasResume;
  return { hasKey, hasResume };
}

$("showFab").addEventListener("change", async () => {
  const { settings = {} } = await chrome.storage.local.get(["settings"]);
  await chrome.storage.local.set({ settings: { ...settings, showFab: $("showFab").checked } });
  const tab = await getActiveTab();
  if (tab && tab.id != null && /^https?:|^file:/.test(tab.url || "")) {
    chrome.tabs.sendMessage(tab.id, { type: "autofill_toggle_fab", show: $("showFab").checked }, () => void chrome.runtime.lastError);
  }
});

$("fillBtn").addEventListener("click", async () => {
  const msg = $("msg");
  msg.className = "msg";
  msg.textContent = "";
  const tab = await getActiveTab();
  if (!tab || tab.id == null || !/^https?:|^file:/.test(tab.url || "")) {
    msg.textContent = "请在 http/https 招聘网页上使用";
    return;
  }
  const company = $("company").value.trim();
  const position = $("position").value.trim();
  // 记住本次输入
  const { settings = {} } = await chrome.storage.local.get(["settings"]);
  await chrome.storage.local.set({ settings: { ...settings, defaultCompany: company, defaultPosition: position } });

  $("fillBtn").disabled = true;
  $("fillBtn").textContent = "正在填写，请在网页上查看...";
  try {
    const r = await chrome.tabs.sendMessage(tab.id, {
      type: "autofill_start",
      company,
      position
    });
    if (r && r.success) {
      msg.className = "msg ok";
      msg.textContent = "已触发填写：识别到 " + r.fieldCount + " 个字段，成功填入 " + r.filledCount + " 个";
    } else {
      msg.textContent = "填写失败：" + (r && r.error ? r.error : "请刷新页面后重试");
    }
  } catch (e) {
    msg.textContent = "无法连接页面，请刷新该网页后重试";
  } finally {
    $("fillBtn").disabled = false;
    $("fillBtn").innerHTML = '<span class="btn-icon">⚡</span> 立即填写本页';
  }
});

$("optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("reloadBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab && tab.id != null) chrome.tabs.reload(tab.id);
});

refresh();
