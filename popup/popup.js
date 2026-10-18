/* ============================================================
   刷课助手 · popup 设置面板逻辑
   [SECTION:POPUP]

   - 纯原生 JavaScript，零依赖、零构建；由 popup.html 以
     <script src="popup.js">（非 module）方式引入
   - chrome.storage.local 的键名与默认值以 CONTRACTS.md §3 为
     唯一权威，禁止另造别名
   - deepseekTemperature / deepseekTimeoutMs / deepseekConcurrency
     在 spec/60 中没有 UI 控件：保存时若 storage 中已存在则原样
     回写，绝不覆盖或清空；也不为这三个键新增任何 UI
   ============================================================ */
(function () {
  "use strict";

  /* ---------- 默认值（CONTRACTS §3，仅 popup 有 UI 的 10 个键） ---------- */
  var DEFAULTS = {
    deepseekApiKey: "<YOUR_DEEPSEEK_API_KEY>", // 唯一允许的密钥占位符
    deepseekModel: "deepseek-chat",
    videoSpeed: 3,            // 范围 1–8（学习通上限 8）
    autoVideo: true,
    autoAnswer: true,
    autoSubmit: true,
    cxVideoMode: "report",    // "report"（模拟上报）| "play"（正常播放）
    cxReportBaseInterval: 58, // 上报基础间隔，秒，≥1
    showProgress: true,
    answerIntervalMs: 5000    // 答题间隔，毫秒，≥0
  };

  /* 加载时读取的键（仅 popup 有 UI 的键） */
  var READ_KEYS = Object.keys(DEFAULTS);

  /* 无 UI 但保存时必须原样保留的键（CONTRACTS §3） */
  var PRESERVE_KEYS = [
    "deepseekTemperature",
    "deepseekTimeoutMs",
    "deepseekConcurrency"
  ];

  /* 数值键的范围规则（保存与回填时统一钳制） */
  var CLAMP_RULES = {
    videoSpeed: { min: 1, max: 8 },
    cxReportBaseInterval: { min: 1, max: Infinity },
    answerIntervalMs: { min: 0, max: Infinity }
  };

  /* 数值键的中文名（用于状态提示文案） */
  var NUMBER_LABELS = {
    videoSpeed: "倍速",
    cxReportBaseInterval: "上报基础间隔",
    answerIntervalMs: "答题间隔"
  };

  /* 状态提示自动清除时长（毫秒） */
  var STATUS_CLEAR_MS = 3000;
  var statusTimer = null;

  /* ---------- 通用工具 ---------- */

  /** 宽松转布尔：boolean 原样；数字非 0 为真；字符串 "false"/"0"/空串 为假 */
  function toBoolean(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0 && !isNaN(value);
    if (typeof value === "string") {
      var t = value.trim().toLowerCase();
      return t !== "" && t !== "false" && t !== "0";
    }
    return !!value;
  }

  /** 钳制到 [min, max]；max 为 Infinity 时仅钳制下限 */
  function clampNumber(value, min, max) {
    if (min !== undefined) value = Math.max(min, value);
    if (max !== undefined && max !== Infinity) value = Math.min(max, value);
    return value;
  }

  /** 按 CLAMP_RULES 对指定键做范围钳制 */
  function clampFor(key, value) {
    var rule = CLAMP_RULES[key];
    if (!rule) return value;
    return clampNumber(value, rule.min, rule.max);
  }

  /* ---------- chrome.storage.local 的 Promise 包装（callback 风格） ---------- */

  /**
   * 读取 storage（callback 风格包装为 Promise）。
   * 防御：无 chrome 环境 / storage 不可用 / lastError / 同步抛异常
   * 一律走 reject，绝不向调用方抛异常。
   */
  function storageGet(keys) {
    return new Promise(function (resolve, reject) {
      if (typeof chrome === "undefined" || !chrome.storage ||
          !chrome.storage.local || typeof chrome.storage.local.get !== "function") {
        reject(new Error("chrome.storage.local 不可用"));
        return;
      }
      try {
        chrome.storage.local.get(keys, function (items) {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message || "读取 chrome.storage.local 失败"));
            return;
          }
          resolve(items || {});
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /** 写入 storage（callback 风格包装为 Promise），防御逻辑同 storageGet */
  function storageSet(obj) {
    return new Promise(function (resolve, reject) {
      if (typeof chrome === "undefined" || !chrome.storage ||
          !chrome.storage.local || typeof chrome.storage.local.set !== "function") {
        reject(new Error("chrome.storage.local 不可用"));
        return;
      }
      try {
        chrome.storage.local.set(obj, function () {
          var err = chrome.runtime && chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message || "写入 chrome.storage.local 失败"));
            return;
          }
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /* ---------- 状态提示 ---------- */

  /**
   * 在 #statusText 显示提示；kind 为 "ok" | "error"
   * （对应 popup.css 的 .status.ok / .status.error），
   * 3 秒后自动清除；再次调用会重置计时。
   */
  function showStatus(message, kind) {
    var el = document.getElementById("statusText");
    if (!el) return;
    el.textContent = message || "";
    el.classList.remove("ok");
    el.classList.remove("error");
    if (kind === "ok" || kind === "error") el.classList.add(kind);
    if (statusTimer !== null) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    statusTimer = setTimeout(function () {
      statusTimer = null;
      el.textContent = "";
      el.classList.remove("ok");
      el.classList.remove("error");
    }, STATUS_CLEAR_MS);
  }

  /* ---------- 倍速值文本 ---------- */

  /** 把 #videoSpeed 的当前值同步为 #videoSpeedValue 文本（如 "3x"、"2.5x"） */
  function updateSpeedLabel() {
    var speedEl = document.getElementById("videoSpeed");
    var labelEl = document.getElementById("videoSpeedValue");
    if (!speedEl || !labelEl) return;
    var v = Number(speedEl.value);
    if (!isFinite(v)) v = DEFAULTS.videoSpeed;
    labelEl.textContent = String(v) + "x";
  }

  /* ---------- 加载回填 ---------- */

  /**
   * 用 storage 读取结果回填所有控件（控件均带 data-storage-key）：
   * - 缺失键使用 DEFAULTS 兜底
   * - radio：按 cxVideoMode 值选中，未知值一律回退 "report"
   * - checkbox：按布尔值
   * - range：设置 value 并同步 #videoSpeedValue 文本（对齐 step=0.5）
   * - number：填数值（NaN 回退默认值并钳制）
   * - text：trim 后空串回退默认值（与保存行为一致）
   */
  function fillForm(items) {
    items = items || {};
    var els = document.querySelectorAll("[data-storage-key]");
    Array.prototype.forEach.call(els, function (el) {
      var key = el.getAttribute("data-storage-key");
      var raw = items[key];
      var type = el.type;

      if (type === "radio") {
        /* cxVideoMode：仅 "play" 选中 play，其余（含未知值）回退 "report" */
        var mode = raw === "play" ? "play" : "report";
        el.checked = el.value === mode;
        return;
      }

      if (type === "checkbox") {
        el.checked = raw === undefined || raw === null ? DEFAULTS[key] : toBoolean(raw);
        return;
      }

      if (type === "range") {
        var n = raw === undefined || raw === null ? DEFAULTS[key] : Number(raw);
        if (!isFinite(n)) n = DEFAULTS[key];
        n = clampFor(key, n);
        if (key === "videoSpeed") n = Math.round(n * 2) / 2; // 对齐滑杆 step=0.5
        el.value = String(n);
        updateSpeedLabel();
        return;
      }

      if (type === "number") {
        var n2 = raw === undefined || raw === null ? DEFAULTS[key] : Number(raw);
        if (!isFinite(n2)) n2 = DEFAULTS[key];
        n2 = clampFor(key, n2);
        el.value = String(n2);
        return;
      }

      /* text：trim 后空串回退默认值 */
      var s = raw === undefined || raw === null ? DEFAULTS[key] : String(raw).trim();
      if (s === "") s = DEFAULTS[key];
      el.value = s;
    });
  }

  /* ---------- 保存 ---------- */

  /**
   * 收集所有控件值：
   * - radio 取 checked 项的 value
   * - checkbox 取 checked 布尔
   * - number / range 用 Number()，NaN 回退默认值并记录提示
   * - text（apiKey / model）取 trim 后的字符串，空串回退默认值并记录提示
   * 全部数值按 CLAMP_RULES 钳制（videoSpeed 1–8、上报基础间隔 ≥1、
   * 答题间隔 ≥0）。返回 { data, notes }，notes 为回退/钳制说明。
   */
  function collectForm() {
    var data = {};
    var notes = [];
    var els = document.querySelectorAll("[data-storage-key]");
    Array.prototype.forEach.call(els, function (el) {
      var key = el.getAttribute("data-storage-key");
      var type = el.type;

      if (type === "radio") {
        if (el.checked) data[key] = el.value;
        return;
      }

      if (type === "checkbox") {
        data[key] = !!el.checked;
        return;
      }

      if (type === "range" || type === "number") {
        var n = Number(el.value);
        if (!isFinite(n)) {
          n = DEFAULTS[key];
          notes.push(NUMBER_LABELS[key] + "无效，已回填默认值 " + DEFAULTS[key]);
        }
        var clamped = clampFor(key, n);
        if (clamped !== n) {
          notes.push(NUMBER_LABELS[key] + "已按允许范围调整");
        }
        data[key] = clamped;
        return;
      }

      /* text */
      var s = el.value == null ? "" : String(el.value);
      s = s.trim();
      if (s === "") {
        s = DEFAULTS[key];
        if (key === "deepseekApiKey") notes.push("API Key 为空，已回填占位符");
        else if (key === "deepseekModel") notes.push("模型为空，已回填默认模型");
      }
      data[key] = s;
    });

    /* radio 组兜底：防御没有任何一项被选中（HTML 默认选中 report） */
    if (data.cxVideoMode === undefined) data.cxVideoMode = DEFAULTS.cxVideoMode;

    return { data: data, notes: notes };
  }

  /** 保存成功后把最终写入的值同步回控件，保证界面与 storage 一致 */
  function syncForm(data) {
    var els = document.querySelectorAll("[data-storage-key]");
    Array.prototype.forEach.call(els, function (el) {
      var key = el.getAttribute("data-storage-key");
      var v = data[key];
      if (v === undefined) return;
      var type = el.type;
      if (type === "radio") {
        el.checked = el.value === v;
      } else if (type === "checkbox") {
        el.checked = !!v;
      } else {
        el.value = String(v);
      }
    });
    updateSpeedLabel();
  }

  /** 点击 #saveBtn：收集控件值 → 保留无 UI 三键 → 写入 storage → 状态提示 */
  function onSave() {
    var collected = collectForm();
    var data = collected.data;
    var notes = collected.notes;

    storageGet(PRESERVE_KEYS)
      .then(function (existing) {
        existing = existing || {};
        /* 无 UI 的三键：storage 中已存在则原样回写；不存在则完全不写，
           由 content 端按 CONTRACTS §3 默认值兜底 */
        for (var i = 0; i < PRESERVE_KEYS.length; i++) {
          var key = PRESERVE_KEYS[i];
          if (existing[key] !== undefined) data[key] = existing[key];
        }
        return storageSet(data);
      })
      .then(function () {
        syncForm(data);
        showStatus(
          notes.length > 0 ? "已保存（" + notes.join("；") + "）" : "已保存",
          "ok"
        );
      })
      .catch(function (err) {
        showStatus(
          "保存失败：" + (err && err.message ? err.message : "未知错误"),
          "error"
        );
      });
  }

  /* ---------- 事件绑定与初始化 ---------- */

  function bindEvents() {
    /* 倍速滑杆：input 事件实时更新 #videoSpeedValue 文本 */
    var speedEl = document.getElementById("videoSpeed");
    if (speedEl) speedEl.addEventListener("input", updateSpeedLabel);

    var saveBtn = document.getElementById("saveBtn");
    if (saveBtn) saveBtn.addEventListener("click", onSave);
  }

  function init() {
    bindEvents();
    /* 先用默认值同步回填全部控件，避免 storage 异步读取期间界面空白 */
    fillForm({});
    storageGet(READ_KEYS)
      .then(function (items) {
        fillForm(items || {});
      })
      .catch(function (err) {
        /* storage 不可用：控件保持默认值，并给出错误提示 */
        showStatus(
          "无法读取已保存的设置，已使用默认值（" +
            (err && err.message ? err.message : "未知错误") + "）",
          "error"
        );
      });
  }

  init();
})();
