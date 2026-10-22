/*
 * [SECTION:ADAPTER_UNIPUS]
 * 职责：u校园 AI 版（unipus.cn / *.unipus.cn）平台适配器（spec/40-unipus）。
 *   matches：按 hostname 判定（unipus.cn 或以 .unipus.cn 结尾）；
 *   init/destroy：幂等初始化与清理（activeContext 模式，参考 chaoxing）；
 *   installQuestionInterceptor：isolated world 侧接线 —— 幂等注入 MAIN world bridge
 *     （chrome.scripting.executeScript({world:"MAIN", files:["content/main-world-bridge.js"]}），
 *     全局标记 __COURSE_HELPER_MAIN_WORLD_BRIDGE_INJECTED__ 防重复，风格与 loader.js 的
 *     injectMainWorldBridge 一致）并注册 window "message" 监听（过滤 source==="course-helper"），
 *     接收 `course-helper:main:ucampus-question-data`（payload {code:0, content, k, encrypted, url}，
 *     CONTRACTS §2.2）并缓存到模块内（按题目顺序追加，按 content 去重）。
 *     真正的 XHR/fetch 钩子已在 content/main-world-bridge.js 实现（AGENT 07），
 *     本文件不重复实现；
 *   getQuestions：题目来源抽象接口（spec/40 降级顺序）——
 *     首选模块内拦截缓存；content 以 "unipus." 开头为密文：解密算法缺失（spec/40 已声明
 *     参考脚本后半部分丢失），console.log 密文与密钥（"u校园加密题目：content=... k=...，
 *     解密算法待补，README 已说明"）后该题跳过并计入警告，不伪造解密结果；
 *     content 不以 "unipus." 开头（明文兜底）时直接解析为题目（解析失败跳过）；
 *     缓存为空或全部无法解析时降级为渲染后 DOM 提取（spec/40 降级顺序第 3 条，
 *     选择器全部标注"需在真实页面核对"）；也探测不到时返回 [] 并警告；
 *     返回结构 {qtype, stem, options} 同时兼容 quiz-solver 的 question 输入格式
 *     （qtype 0–4、stem、options 数组；DOM 降级时 options 为纯文本数组，
 *     无 element 时 quiz-solver 只做匹配不做点击）；
 *   setAnswerQueue：向 MAIN world 发 `course-helper:main:set-ucampus-answer-queue`
 *     （payload {answers:string[]}，CONTRACTS §2.1），MAIN bridge 写入
 *     unsafeWindow.__UCAMPUS_ANSWER_CACHE__（AGENT 07 已实现）；answers 非法类型时
 *     警告返回且不发事件；
 *   installSubmitInterceptor：isolated 侧接线 —— 向 MAIN world 发
 *     `course-helper:main:set-confirm` {enabled:true}（CONTRACTS §2.1，触发 MAIN 桥接的
 *     confirm 覆写与提交拦截准备）；真正的 XHR 提交重写（/course/api/v3/newExploration/submit
 *     拦截、递归 value 叶子、先序 shift 队列、usedTime 60–120 随机）已在
 *     main-world-bridge.js 实现（AGENT 07），本函数不重复实现，只做启用接线；
 *     destroy 时发 {enabled:false} 恢复；
 *   startKeepAlive：复用 globalThis.__COURSE_HELPER_KEEP_ALIVE__（挂载名与
 *     content/keep-alive.js 的 MARKER 一致，AGENT 08 已实现），可用时调用其 start(doc)
 *     （幂等），返回函数（调用即 stop/destroy）；不可用时降级为简易 visibility/focus
 *     监听（重新可见时发一次轻量事件）并 console 警告"keep-alive 不可用"，
 *     同样返回清理函数。注意 loader 已全局启动保活（三平台统一），本函数是
 *     unipus 侧幂等接线，重复 start 安全。
 * 分区说明：
 *   "提交拦截+答案注入"的后续 isolated 侧逻辑归 AGENT 20（spec/40-unipus），
 *   本文件在 unipus-submit 分区预留追加位置；
 *   录音功能 v1 不做（spec/40 明确），代码留 TODO 注释；
 *   解密算法待补（spec/40 已声明参考脚本后半部分丢失），题目来源已抽象为
 *   getQuestions() 接口，后续补上解密即可无缝切换。
 * 本文件为 ESM 模块，零依赖，不 import 其他适配器；防御工具（safeQuery/safeQueryAll/
 * asObject/asString 等）自行实现；无 chrome 环境可 node --check 通过且可被 ESM import
 * （typeof chrome 防御）；不包含真实 API key。
 */

// ==== SECTION: unipus-selectors ====

// ---- 平台域名 ----
const UNIPUS_DOMAIN = "unipus.cn";

// ---- MAIN world 通信（CONTRACTS §2）----
const MAIN_SOURCE = "course-helper";
const MAIN_QUESTION_DATA_EVENT = "course-helper:main:ucampus-question-data";
const MAIN_ANSWER_QUEUE_EVENT = "course-helper:main:set-ucampus-answer-queue";
const MAIN_CONFIRM_EVENT = "course-helper:main:set-confirm";
// 语音题停止兜底：MAIN world 对存活 MediaRecorder 直接 stop（React 重渲染替换
// 节点导致停止按钮点击无效时使用；见 unipus-voice 分区 tryStopRecording 策略 3）。
const MAIN_STOP_RECORDING_EVENT = "course-helper:main:ucampus-stop-recording";
// 录音状态回执事件（MAIN → content）：{recording, recorderCount, stopRequested}。
const MAIN_RECORDING_STATE_EVENT = "course-helper:main:ucampus-recording-state";

// ---- MAIN bridge 注入（标记与文件路径和 loader.js 保持一致）----
const MAIN_BRIDGE_FLAG = "__COURSE_HELPER_MAIN_WORLD_BRIDGE_INJECTED__";
const MAIN_BRIDGE_FILE = "content/main-world-bridge.js";

// ---- keep-alive 全局挂载名（与 content/keep-alive.js 的 MARKER 一致）----
const KEEP_ALIVE_GLOBAL_KEY = "__COURSE_HELPER_KEEP_ALIVE__";

// ---- 加密题目数据标记（spec/40：content 以 "unipus." 开头即加密题目数据）----
const ENCRYPTED_CONTENT_PREFIX = "unipus.";
// ---- 已破译的题目密文格式（主控 2026-10-18 实测破译）----
// 平台另有 content 形态 "unipus-content:" + OpenSSL Salted base64（U2FsdGVkX1 前缀）：
//   密码固定 "unipus"，EVP_BytesToKey（MD5 迭代）派生 32 字节 key + 16 字节 iv，
//   AES-256-CBC 解密，明文为题目文本（HTML/纯文本混合）。
//   k 字段为密钥版本日期（如 20261018），不参与加解密。
const UNIPUS_CONTENT_PREFIX = "unipus-content:";
const UNIPUS_AES_PASSWORD = "unipus";
// ---- 降级保活轻量事件名（页面重新可见时派发一次）----
const DEGRADED_KEEP_ALIVE_WAKE_EVENT = "course-helper:ucampus:keep-alive-wake";

// ---- 题目容器候选（全部为通用探测候选，依次探测第一个命中的，需在真实页面核对）----
const DOM_QUESTION_CONTAINER_SELECTORS = Object.freeze([
  ".questionBox",
  ".question-box",
  ".questionLi",
  ".question-li",
  ".question-item",
  ".questionItem",
  ".topic-item",
  ".topicItem",
  ".exam-question",
  ".examQuestion",
  ".subject-item",
  ".subjectItem",
  ".tm-item",
  ".tiMu",
  ".topic",
]);

// ---- 题干候选（题容器内依次探测，需在真实页面核对）----
const DOM_STEM_SELECTOR_CANDIDATES = Object.freeze([
  ".stem",
  ".question-stem",
  ".questionStem",
  ".topic-title",
  ".topicTitle",
  ".question-title",
  ".questionTitle",
  ".mark_name",
  ".title",
  "h3",
  "h4",
]);

// ---- 选项列表兜底候选（题容器内无 radio/checkbox 时按可点击选项节点处理，需在真实页面核对）----
const DOM_OPTION_SELECTOR_CANDIDATES = Object.freeze([
  ".option-list li",
  ".options li",
  ".optionList li",
  ".answer-list li",
  ".answerList li",
  "li[data-option]",
  ".option",
  ".answer-item",
]);

// ---- 题型：题干前缀提取与映射（与 quiz-solver 的 qtype 0–4 一致）----
const UNIPUS_QUIZ_TYPE_RE =
  /(?:【|\[|（|\()\s*(单项选择题?|多项选择题?|单选题?|多选题?|填空题?|判断题?|简答题?|问答题?)\s*(?:】|\]|）|\))/;
const UNIPUS_QUIZ_TYPE_MAP = Object.freeze({
  单选: 0, 单选题: 0, 单项选择: 0, 单项选择题: 0,
  多选: 1, 多选题: 1, 多项选择: 1, 多项选择题: 1,
  填空: 2, 填空题: 2,
  判断: 3, 判断题: 3,
  简答: 4, 简答题: 4, 问答: 4, 问答题: 4,
});
// 判断题选项文本（题干未标【判断】但选项仅两枚对/错时映射 qtype 3，需在真实页面核对）
const TRUE_FALSE_OPTION_TEXT_RE = /^(?:对|错|正确|错误|是|否|√|×|true|false)$/i;

// ==== END SECTION: unipus-selectors ====

// ==== SECTION: unipus-utils ====

// ---- 模块状态（destroy 全量清理；init/destroy 均幂等）----
let activeContext = null;
let activeGeneration = 0;
let questionMessageListener = null;   // window "message" 监听函数
let questionListenerTarget = null;    // 监听器挂载目标（销毁时从同一目标移除）
let interceptedQuestions = [];        // 拦截题目数据（按题目顺序追加）
let interceptedContentSeen = null;    // 按 content 去重
let loggedEncryptedContent = null;    // 密文日志去重（每条密文只 log 一次，避免刷屏）
let keepAliveStop = null;             // startKeepAlive 返回的清理函数
let submitInterceptorEnabled = false; // set-confirm 启用状态
let bridgeInjectWarned = false;       // MAIN bridge 注入失败警告去重

function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function safeQueryAll(doc, selector) {
  if (!doc || typeof doc.querySelectorAll !== "function") return [];
  try {
    return Array.from(doc.querySelectorAll(selector));
  } catch (_error) {
    return [];
  }
}

function safeQuery(doc, selector) {
  if (!doc || typeof doc.querySelector !== "function") return null;
  try {
    return doc.querySelector(selector);
  } catch (_error) {
    return null;
  }
}

function getContextDocument(ctx) {
  return ctx && ctx.document ? ctx.document : null;
}

function getContextWindow(ctx) {
  const documentWindow = getContextDocument(ctx) && getContextDocument(ctx).defaultView;
  if (documentWindow) return documentWindow;
  if (typeof globalThis !== "undefined" && globalThis.window) return globalThis.window;
  return null;
}

function getGlobalRoot() {
  if (typeof globalThis !== "undefined" && globalThis) return globalThis;
  if (typeof window !== "undefined" && window) return window;
  return null;
}

function stripTagsHtml(html) {
  return asString(html).replace(/<[^>]*>/g, "").trim();
}

function uniqueNodes(nodes) {
  const unique = [];
  for (const node of nodes) {
    if (node && unique.indexOf(node) === -1) unique.push(node);
  }
  return unique;
}

function runCleanups(cleanups) {
  for (const cleanup of cleanups) {
    try { cleanup(); } catch (_error) {
      // 单个清理失败不能阻塞其他清理。
    }
  }
}

// 通用警告：ctx.log 优先（loader 提供），回退页面控制台（zhihuishu 同风格）。
function unipusWarn(context, message) {
  try { if (typeof pushUiLog === "function") pushUiLog(message, true); } catch (_uiLogError) { /* UI 未就绪 */ }
  if (context && typeof context.log === "function") {
    try {
      context.log(`[course-helper] ${message}`);
      return;
    } catch (_error) {
      // 日志失败不影响业务，继续走 console 回退。
    }
  }
  const view = getContextWindow(context);
  if (view && view.console && typeof view.console.warn === "function") {
    try { view.console.warn(`[course-helper] ${message}`); } catch (_error) { /* 控制台被页面替换时忽略。 */ }
  }
}

// 普通信息日志（ctx.log 优先，回退页面控制台）。
function unipusLog(context, message) {
  try { if (typeof pushUiLog === "function") pushUiLog(message, false); } catch (_uiLogError) { /* UI 未就绪 */ }
  if (context && typeof context.log === "function") {
    try {
      context.log(`[course-helper] ${message}`);
      return;
    } catch (_error) {
      // 日志失败不影响业务，继续走 console 回退。
    }
  }
  const view = getContextWindow(context);
  if (view && view.console && typeof view.console.log === "function") {
    try { view.console.log(`[course-helper] ${message}`); } catch (_error) { /* 控制台被页面替换时忽略。 */ }
  }
}

// 密文日志专用：必须落到 console（spec/40 降级顺序第 2 条：用户在 DevTools 复制
// "密文+密钥+对应明文题目"样例供人工分析算法），优先页面 console，回退全局 console。
function unipusConsoleLog(message) {
  const view = getContextWindow(activeContext);
  if (view && view.console && typeof view.console.log === "function") {
    try {
      view.console.log(`[course-helper] ${message}`);
      return;
    } catch (_error) {
      // 继续尝试全局 console。
    }
  }
  if (typeof console !== "undefined" && typeof console.log === "function") {
    try { console.log(`[course-helper] ${message}`); } catch (_error) { /* 控制台不可用时忽略。 */ }
  }
}

// 事件监听（addEventListener 优先，on* 属性回退，与 chaoxing 的 attachPlayListener 同风格）
function attachListener(target, eventName, handler, cleanups) {
  if (!target) return;
  try {
    if (typeof target.addEventListener === "function") {
      target.addEventListener(eventName, handler);
      cleanups.push(() => {
        try {
          if (typeof target.removeEventListener === "function") {
            target.removeEventListener(eventName, handler);
          }
        } catch (_error) {
          // 已失效的 DOM 清理失败可忽略。
        }
      });
      return;
    }
  } catch (_error) {
    // 回退到 on* 属性路径。
  }
  const propertyName = `on${eventName}`;
  let previous = null;
  try {
    previous = target[propertyName];
    target[propertyName] = function (event) {
      if (typeof previous === "function") {
        try { previous.call(target, event); } catch (_error) { /* 原处理器异常不阻塞恢复。 */ }
      }
      handler(event);
    };
    cleanups.push(() => {
      try { target[propertyName] = previous; } catch (_error) { /* 只读属性安全跳过。 */ }
    });
  } catch (_error) {
    // 不支持事件绑定的对象安全跳过。
  }
}

