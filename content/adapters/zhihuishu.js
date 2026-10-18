/*
 * [SECTION:ADAPTER_ZHIHUISU]
 * 职责：智慧树（知到，*.zhihuishu.com）平台适配器（spec/50-zhihuishu）。
 *   matches：按 hostname 判定智慧树域名（zhihuishu.com 或以 .zhihuishu.com 结尾）；
 *   init/destroy：幂等初始化与清理（视频自动播放、保活、storage 变化监听）；
 *   handleVideo：自动 play + playbackRate（settings.videoSpeed，1–8 钳制，默认 3），
 *     静音用 volume=0 而非 muted（spec/50：降低检测概率，不设置 video.muted=true）；
 *     监听 blur/visibilitychange 与 pause 事件自动恢复播放（ended 除外）；
 *     ended 后探测并点击"下一集/下一个"按钮（多候选探测 + console.log 调试输出，
 *     点击失败不抛异常）；
 *   extractQuestions：按常见结构通用探测题目（容器/题干/选项选择器均需在真实页面核对），
 *     题型从题干【单选】等前缀提取映射 qtype 0–4（与 quiz-solver 一致），
 *     结构与 quiz-solver 的 question 输入格式对齐（含 isAnswered 函数），
 *     探测不到任何题目时返回 []；
 *   fillAnswers：优先 quiz-solver 三级解析（contextWindow.CourseHelperQuizSolver →
 *     globalThis → require("../quiz-solver.js")）自动答题；solver 不可用且有 answers
 *     数组时按 spec/50 原生方式填答（radio/checkbox click + input 原生 value setter +
 *     dispatch input 事件）；两者都不可用则警告返回；
 *   handleKeepAlive：复用 keep-alive.js 全局 API
 *     （globalThis.__COURSE_HELPER_KEEP_ALIVE__，其关键词检测覆盖智慧树"继续学习"挂机弹窗）；
 *     全局 API 不可用时降级为简易 visibility/focus 监听并 console 警告"keep-alive 不可用"。
 * 本文件为 ESM 模块，零依赖；不依赖 video-manager/keep-alive/quiz-solver 的加载顺序，
 * 仅通过 globalThis 复用后两者；无 chrome 环境可安全加载（typeof chrome 防御）。
 */

// ==== SECTION: zhihuishu-selectors ====

const ZHIHUISHU_DOMAIN = "zhihuishu.com";

// ---- 视频：下一集/下一个按钮候选选择器（全部为通用探测候选，需在真实页面核对）----
const NEXT_VIDEO_SELECTOR_CANDIDATES = Object.freeze([
  ".next-btn",
  ".nextBtn",
  "#nextBtn",
  "#nextButton",
  ".btn-next",
  ".btnNext",
  ".next-button",
  ".nextLesson",
  ".next-lesson",
  ".switch-next",
  ".next-switch",
  ".video-next",
  ".videoNext",
  "button[class*='next']",
  "a[class*='next']",
  "[class*='next-btn']",
  "[class*='nextBtn']",
]);
// 文本探测："下一集/下一节/下一个…"（需在真实页面核对）
const NEXT_VIDEO_TEXT_RE = /下一(?:集|节|个|课|讲|章|部分|单元)/;
// 文本探测兜底（div/span/li）的最大文本长度，避免误点长文本节点（需在真实页面核对）
const NEXT_VIDEO_FALLBACK_TEXT_MAX_LENGTH = 12;

// ---- 题目容器候选（全部为通用探测候选，依次探测第一个命中的，需在真实页面核对）----
const QUESTION_CONTAINER_SELECTORS = Object.freeze([
  ".questionBox",
  ".question-box",
  ".questionLi",
  ".question-li",
  ".topic-item",
  ".topicItem",
  ".question-item",
  ".questionItem",
  ".exam-question",
  ".examQuestion",
  ".subject-item",
  ".subjectItem",
  ".tm-item",
  ".tiMu",
  ".topic",
]);

// ---- 题干候选（题容器内依次探测，需在真实页面核对）----
const STEM_SELECTOR_CANDIDATES = Object.freeze([
  ".stem",
  ".question-stem",
  ".topic-title",
  ".topicTitle",
  ".question-title",
  ".questionTitle",
  ".title",
  ".mark_name",
  "h3",
  "h4",
]);

// ---- 选项列表兜底候选（题容器内无 radio/checkbox 时按可点击选项节点处理，需在真实页面核对）----
const OPTION_LIST_SELECTOR_CANDIDATES = Object.freeze([
  ".option-list li",
  ".options li",
  ".optionList li",
  ".answer-list li",
  ".answerList li",
  "li[data-option]",
  ".option",
  ".answer-item",
]);

