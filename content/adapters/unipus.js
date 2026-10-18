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
  if (context.settings && context.settings.autoAnswer === false) {
    unipusLog(context, "u校园自动答题已关闭（settings.autoAnswer=false），跳过。");
    return { started: false, reason: "auto-answer-disabled" };
  }
  const storageAutoAnswer = await readStorageAutoAnswer();
  if (storageAutoAnswer === false) {
    unipusLog(context, "u校园自动答题已关闭（chrome.storage.local.autoAnswer=false），跳过。");
    return { started: false, reason: "auto-answer-disabled" };
  }

  const questions = await getQuestions();
  if (!questions.length) {
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
  const solvableIndexes = [];
  const solvableQuestions = [];
  questions.forEach((question, index) => {
    if (question && question.__isVoice === true) return;
    solvableIndexes.push(index);
    solvableQuestions.push(question);
  });
  const hasVoiceQuestions = solvableQuestions.length < questions.length;

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
      }
    } else {
      answers.push(stripQuestionNumber(answer));
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
  let pageFilled = fillAnswersToPage(getContextDocument(context), answers);
  if (hasTextQuestions) {
    for (let retry = 0; retry < 2 && pageFilled === 0; retry += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      pageFilled = fillAnswersToPage(getContextDocument(context), answers);
    }
    if (pageFilled === 0) {
      installPageFillObserver(context, answers);
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
  // 语音题：提交前模拟录音（点击录音按钮开始 → 停止），通过前端"已录音"校验；
  // 首次使用需用户手动授权一次麦克风权限（浏览器权限框无法程序化点击）。
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
      let EventConstructor = null;
      try {
        const view = element.ownerDocument && element.ownerDocument.defaultView;
        EventConstructor = (view && typeof view.Event === "function" && view.Event) ||
          (typeof Event === "function" ? Event : null);
      } catch (_error) {
        EventConstructor = typeof Event === "function" ? Event : null;
      }
      if (EventConstructor) {
        event = new EventConstructor("input", { bubbles: true });
      } else {
        event = { type: "input", bubbles: true };
      }
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
      if (fillAnswersToPage(doc, answers) > 0) {
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
// 等待录制窗口 → 再点同一按钮停止，让平台获得一段录音（内容为环境音/静音），
// 通过"已录音"校验后照常提交翻页（评分可能低，但流程不再卡住）。
// 麦克风权限：首次点击录音时浏览器弹权限框，需用户手动允许一次（之后站点持久）。
// 按钮结构（用户实测 selector）：.record-button-group > div:nth-child(2)（麦克风）。

const VOICE_RECORD_DURATION_MS = 2500; // 录音窗口时长
const VOICE_RECORD_GROUP_SELECTOR = ".record-button-group";

function collectRecordButtons(doc) {
  const buttons = [];
  if (!doc) return buttons;
  for (const group of safeQueryAll(doc, VOICE_RECORD_GROUP_SELECTOR)) {
    let children = [];
    try {
      children = Array.from(group.children || []);
    } catch (_error) {
      children = [];
    }
    // 用户实测：第 2 个子元素是麦克风按钮；回退取第 1 个或组本身。
    const target = children.length >= 2 ? children[1] : (children[0] || group);
    if (target) buttons.push(target);
  }
  return buttons;
}

async function simulateVoiceRecordings(context) {
  const doc = getContextDocument(context);
  const buttons = collectRecordButtons(doc);
  if (!buttons.length) {
    unipusWarn(context,
      "u校园语音题：未找到录音按钮（.record-button-group），无法模拟录音，提交可能被前端校验拦截。");
    return false;
  }
  unipusLog(context,
    `u校园语音题：模拟录音 ${buttons.length} 处（点击开始 → ${VOICE_RECORD_DURATION_MS}ms → 停止）。` +
    "首次使用如弹出麦克风权限框，请点击\"允许\"（可勾选始终允许）。");
  for (const button of buttons) {
    clickElementSafely(context, button);
  }
  await new Promise((resolve) => setTimeout(resolve, VOICE_RECORD_DURATION_MS));
  for (const button of buttons) {
    clickElementSafely(context, button);
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
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
    const text = asString(element.textContent).trim();
    const pseudo = isFoot ? getElementPseudoText(element) : "";
    if (/提交/.test(text) || /提交/.test(pseudo)) stats.withText += 1;
    if (stats.texts.length < 5 && /提交/.test(text)) stats.texts.push(text.slice(0, 24));
    if (stats.pseudo.length < 5 && pseudo) stats.pseudo.push(pseudo.slice(0, 24));
    if (!isElementVisible(element)) return null;
    if (isFoot) stats.footVisible += 1;
    if (element.disabled === true || element.getAttribute("aria-disabled") === "true") return null;
    // 文本或伪元素文本含"提交"（排除"提交反馈/评论/意见/问题"等干扰词）即命中。
    if (/提交/.test(text) && !/提交(?:反馈|评论|意见|问题)/.test(text)) return element;
    if (/提交/.test(pseudo)) return element;
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
function clickElementSafely(context, element) {
  if (!element) return false;
  try {
    element.click();
    return true;
  } catch (_error) {
    try {
      const doc = getContextDocument(context);
      const view = (doc && doc.defaultView) || getGlobalRoot();
      const EventConstructor = view && view.Event ? view.Event : (typeof Event !== "undefined" ? Event : null);
      if (EventConstructor && typeof element.dispatchEvent === "function") {
        element.dispatchEvent(new EventConstructor("click", { bubbles: true }));
        return true;
      }
    } catch (_dispatchError) {
      // 点击派发失败不抛出。
    }
  }
  return false;
}

function clickSubmitButton(context) {
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
  if (clickElementSafely(context, found.element)) {
    unipusLog(context, "u校园自动提交：已点击提交按钮，等待平台提交并切下一页。");
    // 提交观测：8 秒内未观察到提交请求则警告（前端校验拦截/按钮不可用）。
    resetSubmitObservation();
    submitObserveTimer = setTimeout(() => {
      submitObserveTimer = null;
      if (!submitObserved) {
        unipusWarn(context,
          "u校园自动提交：点击后 8 秒未观察到提交请求（平台前端校验拦截或提交按钮不可用？请检查页面状态与弹窗）。");
      }
    }, 8000);
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
const autoContinueState = { timer: null, deadline: 0, clicked: false };

function resetAutoContinueState() {
  if (autoContinueState.timer) {
    clearTimeout(autoContinueState.timer);
    autoContinueState.timer = null;
  }
  autoContinueState.deadline = 0;
  autoContinueState.clicked = false;
}

// 在页脚候选（用户实测 selector）中按文本/伪元素文本查找链接。
function findFootLinkByText(doc, pattern) {
  if (!doc || typeof doc.querySelectorAll !== "function") return null;
  const seen = new Set();
  for (const selector of ["#pc-foot > div > a", "#pc-foot a"]) {
    for (const link of safeQueryAll(doc, selector)) {
      if (seen.has(link)) continue;
      seen.add(link);
      const text = asString(link.textContent).trim();
      const pseudo = getElementPseudoText(link);
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
  autoContinueState.deadline = Date.now() + AUTO_CONTINUE_TIMEOUT_MS;
  autoContinueState.timer = setTimeout(() => pollAutoContinue(context), AUTO_CONTINUE_FIRST_DELAY_MS);
}

function pollAutoContinue(context) {
  autoContinueState.timer = null;
  const doc = getContextDocument(context);
  const link = doc ? findFootLinkByText(doc, /继续学习/) : null;
  if (link) {
    autoContinueState.clicked = true;
    if (clickElementSafely(context, link)) {
      unipusLog(context, "u校园自动翻页：已点击“继续学习”按钮，等待下一页题目到达。");
    } else {
      unipusWarn(context, "u校园自动翻页：“继续学习”按钮点击失败。");
    }
    return;
  }
  if (Date.now() >= autoContinueState.deadline) {
    unipusWarn(context, "u校园自动翻页：60 秒内未出现“继续学习”按钮，已停止等待（可手动点击继续）。");
    return;
  }
  autoContinueState.timer = setTimeout(() => pollAutoContinue(context), AUTO_CONTINUE_POLL_MS);
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

  // 主控接线：立即尝试一次自动答题（题目数据可能已拦截）；未成功时由
  // 题目数据事件（handleQuestionDataPayload → triggerAutoAnswerOnce）驱动重试。
  void triggerAutoAnswerOnce();

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

  // 移除 window "message" 监听
  removeQuestionMessageListener();

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