function getHostname(urlOrLocation) {
  if (!urlOrLocation) return "";
  if (typeof urlOrLocation === "string") {
    try {
      return new URL(urlOrLocation, "https://unipus.invalid").hostname;
    } catch (_error) {
      return asString(urlOrLocation).split(/[/?#]/, 1)[0];
    }
  }
  try {
    return asString(urlOrLocation.hostname);
  } catch (_error) {
    return "";
  }
}

// postMainMessage：向 MAIN world 发 postMessage（source:"course-helper"），
// 与 chaoxing 的 postMainMessage 相同风格。
function postMainMessage(ctx, type, payload) {
  const view = getContextWindow(ctx);
  if (!view || typeof view.postMessage !== "function") return false;
  try {
    view.postMessage({ source: MAIN_SOURCE, type, payload }, "*");
    return true;
  } catch (_error) {
    return false;
  }
}

// ==== END SECTION: unipus-utils ====

// ==== SECTION: unipus-question ====
// ---- 题目来源抽象（spec/40：把题目来源抽象成接口，后续补上解密即可无缝切换）----
// 题目来源链：
//   1. 首选：模块内缓存的拦截题目数据（来自 course-helper:main:ucampus-question-data
//      事件，由 main-world-bridge.js 的 XHR/fetch 钩子产出，AGENT 07 已实现）；
//      - content 以 "unipus." 开头为密文：解密算法缺失（spec/40 声明参考脚本后半部分
//        丢失），console.log 密文与密钥（降级顺序第 2 条），该题跳过并计入警告，
//        不伪造解密结果；
//      - content 不以 "unipus." 开头（明文兜底）：直接解析为题目，解析失败跳过；
//   2. 降级（spec/40 降级顺序第 3 条）：拦截缓存为空或全部无法解析时，
//      从渲染后的 DOM 提取题目文本（题目必然显示在页面上）；
//   3. 都探测不到时返回 [] 并警告。
// 输出结构统一为 {qtype, stem, options}（options 为字符串数组），同时兼容
// quiz-solver 的 question 输入格式（qtype 0–4、stem、options 数组）。

// ---- 拦截题目数据缓存（按题目顺序追加，按 content 去重）----
function ensureInterceptedContentSeen() {
  if (!interceptedContentSeen) interceptedContentSeen = Object.create(null);
  return interceptedContentSeen;
}

function handleQuestionDataPayload(payload) {
  if (!asObject(payload)) return;
  if (payload.code !== 0) return; // 契约固定 code:0
  const content = asString(payload.content);
  if (!content) return;
  if (typeof payload.k !== "string" || !payload.k) return; // 密文必须携带密钥 k
  const seen = ensureInterceptedContentSeen();
  if (seen[content]) return; // 按 content 去重（XHR 与 fetch 双钩可能重复上报同一响应）
  seen[content] = true;
  interceptedQuestions.push({
    code: 0,
    content,
    k: payload.k,
    encrypted: payload.encrypted === true,
    url: asString(payload.url),
  });
  // 主控接线：新题到达即调度一轮自动答题（防抖合并同一页连续拦截的多题；
  // SPA 切下一页后无需刷新页面——提交成功时会清空缓存并重置状态，见
  // handleSubmitPayload 的清理分支）。
  scheduleAutoAnswerForNewQuestions();
}

// 密文日志（spec/40 降级顺序第 2 条：console.log 密文+密钥，README 让用户提供
// "密文+密钥+对应明文题目"样例供人工分析算法）。每条 content 只 log 一次，避免刷屏。
function logEncryptedQuestionOnce(item) {
  if (!item) return;
  if (!loggedEncryptedContent) loggedEncryptedContent = Object.create(null);
  if (loggedEncryptedContent[item.content]) return;
  loggedEncryptedContent[item.content] = true;
  unipusConsoleLog(
    `u校园加密题目：content=${item.content} k=${item.k}，解密算法待补，README 已说明` +
    (item.url ? `（url=${item.url}）` : ""),
  );
}

// ---- 题目密文解密（主控 2026-10-18 实测破译：OpenSSL Salted + AES-256-CBC）----
// 格式："unipus-content:" + base64(Salted__ + salt8 + ciphertext)。
// 密码固定 "unipus"；EVP_BytesToKey（MD5 迭代）派生 key(32)/iv(16)；AES-256-CBC。
// 解密失败返回 null（保留密文日志与降级路径，不伪造结果）。

function resolveUnipusMd5() {
  if (typeof globalThis !== "undefined" && typeof globalThis.md5 === "function") {
    return globalThis.md5;
  }
  if (typeof require === "function") {
    for (const spec of ["../../lib/md5.js", "../lib/md5.js"]) {
      try {
        const loaded = require(spec);
        const fn = typeof loaded === "function" ? loaded : loaded && (loaded.md5 || loaded.default);
        if (typeof fn === "function") return fn;
      } catch (_error) {
        // 继续尝试下一个路径。
      }
    }
  }
  return null;
}

function decodeUnipusBase64(text) {
  const clean = asString(text).replace(/[^A-Za-z0-9+/=]/g, "");
  if (!clean) return null;
  if (typeof atob === "function") {
    try {
      const binary = atob(clean);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch (_error) {
      // atob 失败走手写回退。
    }
  }
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean.charAt(i);
    if (char === "=") break;
    const value = chars.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function bytesToLatin1(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// EVP_BytesToKey（OpenSSL 传统派生）：D_i = MD5(D_{i-1} + password + salt)，
// 按原始字节级计算（lib/md5.js 支持 Uint8Array 输入），拼接直到满足 keyLen+ivLen。
function evpBytesToKeyUnipus(password, salt, keyLen, ivLen) {
  const md5 = resolveUnipusMd5();
  if (!md5) return null;
  const passwordBytes = new TextEncoder().encode(password);
  const parts = [];
  let prevBytes = new Uint8Array(0);
  let total = 0;
  while (total < keyLen + ivLen) {
    const joined = new Uint8Array(prevBytes.length + passwordBytes.length + salt.length);
    joined.set(prevBytes, 0);
    joined.set(passwordBytes, prevBytes.length);
    joined.set(salt, prevBytes.length + passwordBytes.length);
    const digestHex = md5(joined);
    if (typeof digestHex !== "string" || !/^[0-9a-f]{32}$/.test(digestHex)) return null;
    prevBytes = hexToBytes(digestHex);
    parts.push(prevBytes);
    total += prevBytes.length;
  }
  const full = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    full.set(part, offset);
    offset += part.length;
  }
  return {
    key: full.subarray(0, keyLen),
    iv: full.subarray(keyLen, keyLen + ivLen),
  };
}

function getSubtleCrypto() {
  try {
    const root = typeof globalThis !== "undefined" ? globalThis : null;
    return root && root.crypto && root.crypto.subtle ? root.crypto.subtle : null;
  } catch (_error) {
    return null;
  }
}

async function decryptUnipusContent(content) {
  const text = asString(content);
  if (text.indexOf(UNIPUS_CONTENT_PREFIX) !== 0) return null;
  const subtle = getSubtleCrypto();
  if (!subtle) return null;
  const raw = decodeUnipusBase64(text.slice(UNIPUS_CONTENT_PREFIX.length));
  if (!raw || raw.length < 32) return null;
  // "Salted__" 魔数（8 字节）+ 8 字节盐 + 密文
  if (raw[0] !== 0x53 || raw[1] !== 0x61 || raw[2] !== 0x6c ||
      raw[3] !== 0x74 || raw[4] !== 0x65 || raw[5] !== 0x64 ||
      raw[6] !== 0x5f || raw[7] !== 0x5f) {
    return null;
  }
  const salt = raw.slice(8, 16);
  const ciphertext = raw.slice(16);
  const derived = evpBytesToKeyUnipus(UNIPUS_AES_PASSWORD, salt, 32, 16);
  if (!derived) return null;
  try {
    const cryptoKey = await subtle.importKey("raw", derived.key, { name: "AES-CBC" }, false, ["decrypt"]);
    const plain = await subtle.decrypt({ name: "AES-CBC", iv: derived.iv }, cryptoKey, ciphertext);
    return new TextDecoder().decode(plain);
  } catch (_error) {
    return null; // 解密失败保留密文日志与降级路径。
  }
}

// 解密后的题目文本解析（各题型形态待真实页面收集；当前已知"看视频填空"形态：
// Directions... + 视频时间轴控件文本 + "Write down your answer here."）。
function parseDecryptedQuestionText(plainText) {
  const clean = asString(plainText).trim();
  if (!clean) return [];
  const textOnly = stripTagsHtml(clean).replace(/\s+/g, " ").trim();
  if (!textOnly) return [];
  const isFillBlank = /write down your answer here|填写你的答案|请作答|填空/i.test(textOnly);
  const question = {
    qtype: isFillBlank ? 2 : 4,
    stem: clean,
    options: [],
    inputs: [],
    // 拦截数据的题目没有 DOM 元素：由 quiz-solver 只做答案获取（不做 DOM 填答），
    // 答案经 setAnswerQueue 下发给 MAIN bridge 在提交时注入。
    isAnswered: () => false,
  };
  return [question];
}

// ---- 第二种密文格式（主控 2026-10-18 从页面 bundle 破译）----
// 页面代码（common-*.js）：content 以 "unipus." 开头 → slice(7) 得 hex 密文，
// key = UTF8("1a2b3c4d" + k)（16 字节），AES-128-ECB + ZeroPadding 解密，
// 明文为 JSON 数组：[{id, content:"<题目JSON字符串>", answer, analysis, quesId}]。
// 题目 JSON：{replyType, contents[媒体], children[子题递归], options, rule,
//   quesText, direction{pcText,text,mText}}；叶子题 quesText 非空。
const UNIPUS_HEX_AES_KEY_PREFIX = "1a2b3c4d";
// 语音题识别（朗读/口语等需录音作答的题型）：v1 不做录音（spec/40 明确），
// 识别后按"占位跳过"处理——不送 DeepSeek 求解、答案队列占位空字符串、
// 页面不填答，提交注入时该题值叶子填入空（平台接受则相当于跳过）。
const UNIPUS_VOICE_REPLY_KEYWORDS = /speak|oral|record|voice|audio|read[-_ ]?aloud|recite|pronounc/i;
const UNIPUS_QTYPE_BY_REPLY = Object.freeze({
  "single-choice": 0,
  "singlechoice": 0,
  "multi-choice": 1,
  "multichoice": 1,
  fillblank: 2,
  "fill-blank": 2,
  "text-area": 4,
  "text-area-blank": 2,
  judge: 3,
  judgement: 3,
});

// WebCrypto 不支持 AES-ECB（AES-CBC 强制 PKCS7 去填充校验，无法处理 ZeroPadding 块），
// 因此内置紧凑的纯 JS AES-128 解密（标准 FIPS-197，S 盒表硬编码，无外部依赖）。
const AES_SBOX = new Uint8Array([
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
]);
const AES_INV_SBOX = new Uint8Array(256);
const AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
// GF(2^8) 乘法（AES 多项式 0x11b）
function aesGmul(a, b) {
  let product = 0;
  for (let i = 0; i < 8; i += 1) {
    if (b & 1) product ^= a;
    const high = a & 0x80;
    a = (a << 1) & 0xff;
    if (high) a ^= 0x1b;
    b >>= 1;
  }
  return product;
}
function aesBuildInvSbox() {
  if (AES_INV_SBOX[0x63] === 0x00) {
    for (let i = 0; i < 256; i += 1) AES_INV_SBOX[AES_SBOX[i]] = i;
  }
  return AES_INV_SBOX;
}
// AES-128 密钥扩展：16 字节 key → 176 字节轮密钥（11 轮）
function aesKeyExpansion(keyBytes) {
  const roundKeys = new Uint8Array(176);
  roundKeys.set(keyBytes, 0);
  let generated = 16;
  let rconIndex = 0;
  const temp = new Uint8Array(4);
  while (generated < 176) {
    for (let i = 0; i < 4; i += 1) temp[i] = roundKeys[generated - 4 + i];
    if (generated % 16 === 0) {
      // RotWord + SubWord + Rcon
      const first = temp[0];
      temp[0] = AES_SBOX[temp[1]] ^ AES_RCON[rconIndex];
      temp[1] = AES_SBOX[temp[2]];
      temp[2] = AES_SBOX[temp[3]];
      temp[3] = AES_SBOX[first];
      rconIndex += 1;
    }
    for (let i = 0; i < 4; i += 1) {
      roundKeys[generated] = roundKeys[generated - 16] ^ temp[i];
      generated += 1;
    }
  }
  return roundKeys;
}
// 单块 AES-128 解密（16 字节入 / 16 字节出）
function aes128DecryptBlock(block, roundKeys) {
  const state = new Uint8Array(16);
  const invSbox = aesBuildInvSbox();
  // 初始 AddRoundKey（第 10 轮密钥）
  for (let i = 0; i < 16; i += 1) state[i] = block[i] ^ roundKeys[160 + i];
  for (let round = 9; round >= 1; round -= 1) {
    // InvShiftRows
    const shifted = new Uint8Array(16);
    shifted[0] = state[0]; shifted[1] = state[13]; shifted[2] = state[10]; shifted[3] = state[7];
    shifted[4] = state[4]; shifted[5] = state[1]; shifted[6] = state[14]; shifted[7] = state[11];
    shifted[8] = state[8]; shifted[9] = state[5]; shifted[10] = state[2]; shifted[11] = state[15];
    shifted[12] = state[12]; shifted[13] = state[9]; shifted[14] = state[6]; shifted[15] = state[3];
    // InvSubBytes
    for (let i = 0; i < 16; i += 1) shifted[i] = invSbox[shifted[i]];
    // AddRoundKey
    for (let i = 0; i < 16; i += 1) shifted[i] ^= roundKeys[round * 16 + i];
    // InvMixColumns
    for (let col = 0; col < 4; col += 1) {
      const o = col * 4;
      const a0 = shifted[o]; const a1 = shifted[o + 1];
      const a2 = shifted[o + 2]; const a3 = shifted[o + 3];
      state[o] = aesGmul(a0, 0x0e) ^ aesGmul(a1, 0x0b) ^ aesGmul(a2, 0x0d) ^ aesGmul(a3, 0x09);
      state[o + 1] = aesGmul(a0, 0x09) ^ aesGmul(a1, 0x0e) ^ aesGmul(a2, 0x0b) ^ aesGmul(a3, 0x0d);
      state[o + 2] = aesGmul(a0, 0x0d) ^ aesGmul(a1, 0x09) ^ aesGmul(a2, 0x0e) ^ aesGmul(a3, 0x0b);
      state[o + 3] = aesGmul(a0, 0x0b) ^ aesGmul(a1, 0x0d) ^ aesGmul(a2, 0x09) ^ aesGmul(a3, 0x0e);
    }
  }
  // 最后一轮（无 MixColumns）
  const shifted = new Uint8Array(16);
  shifted[0] = state[0]; shifted[1] = state[13]; shifted[2] = state[10]; shifted[3] = state[7];
  shifted[4] = state[4]; shifted[5] = state[1]; shifted[6] = state[14]; shifted[7] = state[11];
  shifted[8] = state[8]; shifted[9] = state[5]; shifted[10] = state[2]; shifted[11] = state[15];
  shifted[12] = state[12]; shifted[13] = state[9]; shifted[14] = state[6]; shifted[15] = state[3];
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = invSbox[shifted[i]] ^ roundKeys[i];
  return out;
}
// AES-128-ECB 解密（ZeroPadding 由调用方处理）
function aes128EcbDecrypt(cipherBytes, keyBytes) {
  if (!cipherBytes || cipherBytes.length % 16 !== 0 || !keyBytes || keyBytes.length !== 16) {
    return null;
  }
  const roundKeys = aesKeyExpansion(keyBytes);
  const out = new Uint8Array(cipherBytes.length);
  for (let offset = 0; offset < cipherBytes.length; offset += 16) {
    out.set(aes128DecryptBlock(cipherBytes.subarray(offset, offset + 16), roundKeys), offset);
  }
  return out;
}

async function decryptUnipusHexContent(content, k) {
  const text = asString(content);
  if (text.indexOf(ENCRYPTED_CONTENT_PREFIX) !== 0) return null;
  const hex = text.slice(ENCRYPTED_CONTENT_PREFIX.length);
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 32 !== 0) return null;
  const keyBytes = new TextEncoder().encode(UNIPUS_HEX_AES_KEY_PREFIX + asString(k));
  if (keyBytes.length !== 16) return null;
  const out = aes128EcbDecrypt(hexToBytes(hex), keyBytes);
  if (!out) return null;
  // ZeroPadding：去掉尾部 0 字节。
  let end = out.length;
  while (end > 0 && out[end - 1] === 0) end -= 1;
  return new TextDecoder().decode(out.subarray(0, end));
}

// 题目 JSON 解析：外层数组每项 content 为题目 JSON 字符串；
// 递归 children 收集叶子题（quesText 非空），题干 = 祖先 direction 文本 + 自身 quesText。
// 实测形态补充：填空题的题目文本可能在 contents[].text（含 1)____1____ 占位符），
// 其 children 为无文本空壳（对应填空位），解析时并入 stem、空壳跳过。
// ---- 选择题页面填答（主控 2026-10-18 实测：quiz-solver 对 qtype 0/1/3 会尝试
// 页面点击选项，需要题目对象提供 clickOption 回调，否则报
// "adapter did not provide a clickable target"）----
// 点击策略（选项 DOM 结构需在真实页面核对，按通用结构实现）：
//   1. 作答区 .layout-reply-container 内 input[type=radio/checkbox] 按 DOM 顺序与
//      题目 options 数组顺序一致，取第 optionIndex 个；优先点击其 label（若有），
//      否则点击 input 本身（click 事件冒泡可达框架监听）。
//   2. 无 radio/checkbox 时，按选项文本匹配作答区内最深文本元素，点击其自身或
//      最近可点击祖先（label / role=radio/checkbox / li / a）。
// 找不到目标返回 false（quiz-solver 记为 click-failed 并跳过该题，提交注入兜底）。

function choiceOptionText(option) {
  if (typeof option === "string") return option.trim();
  if (option && typeof option === "object") {
    return asString(option.text !== undefined ? option.text :
      (option.optionText !== undefined ? option.optionText :
        (option.content !== undefined ? option.content :
          (option.label !== undefined ? option.label : option.value)))).trim();
  }
  return "";
}

function choiceContainers(doc) {
  const containers = [];
  for (const selector of ["#main-content .layout-reply-container", ".layout-reply-container"]) {
    const found = safeQueryAll(doc, selector);
    if (found.length) {
      containers.push(...found);
      break; // 第一个命中的候选作为容器来源
    }
  }
  return containers;
}

// 按题干文本定位题块（一页多题时避免跨题点错选项）：先找含题干文本的最深元素，
// 再向上找最近的含 radio/checkbox 的祖先（题块），找不到题块时回退整容器。
function findStemElement(container, stemText) {
  if (!container || !stemText) return null;
  const normalizedStem = stemText.replace(/\s+/g, "");
  if (!normalizedStem) return null;
  // 完整题干优先；失败则尝试尾部片段（direction 主题干可能渲染在公共区域，
  // 题干核心（quesText）在拼接串末尾）。
  const candidates = [normalizedStem];
  for (const len of [60, 40, 20]) {
    if (normalizedStem.length > len) candidates.push(normalizedStem.slice(-len));
  }
  for (const candidate of candidates) {
    const all = safeQueryAll(container, "*");
    let best = null;
    let bestLength = Infinity;
    for (const element of all) {
      const elementText = asString(element.textContent).replace(/\s+/g, "");
      if (!elementText || elementText.length >= bestLength) continue;
      if (elementText.indexOf(candidate) !== -1) {
        best = element;
        bestLength = elementText.length;
      }
    }
    if (best) return best;
  }
  return null;
}

function findChoiceBlock(stemElement, container) {
  let node = stemElement;
  while (node && node !== container) {
    const radios = safeQueryAll(node,
      "input[type=radio], input[type=checkbox], .option-wrap");
    if (radios.length) return node;
    try {
      node = node.parentElement || null;
    } catch (_error) {
      node = null;
    }
  }
  return null;
}

// 收集作答块内 div.option-wrap 的直接子元素作为选项（用户实测结构：
// .layout-reply-container ... div.option-wrap > div 即选项，可点击 div）。
function collectOptionItems(block) {
  const items = [];
  if (!block) return items;
  const wraps = safeQueryAll(block, ".option-wrap");
  for (const wrap of wraps) {
    let children = [];
    try {
      children = Array.from(wrap.children || []);
    } catch (_error) {
      children = [];
    }
    for (const child of children) {
      if (child) items.push(child);
    }
  }
  return items;
}

// 元素描述（诊断日志用）：tagName/class/文本摘要。
function describeElement(element) {
  if (!element) return "null";
  const tagName = asString(element.tagName).toLowerCase() || "?";
  let className = "";
  try {
    className = asString(element.className).slice(0, 40);
  } catch (_error) {
    className = "";
  }
  const text = asString(element.textContent).replace(/\s+/g, " ").trim().slice(0, 30);
  return `<${tagName} class="${className}" text="${text}">`;
}

function clickUnipusChoiceOption(question, optionIndex, option) {
  const doc = getContextDocument(activeContext);
  if (!doc) return false;
  const text = choiceOptionText(option);
  const stemText = question && question.stem ? stripTagsHtml(asString(question.stem)) : "";
  const containers = choiceContainers(doc);
  let radioCount = 0;
  for (const container of containers) {
    // 题块定位：按题干文本找题块（一页多题的场景），失败回退整容器。
    let choiceBlock = container;
    const stemElement = stemText ? findStemElement(container, stemText) : null;
    if (stemElement) {
      const block = findChoiceBlock(stemElement, container);
      if (block) choiceBlock = block;
    }
    // 策略 0（用户实测结构）：div.option-wrap 直接子元素按 DOM 顺序 = 选项。
    const optionItems = collectOptionItems(choiceBlock);
    if (optionItems.length > optionIndex) {
      const target = optionItems[optionIndex];
      if (clickElementSafely(activeContext, target)) {
        unipusLog(activeContext,
          `u校园选项点击：第 ${optionIndex} 个选项 → ${describeElement(target)}`);
        return true;
      }
    }
    // 策略 1：题块内 radio/checkbox 按 DOM 顺序取第 optionIndex 个。
    const choiceInputs = safeQueryAll(choiceBlock, "input[type=radio], input[type=checkbox]");
    if (choiceInputs.length) radioCount = choiceInputs.length;
    if (choiceInputs.length > optionIndex) {
      const input = choiceInputs[optionIndex];
      let target = null;
      try {
        if (typeof input.closest === "function") {
          target = input.closest("label");
          if (!target && input.parentElement) target = input.parentElement;
        }
      } catch (_error) {
        target = null;
      }
      if (clickElementSafely(activeContext, target || input)) {
        unipusLog(activeContext,
          `u校园选项点击（radio）：第 ${optionIndex} 个 → ${describeElement(target || input)}`);
        return true;
      }
    }
    // 策略 2：按选项文本匹配题块内最深文本元素。
    if (text) {
      const all = safeQueryAll(choiceBlock, "*");
      let best = null;
      let bestLength = Infinity;
      const normalizedTarget = text.replace(/\s+/g, "");
      for (const element of all) {
        const elementText = asString(element.textContent).trim();
        if (!elementText || elementText.length >= bestLength) continue;
        const normalized = elementText.replace(/\s+/g, "");
        if (normalized === normalizedTarget || normalized.endsWith(normalizedTarget)) {
          best = element;
          bestLength = elementText.length;
        }
      }
      if (best) {
        let target = best;
        try {
          const clickable = typeof best.closest === "function"
            ? best.closest('label, [role="radio"], [role="checkbox"], li, a')
            : null;
          if (clickable) target = clickable;
        } catch (_error) {
          target = best;
        }
        if (clickElementSafely(activeContext, target)) {
          unipusLog(activeContext,
            `u校园选项点击（文本匹配）：第 ${optionIndex} 个选项 → ${describeElement(target)}`);
          return true;
        }
      }
    }
  }
  unipusWarn(activeContext,
    `u校园选项点击未命中：optionIndex=${optionIndex}，选项文本="${text}"，` +
    `题块内 radio/checkbox 共 ${radioCount} 个（选项 DOM 结构需在真实页面核对）。`);
  return false;
}

// 给选择题题目对象挂 clickOption 回调（quiz-solver 优先调用，见其 callFillChoiceAnswer）。
function withChoiceClick(question) {
  if (!question || typeof question !== "object") return question;
  const qtype = question.qtype;
  if (qtype !== 0 && qtype !== 1 && qtype !== 3) return question;
  question.clickOption = (optionIndex, option) =>
    clickUnipusChoiceOption(question, optionIndex, option);
  return question;
}

// 题干/答案文本清洗：剥离题号前缀（"1)" "2、" "3." "1：" 等）。
// u校园填空题目文本（contents[].text）常以题号开头，若原样传给 DeepSeek，
// 模型可能把题号一并写进答案；答案返回后同样剥离，防止题号被填入空位。
function stripQuestionNumber(text) {
  return asString(text).replace(/^\s*\d+\s*[)）．.、:：]\s*/, "").trim();
}

// 未知题型诊断：replyType 不在映射表时每条 log 一次（供主控核对真实页面补充
// 映射，如语音题的 replyType 值）。
let loggedUnknownReplyTypes = null;
function logUnknownReplyTypeOnce(replyType) {
  if (!replyType) return;
  if (!loggedUnknownReplyTypes) loggedUnknownReplyTypes = Object.create(null);
  if (loggedUnknownReplyTypes[replyType]) return;
  loggedUnknownReplyTypes[replyType] = true;
  unipusConsoleLog(
    `u校园未知题型：replyType=${replyType}（若为语音/朗读题将按占位跳过处理，映射表可补充）`,
  );
}

// 答案树叶子计数（与 main-world-bridge 的 collectValueLeaves 同规则）：
// 数组递归元素；有 children 数组递归 children；否则有 value 属性计 1 个叶子。
// 用于语音题占位：提交注入按 value 叶子先序 shift，语音题的叶子数决定占位数。
function countAnswerTreeLeaves(node) {
  if (Array.isArray(node)) {
    let count = 0;
    for (const item of node) count += countAnswerTreeLeaves(item);
    return count;
  }
  if (!node || typeof node !== "object") return 0;
  if (Array.isArray(node.children)) {
    let count = 0;
    for (const child of node.children) count += countAnswerTreeLeaves(child);
    return count;
  }
  return Object.prototype.hasOwnProperty.call(node, "value") ? 1 : 0;
}

function parseUnipusQuestionJson(plainText) {
  const pick = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
  const questions = [];
  let parsed = null;
  try {
    parsed = JSON.parse(asString(plainText));
  } catch (_error) {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const contentsText = (node) => {
    const parts = [];
    for (const item of Array.isArray(node && node.contents) ? node.contents : []) {
      const text = stripQuestionNumber(
        stripTagsHtml(asString(item && item.text)).replace(/\s+/g, " ").trim(),
      );
      if (text) parts.push(text);
    }
    return parts.join(" ");
  };
  const collect = (node, ancestorText) => {
    if (!node || typeof node !== "object") return;
    const ownText = stripQuestionNumber(
      stripTagsHtml(asString(node.quesText)).replace(/\s+/g, " ").trim(),
    );
    const ownContents = contentsText(node);
    let stem = ancestorText;
    // direction 主题干在前，自身 quesText/contents 文本追加在后。
    const direction = asObject(node.direction);
    const dirText = stripTagsHtml(
      asString(pick(direction && direction.pcText, direction && direction.text,
        direction && direction.mText)),
    ).replace(/\s+/g, " ").trim();
    if (dirText) stem = stem ? `${stem} ${dirText}` : dirText;
    if (ownText) {
      stem = stem ? `${stem} ${ownText}` : ownText;
    } else if (ownContents) {
      // 填空题等题型的题目文本可能在 contents[].text。
      stem = stem ? `${stem} ${ownContents}` : ownContents;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    if ((ownText || ownContents) && !children.length) {
      // 叶子题：题干非空且无子题。
      const replyType = asString(node.replyType).toLowerCase();
      const qtype = UNIPUS_QTYPE_BY_REPLY[replyType] !== undefined
        ? UNIPUS_QTYPE_BY_REPLY[replyType]
        : 4;
      const isVoice = UNIPUS_VOICE_REPLY_KEYWORDS.test(replyType);
      if (!isVoice && UNIPUS_QTYPE_BY_REPLY[replyType] === undefined) {
        logUnknownReplyTypeOnce(replyType);
      }
      const options = (Array.isArray(node.options) ? node.options : [])
        .map((option) => {
          if (typeof option === "string") return stripTagsHtml(option);
          if (option && typeof option === "object") {
            return stripTagsHtml(asString(pick(
              option.optionText, option.text, option.content, option.label, option.value,
            )));
          }
          return "";
        })
        .filter((option) => option);
      questions.push(withChoiceClick({
        qtype,
        stem,
        options,
        inputs: [],
        isAnswered: () => false,
        __isVoice: isVoice,
      }));
      return;
    }
    const countBefore = questions.length;
    for (const child of children) collect(child, stem);
    if ((ownText || ownContents) && questions.length === countBefore) {
      // children 为无文本空壳（如填空题的空位占位节点）：节点自身即题目。
      const replyType = asString(node.replyType).toLowerCase();
      const qtype = UNIPUS_QTYPE_BY_REPLY[replyType] !== undefined
        ? UNIPUS_QTYPE_BY_REPLY[replyType]
        : 4;
      const isVoice = UNIPUS_VOICE_REPLY_KEYWORDS.test(replyType);
      if (!isVoice && UNIPUS_QTYPE_BY_REPLY[replyType] === undefined) {
        logUnknownReplyTypeOnce(replyType);
      }
      questions.push(withChoiceClick({
        qtype,
        stem,
        options: [],
        inputs: [],
        isAnswered: () => false,
        __isVoice: isVoice,
      }));
    }
  };
  for (const entry of entries) {
    if (entry && typeof entry === "object") {
      let inner = entry.content;
      if (typeof inner === "string") {
        try {
          inner = JSON.parse(inner);
        } catch (_error) {
          continue;
        }
      }
      // 答案树叶子数：提交注入按叶子先序 shift，语音题占位数须与之一致。
      // 一个 entry 恰好产出 1 题时叶子数归属该题（多题条目无法精确分配，回退占位 1）。
      let answerLeaves = 0;
      if (typeof entry.answer === "string" && entry.answer) {
        try {
          answerLeaves = countAnswerTreeLeaves(JSON.parse(entry.answer));
        } catch (_error) {
          answerLeaves = 0;
        }
      }
      const countBefore = questions.length;
      collect(inner, "");
      if (answerLeaves > 1 && questions.length === countBefore + 1) {
        questions[questions.length - 1].__answerLeafCount = answerLeaves;
      }
    }
  }
  return questions;
}

// ---- 明文兜底解析 ----
// content 为 JSON 字符串（平台响应结构未知，字段别名探测需在真实页面核对）。
// 一条 content 可能包含多道题；解析失败返回 []（该条跳过）。
function parsePlaintextQuestionData(content) {
  const text = asString(content);
  if (!text) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    return [];
  }
  const entries = findPlaintextQuestionEntries(parsed);
  if (!entries.length) return [];
  const questions = [];
  for (const entry of entries) {
    const question = buildPlaintextQuestion(entry);
    if (question) questions.push(question);
  }
  return questions;
}

// 顶层题目数组探测（字段别名需在真实页面核对）：
// 数组直接视为题目列表；对象探测 questions/items/list/data.questions 等键；
// 对象自身带题干字段时视为单道题。
function findPlaintextQuestionEntries(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.filter((entry) => asObject(entry));
  }
  if (!asObject(parsed)) return [];
  const data = asObject(parsed.data);
  const candidateKeys = ["questions", "items", "list", "topicList", "questionList", "subjects", "datas"];
  for (const key of candidateKeys) {
    const value = parsed[key] !== undefined ? parsed[key] : (data && data[key]);
    if (Array.isArray(value)) {
      const entries = value.filter((entry) => asObject(entry));
      if (entries.length) return entries;
    }
  }
  // 单道题对象
  if (parsed.stem !== undefined || parsed.questionStem !== undefined ||
      parsed.title !== undefined || parsed.question !== undefined) {
    return [parsed];
  }
  return [];
}

function buildPlaintextQuestion(entry) {
  if (!asObject(entry)) return null;
  const qtype = extractPlaintextQuestionType(
    entry.qtype !== undefined ? entry.qtype :
      (entry.type !== undefined ? entry.type :
        (entry.questionType !== undefined ? entry.questionType : entry.kind)),
  );
  if (qtype === null) return null;
  let stem = entry.stem !== undefined ? entry.stem :
    (entry.questionStem !== undefined ? entry.questionStem :
      (entry.title !== undefined ? entry.title :
        (entry.text !== undefined ? entry.text : entry.content)));
  stem = asString(stem);
  if (!stripTagsHtml(stem)) return null;
  const optionSource = entry.options !== undefined ? entry.options :
    (entry.choices !== undefined ? entry.choices :
      (entry.answerOptions !== undefined ? entry.answerOptions : []));
  const options = [];
  if (Array.isArray(optionSource)) {
    for (const raw of optionSource) {
      const text = plaintextOptionText(raw);
      if (text && options.indexOf(text) === -1) options.push(text);
    }
  }
  return withChoiceClick({ qtype, stem, options });
}

// 题型解析：数字 0–4 直接校验；类型名（中/英文）映射；与 quiz-solver 的 qtype 一致。
function extractPlaintextQuestionType(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 4 ? value : null;
  }
  const text = asString(value).trim();
  if (!text) return null;
  if (/^[0-4]$/.test(text)) return Number(text);
  const compact = text.toLowerCase().replace(/[\s_]+/g, "");
  const mapped = UNIPUS_QUIZ_TYPE_MAP[compact];
  if (mapped !== undefined) return mapped;
  if (/多项?选择|multiple/.test(compact)) return 1;
  if (/单项?选择|single/.test(compact)) return 0;
  if (/填空|blank/.test(compact)) return 2;
  if (/判断|true.*false|false.*true|judg/.test(compact)) return 3;
  if (/简答|问答|short|essay/.test(compact)) return 4;
  return null;
}

// 选项元素文本化：字符串直接清洗；对象取 text/label/value/html 字段（quiz-solver 同款字段）。
function plaintextOptionText(option) {
  if (option === null || option === undefined) return "";
  if (typeof option === "string") return stripTagsHtml(option);
  if (typeof option === "number" || typeof option === "boolean") return asString(option).trim();
  if (asObject(option)) {
    for (const key of ["text", "label", "value", "html"]) {
      if (option[key] !== undefined && option[key] !== null) {
        const candidate = stripTagsHtml(option[key]);
        if (candidate) return candidate;
      }
    }
  }
  return stripTagsHtml(option);
}

// ---- DOM 降级提取（spec/40 降级顺序第 3 条：题目必然显示在页面上）----
// 容器/题干/选项选择器均为通用探测候选（全部标注"需在真实页面核对"）；
// 容器候选依次探测，第一个命中的候选作为容器来源（探测顺序需在真实页面核对）。
function extractQuestionsFromDom(doc) {
  const target = doc || getContextDocument(activeContext);
  if (!target || typeof target.querySelectorAll !== "function") {
    unipusWarn(activeContext, "u校园 DOM 降级：文档不可用，无法提取题目。");
    return [];
  }
  let containers = [];
  for (const selector of DOM_QUESTION_CONTAINER_SELECTORS) {
    containers = safeQueryAll(target, selector);
    if (containers.length) break;
  }
  if (!containers.length) {
    unipusWarn(activeContext, "u校园 DOM 降级：题目容器候选均未命中（选择器需在真实页面核对）。");
    return [];
  }
  const questions = [];
  let ignored = 0;
  for (const container of uniqueNodes(containers)) {
    const question = buildDomQuestion(container);
    if (question) questions.push(question);
    else ignored += 1;
  }
  if (ignored > 0) {
    unipusWarn(activeContext,
      `u校园 DOM 降级：有 ${ignored} 个题目容器无法解析（缺少题干/题型/选项/输入框），已跳过。`);
  }
  return questions; // 探测不到任何题目时返回 []
}

function extractDomQuestionType(stemHtml) {
  const match = UNIPUS_QUIZ_TYPE_RE.exec(asString(stemHtml));
  if (!match) return null;
  const mapped = UNIPUS_QUIZ_TYPE_MAP[match[1]];
  return mapped === undefined ? null : mapped;
}

function readDomTextInputs(container) {
  const inputs = [];
  for (const element of safeQueryAll(container, 'input[type="text"], input:not([type]), textarea')) {
    const tag = asString(element.tagName).toLowerCase();
    const type = asString(element.type).toLowerCase();
    if (tag === "input" && type === "hidden") continue;
    if (inputs.indexOf(element) === -1) inputs.push(element);
  }
  return inputs;
}

// 选项文本：input 的 label 或父级（点击 label/li 联动 radio/checkbox，需在真实页面核对）；
// 空时回退 value 属性。
function domChoiceOptionText(input, container) {
  let target = null;
  try {
    if (typeof input.closest === "function") target = input.closest("label");
    if (!target && input.id) {
      let doc = null;
      try { doc = container.ownerDocument || null; } catch (_error) { doc = null; }
      if (!doc && typeof document !== "undefined") doc = document;
      if (doc) target = safeQuery(doc, `label[for="${input.id}"]`);
    }
    if (!target) {
      const parent = input.parentElement;
      if (parent && asString(parent.tagName).toLowerCase() === "label") target = parent;
    }
    if (!target && typeof input.closest === "function") target = input.closest("li");
    if (!target) target = input.parentElement || input;
  } catch (_error) {
    target = input;
  }
  if (!target) target = input;
  let text = stripTagsHtml(target === input ? asString(input.value) : asString(target.innerHTML));
  if (!text) {
    text = asString(input.getAttribute && input.getAttribute("value")).trim() ||
      asString(input.value).trim();
  }
  return text;
}

// DOM 降级时 options 为纯文本数组（无 element：quiz-solver 只做匹配不做点击）。
function readDomOptions(container, choiceInputs) {
  const texts = [];
  if (choiceInputs.length) {
    for (const input of choiceInputs) {
      const text = domChoiceOptionText(input, container);
      if (text && texts.indexOf(text) === -1) texts.push(text);
    }
    if (texts.length) return texts;
  }
  // 兜底：无 radio/checkbox 时按选项列表候选处理（可点击 div/li 选项，需在真实页面核对）
  for (const selector of DOM_OPTION_SELECTOR_CANDIDATES) {
    for (const node of safeQueryAll(container, selector)) {
      const text = stripTagsHtml(asString(node.innerHTML));
      if (text && texts.indexOf(text) === -1) texts.push(text);
    }
  }
  return texts;
}

function isTrueFalseOptionTexts(texts) {
  if (!Array.isArray(texts) || texts.length !== 2) return false;
  return texts.every((text) => TRUE_FALSE_OPTION_TEXT_RE.test(text));
}

// 已答检测（附加字段，兼容 quiz-solver 的 already-answered 判断；需在真实页面核对）
function domChoiceAnswered(choiceInputs) {
  for (const input of choiceInputs) {
    try {
      if (input && input.checked === true) return true;
    } catch (_error) {
      // 忽略。
    }
  }
  return false;
}

function domInputsAnswered(inputs) {
  if (!inputs || !inputs.length) return false;
  for (const input of inputs) {
    let value = "";
    try {
      value = input && input.value !== undefined ? input.value : "";
    } catch (_error) {
      value = "";
    }
    if (asString(value).trim()) return true;
  }
  return false;
}

function buildDomQuestion(container) {
  if (!container || typeof container.querySelectorAll !== "function") return null;

  // 题干：容器内候选选择器依次探测（需在真实页面核对），无命中回退容器自身
  let stemNode = null;
  for (const selector of DOM_STEM_SELECTOR_CANDIDATES) {
    stemNode = safeQuery(container, selector);
    if (stemNode) break;
  }
  let stemHtml = stemNode ? asString(stemNode.innerHTML) : "";
  if (!stripTagsHtml(stemHtml)) {
    // 回退：容器自身 HTML（含选项文本时由 quiz-solver 清洗题干，需在真实页面核对）
    stemHtml = asString(container.innerHTML);
  }
  if (!stripTagsHtml(stemHtml)) return null;

  // 题型：从题干前缀【单选】等提取（与 quiz-solver 的 qtype 0–4 映射一致）
  let qtype = extractDomQuestionType(stemHtml);

  // 选项输入（radio/checkbox）
  const choiceInputs = [];
  for (const element of safeQueryAll(container, 'input[type="radio"], input[type="checkbox"]')) {
    const type = asString(element.type).toLowerCase();
    if (type !== "radio" && type !== "checkbox") continue;
    if (choiceInputs.indexOf(element) === -1) choiceInputs.push(element);
  }
  // 文本输入（填空/简答）：input[type=text]、无 type 的 input、textarea（排除 hidden）
  const textInputs = readDomTextInputs(container);

  if (qtype === null) {
    // 前缀未命中：按 DOM 结构推断（需在真实页面核对）
    if (choiceInputs.length) {
      qtype = choiceInputs.some((input) => asString(input.type).toLowerCase() === "checkbox") ? 1 : 0;
    } else if (textInputs.length) {
      qtype = 2;
    } else {
      return null;
    }
  }

  if (qtype === 0 || qtype === 1 || qtype === 3) {
    const options = readDomOptions(container, choiceInputs);
    if (!options.length) return null;
    // 判断题识别：题干未标【判断】但选项仅两枚"对/错/正确/错误"时映射为 3（需在真实页面核对）
    if (qtype === 0 && isTrueFalseOptionTexts(options)) qtype = 3;
    return withChoiceClick({
      qtype,
      stem: stemHtml,
      options,
      isAnswered: () => domChoiceAnswered(choiceInputs),
    });
  }

  if (!textInputs.length) return null;
  return {
    qtype,
    stem: stemHtml,
    options: [],
    inputs: textInputs,
    isAnswered: () => domInputsAnswered(textInputs),
  };
}

// ---- 题目来源抽象入口（spec/40：getQuestions() 接口，后续补上解密即可无缝切换）----
export async function getQuestions() {
  // 首选：拦截缓存（按题目顺序）
  if (interceptedQuestions.length) {
    const questions = [];
    let encryptedSkipped = 0;
    let decryptedParsed = 0;
    let plainParsed = 0;
    let plainSkipped = 0;
    for (const item of interceptedQuestions) {
      if (item.content.indexOf(ENCRYPTED_CONTENT_PREFIX) === 0 ||
          item.content.indexOf(UNIPUS_CONTENT_PREFIX) === 0) {
        // 密文：先尝试两种已破译格式——
        //   1) "unipus." hex：AES-128-ECB + ZeroPadding，key = "1a2b3c4d" + k（页面 bundle 实测）；
        //   2) "unipus-content:" OpenSSL Salted base64：AES-256-CBC，密码固定 "unipus"。
        // 失败则保留密文日志供人工分析（spec/40 降级顺序）。
        const hexDecrypted = await decryptUnipusHexContent(item.content, item.k);
        if (hexDecrypted) {
          const parsedQuestions = parseUnipusQuestionJson(hexDecrypted);
          if (parsedQuestions.length) {
            for (const question of parsedQuestions) questions.push(question);
            decryptedParsed += 1;
            continue;
          }
        }
        const decrypted = await decryptUnipusContent(item.content);
        if (decrypted) {
          const parsedQuestions = parseDecryptedQuestionText(decrypted);
          if (parsedQuestions.length) {
            for (const question of parsedQuestions) questions.push(question);
            decryptedParsed += 1;
            continue;
          }
        }
        logEncryptedQuestionOnce(item);
        encryptedSkipped += 1;
        continue;
      }
      // 明文兜底：content 不以 "unipus." 开头，直接解析为题目；解析失败跳过。
      const parsedQuestions = parsePlaintextQuestionData(item.content);
      if (parsedQuestions.length) {
        for (const question of parsedQuestions) questions.push(question);
        plainParsed += 1;
      } else {
        plainSkipped += 1;
      }
    }
    if (questions.length) {
      if (encryptedSkipped > 0 || plainSkipped > 0) {
        unipusWarn(activeContext,
          `u校园拦截题目：解密成功 ${decryptedParsed} 道、明文 ${plainParsed} 条，另有 ${encryptedSkipped} 道密文（未破译格式）与 ${plainSkipped} 条明文解析失败已跳过，返回可解析的 ${questions.length} 道。`);
      }
      return questions;
    }
    if (encryptedSkipped > 0) {
      unipusWarn(activeContext,
        `u校园拦截到 ${encryptedSkipped} 道加密题目但解密失败（未破译格式或资源缺失），已跳过并降级为 DOM 提取。`);
    }
    if (plainSkipped > 0) {
      unipusWarn(activeContext,
        `u校园拦截到的 ${plainSkipped} 条明文题目数据解析失败，降级为 DOM 提取。`);
    }
  }

  // 降级：从渲染后的 DOM 提取（spec/40 降级顺序第 3 条，题目必然显示在页面上）
  const domQuestions = extractQuestionsFromDom(getContextDocument(activeContext));
  if (!domQuestions.length) {
    unipusWarn(activeContext,
      "u校园未获取到任何题目（拦截缓存为空/无法解析且 DOM 提取无结果）。");
  }
  return domQuestions;
}

// ==== END SECTION: unipus-question ====

// ==== SECTION: unipus-interceptor ====
// ---- 题目拦截（isolated world 侧接线）----
// 本函数只做两件事：幂等注入 MAIN bridge、注册 message 监听（若 init 已注册则幂等跳过）。
// 真正的 XHR/fetch 钩子（响应 JSON {code:0, content:"unipus.xxxx", k:"密钥"} 识别、
// 缓存 unsafeWindow.__interceptedQuestionData、事件输出）已在
// content/main-world-bridge.js 实现（AGENT 07），本函数不重复实现。

export function installQuestionInterceptor() {
  ensureMainWorldBridge();
  installQuestionMessageListener();
}

// ---- MAIN bridge 幂等注入（风格与 loader.js 的 injectMainWorldBridge 一致）----
function ensureMainWorldBridge() {
  const root = getGlobalRoot();
  if (root && root[MAIN_BRIDGE_FLAG]) return true; // 全局标记防重复注入

  const chromeApi = typeof chrome !== "undefined" ? chrome : null;
  // MAIN world 桥接已由 manifest 的 content_scripts（world:"MAIN"）原生注入；
  // content script 环境中 chrome.scripting 不可用属预期，静默跳过。
  if (!chromeApi || !chromeApi.scripting ||
      typeof chromeApi.scripting.executeScript !== "function") {
    return false;
  }

  // 先置标记再注入（loader 同款顺序）；注入失败回滚标记以便下次重试。
  if (root) root[MAIN_BRIDGE_FLAG] = true;
  try {
    const result = chromeApi.scripting.executeScript({
      world: "MAIN",
      files: [MAIN_BRIDGE_FILE],
    });
    if (result && typeof result.then === "function") {
      result.then(() => {}, () => {
        if (root) delete root[MAIN_BRIDGE_FLAG];
        bridgeInjectWarnOnce("MAIN bridge 注入失败，题目拦截降级为 DOM 提取。");
      });
    }
    return true;
  } catch (_error) {
    if (root) delete root[MAIN_BRIDGE_FLAG];
    bridgeInjectWarnOnce("MAIN bridge 注入失败，题目拦截降级为 DOM 提取。");
    return false;
  }
}

function bridgeInjectWarnOnce(message) {
  if (bridgeInjectWarned) return;
  bridgeInjectWarned = true;
  unipusWarn(activeContext, message);
}

// ---- window "message" 监听（过滤 source==="course-helper"，CONTRACTS §2）----
// MAIN world bridge 的 emit 使用 window.postMessage（globalWindow），
// isolated world 的 window 监听器可收到同 frame 的 message 事件。
function installQuestionMessageListener() {
  if (questionMessageListener) return; // init 已注册则幂等跳过
  const target = getContextWindow(activeContext) || getGlobalRoot();
  if (!target || typeof target.addEventListener !== "function") {
    unipusWarn(activeContext, "window unavailable，无法注册 ucampus-question-data 消息监听。");
    return;
  }
  questionMessageListener = onQuestionMessage;
  questionListenerTarget = target;
  try {
    target.addEventListener("message", questionMessageListener, false);
  } catch (_error) {
    questionMessageListener = null;
    questionListenerTarget = null;
  }
}

function removeQuestionMessageListener() {
  const target = questionListenerTarget;
  const listener = questionMessageListener;
  questionMessageListener = null;
  questionListenerTarget = null;
  if (!target || !listener) return;
  try {
    if (typeof target.removeEventListener === "function") {
      target.removeEventListener("message", listener, false);
    }
  } catch (_error) {
    // 已卸载的 window 清理失败可忽略。
  }
}

function onQuestionMessage(event) {
  if (!event) return;
  const data = event.data;
  if (!data || data.source !== MAIN_SOURCE) return; // 必须携带 source:"course-helper"
  if (data.type !== MAIN_QUESTION_DATA_EVENT) return;
  handleQuestionDataPayload(asObject(data.payload));
}

// ==== END SECTION: unipus-interceptor ====

// ==== SECTION: unipus-answer-queue ====
// ---- 答案队列下发（CONTRACTS §2.1）----
// 向 MAIN world 发 `course-helper:main:set-ucampus-answer-queue` {answers:string[]}，
// MAIN bridge 会写入 unsafeWindow.__UCAMPUS_ANSWER_CACHE__（AGENT 07 已实现），
// 供提交拦截时按题目顺序先序 shift 填充（位置填充，不需要题号映射）。

export function setAnswerQueue(answers) {
  if (!Array.isArray(answers) || answers.some((answer) => typeof answer !== "string")) {
    unipusWarn(activeContext, "setAnswerQueue：answers 必须是字符串数组，本次不发送事件。");
    return;
  }
  const sent = postMainMessage(activeContext, MAIN_ANSWER_QUEUE_EVENT, { answers: answers.slice() });
  if (!sent) {
    unipusWarn(activeContext, "setAnswerQueue：向 MAIN world 发送答案队列失败（window.postMessage 不可用）。");
  }
}

// ==== END SECTION: unipus-answer-queue ====

// ==== SECTION: unipus-submit ====
// ---- 提交拦截（isolated world 侧接线）----
// installSubmitInterceptor 只做启用接线：向 MAIN world 发
// `course-helper:main:set-confirm` {enabled:true}（CONTRACTS §2.1），
// 触发 MAIN 桥接的 window.confirm 覆写（恒 true）与 top.checkJob 屏蔽（恒 false），
// 为提交流程扫清确认弹窗；destroy 时发 {enabled:false} 恢复。
// 真正的 XHR/fetch 提交重写（URL 含 /course/api/v3/newExploration/submit 且 POST 时拦截、
// quesDatas[i].answer 答案树递归、叶子 value 先序 shift 答案队列、payload.usedTime
// 随机 60–120 秒）已在 content/main-world-bridge.js 实现（AGENT 07），
// 本函数不重复实现，只做启用接线与注释说明。
//
// AGENT 20 已接线：`course-helper:main:ucampus-submit` 事件消费与完整答题流程
// （runAutoAnswer）已追加在本分区之后的 unipus-auto-answer 区块（spec/40-unipus）。
// installSubmitInterceptor 除启用接线外，还幂等注册 submit 事件监听
// （destroy 经 disableSubmitInterceptor 移除）。

export function installSubmitInterceptor() {
  if (submitInterceptorEnabled) return; // 幂等
  const sent = postMainMessage(activeContext, MAIN_CONFIRM_EVENT, { enabled: true });
  if (!sent) {
    unipusWarn(activeContext,
      "installSubmitInterceptor：向 MAIN world 发送 set-confirm 失败（window.postMessage 不可用）。");
    return;
  }
  submitInterceptorEnabled = true;
  installSubmitMessageListener(); // AGENT 20：注册 ucampus-submit 事件消费（幂等）
}

// destroy 时恢复（发 set-confirm {enabled:false}，并移除 AGENT 20 的 submit 事件监听）
function disableSubmitInterceptor(context) {
  if (submitInterceptorEnabled) {
    postMainMessage(context || activeContext, MAIN_CONFIRM_EVENT, { enabled: false });
    submitInterceptorEnabled = false;
  }
  removeSubmitMessageListener(); // AGENT 20：幂等移除
}

// ==== END SECTION: unipus-submit ====

// ==== SECTION: unipus-auto-answer ====
// ---- AGENT 20 区块：提交事件消费 + 完整答题流程接线（spec/40 "提交拦截+答案注入"）----
// 1. 消费 MAIN 事件 `course-helper:main:ucampus-submit`（CONTRACTS §2.2，
//    payload {url, payload:string, usedTime:number, answerCount:integer}）：
//    本区块独立注册 window "message" 监听（幂等；init 已注册 question-data 监听，
//    两个监听器并存各管各的），校验 source==="course-helper"；
//    answerCount>0 时记录注入摘要（console.log），answerCount===0 时警告
//    "答案队列为空，本次提交未注入答案"（防御式：bridge 仅在注入成功时发事件，
//    该分支保留给未来 bridge 上报 0 注入的场景）。
// 2. runAutoAnswer(ctx)：完整答题流程接线（新增导出，报告已说明）——
//    autoAnswer 开关（ctx.settings.autoAnswer 默认 true；chrome.storage.local.autoAnswer
//    防御式覆盖，任一为 false 则不执行）→ getQuestions()（空则警告返回）→
//    quiz-solver 三级解析（contextWindow.CourseHelperQuizSolver →
//    globalThis.CourseHelperQuizSolver → require("../quiz-solver.js")）调
//    solveQuestions(questions, ctx, {autoSubmit:false})（submit 不传：u校园由用户
//    提交触发拦截注入，不自动提交）→ 按题目顺序提取各题答案 → setAnswerQueue
//    下发 MAIN world → installSubmitInterceptor（幂等）。
// 真正的 XHR/fetch 提交重写（URL 含 /course/api/v3/newExploration/submit 且 POST 时
// 拦截、quesDatas[i].answer 答案树递归、value 叶子先序 shift 队列、usedTime 60–120
// 随机）已在 content/main-world-bridge.js 实现（AGENT 07），本区块不重复实现。

const MAIN_SUBMIT_EVENT = "course-helper:main:ucampus-submit";
const QUIZ_SOLVER_GLOBAL_KEY = "CourseHelperQuizSolver";
const QUIZ_SOLVER_MODULE_PATH = "../quiz-solver.js";
const STORAGE_AUTO_ANSWER_KEY = "autoAnswer";

// ---- 主控接线：自动答题触发（init 立即触发 + 新题到达防抖重试）----
// 一轮成功（started:true）后锁定；新题到达（scheduleAutoAnswerForNewQuestions）解锁
// 并防抖合并同一页多题；事件连发时 2 秒节流；destroy/提交成功后 resetAutoAnswerState。
const AUTO_ANSWER_RETRY_THROTTLE_MS = 2000;
const AUTO_ANSWER_DEBOUNCE_MS = 800;
const autoAnswerState = {
  started: false,
  running: null,
  lastAttemptAt: 0,
  retryTimer: null,
  rerunAfterRunning: false,
  // 轮次计数：提交成功（handleSubmitPayload 清空缓存）时 +1。在途求解完成后
  // 若 generation 已变化，说明本轮题目已提交，旧题答案作废（不得下发队列，
  // 否则旧答案会注入下一页新题造成位置错位）。
  generation: 0,
  // 上次求解完成时缓存题目数（getQuestions 后快照）：rerunAfterRunning 补跑前
  // 用它判断求解期间是否真到达了新题，避免 init 探测与防抖调度竞争导致的
  // 整轮重复求解（多题一页时浪费大量时间）。
  lastSolvedCacheLength: -1,
};

// 新题到达调度（handleQuestionDataPayload 调用）：解锁上一轮锁定，防抖 1.5 秒
// 触发新一轮答题（同一页多题连续拦截合并为一次求解）；求解运行期间到达的
// 新题在结束后补跑一轮（防漏，见 triggerAutoAnswerOnce 的 finally 分支）。
function scheduleAutoAnswerForNewQuestions() {
  autoAnswerState.started = false;
  autoAnswerState.lastAttemptAt = 0; // 新题到达不受上次尝试的节流窗口限制
  if (autoAnswerState.running) {
    autoAnswerState.rerunAfterRunning = true;
    return;
  }
  if (autoAnswerState.retryTimer) return; // 已有待触发的防抖调度
  autoAnswerState.retryTimer = setTimeout(() => {
    autoAnswerState.retryTimer = null;
    void triggerAutoAnswerOnce();
  }, AUTO_ANSWER_DEBOUNCE_MS);
}

function triggerAutoAnswerOnce() {
  // 【2026-10-21 用户实测事故修复】语音逐题循环运行期间（可能持续数分钟）绝不允许
  // 重入：否则第二条流程会走完非语音路径并调度"自动提交"，抢在录音完成前提交，
  // 造成"没作答就提交"（实测：手动点面板"本页立即执行"触发，answerCount=5 但 5 题未作答）。
  if (voiceLoopRunning === true) {
    unipusWarn(activeContext, "u校园语音逐题循环运行中，跳过本轮自动答题/提交重入。");
    return null;
  }
  if (autoAnswerState.started || autoAnswerState.running) return autoAnswerState.running;
  const now = Date.now();
  if (now - autoAnswerState.lastAttemptAt < AUTO_ANSWER_RETRY_THROTTLE_MS) return null;
  autoAnswerState.lastAttemptAt = now;
  autoAnswerState.running = (async () => {
    try {
      const result = await runAutoAnswer(activeContext);
      if (result && result.started === true) autoAnswerState.started = true;
    } catch (_error) {
      // runAutoAnswer 内部已防御，此处兜底防未捕获异常。
    } finally {
      autoAnswerState.running = null;
      // 求解期间到达的新题才补跑（跨页竞态）：比较缓存长度，避免 init 探测
      // 与防抖调度竞争时对同一批题重复求解。
      if (autoAnswerState.rerunAfterRunning) {
        autoAnswerState.rerunAfterRunning = false;
        if (interceptedQuestions.length > autoAnswerState.lastSolvedCacheLength) {
          autoAnswerState.started = false;
          autoAnswerState.lastAttemptAt = 0;
          void triggerAutoAnswerOnce();
        }
      }
    }
  })();
  return autoAnswerState.running;
}

function resetAutoAnswerState() {
  autoAnswerState.started = false;
  autoAnswerState.running = null;
  autoAnswerState.lastAttemptAt = 0;
  autoAnswerState.rerunAfterRunning = false;
  autoAnswerState.lastSolvedCacheLength = -1;
  if (autoAnswerState.retryTimer) {
    clearTimeout(autoAnswerState.retryTimer);
    autoAnswerState.retryTimer = null;
  }
}

let submitMessageListener = null; // submit 事件 "message" 监听函数
let submitListenerTarget = null;  // 监听器挂载目标（销毁时从同一目标移除）

// ---- MAIN 提交事件消费（CONTRACTS §2.2）----
function installSubmitMessageListener() {
  if (submitMessageListener) return; // 幂等
  const target = getContextWindow(activeContext) || getGlobalRoot();
  if (!target || typeof target.addEventListener !== "function") {
    unipusWarn(activeContext, "window unavailable，无法注册 ucampus-submit 消息监听。");
    return;
  }
  submitMessageListener = onSubmitMessage;
  submitListenerTarget = target;
  try {
    target.addEventListener("message", submitMessageListener, false);
  } catch (_error) {
    submitMessageListener = null;
    submitListenerTarget = null;
  }
}

function removeSubmitMessageListener() {
  const target = submitListenerTarget;
  const listener = submitMessageListener;
  submitMessageListener = null;
  submitListenerTarget = null;
  if (!target || !listener) return;
  try {
    if (typeof target.removeEventListener === "function") {
      target.removeEventListener("message", listener, false);
    }
  } catch (_error) {
    // 已卸载的 window 清理失败可忽略。
  }
}

function onSubmitMessage(event) {
  if (!event) return;
  const data = event.data;
  if (!data || data.source !== MAIN_SOURCE) return; // 必须携带 source:"course-helper"
  if (data.type !== MAIN_SUBMIT_EVENT) return;
  handleSubmitPayload(asObject(data.payload));
}

function handleSubmitPayload(payload) {
  if (!asObject(payload)) return;
  const usedTime = typeof payload.usedTime === "number" && Number.isFinite(payload.usedTime)
    ? Math.floor(payload.usedTime) : NaN;
  const answerCount = typeof payload.answerCount === "number" && Number.isFinite(payload.answerCount)
    ? Math.floor(payload.answerCount) : NaN;
  if (Number.isNaN(answerCount) || answerCount === 0) {
    unipusWarn(activeContext, "答案队列为空，本次提交未注入答案。");
    return;
  }
  const usedTimeText = Number.isNaN(usedTime) ? "未知" : `${usedTime} 秒`;
  unipusLog(activeContext, `u校园提交已注入：answerCount=${answerCount}，usedTime=${usedTimeText}`);
  // 提交观测达成：清除"未观察到提交"的警告计时。
  submitObserved = true;
  if (submitObserveTimer) {
    clearTimeout(submitObserveTimer);
    submitObserveTimer = null;
  }
  // 主控接线：本轮提交已消费答案队列。清空拦截缓存并重置自动答题/自动提交状态，
  // SPA 切下一页后新题到达（handleQuestionDataPayload → scheduleAutoAnswerForNewQuestions）
  // 会自动重新求解填答，无需刷新页面。缓存必须在此时清空，否则旧题与新题混排
  // 会导致答案队列位置错位。
  interceptedQuestions.length = 0;
  interceptedContentSeen = null;
  // 轮次推进：使在途求解（若有）的旧题结果作废（见 runAutoAnswer 的
  // generation 守卫），防止旧答案队列在提交后被下发注入到下一页新题。
  autoAnswerState.generation += 1;
  stopPageFillObserver();
  resetAutoAnswerState();
  resetAutoSubmitState();
  // 自动翻页：提交成功后平台会切到中间页，页脚出现"继续学习"按钮，
  // 轮询等待并点击进入下一题（点击后新题拦截 → 新一轮自动答题，闭环）。
  scheduleAutoContinue(activeContext);
  unipusLog(activeContext, "u校园本轮提交完成，等待下一页题目到达后自动继续。");
}

// ---- chrome.storage.local.autoAnswer 防御式读取 ----
// 无 chrome API 或读取失败时返回 undefined（不阻塞流程）。
async function readStorageAutoAnswer() {
  let chromeApi = null;
  try {
    chromeApi = typeof chrome !== "undefined" && chrome ? chrome : null;
  } catch (_error) {
    chromeApi = null;
  }
  if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local ||
      typeof chromeApi.storage.local.get !== "function") {
    return undefined;
  }
  try {
    return await new Promise((resolve) => {
      chromeApi.storage.local.get(STORAGE_AUTO_ANSWER_KEY, (result) => {
        let runtimeError = null;
        try {
          runtimeError = chromeApi.runtime && chromeApi.runtime.lastError
            ? chromeApi.runtime.lastError : null;
        } catch (_error) {
          runtimeError = null;
        }
        if (runtimeError) {
          resolve(undefined);
          return;
        }
        resolve(result && typeof result.autoAnswer === "boolean" ? result.autoAnswer : undefined);
      });
    });
  } catch (_error) {
    return undefined;
  }
}