// ---- 提交按钮候选（全部为通用探测候选，需在真实页面核对）----
const SUBMIT_BUTTON_SELECTOR_CANDIDATES = Object.freeze([
  ".submit-btn",
  ".submitBtn",
  "#submitBtn",
  ".btn-submit",
  ".btnSubmit",
  'button[type="submit"]',
  'input[type="submit"]',
  ".exam-submit",
  ".paper-submit",
  ".tj-btn",
]);
const SUBMIT_BUTTON_TEXT_RE = /(?:提交|交卷|交作业|确认提交)/;
const SUBMIT_BUTTON_TEXT_MAX_LENGTH = 12;

// ---- 题型：题干前缀提取与映射（与 quiz-solver 的 qtype 0–4 一致）----
const ZHS_QUIZ_TYPE_RE =
  /(?:【|\[|（|\()\s*(单项选择题?|多项选择题?|单选题?|多选题?|填空题?|判断题?|简答题?|问答题?)\s*(?:】|\]|）|\))/;
const ZHS_QUIZ_TYPE_MAP = Object.freeze({
  单选: 0, 单选题: 0, 单项选择: 0, 单项选择题: 0,
  多选: 1, 多选题: 1, 多项选择: 1, 多项选择题: 1,
  填空: 2, 填空题: 2,
  判断: 3, 判断题: 3,
  简答: 4, 简答题: 4, 问答: 4, 问答题: 4,
});
// 判断题选项文本（题干未标【判断】但选项仅两枚对/错时映射 qtype 3，需在真实页面核对）
const TRUE_FALSE_OPTION_TEXT_RE = /^(?:对|错|正确|错误|是|否|√|×|true|false)$/i;

// ---- 视频播放 ----
const VIDEO_DEFAULT_RATE = 3;
const VIDEO_MIN_RATE = 1;
const VIDEO_MAX_RATE = 8;

// ---- keep-alive 全局挂载名（与 content/keep-alive.js 的 MARKER 一致）----
const KEEP_ALIVE_GLOBAL_KEY = "__COURSE_HELPER_KEEP_ALIVE__";

// ==== END SECTION: zhihuishu-selectors ====

// ==== SECTION: zhihuishu-utils ====

// ---- 模块状态（destroy 全量清理；init/destroy 均幂等）----
let activeContext = null;
let activeGeneration = 0;
let autoVideoEnabled = true;
let videoStates = []; // 活跃的 handleVideo 状态（含清理函数与 resolve）
let keepAliveApi = null; // keep-alive 全局 API 引用
let storageListener = null; // chrome.storage.onChanged 监听函数
let degradeKeepAliveCleanups = []; // 降级保活监听清理

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

