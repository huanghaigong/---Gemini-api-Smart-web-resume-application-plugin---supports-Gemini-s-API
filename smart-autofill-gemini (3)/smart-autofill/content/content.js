/* ============================================================
 * 智能网申 - AI 一键填简历  content script
 * 职责：注入悬浮窗 -> 扫描表单字段 -> 交给后台调用 Gemini 匹配 -> 模拟人工填写
 * 兼容：原生表单、React/Vue 受控组件、Ant Design / Element 自定义下拉/单选/日期
 * ============================================================ */
(() => {
  if (window.__SMART_AUTOFILL_LOADED__) return;
  window.__SMART_AUTOFILL_LOADED__ = true;

  // ---------------- 全局状态 ----------------
  const state = {
    settings: {
      showFab: true,
      overwriteFilled: false,
      highlightFilled: true,
      defaultCompany: "",
      defaultPosition: ""
    },
    resumeText: "",
    running: false
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (el) => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
  const winOf = (el) => el.ownerDocument.defaultView || window;
  const cssEscape = (s) => {
    try { return window.CSS && window.CSS.escape ? window.CSS.escape(s) : String(s).replace(/"/g, '\\"'); }
    catch (e) { return String(s).replace(/"/g, '\\"'); }
  };

  async function loadState() {
    const data = await chrome.storage.local.get(["settings", "resumeText"]);
    Object.assign(state.settings, data.settings || {});
    state.resumeText = data.resumeText || "";
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) Object.assign(state.settings, changes.settings.newValue || {});
    if (changes.resumeText) state.resumeText = changes.resumeText.newValue || "";
    if (changes.settings && ui.host) {
      ui.fab.style.display = state.settings.showFab !== false ? "flex" : "none";
    }
  });

  // ============================================================
  // 一、悬浮窗 UI（Shadow DOM 隔离，避免污染页面样式）
  // ============================================================
  const ui = { host: null, fab: null, panel: null, statusEl: null, companyInput: null, positionInput: null, startBtn: null };

  const UI_CSS = `
    :host, * { box-sizing: border-box; }
    #sa-fab{position:fixed;right:26px;bottom:96px;width:52px;height:52px;border-radius:50%;
      background:linear-gradient(135deg,#2f6bff,#5b8cff);color:#fff;display:flex;align-items:center;
      justify-content:center;font-size:22px;font-weight:700;cursor:grab;z-index:2147483646;
      box-shadow:0 6px 20px rgba(47,107,255,.4);user-select:none;font-family:"PingFang SC","Microsoft YaHei",sans-serif;}
    #sa-fab:active{cursor:grabbing;}
    #sa-panel{position:fixed;right:26px;bottom:158px;width:322px;background:#fff;border:1px solid #e6e8ec;
      border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.16);z-index:2147483647;display:none;flex-direction:column;
      overflow:hidden;font-family:"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;color:#1a1b1c;}
    .sa-head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:linear-gradient(135deg,#2f6bff,#4f81ff);color:#fff;cursor:move;}
    .sa-head .sa-dot{width:26px;height:26px;border-radius:7px;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;}
    .sa-head .sa-tt{font-size:13.5px;font-weight:600;flex:1;}
    .sa-head .sa-x{cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;opacity:.85;}
    .sa-body{padding:13px 14px;}
    .sa-body label{display:block;font-size:11.5px;color:#6b7280;margin:8px 0 4px;}
    .sa-body input{width:100%;padding:8px 10px;border:1px solid #e4e3dd;border-radius:8px;font-size:13px;outline:none;font-family:inherit;background:#fbfbfc;}
    .sa-body input:focus{border-color:#2f6bff;background:#fff;}
    .sa-go{width:100%;margin-top:13px;padding:11px;border:none;border-radius:9px;cursor:pointer;color:#fff;font-size:14px;
      font-weight:600;font-family:inherit;background:linear-gradient(135deg,#2f6bff,#4f81ff);}
    .sa-go:disabled{opacity:.65;cursor:default;}
    .sa-status{margin-top:10px;font-size:12px;color:#4b5563;min-height:32px;line-height:1.5;background:#f6f7f9;border-radius:8px;padding:8px 10px;word-break:break-all;}
    .sa-status.run{color:#1d4ed8;background:#eff4ff;}
    .sa-status.ok{color:#15803d;background:#f0fdf4;}
    .sa-status.err{color:#b91c1c;background:#fef2f2;}
    .sa-foot{display:flex;justify-content:space-between;padding:9px 14px;border-top:1px solid #f0f0ee;}
    .sa-foot button{border:none;background:none;color:#2f6bff;font-size:12px;cursor:pointer;font-family:inherit;padding:0;}
  `;

  function buildUI() {
    const host = document.createElement("div");
    host.id = "__smart_autofill_host";
    host.style.all = "initial";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${UI_CSS}</style>
      <div id="sa-fab" title="智能网申 - AI一键填简历">智</div>
      <div id="sa-panel">
        <div class="sa-head" id="sa-head">
          <div class="sa-dot">智</div>
          <div class="sa-tt">智能网申 · AI 一键填简历</div>
          <div class="sa-x" id="sa-x">×</div>
        </div>
        <div class="sa-body">
          <label>公司（可选，用于针对性自我介绍）</label>
          <input id="sa-company" type="text" placeholder="如：腾讯" />
          <label>职位（可选）</label>
          <input id="sa-position" type="text" placeholder="如：后端开发工程师" />
          <button class="sa-go" id="sa-go">⚡ 一键填写本页</button>
          <div class="sa-status" id="sa-status">就绪。打开简历填写页后点击上方按钮。</div>
        </div>
        <div class="sa-foot">
          <button id="sa-settings">设置 / 编辑简历</button>
          <button id="sa-reload">刷新页面</button>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    ui.host = host;
    ui.fab = root.getElementById("sa-fab");
    ui.panel = root.getElementById("sa-panel");
    ui.statusEl = root.getElementById("sa-status");
    ui.companyInput = root.getElementById("sa-company");
    ui.positionInput = root.getElementById("sa-position");
    ui.startBtn = root.getElementById("sa-go");

    ui.companyInput.value = state.settings.defaultCompany || "";
    ui.positionInput.value = state.settings.defaultPosition || "";
    ui.fab.style.display = state.settings.showFab !== false ? "flex" : "none";

    makeDraggable(ui.fab);
    makeDraggable(root.getElementById("sa-head"), true);

    let dragMoved = false;
    ui.fab.addEventListener("mousedown", () => (dragMoved = false));
    ui.fab.addEventListener("dragMove", () => (dragMoved = true));
    ui.fab.addEventListener("click", () => { if (!dragMoved) togglePanel(true); });
    root.getElementById("sa-x").addEventListener("click", () => togglePanel(false));
    root.getElementById("sa-settings").addEventListener("click", () => chrome.runtime.sendMessage({ type: "open_options" }));
    root.getElementById("sa-reload").addEventListener("click", () => location.reload());
    ui.startBtn.addEventListener("click", () => runFill());
  }

  // 上面 onMessage 写法需要正确持有 sendResponse，重写监听
  function setupMessages() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === "autofill_start") {
        if (msg.company) ui.companyInput.value = msg.company;
        if (msg.position) ui.positionInput.value = msg.position;
        runFill().then((r) => sendResponse(r)).catch((e) => sendResponse({ success: false, error: e.message }));
        return true; // 异步
      }
      if (msg.type === "autofill_toggle_fab") {
        ui.fab.style.display = msg.show ? "flex" : "none";
        sendResponse({ success: true });
      }
    });
  }

  function togglePanel(show) {
    ui.panel.style.display = show ? "flex" : "none";
    if (show) {
      ui.companyInput.value = ui.companyInput.value || state.settings.defaultCompany || "";
      ui.positionInput.value = ui.positionInput.value || state.settings.defaultPosition || "";
    }
  }

  function setStatus(text, kind = "") {
    ui.statusEl.textContent = text;
    ui.statusEl.className = "sa-status" + (kind ? " " + kind : "");
  }

  // 通用拖拽（fab / 标题栏）
  function makeDraggable(el, isHeader) {
    let dragging = false, moved = false, sx = 0, sy = 0, sl = 0, st = 0, target = isHeader ? ui.panel : ui.fab;
    el.addEventListener("mousedown", (e) => {
      dragging = true; moved = false;
      const r = target.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      e.preventDefault();
    });
    const move = (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      let nl = sl + dx, nt = st + dy;
      nl = Math.max(4, Math.min(nl, window.innerWidth - target.offsetWidth - 4));
      nt = Math.max(4, Math.min(nt, window.innerHeight - target.offsetHeight - 4));
      target.style.left = nl + "px"; target.style.top = nt + "px";
      target.style.right = "auto"; target.style.bottom = "auto";
      if (!isHeader) { ui.panel.style.left = nl + "px"; ui.panel.style.top = Math.max(4, nt - ui.panel.offsetHeight - 10) + "px"; ui.panel.style.right = "auto"; ui.panel.style.bottom = "auto"; }
    };
    const up = () => {
      if (dragging && moved && !isHeader) el.dispatchEvent(new CustomEvent("dragMove"));
      dragging = false;
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // ============================================================
  // 二、表单扫描
  // ============================================================
  const SKIP_INPUT_TYPES = ["hidden", "submit", "button", "reset", "image", "file", "password", "range", "color", "search"];
  const SEARCH_RE = /(搜索|检索|查询|关键词|验证码|captcha|search|keyword)/i;
  const FORM_ITEM_RE = /(ant-form-item|el-form-item|form-item|form-group|form_group|field-item|fieldItem|formItem|question|topic|item-box|form-row|form_row)/i;
  const FORM_ITEM_SEL = ".ant-form-item,.el-form-item,.form-item,.form-group,.form_group,.field-item,.fieldItem,.formItem,.question,.topic,.item-box,.form-row,.form_row";
  const SIM_SELECTOR = ".ant-select:not(.ant-select-disabled), .el-select:not(.is-disabled), .el-select:not(.is-disabled *)";
  const SIM_RADIO_WRAPPER = ".ant-radio-wrapper, .el-radio, .el-radio-button, .ant-checkbox-wrapper, .el-checkbox, .el-checkbox-button, label.el-checkbox__button, label.el-radio__button";

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) {
      // 自定义组件里隐藏的原生 input 允许放行（由 wrapper 流程处理），原生流程仍需可见
      if (!el.closest(".ant-radio-wrapper,.el-radio,.ant-checkbox-wrapper,.el-checkbox,.ant-select,.el-select")) return false;
    }
    const win = winOf(el);
    const cs = win.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
      if (!el.closest(".ant-radio-wrapper,.el-radio,.ant-checkbox-wrapper,.el-checkbox")) return false;
    }
    return true;
  }

  function isExcluded(el) {
    const hay = [el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.name, el.id, el.className || "", el.getAttribute("name")].join(" ");
    if (SEARCH_RE.test(hay)) return true;
    if (el.getAttribute("contenteditable") === "false") return true;
    return false;
  }

  function getPrecedingText(el) {
    let node = el;
    for (let depth = 0; depth < 3 && node; depth++) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (!sib.querySelector("input,textarea,select,[contenteditable]")) {
          const t = txt(sib);
          if (t && t.length <= 24) return t;
        }
        sib = sib.previousElementSibling;
      }
      const parent = node.parentElement;
      if (parent) {
        let found = "";
        for (const child of parent.childNodes) {
          if (child === node) break;
          if (child.nodeType === 3) {
            const t = child.textContent.replace(/\s+/g, " ").trim();
            if (t) found = t;
          } else if (child.nodeType === 1 && !child.querySelector("input,textarea,select,[contenteditable]")) {
            const t = txt(child);
            if (t && t.length <= 24) found = t;
          }
        }
        if (found) return found;
      }
      node = parent;
    }
    return "";
  }

  function getLabel(el) {
    const doc = el.ownerDocument;
    let label = (el.getAttribute("aria-label") || "").trim();
    if (!label) {
      const led = el.getAttribute("aria-labelledby");
      if (led) label = led.split(/\s+/).map((id) => { const x = doc.getElementById(id); return x ? txt(x) : ""; }).filter(Boolean).join(" ");
    }
    if (!label && el.id) {
      const l = doc.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (l) label = txt(l);
    }
    if (!label) label = (el.getAttribute("placeholder") || "").trim();
    if (!label) {
      const wrap = el.closest("label");
      if (wrap) label = txt(wrap);
    }
    if (!label) {
      const item = el.closest(FORM_ITEM_SEL) || el.closest(".ant-row, .el-form-item, .form-group, dd, .field");
      if (item) {
        const lab = item.querySelector(".ant-form-item-label, .el-form-item__label, label, .form-label, .field-label, .label, [class*='label']");
        if (lab) label = txt(lab);
      }
    }
    if (!label) {
      const cell = el.closest("td,th");
      if (cell) {
        const prev = cell.previousElementSibling;
        if (prev && /TH|TD/.test(prev.tagName) && txt(prev)) label = txt(prev);
        if (!label) {
          const tr = cell.parentElement;
          const th = tr ? tr.querySelector("th") : null;
          if (th && th !== cell) label = txt(th);
        }
      }
    }
    if (!label) label = getPrecedingText(el);
    if (!label) label = (el.getAttribute("title") || el.name || "").trim();
    label = label.replace(/^[*＊\s]+/, "").replace(/[：:]\s*$/, "").trim();
    return label.length > 30 ? label.slice(0, 30) : label;
  }

  function isRequired(el) {
    if (el.required) return true;
    const cls = (el.className || "") + " " + (el.parentElement ? el.parentElement.className : "");
    if (/required|ant-form-item-required|is-required/i.test(cls)) return true;
    const label = getLabel(el);
    const item = el.closest(FORM_ITEM_SEL);
    const labText = item ? txt(item.querySelector("label,.ant-form-item-label,.el-form-item__label")) : label;
    return /[*＊]/.test(labText || "");
  }

  function isFilled(el, type) {
    if (type === "contenteditable") return !!txt(el);
    if (type === "select") {
      if (!el.value) return false;
      const opt = el.options[el.selectedIndex];
      const t = opt ? txt(opt) : "";
      return !!el.value && !/^(请选择|请选择|Select)/i.test(t);
    }
    return el.value && el.value.trim() !== "";
  }

  // 单选/复选的可见选项文本
  function getCheckLabelText(input, doc) {
    if (input.id) {
      const l = doc.querySelector(`label[for="${cssEscape(input.id)}"]`);
      if (l && txt(l)) return txt(l);
    }
    const wrapper = input.closest("label, .ant-radio-wrapper, .el-radio, .ant-checkbox-wrapper, .el-checkbox");
    if (wrapper && txt(wrapper)) return txt(wrapper);
    let sib = input.nextElementSibling;
    if (sib && txt(sib) && txt(sib).length <= 20) return txt(sib);
    const p = input.parentElement;
    if (p) {
      const t = txt(p);
      if (t && t.length <= 20) return t;
    }
    return (input.getAttribute("aria-label") || input.value || "").trim();
  }

  function collectInDoc(doc, fields, idRef) {
    // ---- 1. 自定义下拉（AntD / Element）----
    doc.querySelectorAll(".ant-select, .el-select").forEach((box) => {
      if (box.closest(".ant-select .ant-select") && box.querySelector(".ant-select")) { /* 嵌套时取外层 */ }
      if (box.classList.contains("ant-select-disabled") || /is-disabled/.test(box.className)) return;
      if (box.querySelector(".ant-select") && box.classList.contains("ant-select") && box !== box.querySelector(".ant-select")) return;
      const trigger = box.querySelector(".ant-select-selector, .el-select__wrapper, .el-input__inner") || box;
      if (!isVisible(trigger) && !isVisible(box)) return;
      const label = getLabel(trigger) || getLabel(box);
      const multiple = box.classList.contains("ant-select-multiple") || box.classList.contains("el-select--multiple");
      let filled = false;
      const selItem = box.querySelector(".ant-select-selection-item, .el-select__selected-item, .ant-select-selection-rendered");
      if (selItem && txt(selItem) && !/请选择/.test(txt(selItem))) filled = true;
      const inner = box.querySelector("input.el-input__inner, .ant-select input");
      if (inner && inner.value && !/请选择/.test(inner.value)) filled = true;
      const id = "f" + idRef.n++;
      fields.push({
        id, kind: multiple ? "sim-multiselect" : "sim-select",
        aiType: multiple ? "checkbox" : "select",
        el: box, trigger, label, placeholder: "", name: inner ? inner.name : "",
        required: isRequired(trigger), options: [], filled
      });
      trigger.setAttribute("data-af-id", id);
    });

    // ---- 2. 自定义单选 / 复选（AntD / Element wrapper），按容器分组 ----
    const groups = new Map();
    doc.querySelectorAll(SIM_RADIO_WRAPPER).forEach((wrapper) => {
      const input = wrapper.querySelector("input");
      if (!input || input.disabled) return;
      if (!isVisible(wrapper)) return;
      const g = wrapper.closest(".ant-radio-group, .el-radio-group, .ant-checkbox-group, .el-checkbox-group, .ant-form-item, .el-form-item, .form-item, [class*='form-item'], fieldset, .form-group, td, dd") || wrapper.parentElement;
      if (!groups.has(g)) groups.set(g, { wrappers: [] });
      groups.get(g).wrappers.push({ wrapper, input });
    });
    groups.forEach((g, groupEl) => {
      const { wrappers } = g;
      const firstInput = wrappers[0].input;
      const isCheckbox = firstInput.type === "checkbox";
      const options = wrappers.map((w) => txt(w.wrapper)).filter(Boolean);
      const label = ((groupEl && groupEl.nodeType === 1 && getLabel(groupEl)) || getLabel(wrappers[0].wrapper) || getLabel(firstInput));
      const checked = wrappers.some((w) => w.input.checked || w.wrapper.classList.contains("ant-radio-wrapper-checked", "is-checked", "ant-checkbox-wrapper-checked"));
      // 排除"同意协议"这类单个复选也保留（AI 自行判断）
      const id = "f" + idRef.n++;
      fields.push({
        id, kind: "sim-checkgroup", aiType: isCheckbox ? "checkbox" : "radio",
        el: groupEl && groupEl.nodeType === 1 ? groupEl : wrappers[0].wrapper, wrappers, label, placeholder: "", name: firstInput.name || "",
        required: isRequired(firstInput), options, filled: checked
      });
    });

    // ---- 3. 自定义日期（AntD DatePicker / Element date-editor）----
    doc.querySelectorAll(".ant-picker, .el-date-editor").forEach((pk) => {
      if (pk.querySelector && pk.closest(".ant-picker-range, .el-date-editor--daterange") && pk.classList.contains("ant-picker")) return;
      if (/disabled/.test(pk.className)) return;
      const input = pk.querySelector("input");
      if (!input || !isVisible(pk)) return;
      const label = getLabel(input);
      const id = "f" + idRef.n++;
      const isRange = pk.classList.contains("ant-picker-range") || /daterange|datetimerange|monthrange/.test(pk.className);
      fields.push({
        id, kind: "sim-date", aiType: isRange ? "text" : "date",
        el: pk, input, label, placeholder: input.placeholder || "", name: input.name || "",
        required: isRequired(input), options: [], filled: !!(input.value || txt(pk.querySelector(".ant-picker-input input"))),
        isRange
      });
      input.setAttribute("data-af-id", id);
    });

    // ---- 4. 原生控件 ----
    doc.querySelectorAll("input, textarea, select, [contenteditable=''], [contenteditable='true']").forEach((el) => {
      // 已被自定义组件托管的元素跳过
      if (el.closest(".ant-select, .el-select, .ant-picker, .el-date-editor")) return;
      if (el.closest(".ant-radio-wrapper, .el-radio, .ant-checkbox-wrapper, .el-checkbox")) return;
      if (!isVisible(el) || isExcluded(el)) return;

      // contenteditable
      if (el.isContentEditable) {
        const filled = !!txt(el);
        if (filled && !state.settings.overwriteFilled) return;
        const id = "f" + idRef.n++;
        fields.push({ id, kind: "native", aiType: "contenteditable", el, label: getLabel(el), placeholder: el.getAttribute("placeholder") || "", name: el.name || "", required: isRequired(el), options: [], filled });
        el.setAttribute("data-af-id", id);
        return;
      }
      const tag = el.tagName;
      if (tag === "SELECT") {
        if (isFilled(el, "select") && !state.settings.overwriteFilled) return;
        const id = "f" + idRef.n++;
        const options = Array.from(el.options).map((o) => txt(o)).filter((t) => t && !/^请选择|^Select/i.test(t));
        fields.push({ id, kind: "native", aiType: "select", el, label: getLabel(el), placeholder: "", name: el.name || "", required: isRequired(el), options, filled: false });
        el.setAttribute("data-af-id", id);
        return;
      }
      if (tag === "TEXTAREA") {
        if (isFilled(el, "text") && !state.settings.overwriteFilled) return;
        const id = "f" + idRef.n++;
        fields.push({ id, kind: "native", aiType: "textarea", el, label: getLabel(el), placeholder: el.placeholder || "", name: el.name || "", required: isRequired(el), options: [], filled: false });
        el.setAttribute("data-af-id", id);
        return;
      }
      if (tag === "INPUT") {
        const type = (el.type || "text").toLowerCase();
        if (SKIP_INPUT_TYPES.includes(type)) return;
        if (type === "radio" || type === "checkbox") {
          // 原生 radio/checkbox 按 name 分组（无自定义 wrapper 的）
          const doc2 = el.ownerDocument;
          const groupKey = "__grp_" + (el.name || "__noname_" + idRef.n) + "_" + type;
          if (el[groupKey]) return;
          const formScope = el.closest("form") || doc2;
          const sibs = el.name ? Array.from(formScope.querySelectorAll(`input[name="${cssEscape(el.name)}"][type="${type}"]`)) : [el];
          const visibleSibs = sibs.filter((x) => isVisible(x) && !x.closest(".ant-radio-wrapper,.el-radio,.ant-checkbox-wrapper,.el-checkbox"));
          visibleSibs.forEach((x) => (x[groupKey] = true));
          if (!visibleSibs.length) return;
          const checked = visibleSibs.some((x) => x.checked);
          if (checked && !state.settings.overwriteFilled) return;
          const id = "f" + idRef.n++;
          const options = visibleSibs.map((x) => getCheckLabelText(x, doc2)).filter(Boolean);
          fields.push({ id, kind: "native", aiType: type, el: visibleSibs[0], inputs: visibleSibs, label: getLabel(visibleSibs[0]), placeholder: "", name: el.name || "", required: isRequired(visibleSibs[0]), options, filled: checked });
          visibleSibs[0].setAttribute("data-af-id", id);
          return;
        }
        // 普通文本/数字/日期
        if (isFilled(el, "text") && !state.settings.overwriteFilled) return;
        const id = "f" + idRef.n++;
        const aiType = ["email", "tel", "number", "date", "month", "time", "url"].includes(type) ? type : "text";
        fields.push({ id, kind: "native", aiType, el, label: getLabel(el), placeholder: el.placeholder || "", name: el.name || "", required: isRequired(el), options: [], filled: false });
        el.setAttribute("data-af-id", id);
      }
    });
  }

  // 递归同源 iframe
  function collectAll() {
    const fields = [];
    const idRef = { n: 0 };
    const walk = (doc) => {
      try { collectInDoc(doc, fields, idRef); }
      catch (e) { try { console.error("[smart-autofill] 表单扫描异常：", e); } catch (_) {} }
      doc.querySelectorAll("iframe").forEach((f) => {
        try {
          const d = f.contentDocument;
          if (d && d.body) walk(d);
        } catch (e) { /* 跨域 iframe 无法访问 */ }
      });
    };
    walk(document);
    // 限制单次字段规模，保持 DOM 顺序
    return fields.slice(0, 150);
  }

  // ============================================================
  // 三、填写引擎
  // ============================================================
  function realClick(el, win) {
    win = win || winOf(el);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const base = { bubbles: true, cancelable: true, view: win, button: 0 };
    try { el.dispatchEvent(new win.PointerEvent("pointerdown", { ...base, pointerId: 1 })); } catch (e) {}
    el.dispatchEvent(new win.MouseEvent("mousedown", base));
    try { el.dispatchEvent(new win.PointerEvent("pointerup", { ...base, pointerId: 1 })); } catch (e) {}
    el.dispatchEvent(new win.MouseEvent("mouseup", base));
    el.dispatchEvent(new win.MouseEvent("click", base));
  }

  function setNativeValue(el, value) {
    const win = winOf(el);
    const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    el.focus();
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    try { el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); } catch (e) {}
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  function setContentEditable(el, value) {
    const win = winOf(el);
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    el.dispatchEvent(new win.Event("blur", { bubbles: true }));
  }

  function pressKey(el, key) {
    const win = winOf(el);
    const code = key === "Enter" ? "Enter" : key;
    const keyCode = key === "Enter" ? 13 : 0;
    ["keydown", "keypress", "keyup"].forEach((t) => {
      el.dispatchEvent(new win.KeyboardEvent(t, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
    });
  }

  function highlight(el) {
    if (!state.settings.highlightFilled || !el || !el.style) return;
    try {
      const old = el.style.outline;
      el.style.outline = "2px solid #16a34a";
      el.style.outlineOffset = "1px";
      setTimeout(() => { el.style.outline = old; el.style.outlineOffset = ""; }, 4000);
    } catch (e) {}
  }

  function cleanValue(value, aiType) {
    let v = (value == null ? "" : String(value)).trim();
    if (aiType === "tel") v = v.replace(/^\+?86[\s-]?/, "").replace(/[\s-]/g, "");
    if (aiType === "number") { const m = v.match(/-?\d+(\.\d+)?/); v = m ? m[0] : v; }
    if (aiType === "date") {
      const m = v.match(/(\d{4})[.\-/年](\d{1,2})(?:[.\-/月](\d{1,2}))?/);
      if (m) v = `${m[1]}-${m[2].padStart(2, "0")}${m[3] ? "-" + m[3].padStart(2, "0") : "-01"}`;
    }
    if (aiType === "month") {
      const m = v.match(/(\d{4})[.\-/年](\d{1,2})/);
      if (m) v = `${m[1]}-${m[2].padStart(2, "0")}`;
    }
    return v;
  }

  function fillNative(field, value) {
    const { el, aiType, inputs } = field;
    const win = winOf(el);
    if (aiType === "select") {
      const target = matchOption(Array.from(el.options).map((o) => ({ text: txt(o), value: o.value })), value);
      if (!target) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value").set;
      setter.call(el, target.value);
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      highlight(el);
      return true;
    }
    if (aiType === "radio" || aiType === "checkbox") {
      return fillCheckGroup(inputs, value, (x) => getCheckLabelText(x, el.ownerDocument));
    }
    if (aiType === "contenteditable") {
      setContentEditable(el, value);
      highlight(el);
      return true;
    }
    const v = cleanValue(value, aiType);
    if (aiType === "date" || aiType === "month") {
      // 原生 date/month 输入框：合法格式才能赋值
      const ok = setDateInput(el, v, aiType);
      if (!ok) { setNativeValue(el, v); }
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      el.blur();
      highlight(el);
      return true;
    }
    setNativeValue(el, v);
    el.dispatchEvent(new win.Event("blur", { bubbles: true }));
    highlight(el);
    return true;
  }

  function setDateInput(el, value, aiType) {
    try {
      if (aiType === "month" && /^\d{4}-\d{2}$/.test(value)) { el.value = value; return true; }
      if (aiType === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) { el.value = value; return true; }
    } catch (e) {}
    return false;
  }

  function fillCheckGroup(inputs, value, labelFn) {
    if (!inputs || !inputs.length) return false;
    const wanted = String(value).split(/[,，、;；\/]/).map((s) => s.trim()).filter(Boolean);
    if (!wanted.length) return false;
    let clicked = false;
    inputs.forEach((node) => {
      const labelText = labelFn ? labelFn(node) : txt(node);
      const hit = wanted.some((w) => w === labelText || (labelText && (labelText.includes(w) || w.includes(labelText))));
      // checkbox 已勾选的不再点（避免反选）；radio 已选中也跳过
      if (hit && !node.checked) { realClick(node); clicked = true; }
    });
    if (clicked) highlight(inputs[0]);
    return clicked;
  }

  function matchOption(options, value) {
    const v = String(value).trim();
    return (
      options.find((o) => o.text === v) ||
      options.find((o) => o.text && (o.text.includes(v) || v.includes(o.text))) ||
      options.find((o) => o.value === v)
    );
  }

  // 等待浮层选项出现
  async function waitForOverlay(doc, timeout = 1600) {
    const t0 = Date.now();
    const SEL = `.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option:not(.ant-select-item-option-disabled),
      .el-select-dropdown:not([style*="display: none"]) .el-select-dropdown__item:not(.is-disabled),
      [role="listbox"] [role="option"], [role="listbox"] li, .el-popper li`;
    while (Date.now() - t0 < timeout) {
      let nodes = [];
      [doc, document].forEach((d) => { try { nodes = nodes.concat(Array.from(d.querySelectorAll(SEL))); } catch (e) {} });
      nodes = nodes.filter((n) => isVisible(n));
      if (nodes.length) return nodes;
      await sleep(100);
    }
    return [];
  }

  async function fillSimSelect(field, value, multiple) {
    const win = winOf(field.trigger);
    const doc = field.el.ownerDocument;
    realClick(field.trigger, win);
    const options = await waitForOverlay(doc);
    if (!options.length) {
      doc.body && (function () { realClick(doc.body, win); })();
      return false;
    }
    const wanted = multiple ? String(value).split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean) : [String(value).trim()];
    let clicked = 0;
    for (const w of wanted) {
      const target = options.find((o) => txt(o) === w) || options.find((o) => txt(o).includes(w) || w.includes(txt(o)));
      if (target) { realClick(target, win); clicked++; await sleep(120); }
      if (!multiple) break;
    }
    if (!clicked) {
      // 关闭浮层
      try { pressKey(field.trigger, "Escape"); } catch (e) {}
      return false;
    }
    if (multiple) {
      await sleep(100);
      try { pressKey(field.trigger, "Escape"); } catch (e) {}
      realClick(field.el.querySelector(".ant-select-selector") || field.trigger, win);
    }
    highlight(field.el);
    return true;
  }

  async function fillSimCheckGroup(field, value) {
    const wanted = String(value).split(/[,，、;；\/]/).map((s) => s.trim()).filter(Boolean);
    if (!wanted.length) return false;
    let clicked = false;
    for (const { wrapper, input } of field.wrappers) {
      const labelText = txt(wrapper);
      const hit = wanted.some((w) => w === labelText || labelText.includes(w) || w.includes(labelText));
      if (hit && !input.checked) { realClick(wrapper); clicked = true; await sleep(60); }
    }
    if (clicked) highlight(field.el);
    return clicked;
  }

  async function fillSimDate(field, value) {
    const win = winOf(field.input);
    const v = cleanValue(value, "date");
    field.input.scrollIntoView({ block: "center" });
    realClick(field.input, win);
    await sleep(150);
    setNativeValue(field.input, v);
    pressKey(field.input, "Enter");
    field.input.dispatchEvent(new win.Event("change", { bubbles: true }));
    field.input.dispatchEvent(new win.Event("blur", { bubbles: true }));
    try { pressKey(field.input, "Escape"); } catch (e) {}
    highlight(field.el);
    return true;
  }

  async function fillOne(field, value) {
    const v = (value == null ? "" : String(value)).trim();
    if (!v) return false;
    field.el.scrollIntoView && field.el.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(80);
    try {
      if (field.kind === "native") return fillNative(field, v);
      if (field.kind === "sim-select") return await fillSimSelect(field, v, false);
      if (field.kind === "sim-multiselect") return await fillSimSelect(field, v, true);
      if (field.kind === "sim-checkgroup") return await fillSimCheckGroup(field, v);
      if (field.kind === "sim-date") return await fillSimDate(field, v);
    } catch (e) {
      return false;
    }
    return false;
  }

  // ============================================================
  // 四、主流程
  // ============================================================
  async function runFill() {
    if (state.running) return { success: false, error: "正在填写中，请等待完成" };
    state.running = true;
    ui.startBtn.disabled = true;
    const originalBtn = ui.startBtn.textContent;
    const failFields = [];
    try {
      await loadState();
      if (!state.resumeText.trim()) {
        setStatus("尚未录入简历。请点击下方「设置 / 编辑简历」粘贴你的简历。", "err");
        return { success: false, error: "未录入简历" };
      }
      togglePanel(true);
      setStatus("正在扫描页面表单字段…", "run");
      ui.startBtn.textContent = "扫描中…";
      const fields = collectAll();
      if (!fields.length) {
        setStatus("没有在当前页面发现可填写的空字段。\n如页面是分步表单，请先进入到具体填写步骤再点击；已填字段默认跳过。", "err");
        return { success: false, error: "未发现可填写字段", fieldCount: 0, filledCount: 0 };
      }
      const company = ui.companyInput.value.trim();
      const position = ui.positionInput.value.trim();

      const aiFields = fields.map((f) => ({
        id: f.id, label: f.label, type: f.aiType,
        placeholder: f.placeholder || "", name: f.name || "",
        options: f.options || [], required: !!f.required
      }));

      ui.startBtn.textContent = "AI 匹配中…";
      setStatus(`识别到 ${fields.length} 个待填字段，正在调用 AI 依据简历匹配内容（推理模型可能需要 20-60 秒）…`, "run");

      const resp = await chrome.runtime.sendMessage({
        type: "autofill_match",
        payload: { fields: aiFields, resume: state.resumeText, company, position }
      });
      if (!resp || !resp.success) {
        setStatus("AI 匹配失败：" + (resp && resp.error ? resp.error : "未知错误"), "err");
        return { success: false, error: resp && resp.error || "AI 匹配失败", fieldCount: fields.length, filledCount: 0 };
      }

      const valueMap = new Map();
      (resp.values || []).forEach((v) => { if (v && v.id != null) valueMap.set(String(v.id), v.value); });

      ui.startBtn.textContent = "正在填写…";
      setStatus("AI 已返回结果，正在模拟人工填写…", "run");
      let filled = 0;
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const value = valueMap.get(f.id);
        if (value == null || String(value).trim() === "") continue;
        setStatus(`正在填写（${i + 1}/${fields.length}）：${f.label || f.name || "字段"}`, "run");
        const ok = await fillOne(f, value);
        if (ok) filled++; else failFields.push(f.label || f.name || f.id);
        await sleep(120);
      }

      const msg = `完成：共 ${fields.length} 个字段，成功填入 ${filled} 个。` +
        (failFields.length ? `\n以下 ${failFields.length} 个字段需手动处理（多为自定义日期/级联控件）：${failFields.slice(0, 6).join("、")}${failFields.length > 6 ? "等" : ""}` : "") +
        `\n请在提交前仔细核对，尤其是下拉、单选与日期。`;
      setStatus(msg, filled ? "ok" : "err");
      return { success: filled > 0, fieldCount: fields.length, filledCount: filled, failFields };
    } catch (e) {
      setStatus("出错：" + e.message, "err");
      return { success: false, error: e.message };
    } finally {
      state.running = false;
      ui.startBtn.disabled = false;
      ui.startBtn.textContent = originalBtn;
    }
  }

  // ============================================================
  // 启动
  // ============================================================
  (async function init() {
    await loadState();
    // 只在顶层窗口渲染悬浮窗
    if (window.top === window) {
      buildUI();
      setupMessages();
      // buildUI 内也注册了一个监听，移除重复逻辑影响：重复消息无害，但确保 runFill 只走 setupMessages
    }
  })();
})();