// ---- quiz-solver 三级解析 ----
// 1. contextWindow.CourseHelperQuizSolver（ctx.document.defaultView）
// 2. globalThis.CourseHelperQuizSolver
// 3. require("../quiz-solver.js")（CommonJS/打包环境；ESM 下 require 不存在，防御跳过）
function resolveQuizSolver(context) {
  const view = getContextWindow(context);
  if (view && view[QUIZ_SOLVER_GLOBAL_KEY] &&
      typeof view[QUIZ_SOLVER_GLOBAL_KEY].solveQuestions === "function") {
    return view[QUIZ_SOLVER_GLOBAL_KEY];
  }
  const root = getGlobalRoot();
  if (root && root[QUIZ_SOLVER_GLOBAL_KEY] &&
      typeof root[QUIZ_SOLVER_GLOBAL_KEY].solveQuestions === "function") {
    return root[QUIZ_SOLVER_GLOBAL_KEY];
  }
  if (typeof require === "function") {
    try {
      const moduleValue = require(QUIZ_SOLVER_MODULE_PATH);
      if (moduleValue && typeof moduleValue.solveQuestions === "function") return moduleValue;
      if (moduleValue && moduleValue.default &&
          typeof moduleValue.default.solveQuestions === "function") {
        return moduleValue.default;
      }
    } catch (_error) {
      // require 失败按不可用处理。
    }
  }
  return null;
}

