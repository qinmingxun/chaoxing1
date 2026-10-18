/*
 * [SECTION:ADAPTER_CHAOXING]
 * 职责：学习通（Chaoxing）页面适配器的路由、任务解析与跨层请求骨架。
 * 本文件只实现任务解析及文档类任务的契约接线；视频、答题、字体解密等细节留给后续 Agent。
 */

// ==== SECTION: chaoxing-selectors ====
const SELECTORS = Object.freeze({
  inlineScripts: "script",
  attachmentContainers: ".wrap .ans-cc .ans-attach-ct",
  attachmentFrame: "iframe",
  chapterNext: "#mainid > .prev_next.next:not(.disabled), #prevNextFocusNext:not(.disabled)",
  pcQuizStatus: ".newTestCon .newTestTitle .testTit_status",
  pcQuizQuestion: ".CeYan .TiMu",
});

const ROUTES = Object.freeze({
  KNOWLEDGE_CARDS: "/knowledge/cards",
  STUDENT_STUDY: "/mycourse/studentstudy",
  EXAM: "/exam/test/reVersionTestStartNew",
  WORK: "/mooc2/work/dowork",
  PHONE_HOMEWORK: "/work/phone/doHomeWork",
});

const ROUTE_PATHS = Object.freeze(Object.values(ROUTES));
const FIXTURE_PATH = "/test-page.html";
const MARG_TRY_RE = /try\s*\{\s*mArg\s*=\s*([\s\S]*?)(?:;\s*)?\}\s*catch\b/gi;
const MARG_ASSIGN_RE = /mArg\s*=\s*([\{\[][\s\S]*?)(?:;|$)/i;
const MAIN_SOURCE = "course-helper";
const MAIN_INIT_EVENT = "course-helper:main:init";
const MAIN_CONFIRM_EVENT = "course-helper:main:set-confirm";
const MAIN_DISPOSE_EVENT = "course-helper:main:dispose";
const REQUEST_PREFIX = "cx";

let activeContext = null;
let activeGeneration = 0;
let chapterClickHandler = null;
let internalChapterClick = false;
let lastChapterClickAt = 0;
let requestSequence = 0;

function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? "";
}

function normalizePathname(pathname) {
  const path = asString(pathname).trim();
  if (!path) return "/";
  const withoutTrailingSlash = path.replace(/\/+$/, "");
  return withoutTrailingSlash || "/";
}

function getPathname(urlOrLocation) {
  if (!urlOrLocation) return "";
  if (typeof urlOrLocation === "string") {
    try {
      return new URL(urlOrLocation, "https://chaoxing.invalid").pathname;
    } catch (_error) {
      return urlOrLocation.split(/[?#]/, 1)[0];
    }
  }
  return asString(urlOrLocation.pathname);
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

function defineMetadata(target, name, value) {
  try {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: false,
      value,
      writable: true,
    });
  } catch (_error) {
    // 解析结果仍可在没有元数据的情况下使用。
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

function createRequestId() {
  requestSequence += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `${REQUEST_PREFIX}-${Date.now()}-${requestSequence}-${random}`;
}

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

// ==== END SECTION: chaoxing-selectors ====

// ==== SECTION: chaoxing-route ====
export function matches(url) {
  const path = normalizePathname(getPathname(url));
  // 手机版测验在任务列表页 /work/phone/doHomeWork 内 iframe 导航到 /work/phone/work 后处理，
  // 一并放行 /work/phone 前缀（spec/30e）。
  return ROUTE_PATHS.includes(path) || path.indexOf("/work/phone") === 0;
}

export async function init(ctx) {
  if (activeContext) return;

  activeContext = ctx || {};
  const generation = ++activeGeneration;
  const doc = getContextDocument(activeContext);
  const path = normalizePathname(getPathname(activeContext.location));

  postMainMessage(activeContext, MAIN_INIT_EVENT, {
    version: 1,
    routes: ROUTE_PATHS.slice(),
  });
  postMainMessage(activeContext, MAIN_CONFIRM_EVENT, { enabled: true });
  installChapterGuard(doc);

  if (path === ROUTES.KNOWLEDGE_CARDS) {
    const parsed = parseTasks(doc);
    await processTaskQueue(parsed.tasks, parsed.defaults, activeContext, generation);
  } else if (path === FIXTURE_PATH) {
    // 本地 fixture 测试页（spec/70，localhost 经 loader 放行进入本分支）：
    // 1) PC 测验区：solvePcQuiz 自动提取→答题→提交→确认；
    // 2) 视频区：以伪任务走 runVideoPlayTask（自动 play/倍速，ended 时完成；不 await，
    //    随页面上"模拟 ended"按钮触发完成）；"下一集"按钮由 fixture 页面自身逻辑处理；
    // 3) 挂机弹窗区：由 loader 的全局 keep-alive 覆盖（本分支无需处理）；
    // 4) u校园提交注入区：MAIN bridge 已由 loader 注入，用户点"模拟提交"时自动改写
    //    payload（答案队列可经页面控制台预填 __UCAMPUS_ANSWER_CACHE__）。
    if (activeContext && typeof activeContext.log === "function") {
      activeContext.log("[course-helper] 本地 fixture 测试页：验证 PC 测验与视频播放。");
    }
    try {
      await solvePcQuiz(doc, activeContext);
    } catch (_error) {
      // fixture 测验异常不阻塞视频验证。
    }
    try {
      // fixture 视频无真实 src：浏览器原生 play() 必然 reject，且 paused 恒为 true，
      // 会令视频分区每轮轮询重试恢复（pause/play 抖动循环）。此处仅对本页面的
      // video 包装 play() 模拟可播放状态，让视频验证区按"自动播放→倍速→ended 完成"
      // 正常流转（仅 fixture 分支生效，不影响生产页面）。
      for (const media of safeQueryAll(doc, "video")) {
        if (media.__courseHelperFixtureMedia) continue;
        try {
          Object.defineProperty(media, "__courseHelperFixtureMedia", {
            configurable: true,
            value: true,
          });
          media.play = function fixturePlay() {
            try {
              this.paused = false;
            } catch (_error) {
              // 只读媒体对象安全跳过。
            }
            return Promise.resolve();
          };
        } catch (_error) {
          // 包装失败时保留原生行为（抖动循环仅影响 fixture 日志）。
        }
      }
      void runVideoPlayTask({ type: "video", iframe: { contentDocument: doc } }, {}, activeContext);
    } catch (_error) {
      // 视频验证失败不抛出。
    }
    // fixture 诊断：延迟打印 keep-alive 运行状态（loader 在 init 完成后启动保活），
    // 供本地验证挂机弹窗自动点击时排查（真实平台页面不进入本分支，无影响）。
    try {
      const fixtureDiagnoseAt = Date.now();
      setTimeout(() => {
        try {
          const keepAliveApi = typeof globalThis !== "undefined"
            ? globalThis.__COURSE_HELPER_KEEP_ALIVE__
            : null;
          const state = keepAliveApi && typeof keepAliveApi.getState === "function"
            ? keepAliveApi.getState()
            : null;
          const message = `[course-helper] fixture: keep-alive 状态（+${Date.now() - fixtureDiagnoseAt}ms）= ${state ? JSON.stringify(state) : (keepAliveApi ? "无 getState" : "未挂载")}`;
          if (activeContext && typeof activeContext.log === "function") {
            activeContext.log(message);
          } else {
            console.log(message);
          }
        } catch (_error) {
          // 诊断失败不影响验证流程。
        }
      }, 2500);
    } catch (_error) {
      // 诊断注册失败不抛出。
    }
  } else if (path === ROUTES.WORK || path === ROUTES.EXAM || path.indexOf("/work/phone") === 0) {
    // 作业页 / 考试页 / 手机版测验（含任务列表页与测验 iframe）：
    // 由 solvePhoneWorkExam 按页面结构自动分流（quiz-phone/work-exam 分区）。
    // 字体解密先行（spec/30f：题目提取前必须先解密）；解密不可用时跳过并警告。
    await decryptFont(doc);
    if (hasUndecryptedFont(doc)) {
      if (activeContext && typeof activeContext.log === "function") {
        activeContext.log("[course-helper] 字体解密不可用，跳过本页答题流程（作业/考试/手机版测验）。");
      }
    } else {
      await solvePhoneWorkExam(doc, activeContext);
    }
  }
}

export function destroy() {
  const context = activeContext;
  activeGeneration += 1;
  removeChapterGuard();
  activeContext = null;
  if (context) {
    postMainMessage(context, MAIN_DISPOSE_EVENT, { reason: "adapter-destroy" });
    postMainMessage(context, MAIN_CONFIRM_EVENT, { enabled: false });
  }
}

// ==== END SECTION: chaoxing-route ====

// ==== SECTION: chaoxing-task-parse ====
function extractMArgValue(doc) {
  const scripts = safeQueryAll(doc, SELECTORS.inlineScripts);
  for (const script of scripts) {
    const source = asString(script && (script.textContent ?? script.innerHTML));
    if (!source) continue;

    MARG_TRY_RE.lastIndex = 0;
    let match;
    while ((match = MARG_TRY_RE.exec(source)) !== null) {
      const candidate = asString(match[1]).trim().replace(/;\s*$/, "");
      if (!candidate) continue;
      try {
        return JSON.parse(candidate);
      } catch (_error) {
        // 同一 script 可能含有多个 mArg，继续尝试下一个候选值。
      }
    }

    const fallback = source.match(MARG_ASSIGN_RE);
    if (fallback) {
      let candidate = asString(fallback[1]).trim().replace(/;\s*$/, "");
      try {
        return JSON.parse(candidate);
      } catch (_error) {
        // 无法解析时交给下一个 script。
      }
    }
  }
  return null;
}

function readAttachmentsAndDefaults(parsed) {
  let attachments = [];
  let defaults = {};

  if (Array.isArray(parsed)) {
    if (Array.isArray(parsed[0])) attachments = parsed[0];
    else attachments = parsed;
    defaults = asObject(parsed[1]) || {};
  } else if (asObject(parsed)) {
    const data = asObject(parsed.data);
    const attachmentValue = firstDefined(
      parsed.attachments,
      parsed.attachment,
      parsed.tasks,
      data && data.attachments,
      data && data.tasks,
    );
    if (Array.isArray(attachmentValue)) attachments = attachmentValue;

    defaults =
      asObject(parsed.defaults) ||
      asObject(parsed.default) ||
      (data && (asObject(data.defaults) || asObject(data.default))) ||
      {};
  }

  return { attachments, defaults };
}

function attachDomMetadata(task, container, index) {
  defineMetadata(task, "attachmentIndex", index);
  defineMetadata(task, "container", container || null);
  defineMetadata(task, "element", container || null);
  defineMetadata(task, "iframe", safeQuery(container, SELECTORS.attachmentFrame));
  return task;
}

export function parseTasks(doc) {
  const parsed = extractMArgValue(doc);
  const { attachments, defaults } = readAttachmentsAndDefaults(parsed);
  const containers = safeQueryAll(doc, SELECTORS.attachmentContainers);

  const tasks = attachments.map((rawTask, index) => {
    const task = asObject(rawTask) ? { ...rawTask } : { value: rawTask };
    return attachDomMetadata(task, containers[index] || null, index);
  });

  return { tasks, defaults };
}

function taskModule(task) {
  if (!task || typeof task !== "object") return "";
  const property = asObject(task.property);
  return asString(firstDefined(task.type || undefined, property && property.module))
    .trim()
    .toLowerCase();
}

function taskValue(task, defaults, ...names) {
  const property = task && asObject(task.property);
  const sources = [task, property, defaults];
  for (const name of names) {
    for (const source of sources) {
      if (source && source[name] !== undefined && source[name] !== null) return source[name];
    }
  }
  return "";
}

function resolveOrigin(ctx) {
  const location = ctx && ctx.location;
  return asString(firstDefined(location && location.origin, getContextWindow(ctx) && getContextWindow(ctx).location && getContextWindow(ctx).location.origin));
}

function buildJobInput(task, defaults, ctx) {
  return {
    origin: resolveOrigin(ctx),
    jobid: asString(taskValue(task, defaults, "jobid", "jobId", "jobID")),
    knowledgeid: asString(taskValue(task, defaults, "knowledgeid", "knowledgeId")),
    courseid: asString(taskValue(task, defaults, "courseid", "courseId")),
    clazzid: asString(taskValue(task, defaults, "clazzid", "clazzId", "classId")),
    jtoken: asString(taskValue(task, defaults, "jtoken", "jToken")),
  };
}

function backgroundResultData(response) {
  if (response && response.ok === false) return null;
  if (response && Object.prototype.hasOwnProperty.call(response, "data")) return response.data;
  return response;
}

async function sendJob(kind, input, ctx) {
  const context = ctx || activeContext;
  if (!context || typeof context.sendMessage !== "function") {
    return {
      ok: false,
      error: { code: "NO_CONTEXT", message: "AdapterContext.sendMessage 不可用" },
    };
  }

  const messageType = {
    document: "CX_DOCUMENT",
    readv2: "CX_READV2",
    job: "CX_JOB",
  }[kind];
  if (!messageType) {
    return {
      ok: false,
      error: { code: "BAD_KIND", message: `不支持的完成任务类型：${asString(kind)}` },
    };
  }

  const payload = {
    origin: asString(firstDefined(input && input.origin, resolveOrigin(context))),
    jobid: asString(input && input.jobid),
    knowledgeid: asString(input && input.knowledgeid),
    courseid: asString(input && input.courseid),
    clazzid: asString(input && input.clazzid),
    jtoken: asString(input && input.jtoken),
    cacheBust: Number.isFinite(input && input.cacheBust) ? input.cacheBust : Date.now(),
  };

  try {
    const response = await context.sendMessage({
      type: messageType,
      requestId: createRequestId(),
      payload,
    });
    return { ok: true, data: backgroundResultData(response) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "SEND_MESSAGE_FAILED",
        message: error && error.message ? String(error.message) : "发送后台请求失败",
      },
    };
  }
}

export async function completeJob(kind, input) {
  const result = await sendJob(kind, input || {}, activeContext);
  if (result.ok) return result.data || {};
  return { isPassed: false, error: result.error };
}

function getTaskDocument(task, ctx) {
  if (task && task.document && typeof task.document.querySelector === "function") return task.document;
  if (task && task.iframe && task.iframe.contentDocument) return task.iframe.contentDocument;
  return getContextDocument(ctx);
}

export async function processTask(task, defaults, ctx) {
  if (!task || typeof task !== "object") {
    return { done: true, skipped: true, reason: "invalid-task" };
  }
  if (task.isPassed === true) {
    return { done: true, skipped: true, reason: "passed" };
  }

  const context = ctx || activeContext;
  const module = taskModule(task);
  if (module === "insertimage") {
    return { done: true, skipped: true, reason: "insertimage" };
  }

  if (module === "document" || module === "read" || module === "insertbook") {
    const kind = module === "document" ? "document" : module === "read" ? "readv2" : "job";
    const result = await sendJob(kind, buildJobInput(task, defaults || {}, context), context);
    if (!result.ok) {
      return { done: false, skipped: false, reason: "complete-job-failed" };
    }
    return { done: true, skipped: false };
  }

  if (module === "video" || module === "audio") {
    const settings = asObject(context && context.settings) || {};
    if (module === "video" && settings.cxVideoMode !== "play" && typeof runVideoReportTask === "function") {
      return runVideoReportTask(task, defaults || {}, context);
    }
    if (typeof runVideoPlayTask === "function") {
      return runVideoPlayTask(task, defaults || {}, context);
    }
    return {
      done: false,
      skipped: false,
      reason: VIDEO_PLAY_STUB_REASON,
    };
  }

  if (module === "workid") {
    const taskDoc = getTaskDocument(task, context);
    // 字体解密必须在题目提取之前完成（spec/30f）；decryptFont 幂等且无加密元素时立即返回。
    await decryptFont(taskDoc);
    if (hasUndecryptedFont(taskDoc)) {
      // 字体解密不可用/映射未命中：跳过整个测验并警告，不阻塞任务队列（spec/30f 降级语义）。
      if (context && typeof context.log === "function") {
        context.log("[course-helper] 字体解密不可用，跳过含加密字符的测验任务（workid）。");
      }
      return { done: true, skipped: true, reason: "font-decrypt-unavailable" };
    }
    // 手机版测验任务点（workid 模块、iframe 内为 .zquestions .Py-mian1 手机版页面结构）
    // 走 solvePhoneWorkExam；否则按 PC 版测验处理。
    const isPhoneQuiz = Boolean(safeQuery(taskDoc, PHONE_QUIZ_QUESTION_SELECTOR));
    const result = isPhoneQuiz
      ? await solvePhoneWorkExam(taskDoc, context)
      : await solvePcQuiz(taskDoc, context);
    return result && typeof result === "object"
      ? result
      : { done: false, skipped: false, reason: WORK_EXAM_STUB_REASON };
  }

  return { done: true, skipped: true, reason: "unsupported" };
}

async function processTaskQueue(tasks, defaults, ctx, generation) {
  if (!Array.isArray(tasks)) return;

  while (tasks.length && activeContext === ctx && activeGeneration === generation) {
    let result;
    try {
      result = await processTask(tasks[0], defaults, ctx);
    } catch (_error) {
      result = { done: false, skipped: false, reason: "task-error" };
    }

    if (activeContext !== ctx || activeGeneration !== generation) return;
    if (!result || result.done !== true) return;
    tasks.splice(0, 1);
  }

  if (!tasks.length && activeContext === ctx && activeGeneration === generation) {
    triggerNextChapter(getContextDocument(ctx));
  }
}

// ==== END SECTION: chaoxing-task-parse ====

// ==== SECTION: video-report ====
const VIDEO_REPORT_STUB_REASON = "video-report-not-implemented";

// ---- 学习通视频模拟上报（spec/30b）----
// CX_STATUS：GET {origin}/ananas/status/{objectId}?k={fid}&flag=normal&_dc={时间戳}；
// Blob Worker 每 200ms 从 playingTime 起累计 elapsed*rate；
// 上报间隔 max(5, floor(基础间隔/rate))，基础间隔默认 58s，popup 的 cxReportBaseInterval 可覆盖；
// 完成时 isdrag=4，响应 isPassed===true 视为任务完成；showProgress 右下角浮窗可选开关。
const VIDEO_REPORT_TICK_MS = 200;
const VIDEO_REPORT_DEFAULT_BASE_INTERVAL_SEC = 58;
const VIDEO_REPORT_MIN_INTERVAL_SEC = 5;
const VIDEO_REPORT_MAX_RATE = 8;
const VIDEO_REPORT_ENC_SALT = "d_yHJ!$pdA~5";
const VIDEO_REPORT_MAX_CONSECUTIVE_FAILURES = 3;

let videoReportProgressElement = null;
let videoReportRunActive = false;
let videoReportMd5Warned = false;

function toFiniteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

// 与 firstDefined 不同：空字符串不算命中，用于 cookie 多候选回退。
function firstNonEmpty(...values) {
  for (const value of values) {
    if (value) return value;
  }
  return "";
}

function readCookieValue(doc, name) {
  const target = doc || getContextDocument(activeContext);
  if (!target || typeof target.cookie !== "string") return "";
  const pairs = target.cookie.split(";");
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    let decodedKey;
    try {
      decodedKey = decodeURIComponent(key);
    } catch (_error) {
      decodedKey = key;
    }
    if (decodedKey !== name) continue;
    const rawValue = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch (_error) {
      return rawValue;
    }
  }
  return "";
}

// MD5 来源优先级：ctx.md5 → 页面/全局 md5 → require("../..//lib/md5.js")（Node/打包器兼容）。
function resolveVideoReportMd5(context) {
  if (context && typeof context.md5 === "function") return context.md5;
  const view = getContextWindow(context);
  if (view && typeof view.md5 === "function") return view.md5;
  if (typeof globalThis !== "undefined" && typeof globalThis.md5 === "function") return globalThis.md5;
  if (typeof require === "function") {
    try {
      const loaded = require("../..//lib/md5.js");
      const fn = typeof loaded === "function" ? loaded : loaded && (loaded.md5 || loaded.default);
      if (typeof fn === "function") return fn;
    } catch (_error) {
      // 模块不可加载时继续走告警路径。
    }
  }
  return null;
}

function videoReportWarn(context, message) {
  if (context && typeof context.log === "function") {
    context.log(message);
    return;
  }
  const view = getContextWindow(context);
  if (view && view.console && typeof view.console.warn === "function") {
    view.console.warn(`[course-helper] ${message}`);
  }
}

// enc = MD5("[clazzId][uid][jobId][objectId][playingTime*1000][d_yHJ!$pdA~5][duration*1000][0_duration]")
function buildVideoReportEnc(md5, fields) {
  const playingTimeSec = Math.floor(toFiniteNonNegative(fields && fields.playingTime, 0));
  const durationSec = Math.floor(toFiniteNonNegative(fields && fields.duration, 0));
  const raw =
    `[${asString(fields && fields.clazzId)}][${asString(fields && fields.uid)}]` +
    `[${asString(fields && fields.jobId)}][${asString(fields && fields.objectId)}]` +
    `[${playingTimeSec * 1000}][${VIDEO_REPORT_ENC_SALT}][${durationSec * 1000}][0_${durationSec}]`;
  return md5(raw);
}

// ---- 进度浮窗（右下角，showProgress 开关）----
function ensureProgressOverlay(doc, enabled) {
  if (videoReportProgressElement) return videoReportProgressElement;
  if (enabled === false) return null;
  const target = doc || getContextDocument(activeContext);
  if (!target || !target.body || typeof target.createElement !== "function") return null;
  const element = target.createElement("div");
  element.setAttribute("data-course-helper-progress", "video-report");
  const style = element.style;
  style.position = "fixed";
  style.right = "16px";
  style.bottom = "16px";
  style.zIndex = "2147483647";
  style.padding = "8px 12px";
  style.borderRadius = "4px";
  style.background = "rgba(0, 0, 0, 0.72)";
  style.color = "#ffffff";
  style.font = "12px/1.4 system-ui, sans-serif";
  style.pointerEvents = "none";
  element.textContent = "视频模拟进度 0.0%";
  try {
    target.body.appendChild(element);
    videoReportProgressElement = element;
  } catch (_error) {
    return null;
  }
  return element;
}

function updateProgressOverlay(percent) {
  if (!videoReportProgressElement) return;
  const bounded = Math.max(0, Math.min(100, Number(percent) || 0));
  videoReportProgressElement.textContent = `视频模拟进度 ${bounded.toFixed(1)}%`;
}

function removeProgressOverlay() {
  const element = videoReportProgressElement;
  videoReportProgressElement = null;
  if (!element) return;
  try {
    if (element.parentNode) element.parentNode.removeChild(element);
  } catch (_error) {
    // 页面已卸载时忽略清理错误。
  }
}

// ---- Blob Worker 计时器（避开后台标签页定时器节流），失败降级为页面 setInterval ----
function videoReportWorkerSource() {
  return [
    "(function () {",
    "  'use strict';",
    "  var timer = null;",
    "  var last = 0;",
    "  function stop() { if (timer !== null) { clearInterval(timer); timer = null; } }",
    "  function tick() {",
    "    var now = Date.now();",
    "    var elapsedMs = now - last;",
    "    last = now;",
    "    self.postMessage({ type: 'tick', now: now, elapsedMs: elapsedMs });",
    "  }",
    "  self.onmessage = function (event) {",
    "    var data = event && event.data ? event.data : {};",
    "    if (data.type === 'stop') { stop(); return; }",
    "    if (data.type === 'start') {",
    "      stop();",
    "      last = Date.now();",
    "      timer = setInterval(tick, 200);",
    "    }",
    "  };",
    "}());",
  ].join("\n");
}

function getVideoReportPlatformGlobals(context) {
  const view = getContextWindow(context);
  return {
    Worker: view && typeof view.Worker === "function"
      ? view.Worker
      : typeof Worker === "function" ? Worker : null,
    Blob: view && typeof view.Blob === "function"
      ? view.Blob
      : typeof Blob === "function" ? Blob : null,
    URL: view && view.URL ? view.URL : typeof URL !== "undefined" ? URL : null,
  };
}

function startVideoReportClock(context, onTick) {
  const globals = getVideoReportPlatformGlobals(context);
  let worker = null;
  let workerUrl = null;
  let timer = null;
  let lastTickAt = 0;
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (worker) {
      try {
        if (typeof worker.postMessage === "function") worker.postMessage({ type: "stop" });
      } catch (_error) {
        // 忽略已失效的 worker。
      }
      try {
        if (typeof worker.terminate === "function") worker.terminate();
      } catch (_error) {
        // 忽略已失效的 worker。
      }
      worker = null;
    }
    if (workerUrl && globals.URL && typeof globals.URL.revokeObjectURL === "function") {
      try {
        globals.URL.revokeObjectURL(workerUrl);
      } catch (_error) {
        // 忽略已失效的 URL。
      }
      workerUrl = null;
    }
  }

  function startFallbackClock() {
    if (stopped || timer !== null) return;
    lastTickAt = Date.now();
    timer = setInterval(function () {
      const now = Date.now();
      const elapsedMs = now - lastTickAt;
      lastTickAt = now;
      if (elapsedMs >= 0) onTick(elapsedMs);
    }, VIDEO_REPORT_TICK_MS);
  }

  if (globals.Worker && globals.Blob && globals.URL &&
      typeof globals.URL.createObjectURL === "function") {
    try {
      const blob = new globals.Blob([videoReportWorkerSource()], { type: "application/javascript" });
      workerUrl = globals.URL.createObjectURL(blob);
      worker = new globals.Worker(workerUrl);
      worker.onmessage = function (event) {
        const data = event && event.data ? event.data : {};
        if (data && data.type === "tick" &&
            Number.isFinite(data.elapsedMs) && data.elapsedMs >= 0) {
          onTick(data.elapsedMs);
        }
      };
      worker.onerror = function () {
        if (worker) {
          try {
            if (typeof worker.terminate === "function") worker.terminate();
          } catch (_error) {
            // 忽略已失效的 worker。
          }
          worker = null;
        }
        startFallbackClock();
      };
      worker.postMessage({ type: "start" });
      return stop;
    } catch (_error) {
      if (workerUrl && globals.URL && typeof globals.URL.revokeObjectURL === "function") {
        try {
          globals.URL.revokeObjectURL(workerUrl);
        } catch (_cleanupError) {
          // 忽略已失效的 URL。
        }
      }
      workerUrl = null;
      worker = null;
    }
  }

  startFallbackClock();
  return stop;
}

async function sendVideoReportRequest(type, payload, context) {
  const target = context || activeContext;
  if (!target || typeof target.sendMessage !== "function") {
    return {
      isPassed: false,
      error: { code: "NO_CONTEXT", message: "AdapterContext.sendMessage 不可用" },
    };
  }
  try {
    const response = await target.sendMessage({
      type,
      requestId: createRequestId(),
      payload,
    });
    const data = backgroundResultData(response);
    return data && typeof data === "object" ? data : { isPassed: false };
  } catch (error) {
    return {
      isPassed: false,
      error: {
        code: "SEND_MESSAGE_FAILED",
        message: error && error.message ? String(error.message) : "发送后台请求失败",
      },
    };
  }
}

async function getVideoStatusWithContext(_input, context) {
  const input = _input || {};
  const payload = {
    origin: asString(input.origin),
    objectId: asString(input.objectId),
    fid: asString(input.fid),
    cacheBust: Date.now(),
  };
  if (!payload.origin || !payload.objectId || !payload.fid) {
    return {
      isPassed: false,
      error: { code: "INVALID_INPUT", message: "getVideoStatus 缺少 origin/objectId/fid" },
    };
  }
  return sendVideoReportRequest("CX_STATUS", payload, context);
}

export async function getVideoStatus(_input) {
  return getVideoStatusWithContext(_input, activeContext);
}

async function reportVideoWithContext(_input, context) {
  const input = _input || {};
  const playingTime = Number(input.playingTime);
  const duration = Number(input.duration);
  let enc = asString(input.enc);
  if (!enc) {
    const md5 = resolveVideoReportMd5(context);
    if (typeof md5 !== "function") {
      if (!videoReportMd5Warned) {
        videoReportMd5Warned = true;
        videoReportWarn(context, "缺少 MD5 实现，无法生成 enc 签名，本次上报不伪造并跳过。");
      }
      return { isPassed: false, error: { code: "NO_MD5", message: "缺少 MD5 实现" } };
    }
    enc = buildVideoReportEnc(md5, {
      clazzId: asString(input.clazzId),
      uid: asString(input.userid),
      jobId: asString(input.jobid),
      objectId: asString(input.objectId),
      playingTime,
      duration,
    });
  }
  const payload = {
    reportUrl: asString(input.reportUrl),
    dtoken: asString(input.dtoken),
    clazzId: asString(input.clazzId),
    playingTime,
    duration,
    objectId: asString(input.objectId),
    otherInfo: asString(input.otherInfo),
    jobid: asString(input.jobid),
    userid: asString(input.userid),
    isdrag: input.isdrag === 4 ? 4 : 0,
    enc,
    rt: asString(input.rt),
    timestamp: Date.now(),
  };
  const requiredFields = ["reportUrl", "dtoken", "clazzId", "objectId", "otherInfo", "jobid", "userid", "enc", "rt"];
  for (const field of requiredFields) {
    if (!payload[field]) {
      return {
        isPassed: false,
        error: { code: "INVALID_INPUT", message: `reportVideo 缺少 ${field}` },
      };
    }
  }
  if (!Number.isFinite(playingTime) || !Number.isFinite(duration)) {
    return {
      isPassed: false,
      error: { code: "INVALID_INPUT", message: "reportVideo playingTime/duration 必须是有限数字" },
    };
  }
  return sendVideoReportRequest("CX_REPORT", payload, context);
}

export async function reportVideo(_input) {
  return reportVideoWithContext(_input, activeContext);
}

function readVideoReportSettings(context) {
  const settings = asObject(context && context.settings) || {};
  const rawRate = Number(settings.videoSpeed);
  const rate = Number.isFinite(rawRate) && rawRate > 0
    ? Math.min(VIDEO_REPORT_MAX_RATE, Math.max(1, rawRate))
    : 3;
  const rawBase = Number(settings.cxReportBaseInterval);
  const baseIntervalSec = Number.isFinite(rawBase) && rawBase > 0
    ? rawBase
    : VIDEO_REPORT_DEFAULT_BASE_INTERVAL_SEC;
  const intervalSec = Math.max(VIDEO_REPORT_MIN_INTERVAL_SEC, Math.floor(baseIntervalSec / rate));
  const showProgress = settings.showProgress !== false;
  return { rate, intervalSec, showProgress };
}

// 视频模拟上报主流程；由任务队列对 video 任务点调用（TaskResult 形状），
// isPassed===true 后返回 { done: true } 继续下一个任务点。
export async function runVideoReportTask(task, defaults, ctx) {
  const context = ctx || activeContext;
  const startGeneration = activeGeneration;
  const settings = readVideoReportSettings(context);
  const doc = getContextDocument(context);

  const objectId = asString(taskValue(task, defaults, "objectId", "objectid", "objectID"));
  const clazzId = asString(taskValue(task, defaults, "clazzid", "clazzId", "classId"));
  const jobId = asString(taskValue(task, defaults, "jobid", "jobId", "jobID"));
  const otherInfo = asString(taskValue(task, defaults, "otherInfo", "otherinfo"));
  const rt = asString(taskValue(task, defaults, "rt"));
  const reportUrl = asString(taskValue(task, defaults, "reportUrl", "reporturl"));
  const origin = resolveOrigin(context);
  const fid = readCookieValue(doc, "fid");
  const uid = firstNonEmpty(readCookieValue(doc, "_uid"), readCookieValue(doc, "UID"));

  const missingFields = [];
  if (!objectId) missingFields.push("objectId");
  if (!clazzId) missingFields.push("clazzId");
  if (!jobId) missingFields.push("jobId");
  if (!otherInfo) missingFields.push("otherInfo");
  if (!rt) missingFields.push("rt");
  if (!reportUrl) missingFields.push("reportUrl");
  if (!origin) missingFields.push("origin");
  if (!fid) missingFields.push("cookie:fid");
  if (!uid) missingFields.push("cookie:_uid/UID");
  if (missingFields.length) {
    videoReportWarn(context, `学习通视频模拟上报缺少字段：${missingFields.join(", ")}，任务保留未完成。`);
    return { done: false, skipped: false, reason: "video-report-missing-fields" };
  }

  const md5 = resolveVideoReportMd5(context);
  if (typeof md5 !== "function") {
    if (!videoReportMd5Warned) {
      videoReportMd5Warned = true;
      videoReportWarn(context,
        "缺少 MD5 实现（ctx.md5/全局 md5/lib/md5.js 均不可用），不伪造 enc 签名，视频模拟上报终止。");
    }
    return { done: false, skipped: false, reason: "video-report-no-md5" };
  }

  const status = await getVideoStatusWithContext({ origin, objectId, fid }, context);
  if (status && status.isPassed === true) {
    return { done: true, skipped: true, reason: "passed" };
  }
  if (!status || typeof status !== "object" || status.error) {
    videoReportWarn(context, "学习通视频状态接口失败，无法开始模拟上报。");
    return { done: false, skipped: false, reason: "video-report-status-failed" };
  }

  const durationSec = Math.floor(toFiniteNonNegative(status.duration, 0));
  const dtoken = asString(status.dtoken);
  if (durationSec <= 0 || !dtoken) {
    videoReportWarn(context, "学习通视频状态接口缺少 duration/dtoken，无法开始模拟上报。");
    return { done: false, skipped: false, reason: "video-report-bad-status" };
  }

  if (videoReportRunActive) {
    return { done: false, skipped: false, reason: "video-report-busy" };
  }
  videoReportRunActive = true;

  const initialPlayingTime = Math.min(toFiniteNonNegative(status.playingTime, 0), durationSec);

  return new Promise((resolve) => {
    let currentTime = initialPlayingTime;
    let lastReportAt = initialPlayingTime;
    let consecutiveFailures = 0;
    let reporting = false;
    let finished = false;
    let lastTickWallAt = Date.now();

    function finish(result) {
      if (finished) return;
      finished = true;
      clearInterval(watchdog);
      clockStop();
      removeProgressOverlay();
      videoReportRunActive = false;
      resolve(result);
    }

    function handleTick(elapsedMs) {
      if (finished) return;
      if (activeGeneration !== startGeneration) {
        finish({ done: false, skipped: false, reason: "video-report-aborted" });
        return;
      }
      lastTickWallAt = Date.now();
      const increment = (Number(elapsedMs) / 1000) * settings.rate;
      currentTime = Math.min(currentTime + increment, durationSec);
      updateProgressOverlay((currentTime / durationSec) * 100);
      if (reporting) return;
      if (currentTime >= durationSec) {
        void runFinalReport();
        return;
      }
      if (currentTime - lastReportAt >= settings.intervalSec) {
        void runIntervalReport();
      }
    }

    async function runIntervalReport() {
      if (finished || reporting) return;
      reporting = true;
      const reportTime = Math.floor(currentTime);
      try {
        const data = await reportVideoWithContext({
          reportUrl,
          dtoken,
          clazzId,
          playingTime: reportTime,
          duration: durationSec,
          objectId,
          otherInfo,
          jobid: jobId,
          userid: uid,
          isdrag: 0,
          enc: buildVideoReportEnc(md5, {
            clazzId, uid, jobId, objectId,
            playingTime: reportTime,
            duration: durationSec,
          }),
          rt,
        }, context);
        if (finished) return;
        if (data && data.isPassed === true) {
          finish({ done: true, skipped: false });
          return;
        }
        if (data && data.error) {
          consecutiveFailures += 1;
          videoReportWarn(context,
            `学习通视频上报失败（连续 ${consecutiveFailures} 次）：${asString(data.error.message || data.error.code)}`);
        } else {
          consecutiveFailures = 0;
        }
        lastReportAt = reportTime;
        if (consecutiveFailures >= VIDEO_REPORT_MAX_CONSECUTIVE_FAILURES) {
          finish({ done: false, skipped: false, reason: "video-report-failed" });
        }
      } catch (error) {
        if (!finished) {
          finish({ done: false, skipped: false, reason: "video-report-failed" });
        }
      } finally {
        reporting = false;
      }
    }

    async function runFinalReport() {
      if (finished) return;
      reporting = true;
      updateProgressOverlay(100);
      const reportTime = durationSec;
      try {
        const data = await reportVideoWithContext({
          reportUrl,
          dtoken,
          clazzId,
          playingTime: reportTime,
          duration: durationSec,
          objectId,
          otherInfo,
          jobid: jobId,
          userid: uid,
          isdrag: 4,
          enc: buildVideoReportEnc(md5, {
            clazzId, uid, jobId, objectId,
            playingTime: reportTime,
            duration: durationSec,
          }),
          rt,
        }, context);
        if (finished) return;
        if (data && data.isPassed === true) {
          finish({ done: true, skipped: false });
          return;
        }
        if (data && data.error) {
          videoReportWarn(context,
            `学习通视频完成上报失败：${asString(data.error.message || data.error.code)}`);
        }
        finish({ done: false, skipped: false, reason: "video-report-not-passed" });
      } catch (error) {
        if (!finished) {
          finish({ done: false, skipped: false, reason: "video-report-failed" });
        }
      } finally {
        reporting = false;
      }
    }

    const clockStop = startVideoReportClock(context, handleTick);

    // 看门狗：时钟停摆或适配器销毁时终止挂起的上报循环。
    const watchdog = setInterval(function () {
      if (finished) return;
      if (activeGeneration !== startGeneration) {
        finish({ done: false, skipped: false, reason: "video-report-aborted" });
        return;
      }
      if (Date.now() - lastTickWallAt > 10000) {
        finish({ done: false, skipped: false, reason: "video-report-clock-stalled" });
      }
    }, 5000);

    ensureProgressOverlay(doc, settings.showProgress);
    updateProgressOverlay((currentTime / durationSec) * 100);
    handleTick(0);
  });
}

// ==== END SECTION: video-report ====

// ==== SECTION: video-play ====
const VIDEO_PLAY_STUB_REASON = "video-play-not-implemented";
const VIDEO_PLAY_POLL_INTERVAL_MS = 1500;
const VIDEO_PLAY_AUDIO_WAIT_MS = 5000;
const VIDEO_PLAY_DEFAULT_RATE = 3;
const VIDEO_PLAY_MIN_RATE = 1;
const VIDEO_PLAY_MAX_RATE = 8;

// ---- 学习通视频/音频任务：正常播放模式（spec/30c，降级/备用）----
// 任务点 iframe 内每 1.5s 轮询查找 video/audio 元素；找到后 pause → muted=true →
// playbackRate=rate（settings.videoSpeed，钳制 1–8，默认 3）→ play()；
// 监听 pause 事件自动恢复播放（ended 除外）；video 播放 ended → {done:true}；
// audio 找到后等待 5 秒直接标记完成。跨域 iframe、play() Promise 拒绝、
// 缺元素均安全处理；完成/中止/适配器销毁时清理全部定时器与监听。
// 本分区自包含实现，不依赖 content/video-manager.js 的加载顺序；
// 如需复用 globalThis.CourseHelperVideoManager，两套逻辑互不影响。

let videoPlayRunActive = false;

function clampVideoPlayRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return VIDEO_PLAY_DEFAULT_RATE;
  return Math.min(VIDEO_PLAY_MAX_RATE, Math.max(VIDEO_PLAY_MIN_RATE, rate));
}