function zhsLog(context, message) {
  if (context && typeof context.log === "function") {
    try {
      context.log(message);
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

function zhsWarn(context, message) {
  if (context && typeof context.log === "function") {
    try {
      context.log(message);
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

// spec/50 要求保留 console.log 调试输出：ended 后下一集按钮探测的候选命中情况。
function zhsConsoleLog(context, message) {
  const view = getContextWindow(context);
  if (view && view.console && typeof view.console.log === "function") {
    try {
      view.console.log(`[course-helper] ${message}`);
      return;
    } catch (_error) {
      // 控制台被页面替换时忽略。
    }
  }
  if (typeof console !== "undefined" && typeof console.log === "function") {
    try { console.log(`[course-helper] ${message}`); } catch (_error) { /* 忽略。 */ }
  }
}

function clampVideoRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return VIDEO_DEFAULT_RATE;
  return Math.min(VIDEO_MAX_RATE, Math.max(VIDEO_MIN_RATE, rate));
}

function readVideoRate(context) {
  const settings = asObject(context && context.settings) || {};
  return clampVideoRate(settings.videoSpeed);
}

function readAutoVideo(context) {
  const settings = asObject(context && context.settings) || {};
  return settings.autoVideo !== false; // 默认 true
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
      return new URL(urlOrLocation, "https://zhihuishu.invalid").hostname;
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

function readZhihuishuStoredSettings(keys) {
  if (typeof chrome === "undefined" || !chrome || !chrome.storage || !chrome.storage.local ||
      typeof chrome.storage.local.get !== "function") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (stored) => {
        resolve(stored && typeof stored === "object" ? stored : null);
      });
    } catch (_error) {
      resolve(null);
    }
  });
}

// ==== END SECTION: zhihuishu-utils ====

// ==== SECTION: zhihuishu-route ====

export function matches(url) {
  const hostname = getHostname(url).toLowerCase();
  return hostname === ZHIHUISHU_DOMAIN || hostname.endsWith(`.${ZHIHUISHU_DOMAIN}`);
}

export async function init(ctx) {
  if (activeContext) return; // 幂等：重复调用直接返回（参考 chaoxing 的 activeContext 模式）

  activeContext = ctx || {};
  activeGeneration += 1;
  autoVideoEnabled = readAutoVideo(activeContext);
  const doc = getContextDocument(activeContext);

  // 保活（智慧树"继续学习"等挂机弹窗由 keep-alive 的关键词检测覆盖）
  handleKeepAlive(doc);

  // storage 变化监听：videoSpeed/autoVideo 变化即时应用；无 chrome 环境安全忽略
  installStorageListener();

  // 查找 video 元素（含同域 iframe）并对每个调 handleVideo；
  // 不 await：handleVideo 直到 ended 后下一集点击完成才返回，生命周期与页面播放同步。
  for (const media of collectZhihuishuVideos(doc)) {
    handleVideo(media, activeContext).catch(() => {});
  }
}

export function destroy() {
  // 按代清理：使所有挂起的 handleVideo 回调失效
  activeGeneration += 1;

  const states = videoStates.splice(0, videoStates.length);
  for (const state of states) {
    teardownVideoState(state);
    state.completed = true;
    if (state.resolveDone) state.resolveDone();
  }

  removeStorageListener();
  stopKeepAlive();
  runCleanups(degradeKeepAliveCleanups);
  degradeKeepAliveCleanups.length = 0;

  activeContext = null;
}

// ---- chrome.storage.onChanged 监听（videoSpeed/autoVideo 变化并应用；无 chrome 环境忽略）----
function installStorageListener() {
  removeStorageListener();
  if (typeof chrome === "undefined" || !chrome || !chrome.storage ||
      !chrome.storage.onChanged || typeof chrome.storage.onChanged.addListener !== "function") {
    return; // 无 chrome 环境（Node/测试）安全忽略
  }
  storageListener = (changes, areaName) => {
    if (areaName && areaName !== "local") return;
    if (!changes) return;
    try {
      if (changes.videoSpeed && changes.videoSpeed.newValue !== undefined) {
        applyVideoSpeedToActiveStates(clampVideoRate(changes.videoSpeed.newValue));
      }
      if (changes.autoVideo && changes.autoVideo.newValue !== undefined) {
        autoVideoEnabled = changes.autoVideo.newValue !== false;
        if (autoVideoEnabled) resumeAllActiveVideos();
      }
    } catch (_error) {
      // 变化处理失败不能抛出到 chrome 事件系统。
    }
  };
  try {
    chrome.storage.onChanged.addListener(storageListener);
  } catch (_error) {
    storageListener = null;
  }
}

function removeStorageListener() {
  if (!storageListener) return;
  if (typeof chrome !== "undefined" && chrome && chrome.storage && chrome.storage.onChanged &&
      typeof chrome.storage.onChanged.removeListener === "function") {
    try { chrome.storage.onChanged.removeListener(storageListener); } catch (_error) { /* 忽略。 */ }
  }
  storageListener = null;
}

function applyVideoSpeedToActiveStates(rate) {
  for (const state of videoStates) {
    try { state.media.playbackRate = rate; } catch (_error) { /* 只读媒体对象安全跳过。 */ }
  }
}

// ==== END SECTION: zhihuishu-route ====

// ==== SECTION: zhihuishu-video ====
// ---- 智慧树视频自动播放（spec/50）----
// 本分区自包含实现，不依赖 content/video-manager.js：
//   video-manager 的静音路径默认 muted=true（_applyMuted），与 spec/50"volume=0 而非 muted"的
//   检测规避要求冲突（虽可通过 options 覆盖，但多一层间接风险）；且其时钟/上报模型为学习通
//   场景设计，智慧树无播放时长上报需求，复用只会带来冗余复杂度。
// 健壮性与 chaoxing 的 video-play 分区对齐：play() 拒绝安全、ended 幂等、按代清理。

export async function handleVideo(video, ctx) {
  const context = ctx || activeContext;
  let playable = false;
  try {
    playable = Boolean(video) && typeof video.play === "function";
  } catch (_error) {
    playable = false;
  }
  if (!playable) {
    zhsWarn(context, "智慧树 handleVideo：传入元素不是可播放的 video，安全跳过。");
    return;
  }

  // 同一 video 元素幂等：返回同一 promise
  for (const existing of videoStates) {
    if (existing.media === video) return existing.donePromise;
  }

  const state = {
    media: video,
    context,
    completed: false,
    endedNotified: false,
    suppressPause: false,
    resumeTimer: null,
    generation: activeGeneration,
    cleanups: [],
    donePromise: null,
    resolveDone: null,
  };
  state.donePromise = new Promise((resolve) => {
    state.resolveDone = resolve;
  });
  videoStates.push(state);

  // pause 事件自动恢复（ended 除外）
  attachListener(video, "pause", () => handleVideoPause(state), state.cleanups);
  attachListener(video, "ended", () => handleVideoEnded(state), state.cleanups);

  // spec/50：失焦暂停 —— 监听 blur/visibilitychange 后重新 play
  const view = getContextWindow(context);
  const doc = getContextDocument(context);
  attachListener(view, "blur", () => resumeIfNeeded(state), state.cleanups);
  attachListener(doc, "visibilitychange", () => {
    const hidden = doc && (doc.hidden === true || doc.visibilityState === "hidden");
    if (!hidden) resumeIfNeeded(state);
  }, state.cleanups);

  prepareAndPlayVideo(state);
  return state.donePromise;
}

function mediaEnded(media) {
  try {
    return media.ended === true;
  } catch (_error) {
    return false;
  }
}

function playSafely(media) {
  try {
    if (!media || typeof media.play !== "function") return;
    const playResult = media.play();
    if (playResult && typeof playResult.catch === "function") {
      playResult.catch(() => {});
    } else if (playResult && typeof playResult.then === "function") {
      playResult.then(() => {}, () => {});
    }
  } catch (_error) {
    // play() 同步抛错或返回拒绝的 Promise 均安全忽略，pause 恢复链路会再次尝试。
  }
}

function prepareAndPlayVideo(state) {
  if (state.completed || state.generation !== activeGeneration) return;
  if (mediaEnded(state.media)) {
    handleVideoEnded(state); // 防御：ended 事件未触发（如元素替换）时补一次处理
    return;
  }
  const rate = readVideoRate(state.context);
  state.suppressPause = true;
  try {
    if (typeof state.media.pause === "function") state.media.pause();
  } catch (_error) {
    // pause() 可能被页面脚本或只读对象拒绝。
  }
  state.suppressPause = false;
  try { state.media.playbackRate = rate; } catch (_error) { /* 只读媒体对象安全跳过。 */ }
  // spec/50：静音用 volume=0 而非 muted（降低检测概率）；不要设置 video.muted = true
  try { state.media.volume = 0; } catch (_error) { /* 只读媒体对象安全跳过。 */ }
  if (autoVideoEnabled) playSafely(state.media);
}

function handleVideoPause(state) {
  if (state.completed || state.suppressPause || state.generation !== activeGeneration) return;
  if (!autoVideoEnabled) return;
  if (mediaEnded(state.media)) return; // ended 由 ended 事件处理，不自动恢复
  scheduleVideoResume(state);
}

function scheduleVideoResume(state) {
  if (state.resumeTimer !== null) return;
  state.resumeTimer = setTimeout(() => {
    state.resumeTimer = null;
    if (state.completed || state.generation !== activeGeneration) return;
    if (!autoVideoEnabled) return;
    if (mediaEnded(state.media)) return;
    let paused = true;
    try {
      paused = state.media.paused === true;
    } catch (_error) {
      paused = true;
    }
    if (!paused) return; // 仍在播放则无需恢复，避免无谓的 pause→play 循环
    prepareAndPlayVideo(state);
  }, 0);
}

function resumeIfNeeded(state) {
  if (!autoVideoEnabled) return;
  scheduleVideoResume(state);
}

function handleVideoEnded(state) {
  if (state.completed || state.generation !== activeGeneration) return;
  if (state.endedNotified) return; // ended 幂等
  state.endedNotified = true;
  const doc = getContextDocument(state.context);
  const clicked = tryClickNextVideo(doc, state.context);
  if (!clicked) {
    zhsLog(state.context,
      "智慧树视频 ended：未探测到下一集按钮（候选选择器与文本探测均未命中，选择器需在真实页面核对）。");
  }
  finishVideoState(state);
}

function finishVideoState(state) {
  if (state.completed) return;
  state.completed = true;
  teardownVideoState(state);
  const index = videoStates.indexOf(state);
  if (index !== -1) videoStates.splice(index, 1);
  if (state.resolveDone) state.resolveDone();
}

function teardownVideoState(state) {
  if (state.resumeTimer !== null) {
    clearTimeout(state.resumeTimer);
    state.resumeTimer = null;
  }
  runCleanups(state.cleanups);
  state.cleanups.length = 0;
}

// ---- ended 后点击"下一集/下一个"按钮：多候选探测 + console.log 调试输出（spec/50）----
function tryClickNextVideo(doc, context) {
  if (!doc) return false;

  // 第一级：候选选择器依次探测（选择器需在真实页面核对）
  for (const selector of NEXT_VIDEO_SELECTOR_CANDIDATES) {
    for (const element of safeQueryAll(doc, selector)) {
      if (!isVisibleClickable(element)) continue;
      zhsConsoleLog(context,
        `智慧树下一集按钮候选选择器命中：${selector}（选择器需在真实页面核对）`);
      try { element.click(); } catch (_error) { /* 点击失败不抛异常（spec/50）。 */ }
      return true;
    }
  }

  // 第二级：button/a/[role=button] 文本探测（"下一集/下一节/下一个…"）
  for (const element of safeQueryAll(doc, 'button, a, [role="button"]')) {
    const text = asString(element.textContent).replace(/\s+/g, "");
    if (!text || text.length > NEXT_VIDEO_FALLBACK_TEXT_MAX_LENGTH + 4) continue;
    if (!NEXT_VIDEO_TEXT_RE.test(text)) continue;
    if (!isVisibleClickable(element)) continue;
    zhsConsoleLog(context,
      `智慧树下一集按钮文本探测命中："${text}"（选择器需在真实页面核对）`);
    try { element.click(); } catch (_error) { /* 点击失败不抛异常（spec/50）。 */ }
    return true;
  }

  // 第三级：div/span/li 兜底文本探测（仅短文本，误点风险高，最后尝试）
  for (const element of safeQueryAll(doc, "div, span, li")) {
    const text = asString(element.textContent).replace(/\s+/g, "");
    if (!text || text.length > NEXT_VIDEO_FALLBACK_TEXT_MAX_LENGTH) continue;
    if (!NEXT_VIDEO_TEXT_RE.test(text)) continue;
    if (!isVisibleClickable(element)) continue;
    zhsConsoleLog(context,
      `智慧树下一集按钮兜底文本探测命中："${text}"（需在真实页面核对）`);
    try { element.click(); } catch (_error) { /* 点击失败不抛异常（spec/50）。 */ }
    return true;
  }

  zhsConsoleLog(context,
    "智慧树下一集按钮未命中：候选选择器与文本探测均失败（选择器需在真实页面核对）。");
  return false;
}

function isVisibleClickable(element) {
  if (!element || typeof element.click !== "function") return false;
  try {
    // 不可见（display:none 等）的候选不点击（需在真实页面核对的行为约定）
    if (typeof element.getClientRects === "function") {
      const rects = element.getClientRects();
      if (rects && typeof rects.length === "number" && rects.length === 0) return false;
    }
  } catch (_error) {
    // 可见性判定失败时仍允许点击（防御）。
  }
  return true;
}

// ---- 收集 video 元素（主文档 + 同域 iframe，跨域安全跳过）----
function collectVideoDocuments(roots, documents, seen) {
  for (const root of roots) {
    if (!root) continue;
    let documentLike = root;
    try {
      if (root.contentDocument) documentLike = root.contentDocument;
      else if (root.contentWindow && root.contentWindow.document) {
        documentLike = root.contentWindow.document;
      }
    } catch (_error) {
      continue; // 跨域 iframe：contentDocument 读取失败，安全跳过
    }
    if (!documentLike || seen.indexOf(documentLike) !== -1) continue;
    let canQuery = false;
    try {
      canQuery = typeof documentLike.querySelectorAll === "function";
    } catch (_error) {
      canQuery = false;
    }
    if (!canQuery) continue;
    seen.push(documentLike);
    documents.push(documentLike);
    let frames;
    try {
      frames = documentLike.querySelectorAll("iframe, frame");
    } catch (_error) {
      frames = [];
    }
    const frameList = frames && typeof frames.length === "number" ? Array.from(frames) : [];
    collectVideoDocuments(frameList, documents, seen);
  }
}

function collectZhihuishuVideos(doc) {
  const documents = [];
  const seen = [];
  collectVideoDocuments([doc], documents, seen);
  const videos = [];
  for (const documentLike of documents) {
    for (const media of safeQueryAll(documentLike, "video")) {
      if (videos.indexOf(media) === -1) videos.push(media);
    }
  }
  return videos;
}

// ==== END SECTION: zhihuishu-video ====

// ==== SECTION: zhihuishu-quiz ====
// ---- 智慧树题目提取与填答（spec/50，通用探测实现）----
// 容器/题干/选项/提交按钮选择器均为通用探测候选，需在真实页面核对；
// 填答优先复用 quiz-solver 的 solveQuestions（缓存命中 → DeepSeek，失败跳过本题不阻塞队列）；
// solver 不可用且有 answers 数组时按 spec/50 原生方式填答。

export function extractQuestions(doc) {
  const target = doc || getContextDocument(activeContext);
  if (!target || typeof target.querySelectorAll !== "function") return [];

  // 容器候选依次探测，第一个命中的候选作为容器来源（探测顺序需在真实页面核对）
  let containers = [];
  for (const selector of QUESTION_CONTAINER_SELECTORS) {
    containers = safeQueryAll(target, selector);
    if (containers.length) break;
  }

  const questions = [];
  for (const container of uniqueNodes(containers)) {
    const question = buildZhihuishuQuestion(container);
    if (question) questions.push(question);
  }
  return questions; // 探测不到任何题目时返回 []
}

function extractZhihuishuQuestionType(stemHtml) {
  const match = ZHS_QUIZ_TYPE_RE.exec(asString(stemHtml));
  if (!match) return null;
  const mapped = ZHS_QUIZ_TYPE_MAP[match[1]];
  return mapped === undefined ? null : mapped;
}

function buildZhihuishuQuestion(container) {
  if (!container || typeof container.querySelectorAll !== "function") return null;

  // 题干：容器内候选选择器依次探测（需在真实页面核对），无命中回退容器自身
  let stemNode = null;
  for (const selector of STEM_SELECTOR_CANDIDATES) {
    stemNode = safeQuery(container, selector);
    if (stemNode) break;
  }
  let stemHtml = stemNode ? asString(stemNode.innerHTML) : "";
  if (!stripTagsHtml(stemHtml)) {
    // 回退：容器自身 HTML（含选项文本时由 quiz-solver 清洗题干前缀，需在真实页面核对）
    stemHtml = asString(container.innerHTML);
  }
  if (!stripTagsHtml(stemHtml)) return null;

  // 题型：从题干前缀【单选】等提取（与 quiz-solver 的 qtype 0–4 映射一致）
  let qtype = extractZhihuishuQuestionType(stemHtml);

  // 选项输入（radio/checkbox 的 label/父级）
  const choiceInputs = [];
  for (const element of safeQueryAll(container, 'input[type="radio"], input[type="checkbox"]')) {
    const type = asString(element.type).toLowerCase();
    if (type !== "radio" && type !== "checkbox") continue;
    if (choiceInputs.indexOf(element) === -1) choiceInputs.push(element);
  }
  // 文本输入（填空/简答）：input[type=text]、无 type 的 input、textarea（排除 hidden）
  const textInputs = [];
  for (const element of safeQueryAll(container, 'input[type="text"], input:not([type]), textarea')) {
    const tag = asString(element.tagName).toLowerCase();
    const type = asString(element.type).toLowerCase();
    if (tag === "input" && type === "hidden") continue;
    if (textInputs.indexOf(element) === -1) textInputs.push(element);
  }

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
    const options = buildZhihuishuOptions(container, choiceInputs);
    if (!options.length) return null;
    // 判断题识别：题干未标【判断】但选项仅两枚"对/错/正确/错误"时映射为 3（需在真实页面核对）
    if (qtype === 0 && isTrueFalseOptions(options)) qtype = 3;
    return {
      qtype,
      stem: stemHtml,
      options,
      isAnswered: () => zhihuishuChoiceAnswered(options),
    };
  }

  if (!textInputs.length) return null;
  return {
    qtype,
    stem: stemHtml,
    inputs: textInputs,
    isAnswered: () => zhihuishuInputsAnswered(textInputs),
  };
}

function buildZhihuishuOptions(container, choiceInputs) {
  const options = [];
  if (choiceInputs.length) {
    for (const input of choiceInputs) {
      options.push(buildChoiceOptionEntry(input, container));
    }
    return options;
  }
  // 兜底：无 radio/checkbox 时按选项列表候选处理（可点击 div/li 选项，需在真实页面核对）
  const listNodes = [];
  for (const selector of OPTION_LIST_SELECTOR_CANDIDATES) {
    for (const node of safeQueryAll(container, selector)) listNodes.push(node);
  }
  for (const node of uniqueNodes(listNodes)) {
    options.push({ html: asString(node.innerHTML), element: node });
  }
  return options;
}

function buildChoiceOptionEntry(input, container) {
  // 点击目标：input 的 label 或父级（点击 label/li 联动 radio/checkbox）
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
  // 选项文本：label/li 的 innerHTML（quiz-solver 清洗时去除其中的 input 标签与选项前缀）
  let html = "";
  if (target !== input) html = asString(target.innerHTML);
  if (!stripTagsHtml(html)) {
    html = asString(input.getAttribute && input.getAttribute("value")) || asString(input.value);
  }
  return { html, element: target, input };
}

function isTrueFalseOptions(options) {
  const texts = options.map((option) => stripTagsHtml(option && option.html));
  if (texts.length !== 2) return false;
  return texts.every((text) => TRUE_FALSE_OPTION_TEXT_RE.test(text));
}

// 已答检测：input checked / 承载节点 aria-label 非空 / class 含 checked|selected|current（需在真实页面核对）
function zhihuishuChoiceAnswered(options) {
  for (const entry of options) {
    if (!entry) continue;
    if (entry.input) {
      try {
        if (entry.input.checked === true) return true;
      } catch (_error) { /* 忽略。 */ }
    }
    const element = entry.element;
    if (!element) continue;
    try {
      const label = element && typeof element.getAttribute === "function"
        ? element.getAttribute("aria-label") || ""
        : "";
      if (asString(label).trim()) return true;
      const className = String(element.className || "");
      if (/(^|\s)(checked|selected|current)(\s|$)/.test(className)) return true;
    } catch (_error) { /* 忽略。 */ }
  }
  return false;
}

function zhihuishuInputsAnswered(inputs) {
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

// quiz-solver 三级解析：contextWindow.CourseHelperQuizSolver → globalThis → require("../quiz-solver.js")
function resolveZhihuishuQuizSolver(context) {
  const view = getContextWindow(context);
  if (view && view.CourseHelperQuizSolver &&
      typeof view.CourseHelperQuizSolver.solveQuestions === "function") {
    return view.CourseHelperQuizSolver;
  }
  if (typeof globalThis !== "undefined" && globalThis.CourseHelperQuizSolver &&
      typeof globalThis.CourseHelperQuizSolver.solveQuestions === "function") {
    return globalThis.CourseHelperQuizSolver;
  }
  if (typeof require === "function") {
    try {
      const loaded = require("../quiz-solver.js");
      const api = loaded && typeof loaded === "object" ? (loaded.default || loaded) : loaded;
      if (api && typeof api.solveQuestions === "function") return api;
    } catch (_error) {
      // 模块不可加载时走不可用告警路径。
    }
  }
  return null;
}

async function readZhihuishuAutoSubmit(context) {
  const settings = asObject(context && context.settings) || {};
  if (typeof settings.autoSubmit === "boolean") return settings.autoSubmit;
  const stored = await readZhihuishuStoredSettings(["autoSubmit"]);
  if (stored && typeof stored.autoSubmit === "boolean") return stored.autoSubmit;
  return true; // 默认开启自动提交
}

// ---- 提交按钮探测（候选选择器 + 文本探测，需在真实页面核对）----
function findZhihuishuSubmitButton(doc) {
  if (!doc) return null;
  for (const selector of SUBMIT_BUTTON_SELECTOR_CANDIDATES) {
    for (const element of safeQueryAll(doc, selector)) {
      if (typeof element.click === "function") return element;
    }
  }
  for (const element of safeQueryAll(doc, 'button, a, [role="button"]')) {
    const text = asString(element.textContent).replace(/\s+/g, "");
    if (text && text.length <= SUBMIT_BUTTON_TEXT_MAX_LENGTH &&
        SUBMIT_BUTTON_TEXT_RE.test(text) && typeof element.click === "function") {
      return element;
    }
  }
  return null;
}

function clickZhihuishuSubmit(button, context) {
  try {
    if (button && typeof button.click === "function") {
      button.click();
      return true;
    }
  } catch (_error) {
    // 落入下方告警路径。
  }
  zhsWarn(context, "智慧树提交按钮点击失败。");
  return false;
}

export async function fillAnswers(questions, answers, ctx) {
  const context = ctx || activeContext;
  const list = Array.isArray(questions) ? questions : [];
  if (!list.length) {
    zhsWarn(context, "智慧树填答：题目列表为空，跳过。");
    return;
  }

  // 优先 quiz-solver 自动答题（缓存命中 → DeepSeek，失败跳过本题不阻塞队列）
  const solver = resolveZhihuishuQuizSolver(context);
  if (solver && typeof solver.solveQuestions === "function") {
    const autoSubmit = await readZhihuishuAutoSubmit(context);
    const solveOptions = { autoSubmit };
    const submitButton = findZhihuishuSubmitButton(getContextDocument(context));
    if (submitButton) {
      solveOptions.submit = () => clickZhihuishuSubmit(submitButton, context);
    }
    await solver.solveQuestions(list, context, solveOptions);
    return;
  }

  // solver 不可用：按 spec/50 原生方式填答（需要传入 answers 数组）
  if (Array.isArray(answers) && answers.length > 0) {
    await fillAnswersNatively(list, answers, context);
    return;
  }

  zhsWarn(context, "quiz-solver 不可用且未提供 answers 数组，智慧树题目无法填答。");
}

// ---- 原生填答（spec/50）：radio/checkbox click + input 原生 value setter + dispatch input ----
async function fillAnswersNatively(questions, answers, context) {
  let filled = 0;
  for (let index = 0; index < questions.length && index < answers.length; index += 1) {
    const question = questions[index];
    const answer = answers[index];
    if (!question || answer === null || answer === undefined) continue;
    if (question.isAnswered && typeof question.isAnswered === "function") {
      try {
        if (await question.isAnswered()) continue; // 已答跳过
      } catch (_error) {
        // 已答检测失败按未答题继续。
      }
    }
    try {
      if (fillOneQuestionNatively(question, answer, context)) filled += 1;
    } catch (_error) {
      // 单题填答异常不阻塞后续题目。
    }
  }
  zhsLog(context, `智慧树原生填答完成：${filled}/${questions.length} 道题（${answers.length} 个答案）。`);
}

function fillOneQuestionNatively(question, answer, context) {
  const qtype = Number(question.qtype);
  if (!Number.isInteger(qtype) || qtype < 0 || qtype > 4) return false;
  const text = asString(answer).trim();
  if (!text) return false;

  if (qtype === 0 || qtype === 1 || qtype === 3) {
    const options = Array.isArray(question.options) ? question.options : [];
    if (!options.length) return false;
    const indexes = matchAnswerIndexesNatively(text, options);
    if (!indexes.length) {
      zhsWarn(context, "智慧树原生填答：答案与选项无法匹配，跳过该题。");
      return false;
    }
    let clicked = 0;
    for (const optionIndex of indexes) {
      const option = options[optionIndex];
      const target = option && (option.element || option.input);
      if (!target || typeof target.click !== "function") continue;
      try {
        target.click(); // radio/checkbox click（spec/50）
        clicked += 1;
      } catch (_error) {
        // 单个选项点击失败不影响其他选项。
      }
    }
    return clicked > 0;
  }

  // 填空（qtype 2，多空用 # 分隔）与简答（qtype 4）
  const inputs = Array.isArray(question.inputs) ? question.inputs : [];
  if (!inputs.length) {
    zhsWarn(context, "智慧树原生填答：题目缺少输入框，无法填答文本类题目。");
    return false;
  }
  const values = qtype === 2 ? text.split(/\s*#\s*/) : [text];
  let filledCount = 0;
  for (let i = 0; i < inputs.length && i < values.length; i += 1) {
    if (values[i] === undefined || values[i] === "") continue;
    setNativeInputValue(inputs[i], values[i]);
    filledCount += 1;
  }
  return filledCount > 0;
}

function matchAnswerIndexesNatively(answer, options) {
  const normalized = normalizeZhihuishuText(answer);
  if (!normalized) return [];
  const indexes = [];
  // 1) 字母匹配：单选/判断 A–Z；多选连续字母（如 ABD）逐个映射
  if (/^[A-Za-z]{1,10}$/.test(normalized)) {
    for (const char of normalized.toUpperCase()) {
      const index = char.charCodeAt(0) - 65;
      if (index >= 0 && index < options.length && indexes.indexOf(index) === -1) {
        indexes.push(index);
      }
    }
    if (indexes.length) return indexes;
  }
  // 2) 文本匹配：与选项文本规范化比较（包含关系，参考 quiz-solver 的匹配思路；
  //    判断题答案"对/错/正确/错误"经此路径命中选项）
  for (let i = 0; i < options.length; i += 1) {
    const optionText = normalizeZhihuishuText(stripTagsHtml(options[i] && options[i].html));
    if (!optionText) continue;
    if (optionText === normalized ||
        (optionText.indexOf(normalized) !== -1 || normalized.indexOf(optionText) !== -1)) {
      if (indexes.indexOf(i) === -1) indexes.push(i);
    }
  }
  return indexes;
}

function normalizeZhihuishuText(value) {
  return asString(value)
    .replace(/\s+/g, "")
    .replace(/[.．、,，:：;；)]/g, "")
    .toUpperCase();
}

// 原生 value setter（沿原型链找 value 描述符并用其 set 调用，绕过框架对 value 的劫持）+
// dispatch input 事件（spec/50）
function setNativeInputValue(element, value) {
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
    try { element.value = text; } catch (_assignmentError) { /* 只读对象安全跳过。 */ }
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

// ==== END SECTION: zhihuishu-quiz ====

// ==== SECTION: zhihuishu-keep-alive ====
// ---- 智慧树保活（spec/50）----
// 复用 keep-alive.js 全局 API（globalThis.__COURSE_HELPER_KEEP_ALIVE__）：
//   其关键词检测（长时间未操作|继续使用|继续学习|超时|timeout|会话已结束）覆盖智慧树
//   常见"继续学习"挂机弹窗（AGENT 08 已实现，本适配器只做接线）；
// 全局 API 不可用时降级为简易 visibility/focus 监听并 console 警告"keep-alive 不可用"。

export function handleKeepAlive(root) {
  const target = root || getContextDocument(activeContext);
  const api = readKeepAliveApi();
  if (api) {
    keepAliveApi = api;
    try {
      // start/init 内部幂等（keep-alive 为单例 state）
      if (typeof api.start === "function") api.start(target);
      else if (typeof api.init === "function") api.init(target);
      zhsLog(activeContext, "智慧树保活：keep-alive 已启动（覆盖\"继续学习\"等挂机弹窗关键词）。");
    } catch (_error) {
      // keep-alive 启动失败不能阻断视频与答题流程。
    }
    return;
  }

  if (degradeKeepAliveCleanups.length > 0) return; // 降级幂等
  zhsWarn(activeContext, "keep-alive 不可用（globalThis.__COURSE_HELPER_KEEP_ALIVE__ 缺失），启用简易 visibility/focus 保活降级。");
  installDegradeKeepAlive(target);
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

// 降级保活：页面重新可见/聚焦时恢复活跃视频播放（不能替代 keep-alive 的弹窗检测与活动模拟）
function installDegradeKeepAlive(target) {
  const doc = target || getContextDocument(activeContext);
  const view = getContextWindow(activeContext);
  attachListener(doc, "visibilitychange", () => {
    const hidden = doc && (doc.hidden === true || doc.visibilityState === "hidden");
    if (!hidden) resumeAllActiveVideos();
  }, degradeKeepAliveCleanups);
  attachListener(view, "focus", () => {
    resumeAllActiveVideos();
  }, degradeKeepAliveCleanups);
}

function resumeAllActiveVideos() {
  if (!autoVideoEnabled) return;
  for (const state of videoStates.slice()) {
    if (state.generation === activeGeneration) scheduleVideoResume(state);
  }
}

function stopKeepAlive() {
  if (keepAliveApi && (typeof keepAliveApi.destroy === "function" || typeof keepAliveApi.stop === "function")) {
    try {
      if (typeof keepAliveApi.destroy === "function") keepAliveApi.destroy();
      else keepAliveApi.stop();
    } catch (_error) {
      // keep-alive 已失效时忽略停止错误。
    }
  }
  keepAliveApi = null;
}

// ==== END SECTION: zhihuishu-keep-alive ====