// ---- 完整答题流程接线（u校园：由用户提交触发拦截注入，不自动提交）----
// getQuestions() → solveQuestions → 按题目顺序提取答案 → setAnswerQueue →
// installSubmitInterceptor。返回 {started, reason?, answerCount?} 供调用方（主控接线）检查。
export async function runAutoAnswer(ctx) {
  const context = ctx || activeContext;
  if (!context) {
    unipusWarn(activeContext, "runAutoAnswer：缺少 AdapterContext，跳过。");
    return { started: false, reason: "no-context" };
  }
  // 轮次快照：求解期间若发生提交成功（generation 递增），本轮旧题结果作废。
  const generation = autoAnswerState.generation;

  // autoAnswer 开关：ctx.settings.autoAnswer（默认 true，CONTRACTS §3）；
  // chrome.storage.local.autoAnswer 防御式覆盖；任一为 false 时不执行。
  // 【2026-10-21 修复】以模块标志 unipusSweepEnabled 为准（面板「开始/停止刷课」与
  // chrome.storage.local.autoAnswer 同步）。此前读 context.settings.autoAnswer ——
  // 那是页面加载时的快照，面板开始刷课后仍是旧值 false，导致"点了开始却不答题"。
  if (unipusSweepEnabled !== true) {
    unipusLog(context, "u校园刷课已停止（面板开关），跳过自动答题。");
    return { started: false, reason: "sweep-disabled" };
  }
  const storageAutoAnswer = await readStorageAutoAnswer();
  if (storageAutoAnswer === false) {
    unipusLog(context, "u校园自动答题已关闭（chrome.storage.local.autoAnswer=false），跳过。");
    return { started: false, reason: "auto-answer-disabled" };
  }

  const questions = await getQuestions();
  if (!questions.length) {
    // 标记"适配器已确认无可答题目"——看门狗据此用更短的兜底阈值。
    try { unipusNoQuestionConfirmedAt = Date.now(); } catch (_flagError) { /* 忽略 */ }
    unipusWarn(context, "u校园未获取到任何题目，跳过答案注入接线。");
    return { started: false, reason: "no-questions" };
  }
  // 求解快照：补跑判定用（见 triggerAutoAnswerOnce 的 finally 分支）。
  autoAnswerState.lastSolvedCacheLength = interceptedQuestions.length;

  const solver = resolveQuizSolver(context);
  if (!solver || typeof solver.solveQuestions !== "function") {
    unipusWarn(context, "quiz-solver 不可用（三级解析均未命中），跳过答案注入接线。");
    return { started: false, reason: "solver-unavailable" };
  }

  // 批间间隔：并发批之间保持短间隔（不影响单题答案质量，仅防请求突发；
  // 显式配置 answerIntervalMs 时尊重用户配置）。
  let solverContext = context;
  if (context && context.settings) {
    const configured = context.settings.answerIntervalMs;
    if (configured === undefined || configured === null) {
      solverContext = {
        ...context,
        settings: { ...context.settings, answerIntervalMs: 800 },
      };
    }
  }

  // 语音题（朗读/口语等需录音的题型，v1 不做录音——spec/40）：不送 DeepSeek
  // 求解，答案队列占位空字符串（提交注入时该题值叶子填入空，平台接受则相当于
  // 跳过）；整页只有语音题时仍自动提交翻页。
  // 【2026-10-21 实测修复】页面存在录音控件时，把 qtype=4 的题一并按语音题处理。
  // 背景：口语题（如 1-4 Viewing > Think and speak 的 3 道"Now it's your turn"）平台的
  // replyType 不匹配 UNIPUS_VOICE_REPLY_KEYWORDS（speak|oral|record|voice|…），于是被当成
  // 文本题送求解 → 求解失败 → "有 N 道题未获得答案" → 整轮跳过，既不录音也不提交，
  // 只能靠看门狗 20-60s 兜底跳过（用户实测反馈的"卡住/慢"根因）。
  // DOM 上该页确实有 .ucomp-recorder 录音控件，据此判定为语音题最可靠。
  try {
    const docForVoice = getContextDocument(context);
    const hasRecorderOnPage = Boolean(docForVoice && safeQueryAll(docForVoice, VOICE_RECORD_BUTTON_SELECTOR).length);
    if (hasRecorderOnPage) {
      let retagged = 0;
      questions.forEach((question) => {
        if (question && question.__isVoice !== true && question.qtype === 4) {
          question.__isVoice = true;
          retagged += 1;
        }
      });
      if (retagged > 0) {
        unipusLog(context,
          `u校园语音题识别：页面存在录音控件，将 ${retagged} 道 qtype=4 题按语音题处理（走录音流程 + 空占位）。`);
      }
    }
  } catch (_voiceRetagError) { /* 识别失败按原逻辑走 */ }

  const solvableIndexes = [];
  const solvableQuestions = [];
  questions.forEach((question, index) => {
    if (question && question.__isVoice === true) return;
    solvableIndexes.push(index);
    solvableQuestions.push(question);
  });
  const hasVoiceQuestions = solvableQuestions.length < questions.length;
  // 题目类型诊断（2026-10-20）：打印每题 qtype/isVoice，确认语音题被正确识别
  // （真实平台 replyType 未核对，若语音题未被识别会误送 DeepSeek 且录音流程不触发）。
  try {
    unipusLog(context,
      `u校园题目类型诊断（${questions.length} 道）：` +
      questions.map((question, index) => {
        const qtype = question && question.qtype;
        const voice = question && question.__isVoice === true;
        const stem = asString(question && question.stem).replace(/\s+/g, " ").slice(0, 18);
        return `#${index + 1} qtype=${qtype}${voice ? "(语音)" : ""} stem="${stem}"`;
      }).join(" | "));
  } catch (_error) { /* 诊断日志失败不影响流程 */ }

  let summary = null;
  try {
    // 并发 3 求解（quiz-solver 仅在该选项显式传入时并发，学习通等平台不受影响）：
    // DeepSeek 答案质量与并发无关，只缩短多题一页的墙钟时间。
    summary = await solver.solveQuestions(solvableQuestions, solverContext,
      { autoSubmit: false, concurrency: 3 });
  } catch (_error) {
    unipusWarn(context, "solveQuestions 调用失败，跳过答案注入接线。");
    return { started: false, reason: "solve-failed" };
  }

  // generation 守卫：求解期间若已发生提交成功（缓存已清空、进入下一轮），
  // 本轮旧题结果作废——不下发队列、不填答、不自动提交，防止旧答案错位注入新题。
  if (autoAnswerState.generation !== generation) {
    unipusLog(context, "u校园求解期间已发生提交，本轮旧题结果作废，等待下一轮新题。");
    return { started: false, reason: "stale-generation" };
  }

  // 答案队列顺序 = 题目顺序（spec/40：位置填充，不需要题号映射）。
  // 队列元素数必须与题目数一致：任何一题缺少答案都会导致后续题目错位，
  // 因此只要有一题未获得答案就不下发队列（bridge 原样放行提交，安全降级）。
  // 语音题占位空字符串（不计 missing）：提交注入时该题值叶子填入空。
  const results = asObject(summary) && Array.isArray(summary.results) ? summary.results : [];
  const solvablePositionByIndex = Object.create(null);
  solvableIndexes.forEach((originalIndex, position) => {
    solvablePositionByIndex[originalIndex] = position;
  });
  const answers = [];
  // 页面填答专用：仅文本题（填空/简答）的答案，按题目顺序收集。混合页（选择题+
  // 填空题）时页面输入框只对应文本题——完整队列含选择题占位，按序对齐会错位
  // （真实浏览器实测 AGENT 31 发现：input 被填入判断题答案 "B"）。
  const textAnswers = [];
  let missing = 0;
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    if (question && question.__isVoice === true) {
      // 语音题占位：按答案树叶子数放空字符串（与提交注入的先序 shift 对齐；
      // 叶子数无法解析时回退 1）。
      const placeholderCount = Number(question.__answerLeafCount) > 0
        ? Math.floor(Number(question.__answerLeafCount)) : 1;
      for (let placeholder = 0; placeholder < placeholderCount; placeholder += 1) {
        answers.push("");
      }
      continue;
    }
    const qtype = question && question.qtype;
    const isTextQuestion = (qtype === 2 || qtype === 4);
    const solvablePosition = solvablePositionByIndex[index];
    const result = solvablePosition !== undefined && solvablePosition < results.length
      ? results[solvablePosition] : null;
    const answer = result && typeof result.answer === "string" ? result.answer.trim() : "";
    if (!answer) {
      missing += 1;
      answers.push("");
      continue;
    }
    // 多选答案按 CONTRACTS 规范（连续大写字母）原样入队。
    // 填空答案按 # 拆分入队：一题多空对应多个 value 叶子，位置填充语义下
    // 每个空占一个队列位（bridge 注入按先序 shift，与题目顺序兼容）。
    // 各段剥离题号前缀（模型可能把 "1) xxx # 2) yyy" 的题号写进答案）。
    if (answer.indexOf("#") !== -1) {
      for (const part of answer.split("#")) {
        const trimmed = stripQuestionNumber(part.trim());
        if (!trimmed) {
          missing += 1;
        }
        answers.push(trimmed);
        if (isTextQuestion && trimmed) textAnswers.push(trimmed);
      }
    } else {
      const cleaned = stripQuestionNumber(answer);
      answers.push(cleaned);
      if (isTextQuestion && cleaned) textAnswers.push(cleaned);
    }
  }
  if (missing > 0) {
    unipusWarn(context,
      `u校园有 ${missing} 道题未获得答案，跳过答案队列下发（避免位置错位导致答案注入到错误题目）。`);
    return { started: false, reason: "missing-answers", missing };
  }

  setAnswerQueue(answers);
  installSubmitInterceptor();
  // 页面可见填答：把答案按顺序写入页面输入框（失败不阻塞，提交注入仍兜底）。
  // 输入框可能在视频播放后才渲染：先立即尝试，未命中则安装观察者持续监听。
  // 纯选择题（单选/多选/判断）无文本输入框，跳过输入框重试与观察者（省时）。
  const hasTextQuestions = questions.some((question) => {
    const qtype = question && question.qtype;
    return (qtype === 2 || qtype === 4) && question.__isVoice !== true;
  });
  let pageFilled = fillAnswersToPage(getContextDocument(context), textAnswers);
  if (hasTextQuestions) {
    for (let retry = 0; retry < 2 && pageFilled === 0; retry += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      pageFilled = fillAnswersToPage(getContextDocument(context), textAnswers);
    }
    if (pageFilled === 0) {
      installPageFillObserver(context, textAnswers);
    }
  }
  unipusLog(context,
    `u校园答案注入已就绪：${answers.length} 道题，等待用户提交时自动注入。` +
    (pageFilled > 0 ? `（已同步填入页面输入框 ${pageFilled} 处）` :
      (hasTextQuestions
        ? "（页面输入框暂未出现，已持续监听待其渲染后填入；提交时仍会注入）"
        : "（选择题：选项已点击，提交时仍会注入）")));
  // 自动提交：页面填答成功即调度点击提交按钮（autoSubmit 开关在调度函数内判定）；
  // 输入框延迟渲染的场景由页面填答观察者填答成功后补调度。
  // 选择题（单选/多选/判断）无文本输入框：quiz-solver 经 clickOption 回调点击选项，
  // solved===true 即页面已选中，同样调度自动提交。
  // 填答重试等待期间若发生提交（generation 变化），不再调度自动提交。
  const choiceSolved = questions.some((question, index) => {
    const solvablePosition = solvablePositionByIndex[index];
    const result = solvablePosition !== undefined && solvablePosition < results.length
      ? results[solvablePosition] : null;
    const qtype = question && question.qtype;
    return (qtype === 0 || qtype === 1 || qtype === 3) &&
      Boolean(result && result.solved === true);
  });
  // 语音题：提交前模拟录音（合成音频流由 MAIN bridge 注入，不使用真实麦克风）。
  if (hasVoiceQuestions) {
    await simulateVoiceRecordings(context);
  }
  // 整页只有语音题（无任何可求解题目）时也自动提交：占位空答案翻页。
  const voiceOnlyPage = hasVoiceQuestions && solvableQuestions.length === 0;
  if ((pageFilled > 0 || choiceSolved || voiceOnlyPage) &&
      autoAnswerState.generation === generation) {
    scheduleAutoSubmit(context);
  }
  return { started: true, answerCount: answers.length };
}

// ==== END SECTION: unipus-auto-answer ====

// ==== SECTION: unipus-page-fill ====
// ---- 页面可见填答（主控 2026-10-18 实测需求：答案直接显示在页面输入框）----
// 作答区容器选择器来自真实页面核对（用户提供，两种题型实测）：
//   填空：  #main-content ... .layout-reply-container .item 内 span > input
//   简答：  #main-content ... .layout-reply-container .question-inputbox-body 内 textarea
// 共同祖先 .layout-reply-container 内的文本输入框（input[非 hidden/radio/
// checkbox/submit/button] 与 textarea）按 DOM 顺序 = 答案队列顺序。
// 填答用原生 value setter（沿原型链）+ input 事件，平台前端框架可识别；
// 提交注入仍保留（双保险：页面填答失败不影响提交时改写 payload）。
const UNIPUS_DOM_ITEM_SELECTOR_CANDIDATES = Object.freeze([
  "#main-content .layout-reply-container",
  ".layout-reply-container",
  ".item",
]);

const UNIPUS_DOM_SKIP_INPUT_TYPES = Object.freeze({
  hidden: true,
  radio: true,
  checkbox: true,
  submit: true,
  button: true,
  file: true,
});

function setUnipusInputValue(element, value) {
  if (!element) return;
  const text = value === null || value === undefined ? "" : String(value);
  let descriptor = null;
  let owner = element;
  while (owner && !descriptor) {
    try {
      descriptor = Object.getOwnPropertyDescriptor(owner, "value") || null;
    } catch (_error) {
      descriptor = null;
    }
    if (!descriptor) {
      try {
        owner = Object.getPrototypeOf(owner);
      } catch (_error) {
        owner = null;
      }
    }
  }
  try {
    if (descriptor && typeof descriptor.set === "function") descriptor.set.call(element, text);
    else element.value = text;
  } catch (_error) {
    try {
      element.value = text;
    } catch (_assignmentError) {
      // 只读对象安全跳过。
    }
  }
  try {
    if (typeof element.dispatchEvent === "function") {
      let event = null;
      // InputEvent 优先（带 inputType/data，React 受控组件识别更可靠）；
      // 回退 Event，最后回退最小对象。
      try {
        const view = element.ownerDocument && element.ownerDocument.defaultView;
        const InputEventCtor = (view && typeof view.InputEvent === "function" && view.InputEvent) ||
          (typeof InputEvent === "function" ? InputEvent : null);
        const EventCtor = (view && typeof view.Event === "function" && view.Event) ||
          (typeof Event === "function" ? Event : null);
        if (InputEventCtor) {
          event = new InputEventCtor("input", { bubbles: true, composed: true, inputType: "insertText" });
        } else if (EventCtor) {
          event = new EventCtor("input", { bubbles: true, composed: true });
        }
      } catch (_error) {
        event = null;
      }
      if (!event) event = { type: "input", bubbles: true };
      element.dispatchEvent(event);
    }
  } catch (_error) {
    // input 事件派发失败不阻塞填答。
  }
}

// 按 DOM 顺序把答案队列填入页面输入框；返回填充数。失败不抛出。
function fillAnswersToPage(doc, answers) {
  if (!doc || typeof doc.querySelectorAll !== "function") return 0;
  if (!Array.isArray(answers) || !answers.length) return 0;
  let inputs = [];
  for (const selector of UNIPUS_DOM_ITEM_SELECTOR_CANDIDATES) {
    const containerNodes = safeQueryAll(doc, selector);
    if (!containerNodes.length) continue;
    const candidateInputs = [];
    for (const container of containerNodes) {
      for (const input of safeQueryAll(container, "input, textarea")) {
        const tagName = asString(input && input.tagName).toLowerCase();
        const type = asString(input && input.type).toLowerCase();
        if (tagName === "input" && UNIPUS_DOM_SKIP_INPUT_TYPES[type]) continue;
        candidateInputs.push(input);
      }
    }
    if (!candidateInputs.length) continue;
    // 输入框总数与答案数一致才采用（防止宽泛候选误命中无关输入框）；
    // 否则记住第一个非空候选兜底。
    if (candidateInputs.length === answers.length) {
      inputs = candidateInputs;
      break;
    }
    if (!inputs.length) inputs = candidateInputs;
  }
  if (!inputs.length) return 0;
  let filled = 0;
  for (let index = 0; index < inputs.length && index < answers.length; index += 1) {
    const answer = answers[index];
    if (!answer) continue;
    try {
      setUnipusInputValue(inputs[index], answer);
      filled += 1;
    } catch (_error) {
      // 单个输入框填答失败不影响其余。
    }
  }
  return filled;
}

// 页面填答观察者：输入框可能随视频播放/异步渲染延迟出现，持续监听页面
// DOM 变化，输入框组（数量与答案数一致）出现即填入；填满后断开。
const PAGE_FILL_OBSERVER_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟兜底断开
let pageFillObserver = null;
let pageFillObserverTimer = null;

function stopPageFillObserver() {
  if (pageFillObserver) {
    try {
      pageFillObserver.disconnect();
    } catch (_error) {
      // 已断开的观察者安全跳过。
    }
    pageFillObserver = null;
  }
  if (pageFillObserverTimer) {
    clearTimeout(pageFillObserverTimer);
    pageFillObserverTimer = null;
  }
}

function installPageFillObserver(context, answers) {
  stopPageFillObserver();
  const doc = getContextDocument(context);
  if (!doc || typeof doc.querySelectorAll !== "function") return;
  const MutationObserverCtor =
    (doc.defaultView && doc.defaultView.MutationObserver) ||
    (typeof MutationObserver !== "undefined" ? MutationObserver : null);
  if (!MutationObserverCtor) return;
  try {
    pageFillObserver = new MutationObserverCtor(() => {
      if (fillAnswersToPage(doc, textAnswers) > 0) {
        unipusLog(context, `u校园页面填答（观察者）：答案已填入输入框。`);
        stopPageFillObserver();
        // 延迟渲染的输入框填答完成后，同样调度自动提交（autoSubmit 开关内部判定）。
        scheduleAutoSubmit(context);
      }
    });
    pageFillObserver.observe(doc, { childList: true, subtree: true });
    pageFillObserverTimer = setTimeout(() => {
      if (pageFillObserver) {
        unipusWarn(context, "u校园页面填答观察者超时（10 分钟），输入框未出现，已停止监听。");
      }
      stopPageFillObserver();
    }, PAGE_FILL_OBSERVER_TIMEOUT_MS);
  } catch (_error) {
    stopPageFillObserver();
  }
}

// ==== END SECTION: unipus-page-fill ====

// ==== SECTION: unipus-voice ====
// ---- 语音题模拟录音（主控 2026-10-18 实测：朗读句/对话题，v1 不做真实录音）----
// 前端校验拦截提交（语音题未录音不发请求）。方案：点击平台的录音按钮开始 →
// 等待录制窗口 → 再点停止。录音内容由 MAIN bridge 注入的合成音频流提供
// （见 main-world-bridge.js 的 installFakeAudioStream：覆写 getUserMedia，
// 不经过真实麦克风——无权限弹窗、无环境噪声）。
// 按钮结构（用户实测 selector）：.record-button-group > div:nth-child(2)（麦克风）。
// 停止卡点加固（2026-10-19）：录音开始后 React 重渲染替换按钮节点，旧引用点击
// 无效（实测"停不下来"）。三级停止策略见 tryStopRecording；MAIN bridge 侧另有
// MediaRecorder 强制停止兜底（course-helper:main:ucampus-stop-recording）与录音
// 状态回执（course-helper:main:ucampus-recording-state，CONTRACTS §2）。

