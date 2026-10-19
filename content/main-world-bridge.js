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

  // content 侧停止命令：对存活 recorder 逐个 stop（重复 stop 已停止的 recorder
  // 会抛 InvalidStateError，逐个 try/catch 吞掉），并回执停止后状态。
  function handleStopRecordingCommand() {
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
    console.log('[course-helper] MAIN bridge：停止录音命令已执行（对 ' + stopped +
      ' 个存活 MediaRecorder 调用 stop）。');
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
        var oscillator = context.createOscillator();
        var gain = context.createGain();
        gain.gain.value = 0.06; // 低音量柔和音，避免爆音
        oscillator.type = 'sine';
        oscillator.frequency.value = 220;
        oscillator.connect(gain);
        gain.connect(destination);
        oscillator.start();
        // autoplay 策略可能将 AudioContext 挂起，尝试恢复（失败也不阻塞）。
        if (typeof context.resume === 'function') {
          try {
            context.resume();
          } catch (ignoredResumeError) {
            // 挂起状态下流轨可能为静音，但不影响流程推进。
          }
        }
        fakeAudioStreams.push({ context: context, oscillator: oscillator });
        while (fakeAudioStreams.length > FAKE_AUDIO_MAX_STREAMS) {
          var old = fakeAudioStreams.shift();
          try {
            old.oscillator.stop();
          } catch (ignoredStopError) {
            // 已停止的振荡器安全跳过。
          }
          try {
            old.context.close();
          } catch (ignoredCloseError) {
            // 已关闭的上下文安全跳过。
          }
        }
        console.log('[course-helper] MAIN bridge：已提供合成音频流（不经过真实麦克风）。');
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
      try {
        record.oscillator.stop();
      } catch (ignoredStopError) {
        // 已停止的振荡器安全跳过。
      }
      try {
        record.context.close();
      } catch (ignoredCloseError) {
        // 已关闭的上下文安全跳过。
      }
    }
  }

  installCommunication();
  installXhrHook();
  installFetchHook();
  // 合成音频流注入（u校园语音题）：不经过真实麦克风（无权限弹窗、
  // 无环境噪声），平台 MediaRecorder 录到程序生成的音频轨。
  installFakeAudioStream();
  // MediaRecorder 观测：确认平台录音是否真正开始、流来源是否为本覆写。
  installMediaRecorderProbe();
})(typeof window !== 'undefined' ? window : null);
