/**
 * Course Helper MV3 content loader.
 * 职责：读取 chrome.storage.local 配置、按 hostname/pathname 选择适配器，按需注入
 * MAIN world bridge，并以幂等方式管理适配器 init/destroy 生命周期。
 * [SECTION:LOADER]
 */
(function installCourseHelperLoader(root) {
  'use strict';

  const WINDOW_FLAG = '__COURSE_HELPER_LOADER__';
  const BRIDGE_FLAG = '__COURSE_HELPER_MAIN_WORLD_BRIDGE_INJECTED__';

  const DEFAULT_CONFIG = Object.freeze({
    deepseekApiKey: '<YOUR_DEEPSEEK_API_KEY>',
    deepseekModel: 'deepseek-chat',
    deepseekTemperature: 0.1,
    deepseekTimeoutMs: 30000,
    deepseekConcurrency: 3,
    videoSpeed: 3,
    autoVideo: true,
    autoAnswer: true,
    autoSubmit: true,
    showProgress: true,
    cxVideoMode: 'report',
    cxReportBaseInterval: 58,
    answerIntervalMs: 5000,
    // 题库 API（唯一题库来源）：未配置时跳过查询，由 DeepSeek 兜底；面板保存后写入。
    questionBankEnabled: false,
    questionBankUrl: '',
    questionBankKey: '',
    questionBankTimeoutMs: 15000
  });

  // [SECTION:LOADER] Hostname adapter registration.
  const ADAPTER_REGISTRY = Object.freeze({
    'chaoxing.com': Object.freeze({
      module: 'content/adapters/chaoxing.js',
      name: 'chaoxing'
    }),
    'zhihuishu.com': Object.freeze({
      module: 'content/adapters/zhihuishu.js',
      name: 'zhihuishu'
    }),
    'unipus.cn': Object.freeze({
      module: 'content/adapters/unipus.js',
      name: 'unipus'
    })
  });

  const ROUTES = Object.freeze([
    // [ROUTE:KNOWLEDGE_CARDS]
    Object.freeze({
      name: 'KNOWLEDGE_CARDS',
      path: 'knowledge/cards',
      test: /\/knowledge\/cards(?:\/|$)/i
    }),
    // [ROUTE:STUDENT_STUDY]
    Object.freeze({
      name: 'STUDENT_STUDY',
      path: 'studentstudy',
      test: /(?:^|\/)studentstudy(?:\/|$)/i
    }),
    // [ROUTE:EXAM]
    Object.freeze({
      name: 'EXAM',
      path: 'exam',
      test: /(?:^|\/)exam(?:\/|$)/i
    }),
    // [ROUTE:WORK]
    Object.freeze({
      name: 'WORK',
      path: 'work',
      test: /(?:^|\/)work(?:\/|$)/i
    }),
    // [ROUTE:PHONE_HOMEWORK]
    Object.freeze({
      name: 'PHONE_HOMEWORK',
      path: 'phone homework',
      test: /(?:^|\/)phone(?:[\s_/-]+)homework(?:\/|$)/i
    })
  ]);

  const existingLoader = root && root[WINDOW_FLAG];
  if (existingLoader && typeof existingLoader.init === 'function') {
    // A second content-script evaluation reuses the first lifecycle object.
    void existingLoader.init();
    return;
  }

  const state = {
    initialized: false,
    initializing: null,
    destroying: null,
    destroyed: false,
    settings: { ...DEFAULT_CONFIG },
    route: null,
    adapterEntry: null,
    adapter: null,
    context: null
  };

  const warned = new Set();

  function logger(method, ...args) {
    const consoleObject = root && root.console;
    if (consoleObject && typeof consoleObject[method] === 'function') {
      consoleObject[method](...args);
    }
  }

  function warn(message, error) {
    if (error) {
      logger('warn', `[course-helper] ${message}`, error);
    } else {
      logger('warn', `[course-helper] ${message}`);
    }
  }

  function warnOnce(key, message, error) {
    if (warned.has(key)) {
      return;
    }
    warned.add(key);
    warn(message, error);
  }

  function getChrome() {
    if (root && root.chrome) {
      return root.chrome;
    }
    if (typeof globalThis !== 'undefined' && globalThis.chrome) {
      return globalThis.chrome;
    }
    return null;
  }

  function getRuntime() {
    const chromeApi = getChrome();
    if (chromeApi && chromeApi.runtime) {
      return chromeApi.runtime;
    }
    return null;
  }

  function getCurrentLocation() {
    if (root && root.location) {
      return root.location;
    }
    if (typeof globalThis !== 'undefined' && globalThis.location) {
      return globalThis.location;
    }
    return null;
  }

  function normalizeHostname(hostname) {
    return String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  }

  function isLocalTestHost(hostname) {
    const normalized = normalizeHostname(hostname);
    return normalized === 'localhost' || normalized === '127.0.0.1';
  }

  function resolveAdapterEntry(hostname) {
    const normalized = normalizeHostname(hostname);
    // 本地 fixture 测试页（spec/70）：localhost/127.0.0.1 复用学习通适配器，
    // fixture 页面主要模拟学习通 PC 测验 DOM 与视频/挂机/提交注入验证。
    if (isLocalTestHost(normalized)) {
      return ADAPTER_REGISTRY['chaoxing.com'];
    }
    const registeredHosts = Object.keys(ADAPTER_REGISTRY);
    for (const registeredHost of registeredHosts) {
      if (normalized === registeredHost || normalized.endsWith(`.${registeredHost}`)) {
        return ADAPTER_REGISTRY[registeredHost];
      }
    }
    return null;
  }

  function decodePathname(pathname) {
    try {
      return decodeURIComponent(String(pathname || ''));
    } catch (error) {
      warnOnce('bad-pathname', 'pathname 解码失败，使用原始 pathname。', error);
      return String(pathname || '');
    }
  }

  function resolveRoute(pathname) {
    const normalizedPath = decodePathname(pathname).replace(/\\/g, '/');
    return ROUTES.find((route) => route.test.test(normalizedPath)) || null;
  }

  // 模块缓存破坏（2026-10-20 关键修复）：chrome-extension:// 的 ESM import 会被浏览器
  // 缓存，扩展"重新加载"后 content script 仍可能拿到旧模块（实测：loader.js 更新生效、
  // unipus.js 仍是旧版，语音题探测日志完全不出现）。给模块 URL 加版本标记，
  // 版本变化即强制重新拉取。改 unipus.js/bridge/quiz-solver 等模块后递增。
  //
  // 【2026-10-24 真机修复】标记从 `?v=`（查询参数）改为 `#v=`（hash 片段）：
  // Edge 155 下带查询参数的扩展资源 URL 不再按 ES module 解析，
  // 会抛 "SyntaxError: Unexpected token 'export'"（adapter 加载失败的根因：
  // 面板不出现、自动化全部失效）。hash 片段同样改变模块 URL（缓存 key 不同 → 缓存被破坏），
  // 但不参与 web_accessible_resources 匹配、不影响 ESM 解析。
  const MODULE_CACHE_VERSION = '20261024.67';
  function getModuleSpecifier(relativePath) {
    const runtime = getRuntime();
    const base = (runtime && typeof runtime.getURL === 'function')
      ? runtime.getURL(relativePath)
      : relativePath;
    try {
      const bare = base.split('#')[0];
      return bare + '#v=' + MODULE_CACHE_VERSION;
    } catch (_error) {
      return base;
    }
  }

  // 【2026-10-24 架构变更】adapter 不再用动态 import() 加载：
  // Edge 155 的内容脚本已不支持 import() 取 ESM（会按 classic script 解析 →
  // "SyntaxError: Unexpected token 'export'"），导致 adapter 全部加载失败、面板消失。
  // 现改为 manifest content_scripts 按序注入 classic script，adapter 自行挂到 globalThis。
  const ADAPTER_GLOBALS = Object.freeze({
    chaoxing: 'CourseHelperAdapterChaoxing',
    zhihuishu: 'CourseHelperAdapterZhihuishu',
    unipus: 'CourseHelperAdapterUnipus'
  });

  async function loadAdapter(entry) {
    if (!entry || !entry.name) {
      return null;
    }
    const globalKey = ADAPTER_GLOBALS[entry.name];
    let candidate = null;
    try {
      candidate = globalKey && root ? root[globalKey] : null;
    } catch (_readError) {
      candidate = null;
    }
    if (!candidate || typeof candidate !== 'object') {
      warnOnce(`adapter-missing:${entry.name}`,
        `${entry.name} adapter 未注入（检查 manifest content_scripts 是否包含该文件），安全跳过。`);
      return null;
    }
    return candidate;
  }

  // 共享模块由 manifest 按序注入（classic script）：md5.js 挂 globalThis.md5、
  // quiz-solver.js 挂 globalThis.CourseHelperQuizSolver、keep-alive.js 挂
  // __COURSE_HELPER_KEEP_ALIVE__。此处只校验是否就绪，缺失时降级跳过对应分区。
  async function loadSharedModules() {
    const checks = [
      { global: 'CourseHelperQuizSolver', name: 'quiz-solver' },
      { global: '__COURSE_HELPER_KEEP_ALIVE__', name: 'keep-alive' },
      { global: 'md5', name: 'md5' }
    ];
    for (const check of checks) {
      let ready = false;
      try {
        ready = Boolean(root && root[check.global]);
      } catch (_checkError) {
        ready = false;
      }
      if (!ready) {
        warnOnce(`shared-module-missing:${check.name}`,
          `${check.name} 共享模块未就绪（manifest 注入顺序？），相关分区将降级跳过。`);
      }
    }
  }

  function startKeepAlive() {
    try {
      const keepAliveApi = root && root.__COURSE_HELPER_KEEP_ALIVE__;
      if (!keepAliveApi || typeof keepAliveApi.start !== 'function') return;
      keepAliveApi.start(root.document);
    } catch (error) {
      warnOnce('keep-alive-start-failed', 'keep-alive 启动失败，安全跳过。', error);
    }
  }

  function readStorageLocal(storage, defaults) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };

      const callback = (value) => finish(null, value);
      let result;
      try {
        // MV3 exposes promise-returning methods; older/test shims may expose
        // callback methods. Try the native promise form first.
        result = storage.get(defaults);
      } catch (firstError) {
        try {
          result = storage.get(defaults, callback);
        } catch (secondError) {
          finish(firstError || secondError);
          return;
        }
      }

      if (result && typeof result.then === 'function') {
        result.then((value) => finish(null, value), (error) => finish(error));
        return;
      }
      if (result !== undefined) {
        finish(null, result);
        return;
      }

      // Callback-only implementations return undefined from the first call.
      try {
        result = storage.get(defaults, callback);
        if (result && typeof result.then === 'function') {
          result.then((value) => finish(null, value), (error) => finish(error));
        }
      } catch (error) {
        finish(error);
      }
    });
  }

  async function readSettings() {
    const defaults = { ...DEFAULT_CONFIG };
    const chromeApi = getChrome();
    const storage = chromeApi && chromeApi.storage && chromeApi.storage.local;
    if (!storage || typeof storage.get !== 'function') {
      warnOnce('storage-unavailable', 'chrome.storage.local unavailable，使用默认配置。');
      return defaults;
    }

    try {
      const stored = await readStorageLocal(storage, defaults);
      if (!stored || typeof stored !== 'object') {
        return defaults;
      }
      return { ...defaults, ...stored };
    } catch (error) {
      warnOnce('storage-read-failed', '读取 chrome.storage.local 失败，使用默认配置。', error);
      return defaults;
    }
  }

  function sendMessage(message) {
    const runtime = getRuntime();
    if (!runtime || typeof runtime.sendMessage !== 'function') {
      warnOnce('send-message-unavailable', 'chrome.runtime.sendMessage unavailable。');
      return Promise.reject(new Error('chrome.runtime.sendMessage unavailable'));
    }

    try {
      const result = runtime.sendMessage(message);
      return result && typeof result.then === 'function'
        ? result
        : Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function injectMainWorldBridge() {
    if (root && root[BRIDGE_FLAG]) {
      return true;
    }

    const chromeApi = getChrome();
    // MAIN world 桥接已由 manifest 的 content_scripts（world:"MAIN",
    // run_at:"document_start"）原生注入；此处仅作防御性重注入路径。
    // content script 环境中 chrome.scripting 不可用属预期，静默跳过。
    if (!chromeApi || !chromeApi.scripting ||
        typeof chromeApi.scripting.executeScript !== 'function') {
      return false;
    }

    if (root) {
      root[BRIDGE_FLAG] = true;
    }

    try {
      // Injection is deliberately lazy: it happens only after a registered
      // adapter and a supported pathname have both been resolved.
      const result = chromeApi.scripting.executeScript({
        world: 'MAIN',
        files: ['content/main-world-bridge.js']
      });
      if (result && typeof result.then === 'function') {
        await result;
      }
      return true;
    } catch (error) {
      if (root) {
        delete root[BRIDGE_FLAG];
      }
      warnOnce('scripting-injection-failed', 'MAIN bridge 注入失败，继续运行适配器。', error);
      return false;
    }
  }

  function createContext(locationObject, route, settings) {
    return {
      document: root && root.document ? root.document : null,
      location: locationObject,
      route,
      settings,
      sendMessage,
      log: (...args) => logger('log', '[course-helper]', ...args)
    };
  }

  async function runInit() {
    const runtime = getRuntime();
    if (!runtime) {
      warnOnce('runtime-unavailable', 'chrome.runtime unavailable，loader 安全跳过。');
      state.initialized = true;
      state.destroyed = false;
      return state;
    }

    const locationObject = getCurrentLocation();
    const hostname = locationObject && locationObject.hostname;
    const pathname = locationObject && locationObject.pathname;
    const adapterEntry = resolveAdapterEntry(hostname);
    let route = resolveRoute(pathname);
    // 本地 fixture 测试页（spec/70）：路径不匹配课程路由时用 FIXTURE 占位路由放行，
    // 由适配器（chaoxing）在其 fixture 分支处理页面上的测验/视频/弹窗验证区。
    if (!route && isLocalTestHost(hostname)) {
      route = Object.freeze({ name: 'FIXTURE', path: '/test-page.html', test: /\/test-page\.html(?:\?|$)/i });
    }

    state.settings = await readSettings();
    state.route = route;
    state.adapterEntry = adapterEntry;
    state.destroyed = false;

    if (!adapterEntry) {
      warnOnce(`host:${normalizeHostname(hostname)}`, '当前 hostname 没有注册适配器，安全跳过。');
      state.initialized = true;
      return state;
    }
    if (!route) {
      // 学习通按课程路由（knowledge/cards 等）分发；智慧树/u校园没有课程路由
      // 概念，由各自适配器的 matches/init 自行判断页面，这里给占位路由放行。
      if (adapterEntry.name === 'chaoxing') {
        warnOnce(`route:${String(pathname || '')}`, '当前 pathname 没有匹配的课程路由，安全跳过。');
        state.initialized = true;
        return state;
      }
      route = Object.freeze({ name: 'ADAPTER_DEFAULT', path: String(pathname || ''), test: null });
      state.route = route;
    }

    await loadSharedModules();
    // 保活系统尽早启动（不依赖适配器）：真实平台的任务队列（视频上报等）与
    // fixture 测验都可能长时间占用 init，期间的挂机弹窗必须被观察处理。
    startKeepAlive();

    const adapter = await loadAdapter(adapterEntry);
    if (!adapter) {
      state.initialized = true;
      return state;
    }

    const currentUrl = (() => {
      try {
        return new URL(String(locationObject.href || ''), root && root.document
          ? root.document.baseURI
          : undefined);
      } catch (error) {
        return null;
      }
    })();

    // 本地 fixture 测试页由 loader 直接放行（chaoxing.matches 只按生产路由判定）。
    if (!isLocalTestHost(hostname) && typeof adapter.matches === 'function') {
      let matched = false;
      try {
        matched = Boolean(adapter.matches(currentUrl || locationObject));
      } catch (error) {
        warnOnce(`adapter-matches:${adapterEntry.name}`, `${adapterEntry.name} adapter matches 失败，安全跳过。`, error);
        state.initialized = true;
        return state;
      }
      if (!matched) {
        state.initialized = true;
        return state;
      }
    }

    await injectMainWorldBridge();
    const context = createContext(locationObject, route, state.settings);
    state.context = context;
    state.adapter = adapter;

    if (typeof adapter.init !== 'function') {
      warnOnce(`adapter-init:${adapterEntry.name}`, `${adapterEntry.name} adapter 缺少 init，安全跳过。`);
      state.initialized = true;
      return state;
    }

    // 版本标记（2026-10-20）：重载扩展后日志首行即可确认运行的代码版本，
    // 避免"改了代码但浏览器跑的是旧版"的排查浪费。修改 unipus.js/bridge 后递增。
    // 同时写入 DOM 属性：控制台执行 document.documentElement.dataset.courseHelperVersion
    // 即可秒查当前运行版本（页面可见/可查，不依赖日志滚动）。
    const ADAPTER_VERSION = 'v2026-10-20.78（子标签优先+可重试）';
    try {
      console.log('[course-helper] [course-helper] 扩展已加载：' + adapterEntry.name +
        ' 适配器 ' + ADAPTER_VERSION);
      const rootDoc = root && root.document;
      if (rootDoc && rootDoc.documentElement) {
        rootDoc.documentElement.setAttribute('data-course-helper-version', ADAPTER_VERSION);
      }
    } catch (_error) { /* 日志失败不影响流程 */ }

    try {
      await adapter.init(context);
    } catch (error) {
      warnOnce(`adapter-init-failed:${adapterEntry.name}`, `${adapterEntry.name} adapter init 失败，继续保持页面可用。`, error);
    }

    state.initialized = true;
    return state;
  }

  function init() {
    if (state.initializing) {
      return state.initializing;
    }
    if (state.initialized && !state.destroyed) {
      return Promise.resolve(state);
    }

    state.initializing = Promise.resolve()
      .then(() => runInit())
      .catch((error) => {
        warnOnce('loader-init-failed', 'loader 初始化失败，安全停止。', error);
        state.initialized = true;
        return state;
      })
      .finally(() => {
        state.initializing = null;
      });
    return state.initializing;
  }

  function destroy() {
    if (state.destroying) {
      return state.destroying;
    }

    state.destroying = Promise.resolve()
      .then(async () => {
        if (state.initializing) {
          try {
            await state.initializing;
          } catch (error) {
            // init() already converts failures to a safe state.
          }
        }

        const adapter = state.adapter;
        state.adapter = null;
        state.context = null;
        if (adapter && typeof adapter.destroy === 'function') {
          try {
            await adapter.destroy();
          } catch (error) {
            warnOnce(`adapter-destroy:${state.adapterEntry && state.adapterEntry.name || 'unknown'}`,
              'adapter destroy 失败，继续完成 loader 清理。', error);
          }
        }
        state.initialized = false;
        state.destroyed = true;
        return state;
      })
      .finally(() => {
        state.destroying = null;
      });
    return state.destroying;
  }

  const publicApi = Object.freeze({
    init,
    destroy,
    get settings() {
      return { ...state.settings };
    },
    get route() {
      return state.route;
    }
  });

  if (root) {
    root[WINDOW_FLAG] = publicApi;
  }

  void init();
})(typeof window !== 'undefined' ? window : globalThis);