// 录音窗口时长：2026-10-20 实测调优。题目原音约 4.6s，3 秒窗口会把音频截断在
// 中途——腾讯 SOE 评测服务器收到不完整音频后返回 wrong sig（会话无效）。
// 8 秒 = 完整播放一轮原音 + 评测往返余量；题与题之间由 acquire/v2 的次序保证互不干扰。
const VOICE_RECORD_DURATION_MS = 8000;
const VOICE_RECORD_GROUP_SELECTOR = ".record-button-group";
// 真实结构（2026-10-20 快照）：录音按钮为 group 内 .record-button-wrap；
// .question-audio（audio-origin 原音 / audio-replay 回放）是音频播放器，不是按钮。
// 真实结构（2026-10-20 CDP 实测 ucontent.unipus.cn 实证）：
//   .record-button-group × 7（每题一组）
//   ├── .record-button-wrap 24x24 → .question-audio（播放原音 audio-origin / 回放 audio-replay）
//   └── .record-button-wrap 32x32 → .ucomp-recorder > span.record-icon.button-record  ← 真录音按钮
// 注意：.record-button-wrap 共 21 个（14 播放器 + 7 录音），必须按【内容】区分，
// 不能按序号——这正是此前"点了没反应"的根因（点到播放器）。
// 录音按钮是【开关式】：点第 1 次开始（MediaRecorder 构造）、点第 2 次停止
// （MediaRecorder.stop），且 UI class 不变（始终 button-record），因此不能用
// "class/文本变化"判断录音态，只能用 MediaRecorder 生命周期观测。
const VOICE_RECORD_BUTTON_SELECTOR = ".ucomp-recorder .button-record";
// 兼容旧结构/兜底：仅含 ucomp-recorder 的 wrap（排除播放器）
const VOICE_RECORDER_WRAP_SELECTOR = ".record-button-wrap .ucomp-recorder";
const VOICE_STOP_VERIFY_DELAY_MS = 600; // 停止点击后的验证等待（React 状态切换）
const VOICE_NEXT_QUESTION_SETTLE_MS = 2500; // 点"下一题"后新题渲染等待（React+数据加载）

// ---- 评分等待（2026-10-20 参考 wenliu 脚本实证）----
// 停止录音后平台的作答登记依赖【评分回调完成】（腾讯 SOE 返回分数渲染到
// .score_layout / .practice-score .score / .oral-score）。不等分数就点"下一题"
// 会导致该题被记为未作答——正是"还有 N 道题没有作答"的根因。
// 停止后轮询评分元素（最多 VOICE_SCORE_WAIT_MS），出现即作答已登记。
// 2026-10-21 真实平台三轮实测（等评分时长 → 平台"未作答"计数）：
//   15s/题 → 0 道未作答（v28，约170s/页）；5s/题 → 4 道未作答（v29，116s）；
//   5s/题 + 提交前统一等15s → 仍 4 道未作答（v30，131s）——证明起作用的是
//   【每题离开前的等待】（登记在切题前完成），而非总时长。本版取 10s 折中。
// 若 10s 仍出现未作答，请回调至 15s（v28 已验证 0 未作答）。
const VOICE_SCORE_WAIT_MS = 10000;
const VOICE_SCORE_SELECTORS = [".score_layout", ".practice-score .score", ".score-wrapper .score", ".oral-score"];

function readRecordedScore(doc) {
  for (const selector of VOICE_SCORE_SELECTORS) {
    for (const element of safeQueryAll(doc, selector)) {
      const text = asString(element.textContent).trim();
      if (text) return text.slice(0, 20);
    }
  }
  return null;
}

function waitForVoiceScore(context) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      const score = readRecordedScore(getContextDocument(context));
      if (score !== null) {
        unipusLog(context, `u校园语音题：评分已出现（${score}），作答登记完成。`);
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= VOICE_SCORE_WAIT_MS) {
        unipusLog(context, `u校园语音题：评分等待超时（${Math.round(VOICE_SCORE_WAIT_MS / 1000)}s），继续推进（可能不影响作答登记）。`);
        resolve(false);
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

// 录音态按钮判定（.recording class，参考 wenliu：录音中按钮加 .recording）。
function isRecordButtonRecording(doc) {
  for (const selector of [".record-icon.recording", ".button-record.recording", ".record-fill-icon.recording"]) {
    if (safeQueryAll(doc, selector).length) return true;
  }
  return false;
}

// 当前题原音时长（秒）：取第一个 audio.unipus-audio-h5（题目自带朗读）；
// 读取失败回退 0（由调用方用固定窗口兜底）。
function readSampleAudioDurationSeconds(doc) {
  try {
    const audio = doc && typeof doc.querySelector === "function"
      ? doc.querySelector("audio.unipus-audio-h5")
      : null;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      return audio.duration;
    }
  } catch (_error) {
    // 元素不可读时回退。
  }
  return 0;
}

// 组内"停止"目标（录音态）：取【最深】命中——React 录音组件的原生监听常绑在
// 文本叶子/图标层，点外层 wrapper 事件不经过深层元素。伪元素渲染文本（css
// content）的宿主元素也算命中。先序遍历最后一个命中即最深命中。
function findStopTextTarget(group) {
  let best = null;
  for (const element of safeQueryAll(group, "*")) {
    const text = asString(element.textContent).replace(/\s+/g, "");
    const cls = asString(element.className).toLowerCase();
    const aria = asString(element.getAttribute && element.getAttribute("aria-label")).toLowerCase();
    // 文本/伪元素命中"停止"文案；或 class/aria 标识录音态（stop/ing/rec 常见命名——
    // 真实平台按钮为图标无文本，快照无法采集录音态文案，特征兜底）。
    const textHit = /停止|stop/i.test(text) || /停止|stop/i.test(getElementPseudoText(element));
    const attrHit = /(^|[-_])(stop|recording|rec-?ing)/.test(cls) || /(停止|stop|recording)/.test(aria);
    if (!textHit && !attrHit) continue;
    best = element;
  }
  return best;
}

// 真实指针事件序列点击：pointerdown → mousedown → pointerup → mouseup → click
// （全部冒泡 + composed）。部分录音组件监听 pointer/mouse 事件而非 click，仅
// element.click() 不触发；事件坐标取元素中心（rect 不可用时取 0，不阻断）。
// 2026-10-20 关键修复：必须用 MouseEvent / PointerEvent 构造（不是 Event）——
// new Event('click') 没有 clientX/clientY/button/buttons 属性，平台 React 处理函数
// 读到 undefined 坐标后调用 elementFromPoint(NaN) 直接抛异常（实测日志
// "Failed to execute 'elementFromPoint': double value is non-finite"），
// 点击逻辑被中断 → 录音/翻页全部"无效"。
function dispatchPointerClick(element) {
  const view = (element.ownerDocument && element.ownerDocument.defaultView) || getGlobalRoot();
  if (!view || typeof element.dispatchEvent !== "function") return false;
  const MouseEventCtor = view.MouseEvent || (typeof MouseEvent !== "undefined" ? MouseEvent : null);
  const PointerEventCtor = view.PointerEvent || (typeof PointerEvent !== "undefined" ? PointerEvent : null);
  if (!MouseEventCtor && !PointerEventCtor) return false;
  let rect = null;
  try {
    rect = element.getBoundingClientRect();
  } catch (_error) {
    rect = null;
  }
  // 坐标必须是有限数（NaN/Infinity 会让平台 elementFromPoint 崩溃）
  const rawX = rect && Number.isFinite(rect.left) && Number.isFinite(rect.width)
    ? rect.left + (rect.width || 0) / 2 : 0;
  const rawY = rect && Number.isFinite(rect.top) && Number.isFinite(rect.height)
    ? rect.top + (rect.height || 0) / 2 : 0;
  const clientX = Number.isFinite(rawX) ? Math.round(rawX) : 0;
  const clientY = Number.isFinite(rawY) ? Math.round(rawY) : 0;
  const baseInit = {
    bubbles: true, cancelable: true, composed: true, view,
    clientX: clientX, clientY: clientY, screenX: clientX, screenY: clientY,
    detail: 1, button: 0, buttons: 0,
  };
  const plan = [
    ["pointerdown", PointerEventCtor, 1],
    ["mousedown", MouseEventCtor, 1],
    ["pointerup", PointerEventCtor, 0],
    ["mouseup", MouseEventCtor, 0],
    ["click", MouseEventCtor, 0],
  ];
  let dispatched = 0;
  for (const [type, preferredCtor, pressed] of plan) {
    const EventCtor = preferredCtor || MouseEventCtor;
    if (!EventCtor) continue;
    try {
      const init = Object.assign({}, baseInit, { buttons: pressed });
      if (PointerEventCtor && EventCtor === PointerEventCtor) {
        Object.assign(init, {
          pointerId: 1, pointerType: "mouse", isPrimary: true,
          width: 1, height: 1, pressure: pressed ? 0.5 : 0,
        });
      }
      element.dispatchEvent(new EventCtor(type, init));
      dispatched += 1;
    } catch (_error) {
      // 单个事件派发失败继续后续事件。
    }
  }
  return dispatched > 0;
}

// 通用点击（页脚提交/下一题/继续学习）：指针事件序列优先（覆盖只监听 pointer/mouse
// 的组件，2026-10-20 实测平台页脚按钮可能如此），失败回退原生 click。
function clickWithPointerSequence(context, element) {
  if (!element) return false;
  if (dispatchPointerClick(element)) return true;
  return clickElementSafely(context, element);
}

// 语音按钮点击：指针序列优先，失败回退原生 click（clickElementSafely）。
function clickRecordTarget(context, element) {
  return clickWithPointerSequence(context, element);
}

// 点击后短窗口捕获平台提示弹窗文本（前端校验拦截原因，如"请先录音/录音不完整"）。
// 覆盖 antd/自绘弹窗常见容器；仅在点击后调用，不影响其他流程。
function capturePageFeedback(context, waitMs) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const doc = getContextDocument(context);
      if (!doc) { resolve(""); return; }
      const messages = [];
      for (const selector of [
        ".ant-message-notice-content", ".ant-modal-body", ".ant-notification-notice-message",
        '[class*="toast" i]', '[class*="message" i]', '[class*="tip" i]', '[role="alert"]',
      ]) {
        for (const element of safeQueryAll(doc, selector)) {
          if (!isElementVisible(element)) continue;
          const text = asString(element.textContent).replace(/\s+/g, " ").trim().slice(0, 120);
          if (text && !messages.includes(text)) messages.push(text);
        }
      }
      resolve(messages.slice(0, 3).join(" | "));
    }, waitMs);
  });
}

// ---- 录音状态回执（course-helper:main:ucampus-recording-state，CONTRACTS §2.2）----
// MAIN bridge 回执 payload：{recording:boolean, recorderCount:number, stopRequested:boolean}。
// recording=false：某次 stop 已执行（平台自行停止或强制停止命令回执）；
// stopRequested=true：本次回执是 content 停止命令的应答。
let voiceRecordingStoppedSeen = false;
let voiceRecordingStateListener = null;

function handleVoiceRecordingStatePayload(payload) {
  const data = asObject(payload);
  if (!data) return;
  if (data.stopRequested === true || data.recording === false) {
    voiceRecordingStoppedSeen = true;
  }
  // 同步录音态（供 detectRecordingActive 判定平台是否已自动开录）
  if (typeof handleBridgeRecordingState === "function") {
    handleBridgeRecordingState(data);
  }
}

function installVoiceRecordingStateListener() {
  if (voiceRecordingStateListener) return; // 幂等
  const target = getContextWindow(activeContext) || getGlobalRoot();
  if (!target || typeof target.addEventListener !== "function") return;
  voiceRecordingStateListener = (event) => {
    if (!event) return;
    const data = event.data;
    if (!data || data.source !== MAIN_SOURCE) return; // 必须携带 source:"course-helper"
    if (data.type !== MAIN_RECORDING_STATE_EVENT) return;
    handleVoiceRecordingStatePayload(asObject(data.payload));
  };
  try {
    target.addEventListener("message", voiceRecordingStateListener, false);
  } catch (_error) {
    voiceRecordingStateListener = null;
  }
}

function removeVoiceRecordingStateListener() {
  const target = getContextWindow(activeContext) || getGlobalRoot();
  const listener = voiceRecordingStateListener;
  voiceRecordingStateListener = null;
  if (!target || !listener) return;
  try {
    if (typeof target.removeEventListener === "function") {
      target.removeEventListener("message", listener, false);
    }
  } catch (_error) {
    // 已卸载的 window 清理失败可忽略。
  }
}

