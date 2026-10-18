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
  // 主控接线：拦截到题目数据后触发一次自动答题（幂等/节流/成功锁定）。
  void triggerAutoAnswerOnce();
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
  return { qtype, stem, options };
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
    return {
      qtype,
      stem: stemHtml,
      options,
      isAnswered: () => domChoiceAnswered(choiceInputs),
    };
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
    let plainParsed = 0;
    let plainSkipped = 0;
    for (const item of interceptedQuestions) {
      if (item.content.indexOf(ENCRYPTED_CONTENT_PREFIX) === 0) {
        // 密文：解密算法缺失（spec/40 降级顺序第 1/2 条），
        // console.log 密文与密钥供人工分析，不伪造解密结果，该题跳过并计入警告。
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
          `u校园拦截题目：${encryptedSkipped} 道密文（解密算法待补）与 ${plainSkipped} 条明文解析失败已跳过，返回可解析的 ${questions.length} 道。`);
      }
      return questions;
    }
    if (encryptedSkipped > 0) {
      unipusWarn(activeContext,
        `u校园拦截到 ${encryptedSkipped} 道加密题目但解密算法缺失（参考脚本后半部分丢失），已跳过并降级为 DOM 提取。`);
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
  if (!chromeApi || !chromeApi.scripting ||
      typeof chromeApi.scripting.executeScript !== "function") {
    if (!bridgeInjectWarned) {
      bridgeInjectWarned = true;
      unipusWarn(activeContext,
        "chrome.scripting.executeScript unavailable，跳过 MAIN bridge 注入（loader 可能已注入）。");
    }
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

// ---- 主控接线：自动答题触发（init 立即触发 + 题目数据事件驱动重试）----
// 成功（started:true）后锁定不再触发；事件连发时 2 秒节流；destroy 时重置。
const AUTO_ANSWER_RETRY_THROTTLE_MS = 2000;
const autoAnswerState = { started: false, running: null, lastAttemptAt: 0 };

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
    }
  })();
  return autoAnswerState.running;
}

function resetAutoAnswerState() {
  autoAnswerState.started = false;
  autoAnswerState.running = null;
  autoAnswerState.lastAttemptAt = 0;
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

  const solver = resolveQuizSolver(context);
  if (!solver || typeof solver.solveQuestions !== "function") {
    unipusWarn(context, "quiz-solver 不可用（三级解析均未命中），跳过答案注入接线。");
    return { started: false, reason: "solver-unavailable" };
  }

  let summary = null;
  try {
    summary = await solver.solveQuestions(questions, context, { autoSubmit: false });
  } catch (_error) {
    unipusWarn(context, "solveQuestions 调用失败，跳过答案注入接线。");
    return { started: false, reason: "solve-failed" };
  }

  // 答案队列顺序 = 题目顺序（spec/40：位置填充，不需要题号映射）。
  // 队列元素数必须与题目数一致：任何一题缺少答案都会导致后续题目错位，
  // 因此只要有一题未获得答案就不下发队列（bridge 原样放行提交，安全降级）。
  const results = asObject(summary) && Array.isArray(summary.results) ? summary.results : [];
  const answers = [];
  let missing = 0;
  for (let index = 0; index < questions.length; index += 1) {
    const result = index < results.length ? results[index] : null;
    const answer = result && typeof result.answer === "string" ? result.answer.trim() : "";
    if (!answer) {
      missing += 1;
      answers.push("");
      continue;
    }
    answers.push(answer); // 多选答案按 CONTRACTS 规范（连续大写字母）原样入队
  }
  if (missing > 0) {
    unipusWarn(context,
      `u校园有 ${missing} 道题未获得答案，跳过答案队列下发（避免位置错位导致答案注入到错误题目）。`);
    return { started: false, reason: "missing-answers", missing };
  }

  setAnswerQueue(answers);
  installSubmitInterceptor();
  unipusLog(context, `u校园答案注入已就绪：${answers.length} 道题，等待用户提交时自动注入。`);
  return { started: true, answerCount: answers.length };
}

// ==== END SECTION: unipus-auto-answer ====

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

  // 重置自动答题触发状态（下次 init 可重新触发）
  resetAutoAnswerState();

  activeContext = null;
}

// ==== END SECTION: unipus-lifecycle ====