function readVideoPlayRate(context) {
  const settings = asObject(context && context.settings) || {};
  return clampVideoPlayRate(settings.videoSpeed);
}

function videoPlayLog(context, message) {
  if (!context || typeof context.log !== "function") return;
  try {
    context.log(`[course-helper] ${message}`);
  } catch (_error) {
    // 日志失败不影响播放流程。
  }
}

function mediaTagName(media) {
  try {
    return String(media && (media.tagName || media.nodeName) || "").toLowerCase();
  } catch (_error) {
    return "";
  }
}

function collectPlayDocuments(roots, documents, seen) {
  for (const root of roots) {
    if (!root) continue;
    let documentLike = root;
    try {
      if (root.contentDocument) documentLike = root.contentDocument;
      else if (root.contentWindow && root.contentWindow.document) documentLike = root.contentWindow.document;
    } catch (_error) {
      continue; // 跨域 iframe：contentDocument 读取失败，安全跳过。
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
    collectPlayDocuments(frameList, documents, seen);
  }
}

function queryPlayMedia(documentLike) {
  let list = null;
  try {
    list = documentLike.querySelectorAll("video, audio");
  } catch (_error) {
    list = null;
  }
  if (list && typeof list.length === "number") {
    const combined = Array.from(list);
    if (combined.length) return combined;
  }
  const result = [];
  for (const tag of ["video", "audio"]) {
    let perTag = null;
    try {
      perTag = documentLike.querySelectorAll(tag);
    } catch (_error) {
      perTag = null;
    }
    if (perTag && typeof perTag.length === "number") {
      for (const media of Array.from(perTag)) {
        if (result.indexOf(media) === -1) result.push(media);
      }
    }
  }
  return result;
}

function collectPlayMedia(task, context, preferredKind) {
  const roots = [];
  const pushRoot = (root) => {
    if (root && roots.indexOf(root) === -1) roots.push(root);
  };
  try { pushRoot(task && task.iframe); } catch (_error) { /* 已分离的 DOM 安全忽略。 */ }
  try { pushRoot(task && task.container); } catch (_error) { /* 已分离的 DOM 安全忽略。 */ }
  try { pushRoot(task && task.element); } catch (_error) { /* 已分离的 DOM 安全忽略。 */ }
  try { pushRoot(task && task.document); } catch (_error) { /* 已分离的 DOM 安全忽略。 */ }
  pushRoot(getContextDocument(context));

  const documents = [];
  const seen = [];
  collectPlayDocuments(roots, documents, seen);

  const preferred = [];
  const others = [];
  for (const documentLike of documents) {
    for (const media of queryPlayMedia(documentLike)) {
      const tag = mediaTagName(media);
      if (tag === preferredKind) {
        if (preferred.indexOf(media) === -1) preferred.push(media);
      } else if (others.indexOf(media) === -1) {
        others.push(media);
      }
    }
  }

  const entries = [];
  for (const media of preferred) entries.push({ media, kind: preferredKind });
  for (const media of others) {
    if (entries.every((entry) => entry.media !== media)) {
      entries.push({ media, kind: mediaTagName(media) === "audio" ? "audio" : "video" });
    }
  }
  return entries;
}

function attachPlayListener(target, eventName, handler, cleanups) {
  if (!target) return;
  try {
    if (typeof target.addEventListener === "function") {
      target.addEventListener(eventName, handler);
      cleanups.push(() => {
        try {
          if (typeof target.removeEventListener === "function") target.removeEventListener(eventName, handler);
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

export async function runVideoPlayTask(task, _defaults, ctx) {
  const context = ctx || activeContext;
  const startGeneration = activeGeneration;
  const kind = taskModule(task) === "audio" ? "audio" : "video";
  const rate = readVideoPlayRate(context);

  if (videoPlayRunActive) {
    return { done: false, skipped: false, reason: "video-play-busy" };
  }
  videoPlayRunActive = true;

  return new Promise((resolve) => {
    let finished = false;
    let pollTimer = null;
    const states = [];

    function teardownPlayState(state) {
      if (state.resumeTimer !== null) {
        clearTimeout(state.resumeTimer);
        state.resumeTimer = null;
      }
      if (state.audioTimer !== null) {
        clearTimeout(state.audioTimer);
        state.audioTimer = null;
      }
      for (const cleanup of state.cleanups) {
        try { cleanup(); } catch (_error) { /* 清理异常不阻塞其他清理。 */ }
      }
      state.cleanups.length = 0;
    }

    function finish(result) {
      if (finished) return;
      finished = true;
      videoPlayRunActive = false;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      for (const state of states) teardownPlayState(state);
      states.length = 0;
      resolve(result);
    }

    function mediaEnded(state) {
      try {
        return state.media.ended === true;
      } catch (_error) {
        return false;
      }
    }

    function complete(state, reason) {
      if (finished || state.completed) return;
      state.completed = true;
      videoPlayLog(context, `学习通播放任务完成（${reason}）。`);
      finish({ done: true, skipped: false });
    }

    function scheduleAudioCompletion(state) {
      if (finished || state.completed || state.audioTimer !== null) return;
      state.audioTimer = setTimeout(() => {
        state.audioTimer = null;
        if (!finished && !state.completed) complete(state, "audio-wait");
      }, VIDEO_PLAY_AUDIO_WAIT_MS);
    }

    function prepareAndPlay(state) {
      if (finished || state.completed) return;
      if (mediaEnded(state)) {
        if (state.kind === "audio") scheduleAudioCompletion(state);
        else complete(state, "ended");
        return;
      }

      state.suppressPause = true;
      try {
        if (typeof state.media.pause === "function") state.media.pause();
      } catch (_error) {
        // pause() 可能被页面脚本或只读对象拒绝。
      }
      state.suppressPause = false;

      try { state.media.muted = true; } catch (_error) { /* 只读媒体对象安全跳过。 */ }
      try { state.media.playbackRate = rate; } catch (_error) { /* 只读媒体对象安全跳过。 */ }

      try {
        if (typeof state.media.play === "function") {
          const playResult = state.media.play();
          if (playResult && typeof playResult.catch === "function") {
            playResult.catch(() => {});
          } else if (playResult && typeof playResult.then === "function") {
            playResult.then(() => {}, () => {});
          }
        }
      } catch (_error) {
        // play() 同步抛错或返回拒绝的 Promise 均安全忽略，下一轮轮询会重试。
      }
      state.started = true;

      if (state.kind === "audio") scheduleAudioCompletion(state);
    }

    function handlePause(state) {
      if (finished || state.completed || state.suppressPause) return;
      if (mediaEnded(state)) return; // ended 由 ended 事件/轮询处理，不自动恢复。
      if (state.resumeTimer !== null) return;
      state.resumeTimer = setTimeout(() => {
        state.resumeTimer = null;
        if (!finished && !state.completed) prepareAndPlay(state);
      }, 0);
    }

    function handleEnded(state) {
      if (finished || state.completed) return;
      if (state.kind === "audio") return; // 音频任务按 5 秒计时完成，与 ended 无关。
      complete(state, "ended");
    }

    function createPlayState(entry) {
      const state = {
        media: entry.media,
        kind: entry.kind,
        completed: false,
        started: false,
        suppressPause: false,
        resumeTimer: null,
        audioTimer: null,
        cleanups: [],
      };
      attachPlayListener(state.media, "pause", () => handlePause(state), state.cleanups);
      attachPlayListener(state.media, "ended", () => handleEnded(state), state.cleanups);
      states.push(state);
      return state;
    }

    function poll() {
      if (finished) return;
      if (activeGeneration !== startGeneration) {
        finish({ done: false, skipped: false, reason: "video-play-aborted" });
        return;
      }
      const entries = collectPlayMedia(task, context, kind);
      for (const entry of entries) {
        let state = null;
        for (const existing of states) {
          if (existing.media === entry.media) {
            state = existing;
            break;
          }
        }
        if (!state) state = createPlayState(entry);
        prepareAndPlay(state);
      }
    }

    pollTimer = setInterval(poll, VIDEO_PLAY_POLL_INTERVAL_MS);
    poll();
  });
}

// ==== END SECTION: video-play ====

// ==== SECTION: quiz-pc ====
const WORK_EXAM_STUB_REASON = "pc-quiz-not-implemented";

// ---- 学习通 PC 测验求解（spec/30d-quiz-pc）----
// 状态文本 .newTestCon .newTestTitle .testTit_status：
//   含"已完成"/"已交"/"待批阅"跳过（quiz-finished），含"待做"/"待完成"（及未知状态）继续。
// 题目容器 .CeYan 内 .TiMu 每题：题干 .Zy_TItle.clearfix > div（题型从【单选题】等前缀提取），
//   选项 .Zy_ulTop li a（"A." 前缀由 quiz-solver 清洗，点击目标为 a 的父级 li），
//   判断题选项 li 内含 span[val-param=true|false]；
//   填空 textarea 在 .Zy_ulTk .XztiHover1 / .stem_answer .Answer .divText .textDIV / .subEditor 下，
//     存在对应 UE 编辑器时经 MAIN world set-editor 桥接调用 UE.getEditor(id).setContent；
//   简答 textarea[name^="answerEditor"] / .eidtDiv textarea，UE 优先。
// 已答检测：选择/判断看 li 的 aria-label，填空/简答看 textarea 值，已答跳过。
// 答案复用 quiz-solver.js 的 solveQuestions 逐题顺序获取（缓存命中 → DeepSeek，失败跳过本题不阻塞队列）。
// 提交 .ZY_sub .btnSubmit + 确认 #confirmSubWin > div > div > a.bluebtn；
//   自动提交关闭（chrome.storage.local.autoSubmit === false，默认 true）时改用 .ZY_sub .btnSave 保存。

const PC_QUIZ_FINISHED_MARKERS = ["已完成", "已交", "待批阅"];
const PC_QUIZ_TYPE_RE = /【\s*(单项选择题?|多项选择题?|单选题?|多选题?|填空题?|判断题?|简答题?|问答题?)\s*】/;
const PC_QUIZ_TYPE_MAP = Object.freeze({
  单选: 0, 单选题: 0, 单项选择: 0, 单项选择题: 0,
  多选: 1, 多选题: 1, 多项选择: 1, 多项选择题: 1,
  填空: 2, 填空题: 2,
  判断: 3, 判断题: 3,
  简答: 4, 简答题: 4, 问答: 4, 问答题: 4,
});
const PC_QUIZ_UE_EDITOR_RE = /UE\s*\.\s*getEditor\s*\(\s*["']([^"']+)["']/g;
const PC_QUIZ_BLANK_CONTAINER_SELECTORS = [
  ".Zy_ulTk .XztiHover1",
  ".stem_answer .Answer .divText .textDIV",
  ".subEditor",
];
const PC_QUIZ_CONFIRM_POLL_MS = 200;
const PC_QUIZ_CONFIRM_TIMEOUT_MS = 5000;
const PC_QUIZ_LOAD_POLL_MS = 500;
const PC_QUIZ_LOAD_TIMEOUT_MS = 5000;

function pcQuizWarn(context, message) {
  if (context && typeof context.log === "function") {
    try {
      context.log(`[course-helper] ${message}`);
    } catch (_error) {
      // 日志失败不影响答题流程。
    }
    return;
  }
  const view = getContextWindow(context);
  if (view && view.console && typeof view.console.warn === "function") {
    try {
      view.console.warn(`[course-helper] ${message}`);
    } catch (_error) {
      // 控制台被页面替换时不能阻塞答题流程。
    }
  }
}

function readPcQuizStatus(doc) {
  const node = safeQuery(doc, SELECTORS.pcQuizStatus);
  if (!node) return "";
  return asString(node.textContent).replace(/\s+/g, "");
}

function extractPcQuizQuestionType(stemHtml) {
  const match = PC_QUIZ_TYPE_RE.exec(asString(stemHtml));
  if (!match) return null;
  const mapped = PC_QUIZ_TYPE_MAP[match[1]];
  return mapped === undefined ? null : mapped;
}

function pcQuizUniqueNodes(nodes) {
  const unique = [];
  for (const node of nodes) {
    if (node && unique.indexOf(node) === -1) unique.push(node);
  }
  return unique;
}

function pcQuizOptionEntry(link) {
  let html = asString(link.innerHTML);
  if (!html.replace(/<[^>]*>/g, "").trim()) {
    // 判断题等选项文本可能只存在于 span[val-param=true|false] 属性上。
    const li = link && link.parentElement;
    const paramSpan = li && typeof li.querySelector === "function"
      ? li.querySelector("span[val-param]")
      : null;
    const param = paramSpan && typeof paramSpan.getAttribute === "function"
      ? paramSpan.getAttribute("val-param")
      : "";
    if (param) html = param;
  }
  return { html, element: link && link.parentElement ? link.parentElement : null };
}

function readPcQuizOptions(node) {
  const options = [];
  for (const link of safeQueryAll(node, ".Zy_ulTop li a")) {
    options.push(pcQuizOptionEntry(link));
  }
  return options;
}

function pcQuizChoiceAnswered(optionEntries) {
  for (const entry of optionEntries) {
    const li = entry && entry.element;
    let label = "";
    try {
      label = li && typeof li.getAttribute === "function" ? li.getAttribute("aria-label") || "" : "";
    } catch (_error) {
      label = "";
    }
    if (asString(label).trim()) return true;
  }
  return false;
}

function pcQuizInputsAnswered(inputs) {
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

function readPcQuizBlankInputs(node) {
  const containers = [];
  for (const selector of PC_QUIZ_BLANK_CONTAINER_SELECTORS) {
    for (const container of safeQueryAll(node, selector)) containers.push(container);
  }
  const inputs = [];
  for (const container of pcQuizUniqueNodes(containers)) {
    const tag = String(container.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input") {
      inputs.push(container);
      continue;
    }
    for (const element of safeQueryAll(container, "textarea")) inputs.push(element);
    for (const element of safeQueryAll(container, 'input[type="text"]')) inputs.push(element);
  }
  return pcQuizUniqueNodes(inputs);
}

function readPcQuizEssayInputs(node) {
  const inputs = [];
  for (const element of safeQueryAll(node, 'textarea[name^="answerEditor"]')) inputs.push(element);
  for (const element of safeQueryAll(node, ".eidtDiv textarea")) inputs.push(element);
  return pcQuizUniqueNodes(inputs);
}

function readPcQuizUeEditorIds(node) {
  const ids = [];
  for (const script of safeQueryAll(node, "script")) {
    const source = asString(script.textContent);
    PC_QUIZ_UE_EDITOR_RE.lastIndex = 0;
    let match;
    while ((match = PC_QUIZ_UE_EDITOR_RE.exec(source)) !== null) {
      if (ids.indexOf(match[1]) === -1) ids.push(match[1]);
    }
  }
  return ids;
}

function buildPcQuizQuestion(node) {
  const title = safeQuery(node, ".Zy_TItle.clearfix > div") || safeQuery(node, ".Zy_TItle.clearfix");
  const stemHtml = title ? asString(title.innerHTML) : "";
  if (!stemHtml.replace(/<[^>]*>/g, "").trim()) return null;
  const qtype = extractPcQuizQuestionType(stemHtml);
  if (qtype === null) return null;

  if (qtype === 0 || qtype === 1 || qtype === 3) {
    const options = readPcQuizOptions(node);
    if (!options.length) return null;
    return {
      qtype,
      stem: stemHtml,
      options,
      isAnswered: () => pcQuizChoiceAnswered(options),
    };
  }

  const editorIds = readPcQuizUeEditorIds(node);
  const inputs = qtype === 2 ? readPcQuizBlankInputs(node) : readPcQuizEssayInputs(node);
  if (editorIds.length) {
    // UE 编辑器优先（经 MAIN world set-editor 桥接写入）；
    // 已答检测仍按题内 textarea 值尽力判断（UE 内容无法从 isolated world 读取）。
    const textareas = safeQueryAll(node, "textarea");
    return {
      qtype,
      stem: stemHtml,
      editorIds,
      isAnswered: () => pcQuizInputsAnswered(textareas),
    };
  }
  if (!inputs.length) return null;
  return {
    qtype,
    stem: stemHtml,
    inputs,
    isAnswered: () => pcQuizInputsAnswered(inputs),
  };
}

function extractPcQuizQuestions(doc) {
  const questions = [];
  let ignored = 0;
  for (const node of safeQueryAll(doc, SELECTORS.pcQuizQuestion)) {
    const question = buildPcQuizQuestion(node);
    if (question) questions.push(question);
    else ignored += 1;
  }
  return { questions, ignored };
}

async function waitForPcQuizQuestions(doc) {
  const startedAt = Date.now();
  let extracted = extractPcQuizQuestions(doc);
  while (!extracted.questions.length && Date.now() - startedAt < PC_QUIZ_LOAD_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, PC_QUIZ_LOAD_POLL_MS));
    extracted = extractPcQuizQuestions(doc);
  }
  return extracted;
}

function resolvePcQuizSolver(context) {
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

function readPcQuizStoredSettings(keys) {
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

async function readPcQuizAutoSubmit(context) {
  const settings = asObject(context && context.settings) || {};
  if (typeof settings.autoSubmit === "boolean") return settings.autoSubmit;
  const stored = await readPcQuizStoredSettings(["autoSubmit"]);
  if (stored && typeof stored.autoSubmit === "boolean") return stored.autoSubmit;
  return true; // 默认开启自动提交
}

function waitForPcQuizConfirm(doc) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    function pollConfirm() {
      const confirmLink =
        safeQuery(doc, "#confirmSubWin > div > div > a.bluebtn") ||
        safeQuery(doc, "#confirmSubWin a.bluebtn");
      if (confirmLink && typeof confirmLink.click === "function") {
        try {
          confirmLink.click();
        } catch (_error) {
          // 确认按钮点击异常时仍视为已确认（按钮已出现说明提交流程已进入确认阶段）。
        }
        resolve(true);
        return;
      }
      // 部分课程无确认弹窗：状态文本变为已完成/已交/待批阅视为提交成功。
      const statusText = readPcQuizStatus(doc);
      if (PC_QUIZ_FINISHED_MARKERS.some((marker) => statusText.indexOf(marker) !== -1)) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= PC_QUIZ_CONFIRM_TIMEOUT_MS) {
        resolve(false);
        return;
      }
      setTimeout(pollConfirm, PC_QUIZ_CONFIRM_POLL_MS);
    }
    pollConfirm();
  });
}

async function submitPcQuiz(doc, context) {
  const submitButton = safeQuery(doc, ".ZY_sub .btnSubmit");
  if (!submitButton || typeof submitButton.click !== "function") {
    pcQuizWarn(context, "学习通 PC 测验提交按钮 .ZY_sub .btnSubmit 不存在，无法提交。");
    return false;
  }
  try {
    submitButton.click();
  } catch (_error) {
    pcQuizWarn(context, "学习通 PC 测验提交按钮点击失败。");
    return false;
  }
  return waitForPcQuizConfirm(doc);
}

function savePcQuiz(doc) {
  const saveButton = safeQuery(doc, ".ZY_sub .btnSave");
  if (!saveButton || typeof saveButton.click !== "function") return false;
  try {
    saveButton.click();
    return true;
  } catch (_error) {
    return false;
  }
}

export async function solvePcQuiz(doc, ctx) {
  const targetDoc = doc || getContextDocument(ctx || activeContext);
  const context = ctx || activeContext;
  if (!targetDoc || typeof targetDoc.querySelectorAll !== "function") {
    return { done: false, skipped: false, reason: "quiz-document-unavailable" };
  }

  // 状态文本：已完成/已交/待批阅 → 跳过；"待做"/"待完成"及未知状态继续尝试。
  const statusText = readPcQuizStatus(targetDoc);
  if (PC_QUIZ_FINISHED_MARKERS.some((marker) => statusText.indexOf(marker) !== -1)) {
    return { done: true, skipped: true, reason: "quiz-finished" };
  }

  const solver = resolvePcQuizSolver(context);
  if (!solver || typeof solver.solveQuestions !== "function") {
    pcQuizWarn(context,
      "quiz-solver 不可用（globalThis.CourseHelperQuizSolver 与 require(\"../quiz-solver.js\") 均失败），PC 测验任务保留未完成。");
    return { done: false, skipped: false, reason: "quiz-solver-unavailable" };
  }

  const extracted = await waitForPcQuizQuestions(targetDoc);
  if (extracted.ignored > 0) {
    pcQuizWarn(context,
      `学习通 PC 测验有 ${extracted.ignored} 道题无法解析（缺少题干/题型/选项/输入框），已跳过。`);
  }
  if (!extracted.questions.length) {
    return { done: false, skipped: false, reason: "quiz-no-questions" };
  }

  const autoSubmit = await readPcQuizAutoSubmit(context);
  const summary = await solver.solveQuestions(extracted.questions, context, {
    submit: () => submitPcQuiz(targetDoc, context),
    autoSubmit,
  });

  const allAnswered =
    summary.total > 0 &&
    summary.results.length === summary.total &&
    summary.results.every((result) => result && result.reason === "already-answered");

  if (summary.submitted === true) {
    return { done: true, skipped: false };
  }

  if (summary.solved > 0 || allAnswered) {
    if (autoSubmit) {
      const submitResult = await submitPcQuiz(targetDoc, context);
      if (!submitResult) {
        return { done: false, skipped: false, reason: "quiz-submit-failed" };
      }
      return { done: true, skipped: false };
    }
    // 自动提交关闭：保存草稿后视为本任务点完成。
    if (savePcQuiz(targetDoc)) {
      return { done: true, skipped: false };
    }
    return { done: false, skipped: false, reason: "quiz-save-failed" };
  }

  return { done: false, skipped: false, reason: "no-question-solved" };
}

// ==== END SECTION: quiz-pc ====

// ==== SECTION: quiz-phone ====
// ---- 学习通手机版测验/作业/考试求解（spec/30e）----
// solvePhoneWorkExam 按页面结构自动分流三种场景：
//   A. 手机版测验：iframe 导航到 /work/phone/work 后处理，容器 .zquestions .Py-mian1；
//      题干 .Py-m1-title，题型从 [..题] 前缀提取（单选/多选/判断/填空/简答 → qtype 0–4）；
//      选项 .answerList.singleChoice / .answerList.multiChoice / .answerList.panduan 的 li
//      （判断题看 li 的 val-param 属性）；填空 .blankList2 input 或 [data-editorindex]
//      （编辑器经 MAIN world course-helper:main:set-mobile-editor 桥接写入
//      contextWindow.editors[idx].ueditor.setContent()，payload {index,content,itemId?}，
//      由桥接层同时写隐藏 input #answer{itemId}）；简答 textarea[name^="answer"]；
//      提交 .zquestions .zsubmit .btn-ok-bottom，确认 #okBtn。
//   B. 作业页 /mooc2/work/dowork：容器 .mark_table form .questionLi，题干 .mark_name，
//      选项 .stem_answer .answer_p（点击父级），填空 .stem_answer .Answer .divText .textDIV textarea，
//      简答 .stem_answer .eidtDiv textarea；提交按钮 spec 未给出，按通用探测依次回退
//      （.mark_table form 内 type=submit / .btnSubmit / .ZY_sub .btnSubmit，需在真实页面核对）。
//   C. 考试页 /exam/test/reVersionTestStartNew：容器 .mark_table .whiteDiv，题干 h3.mark_name，
//      选项 .clearfix.answerBg .fl.answer_p（点击父级），填空 .Answer .divText .subEditor textarea；
//      下一题按钮 a.jb_btn（可选自动跳转：答完当前题后若存在则点击，没有则忽略）。
// 答案统一复用 quiz-solver.js 的 solveQuestions（缓存命中 → DeepSeek，失败跳过本题不阻塞队列）；
// autoSubmit 读取顺序与 quiz-pc 分区一致：ctx.settings.autoSubmit →
// chrome.storage.local.autoSubmit → 默认 true。
// 状态判定：任一场景的"已完成/已交/待批阅"状态文本（若该页面存在状态节点）→
//   {done:true, skipped:true, reason:"quiz-finished"}；提交失败 → {done:false, reason:"quiz-submit-failed"}。
// 场景 B/C 的具体实现在 work-exam 分区，入口在本分区按结构分流调用。

const PHONE_QUIZ_QUESTION_SELECTOR = ".zquestions .Py-mian1";
const WORK_QUESTION_SELECTOR = ".mark_table form .questionLi";
const EXAM_QUESTION_SELECTOR = ".mark_table .whiteDiv";
const PHONE_QUIZ_FINISHED_MARKERS = ["已完成", "已交", "待批阅"];
const PHONE_QUIZ_TYPE_RE = /[【\[]\s*(单项选择题?|多项选择题?|单选题?|多选题?|填空题?|判断题?|简答题?|问答题?)\s*[】\]]/;
const PHONE_QUIZ_TYPE_MAP = Object.freeze({
  单选: 0, 单选题: 0, 单项选择: 0, 单项选择题: 0,
  多选: 1, 多选题: 1, 多项选择: 1, 多项选择题: 1,
  填空: 2, 填空题: 2,
  判断: 3, 判断题: 3,
  简答: 4, 简答题: 4, 问答: 4, 问答题: 4,
});
const PHONE_QUIZ_OPTION_SELECTORS = Object.freeze({
  0: ".answerList.singleChoice li",
  1: ".answerList.multiChoice li",
  3: ".answerList.panduan li",
});
const PHONE_QUIZ_LOAD_POLL_MS = 500;
const PHONE_QUIZ_LOAD_TIMEOUT_MS = 5000;
const PHONE_QUIZ_CONFIRM_POLL_MS = 200;
const PHONE_QUIZ_CONFIRM_TIMEOUT_MS = 5000;

// ---- 三个场景共用的通用辅助（work-exam 分区直接复用）----
function quizWarn(context, message) {
  if (context && typeof context.log === "function") {
    try {
      context.log(`[course-helper] ${message}`);
    } catch (_error) {
      // 日志失败不影响答题流程。
    }
    return;
  }
  const view = getContextWindow(context);
  if (view && view.console && typeof view.console.warn === "function") {
    try {
      view.console.warn(`[course-helper] ${message}`);
    } catch (_error) {
      // 控制台被页面替换时不能阻塞答题流程。
    }
  }
}

function stripTagsHtml(html) {
  return asString(html).replace(/<[^>]*>/g, "").trim();
}

function delayMs(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function quizInputsAnswered(inputs) {
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

function quizAllAnswered(summary) {
  return Boolean(
    summary &&
    summary.total > 0 &&
    Array.isArray(summary.results) &&
    summary.results.length === summary.total &&
    summary.results.every((result) => result && result.reason === "already-answered"),
  );
}

// quiz-solver 三级解析：contextWindow.CourseHelperQuizSolver → globalThis → require("../quiz-solver.js")。
function resolveQuizSolver(context) {
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

function readQuizStoredSettings(keys) {
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

async function readQuizAutoSubmit(context) {
  const settings = asObject(context && context.settings) || {};
  if (typeof settings.autoSubmit === "boolean") return settings.autoSubmit;
  const stored = await readQuizStoredSettings(["autoSubmit"]);
  if (stored && typeof stored.autoSubmit === "boolean") return stored.autoSubmit;
  return true; // 默认开启自动提交
}

// 目标文档路径名：优先 doc.location（iframe 文档时为 iframe URL），回退 ctx.location。
function getDocumentPathname(doc, context) {
  let location = null;
  try {
    location = doc && doc.location ? doc.location : null;
  } catch (_error) {
    location = null;
  }
  if (location) {
    const path = normalizePathname(getPathname(location));
    if (path) return path;
  }
  const contextLocation = context && context.location;
  if (contextLocation) return normalizePathname(getPathname(contextLocation));
  return "";
}

// 手机版测验文档定位：doc 自身含题目容器则直接用；否则遍历同域 iframe
// （任务列表页 /work/phone/doHomeWork 的测验在 iframe 内，导航到 /work/phone/work）。
// 跨域 iframe 的 contentDocument 读取会抛错，安全跳过。
function findPhoneQuizDocument(doc) {
  if (!doc || typeof doc.querySelector !== "function") return null;
  if (safeQuery(doc, PHONE_QUIZ_QUESTION_SELECTOR)) return doc;
  for (const frame of safeQueryAll(doc, "iframe, frame")) {
    let frameDoc = null;
    try {
      frameDoc = frame.contentDocument;
    } catch (_error) {
      frameDoc = null;
    }
    if (frameDoc && typeof frameDoc.querySelector === "function" &&
        safeQuery(frameDoc, PHONE_QUIZ_QUESTION_SELECTOR)) {
      return frameDoc;
    }
  }
  return null;
}

// ---- 场景 A：手机版测验（spec/30e，iframe 导航到 /work/phone/work 后处理）----
function extractPhoneQuizQuestionType(stemHtml) {
  const match = PHONE_QUIZ_TYPE_RE.exec(asString(stemHtml));
  if (!match) return null;
  const mapped = PHONE_QUIZ_TYPE_MAP[match[1]];
  return mapped === undefined ? null : mapped;
}

function phoneQuizUniqueNodes(nodes) {
  const unique = [];
  for (const node of nodes) {
    if (node && unique.indexOf(node) === -1) unique.push(node);
  }
  return unique;
}

function phoneQuizOptionEntry(li) {
  let html = asString(li.innerHTML);
  if (!stripTagsHtml(html)) {
    // 判断题等选项文本可能只存在于 li 的 val-param 属性上（val-param=true|false）。
    const param = li && typeof li.getAttribute === "function"
      ? asString(li.getAttribute("val-param"))
      : "";
    if (param) html = param;
  }
  if (!stripTagsHtml(html)) {
    // 再回退到 li 内带 val-param 的子元素。
    const paramNode = li && typeof li.querySelector === "function"
      ? li.querySelector("[val-param]")
      : null;
    const param = paramNode && typeof paramNode.getAttribute === "function"
      ? asString(paramNode.getAttribute("val-param"))
      : "";
    if (param) html = param;
  }
  return { html, element: li };
}

function readPhoneQuizOptions(node, qtype) {
  const selector = PHONE_QUIZ_OPTION_SELECTORS[qtype];
  const lists = [];
  if (selector) {
    for (const li of safeQueryAll(node, selector)) lists.push(li);
  }
  if (!lists.length) {
    // 题型列表 class 漂移兜底：全量收集三个题型列表（节点去重）。
    for (const type of [0, 1, 3]) {
      for (const li of safeQueryAll(node, PHONE_QUIZ_OPTION_SELECTORS[type])) lists.push(li);
    }
  }
  const options = [];
  for (const li of phoneQuizUniqueNodes(lists)) {
    options.push(phoneQuizOptionEntry(li));
  }
  return options;
}

// 已答检测：选择题看 li 的 aria-label（参考 quiz-pc 分区做法）。
function phoneQuizChoiceAnswered(optionEntries) {
  for (const entry of optionEntries) {
    const li = entry && entry.element;
    let label = "";
    try {
      label = li && typeof li.getAttribute === "function" ? li.getAttribute("aria-label") || "" : "";
    } catch (_error) {
      label = "";
    }
    if (asString(label).trim()) return true;
  }
  return false;
}

function readPhoneQuizBlankInputs(node) {
  const inputs = [];
  for (const element of safeQueryAll(node, ".blankList2 input")) {
    // 隐藏 input（如编辑器场景的 #answer{itemId}）不作为普通填空输入框。
    const type = asString(element.type).toLowerCase();
    if (type === "hidden") continue;
    inputs.push(element);
  }
  return phoneQuizUniqueNodes(inputs);
}

function readPhoneQuizEditorIndexes(node) {
  const indexes = [];
  for (const element of safeQueryAll(node, "[data-editorindex]")) {
    const index = Number(asString(element.getAttribute("data-editorindex")));
    if (Number.isInteger(index) && index >= 0 && indexes.indexOf(index) === -1) {
      indexes.push(index);
    }
  }
  return indexes;
}

function readPhoneQuizItemId(node) {
  // MAIN world set-mobile-editor 桥接的 payload.itemId 取自题内隐藏 input #answer{itemId}
  // 的 id（去掉 answer 前缀）；页面无该 input 时不传 itemId（桥接层只 setContent）。
  const answerInput = safeQuery(node, 'input[id^="answer"]');
  if (!answerInput) return "";
  const id = asString(answerInput.id);
  if (id.length > "answer".length && id.slice(0, "answer".length) === "answer") {
    return id.slice("answer".length);
  }
  return "";
}

function readPhoneQuizEssayInputs(node) {
  const inputs = [];
  for (const element of safeQueryAll(node, 'textarea[name^="answer"]')) inputs.push(element);
  return phoneQuizUniqueNodes(inputs);
}

function buildPhoneQuizQuestion(node) {
  const title = safeQuery(node, ".Py-m1-title");
  const stemHtml = title ? asString(title.innerHTML) : "";
  if (!stripTagsHtml(stemHtml)) return null;
  const qtype = extractPhoneQuizQuestionType(stemHtml);
  if (qtype === null) return null;

  if (qtype === 0 || qtype === 1 || qtype === 3) {
    const options = readPhoneQuizOptions(node, qtype);
    if (!options.length) return null;
    return {
      qtype,
      stem: stemHtml,
      options,
      isAnswered: () => phoneQuizChoiceAnswered(options),
    };
  }

  const editorIndexes = readPhoneQuizEditorIndexes(node);
  if (qtype === 2 && editorIndexes.length) {
    // 手机版填空题编辑器：contextWindow.editors[idx].ueditor.setContent() 经 MAIN world
    // course-helper:main:set-mobile-editor 桥接写入（payload {index,content,itemId?}），
    // 同时由桥接层写隐藏 input #answer{itemId}；content 侧不直接触碰页面全局。
    // 已答检测仍按题内 input/textarea 值尽力判断（编辑器内容无法从 isolated world 读取）。
    const itemId = readPhoneQuizItemId(node) || undefined;
    const editorIds = editorIndexes.map((index) => ({ mobileEditorIndex: index, itemId }));
    const checkNodes = safeQueryAll(node, "input, textarea");
    return {
      qtype,
      stem: stemHtml,
      editorIds,
      isAnswered: () => quizInputsAnswered(checkNodes),
    };
  }

  const inputs = qtype === 2
    ? readPhoneQuizBlankInputs(node)
    : readPhoneQuizEssayInputs(node);
  if (!inputs.length) return null;
  return {
    qtype,
    stem: stemHtml,
    inputs,
    isAnswered: () => quizInputsAnswered(inputs),
  };
}

function extractPhoneQuizQuestions(doc) {
  const questions = [];
  let ignored = 0;
  for (const node of safeQueryAll(doc, PHONE_QUIZ_QUESTION_SELECTOR)) {
    const question = buildPhoneQuizQuestion(node);
    if (question) questions.push(question);
    else ignored += 1;
  }
  return { questions, ignored };
}

async function waitForPhoneQuizQuestions(doc) {
  const startedAt = Date.now();
  let extracted = extractPhoneQuizQuestions(doc);
  while (!extracted.questions.length && Date.now() - startedAt < PHONE_QUIZ_LOAD_TIMEOUT_MS) {
    await delayMs(PHONE_QUIZ_LOAD_POLL_MS);
    extracted = extractPhoneQuizQuestions(doc);
  }
  return extracted;
}

// 手机版状态节点选择器 spec/30e 未给出，需在真实页面核对：
// 现读 .zquestions 区域整体文本，仅在题目容器不存在时参与完成判定（避免题干含标记词误判）。
function readPhoneQuizStatus(doc) {
  const zone = safeQuery(doc, ".zquestions");
  return zone ? asString(zone.textContent).replace(/\s+/g, "") : "";
}

function phoneQuizFinished(doc) {
  if (safeQuery(doc, PHONE_QUIZ_QUESTION_SELECTOR)) return false;
  const statusText = readPhoneQuizStatus(doc);
  return PHONE_QUIZ_FINISHED_MARKERS.some((marker) => statusText.indexOf(marker) !== -1);
}

function waitForPhoneQuizConfirm(doc) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    function pollConfirm() {
      const confirmButton = safeQuery(doc, "#okBtn");
      if (confirmButton && typeof confirmButton.click === "function") {
        try {
          confirmButton.click();
        } catch (_error) {
          // 确认按钮点击异常时仍视为已确认（按钮已出现说明提交流程已进入确认阶段）。
        }
        resolve(true);
        return;
      }
      // 无确认弹窗：状态文本变为已完成/已交/待批阅视为提交成功。
      if (phoneQuizFinished(doc)) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= PHONE_QUIZ_CONFIRM_TIMEOUT_MS) {
        resolve(false);
        return;
      }
      setTimeout(pollConfirm, PHONE_QUIZ_CONFIRM_POLL_MS);
    }
    pollConfirm();
  });
}

function submitPhoneQuiz(doc, context) {
  const submitButton = safeQuery(doc, ".zquestions .zsubmit .btn-ok-bottom");
  if (!submitButton || typeof submitButton.click !== "function") {
    quizWarn(context, "学习通手机版测验提交按钮 .zquestions .zsubmit .btn-ok-bottom 不存在，无法提交。");
    return false;
  }
  try {
    submitButton.click();
  } catch (_error) {
    quizWarn(context, "学习通手机版测验提交按钮点击失败。");
    return false;
  }
  return waitForPhoneQuizConfirm(doc);
}

async function solvePhoneQuizScene(doc, context) {
  // 状态文本：已完成/已交/待批阅 → 跳过。
  if (phoneQuizFinished(doc)) {
    return { done: true, skipped: true, reason: "quiz-finished" };
  }

  const solver = resolveQuizSolver(context);
  if (!solver || typeof solver.solveQuestions !== "function") {
    quizWarn(context,
      "quiz-solver 不可用（globalThis.CourseHelperQuizSolver 与 require(\"../quiz-solver.js\") 均失败），手机版测验任务保留未完成。");
    return { done: false, skipped: false, reason: "quiz-solver-unavailable" };
  }

  const extracted = await waitForPhoneQuizQuestions(doc);
  if (extracted.ignored > 0) {
    quizWarn(context,
      `学习通手机版测验有 ${extracted.ignored} 道题无法解析（缺少题干/题型/选项/输入框），已跳过。`);
  }
  if (!extracted.questions.length) {
    // 无题可做防御路径：轮询结束后若页面已呈现完成状态则跳过。
    if (phoneQuizFinished(doc)) {
      return { done: true, skipped: true, reason: "quiz-finished" };
    }
    return { done: false, skipped: false, reason: "quiz-no-questions" };
  }

  const autoSubmit = await readQuizAutoSubmit(context);
  const summary = await solver.solveQuestions(extracted.questions, context, {
    submit: () => submitPhoneQuiz(doc, context),
    autoSubmit,
  });

  if (summary.submitted === true) {
    return { done: true, skipped: false };
  }

  if (summary.solved > 0 || quizAllAnswered(summary)) {
    if (autoSubmit) {
      const submitResult = await submitPhoneQuiz(doc, context);
      if (!submitResult) {
        return { done: false, skipped: false, reason: "quiz-submit-failed" };
      }
      return { done: true, skipped: false };
    }
    // 自动提交关闭：spec/30e 未给出手机版测验的保存按钮，题目已填完即可（用户手动提交）。
    return { done: true, skipped: false };
  }

  return { done: false, skipped: false, reason: "no-question-solved" };
}

export async function solvePhoneWorkExam(doc, ctx) {
  const targetDoc = doc || getContextDocument(ctx || activeContext);
  const context = ctx || activeContext;
  if (!targetDoc || typeof targetDoc.querySelectorAll !== "function") {
    return { done: false, skipped: false, reason: "quiz-document-unavailable" };
  }
  const pathname = getDocumentPathname(targetDoc, context);

  // 场景 A：手机版测验。容器可能位于 doc 自身（主控在 iframe 导航到 /work/phone/work 后
  // 传入 iframe 文档）或其同域 iframe 内（任务列表页 /work/phone/doHomeWork 的防御路径）。
  const phoneDoc = findPhoneQuizDocument(targetDoc);
  if (phoneDoc || pathname.indexOf("/work/phone") === 0) {
    return solvePhoneQuizScene(phoneDoc || targetDoc, context);
  }

  // 场景 B：作业页 /mooc2/work/dowork。
  if (pathname === ROUTES.WORK || safeQuery(targetDoc, WORK_QUESTION_SELECTOR)) {
    return solveWorkScene(targetDoc, context);
  }

  // 场景 C：考试页 /exam/test/reVersionTestStartNew。
  if (pathname === ROUTES.EXAM || safeQuery(targetDoc, EXAM_QUESTION_SELECTOR)) {
    return solveExamScene(targetDoc, context);
  }

  return { done: false, skipped: false, reason: "phone-work-exam-scene-unknown" };
}

// ==== END SECTION: quiz-phone ====

// ==== SECTION: work-exam ====
// ---- 学习通作业页（/mooc2/work/dowork，spec/30e 场景 B）----
// 容器 .mark_table form，每题 .questionLi，题干 .mark_name；
// 选项 .stem_answer .answer_p（点击父级），填空 .stem_answer .Answer .divText .textDIV textarea，
// 简答 .stem_answer .eidtDiv textarea。
// spec/30e 未给出作业页提交/保存选择器：提交按钮按通用探测依次回退
// （.mark_table form 内 button/input[type=submit] → .btnSubmit → .ZY_sub .btnSubmit），
// 该探测选择器需在真实作业页面核对；确认弹窗沿用 PC 测验的 #confirmSubWin a.bluebtn（需核对）。
// ---- 学习通考试页（/exam/test/reVersionTestStartNew，spec/30e 场景 C）----
// 容器 .mark_table .whiteDiv，题干 h3.mark_name；
// 选项 .clearfix.answerBg .fl.answer_p（点击父级），填空 .Answer .divText .subEditor textarea，
// 简答选择器 spec 未给出：回退 .eidtDiv textarea（需在真实页面核对）；
// 下一题按钮 a.jb_btn（可选自动跳转：答完当前题后若存在则点击，没有则忽略）；
// 考试页提交按钮 spec 未给出：不自动交卷，答完所有可见题目即视为本场景完成（需在真实页面核对）。
// 入口 solvePhoneWorkExam 位于 quiz-phone 分区，按页面结构分流调用 solveWorkScene / solveExamScene；
// 通用辅助（quizWarn/stripTagsHtml/delayMs/quizInputsAnswered/quizAllAnswered/resolveQuizSolver/
// readQuizAutoSubmit）由 quiz-phone 分区提供。

const WORK_EXAM_FINISHED_MARKERS = ["已完成", "已交", "待批阅"];
const WORK_EXAM_TYPE_RE = /【\s*(单项选择题?|多项选择题?|单选题?|多选题?|填空题?|判断题?|简答题?|问答题?)\s*】/;
const WORK_EXAM_TYPE_MAP = Object.freeze({
  单选: 0, 单选题: 0, 单项选择: 0, 单项选择题: 0,
  多选: 1, 多选题: 1, 多项选择: 1, 多项选择题: 1,
  填空: 2, 填空题: 2,
  判断: 3, 判断题: 3,
  简答: 4, 简答题: 4, 问答: 4, 问答题: 4,
});
const WORK_EXAM_LOAD_POLL_MS = 500;
const WORK_EXAM_LOAD_TIMEOUT_MS = 5000;
const WORK_EXAM_CONFIRM_POLL_MS = 200;
const WORK_EXAM_CONFIRM_TIMEOUT_MS = 5000;
const WORK_EXAM_NEXT_WAIT_MS = 800;
const WORK_EXAM_MAX_ROUNDS = 200;

function workExamQuestionType(stemHtml) {
  const match = WORK_EXAM_TYPE_RE.exec(asString(stemHtml));
  if (!match) return null;
  const mapped = WORK_EXAM_TYPE_MAP[match[1]];
  return mapped === undefined ? null : mapped;
}

function workExamUniqueNodes(nodes) {
  const unique = [];
  for (const node of nodes) {
    if (node && unique.indexOf(node) === -1) unique.push(node);
  }
  return unique;
}

// 已答检测：参考 quiz-pc 分区做法（选项承载节点 aria-label 非空即已选）；
// 作业/考试页另把已选 class（checked/selected/current）作为已答标记（需在真实页面核对）。
function workExamChoiceAnswered(answerNodes, optionEntries) {
  const nodes = workExamUniqueNodes(
    answerNodes.concat(optionEntries.map((entry) => entry && entry.element)),
  );
  for (const node of nodes) {
    if (!node) continue;
    let label = "";
    try {
      label = node && typeof node.getAttribute === "function"
        ? node.getAttribute("aria-label") || ""
        : "";
    } catch (_error) {
      label = "";
    }
    if (asString(label).trim()) return true;
    let className = "";
    try {
      className = String(node.className || "");
    } catch (_error) {
      className = "";
    }
    if (/(^|\s)(checked|selected|current)(\s|$)/.test(className)) return true;
  }
  return false;
}

// ---- 作业页题目构建 ----
function workExamBlankInputs(node) {
  const inputs = [];
  for (const element of safeQueryAll(node, ".stem_answer .Answer .divText .textDIV textarea")) {
    inputs.push(element);
  }
  return workExamUniqueNodes(inputs);
}

function workExamEssayInputs(node) {
  const inputs = [];
  for (const element of safeQueryAll(node, ".stem_answer .eidtDiv textarea")) {
    inputs.push(element);
  }
  return workExamUniqueNodes(inputs);
}

function buildWorkQuestion(node) {
  const title = safeQuery(node, ".mark_name");
  const stemHtml = title ? asString(title.innerHTML) : "";
  if (!stripTagsHtml(stemHtml)) return null;
  const qtype = workExamQuestionType(stemHtml);
  if (qtype === null) return null;

  if (qtype === 0 || qtype === 1 || qtype === 3) {
    const answerNodes = safeQueryAll(node, ".stem_answer .answer_p");
    if (!answerNodes.length) return null;
    const options = answerNodes.map((answerNode) => ({
      html: asString(answerNode.innerHTML),
      // spec/30e：点击 .answer_p 的父级（父级承载已选样式与点击事件）。
      element: answerNode.parentElement || answerNode,
    }));
    return {
      qtype,
      stem: stemHtml,
      options,
      isAnswered: () => workExamChoiceAnswered(answerNodes, options),
    };
  }

  const inputs = qtype === 2
    ? workExamBlankInputs(node)
    : workExamEssayInputs(node);
  if (!inputs.length) return null;
  return {
    qtype,
    stem: stemHtml,
    inputs,
    isAnswered: () => quizInputsAnswered(inputs),
  };
}

function extractWorkQuestions(doc) {
  const questions = [];
  let ignored = 0;
  for (const node of safeQueryAll(doc, WORK_QUESTION_SELECTOR)) {
    const question = buildWorkQuestion(node);
    if (question) questions.push(question);
    else ignored += 1;
  }
  return { questions, ignored };
}

async function waitForWorkQuestions(doc) {
  const startedAt = Date.now();
  let extracted = extractWorkQuestions(doc);
  while (!extracted.questions.length && Date.now() - startedAt < WORK_EXAM_LOAD_TIMEOUT_MS) {
    await delayMs(WORK_EXAM_LOAD_POLL_MS);
    extracted = extractWorkQuestions(doc);
  }
  return extracted;
}

// 作业/考试页状态节点选择器 spec/30e 未给出，需在真实页面核对：
// 现回退读 .mark_table 区域整体文本，仅在题目容器不存在时参与完成判定。
function workExamStatusText(doc) {
  const table = safeQuery(doc, ".mark_table");
  return table ? asString(table.textContent).replace(/\s+/g, "") : "";
}

function workExamFinished(doc, questionSelector) {
  if (safeQuery(doc, questionSelector)) return false;
  const statusText = workExamStatusText(doc);
  return WORK_EXAM_FINISHED_MARKERS.some((marker) => statusText.indexOf(marker) !== -1);
}

// spec/30e 未给出作业页提交选择器：按通用探测依次回退，需在真实作业页面核对。
function findWorkSubmitButton(doc) {
  const form = safeQuery(doc, ".mark_table form");
  if (form) {
    const inForm =
      safeQuery(form, 'button[type="submit"]') ||
      safeQuery(form, 'input[type="submit"]') ||
      safeQuery(form, ".btnSubmit");
    if (inForm) return inForm;
  }
  return safeQuery(doc, ".btnSubmit") || safeQuery(doc, ".ZY_sub .btnSubmit");
}

function waitForWorkExamConfirm(doc) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    function pollConfirm() {
      // 确认弹窗沿用 PC 测验的 #confirmSubWin a.bluebtn（同一组件库，需在真实页面核对）。
      const confirmLink =
        safeQuery(doc, "#confirmSubWin > div > div > a.bluebtn") ||
        safeQuery(doc, "#confirmSubWin a.bluebtn");
      if (confirmLink && typeof confirmLink.click === "function") {
        try {
          confirmLink.click();
        } catch (_error) {
          // 确认按钮点击异常时仍视为已确认（按钮已出现说明提交流程已进入确认阶段）。
        }
        resolve(true);
        return;
      }
      // 无确认弹窗：状态文本变为已完成/已交/待批阅视为提交成功。
      if (workExamFinished(doc, WORK_QUESTION_SELECTOR)) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= WORK_EXAM_CONFIRM_TIMEOUT_MS) {
        resolve(false);
        return;
      }
      setTimeout(pollConfirm, WORK_EXAM_CONFIRM_POLL_MS);
    }
    pollConfirm();
  });
}

async function submitWorkQuiz(doc, context) {
  const submitButton = findWorkSubmitButton(doc);
  if (!submitButton || typeof submitButton.click !== "function") {
    quizWarn(context,
      "学习通作业页未探测到提交按钮（form 内 type=submit/.btnSubmit/.ZY_sub .btnSubmit 均不存在），无法提交。");
    return false;
  }
  try {
    submitButton.click();
  } catch (_error) {
    quizWarn(context, "学习通作业页提交按钮点击失败。");
    return false;
  }
  return waitForWorkExamConfirm(doc);
}

async function solveWorkScene(doc, context) {
  // 状态文本：已完成/已交/待批阅 → 跳过（状态节点选择器需在真实页面核对）。
  if (workExamFinished(doc, WORK_QUESTION_SELECTOR)) {
    return { done: true, skipped: true, reason: "quiz-finished" };
  }

  const solver = resolveQuizSolver(context);
  if (!solver || typeof solver.solveQuestions !== "function") {
    quizWarn(context,
      "quiz-solver 不可用（globalThis.CourseHelperQuizSolver 与 require(\"../quiz-solver.js\") 均失败），学习通作业任务保留未完成。");
    return { done: false, skipped: false, reason: "quiz-solver-unavailable" };
  }

  const extracted = await waitForWorkQuestions(doc);
  if (extracted.ignored > 0) {
    quizWarn(context,
      `学习通作业页有 ${extracted.ignored} 道题无法解析（缺少题干/题型/选项/输入框），已跳过。`);
  }
  if (!extracted.questions.length) {
    // 无题可做防御路径：轮询结束后若页面已呈现完成状态则跳过。
    if (workExamFinished(doc, WORK_QUESTION_SELECTOR)) {
      return { done: true, skipped: true, reason: "quiz-finished" };
    }
    return { done: false, skipped: false, reason: "quiz-no-questions" };
  }

  const autoSubmit = await readQuizAutoSubmit(context);
  const summary = await solver.solveQuestions(extracted.questions, context, {
    submit: () => submitWorkQuiz(doc, context),
    autoSubmit,
  });

  if (summary.submitted === true) {
    return { done: true, skipped: false };
  }

  if (summary.solved > 0 || quizAllAnswered(summary)) {
    if (autoSubmit) {
      const submitResult = await submitWorkQuiz(doc, context);
      if (!submitResult) {
        return { done: false, skipped: false, reason: "quiz-submit-failed" };
      }
      return { done: true, skipped: false };
    }
    // 自动提交关闭：spec/30e 未给出作业页保存按钮，题目已填完即可（用户手动提交）。
    return { done: true, skipped: false };
  }

  return { done: false, skipped: false, reason: "no-question-solved" };
}

// ---- 考试页题目构建 ----
function examBlankInputs(node) {
  const inputs = [];
  for (const element of safeQueryAll(node, ".Answer .divText .subEditor textarea")) {
    inputs.push(element);
  }
  return workExamUniqueNodes(inputs);
}

function examEssayInputs(node) {
  // spec/30e 未给出考试页简答选择器：回退 .eidtDiv textarea（作业页简答同款结构），
  // 需在真实页面核对。
  const inputs = [];
  for (const element of safeQueryAll(node, ".eidtDiv textarea")) {
    inputs.push(element);
  }
  return workExamUniqueNodes(inputs);
}

function buildExamQuestion(node) {
  const title = safeQuery(node, "h3.mark_name");
  const stemHtml = title ? asString(title.innerHTML) : "";
  if (!stripTagsHtml(stemHtml)) return null;
  const qtype = workExamQuestionType(stemHtml);
  if (qtype === null) return null;

  if (qtype === 0 || qtype === 1 || qtype === 3) {
    const answerNodes = safeQueryAll(node, ".clearfix.answerBg .fl.answer_p");
    if (!answerNodes.length) return null;
    const options = answerNodes.map((answerNode) => ({
      html: asString(answerNode.innerHTML),
      // spec/30e：点击 .answer_p 的父级（父级承载已选样式与点击事件）。
      element: answerNode.parentElement || answerNode,
    }));
    return {
      qtype,
      stem: stemHtml,
      options,
      isAnswered: () => workExamChoiceAnswered(answerNodes, options),
    };
  }

  const inputs = qtype === 2
    ? examBlankInputs(node)
    : examEssayInputs(node);
  if (!inputs.length) return null;
  return {
    qtype,
    stem: stemHtml,
    inputs,
    isAnswered: () => quizInputsAnswered(inputs),
  };
}

function extractExamQuestions(doc) {
  const questions = [];
  let ignored = 0;
  for (const node of safeQueryAll(doc, EXAM_QUESTION_SELECTOR)) {
    const question = buildExamQuestion(node);
    if (question) {
      // 跨轮跳题时按容器节点身份去重（非枚举属性，不影响 quiz-solver 的题目处理）。
      defineMetadata(question, "examNode", node);
      questions.push(question);
    } else {
      ignored += 1;
    }
  }
  return { questions, ignored };
}

async function waitForExamQuestions(doc) {
  const startedAt = Date.now();
  let extracted = extractExamQuestions(doc);
  while (!extracted.questions.length && Date.now() - startedAt < WORK_EXAM_LOAD_TIMEOUT_MS) {
    await delayMs(WORK_EXAM_LOAD_POLL_MS);
    extracted = extractExamQuestions(doc);
  }
  return extracted;
}

async function solveExamScene(doc, context) {
  // 状态文本：已完成/已交/待批阅 → 跳过（状态节点选择器需在真实页面核对）。
  if (workExamFinished(doc, EXAM_QUESTION_SELECTOR)) {
    return { done: true, skipped: true, reason: "quiz-finished" };
  }

  const solver = resolveQuizSolver(context);
  if (!solver || typeof solver.solveQuestions !== "function") {
    quizWarn(context,
      "quiz-solver 不可用（globalThis.CourseHelperQuizSolver 与 require(\"../quiz-solver.js\") 均失败），学习通考试任务保留未完成。");
    return { done: false, skipped: false, reason: "quiz-solver-unavailable" };
  }

  const extracted = await waitForExamQuestions(doc);
  if (extracted.ignored > 0) {
    quizWarn(context,
      `学习通考试页有 ${extracted.ignored} 道题无法解析（缺少题干/题型/选项/输入框），已跳过。`);
  }
  if (!extracted.questions.length) {
    // 无题可做防御路径：轮询结束后若页面已呈现完成状态则跳过。
    if (workExamFinished(doc, EXAM_QUESTION_SELECTOR)) {
      return { done: true, skipped: true, reason: "quiz-finished" };
    }
    return { done: false, skipped: false, reason: "quiz-no-questions" };
  }

  // 考试页逐轮处理：答完当前可见题目后若存在下一题按钮 a.jb_btn 则点击跳转（可选自动跳转），
  // 没有则忽略（题目可能一页全部渲染）。spec/30e 未给出考试页提交按钮，不自动交卷：
  // 答完所有可见题目即视为本场景完成（交卷行为需在真实页面核对）。
  const seenNodes = new Set();
  for (const question of extracted.questions) {
    seenNodes.add(question.examNode);
  }
  let fresh = extracted.questions.slice();
  let solvedTotal = 0;
  let answeredTotal = 0;
  let processedTotal = 0;

  for (let round = 0; round < WORK_EXAM_MAX_ROUNDS && fresh.length; round += 1) {
    const summary = await solver.solveQuestions(fresh, context, { autoSubmit: false });
    processedTotal += summary.total;
    solvedTotal += summary.solved;
    for (const result of summary.results) {
      if (result && result.reason === "already-answered") answeredTotal += 1;
    }

    const nextButton = safeQuery(doc, "a.jb_btn");
    if (!nextButton || typeof nextButton.click !== "function") break;
    try {
      nextButton.click();
    } catch (_error) {
      // 下一题按钮点击失败：不阻塞，当前可见题目已处理完。
      break;
    }
    await delayMs(WORK_EXAM_NEXT_WAIT_MS);

    // 下一轮题目：只取尚未处理过的容器（按节点身份去重）。
    fresh = [];
    for (const question of extractExamQuestions(doc).questions) {
      if (seenNodes.has(question.examNode)) continue;
      seenNodes.add(question.examNode);
      fresh.push(question);
    }
  }

  if (processedTotal > 0 && (solvedTotal > 0 || answeredTotal === processedTotal)) {
    return { done: true, skipped: false };
  }
  return { done: false, skipped: false, reason: "no-question-solved" };
}

// ==== END SECTION: work-exam ====

// ==== SECTION: font-decrypt ====
// 学习通 font-cxsecret 字体加密解密（spec/30f）：
// 页面 <style> 内嵌 base64 woff 字体（style 文本含 font-cxsecret）→ base64 → Typr.parse →
// 对 .font-cxsecret 元素文本的每个可疑字符（Unicode 19968–40869）：
// Typr.U.codeToGlyph → glyphToPath → JSON.stringify → MD5 → 取 hash 后 24 位（见 FONT_HASH_KEYS）
// → Table[该key] → String.fromCodePoint(真实码点) → 全局替换并移除 font-cxsecret class。
//
// 资源加载（分区内自包含，不依赖 loader 改动）：
// - Typr：lib/typr.js 是顶层 var Typr 的全局脚本，ESM import() 拿不到模块作用域变量，
//   用 chrome.scripting.executeScript({ world: "ISOLATED", files: ["lib/typr.js"] }) 注入
//   （content script 与其 ISOLATED world 共享 globalThis），并以
//   globalThis.__COURSE_HELPER_TYPR_INJECTED__ 幂等标记（风格与 loader 的
//   __COURSE_HELPER_MAIN_WORLD_BRIDGE_INJECTED__ 一致）。chrome.scripting 不可用或注入
//   失败时走降级路径。
// - Table：fetch(chrome.runtime.getURL("lib/table.json")) 模块级缓存只 fetch 一次；
//   chrome.runtime 不可用（Node 测试）时回退相对路径动态 import（.default 兼容 CJS/JSON
//   导入），仍失败走降级路径。
// - MD5：globalThis.md5（loader 已挂载 lib/md5.js；typr.js 注入后其尾部 blueimp-md5 会
//   覆盖同名全局，两者同为标准 MD5 32 位小写 hex，均可）→ require("../..//lib/md5.js"、
//   "../lib/md5.js")（Node 测试回退），都不可用走降级路径。
//
// 幂等与安全：WeakSet 记录已处理文档；有 .font-cxsecret 元素时处理一次（成功或降级）后
// 不再重复，无元素时立即返回且不记录（允许题目动态渲染后再次调用）；解密全程 try/catch
// 包裹，任何异常不抛出、警告后安全返回。
//
// 降级路径：Typr/Table/MD5/内嵌字体任一不可用（或映射整页 0 命中）时，console 警告并对
// 文档内所有 .font-cxsecret 元素设置 data-course-helper-encrypted="1"（主控接线在 workid
// 分支检测该标记并跳过整个测验），随后安全返回。
//
// 导出：decryptFont（CONTRACTS §6）+ hasUndecryptedFont（CONTRACTS 未列出但主控接线需要
// 的最小附加导出，用途见函数注释）。除此之外不新增其他导出。

const FONT_CXSECRET_CLASS = "font-cxsecret";
const FONT_CXSECRET_SELECTOR = ".font-cxsecret";
const FONT_ENCRYPTED_ATTR = "data-course-helper-encrypted";
const FONT_TYPR_FLAG = "__COURSE_HELPER_TYPR_INJECTED__";
const FONT_CHAR_MIN = 19968;
const FONT_CHAR_MAX = 40869;
const FONT_STYLE_HINT = "font-cxsecret";
const FONT_DATA_URI_RE = /data:[^,]*;base64,([A-Za-z0-9+/=]+)/gi;
// MD5 输出 32 位小写 hex，而 lib/table.json 的 key 实测全部为 8 位 hex（20902 条），
// 因此配套实现的 key 必为 8 字符窗口：主窗口取 hash 第 24 位之后（hash.slice(24)，即
// 末尾 8 字符，与 spec/30f"取 hash 后 24 位"按"第 24 位之后"的解读一致；若按"末尾 24
// 字符"解读则与表 key 长度矛盾，永远无法命中）。主窗口整页 0 命中时回退前 8 位
// （hash.slice(0, 8)，公开配套脚本的另一常见写法）；回退仅在整页 0 命中时启用，
// 避免逐字符双窗口试错引入误命中替换。
const FONT_HASH_KEYS = Object.freeze([
  { start: 24, end: -1 }, // hash.slice(24)：第 24 位之后（末尾 8 字符）
  { start: 0, end: 8 },   // hash.slice(0, 8)：前 8 位（整页 0 命中时的回退窗口）
]);

const DECRYPTED_FONT_DOCS = new WeakSet();
let fontTableCache = null; // 已加载的 Table（null 表示未加载或已确认加载失败）
let fontTableLoadStarted = false;

// ---- 日志（无 ctx，走文档 window 控制台或全局 console）----
function fontNotice(doc, method, message) {
  try {
    const view = doc && doc.defaultView;
    const target = (view && view.console) || (typeof console !== "undefined" ? console : null);
    if (target && typeof target[method] === "function") target[method](`[course-helper] ${message}`);
  } catch (_error) {
    // 控制台不可用时静默。
  }
}

// ---- 资源加载：MD5 ----
function resolveFontMd5() {
  if (typeof globalThis !== "undefined" && typeof globalThis.md5 === "function") return globalThis.md5;
  if (typeof require === "function") {
    for (const spec of ["../..//lib/md5.js", "../lib/md5.js"]) {
      try {
        const loaded = require(spec);
        const fn = typeof loaded === "function" ? loaded : loaded && (loaded.md5 || loaded.default);
        if (typeof fn === "function") return fn;
      } catch (_error) {
        // 模块不可加载时继续尝试下一个路径。
      }
    }
  }
  return null;
}

// ---- 资源加载：Table.json ----
async function loadFontTableOnce() {
  if (typeof chrome !== "undefined" && chrome.runtime &&
      typeof chrome.runtime.getURL === "function" && typeof fetch === "function") {
    try {
      const response = await fetch(chrome.runtime.getURL("lib/table.json"));
      if (response && typeof response.json === "function") {
        const data = await response.json();
        if (data && typeof data === "object" && !Array.isArray(data)) return data;
      }
    } catch (_error) {
      // 扩展内 fetch 失败时继续走 Node 回退。
    }
  }
  // Node 测试回退：相对路径动态 import（.default 兼容 CommonJS/JSON 导入形态）。
  // import attributes（with）用 Function 构造隔离：旧引擎解析本文件时不报语法错，
  // 运行时 Node 24 走带属性导入、Node 22/23 走无属性导入，均失败则继续 require 回退。
  for (const spec of ["../..//lib/table.json", "../lib/table.json"]) {
    try {
      let mod = null;
      try {
        const importJson = new Function("spec", "return import(spec, { with: { type: 'json' } })");
        mod = await importJson(spec);
      } catch (_error) {
        try {
          mod = await import(spec);
        } catch (_ignored) {
          mod = null;
        }
      }
      const data = mod && mod.default && typeof mod.default === "object" ? mod.default : mod;
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
    } catch (_error) {
      // 该路径不可导入时继续尝试下一个候选。
    }
  }
  if (typeof require === "function") {
    for (const spec of ["../..//lib/table.json", "../lib/table.json"]) {
      try {
        const data = require(spec);
        if (data && typeof data === "object" && !Array.isArray(data)) return data;
      } catch (_error) {
        // 该路径不可加载时继续尝试下一个候选。
      }
    }
  }
  return null;
}

async function loadFontTable() {
  if (fontTableLoadStarted) return fontTableCache;
  fontTableLoadStarted = true;
  let table = null;
  try {
    table = await loadFontTableOnce();
  } catch (_error) {
    table = null;
  }
  fontTableCache = table && typeof table === "object" ? table : null;
  return fontTableCache;
}

// ---- 资源加载：Typr 注入（ISOLATED world，与 content script 共享 globalThis）----
async function ensureFontTypr() {
  const root = typeof globalThis !== "undefined" ? globalThis : null;
  if (!root) return null;
  if (root.Typr && typeof root.Typr.parse === "function") return root.Typr;
  if (typeof chrome === "undefined" || !chrome.scripting ||
      typeof chrome.scripting.executeScript !== "function") {
    return null;
  }
  if (root[FONT_TYPR_FLAG]) return null; // 已有并发注入在途（或失败未撤回），直接降级。
  try {
    root[FONT_TYPR_FLAG] = true; // 幂等标记先置位，防止并发重复注入（风格同 loader 的 BRIDGE_FLAG）。
    const result = chrome.scripting.executeScript({ world: "ISOLATED", files: ["lib/typr.js"] });
    if (result && typeof result.then === "function") await result;
    const typr = root.Typr && typeof root.Typr.parse === "function" ? root.Typr : null;
    if (!typr) delete root[FONT_TYPR_FLAG]; // 注入未生效，撤回标记允许下次重试。
    return typr;
  } catch (_error) {
    try {
      delete root[FONT_TYPR_FLAG];
    } catch (_ignored) {
      // 标记撤回失败不影响降级。
    }
    return null;
  }
}

// ---- base64 解码（atob 优先，无 atob 环境手写回退）----
function decodeFontBase64(text) {
  const clean = asString(text).replace(/[^A-Za-z0-9+/=]/g, "");
  if (!clean) return null;
  if (typeof atob === "function") {
    try {
      const binary = atob(clean);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch (_error) {
      // atob 失败（非法 base64）时走手写回退。
    }
  }
  const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean.charAt(i);
    if (char === "=") break;
    const value = BASE64_CHARS.indexOf(char);
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

// ---- zlib 解压（woff 表数据为 zlib 流；DecompressionStream 在 Chrome 80+ 与 Node 18+ 可用）----
async function inflateWoffTable(bytes) {
  if (typeof DecompressionStream !== "function" || typeof Blob !== "function" ||
      typeof Response !== "function") {
    return null;
  }
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch (_error) {
    return null;
  }
}

// ---- woff 容器解包为裸 sfnt 字节（wOFF 魔数；woff2/wOF2 不支持返回 null）----
// spec/30f 指明页面内嵌 woff；lib/typr.js 只支持裸 sfnt（ttf/otf/ttc），
// 故需先按 woff 规范解出表目录、逐表 zlib 解压并重组 sfnt 再 Typr.parse。
async function unpackWoffFont(bytes) {
  const isWoff = bytes.length >= 4 &&
    bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x46; // "wOFF"
  if (!isWoff) return bytes; // 裸 sfnt 直接原样返回。
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = view.getUint16(12);
  if (numTables === 0 || 44 + numTables * 20 > bytes.length) return null;
  // woff 表目录与 sfnt 目录同序（tag 升序），每表 20 字节：tag/offset/compLength/origLength/checkSum。
  const tables = [];
  for (let i = 0; i < numTables; i += 1) {
    const record = 44 + i * 20;
    tables.push({
      tag: bytes.slice(record, record + 4),
      offset: view.getUint32(record + 4),
      compLength: view.getUint32(record + 8),
      origLength: view.getUint32(record + 12),
      checkSum: view.getUint32(record + 16),
    });
  }
  const inflated = [];
  for (const table of tables) {
    if (table.offset + table.compLength > bytes.length) return null;
    const data = await inflateWoffTable(bytes.slice(table.offset, table.offset + table.compLength));
    if (!data || data.length !== table.origLength) return null;
    inflated.push(data);
  }
  // 重组 sfnt：12 字节头（searchRange 等）+ 16 字节/表目录 + 4 字节对齐的表数据。
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = Math.pow(2, entrySelector) * 16;
  const totalLength = 12 + numTables * 16 +
    inflated.reduce((sum, data) => sum + Math.ceil(data.length / 4) * 4, 0);
  const out = new Uint8Array(totalLength);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, view.getUint32(4)); // flavor（原 sfnt 版本号）。
  outView.setUint16(4, numTables);
  outView.setUint16(6, searchRange);
  outView.setUint16(8, entrySelector);
  outView.setUint16(10, numTables * 16 - searchRange);
  let dataOffset = 12 + numTables * 16;
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    out.set(tables[i].tag, record);
    outView.setUint32(record + 4, tables[i].checkSum);
    outView.setUint32(record + 8, dataOffset);
    outView.setUint32(record + 12, tables[i].origLength);
    out.set(inflated[i], dataOffset);
    dataOffset += Math.ceil(inflated[i].length / 4) * 4;
  }
  return out;
}

// ---- 内嵌字体提取：style 文本含 font-cxsecret 才扫描，多个候选逐个试 Typr.parse ----
async function extractFontBase64(doc, typr) {
  for (const styleEl of safeQueryAll(doc, "style")) {
    const css = asString(styleEl.textContent ?? styleEl.innerHTML);
    if (css.indexOf(FONT_STYLE_HINT) < 0) continue;
    FONT_DATA_URI_RE.lastIndex = 0;
    let match;
    while ((match = FONT_DATA_URI_RE.exec(css)) !== null) {
      const bytes = decodeFontBase64(match[1]);
      if (!bytes) continue;
      try {
        const sfnt = await unpackWoffFont(bytes);
        if (!sfnt) continue; // woff2 或 woff 解包失败：试下一个候选。
        // Typr.parse 返回字体对象数组（单字体 1 个元素，TTC 多 face），取第一个含 cmap 的 face。
        const parsed = typr.parse(sfnt);
        const faces = Array.isArray(parsed) ? parsed : [parsed];
        const font = faces.find((face) => face && face.cmap) || null;
        if (font) return font;
      } catch (_error) {
        // 该候选不是合法字体数据，继续试下一个。
      }
    }
  }
  return null;
}

// ---- 字符映射：path JSON → MD5 → 8 字符窗口 → Table → 真实码点 ----
function mapFontHashKey(hash, table, windowIndex) {
  const spec = FONT_HASH_KEYS[windowIndex];
  if (!spec) return -1;
  const key = spec.end < 0 ? hash.slice(spec.start) : hash.slice(spec.start, spec.end);
  const value = table[key];
  return typeof value === "number" ? value : -1;
}

function mapFontCharacter(char, typr, font, table, md5, windowIndex) {
  const codePoint = char.codePointAt(0);
  if (codePoint < FONT_CHAR_MIN || codePoint > FONT_CHAR_MAX) return char;
  try {
    const glyph = typr.U.codeToGlyph(font, codePoint);
    const path = typr.U.glyphToPath(font, glyph);
    const hash = asString(md5(JSON.stringify(path)));
    const value = mapFontHashKey(hash, table, windowIndex);
    if (value > 0) return String.fromCodePoint(value);
  } catch (_error) {
    // 单字符映射失败：保留原字符。
  }
  return char;
}

// ---- 元素文本替换：只改文本节点，保留元素内非加密的兄弟结构 ----
function remapFontTextNode(node, typr, font, table, md5, windowIndex) {
  const raw = asString(node.nodeValue);
  if (!raw) return 0;
  let hits = 0;
  const mapped = Array.from(raw).map((char) => {
    const result = mapFontCharacter(char, typr, font, table, md5, windowIndex);
    if (result !== char) hits += 1;
    return result;
  });
  if (hits > 0) node.nodeValue = mapped.join("");
  return hits;
}

function remapFontElementNode(node, typr, font, table, md5, windowIndex) {
  if (node.nodeType === 3) {
    return remapFontTextNode(node, typr, font, table, md5, windowIndex);
  }
  let hits = 0;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    hits += remapFontElementNode(child, typr, font, table, md5, windowIndex);
  }
  return hits;
}