// 停止结果验证：窗口期内收到任一回执（recording=false 或 stopRequested）即确认。
// context 参数保留（与 tryStopRecording 签名风格一致，当前无需使用）。
// 无回执返回 false → 上层继续下一级策略；三级全无回执时最终警告并请用户提供日志。
async function verifyStopOutcome(context) {
  void context;
  voiceRecordingStoppedSeen = false;
  const deadline = Date.now() + VOICE_STOP_VERIFY_DELAY_MS;
  while (Date.now() < deadline) {
    if (voiceRecordingStoppedSeen) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return voiceRecordingStoppedSeen;
}

// 取元素内最深后代（点击目标）：平台原生监听常绑深层，深点冒泡覆盖全部祖先。
function deepestClickTarget(element) {
  if (!element || typeof element.querySelectorAll !== "function") return element;
  const descendants = safeQueryAll(element, "*");
  let deepest = null;
  let deepestDepth = -1;
  for (const descendant of descendants) {
    let depth = 0;
    let node = descendant;
    try {
      while (node && node.parentElement && node !== element) {
        depth += 1;
        node = node.parentElement;
      }
    } catch (_error) {
      depth = 0;
    }
    if (depth > deepestDepth) {
      deepestDepth = depth;
      deepest = descendant;
    }
  }
  return deepest || element;
}

// 录音按钮收集（2026-10-20 CDP 实测真实结构）：
//   主路径：.ucomp-recorder .button-record —— 唯一可靠的录音按钮标识。
//   fallback：仅含 .ucomp-recorder 的 wrap（结构微调时的兜底）。
// 绝不再按 .record-button-wrap 序号取——21 个 wrap 里 14 个是播放器（实测踩坑）。
// 点击目标取 .button-record 自身（实测有效）：它在 32x32 的可点击区域内。
function collectRecordButtons(doc) {
  const buttons = [];
  if (!doc) return buttons;
  const seen = new Set();
  for (const icon of safeQueryAll(doc, VOICE_RECORD_BUTTON_SELECTOR)) {
    if (seen.has(icon)) continue;
    seen.add(icon);
    buttons.push(icon); // 直接点 .button-record（实测可触发 MediaRecorder 构造）
  }
  if (buttons.length) return buttons;
  // fallback：ucomp-recorder 容器（结构变化时仍能点到）
  for (const recorder of safeQueryAll(doc, VOICE_RECORDER_WRAP_SELECTOR)) {
    if (seen.has(recorder)) continue;
    seen.add(recorder);
    buttons.push(recorder);
  }
  if (buttons.length) return buttons;
  // 最后兜底：旧结构（.record-button-group > 第 2 个子元素），仅当页面无 ucomp-recorder
  for (const group of safeQueryAll(doc, VOICE_RECORD_GROUP_SELECTOR)) {
    let children = [];
    try {
      children = Array.from(group.children || []);
    } catch (_error) {
      children = [];
    }
    const wrapper = children.length >= 2 ? children[1] : (children[0] || group);
    if (!wrapper || seen.has(wrapper)) continue;
    seen.add(wrapper);
    buttons.push(deepestClickTarget(wrapper));
  }
  return buttons;
}

// 录音中 DOM 快照（录音开始后采集一次，自动收集"停止按钮长什么样"的证据，
// 免去用户描述 UI）：.record-button-group 内子元素树（标签/class/文本/可见性）
// + 全页可见"停止"文本元素候选（前 3 个）。
function snapshotRecordingDom(context) {
  const doc = getContextDocument(context);
  if (!doc || typeof doc.querySelectorAll !== "function") return;
  try {
    const groups = safeQueryAll(doc, VOICE_RECORD_GROUP_SELECTOR);
    const groupParts = [];
    for (const group of groups) {
      for (const element of safeQueryAll(group, "*")) {
        const text = asString(element.textContent).replace(/\s+/g, " ").trim().slice(0, 20);
        if (!text) continue;
        groupParts.push(`${describeElement(element)}${isElementVisible(element) ? "" : "(不可见)"}`);
      }
    }
    const pageStopCandidates = [];
    for (const selector of ['button', '[role="button"]', 'a', '[class*="btn" i]']) {
      for (const element of safeQueryAll(doc, selector)) {
        if (pageStopCandidates.length >= 3) break;
        const text = asString(element.textContent).replace(/\s+/g, "").trim();
        const pseudo = getElementPseudoText(element);
        if (!/停止|stop/i.test(text) && !/停止|stop/i.test(pseudo)) continue;
        if (!isElementVisible(element)) continue;
        pageStopCandidates.push(`${describeElement(element)}${pseudo ? `（伪元素文本：${pseudo.slice(0, 12)}）` : ""}`);
      }
    }
    // 第一组 wrap 的内部结构（按钮真实形态：svg/button/监听层；开始态+点击后各采一次）
    let wrapDetail = "无";
    const firstWrap = safeQuery(doc, VOICE_RECORD_BUTTON_SELECTOR);
    if (firstWrap) {
      const childParts = [];
      for (const child of safeQueryAll(firstWrap, "*")) {
        const cls = asString(child.className).slice(0, 40);
        let rect = null;
        try { rect = child.getBoundingClientRect(); } catch (_e) { rect = null; }
        const size = rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : "?";
        childParts.push(`<${asString(child.tagName).toLowerCase()} class="${cls}" ${size}`);
      }
      let html = "";
      try { html = asString(firstWrap.innerHTML).replace(/\s+/g, " ").slice(0, 300); } catch (_e) { html = "?"; }
      wrapDetail = `子元素[${childParts.join(" | ") || "无"}] innerHTML=${html}`;
    }
    unipusLog(context,
      `u校园语音题：录音中 DOM 快照——按钮组子元素 [${groupParts.join(" | ") || "无文本子元素"}]；` +
      `录音按钮细节 ${wrapDetail}；` +
      `全页可见停止候选 [${pageStopCandidates.join(" | ") || "无"}]。`);
  } catch (_error) {
    // 快照仅诊断用，失败不影响录音流程。
  }
}

// 停止录音三级策略（每级命中后统一经 verifyStopOutcome 验证）：
//   1. 组内同位置"停止"目标（录音态下 React 把开始按钮替换为停止文本，实时查询）；
//   2. 全页扫描含"停止/stop"文本（含伪元素）的可见未禁用按钮（停止按钮可能
//      在弹层/其他位置）；
//   3. MAIN bridge 强制停止：对存活 MediaRecorder 直接 stop（与平台停止按钮
//      内部行为一致，触发 onstop 回调），回执经 ucampus-recording-state 验证。
async function tryStopRecording(context, index) {
  const doc = getContextDocument(context);
  // 策略 1（首选，2026-10-20 CDP 实测有效）：平台录音按钮是【开关式】——
  // 同一个 .ucomp-recorder .button-record 点第 1 次开始录音（MediaRecorder 构造）、
  // 点第 2 次停止（MediaRecorder.stop），且 UI class 始终不变（button-record）。
  // 因此停止 = 实时重新查询同一按钮并再点一次（不能用文本/class 判断录音态）。
  const buttons = collectRecordButtons(doc);
  if (index < buttons.length) {
    clickRecordTarget(context, buttons[index]);
    if (await verifyStopOutcome(context)) return "dom-toggle";
  }
  // 策略 1b：组内"停止"文本命中（结构变化时的兜底；实测当前平台无此文案）
  const group = doc ? safeQuery(doc, VOICE_RECORD_GROUP_SELECTOR) : null;
  if (group) {
    const stopTextTarget = findStopTextTarget(group);
    if (stopTextTarget) {
      clickRecordTarget(context, stopTextTarget);
      if (await verifyStopOutcome(context)) return "dom";
    }
  }

  // 策略 2：全页扫描录音控件（文本/伪元素/class/id/aria/title 含停止语义）——
  // 真实停止按钮可能不在 .record-button-group 内（2026-10-20 实证：平台自动录音，
  // 停止控件为独立元素，可能是 div/span/i 而非 button）。
  const stopCandidates = [];
  const stopSeen = new Set();
  for (const selector of ['button', '[role="button"]', 'a', '.ant-btn', '[class*="btn" i]',
    '[class*="record" i]', '[class*="stop" i]', '[class*="audio-control" i]', 'i', 'span', 'div']) {
    for (const element of safeQueryAll(doc, selector)) {
      if (stopSeen.has(element)) continue;
      stopSeen.add(element);
      // 排除扩展自己的面板（其标签"停止后等评分（推荐）"含"停止"二字，
      // 实测被文本扫描命中并误点，见 2026-10-21 用户会话日志）。
      try {
        if (element.closest && element.closest("#ch-panel, #ch-ball")) continue;
      } catch (_panelSkipError) { /* closest 不可用时按原逻辑 */ }
      const text = asString(element.textContent).replace(/\s+/g, "").trim();
      const pseudo = getElementPseudoText(element);
      let attrs = "";
      try {
        attrs = asString(element.className) + " " + asString(element.id) + " " +
          asString(element.getAttribute && element.getAttribute("aria-label")) + " " +
          asString(element.getAttribute && element.getAttribute("title"));
      } catch (_error) { attrs = ""; }
      const textHit = /停止|stop/i.test(text) || /停止|stop/i.test(pseudo);
      const attrHit = /(^|[-_"\s])(stop|recording|stop-?record|录音中|停止录音)/i.test(attrs);
      if (!textHit && !attrHit) continue;
      if (!isElementVisible(element)) continue;
      if (element.disabled === true || element.getAttribute("aria-disabled") === "true") continue;
      // 排除过大的容器（整页 div 的 textContent 也含"停止"）
      let rect = null;
      try { rect = element.getBoundingClientRect(); } catch (_e) { rect = null; }
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.width > 400 || rect.height > 200) continue;
      stopCandidates.push(element);
    }
  }
  if (stopCandidates.length) {
    unipusLog(context,
      `u校园语音题：尝试点击停止按钮（文本扫描命中 ${describeElement(stopCandidates[0])}）。`);
    clickRecordTarget(context, stopCandidates[0]);
    if (await verifyStopOutcome(context)) return "dom";
  }

  // 策略 3：MAIN bridge 强制停止 MediaRecorder（React 节点替换导致 DOM 点击
  // 全部无效时的兜底；recorder.stop 触发平台 onstop，前端进入已录音状态）。
  const requestSent = postMainMessage(context, MAIN_STOP_RECORDING_EVENT, { reason: "voice-stop" });
  if (!requestSent) {
    unipusWarn(context, "u校园语音题：停止命令发送失败（window.postMessage 不可用），录音可能仍在进行。");
    return "none";
  }
  const stopConfirmed = await verifyStopOutcome(context);
  if (!stopConfirmed) {
    unipusWarn(context,
      "u校园语音题：三级停止均未确认生效（未收到 MediaRecorder.stop 回执）。" +
      "请把以上日志（含录音中 DOM 快照）发给助手分析。");
    return "none";
  }
  return "bridge";
}

// ---- 全页录音控件探测（2026-10-20 真实平台语义修正）----
// 平台实证：进入语音题页即【自动开始录音】（点"下一题"提示"正在录音中"），
// 需要点击平台自己的"停止录音"按钮结束。.record-button-wrap 实为【播放原音/回放】
// 按钮（内含 question-audio + audio-control-trumpet 喇叭图标），不是录音入口。
// 本探测器全页扫描录音相关控件：class/id/aria/title 含 record|录音|mic|voice 的
// 可见元素，输出其结构供精确定位（含 audio 标签与按钮候选）。
const RECORD_CONTROL_HINT = /record|录音|mic|voice|speak|oral/i;
function probeRecordControls(context) {
  const doc = getContextDocument(context);
  if (!doc) return { controls: [], stopCandidates: [] };
  const controls = [];
  const seen = new Set();
  for (const selector of ["button", '[role="button"]', "a", "div", "span", "i", "svg"]) {
    for (const element of safeQueryAll(doc, selector)) {
      if (seen.has(element)) continue;
      seen.add(element);
      let cls = "";
      let id = "";
      let aria = "";
      let title = "";
      try {
        cls = asString(element.className).slice(0, 60);
        id = asString(element.id);
        aria = asString(element.getAttribute && element.getAttribute("aria-label"));
        title = asString(element.getAttribute && element.getAttribute("title"));
      } catch (_error) { continue; }
      const haystack = cls + " " + id + " " + aria + " " + title;
      if (!RECORD_CONTROL_HINT.test(haystack)) continue;
      if (!isElementVisible(element)) continue;
      // 只看有独立尺寸的叶子级候选（避免整页容器刷屏）
      let rect = null;
      try { rect = element.getBoundingClientRect(); } catch (_e) { rect = null; }
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.width > 400 || rect.height > 200) continue;
      controls.push({
        element,
        desc: `<${asString(element.tagName).toLowerCase()} class="${cls}"${id ? ` id="${id}"` : ""}` +
          `${aria ? ` aria-label="${aria}"` : ""}${title ? ` title="${title}"` : ""} ` +
          `${Math.round(rect.width)}x${Math.round(rect.height)}>`,
        text: asString(element.textContent).replace(/\s+/g, "").trim().slice(0, 20),
      });
    }
  }
  return { controls };
}

// ---- 全页可点击元素结构 dump（2026-10-20 诊断）----
// 平台"停止录音"按钮不在 .record-button-group 内且无"停止"文案（旧扫描 [无] 命中），
// 需要看清页面上所有可点击元素（cursor:pointer / onclick / 小尺寸图标）的真实结构。
// 输出：tag + class + id + 文本 + 尺寸 + cursor，最多 30 个（按尺寸从小到大，
// 图标按钮优先），供精确定位停止控件。
function dumpClickableElements(context) {
  const doc = getContextDocument(context);
  if (!doc || typeof doc.querySelectorAll !== "function") return;
  const view = (doc.defaultView) || getGlobalRoot();
  const items = [];
  const seen = new Set();
  for (const selector of ["button", '[role="button"]', "a", "div", "span", "i", "svg", "img", "input"]) {
    for (const element of safeQueryAll(doc, selector)) {
      if (seen.has(element)) continue;
      seen.add(element);
      if (!isElementVisible(element)) continue;
      let rect = null;
      try { rect = element.getBoundingClientRect(); } catch (_e) { rect = null; }
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (rect.width > 300 || rect.height > 150) continue; // 排除大容器
      let cursor = "";
      let cls = "";
      let id = "";
      let text = "";
      try {
        cursor = view && view.getComputedStyle ? view.getComputedStyle(element).cursor : "";
        cls = asString(element.className).slice(0, 70);
        id = asString(element.id).slice(0, 40);
        text = asString(element.textContent).replace(/\s+/g, "").trim().slice(0, 16);
      } catch (_e) { continue; }
      const clickable = /pointer/i.test(cursor) || asString(element.tagName).toLowerCase() === "button" ||
        asString(element.tagName).toLowerCase() === "a";
      if (!clickable) continue;
      items.push({
        size: Math.round(rect.width) + "x" + Math.round(rect.height),
        desc: `<${asString(element.tagName).toLowerCase()}${cls ? ` class="${cls}"` : ""}${id ? ` id="${id}"` : ""}` +
          ` ${Math.round(rect.width)}x${Math.round(rect.height)}${text ? ` text="${text}"` : ""}>`,
        area: rect.width * rect.height,
      });
    }
  }
  items.sort((a, b) => a.area - b.area); // 小图标优先
  const uniq = [];
  for (const item of items) {
    if (!uniq.includes(item.desc)) uniq.push(item.desc);
    if (uniq.length >= 30) break;
  }
  unipusLog(context,
    `u校园语音题：全页可点击元素 dump（${uniq.length} 个，小尺寸优先）——` + (uniq.join(" | ") || "无"));
}

// 录音状态判定（2026-10-20 CDP 实测修正）：
// 平台录音按钮是开关式且 **UI class 完全不变**（始终 .button-record），
// 因此不能靠 class/文本判断录音态。可靠信号来自 MAIN bridge 的 MediaRecorder 观测：
// 收到 ucampus-recording-state {recording:true} 即表示平台已构造 recorder（正在录音）。
// 这里用模块内缓存的状态；未收到回执时保守返回 false（走"点开始→等待→再点停止"路径）。
let bridgeRecordingActive = false;
function handleBridgeRecordingState(payload) {
  const data = asObject(payload);
  if (!data) return;
  if (data.stopRequested === true || data.recording === false) {
    bridgeRecordingActive = false;
  } else if (data.recording === true) {
    bridgeRecordingActive = true;
  }
}
function detectRecordingActive(context) {
  void context;
  if (bridgeRecordingActive) return true;
  // 兜底：页面出现明确的"正在录音中"提示（部分场景平台会弹）
  const doc = getContextDocument(activeContext);
  if (!doc) return false;
  for (const selector of [".ant-message-notice-content", '[class*="toast" i]', '[role="alert"]']) {
    for (const element of safeQueryAll(doc, selector)) {
      if (!isElementVisible(element)) continue;
      if (/正在录音中|录音中/.test(asString(element.textContent))) return true;
    }
  }
  return false;
}

// 找下一个未完成的练习组 tab（2026-10-20 实测结构：.pc-task，父容器
// .pc-header-tasks-row，激活态 class 含 pc-header-task-activity）。
// 返回第一个【非激活】的 tab；全部完成返回 null。
function findNextPracticeTab(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return null;
  const tabs = safeQueryAll(doc, ".pc-task");
  let activeIndex = -1;
  for (let i = 0; i < tabs.length; i += 1) {
    if (/pc-header-task-activity/.test(asString(tabs[i].className))) {
      activeIndex = i;
      break;
    }
  }
  // 找到激活组 → 返回其【下一个】（修复：旧逻辑返回第一个非激活组=Practice-1，
  // 点已完成组导致循环终止）；无激活组 → 返回第一个（页面初始态兜底）。
  if (activeIndex >= 0) {
    return activeIndex + 1 < tabs.length ? tabs[activeIndex + 1] : null;
  }
  return tabs.length ? tabs[0] : null;
}

let voiceLoopRunning = false;

async function simulateVoiceRecordings(context) {
  if (voiceLoopRunning) {
    unipusLog(context, "u校园语音题：逐题循环已在运行，跳过本次重入。");
    return true;
  }
  voiceLoopRunning = true;
  try {
    await simulateVoiceRecordingsInner(context);
  } finally {
    voiceLoopRunning = false;
  }
}

async function simulateVoiceRecordingsInner(context) {
  const doc = getContextDocument(context);
  // 版本标记（诊断用：一眼确认跑的是哪版代码，避免"改了但跑旧版"）
  unipusLog(context, "u校园语音题：模块版本 v2026-10-20.7（ucomp-recorder 录音按钮 + 开关式停止）");
  // 先探测全页录音控件（输出真实结构，供下次精确定位）
  const probe = probeRecordControls(context);
  if (probe.controls.length) {
    unipusLog(context,
      `u校园语音题：全页录音控件探测（${probe.controls.length} 个）——` +
      probe.controls.slice(0, 8).map((c) => `${c.desc}${c.text ? ` text="${c.text}"` : ""}`).join(" | "));
  } else {
    unipusLog(context, "u校园语音题：全页未探测到录音相关控件（class/id/aria/title 含 record|录音|mic）。");
  }
  // 平台是否已自动开始录音（提示"正在录音中"或录音态控件存在）
  const alreadyRecording = detectRecordingActive(context);
  // 全页可点击元素结构 dump（定位平台真实"停止录音"控件）
  dumpClickableElements(context);
  unipusLog(context, `u校园语音题：当前录音状态判定 = ${alreadyRecording ? "已自动开始录音" : "未在录音"}。`);
  const initialButtons = collectRecordButtons(doc);
  if (!initialButtons.length && !alreadyRecording) {
    unipusWarn(context,
      "u校园语音题：未找到录音按钮（.record-button-group）且未检测到自动录音，无法模拟录音，提交可能被前端校验拦截。");
    return false;
  }
  // ---- 场景 A：平台已自动开始录音（2026-10-20 实证：进页面即录）----
  // 只需停止录音，不需要点任何"开始"。等待录音窗口后调用停止链路。
  if (alreadyRecording) {
    unipusLog(context,
      `u校园语音题：平台已自动录音，等待 ${VOICE_RECORD_DURATION_MS}ms 录音窗口后执行停止。`);
    await new Promise((resolve) => setTimeout(resolve, VOICE_RECORD_DURATION_MS));
    snapshotRecordingDom(context); // 录音中快照（自动收集停止按钮证据）
    const stopOutcome = await tryStopRecording(context, 0);
    unipusLog(context, `u校园语音题：停止结果 = ${stopOutcome}（dom=按钮命中 / bridge=强制停止 / none=未确认）。`);
    if (stopOutcome === "none") {
      unipusWarn(context, "u校园语音题：自动录音的停止未确认，提交可能仍被拦截（见上方录音控件探测）。");
    }
    return true;
  }

  // ---- 场景 B：逐题循环（2026-10-20 实测平台语义修正）----
  // 一页含多道语音题（实测 19 道）：每题流程 = 点当前录音位 → 录音窗口 → 停止
  // （开关激活）→ 点页脚"下一题" → 新题渲染 → 继续；页脚变"提 交"时结束，
  // 由外层 scheduleAutoSubmit 完成整页提交（19 题作答记录齐全，校验通过）。
  // 旧逻辑一次点完全页录音位再点一次下一题——实测跳题，平台报
  // "还有19道题没有作答"（7789122 版本实测教训）。
  // 统一由「开始刷课」驱动：停止状态下不录音。
  if (unipusSweepEnabled !== true) {
    unipusLog(context, "u校园语音题：刷课已停止，跳过语音录音。");
    return false;
  }
  const count = initialButtons.length;
  const maxQuestions = 45; // 上限保护（一页题数未知，跨多个 Practice 组时可能达 19+ 题）
  setUnipusPanelStatus(`状态：语音题处理中 0/${count}`, "warn");
  unipusLog(context,
    `u校园语音题：逐题循环开始（当前可见录音位 ${count} 个；每题：录音 ${VOICE_RECORD_DURATION_MS}ms → 停止 → 下一题，直到页脚出现"提 交"）。`);
  let questionIndex = 0;
  // 多题同屏布局的下标游标（无"下一题"时使用），见循环内布局判定注释。
  let multiIndex = 0;
  for (; questionIndex < maxQuestions; questionIndex += 1) {
    // 「停止刷课」后立即中断录音循环（当前题停止后不再继续）。
    if (unipusSweepEnabled !== true) {
      unipusLog(context, `u校园语音题：刷课已停止，中断录音循环（已完成 ${questionIndex} 题）。`);
      break;
    }
    // 每轮重新取 document（SPA 翻页可能替换 document，避免旧引用失效）。
    const docNow = getContextDocument(context);
    setUnipusPanelStatus(`状态：语音题处理中 ${questionIndex + 1}/${count}`, "warn");
    // 每轮实时查询录音位（切题后 React 重渲染，旧引用失效）。
    const startButtons = collectRecordButtons(docNow);
    if (!startButtons.length) {
      unipusLog(context, `u校园语音题：第 ${questionIndex + 1} 题无可见录音位（可能全部完成），结束循环。`);
      break;
    }
    // 布局判定（2026-10-21 用户实测反馈修复）：
    //  A) 单题布局：页脚有"下一题"（如 6-2 Sharing 的组内翻页）→ 始终点第 0 个；
    //  B) 多题布局：页脚只有"提交"（如 2-5 Pronunciation 五题同屏）→ 按 multiIndex
    //     依次处理；旧逻辑固定点第 0 个，导致第 1 题后就误判"整页处理完毕"（用户实测现象）。
    const hasNextLinkNow = Boolean(docNow ? findFootLinkByText(docNow, /下一题/) : null);
    const targetIndex = hasNextLinkNow ? 0 : multiIndex;
    if (targetIndex >= startButtons.length) {
      unipusLog(context,
        `u校园语音题：同页 ${startButtons.length} 个录音位均已处理（多题布局），结束录音循环。`);
      break;
    }
    const clickTarget = startButtons[targetIndex];
    const clickOk = clickRecordTarget(context, clickTarget);
    try {
      unipusLog(context,
        `u校园语音题：第 ${questionIndex + 1} 题开始录音点击${clickOk ? "已派发" : "失败"}，目标 ${describeElement(clickTarget)}。`);
      // 录音窗口 = 原音时长 + 2s 缓冲（参考 wenliu：固定短窗截断音频会被 SOE 判无效）；
      // 读不到原音时长时回退固定窗口。
      const sampleSeconds = readSampleAudioDurationSeconds(docNow);
      const recordWindowMs = sampleSeconds > 0
        ? Math.round(sampleSeconds * 1000) + 2000
        : VOICE_RECORD_DURATION_MS;
      await new Promise((resolve) => setTimeout(resolve, recordWindowMs));
      // 【2026-10-21 用户实测修复】停止必须点【当前正在录的那个录音位】：
      // 原实现硬编码索引 0，在多题同屏布局下会去点第 1 个（导致当前题一直在录、
      // 用户看到"每一题都没停止录音"），单题布局下 targetIndex 恰好为 0 所以没暴露。
      const outcome = await tryStopRecording(context, targetIndex);
      if (outcome === "none") {
        unipusWarn(context,
          `u校园语音题：第 ${questionIndex + 1} 题（录音位 #${targetIndex + 1}）录音停止未确认。`);
      } else {
        unipusLog(context,
          `u校园语音题：第 ${questionIndex + 1} 题（录音位 #${targetIndex + 1}）已停止录音（${outcome}）。`);
      }
      // 【关键】等评分出现再点"下一题"（wenliu 实证：不等分会把该题记为未作答）
      await waitForVoiceScore(docNow);
      // 页脚还有"下一题"？→ 组内切题
      const nextLink = docNow ? findFootLinkByText(docNow, /下一题/) : null;
      if (nextLink) {
        if (clickWithPointerSequence(context, nextLink)) {
          unipusLog(context, `u校园语音题：已点击"下一题"，等待第 ${questionIndex + 2} 题渲染。`);
        } else {
          unipusWarn(context, `u校园语音题："下一题"点击失败。`);
        }
        await new Promise((resolve) => setTimeout(resolve, VOICE_NEXT_QUESTION_SETTLE_MS));
        continue;
      }
      // 无"下一题"：若是多题同屏布局且还有未处理的录音位 → 直接处理下一个（不切组）。
      if (!nextLink) {
        multiIndex += 1;
        const remainingButtons = collectRecordButtons(docNow).length;
        if (multiIndex < remainingButtons) {
          unipusLog(context,
            `u校园语音题：同页还有 ${remainingButtons - multiIndex} 个录音位未处理，继续第 ${multiIndex + 1} 个。`);
          await new Promise((resolve) => setTimeout(resolve, VOICE_NEXT_QUESTION_SETTLE_MS));
          continue;
        }
      }
      // 无"下一题"：找下一个未完成的 Practice tab（.pc-task，非激活可点击）→ 切组
      const nextTab = findNextPracticeTab(docNow);
      if (nextTab) {
        unipusLog(context,
          `u校园语音题：组内题完成，切换下一个练习组（${describeElement(nextTab)}）。`);
        if (clickWithPointerSequence(context, nextTab)) {
          await new Promise((resolve) => setTimeout(resolve, VOICE_NEXT_QUESTION_SETTLE_MS));
          continue;
        }
        unipusWarn(context, "u校园语音题：练习组 tab 点击失败。");
      }
      // 既无"下一题"也无未完成 tab：整页语音题完成
      unipusLog(context,
        `u校园语音题：第 ${questionIndex + 1} 题完成，无"下一题"且无未完成练习组（整页语音题处理完毕，共 ${questionIndex + 1} 题）。`);
      break;
    } catch (loopError) {
      unipusWarn(context, `u校园语音题：第 ${questionIndex + 1} 题处理异常，停止循环：${loopError && loopError.message ? loopError.message : String(loopError)}`);
      break;
    }
  }
  if (questionIndex >= maxQuestions) {
    unipusWarn(context, `u校园语音题：达到循环上限 ${maxQuestions} 题，停止（防死循环）。`);
  }
  // 录音循环结束 → 状态行恢复为运行中（除非用户已停止刷课）。
  if (unipusSweepEnabled === true) {
    setUnipusPanelStatus("状态：运行中（自动答题 / 录音 / 视频倍速 / 翻页）", "ok");
  }
  return true;
}

// ==== END SECTION: unipus-voice ====

// ==== SECTION: unipus-auto-submit ====
// ---- 自动提交（主控 2026-10-18 实测需求：答案填入后自动提交并随平台切下一页）----
// 触发点：runAutoAnswer 页面填答成功 / 页面填答观察者延迟填答成功。
// 每轮只调度一次（autoSubmitState.fired 锁定），提交成功事件（handleSubmitPayload）
// 会 resetAutoSubmitState；autoSubmit 开关由 ctx.settings.autoSubmit 控制（默认 true）。
// 提交按钮查找：优先 .layout-reply-container 内 button，其次全页 button/role=button/
// class 含 submit/confirm 的元素；文本须含"提交"且不含"反馈/评论/意见"等干扰词，
// 且元素必须可见、未禁用。找不到按钮时仅警告一次（用户可提供 selector 补充）。

const AUTO_SUBMIT_CLICK_DELAY_MS = 2000; // 填答完成后等 2 秒（框架状态同步）再点击
const autoSubmitState = { timer: null, fired: false };
// 提交观测：handleSubmitPayload 置 observed=true；点击提交后 8 秒仍无提交
// 事件则警告（区分"前端校验拦截"与"提交请求正常注入"）。
let submitObserved = false;
let submitObserveTimer = null;

function resetSubmitObservation() {
  submitObserved = false;
  if (submitObserveTimer) {
    clearTimeout(submitObserveTimer);
    submitObserveTimer = null;
  }
}

function resetAutoSubmitState() {
  if (autoSubmitState.timer) {
    clearTimeout(autoSubmitState.timer);
    autoSubmitState.timer = null;
  }
  autoSubmitState.fired = false;
  resetSubmitObservation();
}

function scheduleAutoSubmit(context) {
  if (autoSubmitState.fired || autoSubmitState.timer) return; // 每轮只调度一次
  if (context && context.settings && context.settings.autoSubmit === false) {
    unipusLog(context, "u校园自动提交已关闭（settings.autoSubmit=false），等待用户手动提交。");
    return;
  }
  autoSubmitState.fired = true;
  autoSubmitState.timer = setTimeout(() => {
    autoSubmitState.timer = null;
    clickSubmitButton(context);
  }, AUTO_SUBMIT_CLICK_DELAY_MS);
}

function isElementVisible(element) {
  if (!element) return false;
  try {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch (_error) {
    return false;
  }
}

function getElementPseudoText(element) {
  try {
    const ownerDoc = element.ownerDocument;
    const view = ownerDoc && ownerDoc.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") return "";
    const before = view.getComputedStyle(element, "::before");
    const after = view.getComputedStyle(element, "::after");
    const beforeText = before && typeof before.content === "string" ? before.content : "";
    const afterText = after && typeof after.content === "string" ? after.content : "";
    // CSS content 值自带引号（如 "提交"），去掉首尾引号。
    return (beforeText + afterText).replace(/^["']+|["']+$/g, "").trim();
  } catch (_error) {
    return "";
  }
}

function findSubmitButton(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return { element: null, stats: null };
  const stats = { total: 0, foot: 0, footVisible: 0, withText: 0, texts: [], pseudo: [] };
  let footFallback = null; // 页脚最后一个可见未禁用的链接（提交按钮兜底，通常在页脚末尾）
  const consider = (element, isFoot) => {
    // 2026-10-20 实测：普通题页脚按钮文本为"提 交"（含全角/半角空格）——
    // 匹配前压缩空白，"提 交"=="提交"。语音题页为"下一题"。
    const text = asString(element.textContent).replace(/\s+/g, "").trim();
    const pseudo = isFoot ? getElementPseudoText(element).replace(/\s+/g, "") : "";
    if (/提交|下一题/.test(text) || /提交|下一题/.test(pseudo)) stats.withText += 1;
    if (stats.texts.length < 5 && /提交|下一题/.test(text)) stats.texts.push(text.slice(0, 24));
    if (stats.pseudo.length < 5 && pseudo) stats.pseudo.push(pseudo.slice(0, 24));
    if (!isElementVisible(element)) return null;
    if (isFoot) stats.footVisible += 1;
    if (element.disabled === true || element.getAttribute("aria-disabled") === "true") return null;
    // 文本或伪元素文本含"提交/下一题"（排除"提交反馈/评论/意见/问题"等干扰词）即命中。
    if (/提交|下一题/.test(text) && !/提交(?:反馈|评论|意见|问题)/.test(text)) return element;
    if (/提交|下一题/.test(pseudo)) return element;
    if (isFoot) footFallback = element;
    return null;
  };
  // 优先平台底部操作栏（用户实测：提交按钮为 #pc-foot > div > a，<a> 标签）；
  // 其次作答区内按钮；最后全页候选（button / role=button / a / class 含 submit|confirm）。
  const footSeen = new Set();
  for (const selector of ["#pc-foot > div > a", "#pc-foot a"]) {
    for (const link of safeQueryAll(doc, selector)) {
      if (footSeen.has(link)) continue;
      footSeen.add(link);
      stats.total += 1;
      stats.foot += 1;
      const hit = consider(link, true);
      if (hit) return { element: hit, stats };
    }
  }
  const seen = new Set(footSeen);
  for (const container of safeQueryAll(doc, ".layout-reply-container")) {
    for (const button of safeQueryAll(container, "button")) {
      if (seen.has(button)) continue;
      seen.add(button);
      stats.total += 1;
      const hit = consider(button, false);
      if (hit) return { element: hit, stats };
    }
  }
  for (const selector of ['button', '[role="button"]', 'a', '[class*="submit" i]', '[class*="confirm" i]']) {
    for (const element of safeQueryAll(doc, selector)) {
      if (seen.has(element)) continue;
      seen.add(element);
      stats.total += 1;
      const hit = consider(element, false);
      if (hit) return { element: hit, stats };
    }
  }
  // 页脚候选均无"提交"文本（可能为背景图渲染）时，兜底点击最后一个可见未禁用链接。
  if (footFallback) return { element: footFallback, stats };
  return { element: null, stats };
}

// 安全点击：优先原生 click()，失败回退派发 click 事件（bubbles）。
// 安全点击：原生 click() 优先；失败回退 MouseEvent（带坐标——Event 缺坐标会让
// 平台 elementFromPoint 崩溃，2026-10-20 实测）。
function clickElementSafely(context, element) {
  if (!element) return false;
  try {
    element.click();
    return true;
  } catch (_error) {
    try {
      const doc = getContextDocument(context);
      const view = (doc && doc.defaultView) || getGlobalRoot();
      const MouseEventCtor = (view && view.MouseEvent) || (typeof MouseEvent !== "undefined" ? MouseEvent : null);
      if (MouseEventCtor && typeof element.dispatchEvent === "function") {
        let rect = null;
        try { rect = element.getBoundingClientRect(); } catch (_e) { rect = null; }
        const rawX = rect && Number.isFinite(rect.left) && Number.isFinite(rect.width)
          ? rect.left + (rect.width || 0) / 2 : 0;
        const rawY = rect && Number.isFinite(rect.top) && Number.isFinite(rect.height)
          ? rect.top + (rect.height || 0) / 2 : 0;
        element.dispatchEvent(new MouseEventCtor("click", {
          bubbles: true, cancelable: true, composed: true, view,
          clientX: Number.isFinite(rawX) ? Math.round(rawX) : 0,
          clientY: Number.isFinite(rawY) ? Math.round(rawY) : 0,
          detail: 1, button: 0, buttons: 0,
        }));
        return true;
      }
    } catch (_dispatchError) {
      // 点击派发失败不抛出。
    }
  }
  return false;
}

function clickSubmitButton(context) {
  // 语音循环运行中禁止提交（双保险：见 triggerAutoAnswerOnce 的同一事故说明）。
  if (voiceLoopRunning === true) {
    unipusWarn(context, "u校园自动提交：语音逐题循环运行中，暂不提交（等录音全部完成后再提交）。");
    return false;
  }
  const doc = getContextDocument(context);
  const found = findSubmitButton(doc);
  if (!found.element) {
    const stats = found.stats || {};
    unipusWarn(context,
      `u校园自动提交：未找到提交按钮（候选 ${stats.total || 0} 个 / 页脚 #pc-foot 候选 ${stats.foot || 0} 个（可见 ${stats.footVisible || 0}）` +
      ` / 文本或伪元素含"提交" ${stats.withText || 0} 个` +
      (stats.texts && stats.texts.length ? `；文本示例：[${stats.texts.join(" | ")}]` : "") +
      (stats.pseudo && stats.pseudo.length ? `；伪元素示例：[${stats.pseudo.join(" | ")}]` : "") +
      "），请提供提交按钮 selector 以便补充查找规则。");
    return false;
  }
  let clickPathname = "";
  try { clickPathname = asString(context && context.location && context.location.pathname); } catch (_e) { clickPathname = ""; }
  if (clickWithPointerSequence(context, found.element)) {
    unipusLog(context,
      `u校园自动提交：已点击提交按钮（${describeElement(found.element)}，指针序列），等待平台提交并切下一页。`);
    // 点击后 1.2 秒捕获平台提示（校验拦截原因：请先录音/录音不完整等）
    void capturePageFeedback(context, 1200).then((feedback) => {
      if (feedback) {
        unipusWarn(context, `u校园自动提交：点击后平台提示「${feedback}」`);
      }
    });
    // 提交观测：8 秒内未观察到提交请求则警告（前端校验拦截/按钮不可用）。
    // 例外：语音题"下一题"可能为纯前端翻页（无 /submit 请求）——若按钮组已消失或
    // pathname 变化，视为翻页成功，不告警。
    const clickedText = asString(found.element.textContent).trim();
    // 提交重试（2026-10-20 实测）：语音题整页完成后点"提 交"，平台弹信息框
    // 「还有 N 道题没有作答，请完成后提交 / 我知道了」——bridge 自动点掉后，
    // 必须【再点一次"提 交"】才会弹"确认要提交吗？取消/确定"，点"确定"才真正发出
    // POST /newExploration/submit。因此 8 秒未观察到提交时自动重试点击（最多 3 次）。
    const MAX_SUBMIT_RETRY = 3;
    const observeSubmitOutcome = (attempt) => {
      resetSubmitObservation();
      submitObserveTimer = setTimeout(() => {
        submitObserveTimer = null;
        if (submitObserved) return;
        const docNow = getContextDocument(context);
        const groupGone = !docNow || !safeQuery(docNow, VOICE_RECORD_GROUP_SELECTOR);
        let pathChanged = false;
        try {
          pathChanged = Boolean(context && context.location &&
            asString(context.location.pathname) !== clickPathname);
        } catch (_error) { pathChanged = false; }
        if (/下一题/.test(clickedText) && (groupGone || pathChanged)) {
          unipusLog(context, "u校园自动提交：'下一题'点击后无提交请求但页面已切换（语音题纯前端翻页），正常。");
          return;
        }
        // 硬拦截识别（2026-10-21 实测）：平台弹「还有 N 道题没有作答，请完成后提交 / 我知道了」
        // 属于【不可绕过的硬拦截】（与"确认要提交吗？取消/确定"的软提示不同）——继续重试
        // 只会无限循环。此时停止重试，改走"左侧目录下一节"跳过该页，保证整课推进不卡死。
        let hardBlocked = false;
        try {
          for (const dlg of safeQueryAll(docNow, ".ant-modal-confirm-content, .ant-modal-body")) {
            if (/请完成后提交/.test(asString(dlg.textContent))) { hardBlocked = true; break; }
          }
        } catch (_hardBlockError) { /* 判定失败按软提示处理 */ }
        if (hardBlocked) {
          unipusWarn(context,
            "u校园自动提交：平台硬拦截（该页题目未被登记为已作答，如无原音的自由说话题），停止重试提交。");
          const nextToc = findNextTocItem(docNow);
          if (nextToc && clickWithPointerSequence(context, nextToc)) {
            unipusLog(context,
              `u校园自动提交：硬拦截后改走左侧目录下一节（${describeElement(nextToc)}），继续整课推进。`);
          } else {
            unipusWarn(context, "u校园自动提交：硬拦截且目录无下一节，停在当前页（可能已是最后一节）。");
          }
          return;
        }
        if (attempt < MAX_SUBMIT_RETRY) {
          unipusLog(context,
            `u校园自动提交：第 ${attempt} 次点击后仍无提交请求（可能被"还有 N 题未作答"信息框拦截），` +
            `自动重试第 ${attempt + 1} 次点击"提 交"...`);
          if (clickSubmitButton(context)) return;
        }
        unipusWarn(context,
          `u校园自动提交：点击 ${MAX_SUBMIT_RETRY} 次后仍未观察到提交请求（平台前端校验拦截或按钮不可用？请检查页面状态与弹窗）。`);
      }, 8000);
    };
    observeSubmitOutcome(1);
    return true;
  }
  unipusWarn(context, "u校园自动提交：提交按钮点击失败。");
  return false;
}

// ---- 自动翻页（主控 2026-10-18 实测需求：提交成功后的中间页需点击页脚
// #pc-foot > div > a（文本"继续学习"，可能同样为伪元素渲染）才进入下一题）----
// 触发点：handleSubmitPayload（提交注入成功）→ scheduleAutoContinue；
// 先等 1.5 秒（提交响应渲染），再 800ms 轮询等待按钮出现，出现即点击一次，
// 60 秒超时停止（最后一题场景）。点击后平台切下一页 → 新题拦截 →
// 新一轮自动答题（闭环，见 handleQuestionDataPayload → scheduleAutoAnswerForNewQuestions）。
const AUTO_CONTINUE_FIRST_DELAY_MS = 1000;
const AUTO_CONTINUE_POLL_MS = 500;
const AUTO_CONTINUE_TIMEOUT_MS = 60 * 1000;
const autoContinueState = { timer: null, deadline: 0, clicked: false, startedAt: 0, tocTried: false };
// 页脚无按钮持续这么久后，改走"左侧目录下一节"（见 findNextTocItem）。
const TOC_ADVANCE_AFTER_MS = 8000;

function resetAutoContinueState() {
  if (autoContinueState.timer) {
    clearTimeout(autoContinueState.timer);
    autoContinueState.timer = null;
  }
  autoContinueState.deadline = 0;
  autoContinueState.clicked = false;
}

// ---- 目录推进（2026-10-21 真实平台实测补缺口）----
// 场景：某些节（如 6-3 Listening 导语页）页脚为空（#pc-foot 内无 a），也没有题目，
// 提交后无"继续学习/下一题"可点 → 自动流程停滞。此时改点【左侧微课菜单的下一个条目】。
// 结构（实测）：左侧 [data-role="micro"]（class pc-slider-menu-micro），
// 当前激活项 class 含 pc-menu-activity；下一项即要进入的节。
function findNextTocItem(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return null;
  const items = safeQueryAll(doc, '[data-role="micro"]');
  if (!items.length) return null;
  let activeIndex = -1;
  for (let i = 0; i < items.length; i += 1) {
    if (/pc-menu-activity/.test(asString(items[i].className))) { activeIndex = i; break; }
  }
  if (activeIndex < 0 || activeIndex + 1 >= items.length) return null;
  const next = items[activeIndex + 1];
  if (!next || !isElementVisible(next)) return null;
  return next;
}

// 在页脚候选（用户实测 selector）中按文本/伪元素文本查找链接。
function findFootLinkByText(doc, pattern) {
  if (!doc || typeof doc.querySelectorAll !== "function") return null;
  const seen = new Set();
  for (const selector of ["#pc-foot > div > a", "#pc-foot a"]) {
    for (const link of safeQueryAll(doc, selector)) {
      if (seen.has(link)) continue;
      seen.add(link);
      const text = asString(link.textContent).replace(/\s+/g, "").trim();
      const pseudo = getElementPseudoText(link).replace(/\s+/g, "");
      if (!pattern.test(text) && !pattern.test(pseudo)) continue;
      if (!isElementVisible(link)) continue;
      if (link.disabled === true || link.getAttribute("aria-disabled") === "true") continue;
      return link;
    }
  }
  return null;
}

function scheduleAutoContinue(context) {
  resetAutoContinueState();
  autoContinueState.startedAt = Date.now();
  autoContinueState.deadline = Date.now() + AUTO_CONTINUE_TIMEOUT_MS;
  autoContinueState.timer = setTimeout(() => pollAutoContinue(context), AUTO_CONTINUE_FIRST_DELAY_MS);
}

function pollAutoContinue(context) {
  autoContinueState.timer = null;
  const doc = getContextDocument(context);
  // 语音题页脚为"下一题"（2026-10-20 实测），其余场景为"继续学习"——一并匹配。
  const link = doc ? findFootLinkByText(doc, /继续学习|下一题/) : null;
  if (link) {
    autoContinueState.clicked = true;
    if (clickWithPointerSequence(context, link)) {
      unipusLog(context,
        `u校园自动翻页：已点击页脚翻页按钮（${describeElement(link)}，指针序列），等待下一页题目到达。`);
      void capturePageFeedback(context, 1200).then((feedback) => {
        if (feedback) unipusWarn(context, `u校园自动翻页：点击后平台提示「${feedback}」`);
      });
    } else {
      unipusWarn(context, "u校园自动翻页：页脚翻页按钮点击失败。");
    }
    return;
  }
  // 页脚长时间无按钮（如导语页）→ 尝试点左侧目录的下一节（只试一次）。
  if (!autoContinueState.tocTried &&
      autoContinueState.startedAt &&
      Date.now() - autoContinueState.startedAt >= TOC_ADVANCE_AFTER_MS) {
    autoContinueState.tocTried = true;
    const nextToc = findNextTocItem(doc);
    if (nextToc) {
      if (clickWithPointerSequence(context, nextToc)) {
        autoContinueState.clicked = true;
        unipusLog(context,
          `u校园自动翻页：页脚无按钮，改点左侧目录下一节（${describeElement(nextToc)}），等待新节内容。`);
        return;
      }
      unipusWarn(context, "u校园自动翻页：目录下一节点击失败。");
    } else {
      unipusLog(context, "u校园自动翻页：页脚无按钮且目录中无下一节（可能已是最后一节）。");
    }
  }
  if (Date.now() >= autoContinueState.deadline) {
    unipusWarn(context, "u校园自动翻页：60 秒内未出现“继续学习/下一题”按钮，已停止等待（可手动点击继续）。");
    return;
  }
  autoContinueState.timer = setTimeout(() => pollAutoContinue(context), AUTO_CONTINUE_POLL_MS);
}

// ---- 空闲看门狗（2026-10-21 真实平台实测补缺口）----
// 问题：自动翻页轮询在点击"继续学习"后就结束了；若下一节是导语页（无题目、页脚为空，
// 如 6-3 Listening），没有任何事件接手 → 整课循环停滞。
// 方案：常驻看门狗每 5s 检查；页面【完全无交互内容】且空闲 ≥ IDLE_ADVANCE_MS 时，
// 点左侧目录的下一节推进（每页只推一次，防抖）。
// "有交互内容"包括：录音位、题目容器/选项/输入框、页脚按钮、音视频、iframe、textarea
// ——出现任意一种都视为正常页面，不推进（避免误跳过视频/听力页）。
const IDLE_ADVANCE_MS = 12000;
// 卡死逃生：页面【有题目】但适配器长时间没有任何动作（题型未覆盖、题目数据未到达等）
// → 兜底点页脚"提交/下一题"推进，避免整课循环永久死锁（实测：6-4 Viewing 有 2 道
// textarea 题但适配器"未获取到任何题目"）。阈值取大一些，避免抢在数据到达前误提交。
const STUCK_ESCAPE_MS = 60000;
// 适配器已明确"取不到题目"时用的短阈值：此时 60s 纯属等待（题目若稍后到达，答题流程
// 会置 busy 并重置计时，不会误提交）。20s 足以覆盖"数据还在路上"的常见情况。
const STUCK_ESCAPE_FAST_MS = 20000;
// 适配器最近一次确认"无题可答"的时间戳（0 = 未确认）。
let unipusNoQuestionConfirmedAt = 0;
const IDLE_WATCH_INTERVAL_MS = 5000;
const idleWatchState = { timer: null, lastActivityAt: 0, advancedHash: "", lastSignature: "" };

function unipusPageSignature(context) {
  try {
    const view = getContextWindow(context);
    const hash = String(view && view.location ? view.location.hash : "") || "";
    // 页脚按钮文本纳入标识（2026-10-21 实测必要）：兜底提交后页面从"提交"变为
    // "继续学习"（答题小结页），但 hash 不变——若只按 hash 去重，看门狗的"每页一次"
    // 护栏会挡住这一次推进，导致卡在答题小结页。
    let footText = "";
    try {
      const doc = getContextDocument(context);
      const foot = doc && typeof doc.querySelector === "function" ? doc.querySelector("#pc-foot") : null;
      if (foot) {
        footText = asString(foot.textContent).replace(/\s+/g, "").slice(0, 12);
      }
    } catch (_footError) { /* 页脚不可读时只用 hash */ }
    return hash + "|" + footText;
  } catch (_error) {
    return "";
  }
}

function unipusHasInteractiveContent(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return true; // 无法判定时不推进
  // 1) 题目/录音类容器：命中即视为"有内容"（这些是真正需要作答的）。
  const containerSelectors = [
    VOICE_RECORD_BUTTON_SELECTOR,
    ".ucomp-recorder",
    ".question-common-abs-reply",
    ".question-common-abs-banked-cloze",
    ".fe-scoop",
    ".option.isNotReview",
  ];
  for (const selector of containerSelectors) {
    if (safeQueryAll(doc, selector).length) return true;
  }
  // 2) 输入类：排除页头/导航/搜索框（2026-10-21 实测：页面有 1 个搜索框，
  //    若一并计入会导致"永远有内容"，看门狗永不触发）。
  const inputSelector = 'textarea, input[type="text"], input[type="radio"], input[type="checkbox"]';
  for (const element of safeQueryAll(doc, inputSelector)) {
    try {
      if (element.closest && element.closest('header, nav, [class*="search"], [class*="header"], [class*="navbar"]')) continue;
    } catch (_closestError) { /* closest 不可用时按内容处理 */ }
    return true;
  }
  // 注意：这里【不】把页脚按钮算作"有内容"——否则导语页（页脚有"提交"但无题目）
  // 会永远判定为"有内容"，看门狗无法触发空闲推进（2026-10-21 实测：6-4 Viewing 卡住）。
  // 页脚按钮由看门狗的空闲分支处理（空闲到时点它）。
  return false;
}

function startUnipusIdleWatcher(context) {
  if (idleWatchState.timer) return;
  idleWatchState.lastActivityAt = Date.now();
  idleWatchState.timer = setInterval(() => {
    try {
      const doc = getContextDocument(context);
      if (!doc) return;
      // 面板自愈：平台 SPA 重渲染会清掉 body 子节点，导致面板与日志消失。
      // buildUnipusUi 幂等（已存在直接返回），这里定期确保它还在。
      try { buildUnipusUi(); } catch (_uiRebuildError) { /* 忽略 */ }
      // 全局"停止刷课"时看门狗完全不动页面（仅保持巡检）。
      if (unipusSweepEnabled !== true) return;
      const hash = unipusPageSignature(context);
      // 页面状态变化（含页脚按钮变化）→ 重置空闲预算，给新页面充分时间渲染题目，
      // 避免"上一页已积攒的空闲时间"让看门狗在新页题目出现前就急着点提交
      // （2026-10-21 实测风险：不重置会导致连点 提交→继续学习→提交，可能跳过内容）。
      if (idleWatchState.lastSignature !== hash) {
        idleWatchState.lastSignature = hash;
        idleWatchState.lastActivityAt = Date.now();
        return;
      }
      // "有人在干活"：答题求解中 / 语音逐题循环中 → 视为活跃，重置空闲计时。
      const busy = Boolean(autoAnswerState && autoAnswerState.running) || voiceLoopRunning === true;
      if (busy) {
        idleWatchState.lastActivityAt = Date.now();
        return;
      }
      const hasContent = unipusHasInteractiveContent(doc);
      const idleMs = Date.now() - idleWatchState.lastActivityAt;
      // 有题目但无人处理 → 用更保守的卡死逃生阈值；无内容 → 用普通空闲阈值。
      // 自适应阈值：已确认无题可答 → 20s（快速跳过未覆盖题型页）；否则 60s（给题目
      // 数据到达与求解留足时间）；无内容页 → 12s。
      const noQuestionConfirmed = unipusNoQuestionConfirmedAt > idleWatchState.lastActivityAt;
      const threshold = hasContent
        ? (noQuestionConfirmed ? STUCK_ESCAPE_FAST_MS : STUCK_ESCAPE_MS)
        : IDLE_ADVANCE_MS;
      if (idleMs < threshold) return;
      if (idleWatchState.advancedHash === hash) return; // 每页只推一次
      // 情况 A：无题目但页脚有按钮（实测 6-4 Viewing 导语页：页脚有"提交"却无可答题目）
      // ——直接点它推进；否则会卡住（看门狗因"有可见按钮"不推进，自动提交又因"无题目"不触发）。
      const footAction = findFootLinkByText(doc, /提交|下一题|继续学习/);
      if (footAction) {
        idleWatchState.advancedHash = hash;
        if (clickWithPointerSequence(context, footAction)) {
          unipusLog(context,
            `u校园空闲推进：页面无适配器可处理的动作（题题型未覆盖或已作答）且空闲 ${Math.round(idleMs / 1000)}s，点击页脚按钮推进（${describeElement(footAction)}）。`);
        }
        return;
      }
      // 情况 B：页脚为空 → 点左侧目录的下一节。
      const nextToc = findNextTocItem(doc);
      if (!nextToc) {
        idleWatchState.advancedHash = hash; // 已是最后一节，不再重复尝试
        return;
      }
      idleWatchState.advancedHash = hash;
      if (clickWithPointerSequence(context, nextToc)) {
        unipusLog(context,
          `u校园目录推进：当前页无题目/按钮且空闲 ${Math.round(idleMs / 1000)}s，自动进入下一节（${describeElement(nextToc)}）。`);
      }
    } catch (_watchError) { /* 看门狗异常不影响主流程 */ }
  }, IDLE_WATCH_INTERVAL_MS);
}

function stopUnipusIdleWatcher() {
  if (idleWatchState.timer) {
    clearInterval(idleWatchState.timer);
    idleWatchState.timer = null;
  }
}

// ==== END SECTION: unipus-auto-submit ====

// ==== SECTION: unipus-keep-alive ====
// ---- 保活接线 ----
// 复用 globalThis.__COURSE_HELPER_KEEP_ALIVE__（挂载名与 content/keep-alive.js 的 MARKER
// 一致，AGENT 08 已实现：模拟活动事件、HEAD 网络 ping、WebSocket 心跳、挂机弹窗点击）。
// 注意 loader 已全局启动保活（三平台统一），本函数是 unipus 侧幂等接线，
// keep-alive 内部为单例 state，重复 start 安全。
// 全局 API 不可用时降级为简易 visibility/focus 监听（重新可见时发一次轻量事件）
// 并 console 警告"keep-alive 不可用"。

export function startKeepAlive(doc) {
  const api = readKeepAliveApi();
  if (api) {
    try {
      // start/init 内部幂等（keep-alive 为单例 state）
      if (typeof api.start === "function") api.start(doc);
      else if (typeof api.init === "function") api.init(doc);
      unipusLog(activeContext, "u校园保活：keep-alive 已启动（unipus 侧幂等接线）。");
      return () => stopKeepAliveApi(api);
    } catch (_error) {
      // keep-alive 启动失败不能阻断题目拦截与答题流程，继续走降级。
      unipusWarn(activeContext, "keep-alive 启动失败，启用简易 visibility/focus 保活降级。");
    }
  } else {
    unipusWarn(activeContext,
      "keep-alive 不可用（globalThis.__COURSE_HELPER_KEEP_ALIVE__ 缺失），启用简易 visibility/focus 保活降级。");
  }
  return installDegradedKeepAlive(doc);
}

function readKeepAliveApi() {
  try {
    const value = typeof globalThis !== "undefined" ? globalThis[KEEP_ALIVE_GLOBAL_KEY] : undefined;
    if (value && (typeof value.start === "function" || typeof value.init === "function")) {
      return value;
    }
  } catch (_error) {
    // 页面全局被代理拦截时按不可用处理。
  }
  return null;
}

function stopKeepAliveApi(api) {
  try {
    if (api && typeof api.stop === "function") api.stop();
    else if (api && typeof api.destroy === "function") api.destroy();
  } catch (_error) {
    // keep-alive 已失效时忽略停止错误。
  }
}

// 降级保活：页面重新可见/聚焦时派发一次轻量事件（事件名见
// DEGRADED_KEEP_ALIVE_WAKE_EVENT）。不能替代 keep-alive 的弹窗检测与活动模拟，
// 仅提示页面用户已回来（供后续分区/页面脚本自行响应）。
function installDegradedKeepAlive(doc) {
  const target = doc || getContextDocument(activeContext);
  const view = getContextWindow(activeContext);
  const cleanups = [];
  const wake = () => dispatchWakeEvent(target);
  if (target) {
    attachListener(target, "visibilitychange", () => {
      const hidden = target.hidden === true || target.visibilityState === "hidden";
      if (!hidden) wake();
    }, cleanups);
  }
  if (view) {
    attachListener(view, "focus", wake, cleanups);
  }
  if (!cleanups.length) return null; // 无任何可挂监听
  return () => runCleanups(cleanups);
}

// 轻量事件构造：Event 构造器优先，回退 document.createEvent，再回退最小对象。
function dispatchWakeEvent(doc) {
  if (!doc || typeof doc.dispatchEvent !== "function") return;
  try {
    const view = (doc.defaultView && doc.defaultView) || getGlobalRoot();
    const EventConstructor =
      (view && view.Event) || (typeof Event !== "undefined" ? Event : null);
    let event = null;
    if (EventConstructor) {
      try {
        event = new EventConstructor(DEGRADED_KEEP_ALIVE_WAKE_EVENT);
      } catch (_error) {
        event = null;
      }
    }
    if (!event && typeof doc.createEvent === "function") {
      try {
        event = doc.createEvent("Event");
        event.initEvent(DEGRADED_KEEP_ALIVE_WAKE_EVENT, false, false);
      } catch (_error) {
        event = null;
      }
    }
    if (!event) event = { type: DEGRADED_KEEP_ALIVE_WAKE_EVENT };
    doc.dispatchEvent(event);
  } catch (_error) {
    // 轻量事件失败不影响保活主流程。
  }
}

// ==== END SECTION: unipus-keep-alive ====

// ==== SECTION: unipus-video ====
// ---- 视频自动播放 + 倍速（2026-10-21 用户需求；参考 chaoxing/zhihuishu 的自包含实现）----
// 行为：接管页面所有 <video>（含后插入的）——尝试自动播放并设置倍速；
// 自动播放被浏览器策略拒绝时，自动转为静音重试（保留可听场景：先带声试，失败才静音）。
// 倍速来源：ctx.settings.videoSpeed（1–8 钳制），默认 2。
const UNIPUS_VIDEO_DEFAULT_RATE = 3; // 与 loader settings 默认 videoSpeed=3 对齐
const UNIPUS_VIDEO_POLL_MS = 2000;
let unipusVideoTimer = null;
// 是否允许整课自动化（面板"开始/停止刷课"与 chrome.storage.local.autoAnswer 同步）。
let unipusSweepEnabled = true;

function readUnipusVideoRate(context) {
  const configured = Number(context && context.settings && context.settings.videoSpeed);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.max(configured, 1), 8);
  }
  return UNIPUS_VIDEO_DEFAULT_RATE;
}

function applyUnipusVideoPolicy(context) {
  if (unipusSweepEnabled !== true) return;
  const doc = getContextDocument(context);
  if (!doc || typeof doc.querySelectorAll !== "function") return;
  const rate = readUnipusVideoRate(context);
  let videos = [];
  try {
    videos = Array.prototype.slice.call(doc.querySelectorAll("video"));
  } catch (_queryError) {
    return;
  }
  for (const video of videos) {
    try {
      if (video.__chVideoHandled !== true) {
        video.__chVideoHandled = true;
        // 倍速保持：平台或用户改动后拉回（避免被重置为 1x）。
        video.addEventListener("ratechange", () => {
          try {
            if (Math.abs(video.playbackRate - readUnipusVideoRate(context)) > 0.01) {
              video.playbackRate = readUnipusVideoRate(context);
            }
          } catch (_rateError) { /* 只读媒体对象忽略 */ }
        });
        video.addEventListener("play", () => {
          try { video.playbackRate = readUnipusVideoRate(context); } catch (_playError) {}
        });
        unipusLog(context, `u校园视频：已接管视频元素（目标倍速 ${rate}x，尝试静音自动播放）。`);
      }
      if (Math.abs(video.playbackRate - rate) > 0.01) {
        video.playbackRate = rate;
      }
      if (video.paused && !video.ended && video.readyState >= 2) {
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(() => {
            // 自动播放被拒（需用户手势）→ 静音后重试（静音始终允许自动播放）。
            try {
              video.muted = true;
              video.volume = 0;
              const retry = video.play();
              if (retry && typeof retry.catch === "function") retry.catch(() => {});
            } catch (_muteError) { /* 忽略 */ }
          });
        }
      }
    } catch (_videoError) { /* 单个视频异常不影响其它 */ }
  }
}

function startUnipusVideoPolicy(context) {
  if (unipusVideoTimer) return;
  applyUnipusVideoPolicy(context);
  unipusVideoTimer = setInterval(() => applyUnipusVideoPolicy(context), UNIPUS_VIDEO_POLL_MS);
  unipusLog(context,
    `u校园视频：自动播放 + 倍速已启动（当前倍速 ${readUnipusVideoRate(context)}x，每 ${UNIPUS_VIDEO_POLL_MS / 1000}s 巡检）。`);
}

function stopUnipusVideoPolicy() {
  if (unipusVideoTimer) {
    clearInterval(unipusVideoTimer);
    unipusVideoTimer = null;
  }
}

// ==== END SECTION: unipus-video ====

// ==== SECTION: unipus-ui ====
// ---- 控制面板 UI（2026-10-20 参考 wenliu 深色主题设计）----
// 功能：挂机总开关（暂停/恢复逐题循环）、语音设置（录音窗口缓冲/评分等待开关）、
// 实时日志（滚动显示最近 30 条 unipusLog/unipusWarn）、悬浮球（面板关闭后可唤回）。
// 纯 DOM 注入，无外部资源；样式 scoped 前缀 ch- 防与平台冲突。

const UI_STORAGE_KEYS = {
  autopilot: "chUnipusAutopilot",
  scoreWait: "chUnipusScoreWait",
};

function readUiSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "true";
  } catch (_error) {
    return fallback;
  }
}

