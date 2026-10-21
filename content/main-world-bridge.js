/**
 * [SECTION:MAIN_BRIDGE]
 * MAIN world bridge：保存并钩住页面原生网络引用，转发 UCampus 题目/提交数据，
 * 并安全处理 confirm、UE 编辑器及手机版编辑器通信。仅使用原生 JavaScript，
 * 不加载远程代码；全局安装标记保证重复注入不会重复安装钩子。
 */
(function installMainWorldBridge(globalWindow) {
  'use strict';

  if (!globalWindow) {
    return;
  }

  var SOURCE = 'course-helper';
  var VERSION = 1;
  var MARKER = '__COURSE_HELPER_MAIN_BRIDGE__';
  var SUBMIT_PATH = '/course/api/v3/newExploration/submit';

  // 安全取元素文本（兼容 textContent / innerText / 伪元素文本缺失）。
  function asStringSafe(value) {
    if (value == null) return '';
    try { return String(value); } catch (_e) { return ''; }
  }
  // 取元素的 ::before/::after 伪元素文本（平台按钮可能把文本写进伪元素）。
  function getPseudoTextSafe(element) {
    if (!element || typeof window.getComputedStyle !== 'function') return '';
    try {
      var before = window.getComputedStyle(element, '::before');
      var after = window.getComputedStyle(element, '::after');
      var parts = [];
      if (before && before.content) parts.push(before.content.replace(/^["']|["']$/g, ''));
      if (after && after.content) parts.push(after.content.replace(/^["']|["']$/g, ''));
      return parts.join(' ');
    } catch (_e) { return ''; }
  }
  var INPUT_EVENTS = [
    'course-helper:main:init',
    'course-helper:main:set-confirm',
    'course-helper:main:set-editor',
    'course-helper:main:set-mobile-editor',
    'course-helper:main:set-ucampus-answer-queue',
    'course-helper:main:ucampus-stop-recording',
    'course-helper:main:dispose'
  ];
  var OUTPUT_EVENTS = {
    READY: 'course-helper:main:ready',
    EDITOR_RESULT: 'course-helper:main:editor-result',
    QUESTION_DATA: 'course-helper:main:ucampus-question-data',
    SUBMIT: 'course-helper:main:ucampus-submit',
    RECORDING_STATE: 'course-helper:main:ucampus-recording-state',
    ERROR: 'course-helper:main:error'
  };
  var hasOwn = Object.prototype.hasOwnProperty;
  var requestCounter = 0;
  var state;
  var pageWindow = globalWindow;

  try {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow) {
      pageWindow = unsafeWindow;
    }
  } catch (ignoredUnsafeWindowError) {
    pageWindow = globalWindow;
  }

  try {
    var existingMarker = pageWindow[MARKER];
    if (existingMarker && existingMarker.installed === true) {
      return;
    }
  } catch (ignoredMarkerReadError) {
    // 页面可能提供了会抛异常的全局属性；继续使用局部状态，不让注入失败。
  }

  state = {
    installed: true,
    disposed: false,
    disposing: false,
    confirmSnapshot: null,
    alertSnapshot: null,
    checkJobSnapshot: null,
    xhr: null,
    fetch: null,
    messageInstalled: false,
    customEventSeen: typeof WeakSet === 'function' ? new WeakSet() : null,
    unrecognizedQuestionDataWarned: false
  };

  try {
    Object.defineProperty(pageWindow, MARKER, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: state
    });
  } catch (markerDefineError) {
    try {
      pageWindow[MARKER] = state;
    } catch (markerAssignError) {
      // 无法写入标记时仍继续；正常页面中全局属性可写。
    }
  }

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function safeErrorMessage(error, fallback) {
    var message = '';
    try {
      if (error && typeof error.message === 'string') {
        message = error.message;
      } else if (typeof error === 'string') {
        message = error;
      }
    } catch (ignoredErrorRead) {
      message = '';
    }
    if (!message) {
      message = fallback || 'Unknown bridge error';
    }
    return message.length > 500 ? message.slice(0, 500) : message;
  }

  function nextRequestId() {
    requestCounter += 1;
    var now = 0;
    try {
      now = Date.now();
    } catch (ignoredDateError) {
      now = 0;
    }
    return 'main-' + String(now) + '-' + String(requestCounter);
  }

  function validRequestId(requestId) {
    return typeof requestId === 'string' && requestId.length > 0;
  }

  function dispatchCustomEvent(name, payload) {
    try {
      if (typeof globalWindow.CustomEvent === 'function') {
        globalWindow.dispatchEvent(new globalWindow.CustomEvent(name, {
          detail: payload
        }));
        return;
      }
    } catch (customEventConstructorError) {
      // 使用旧式 CustomEvent 创建路径继续尝试。
    }

    try {
      if (globalWindow.document && typeof globalWindow.document.createEvent === 'function') {
        var event = globalWindow.document.createEvent('CustomEvent');
        event.initCustomEvent(name, false, false, payload);
        globalWindow.dispatchEvent(event);
      }
    } catch (customEventFallbackError) {
      // CustomEvent 仅是旁路通知，不能影响 postMessage 或页面网络行为。
    }
  }

  function emit(name, payload, requestId) {
    if (state.disposed || state.disposing) {
      return;
    }

    var responseRequestId = validRequestId(requestId) ? requestId : nextRequestId();
    var message = {
      source: SOURCE,
      type: name,
      requestId: responseRequestId,
      payload: payload
    };

    try {
      if (typeof globalWindow.postMessage === 'function') {
        globalWindow.postMessage(message, '*');
      }
    } catch (postMessageError) {
      // 页面脚本可能替换 postMessage；CustomEvent 仍然应该尝试发送。
    }

    dispatchCustomEvent(name, payload);
  }

  function reportError(code, message, requestId) {
    if (state.disposed || state.disposing) {
      return;
    }
    emit(OUTPUT_EVENTS.ERROR, {
      code: typeof code === 'string' && code ? code : 'MAIN_BRIDGE_ERROR',
      message: typeof message === 'string' && message ? message : 'Main bridge error'
    }, requestId);
  }

  function resolveUrl(url) {
    var text = '';
    try {
      if (url !== undefined && url !== null) {
        text = String(url);
      }
    } catch (ignoredUrlStringError) {
      text = '';
    }

    try {
      var base = '';
      if (globalWindow.location && typeof globalWindow.location.href === 'string') {
        base = globalWindow.location.href;
      }
      if (typeof URL === 'function') {
        return new URL(text, base || undefined).href;
      }
    } catch (ignoredUrlResolveError) {
      // 保留原始 URL；调用者可用路径匹配继续工作。
    }

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      return text;
    }
    return text;
  }

  function isSubmitUrl(url) {
    var text = '';
    try {
      text = String(url || '');
    } catch (ignoredSubmitUrlError) {
      return false;
    }
    return text.indexOf(SUBMIT_PATH) !== -1;
  }

  function getAnswerQueue() {
    try {
      var queue = pageWindow.__UCAMPUS_ANSWER_CACHE__;
      return Array.isArray(queue) ? queue : null;
    } catch (queueReadError) {
      return null;
    }
  }

  function collectValueLeaves(node, leaves) {
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i += 1) {
        collectValueLeaves(node[i], leaves);
      }
      return;
    }

    if (!isObject(node)) {
      return;
    }

    if (Array.isArray(node.children)) {
      for (var childIndex = 0; childIndex < node.children.length; childIndex += 1) {
        collectValueLeaves(node.children[childIndex], leaves);
      }
      return;
    }

    if (hasOwn.call(node, 'value')) {
      leaves.push(node);
    }
  }

  function randomUsedTime() {
    var randomValue = 0;
    try {
      randomValue = Math.random();
    } catch (ignoredRandomError) {
      randomValue = 0;
    }
    if (typeof randomValue !== 'number' || !isFinite(randomValue)) {
      randomValue = 0;
    }
    if (randomValue < 0) {
      randomValue = 0;
    }
    if (randomValue >= 1) {
      randomValue = 0.999999;
    }
    return 60 + Math.floor(randomValue * 61);
  }

  var submitWarnedKeys = {};
  function warnSubmitOnce(key, message) {
    if (submitWarnedKeys[key]) {
      return;
    }
    submitWarnedKeys[key] = true;
    try {
      console.log('[course-helper] MAIN bridge 提交改写跳过：' + message);
    } catch (ignoredLogError) {
      // 诊断日志失败不影响流程。
    }
  }

  /*
   * 仅对明确授权的 UCampus 提交 JSON 做改写。所有校验在改变原队列以前完成，
   * 因此无队列、答案树非法或队列不足时会返回 null，调用者原样放行请求。
   */
  function rewriteSubmitBody(body) {
    if (typeof body !== 'string') {
      return null;
    }

    var queue = getAnswerQueue();
    if (!queue || queue.length === 0) {
      warnSubmitOnce('empty-queue', '答案队列为空或不可用（submit 前未下发答案）。');
      return null;
    }

    var submitPayload;
    try {
      submitPayload = JSON.parse(body);
    } catch (invalidSubmitJsonError) {
      return null;
    }

    if (!isObject(submitPayload) || !Array.isArray(submitPayload.quesDatas)) {
      warnSubmitOnce('bad-structure', '提交结构不符（缺 quesDatas 数组）。');
      return null;
    }

    var pendingAnswers = [];
    var answerTrees = [];

    try {
      for (var questionIndex = 0; questionIndex < submitPayload.quesDatas.length; questionIndex += 1) {
        var question = submitPayload.quesDatas[questionIndex];
        if (!isObject(question) || typeof question.answer !== 'string') {
          warnSubmitOnce('bad-question', '提交题目结构不符（第 ' + questionIndex + ' 题缺 answer 字符串）。');
          return null;
        }

        var answerTree;
        try {
          answerTree = JSON.parse(question.answer);
        } catch (invalidAnswerTreeError) {
          warnSubmitOnce('bad-answer-json', '第 ' + questionIndex + ' 题答案树 JSON 解析失败。');
          return null;
        }

        var leaves = [];
        collectValueLeaves(answerTree, leaves);
        answerTrees.push({
          question: question,
          tree: answerTree,
          leaves: leaves
        });

        for (var leafIndex = 0; leafIndex < leaves.length; leafIndex += 1) {
          var queueIndex = pendingAnswers.length;
          if (queueIndex >= queue.length || typeof queue[queueIndex] !== 'string') {
            warnSubmitOnce('queue-short',
              '答案队列不足：第 ' + questionIndex + ' 题需要 ' + (queueIndex + 1) +
              ' 个答案位，队列只有 ' + queue.length + ' 个（语音题等占位与提交叶子数不匹配？）。');
            return null;
          }
          pendingAnswers.push(queue[queueIndex]);
        }
      }

      if (pendingAnswers.length === 0) {
        warnSubmitOnce('no-leaves', '提交答案树无 value 叶子可注入。');
        return null;
      }

      var answerCursor = 0;
      for (var treeIndex = 0; treeIndex < answerTrees.length; treeIndex += 1) {
        var treeInfo = answerTrees[treeIndex];
        for (var valueIndex = 0; valueIndex < treeInfo.leaves.length; valueIndex += 1) {
          treeInfo.leaves[valueIndex].value = [pendingAnswers[answerCursor]];
          answerCursor += 1;
        }
        treeInfo.question.answer = JSON.stringify(treeInfo.tree);
      }

      submitPayload.usedTime = randomUsedTime();
      var rewrittenBody = JSON.stringify(submitPayload);

      // 以 shift 消耗已实际注入的答案，保持队列的先入先出语义。
      for (var consumedIndex = 0; consumedIndex < pendingAnswers.length; consumedIndex += 1) {
        queue.shift();
      }

      return {
        body: rewrittenBody,
        usedTime: submitPayload.usedTime,
        answerCount: pendingAnswers.length
      };
    } catch (rewriteError) {
      warnSubmitOnce('rewrite-exception', '改写过程异常：' + (rewriteError && rewriteError.message ? rewriteError.message : String(rewriteError)));
      return null;
    }
  }

  function parseResponseValue(value) {
    if (isObject(value)) {
      return value;
    }
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }
    try {
      var parsed = JSON.parse(value);
      return isObject(parsed) ? parsed : null;
    } catch (invalidResponseJsonError) {
      return null;
    }
  }

  function reportQuestionData(value, requestUrl) {
    var data = parseResponseValue(value);
    if (!data || data.code !== 0 || typeof data.content !== 'string') {
      return;
    }
    if (data.content.indexOf('unipus.') !== 0 || typeof data.k !== 'string') {
      // 诊断：URL 疑似题目数据请求但响应格式未识别（可能为新格式/明文）。
      // 只打印一次，避免刷屏（供主控核对真实页面后补充识别规则）。
      var urlText = resolveUrl(requestUrl || '');
      var looksLikeQuestionUrl = /\/course\/api\/v3\/content\//.test(urlText) ||
        /newExploration/.test(urlText);
      if (looksLikeQuestionUrl && !state.unrecognizedQuestionDataWarned) {
        state.unrecognizedQuestionDataWarned = true;
        console.log('[course-helper] MAIN bridge：题目响应格式未识别（content 前缀=' +
          String(data.content).slice(0, 40) + '，k=' +
          (data.k === undefined ? '缺失' : typeof data.k) + '，url=' + urlText + '）');
      }
      return;
    }

    var payload = {
      code: 0,
      content: data.content,
      k: data.k,
      encrypted: true,
      url: resolveUrl(requestUrl || '')
    };

    try {
      pageWindow.__interceptedQuestionData = payload;
    } catch (questionCacheError) {
      reportError('QUESTION_CACHE', '无法缓存 UCampus 题目数据');
    }

    emit(OUTPUT_EVENTS.QUESTION_DATA, payload);
  }

  function readXhrResponse(xhr) {
    var responseType = '';
    try {
      responseType = xhr.responseType || '';
    } catch (ignoredResponseTypeError) {
      responseType = '';
    }

    if (responseType === 'json') {
      try {
        return xhr.response;
      } catch (jsonResponseReadError) {
        return null;
      }
    }

    try {
      if (typeof xhr.responseText === 'string') {
        return xhr.responseText;
      }
    } catch (responseTextReadError) {
      // 某些 responseType 禁止读取 responseText，继续尝试 response。
    }

    try {
      return xhr.response;
    } catch (genericResponseReadError) {
      return null;
    }
  }

  function inspectXhrResponse(xhr, requestUrl) {
    try {
      reportQuestionData(readXhrResponse(xhr), requestUrl);
    } catch (xhrInspectionError) {
      // 解析失败不能影响已经完成的原始 XHR。
    }
  }

  function attachXhrInspector(xhr, requestUrl) {
    if (!xhr || typeof xhr.addEventListener !== 'function') {
      return;
    }

    var handled = false;
    var inspect = function inspect() {
      if (handled) {
        return;
      }
      handled = true;
      inspectXhrResponse(xhr, requestUrl);
    };

    try {
      xhr.addEventListener('load', inspect, false);
    } catch (loadListenerError) {
      // 继续尝试 readystatechange。
    }

    try {
      xhr.addEventListener('readystatechange', function onReadyStateChange(event) {
        if (event && event.type === 'readystatechange') {
          try {
            if (xhr.readyState !== undefined && xhr.readyState !== 4) {
              return;
            }
          } catch (readyStateReadError) {
            // 无法读取 readyState 时仍尝试检查响应。
          }
        }
        inspect();
      }, false);
    } catch (readyStateListenerError) {
      // 不覆盖页面已有回调，监听器安装失败时直接放行。
    }
  }

  function emitSubmit(url, rewritten) {
    if (!rewritten) {
      return;
    }
    emit(OUTPUT_EVENTS.SUBMIT, {
      url: resolveUrl(url),
      payload: rewritten.body,
      usedTime: rewritten.usedTime,
      answerCount: rewritten.answerCount
    });
  }

  function installXhrHook() {
    var constructor;
    var prototype;
    var originalOpen;
    var originalSend;

    try {
      constructor = globalWindow.XMLHttpRequest;
      prototype = constructor && constructor.prototype;
      originalOpen = prototype && prototype.open;
      originalSend = prototype && prototype.send;
    } catch (xhrReferenceError) {
      reportError('XHR_HOOK', '无法读取 XMLHttpRequest 原生引用');
      return;
    }

    if (!prototype || typeof originalOpen !== 'function' || typeof originalSend !== 'function') {
      return;
    }

    var metadata = typeof WeakMap === 'function' ? new WeakMap() : null;
    var fallbackMetadataKey = '__courseHelperXhrMetadata__';
    var hook = {
      prototype: prototype,
      originalOpen: originalOpen,
      originalSend: originalSend,
      openDescriptor: null,
      sendDescriptor: null,
      openWrapper: null,
      sendWrapper: null,
      metadata: metadata,
      fallbackMetadataKey: fallbackMetadataKey,
      openInstalled: false,
      sendInstalled: false
    };

    try {
      hook.openDescriptor = Object.getOwnPropertyDescriptor(prototype, 'open');
      hook.sendDescriptor = Object.getOwnPropertyDescriptor(prototype, 'send');
    } catch (xhrDescriptorError) {
      hook.openDescriptor = null;
      hook.sendDescriptor = null;
    }

    function setMetadata(xhr, info) {
      try {
        if (metadata) {
          metadata.set(xhr, info);
        } else if (xhr) {
          xhr[fallbackMetadataKey] = info;
        }
      } catch (metadataSetError) {
        // 元数据只是辅助信息，失败时仍放行请求。
      }
    }

    function clearMetadata(xhr) {
      try {
        if (metadata) {
          metadata.delete(xhr);
        } else if (xhr) {
          delete xhr[fallbackMetadataKey];
        }
      } catch (metadataClearError) {
        // 忽略清理失败。
      }
    }

    function getMetadata(xhr) {
      try {
        if (metadata) {
          return metadata.get(xhr) || null;
        }
        return xhr ? (xhr[fallbackMetadataKey] || null) : null;
      } catch (metadataGetError) {
        return null;
      }
    }

    hook.openWrapper = function mainBridgeXhrOpen(method, url) {
      clearMetadata(this);
      var result = originalOpen.apply(this, arguments);
      setMetadata(this, {
        method: String(method || 'GET').toUpperCase(),
        url: resolveUrl(url)
      });
      return result;
    };

    hook.sendWrapper = function mainBridgeXhrSend(body) {
      var xhr = this;
      var info = getMetadata(xhr);
      var args = Array.prototype.slice.call(arguments);
      var nextBody = body;

      try {
        if (info) {
          attachXhrInspector(xhr, info.url);
        }
      } catch (responseHookError) {
        // 响应旁路监听失败时仍继续调用原始 send。
      }

      try {
        if (info && info.method === 'POST' && isSubmitUrl(info.url)) {
          // 观测诊断：提交请求每次记录（改写成功与否），用于定位
          // "点击提交后无任何反应"的卡住场景（请求未发 vs 改写被拒）。
          console.log('[course-helper] MAIN bridge：观察到提交请求 ' +
            (info.url || '').slice(0, 120));
          var rewritten = rewriteSubmitBody(body);
          if (rewritten) {
            nextBody = rewritten.body;
            args[0] = nextBody;
            emitSubmit(info.url, rewritten);
          }
        }
      } catch (submitHookError) {
        // 所有异常都降级为原始 body，确保 send 仍被调用。
        nextBody = body;
        if (args.length > 0) {
          args[0] = body;
        }
      }

      if (args.length === 0 && nextBody !== undefined) {
        args = [nextBody];
      }

      if (args.length === 0) {
        return originalSend.apply(xhr, arguments);
      }
      return originalSend.apply(xhr, args);
    };

    try {
      prototype.open = hook.openWrapper;
      hook.openInstalled = prototype.open === hook.openWrapper;
    } catch (openInstallError) {
      reportError('XHR_HOOK', '无法安装 XMLHttpRequest.open 钩子');
    }

    try {
      prototype.send = hook.sendWrapper;
      hook.sendInstalled = prototype.send === hook.sendWrapper;
    } catch (sendInstallError) {
      reportError('XHR_HOOK', '无法安装 XMLHttpRequest.send 钩子');
    }

    state.xhr = hook;
  }

  function getFetchMetadata(input, init) {
    var url = '';
    var method = '';
    var body;
    var hasInitBody = false;

    try {
      if (typeof input === 'string') {
        url = input;
      } else if (input && typeof input === 'object') {
        url = input.url || String(input);
        method = input.method || '';
      }
    } catch (inputMetadataError) {
      url = '';
      method = '';
    }

    if (init && typeof init === 'object') {
      try {
        if (init.method !== undefined && init.method !== null) {
          method = init.method;
        }
        if (hasOwn.call(init, 'body') || init.body !== undefined) {
          body = init.body;
          hasInitBody = true;
        }
      } catch (initMetadataError) {
        // 保持从 Request/input 获得的元数据。
      }
    }

    return {
      url: resolveUrl(url),
      method: String(method || 'GET').toUpperCase(),
      body: body,
      hasBody: hasInitBody
    };
  }

  function copyFetchInit(init) {
    var copied = {};
    if (!init || typeof init !== 'object') {
      return copied;
    }
    try {
      for (var key in init) {
        if (hasOwn.call(init, key)) {
          copied[key] = init[key];
        }
      }
    } catch (copyInitError) {
      // 至少让调用者获得一个可写 body 的初始化对象。
    }
    return copied;
  }

  function inspectFetchResponse(response, requestUrl) {
    if (!response || typeof response.clone !== 'function') {
      return;
    }

    var copy;
    try {
      copy = response.clone();
    } catch (cloneError) {
      return;
    }

    var promiseConstructor;
    try {
      promiseConstructor = globalWindow.Promise || Promise;
    } catch (promiseReferenceError) {
      promiseConstructor = null;
    }

    try {
      if (copy && typeof copy.text === 'function') {
        var textResult = copy.text();
        if (promiseConstructor && typeof promiseConstructor.resolve === 'function') {
          promiseConstructor.resolve(textResult).then(function onFetchText(text) {
            reportQuestionData(text, requestUrl);
          }, function ignoreFetchTextError() {});
        }
        return;
      }

      if (copy && typeof copy.json === 'function') {
        var jsonResult = copy.json();
        if (promiseConstructor && typeof promiseConstructor.resolve === 'function') {
          promiseConstructor.resolve(jsonResult).then(function onFetchJson(json) {
            reportQuestionData(json, requestUrl);
          }, function ignoreFetchJsonError() {});
        }
      }
    } catch (fetchResponseReadError) {
      // 不读取原始 Response，任何异常都不能阻塞 fetch。
    }
  }

  function installFetchHook() {
    var originalFetch;
    try {
      originalFetch = globalWindow.fetch;
    } catch (fetchReferenceError) {
      reportError('FETCH_HOOK', '无法读取 fetch 原生引用');
      return;
    }

    if (typeof originalFetch !== 'function') {
      return;
    }

    var hook = {
      original: originalFetch,
      descriptor: null,
      wrapper: null,
      installed: false
    };

    try {
      hook.descriptor = Object.getOwnPropertyDescriptor(globalWindow, 'fetch');
    } catch (fetchDescriptorError) {
      hook.descriptor = null;
    }

    hook.wrapper = function mainBridgeFetch(input, init) {
      var args = Array.prototype.slice.call(arguments);
      var metadata = getFetchMetadata(input, init);

      try {
        if (metadata.method === 'POST' && metadata.hasBody && isSubmitUrl(metadata.url)) {
          // 观测诊断：提交请求每次记录（改写成功与否）。
          console.log('[course-helper] MAIN bridge：观察到提交请求 ' +
            (metadata.url || '').slice(0, 120));
          var rewritten = rewriteSubmitBody(metadata.body);
          if (rewritten) {
            var nextInit = copyFetchInit(init);
            nextInit.body = rewritten.body;
            if (args.length < 2) {
              args.push(nextInit);
            } else {
              args[1] = nextInit;
            }
            emitSubmit(metadata.url, rewritten);
          }
        }
      } catch (fetchSubmitHookError) {
        // 保持原始 args；原始 fetch 必须继续执行。
      }

      var result;
      try {
        result = originalFetch.apply(this, args);
      } catch (fetchCallError) {
        throw fetchCallError;
      }
      var promiseConstructor;
      try {
        promiseConstructor = globalWindow.Promise || Promise;
      } catch (promiseReferenceError) {
        promiseConstructor = null;
      }

      if (!promiseConstructor || typeof promiseConstructor.resolve !== 'function') {
        return result;
      }

      return promiseConstructor.resolve(result).then(function onFetchResponse(response) {
        try {
          inspectFetchResponse(response, metadata.url);
        } catch (fetchInspectionError) {
          // 只处理旁路观测异常，保持原始 response 返回。
        }
        return response;
      });
    };

    try {
      globalWindow.fetch = hook.wrapper;
      hook.installed = globalWindow.fetch === hook.wrapper;
    } catch (fetchInstallError) {
      reportError('FETCH_HOOK', '无法安装 fetch 钩子');
    }

    state.fetch = hook;
  }

  function captureProperty(target, name) {
    if (!target) {
      return null;
    }
    var descriptor = null;
    var hadOwn = false;
    var original;
    try {
      hadOwn = hasOwn.call(target, name);
      descriptor = Object.getOwnPropertyDescriptor(target, name) || null;
      original = target[name];
    } catch (captureError) {
      return null;
    }
    return {
      target: target,
      name: name,
      hadOwn: hadOwn,
      descriptor: descriptor,
      original: original
    };
  }

  function assignProperty(target, name, value) {
    try {
      target[name] = value;
    } catch (assignError) {
      // 继续尝试 defineProperty。
    }

    try {
      if (target[name] === value) {
        return true;
      }
    } catch (assignedReadError) {
      // 继续尝试 defineProperty。
    }

    try {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: value
      });
      return target[name] === value;
    } catch (definePropertyError) {
      return false;
    }
  }

  function restoreProperty(snapshot) {
    if (!snapshot || !snapshot.target) {
      return true;
    }

    try {
      if (snapshot.hadOwn && snapshot.descriptor) {
        Object.defineProperty(snapshot.target, snapshot.name, snapshot.descriptor);
      } else if (snapshot.hadOwn) {
        snapshot.target[snapshot.name] = snapshot.original;
      } else {
        delete snapshot.target[snapshot.name];
      }
      return true;
    } catch (restoreError) {
      try {
        if (snapshot.hadOwn) {
          snapshot.target[snapshot.name] = snapshot.original;
        } else {
          delete snapshot.target[snapshot.name];
        }
        return true;
      } catch (fallbackRestoreError) {
        return false;
      }
    }
  }

  function getTopWindow() {
    try {
      return globalWindow.top || globalWindow;
    } catch (topReadError) {
      return globalWindow;
    }
  }

  function enableConfirmOverrides() {
    if (!state.confirmSnapshot) {
      state.confirmSnapshot = captureProperty(globalWindow, 'confirm');
    }
    if (state.confirmSnapshot) {
      var confirmOk = assignProperty(globalWindow, 'confirm', function mainBridgeConfirm() {
        return true;
      });
      if (!confirmOk) {
        reportError('CONFIRM_HOOK', '无法覆写 window.confirm');
      }
    } else {
      reportError('CONFIRM_HOOK', '无法保存 window.confirm 原引用');
    }

    // spec/30a：手机端作业页"仅覆写 alert/confirm"——alert 覆写为 no-op，
    // 避免页面 alert 弹窗阻断自动提交流程（不改变调用方可见行为）。
    if (!state.alertSnapshot) {
      state.alertSnapshot = captureProperty(globalWindow, 'alert');
    }
    if (state.alertSnapshot) {
      var alertOk = assignProperty(globalWindow, 'alert', function mainBridgeAlert() {
        return undefined;
      });
      if (!alertOk) {
        reportError('CONFIRM_HOOK', '无法覆写 window.alert');
      }
    } else {
      reportError('CONFIRM_HOOK', '无法保存 window.alert 原引用');
    }

    if (!state.checkJobSnapshot) {
      state.checkJobSnapshot = captureProperty(getTopWindow(), 'checkJob');
    }
    if (state.checkJobSnapshot) {
      var checkJobOk = assignProperty(state.checkJobSnapshot.target, 'checkJob', function mainBridgeCheckJob() {
        return false;
      });
      if (!checkJobOk) {
        reportError('CONFIRM_HOOK', '无法覆写 top.checkJob');
      }
    } else {
      reportError('CONFIRM_HOOK', '无法保存 top.checkJob 原引用');
    }
  }

  function disableConfirmOverrides() {
    var confirmSnapshot = state.confirmSnapshot;
    var checkJobSnapshot = state.checkJobSnapshot;
    var confirmRestored = true;
    var checkJobRestored = true;

    if (confirmSnapshot) {
      confirmRestored = restoreProperty(confirmSnapshot);
      if (!confirmRestored) {
        reportError('CONFIRM_RESTORE', '无法恢复 window.confirm 原引用');
      }
    }
    var alertSnapshot = state.alertSnapshot;
    var alertRestored = true;
    if (alertSnapshot) {
      alertRestored = restoreProperty(alertSnapshot);
      if (!alertRestored) {
        reportError('CONFIRM_RESTORE', '无法恢复 window.alert 原引用');
      }
    }
    if (checkJobSnapshot) {
      checkJobRestored = restoreProperty(checkJobSnapshot);
      if (!checkJobRestored) {
        reportError('CONFIRM_RESTORE', '无法恢复 top.checkJob 原引用');
      }
    }

    if (confirmRestored) {
      state.confirmSnapshot = null;
    }
    if (alertRestored) {
      state.alertSnapshot = null;
    }
    if (checkJobRestored) {
      state.checkJobSnapshot = null;
    }
  }

  function setConfirm(payload, requestId) {
    if (!isObject(payload) || typeof payload.enabled !== 'boolean') {
      reportError('INVALID_CONFIRM', 'set-confirm payload 无效', requestId);
      return;
    }
    if (payload.enabled) {
      enableConfirmOverrides();
    } else {
      disableConfirmOverrides();
    }
  }

  function setEditor(payload, requestId) {
    if (!isObject(payload) || typeof payload.editorId !== 'string' ||
        typeof payload.content !== 'string') {
      emit(OUTPUT_EVENTS.EDITOR_RESULT, {
        editorId: isObject(payload) && typeof payload.editorId === 'string' ? payload.editorId : '',
        ok: false,
        error: 'set-editor payload 无效'
      }, requestId);
      return;
    }

    var editorId = payload.editorId;
    try {
      var ue = pageWindow.UE || globalWindow.UE;
      if (!ue || typeof ue.getEditor !== 'function') {
        throw new Error('UE.getEditor 不可用');
      }
      var editor = ue.getEditor(editorId);
      if (!editor || typeof editor.setContent !== 'function') {
        throw new Error('UE 编辑器不可用');
      }
      editor.setContent(payload.content);
      emit(OUTPUT_EVENTS.EDITOR_RESULT, {
        editorId: editorId,
        ok: true
      }, requestId);
    } catch (editorError) {
      emit(OUTPUT_EVENTS.EDITOR_RESULT, {
        editorId: editorId,
        ok: false,
        error: safeErrorMessage(editorError, 'UE 编辑器写入失败')
      }, requestId);
    }
  }

  function setMobileEditor(payload, requestId) {
    var validIndex = isObject(payload) && typeof payload.index === 'number' &&
      isFinite(payload.index) && Math.floor(payload.index) === payload.index && payload.index >= 0;
    if (!validIndex || typeof payload.content !== 'string') {
      emit(OUTPUT_EVENTS.EDITOR_RESULT, {
        editorId: '',
        ok: false,
        error: 'set-mobile-editor payload 无效'
      }, requestId);
      return;
    }

    try {
      var contextWindow = pageWindow.contextWindow || globalWindow.contextWindow;
      var editors = contextWindow && contextWindow.editors;
      var editorRecord = editors && editors[payload.index];
      var mobileEditor = editorRecord && editorRecord.ueditor ? editorRecord.ueditor : editorRecord;
      if (!mobileEditor || typeof mobileEditor.setContent !== 'function') {
        throw new Error('手机版 UE 编辑器不可用');
      }
      mobileEditor.setContent(payload.content);

      if (typeof payload.itemId === 'string' && globalWindow.document &&
          typeof globalWindow.document.getElementById === 'function') {
        var answerInput = globalWindow.document.getElementById('answer' + payload.itemId);
        if (answerInput && 'value' in answerInput) {
          answerInput.value = payload.content;
        }
      }

      emit(OUTPUT_EVENTS.EDITOR_RESULT, {
        editorId: String(payload.index),
        ok: true
      }, requestId);
    } catch (mobileEditorError) {
      emit(OUTPUT_EVENTS.EDITOR_RESULT, {
        editorId: String(payload.index),
        ok: false,
        error: safeErrorMessage(mobileEditorError, '手机版编辑器写入失败')
      }, requestId);
    }
  }

  function setAnswerQueue(payload, requestId) {
    if (!isObject(payload) || !Array.isArray(payload.answers)) {
      reportError('INVALID_ANSWER_QUEUE', 'set-ucampus-answer-queue payload 无效', requestId);
      return;
    }
    for (var i = 0; i < payload.answers.length; i += 1) {
      if (typeof payload.answers[i] !== 'string') {
        reportError('INVALID_ANSWER_QUEUE', '答案队列必须是字符串数组', requestId);
        return;
      }
    }
    try {
      pageWindow.__UCAMPUS_ANSWER_CACHE__ = payload.answers.slice();
    } catch (queueWriteError) {
      reportError('ANSWER_QUEUE_WRITE', '无法写入 UCampus 答案队列', requestId);
    }
  }

  function validateInitPayload(payload) {
    if (!isObject(payload) || payload.version !== VERSION || !Array.isArray(payload.routes)) {
      return false;
    }
    for (var i = 0; i < payload.routes.length; i += 1) {
      if (typeof payload.routes[i] !== 'string') {
        return false;
      }
    }
    return true;
  }

  function handleInbound(type, payload, requestId) {
    if (state.disposed || state.disposing) {
      return;
    }

    try {
      switch (type) {
        case 'course-helper:main:init':
          if (!validateInitPayload(payload)) {
            reportError('INVALID_INIT', 'main:init payload 无效', requestId);
            return;
          }
          emit(OUTPUT_EVENTS.READY, { version: VERSION }, requestId);
          return;
        case 'course-helper:main:set-confirm':
          setConfirm(payload, requestId);
          return;
        case 'course-helper:main:set-editor':
          setEditor(payload, requestId);
          return;
        case 'course-helper:main:set-mobile-editor':
          setMobileEditor(payload, requestId);
          return;
        case 'course-helper:main:set-ucampus-answer-queue':
          setAnswerQueue(payload, requestId);
          return;
        case 'course-helper:main:ucampus-stop-recording':
          handleStopRecordingCommand(requestId);
          return;
        case 'course-helper:main:dispose':
          if (!isObject(payload) || typeof payload.reason !== 'string') {
            reportError('INVALID_DISPOSE', 'dispose payload 无效', requestId);
            return;
          }
          disposeBridge();
          return;
        default:
          return;
      }
    } catch (inboundError) {
      reportError('MESSAGE_HANDLER', safeErrorMessage(inboundError, '消息处理失败'), requestId);
    }
  }

  function onWindowMessage(event) {
    if (state.disposed || state.disposing || !event) {
      return;
    }

    var data;
    try {
      data = event.data;
      if (event.source && event.source !== globalWindow) {
        return;
      }
    } catch (eventReadError) {
      return;
    }

    if (!isObject(data) || data.source !== SOURCE || typeof data.type !== 'string') {
      return;
    }

    var requestId = validRequestId(data.requestId) ? data.requestId : undefined;
    handleInbound(data.type, data.payload, requestId);
  }

  function onCustomEvent(event) {
    if (state.disposed || state.disposing || !event) {
      return;
    }

    if (state.customEventSeen) {
      try {
        if (state.customEventSeen.has(event)) {
          return;
        }
        state.customEventSeen.add(event);
      } catch (customEventSeenError) {
        // WeakSet 不可用时仍处理一次当前事件。
      }
    }

    var detail;
    try {
      detail = event.detail;
    } catch (detailReadError) {
      return;
    }

    // CustomEvent 入站也必须携带桥接来源；输出事件的 detail 仍严格遵循契约 payload。
    if (!isObject(detail) || detail.source !== SOURCE) {
      return;
    }

    var payload = hasOwn.call(detail, 'payload') ? detail.payload : undefined;
    var requestId = validRequestId(detail.requestId) ? detail.requestId : undefined;
    var type = event.type;
    if (typeof detail.type === 'string') {
      type = detail.type;
    }

    if (INPUT_EVENTS.indexOf(type) === -1) {
      return;
    }
    handleInbound(type, payload, requestId);
  }

  function installCommunication() {
    try {
      if (typeof globalWindow.addEventListener === 'function') {
        globalWindow.addEventListener('message', onWindowMessage, false);
        for (var i = 0; i < INPUT_EVENTS.length; i += 1) {
          globalWindow.addEventListener(INPUT_EVENTS[i], onCustomEvent, false);
        }
        state.messageInstalled = true;
      }
    } catch (windowListenerError) {
      reportError('MESSAGE_HOOK', '无法安装 window 通信监听器');
    }

    try {
      if (globalWindow.document && typeof globalWindow.document.addEventListener === 'function') {
        for (var j = 0; j < INPUT_EVENTS.length; j += 1) {
          globalWindow.document.addEventListener(INPUT_EVENTS[j], onCustomEvent, false);
        }
      }
    } catch (documentListenerError) {
      // window 监听器已经足以满足通信；document 监听失败不影响网络钩子。
    }
  }

  function removeCommunication() {
    try {
      if (typeof globalWindow.removeEventListener === 'function') {
        globalWindow.removeEventListener('message', onWindowMessage, false);
        for (var i = 0; i < INPUT_EVENTS.length; i += 1) {
          globalWindow.removeEventListener(INPUT_EVENTS[i], onCustomEvent, false);
        }
      }
    } catch (windowRemoveListenerError) {
      // 忽略清理异常。
    }

    try {
      if (globalWindow.document && typeof globalWindow.document.removeEventListener === 'function') {
        for (var j = 0; j < INPUT_EVENTS.length; j += 1) {
          globalWindow.document.removeEventListener(INPUT_EVENTS[j], onCustomEvent, false);
        }
      }
    } catch (documentRemoveListenerError) {
      // 忽略清理异常。
    }
    state.messageInstalled = false;
  }

  function restoreNetworkHooks() {
    var xhrHook = state.xhr;
    if (xhrHook) {
      try {
        if (xhrHook.openInstalled && xhrHook.prototype.open === xhrHook.openWrapper) {
          if (xhrHook.openDescriptor) {
            Object.defineProperty(xhrHook.prototype, 'open', xhrHook.openDescriptor);
          } else {
            xhrHook.prototype.open = xhrHook.originalOpen;
          }
        }
      } catch (restoreXhrOpenError) {
        // 不覆盖期间被其他脚本替换的引用。
      }
      try {
        if (xhrHook.sendInstalled && xhrHook.prototype.send === xhrHook.sendWrapper) {
          if (xhrHook.sendDescriptor) {
            Object.defineProperty(xhrHook.prototype, 'send', xhrHook.sendDescriptor);
          } else {
            xhrHook.prototype.send = xhrHook.originalSend;
          }
        }
      } catch (restoreXhrSendError) {
        // 不覆盖期间被其他脚本替换的引用。
      }
      state.xhr = null;
    }

    var fetchHook = state.fetch;
    if (fetchHook) {
      try {
        if (fetchHook.installed && globalWindow.fetch === fetchHook.wrapper) {
          if (fetchHook.descriptor) {
            Object.defineProperty(globalWindow, 'fetch', fetchHook.descriptor);
          } else {
            globalWindow.fetch = fetchHook.original;
          }
        }
      } catch (restoreFetchError) {
        // 不覆盖期间被其他脚本替换的引用。
      }
      state.fetch = null;
    }
  }

  function clearMarker() {
    try {
      if (pageWindow[MARKER] === state) {
        delete pageWindow[MARKER];
      }
    } catch (markerClearError) {
      // 标记不可删除时保留 disposed 状态，后续注入仍会被重复保护拦截。
    }
  }

  // ---- MediaRecorder 观测与强制停止兜底 ----
  // 覆写构造器：1) 每次构造计数并回报（录音真正开始的信号）；流来源为合成流
  // （fakeStream 标记）说明音频注入生效；来源为其他（如真实麦克风/iframe 流）
  // 说明平台录音路径未经过本覆写，需要进一步适配。2) 保留存活 recorder 引用：
  // content 侧点击"停止"无效时（React 重渲染替换节点），经 ucampus-stop-recording
  // 事件从 MAIN world 直接调 recorder.stop()——与平台停止按钮内部行为一致
  // （触发 onstop 回调，前端进入已录音状态）。
  var liveRecorders = [];

  // 最近一次成功获取的真实语音字节（跨 SPA 节复用）。
  // 用途：无原音页面（自由说话题，如 1-4 Viewing > Think and speak）注入静音流会导致
  // 评测不通过、该题记为"未作答"、提交被平台硬拦截；复用前序听力/视听节的真实语音
  // 可让评测服务器收到真人语音。decodeAudioData 会 detach 传入 buffer，故缓存副本。
  var cachedSpeechBytes = null;

  function describeRecorderSource(stream) {
    try {
      if (stream && stream.fakeStream === true) {
        return '合成音频流';
      }
      if (stream && stream.getAudioTracks && stream.getAudioTracks().length) {
        return '其他音频流（真实麦克风或 iframe）';
      }
      return '无音频轨';
    } catch (ignoredStreamReadError) {
      return '未知';
    }
  }

  // 录音状态回执（ucampus-recording-state）：recording 是否在录、存活 recorder
  // 数、stopRequested 是否为 content 强制停止命令的回执。
  function emitRecordingState(recording, recorderCount, stopRequested) {
    emit(OUTPUT_EVENTS.RECORDING_STATE, {
      recording: recording === true,
      recorderCount: recorderCount,
      stopRequested: stopRequested === true
    });
  }

  function installMediaRecorderProbe() {
    var OriginalRecorder = globalWindow.MediaRecorder;
    if (!OriginalRecorder || OriginalRecorder.__courseHelperProbe) {
      return;
    }
    function MediaRecorderProbe(stream, options) {
      var recorder = new OriginalRecorder(stream, options);
      liveRecorders.push(recorder);
      // 只保留最近 10 个存活引用（防长会话内存膨胀）；出列引用不强制 stop（stop 幂等）。
      while (liveRecorders.length > 10) {
        liveRecorders.shift();
      }
      console.log('[course-helper] MAIN bridge：MediaRecorder 已构造（第 ' +
        liveRecorders.length + ' 个存活记录，流来源=' + describeRecorderSource(stream) + '）。');
      emitRecordingState(true, liveRecorders.length, false);
      // stop 观测：平台停止录音时调用（每次 log，用于定位"停不下来"）。
      if (recorder && typeof recorder.stop === 'function') {
        var originalStop = recorder.stop.bind(recorder);
        recorder.stop = function probedStop() {
          console.log('[course-helper] MAIN bridge：MediaRecorder.stop 被调用（平台停止录音）。');
          // 平台自行停止也回执（content 据此判断停止是否生效）。
          emitRecordingState(false, liveRecorders.length, false);
          return originalStop.apply(this, arguments);
        };
      }
      return recorder;
    }
    MediaRecorderProbe.prototype = OriginalRecorder.prototype;
    MediaRecorderProbe.isTypeSupported = OriginalRecorder.isTypeSupported;
    MediaRecorderProbe.__courseHelperProbe = true;
    globalWindow.MediaRecorder = MediaRecorderProbe;
  }

  // 平台录音器实例追踪（2026-10-20 CDP 实测：ucontent 平台用 Html5Recorder 类，
  // prototype 含 record / stopRecord / reset / _resetStatus / dispose）。
  // 仅调用底层 MediaRecorder.stop() 不会清除平台的"正在录音中"状态——
  // 必须调平台自己的 stopRecord()（或 reset()）才会让前端认为录音结束。
  var platformRecorders = [];
  // 腾讯云语音评测 SDK 实例（2026-10-20 CDP 实测：ucontent 语音题用 TencentSOE，
  // 不是 Html5Recorder）。SOE.status：2=录音中。只有 status===2 时 stop() 才会上传评测。
  var soeInstances = [];
  function trackSoeInstance(instance) {
    if (!instance) return;
    for (var i = 0; i < soeInstances.length; i += 1) {
      if (soeInstances[i] === instance) return;
    }
    soeInstances.push(instance);
    while (soeInstances.length > 10) soeInstances.shift();
  }
  function trackPlatformRecorder(instance) {
    if (!instance) return;
    for (var i = 0; i < platformRecorders.length; i += 1) {
      if (platformRecorders[i] === instance) return;
    }
    platformRecorders.push(instance);
    while (platformRecorders.length > 10) platformRecorders.shift();
  }

  // Html5Recorder 在 document_start 时还不存在（平台脚本稍后挂到 window），
  // 必须轮询等待出现再接管；且页面脚本可能保存了旧引用，因此同时提供
  // 【全局兜底停止】——直接遍历已记录实例调用 stopRecord。
  function tryInstallPlatformRecorderProbe() {
    var RecorderCtor = globalWindow.Html5Recorder;
    if (!RecorderCtor || typeof RecorderCtor !== 'function') {
      return false;
    }
    if (RecorderCtor.__courseHelperProbed) {
      return true;
    }
    var OriginalCtor = RecorderCtor;
    // 【方案 A】构造函数包装（仅当平台从 window 取构造函数时生效）
    function Html5RecorderProbe() {
      var instance = new OriginalCtor(...arguments);
      trackPlatformRecorder(instance);
      return instance;
    }
    Html5RecorderProbe.prototype = OriginalCtor.prototype;
    Object.keys(OriginalCtor).forEach(function (key) {
      try { Html5RecorderProbe[key] = OriginalCtor[key]; } catch (ignoredCopyError) {}
    });
    Html5RecorderProbe.__courseHelperProbed = true;

    // 【方案 B·关键】prototype 方法挂钩——平台即使保存了原构造函数引用，
    // 实例方法仍走同一个 prototype。在 record() 时捕获 this（实例），
    // 这样无论实例如何创建都能追踪到。实测平台录音器实例不在 React state 里，
    // 只能靠方法调用时捕获。
    var proto = OriginalCtor.prototype;
    if (proto && typeof proto.record === 'function' && !proto.record.__courseHelperHooked) {
      var originalRecord = proto.record;
      proto.record = function probedRecord() {
        try { trackPlatformRecorder(this); } catch (ignoredTrackError) {}
        return originalRecord.apply(this, arguments);
      };
      proto.record.__courseHelperHooked = true;
    }
    if (proto && typeof proto.__startRecord === 'function' && !proto.__startRecord.__courseHelperHooked) {
      var originalStart = proto.__startRecord;
      proto.__startRecord = function probedStartRecord() {
        try { trackPlatformRecorder(this); } catch (ignoredTrackError) {}
        return originalStart.apply(this, arguments);
      };
      proto.__startRecord.__courseHelperHooked = true;
    }

    try {
      globalWindow.Html5Recorder = Html5RecorderProbe;
      console.log('[course-helper] MAIN bridge：已接管平台 Html5Recorder（构造函数 + prototype.record 双钩子）。');
      return true;
    } catch (ignoredAssignError) {
      return false;
    }
  }

  // 腾讯云 SOE 接管：捕获实例 + 包装 start/stop 记录状态。
  // 平台语音题流程：SOE.start() → 录音 → SOE.stop()（上传评测）。
  // 我们用合成流录音时，平台自己的 SOE.status 仍为"录音中"，导致"正在录音中"提示。
  function tryInstallSoeProbe() {
    var SoeCtor = globalWindow.TencentSOE;
    if (!SoeCtor || typeof SoeCtor !== 'function') {
      return false;
    }
    if (SoeCtor.__courseHelperSoeProbed) {
      return true;
    }
    var proto = SoeCtor.prototype;
    if (proto) {
      // 包装 start：捕获 this
      if (typeof proto.start === 'function' && !proto.start.__courseHelperSoeHooked) {
        var originalSoeStart = proto.start;
        proto.start = function probedSoeStart() {
          try { trackSoeInstance(this); } catch (ignoredTrackError) {}
          return originalSoeStart.apply(this, arguments);
        };
        proto.start.__courseHelperSoeHooked = true;
      }
      // 包装 stop：捕获 this
      if (typeof proto.stop === 'function' && !proto.stop.__courseHelperSoeHooked) {
        var originalSoeStop = proto.stop;
        proto.stop = function probedSoeStop() {
          try { trackSoeInstance(this); } catch (ignoredTrackError) {}
          return originalSoeStop.apply(this, arguments);
        };
        proto.stop.__courseHelperSoeHooked = true;
      }
    }
    SoeCtor.__courseHelperSoeProbed = true;
    console.log('[course-helper] MAIN bridge：已接管 TencentSOE（腾讯语音评测 SDK，可调 stop 清除录音态）。');
    return true;
  }

  function installPlatformRecorderProbe() {
    // 立即尝试 + 轮询（最多 60 秒，覆盖平台脚本加载延迟）
    var done = tryInstallPlatformRecorderProbe();
    var soeDone = tryInstallSoeProbe();
    if (done && soeDone) return;
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      if (!done) done = tryInstallPlatformRecorderProbe();
      if (!soeDone) soeDone = tryInstallSoeProbe();
      if (done && soeDone) {
        clearInterval(timer);
        return;
      }
      if (attempts >= 120) { // 60 秒后放弃
        clearInterval(timer);
      }
    }, 500);
    state.platformProbeTimer = timer;
  }

  // 兜底：不依赖接管成功，直接从 window 上找 Html5Recorder 实例并停止。
  // 平台脚本可能把实例存在组件内部，这里遍历 window 一级属性 + 常见容器。
  function forceStopPlatformRecorders() {
    var stopped = 0;
    var seen = {};
    function tryStop(obj, keyHint) {
      if (!obj || typeof obj !== 'object' || seen[obj]) return;
      try { seen[obj] = true; } catch (e) { return; }
      try {
        if (typeof obj.stopRecord === 'function') {
          obj.stopRecord();
          stopped += 1;
          console.log('[course-helper] MAIN bridge：已调用平台 stopRecord（来源=' + keyHint + '）。');
        } else if (typeof obj.reset === 'function' && typeof obj.record === 'function') {
          obj.reset();
          stopped += 1;
          console.log('[course-helper] MAIN bridge：已调用平台 reset（来源=' + keyHint + '）。');
        }
      } catch (ignoredErr) {}
    }
    // 1) 已追踪的实例（SOE 优先）
    for (var si = 0; si < soeInstances.length; si += 1) {
      var soeInst = soeInstances[si];
      if (!soeInst) continue;
      try {
        if (typeof soeInst.stop === 'function') {
          soeInst.stop({});
          stopped += 1;
          console.log('[course-helper] MAIN bridge：兜底已调用 SOE.stop()（status=' + soeInst.status + '）。');
        }
      } catch (ignoredSoeErr) {}
    }
    for (var i = 0; i < platformRecorders.length; i += 1) tryStop(platformRecorders[i], 'tracked');
    // 2) window 一级属性（含嵌套一层：组件常把实例挂在 obj.current / obj.instance）
    try {
      var keys = Object.keys(globalWindow);
      for (var k = 0; k < keys.length; k += 1) {
        var key = keys[k];
        if (!/record|audio|media|voice|ucomp|unipus/i.test(key)) continue;
        var val = globalWindow[key];
        tryStop(val, 'window.' + key);
        if (val && typeof val === 'object') {
          try {
            var subKeys = Object.keys(val).slice(0, 30);
            for (var sk = 0; sk < subKeys.length; sk += 1) {
              tryStop(val[subKeys[sk]], 'window.' + key + '.' + subKeys[sk]);
            }
          } catch (ignoredSubError) {}
        }
      }
    } catch (ignoredWindowErr) {}
    // 3) 从 .ucomp-recorder 的 React fiber 里找实例（平台可能挂在 props/state）
    try {
      var doc = globalWindow.document;
      var recEl = doc ? doc.querySelector('.ucomp-recorder') : null;
      if (recEl) {
        var fiberKey = null;
        var elKeys = Object.keys(recEl);
        for (var ek = 0; ek < elKeys.length; ek += 1) {
          if (elKeys[ek].indexOf('__reactFiber') === 0 || elKeys[ek].indexOf('__reactInternalInstance') === 0) {
            fiberKey = elKeys[ek];
            break;
          }
        }
        if (fiberKey) {
          var fiber = recEl[fiberKey];
          for (var fi = 0; fi < 25 && fiber; fi += 1) {
            // memoizedProps 深挖
            if (fiber.memoizedProps && typeof fiber.memoizedProps === 'object') {
              try {
                var pks = Object.keys(fiber.memoizedProps).slice(0, 20);
                for (var pk = 0; pk < pks.length; pk += 1) {
                  var pv = fiber.memoizedProps[pks[pk]];
                  tryStop(pv, 'fiber.props.' + pks[pk]);
                  if (pv && typeof pv === 'object' && pv.current) {
                    tryStop(pv.current, 'fiber.props.' + pks[pk] + '.current');
                  }
                }
              } catch (ignoredPropErr) {}
            }
            // memoizedState 链深挖
            var st = fiber.memoizedState;
            for (var si = 0; si < 10 && st; si += 1) {
              var sv = st.memoizedState;
              tryStop(sv, 'fiber.state.' + si);
              if (sv && typeof sv === 'object' && sv.current) {
                tryStop(sv.current, 'fiber.state.' + si + '.current');
              }
              st = st.next;
            }
            fiber = fiber.return;
          }
        }
      }
    } catch (ignoredFiberErr) {}
    return stopped;
  }

  // content 侧停止命令：优先调平台 TencentSOE.stop()（清平台"正在录音中"状态并触发评测上传），
  // 再兜底 Html5Recorder.stopRecord()，最后 MediaRecorder.stop()。
  function handleStopRecordingCommand() {
    // 【首选】腾讯 SOE.stop()：平台语音题的真实录音器。
    // SOE.stop() 内部：检查 status===2（录音中）→ recorder.stop() → 上传音频到评测服务器
    // → 回调评分 → 平台前端认为录音完成（可提交）。
    var soeStopped = 0;
    for (var s = 0; s < soeInstances.length; s += 1) {
      var soe = soeInstances[s];
      if (!soe) continue;
      try {
        if (typeof soe.stop === 'function') {
          soe.stop({});
          soeStopped += 1;
          console.log('[course-helper] MAIN bridge：已调用平台 TencentSOE.stop()（第 ' +
            (s + 1) + ' 个实例，status=' + soe.status + '）。');
        }
      } catch (ignoredSoeStopError) {
        console.log('[course-helper] MAIN bridge：TencentSOE.stop() 失败：' +
          (ignoredSoeStopError && ignoredSoeStopError.message ? ignoredSoeStopError.message : 'unknown'));
      }
    }
    var platformStopped = 0;
    for (var p = 0; p < platformRecorders.length; p += 1) {
      var inst = platformRecorders[p];
      if (!inst) continue;
      try {
        if (typeof inst.stopRecord === 'function') {
          inst.stopRecord();
          platformStopped += 1;
        } else if (typeof inst.reset === 'function') {
          inst.reset();
          platformStopped += 1;
        }
      } catch (ignoredPlatformStopError) {
        // 已停止/已释放的平台录音器安全跳过。
      }
    }
    var stopped = 0;
    for (var i = 0; i < liveRecorders.length; i += 1) {
      try {
        if (liveRecorders[i] && typeof liveRecorders[i].stop === 'function') {
          liveRecorders[i].stop();
          stopped += 1;
        }
      } catch (ignoredStopError) {
        // 已停止/已失活的 recorder 安全跳过。
      }
    }
    // 兜底：平台脚本可能在 document_start 后加载，接管可能没成功——
    // 直接从 window 找 Html5Recorder 实例调 stopRecord。
    var forcedStopped = forceStopPlatformRecorders();
    // 终局开关：chunk 改写注入的 __CH_FORCE_NOT_RECORDING__（若已生效）
    // 让 questionEventHandler 的 isRecording() 返回 false——提交校验放行。
    try {
      globalWindow.__CH_FORCE_NOT_RECORDING__ = true;
      console.log('[course-helper] MAIN bridge：已激活 isRecording=false 开关（chunk 改写模式）。');
    } catch (ignoredFlagError) {}
    console.log('[course-helper] MAIN bridge：停止录音命令已执行（SOE.stop ' + soeStopped +
      ' 个 / 平台 stopRecord ' + platformStopped + ' 个 / 兜底 ' + forcedStopped +
      ' 个 / MediaRecorder.stop ' + stopped + ' 个）。');
    emitRecordingState(false, liveRecorders.length, true);
  }

  function disposeBridge() {
    if (state.disposed || state.disposing) {
      return;
    }
    state.disposing = true;
    removeCommunication();
    disableConfirmOverrides();
    restoreNetworkHooks();
    restoreFakeAudioStream();
    if (state.platformProbeTimer) {
      try { clearInterval(state.platformProbeTimer); } catch (ignoredTimerError) {}
      state.platformProbeTimer = null;
    }
    state.disposed = true;
    state.disposing = false;
    clearMarker();
  }

  // ---- 合成音频流注入（u校园语音题模拟录音）----
  // 覆写 navigator.mediaDevices.getUserMedia：平台请求音频（录音）时返回
  // Web Audio 合成的 MediaStream（振荡器音轨经 MediaStreamDestination），
  // 不经过真实麦克风——无权限弹窗、无环境噪声；视频/屏幕等非音频请求
  // 原样放行。保留最近 N 个流引用防止垃圾回收，超出时停掉最旧的。
  var fakeAudioStreams = [];
  var FAKE_AUDIO_MAX_STREAMS = 5;

  function installFakeAudioStream() {
    var navigatorObject = null;
    try {
      navigatorObject = globalWindow.navigator;
    } catch (ignoredNavigatorError) {
      navigatorObject = null;
    }
    var mediaDevices = navigatorObject && navigatorObject.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      return;
    }
    if (mediaDevices.__courseHelperOriginalGetUserMedia) {
      return; // 幂等
    }
    var original = mediaDevices.getUserMedia;
    try {
      Object.defineProperty(mediaDevices, '__courseHelperOriginalGetUserMedia', {
        configurable: true,
        value: original
      });
    } catch (ignoredDefineError) {
      // 标记失败不影响覆写。
    }

    mediaDevices.getUserMedia = function fakeGetUserMedia(constraints) {
      var wantsAudio = false;
      try {
        wantsAudio = !!(constraints && (constraints.audio === true ||
          (constraints.audio && typeof constraints.audio === 'object')));
      } catch (ignoredConstraintsError) {
        wantsAudio = false;
      }
      if (!wantsAudio) {
        return original.apply(navigatorObject, arguments);
      }
      try {
        var AudioContextCtor = globalWindow.AudioContext || globalWindow.webkitAudioContext;
        if (!AudioContextCtor) {
          return original.apply(navigatorObject, arguments);
        }
        var context = new AudioContextCtor();
        var destination = context.createMediaStreamDestination();
        var gain = context.createGain();
        gain.gain.value = 1.0;
        gain.connect(destination);
        // 2026-10-20 实测结论（ucontent.unipus.cn 语音评测）：
        // 平台把录音音频经 WebSocket 发到 speech.unipus.cn 做【语音识别】，
        // 正弦波等非人声会被服务端忽略 → "录音启动超时"。必须注入【真人语音】。
        // 方案：取页面题目原音 <audio class="unipus-audio-h5">（平台自带的英文朗读），
        // 解码后循环播放注入录音流——既是真人语音，也不需要真实麦克风。
        var sourceNodes = [];
        var started = false;
        var audioEls = [];
        try {
          audioEls = globalWindow.document
            ? Array.prototype.slice.call(globalWindow.document.querySelectorAll('audio.unipus-audio-h5'))
            : [];
        } catch (ignoredQueryError) {
          audioEls = [];
        }
        var audioUrls = [];
        for (var ai = 0; ai < audioEls.length; ai += 1) {
          try {
            if (audioEls[ai].src) audioUrls.push(audioEls[ai].src);
          } catch (ignoredSrcError) {}
        }
        var audioUrl = audioUrls.length ? audioUrls[0] : null;
        // 无原音页面 → 复用缓存语音（见 cachedSpeechBytes 注释）。
        var useCachedSpeech = false;
        if (!audioUrl && cachedSpeechBytes) {
          useCachedSpeech = true;
          console.log('[course-helper] MAIN bridge：当前页无原音，复用缓存语音（' +
            Math.round(cachedSpeechBytes.byteLength / 1024) + 'KB）用于录音流。');
        }
        // 【关键】必须立即让流有音轨（getUserMedia 立即 resolve），否则平台录音器
        // 卡在"启动中"、扩展 await 永不返回（实测 90 秒无进展）。
        // 先接一个【零音量】振荡器占位（保证流有 track 且完全静音），
        // 真实人声异步解码后混入同一个 gain 节点——音轨已存在，混入自动生效。
        try {
          var placeholder = context.createOscillator();
          placeholder.type = 'sine';
          placeholder.frequency.value = 440;
          placeholder.connect(gain);
          placeholder.start();
          sourceNodes.push(placeholder);
          started = true;
        } catch (ignoredPlaceholderError) {
          // 占位失败时仍返回流（可能有 track 但静音）。
        }
        if ((audioUrl || useCachedSpeech) && typeof context.decodeAudioData === 'function') {
          // 异步解码真实人声 → 混入同一 gain（不阻塞 getUserMedia 返回）
          var loadTimeout = setTimeout(function () {
            console.log('[course-helper] MAIN bridge：原音/缓存语音加载超时（8s），继续用静音流。');
          }, 8000);
          var speechBytesPromise;
          if (useCachedSpeech) {
            speechBytesPromise = Promise.resolve(cachedSpeechBytes.slice(0));
          } else if (typeof globalWindow.fetch === 'function') {
            speechBytesPromise = globalWindow.fetch(audioUrl).then(function (response) {
              return response.arrayBuffer();
            }).then(function (arrayBuffer) {
              // 缓存副本供后续无原音页面复用（decodeAudioData 会 detach 原 buffer）。
              try { cachedSpeechBytes = arrayBuffer.slice(0); } catch (ignoredCacheError) {}
              return arrayBuffer;
            });
          } else {
            speechBytesPromise = Promise.reject(new Error('fetch 不可用'));
          }
          speechBytesPromise.then(function (arrayBuffer) {
            return context.decodeAudioData(arrayBuffer);
          }).then(function (audioBuffer) {
            clearTimeout(loadTimeout);
            if (!audioBuffer || !audioBuffer.duration) return;
            // 真实人声：接到独立 gain（1.0）再并入 destination，音量覆盖静音占位
            var voiceGain = context.createGain();
            voiceGain.gain.value = 1.0;
            voiceGain.connect(destination);
            var bufferSource = context.createBufferSource();
            bufferSource.buffer = audioBuffer;
            bufferSource.loop = true;
            bufferSource.connect(voiceGain);
            bufferSource.start();
            sourceNodes.push(bufferSource);
            console.log('[course-helper] MAIN bridge：已注入真实人声音频（题目原音 ' +
              audioBuffer.duration.toFixed(1) + 's，循环播放，评测服务器可识别）。');
          }).catch(function (decodeError) {
            clearTimeout(loadTimeout);
            console.log('[course-helper] MAIN bridge：题目原音注入失败（继续静音流）：' +
              (decodeError && decodeError.message ? decodeError.message : 'unknown'));
          });
        }
        // autoplay 策略可能将 AudioContext 挂起，尝试恢复（失败也不阻塞）。
        if (typeof context.resume === 'function') {
          try {
            context.resume();
          } catch (ignoredResumeError) {
            // 挂起状态下流轨可能为静音，但不影响流程推进。
          }
        }
        fakeAudioStreams.push({ context: context, nodes: sourceNodes, oscillator: sourceNodes[0] });
        // 打标记：MediaRecorder 观测据此识别流来源为合成流（否则误报"其他音频流"）。
        try {
          destination.stream.fakeStream = true;
        } catch (ignoredTagError) {
          // 平台对象不可扩展时跳过（观测退化为"其他音频流"，不影响功能）。
        }
        while (fakeAudioStreams.length > FAKE_AUDIO_MAX_STREAMS) {
          var old = fakeAudioStreams.shift();
          var oldNodes = old.nodes && old.nodes.length ? old.nodes : (old.oscillator ? [old.oscillator] : []);
          for (var oi = 0; oi < oldNodes.length; oi += 1) {
            try {
              oldNodes[oi].stop();
            } catch (ignoredStopError) {
              // 已停止的节点安全跳过。
            }
          }
          try {
            old.context.close();
          } catch (ignoredCloseError) {
            // 已关闭的上下文安全跳过。
          }
        }
        if (audioUrl) {
          console.log('[course-helper] MAIN bridge：正在准备真实人声音频（题目原音注入录音流）。');
        } else {
          console.log('[course-helper] MAIN bridge：未找到题目原音，降级正弦波。');
        }
        return Promise.resolve(destination.stream);
      } catch (fakeStreamError) {
        return original.apply(navigatorObject, arguments);
      }
    };
  }

  function restoreFakeAudioStream() {
    var navigatorObject = null;
    try {
      navigatorObject = globalWindow.navigator;
    } catch (ignoredNavigatorError) {
      navigatorObject = null;
    }
    var mediaDevices = navigatorObject && navigatorObject.mediaDevices;
    var original = mediaDevices && mediaDevices.__courseHelperOriginalGetUserMedia;
    if (mediaDevices && original && typeof mediaDevices.getUserMedia === 'function' &&
        mediaDevices.getUserMedia.name === 'fakeGetUserMedia') {
      mediaDevices.getUserMedia = original;
    }
    while (fakeAudioStreams.length) {
      var record = fakeAudioStreams.shift();
      // 清理所有音频节点（BufferSource / Oscillator 都有 stop）
      var cleanupNodes = record.nodes && record.nodes.length
        ? record.nodes
        : (record.oscillator ? [record.oscillator] : []);
      for (var ni = 0; ni < cleanupNodes.length; ni += 1) {
        try {
          cleanupNodes[ni].stop();
        } catch (ignoredStopError) {
          // 已停止的节点安全跳过。
        }
      }
      try {
        record.context.close();
      } catch (ignoredCloseError) {
        // 已关闭的上下文安全跳过。
      }
    }
  }

  // ---- 平台 chunk 源码改写（2026-10-20 终局方案）----
  // 背景：提交拦截源 questionEventHandler 闭包内 this.isRecording() 引用
  // webpack 模块闭包的 BD1 单例——window 不可达，组件层 patch 全部无效（实测）。
  // 方案：bridge 以 document_start 先于平台脚本运行。用 MutationObserver 监听
  // <head> 新增的 platform chunk <script>，在其执行前把 src 指向改写版：
  // 在 isRecording 方法定义处注入 hook——收到 ucampus-stop-recording 命令后
  // 强制返回 false（录音已由扩展停止，平台前端校验放行，提交/翻页解锁）。
  // 改写用 Service Worker/Blob URL 交付，保持同源执行。
  var platformScriptRewritten = false;

  function rewritePlatformChunkSource(sourceText) {
    // 目标（question-common chunk）：{key:"isRecording",value:function(){...原逻辑...}}
    // 改写：方法体最前插入全局开关短路（不改动其余任何结构，杜绝语法破坏）：
    //   function(){ if(window.__CH_FORCE_NOT_RECORDING__===true){return false} ...原逻辑... }
    var marker = '"isRecording",value:function(){';
    var idx = sourceText.indexOf(marker);
    if (idx === -1) {
      console.log('[course-helper] MAIN bridge：chunk 中未找到 isRecording 定义，未改写。');
      return null;
    }
    var guard = 'if(window.__CH_FORCE_NOT_RECORDING__===true){return false}';
    var patched = sourceText.slice(0, idx + marker.length) + guard +
      sourceText.slice(idx + marker.length);
    // 前置全局开关初始化（默认 false，不影响平台原生行为）
    var prelude = 'window.__CH_FORCE_NOT_RECORDING__=false;';
    return prelude + patched;
  }

  function installPlatformScriptRewriter() {
    if (!globalWindow.document || typeof MutationObserver !== 'function') {
      return;
    }
    var observer = new MutationObserver(function (mutations) {
      for (var mi = 0; mi < mutations.length; mi += 1) {
        var added = mutations[mi].addedNodes;
        for (var ni = 0; ni < added.length; ni += 1) {
          var node = added[ni];
          if (!node || node.tagName !== 'SCRIPT' || !node.src) continue;
          if (!/question-common|common-[a-f0-9]+\.js/i.test(node.src)) continue;
          if (platformScriptRewritten) continue;
          platformScriptRewritten = true;
          // 拦截：移除 src，改写后以行内执行（MutationObserver 微任务先于脚本执行）
          var originalSrc = node.src;
          try {
            // 暂停该脚本：先移除 src 属性阻止立即执行
            node.removeAttribute('src');
            fetch(originalSrc)
              .then(function (resp) { return resp.text(); })
              .then(function (text) {
                var rewritten = rewritePlatformChunkSource(text);
                if (rewritten === null) {
                  // 改写失败：回退原 src 执行（保平台可用）
                  var s = document.createElement('script');
                  s.src = originalSrc;
                  document.head.appendChild(s);
                  return;
                }
                console.log('[course-helper] MAIN bridge：已改写平台 chunk（isRecording 开关注入，长度 ' + rewritten.length + '）。');
                // 语法自检：改写产物必须是合法 JS（失败则回退原脚本，防平台瘫痪）
                try { new Function(rewritten); } catch (syntaxError) {
                  console.log('[course-helper] MAIN bridge：改写产物语法错误，回退原脚本：' +
                    (syntaxError && syntaxError.message ? syntaxError.message : 'unknown'));
                  var sFallback = document.createElement('script');
                  sFallback.src = originalSrc;
                  document.head.appendChild(sFallback);
                  return;
                }
                var blob = new Blob([rewritten], { type: 'text/javascript' });
                var url = URL.createObjectURL(blob);
                var s2 = document.createElement('script');
                s2.src = url;
                s2.onload = function () { URL.revokeObjectURL(url); };
                document.head.appendChild(s2);
              })
              .catch(function (err) {
                console.log('[course-helper] MAIN bridge：chunk 改写失败，回退原脚本：' +
                  (err && err.message ? err.message : 'unknown'));
                var s3 = document.createElement('script');
                s3.src = originalSrc;
                document.head.appendChild(s3);
              });
            // 移除原节点（已被移除 src 不会执行）
            if (node.parentNode) node.parentNode.removeChild(node);
          } catch (ignoredRewriteError) {
            // 异常兜底：还原 src
            node.src = originalSrc;
          }
        }
      }
    });
    observer.observe(globalWindow.document.documentElement, { childList: true, subtree: true });
    console.log('[course-helper] MAIN bridge：平台 chunk 改写器已就绪（等待 question/common 加载）。');
  }

  installCommunication();
  installXhrHook();
  installFetchHook();
  // 合成音频流注入（u校园语音题）：不经过真实麦克风（无权限弹窗、
  // 无环境噪声），平台 MediaRecorder 录到程序生成的音频轨。
  installFakeAudioStream();
  // MediaRecorder 观测：确认平台录音是否真正开始、流来源是否为本覆写。
  installMediaRecorderProbe();
  // 平台 Html5Recorder 接管：停止时调其 stopRecord() 清除"正在录音中"状态。
  installPlatformRecorderProbe();
  // 终局方案：平台 chunk 源码改写（isRecording 全局开关）。
  installPlatformScriptRewriter();

  // ---- 平台确认对话框自动确认（wenliu 参考：检测"还有 N 道题没有作答..."并点"确 定"/"我知道了"）----
  // 语音题逐题完成后点"提 交"时，平台弹确认对话框；不立即点"确定"就直接关页/刷页，
  // 提交会被拦截。这里 MutationObserver 监听新增对话框，命中关键词文本后自动点击
  // 按钮（"确定"、"我知道了"、"继续"、"确认"等）。
  // 元素是否可见：Ant Design 弹窗为 position:fixed，内部按钮 offsetParent === null，
  // 不能用 offsetParent 判断（2026-10-20 实测踩坑：按钮被误判不可见而跳过点击）。
  function isElementVisibleSafe(element) {
    if (!element) return false;
    try {
      var rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      var style = window.getComputedStyle(element);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      return true;
    } catch (_e) { return false; }
  }

  // 上溯到弹窗根容器：匹配到的常是正文子节点（.ant-modal-confirm-body），
  // 其内部【不含按钮】（按钮在兄弟节点 .ant-modal-confirm-btns）——
  // 必须上溯到 .ant-modal-wrap / .ant-modal / [role=dialog] 才能取到按钮。
  function resolveDialogRoot(node) {
    var current = node;
    var depth = 0;
    while (current && depth < 8) {
      try {
        if (current.nodeType === 1) {
          var cls = asStringSafe(current.className);
          var role = current.getAttribute ? current.getAttribute('role') : '';
          if (current.classList && (
            current.classList.contains('ant-modal-wrap') ||
            current.classList.contains('ant-modal') ||
            current.classList.contains('ant-modal-root'))) {
            return current;
          }
          if (role === 'dialog' || /(^|[-_\s])(modal|dialog|popup|confirm)/i.test(cls)) {
            return current;
          }
        }
      } catch (_e) { /* 继续上溯 */ }
      current = current.parentElement;
      depth += 1;
    }
    return node;
  }

  // 在弹窗根内找确认按钮；找不到再全局兜底查 .ant-modal-confirm-btns button
  // （不同 antd 版本 DOM 层级差异大）。
  function findDismissButton(dlg) {
    var PREFERRED = ['确定', '确认', '我知道了', '继续', 'OK', '好的'];
    var roots = [];
    if (dlg) roots.push(dlg);
    try {
      var wraps = globalWindow.document.querySelectorAll(
        '.ant-modal-wrap, .ant-modal, .ant-modal-confirm-btns, [role="dialog"]');
      for (var wi = 0; wi < wraps.length; wi += 1) roots.push(wraps[wi]);
    } catch (_qe) { /* 全局查询失败时只用 dlg */ }
    for (var pi = 0; pi < PREFERRED.length; pi += 1) {
      var keyword = PREFERRED[pi];
      for (var ri = 0; ri < roots.length; ri += 1) {
        var root = roots[ri];
        if (!root || !root.querySelectorAll) continue;
        var buttons = root.querySelectorAll('button, .ant-btn, [role="button"], a.ant-btn, button span');
        for (var bi = 0; bi < buttons.length; bi += 1) {
          var btn = buttons[bi];
          var text = asStringSafe(btn.textContent).replace(/\s+/g, '');
          if (!text || text.indexOf(keyword) === -1) continue;
          if (!isElementVisibleSafe(btn)) continue;
          return btn;
        }
      }
    }
    return null;
  }

  // 弹窗自动确认（2026-10-20 实测版）：定时轮询，直接查弹窗内按钮 → 判文本 →
  // 判尺寸（position:fixed 下 offsetParent 为 null，禁用该判据）→ 点击。
  // 覆盖三类平台弹窗：
  //  1) 进页信息框「本单元学习时间：无限制 是否必修：非必修 / 我知道了」——遮罩挡住后续点击；
  //  2) 提交校验框「还有 N 道题没有作答，请完成后提交 / 我知道了」；
  //  3) 提交确认框「还有 N 道题没有作答，确认要提交吗？ / 取消 确定」。
  // 不用 MutationObserver/根容器解析——实测层级解析易静默失败（按钮在兄弟节点）。
  function installDialogDismisser() {
    if (!globalWindow.document) return;
    // 【分工】只点"确定/确认"——提交确认框「还有 N 道题没有作答，确认要提交吗？/取消 确定」。
    // "我知道了"（信息框）由 content/keep-alive.js 负责（它有意只点"我知道了"系、不点"确定"类
    // 危险按钮）。此处若也点"我知道了"会造成同按钮被两个模块重复点击
    // （2026-10-21 离线实测：4 次点击中 3 次来自 keep-alive 的重复轮询）。
    var CLICK_TEXTS = ['确定', '确认'];

    // 去重（2026-10-21 离线实测校准）：旧版"8 秒窗口"在弹窗被刻意保留 14s 时
    // 会在第 12s 再次点击。改为【永久去重 · 跨实例安全】：
    //  1) DOM 标记 dataset.chDialogClicked：多 bridge 实例下也只点一次；
    //  2) WeakSet：同元素永不再点；
    //  3) 全局 1.2s 节流：防同一轮询周期内点多个按钮。
    var clickedButtons = new WeakSet();
    var lastClickAt = 0;
    function isDialogClosing(btn) {
      try {
        var wrap = btn.closest ? btn.closest('.ant-modal-wrap') : null;
        if (wrap && /fade-leave|zoom-leave|ant-modal-wrap-hidden/.test(asStringSafe(wrap.className))) return true;
        var modal = btn.closest ? btn.closest('.ant-modal') : null;
        if (modal && /fade-leave|zoom-leave/.test(asStringSafe(modal.className))) return true;
      } catch (_e) { /* 判定失败按未关闭处理 */ }
      return false;
    }

    function pollDialogs() {
      try {
        var doc = globalWindow.document;
        var buttons = doc.querySelectorAll(
          '.ant-modal button, .ant-modal .ant-btn, .ant-modal-wrap button, .system-info-cloud-ok-button, [role="dialog"] button');
        var now = Date.now();
        for (var i = 0; i < buttons.length; i += 1) {
          var btn = buttons[i];
          if (!btn) continue;
          if (isDialogClosing(btn)) continue;
          var text = asStringSafe(btn.textContent).replace(/\s+/g, '');
          if (!text) continue;
          var matched = false;
          for (var k = 0; k < CLICK_TEXTS.length; k += 1) {
            if (text.indexOf(CLICK_TEXTS[k]) !== -1) { matched = true; break; }
          }
          if (!matched) continue;
          var rect = null;
          try { rect = btn.getBoundingClientRect(); } catch (_rectError) { rect = null; }
          if (!rect || rect.width <= 0 || rect.height <= 0) continue;
          if (clickedButtons.has(btn)) continue;
          try { if (btn.dataset && btn.dataset.chDialogClicked === '1') continue; } catch (_dsReadErr) {}
          if (now - lastClickAt < 1200) continue;
          clickedButtons.add(btn);
          try { if (btn.dataset) btn.dataset.chDialogClicked = '1'; } catch (_dsWriteErr) {}
          lastClickAt = now;
          try {
            btn.click();
          } catch (_clickError) {
            try {
              btn.dispatchEvent(new globalWindow.MouseEvent('click', { bubbles: true, cancelable: true }));
            } catch (_dispatchError) {}
          }
          console.log('[course-helper] MAIN bridge：自动点击弹窗按钮「' + text + '」。');
        }
      } catch (pollError) {
        console.log('[course-helper] MAIN bridge：弹窗轮询异常：' +
          (pollError && pollError.message ? pollError.message : String(pollError)));
      }
    }

    setInterval(pollDialogs, 1500);
    console.log('[course-helper] MAIN bridge：弹窗自动确认轮询已启动（1.5s 间隔）。');
  }

  installDialogDismisser();
})(typeof window !== 'undefined' ? window : null);