// ---- DOM 收尾：移除 font-cxsecret class / 降级标记 ----
function removeFontClass(el) {
  try {
    if (el.classList && typeof el.classList.remove === "function") {
      el.classList.remove(FONT_CXSECRET_CLASS);
      return;
    }
  } catch (_error) {
    // classList 异常（如 SVG 元素）时走 className 字符串回退。
  }
  try {
    const name = asString(el.className || (typeof el.getAttribute === "function" ? el.getAttribute("class") : ""));
    const cleaned = name.replace(new RegExp(`\\b${FONT_CXSECRET_CLASS}\\b`, "g"), "").replace(/\s+/g, " ").trim();
    if (typeof el.setAttribute === "function") {
      el.setAttribute("class", cleaned);
    } else {
      el.className = cleaned;
    }
  } catch (_error) {
    // 移除失败不阻塞答题流程（元素已按原文保留）。
  }
}

function markFontEncrypted(el) {
  try {
    if (typeof el.setAttribute === "function") el.setAttribute(FONT_ENCRYPTED_ATTR, "1");
  } catch (_error) {
    // 标记失败时该元素仍带 font-cxsecret class，hasUndecryptedFont 依旧能识别。
  }
}

export async function decryptFont(doc) {
  try {
    if (!doc || typeof doc.querySelectorAll !== "function") return;
    if (DECRYPTED_FONT_DOCS.has(doc)) return; // 同一文档不重复解密。
    const targets = safeQueryAll(doc, FONT_CXSECRET_SELECTOR);
    if (!targets.length) return; // 无加密元素立即返回；不记录幂等标记，动态渲染后仍可再调用。

    // 有加密元素：本次调用无论成功或降级都只处理一次。
    DECRYPTED_FONT_DOCS.add(doc);

    const typr = await ensureFontTypr();
    const table = typr ? await loadFontTable() : null;
    const md5 = resolveFontMd5();
    let font = null;
    if (typr) {
      try {
        font = await extractFontBase64(doc, typr);
      } catch (_error) {
        font = null;
      }
    }

    if (!typr || !table || !md5 || !font) {
      // 降级路径：Typr/Table/MD5/内嵌字体任一不可用 → 标记元素供主控接线跳过整个测验。
      for (const el of targets) markFontEncrypted(el);
      const missing = [
        !typr ? "Typr" : "",
        !table ? "Table" : "",
        !md5 ? "MD5" : "",
        !font ? "内嵌字体" : "",
      ].filter(Boolean).join("/");
      fontNotice(doc, "warn",
        `字体解密不可用（${missing}缺失），含加密字符的题目将跳过（已标记 ${FONT_ENCRYPTED_ATTR}）。`);
      return;
    }

    // 主窗口解密；整页 0 命中时回退到备选窗口（见 FONT_HASH_KEYS 注释）。
    let hits = 0;
    let windowIndex = 0;
    for (const el of targets) hits += remapFontElementNode(el, typr, font, table, md5, windowIndex);
    if (hits === 0 && FONT_HASH_KEYS.length > 1) {
      windowIndex = 1;
      for (const el of targets) hits += remapFontElementNode(el, typr, font, table, md5, windowIndex);
    }
    if (hits === 0) {
      // 两个窗口都未命中：Table 与页面字体不配套（如字体已更新），按降级处理，
      // 避免把乱码喂给 AI。
      for (const el of targets) markFontEncrypted(el);
      fontNotice(doc, "warn",
        "字体解密映射未命中（Table 与页面字体不配套），含加密字符的题目将跳过（已标记 " +
        `${FONT_ENCRYPTED_ATTR}）。`);
      return;
    }
    for (const el of targets) removeFontClass(el);
    fontNotice(doc, "log", `字体解密完成：${hits} 个字符已还原。`);
  } catch (error) {
    // 任何异常都不抛出：警告后安全返回（答题流程按降级跳过含加密字符的题）。
    fontNotice(doc, "warn", `字体解密异常，已跳过：${error && error.message ? error.message : error}`);
  }
}