function writeUiSetting(key, value) {
  try { localStorage.setItem(key, String(value)); } catch (_error) { /* 隐私模式忽略 */ }
}

// 日志环形缓冲（UI 显示用；unipusLog/unipusWarn 尾部转发进来）
const uiLogBuffer = [];
const UI_LOG_MAX = 30;
function pushUiLog(message, isWarn) {
  const time = new Date().toTimeString().slice(0, 8);
  uiLogBuffer.push({ time, message: String(message).slice(0, 160), isWarn: !!isWarn });
  while (uiLogBuffer.length > UI_LOG_MAX) uiLogBuffer.shift();
  const box = typeof document !== "undefined"
    ? document.getElementById("ch-ui-log") : null;
  if (box) {
    const line = document.createElement("div");
    line.className = isWarn ? "ch-log-line ch-log-warn" : "ch-log-line";
    line.textContent = "[" + time + "] " + message;
    box.appendChild(line);
    while (box.children.length > UI_LOG_MAX) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
}

// 更新页内面板状态行（面板未就绪时静默忽略）。
function setUnipusPanelStatus(text, tone) {
  try {
    const setter = globalThis.__chUnipusSetStatus;
    if (typeof setter === "function") setter(text, tone);
  } catch (_statusError) { /* 忽略 */ }
}

function buildUnipusUi() {
  const doc = typeof document !== "undefined" ? document : null;
  if (!doc || !doc.body) return;
  if (doc.getElementById("ch-panel")) return; // 幂等

  const style = doc.createElement("style");
  style.textContent = [
    "#ch-panel{position:fixed;top:16px;right:16px;z-index:2147483000;width:300px;font-family:'PingFang SC',system-ui,sans-serif;background:#0f1420;color:#f0f4ff;border:1px solid rgba(255,255,255,.09);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.45);overflow:hidden;font-size:12px}",
    "#ch-panel.ch-hidden{display:none}",
    ".ch-head{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;background:rgba(255,255,255,.03);border-bottom:1px solid rgba(255,255,255,.07)}",
    ".ch-dot{width:8px;height:8px;border-radius:50%;background:#4ade80;flex-shrink:0}",
    ".ch-title{font-weight:600;font-size:13px;flex:1}",
    ".ch-x{background:none;border:none;color:#7a8499;cursor:pointer;font-size:13px;padding:2px 6px;border-radius:6px}",
    ".ch-x:hover{color:#f0f4ff;background:rgba(255,255,255,.08)}",
    ".ch-body{padding:10px 12px;display:flex;flex-direction:column;gap:9px;max-height:min(76vh,640px);overflow-y:auto}",
    ".ch-row{display:flex;align-items:center;justify-content:space-between;gap:8px}",
    ".ch-label{color:#aab3c5}",
    ".ch-switch{width:34px;height:19px;border-radius:10px;background:rgba(255,255,255,.15);border:none;position:relative;cursor:pointer;flex-shrink:0;transition:background .25s}",
    ".ch-switch::after{content:'';position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:left .25s}",
    ".ch-switch.ch-on{background:#38bdf8}",
    ".ch-switch.ch-on::after{left:17px}",
    ".ch-btn{background:linear-gradient(135deg,#059669,#047857);color:#fff;border:none;border-radius:9px;padding:8px 10px;font-size:12px;font-weight:600;cursor:pointer}",
    ".ch-btn.ch-stop{background:linear-gradient(135deg,#991b1b,#7f1d1d)}",
    ".ch-log{flex:1;min-height:110px;max-height:170px;overflow-y:auto;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.06);border-radius:9px;padding:8px;font-family:Consolas,monospace;font-size:11px;line-height:1.55}",
    ".ch-log::-webkit-scrollbar{width:5px}",
    ".ch-log::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:4px}",
    ".ch-log-line{color:#9fb0c8;word-break:break-all}",
    ".ch-log-warn{color:#fbbf24}",
    "#ch-ball{position:fixed;left:16px;bottom:16px;z-index:2147483000;width:42px;height:42px;border-radius:50%;background:#0f1420;color:#38bdf8;border:1px solid rgba(255,255,255,.14);display:none;align-items:center;justify-content:center;cursor:pointer;font-size:17px;box-shadow:0 4px 18px rgba(0,0,0,.5)}",
    "#ch-ball:hover{border-color:#38bdf8}",
    ".ch-status{font-size:11px;line-height:1.5}",
    ".ch-pills{display:flex;gap:4px}",
    ".ch-pill{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#aab3c5;border-radius:12px;padding:3px 9px;font-size:11px;cursor:pointer}",
    ".ch-pill:hover{color:#f0f4ff;border-color:rgba(255,255,255,.25)}",
    ".ch-pill-on{background:linear-gradient(135deg,rgba(56,189,248,.28),rgba(129,140,248,.22));border-color:rgba(56,189,248,.5);color:#f0f4ff;font-weight:600}",
    ".ch-col{display:flex;flex-direction:column;gap:5px}",
    ".ch-input{width:100%;box-sizing:border-box;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.12);color:#f0f4ff;border-radius:8px;padding:6px 8px;font-size:11px;font-family:Consolas,monospace;outline:none}",
    ".ch-input:focus{border-color:rgba(56,189,248,.6)}",
    ".ch-input-row{display:flex;gap:6px;align-items:center}",
    ".ch-btn-sm{padding:6px 10px;font-size:11px;border-radius:8px}",
    ".ch-key-status{font-size:10px}",
  ].join("");
  doc.head.appendChild(style);

  const panel = doc.createElement("div");
  panel.id = "ch-panel";

  const head = doc.createElement("div");
  head.className = "ch-head";
  const dot = doc.createElement("span");
  dot.className = "ch-dot";
  dot.id = "ch-state-dot";
  const title = doc.createElement("span");
  title.className = "ch-title";
  title.textContent = "刷课助手 · u校园";
  const closeBtn = doc.createElement("button");
  closeBtn.className = "ch-x";
  closeBtn.textContent = "×";
  head.appendChild(dot); head.appendChild(title); head.appendChild(closeBtn);

  const body = doc.createElement("div");
  body.className = "ch-body";

  // ---- 全局主开关：开始 / 停止刷课（2026-10-21 用户需求：面板应是整体控制，而非只管语音题）----
  const sweepBtn = doc.createElement("button");
  sweepBtn.className = "ch-btn";
  sweepBtn.id = "ch-sweep-toggle";
  const sweepState = doc.createElement("div");
  sweepState.className = "ch-status";
  sweepState.id = "ch-sweep-status";

  // 供适配器其它部分更新状态行（如语音题进度）
  globalThis.__chUnipusSetStatus = (text, tone) => {
    try {
      const el = doc.getElementById("ch-sweep-status");
      if (!el) return;
      el.textContent = text;
      el.style.color = tone === "warn" ? "#fbbf24" : (tone === "ok" ? "#4ade80" : "#9fb0c8");
    } catch (_statusError) { /* 面板未就绪忽略 */ }
  };

  const renderSweep = () => {
    const on = unipusSweepEnabled === true;
    sweepBtn.textContent = on ? "⏹ 停止刷课" : "▶ 开始刷课";
    if (on) sweepBtn.classList.add("ch-stop"); else sweepBtn.classList.remove("ch-stop");
    sweepState.textContent = on
      ? "状态：运行中（自动答题 / 录音 / 视频倍速 / 翻页）"
      : "状态：已停止（不再自动操作页面）";
    sweepState.style.color = on ? "#4ade80" : "#fbbf24";
  };
  sweepBtn.addEventListener("click", () => {
    unipusSweepEnabled = !unipusSweepEnabled;
    // 同步 chrome.storage.local.autoAnswer（runAutoAnswer 会读取该开关；刷新后仍生效）。
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ autoAnswer: unipusSweepEnabled });
      }
    } catch (_storageError) { /* 无 chrome 环境忽略 */ }
    // 同步运行时快照，避免其它分支读到旧值（settings 是 loader 初始化时的快照）。
    try {
      if (activeContext && activeContext.settings) activeContext.settings.autoAnswer = unipusSweepEnabled;
    } catch (_settingsSyncError) { /* 忽略 */ }
    renderSweep();
    pushUiLog(unipusSweepEnabled ? "已开始刷课" : "已停止刷课（当前动作完成后不再自动操作）", !unipusSweepEnabled);
    if (unipusSweepEnabled) {
      scheduleAutoAnswerForNewQuestions();
    } else {
      // 停止时把状态行文案拉回"已停止"（语音进度等动态文案清除）
      renderSweep();
    }
  });
  renderSweep();

  // 语音题不再单列开关：统一由「开始/停止刷课」驱动（见 runAutoAnswer → simulateVoiceRecordings）。
  // 实测原「语音题挂机」「停止后等评分」两个开关只写 localStorage、无逻辑读取（死开关），已移除。

  // 视频倍速（写 chrome.storage.local.videoSpeed，即时生效）
  const videoRow = doc.createElement("div");
  videoRow.className = "ch-row";
  const videoLabel = doc.createElement("span");
  videoLabel.className = "ch-label";
  videoLabel.textContent = "视频倍速";
  const videoPills = doc.createElement("span");
  videoPills.className = "ch-pills";
  const currentRate = readUnipusVideoRate(activeContext);
  const rateButtons = [];
  [1, 1.5, 2, 3].forEach((rate) => {
    const pill = doc.createElement("button");
    pill.className = "ch-pill" + (Math.abs(rate - currentRate) < 0.01 ? " ch-pill-on" : "");
    pill.textContent = rate + "x";
    pill.addEventListener("click", () => {
      rateButtons.forEach((b) => b.classList.remove("ch-pill-on"));
      pill.classList.add("ch-pill-on");
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ videoSpeed: rate });
        }
      } catch (_storageError) { /* 忽略 */ }
      if (activeContext && activeContext.settings) activeContext.settings.videoSpeed = rate;
      applyUnipusVideoPolicy(activeContext);
      pushUiLog("视频倍速已设为 " + rate + "x", false);
    });
    rateButtons.push(pill);
    videoPills.appendChild(pill);
  });
  videoRow.appendChild(videoLabel);
  videoRow.appendChild(videoPills);

  // ---- DeepSeek API Key（页内配置，免去点扩展图标；选择题/填空题必需）----
  const keyCol = doc.createElement("div");
  keyCol.className = "ch-col";
  const keyLabelRow = doc.createElement("div");
  keyLabelRow.className = "ch-row";
  const keyLabel = doc.createElement("span");
  keyLabel.className = "ch-label";
  keyLabel.textContent = "DeepSeek API Key";
  const keyStatus = doc.createElement("span");
  keyStatus.className = "ch-status ch-key-status";
  keyStatus.id = "ch-key-status";
  keyLabelRow.appendChild(keyLabel);
  keyLabelRow.appendChild(keyStatus);

  const keyInputRow = doc.createElement("div");
  keyInputRow.className = "ch-input-row";
  const keyInput = doc.createElement("input");
  keyInput.type = "password";
  keyInput.className = "ch-input";
  keyInput.id = "ch-api-key";
  keyInput.placeholder = "sk-...（留空则清空）";
  const keyEye = doc.createElement("button");
  keyEye.className = "ch-btn ch-btn-sm";
  keyEye.textContent = "👁";
  keyEye.title = "显示 / 隐藏";
  const keySave = doc.createElement("button");
  keySave.className = "ch-btn ch-btn-sm";
  keySave.id = "ch-key-save";
  keySave.textContent = "保存";
  keyInputRow.appendChild(keyInput);
  keyInputRow.appendChild(keyEye);
  keyInputRow.appendChild(keySave);

  const renderKeyStatus = (value) => {
    const configured = typeof value === "string" && value.length > 8 && value.indexOf("<YOUR") === -1;
    keyStatus.textContent = configured ? "已配置" : "未配置（选择题/填空题答不了）";
    keyStatus.style.color = configured ? "#4ade80" : "#fbbf24";
  };
  renderKeyStatus("");

  keyEye.addEventListener("click", () => {
    keyInput.type = keyInput.type === "password" ? "text" : "password";
    keyEye.textContent = keyInput.type === "password" ? "👁" : "🙈";
  });
  keySave.addEventListener("click", () => {
    const value = String(keyInput.value || "").trim();
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ deepseekApiKey: value });
        renderKeyStatus(value);
        pushUiLog(value ? "API Key 已保存（选择题/填空题可自动作答）" : "API Key 已清空", !value);
      } else {
        pushUiLog("保存失败：chrome.storage 不可用", true);
      }
    } catch (_saveError) {
      pushUiLog("保存失败：" + (_saveError && _saveError.message ? _saveError.message : "未知错误"), true);
    }
  });

  keyCol.appendChild(keyLabelRow);
  keyCol.appendChild(keyInputRow);

  // ---- 题库 API（可选，唯一题库来源；未配置则只用 DeepSeek）----
  const bankCol = doc.createElement("div");
  bankCol.className = "ch-col";
  const bankLabelRow = doc.createElement("div");
  bankLabelRow.className = "ch-row";
  const bankLabel = doc.createElement("span");
  bankLabel.className = "ch-label";
  bankLabel.textContent = "题库 API";
  const bankStatus = doc.createElement("span");
  bankStatus.className = "ch-status ch-key-status";
  bankLabelRow.appendChild(bankLabel);
  bankLabelRow.appendChild(bankStatus);

  const bankUrlRow = doc.createElement("div");
  bankUrlRow.className = "ch-input-row";
  const bankUrlInput = doc.createElement("input");
  bankUrlInput.type = "text";
  bankUrlInput.className = "ch-input";
  bankUrlInput.id = "ch-bank-url";
  bankUrlInput.placeholder = "https://题库/api/query（留空=只用 DeepSeek）";
  const bankSave = doc.createElement("button");
  bankSave.className = "ch-btn ch-btn-sm";
  bankSave.id = "ch-bank-save";
  bankSave.textContent = "保存";
  bankUrlRow.appendChild(bankUrlInput);
  bankUrlRow.appendChild(bankSave);

  const bankKeyRow = doc.createElement("div");
  bankKeyRow.className = "ch-input-row";
  const bankKeyInput = doc.createElement("input");
  bankKeyInput.type = "password";
  bankKeyInput.className = "ch-input";
  bankKeyInput.id = "ch-bank-key";
  bankKeyInput.placeholder = "题库 Key（可选）";
  const bankKeyEye = doc.createElement("button");
  bankKeyEye.className = "ch-btn ch-btn-sm";
  bankKeyEye.textContent = "👁";
  bankKeyEye.title = "显示 / 隐藏";
  bankKeyRow.appendChild(bankKeyInput);
  bankKeyRow.appendChild(bankKeyEye);

  const renderBankStatus = (url) => {
    const configured = typeof url === "string" && /^https?:\/\//i.test(url.trim());
    bankStatus.textContent = configured ? "已启用（先查题库）" : "未配置（仅 DeepSeek）";
    bankStatus.style.color = configured ? "#4ade80" : "#94a3b8";
  };
  renderBankStatus("");

  bankKeyEye.addEventListener("click", () => {
    bankKeyInput.type = bankKeyInput.type === "password" ? "text" : "password";
    bankKeyEye.textContent = bankKeyInput.type === "password" ? "👁" : "🙈";
  });
  bankSave.addEventListener("click", () => {
    const url = String(bankUrlInput.value || "").trim();
    const key = String(bankKeyInput.value || "").trim();
    if (url && !/^https?:\/\//i.test(url)) {
      pushUiLog("题库 API 地址需以 http(s):// 开头", true);
      return;
    }
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          questionBankUrl: url,
          questionBankKey: key,
          questionBankEnabled: Boolean(url)
        });
        renderBankStatus(url);
        pushUiLog(url ? "题库 API 已保存（答题先查题库，未命中走 DeepSeek）" : "题库 API 已清空（只用 DeepSeek）", false);
      } else {
        pushUiLog("保存失败：chrome.storage 不可用", true);
      }
    } catch (_bankSaveError) {
      pushUiLog("保存失败：" + (_bankSaveError && _bankSaveError.message ? _bankSaveError.message : "未知错误"), true);
    }
  });

  bankCol.appendChild(bankLabelRow);
  bankCol.appendChild(bankUrlRow);
  bankCol.appendChild(bankKeyRow);

  // 本页立即执行
  const runBtn = doc.createElement("button");
  runBtn.className = "ch-btn";
  runBtn.id = "ch-run-now";
  runBtn.textContent = "▶ 本页立即执行（答题+录音）";
  runBtn.addEventListener("click", () => {
    if (unipusSweepEnabled !== true) {
      pushUiLog("刷课已停止，请先点「开始刷课」", true);
      return;
    }
    pushUiLog("手动触发一轮执行", false);
    resetAutoAnswerState();
    void triggerAutoAnswerOnce();
  });

  // 日志区
  const log = doc.createElement("div");
  log.className = "ch-log";
  log.id = "ch-ui-log";

  body.appendChild(sweepBtn);
  body.appendChild(sweepState);
  body.appendChild(videoRow);
  body.appendChild(keyCol);
  body.appendChild(bankCol);
  body.appendChild(runBtn);
  body.appendChild(log);

  // 从 chrome.storage 同步开关状态（刷新后保持）
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      // 注意：用"仅含已有键"的读取方式（不传默认值），否则默认值会覆盖 loader 的设置。
      chrome.storage.local.get(["autoAnswer", "videoSpeed", "deepseekApiKey", "questionBankUrl", "questionBankKey"], (data) => {
        try {
          if (data && data.autoAnswer === false) unipusSweepEnabled = false;
          if (data && typeof data.deepseekApiKey === "string") {
            keyInput.value = data.deepseekApiKey;
            renderKeyStatus(data.deepseekApiKey);
          }
          if (data && typeof data.questionBankUrl === "string") {
            bankUrlInput.value = data.questionBankUrl;
            renderBankStatus(data.questionBankUrl);
          }
          if (data && typeof data.questionBankKey === "string") {
            bankKeyInput.value = data.questionBankKey;
          }
          if (data && Number(data.videoSpeed) > 0 && activeContext && activeContext.settings) {
            activeContext.settings.videoSpeed = Number(data.videoSpeed);
          }
          rateButtons.forEach((b) => {
            const v = parseFloat(b.textContent);
            b.classList.toggle("ch-pill-on", Math.abs(v - readUnipusVideoRate(activeContext)) < 0.01);
          });
          renderSweep();
          applyUnipusVideoPolicy(activeContext);
        } catch (_syncError) { /* 忽略 */ }
      });
    }
  } catch (_storageReadError) { /* 无 chrome 环境忽略 */ }

  panel.appendChild(head);
  panel.appendChild(body);
  doc.body.appendChild(panel);

  // 悬浮球
  const ball = doc.createElement("div");
  ball.id = "ch-ball";
  ball.textContent = "⚡";
  ball.title = "打开刷课助手面板";
  ball.addEventListener("click", () => {
    ball.style.display = "none";
    panel.classList.remove("ch-hidden");
  });
  doc.body.appendChild(ball);

  closeBtn.addEventListener("click", () => {
    panel.classList.add("ch-hidden");
    ball.style.display = "flex";
  });

  // 拖拽
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  head.addEventListener("mousedown", (e) => {
    dragging = true; sx = e.clientX - ox; sy = e.clientY - oy;
    e.preventDefault();
  });
  doc.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    ox = e.clientX - sx; oy = e.clientY - sy;
    panel.style.transform = "translate(" + ox + "px," + oy + "px)";
  });
  doc.addEventListener("mouseup", () => { dragging = false; });

  // 回放缓冲日志
  for (const entry of uiLogBuffer) {
    const line = doc.createElement("div");
    line.className = entry.isWarn ? "ch-log-line ch-log-warn" : "ch-log-line";
    line.textContent = "[" + entry.time + "] " + entry.message;
    log.appendChild(line);
  }
  log.scrollTop = log.scrollHeight;
}

// unipusLog/unipusWarn 的 UI 转发：在两个日志函数体内加钩子（保持原 console 输出）。

// ==== END SECTION: unipus-ui ====

// ==== SECTION: unipus-lifecycle ====

export function matches(url) {
  const hostname = getHostname(url).toLowerCase();
  return hostname === UNIPUS_DOMAIN || hostname.endsWith(`.${UNIPUS_DOMAIN}`);
}

export async function init(ctx) {
  if (activeContext) return; // 幂等：重复调用直接返回（参考 chaoxing 的 activeContext 模式）

  activeContext = ctx || {};
  activeGeneration += 1;
  const doc = getContextDocument(activeContext);

  // 题目拦截接线：幂等注入 MAIN bridge（XHR/fetch 钩子由 AGENT 07 实现）并注册
  // ucampus-question-data 消息监听（拦截题目数据缓存到模块内）。
  installQuestionInterceptor();

  // 语音题停止回执监听（ucampus-recording-state，幂等）：三级停止策略的验证通道。
  installVoiceRecordingStateListener();

  // 主控接线：立即尝试一次自动答题（题目数据可能已拦截）；未成功时由
  // 题目数据事件（handleQuestionDataPayload → triggerAutoAnswerOnce）驱动重试。
  void triggerAutoAnswerOnce();

  // 页内控制面板（可见 UI：挂机开关 / 立即执行 / 实时日志）。
  // 注意：content script 与页面共享同一 DOM，因此在 isolated world 创建的元素
  // 用户是【可见】的（只是 JS 上下文隔离）。
  try {
    buildUnipusUi();
  } catch (uiError) {
    // 面板构建失败必须可见（此前静默 try/catch 导致"面板不出现"极难排查）。
    unipusWarn(activeContext, "u校园面板构建失败：" + (uiError && uiError.message ? uiError.message : String(uiError)));
  }

  // 视频自动播放 + 倍速（用户需求：视频页不再需要手动点播放/调速）。
  startUnipusVideoPolicy(activeContext);

  // 空闲看门狗：页面无任何交互内容时自动经目录推进到下一节（补整课循环）。
  startUnipusIdleWatcher(activeContext);

  // 保活（loader 已全局启动三平台统一保活；此处为 unipus 侧幂等接线）
  keepAliveStop = startKeepAlive(doc);

  // TODO(录音功能): spec/40 明确 v1 不做录音；后续版本如需录制音频，
  // 需在 MAIN world 获取 getUserMedia 权限并在此接线（待主控规划）。
}

export function destroy() {
  if (!activeContext) return; // 幂等
  const context = activeContext;
  activeGeneration += 1;

  // 停止页面填答观察者（输入框监听）
  stopPageFillObserver();

  // 停止自动提交调度（未触发的定时器清理）
  resetAutoSubmitState();

  // 停止自动翻页轮询（"继续学习"等待清理）
  resetAutoContinueState();

  // 停止空闲看门狗（目录推进）
  stopUnipusIdleWatcher();

  // 停止视频巡检
  stopUnipusVideoPolicy();

  // 移除 window "message" 监听
  removeQuestionMessageListener();

  // 移除语音题录音状态回执监听（ucampus-recording-state）
  removeVoiceRecordingStateListener();

  // 恢复 MAIN world 的 confirm 覆写（installSubmitInterceptor 启用过才发）
  disableSubmitInterceptor(context);

  // 清理保活（调用 startKeepAlive 返回的 stop 函数）
  if (typeof keepAliveStop === "function") {
    try {
      keepAliveStop();
    } catch (_error) {
      // 保活已失效时忽略停止错误。
    }
  }
  keepAliveStop = null;

  // 清空拦截缓存（防跨页面污染）
  interceptedQuestions.length = 0;
  interceptedContentSeen = null;
  loggedEncryptedContent = null;
  loggedUnknownReplyTypes = null;

  // 重置自动答题触发状态（下次 init 可重新触发）
  resetAutoAnswerState();

  activeContext = null;
}

// ==== END SECTION: unipus-lifecycle ====