// 主控接线辅助（CONTRACTS §6 未列出）：workid 分支在提取题目/答题前调用，
// 存在带 font-cxsecret class 或 data-course-helper-encrypted 标记的元素即视为
// 字体未解密（可能资源缺失降级），此时应跳过整个测验并警告。
export function hasUndecryptedFont(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return false;
  return safeQueryAll(doc, FONT_CXSECRET_SELECTOR).length > 0 ||
    safeQueryAll(doc, `[${FONT_ENCRYPTED_ATTR}]`).length > 0;
}

// ==== END SECTION: font-decrypt ====

// ==== SECTION: chapter-next ====
function findNextChapterButton(doc) {
  return safeQuery(doc, SELECTORS.chapterNext);
}

function chapterTargetFromEvent(event) {
  const target = event && event.target;
  if (!target || typeof target.closest !== "function") return null;
  try {
    return target.closest(SELECTORS.chapterNext);
  } catch (_error) {
    return null;
  }
}

function handleChapterClick(event) {
  const button = chapterTargetFromEvent(event);
  if (!button || internalChapterClick) return;

  const now = Date.now();
  if (now - lastChapterClickAt < 3000) {
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    return;
  }
  lastChapterClickAt = now;
}

function installChapterGuard(doc) {
  if (!doc || typeof doc.addEventListener !== "function" || chapterClickHandler) return;
  chapterClickHandler = handleChapterClick;
  doc.addEventListener("click", chapterClickHandler, true);
}

function removeChapterGuard() {
  const doc = getContextDocument(activeContext);
  if (doc && chapterClickHandler && typeof doc.removeEventListener === "function") {
    doc.removeEventListener("click", chapterClickHandler, true);
  }
  chapterClickHandler = null;
  internalChapterClick = false;
  lastChapterClickAt = 0;
}

function triggerNextChapter(doc) {
  const button = findNextChapterButton(doc);
  if (!button || typeof button.click !== "function") return false;

  const now = Date.now();
  if (now - lastChapterClickAt < 3000) return false;
  lastChapterClickAt = now;
  internalChapterClick = true;
  try {
    button.click();
    return true;
  } finally {
    internalChapterClick = false;
  }
}

// ==== END SECTION: chapter-next ====
