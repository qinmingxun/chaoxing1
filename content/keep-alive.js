/**
 * [SECTION:KEEP_ALIVE]
 * 职责：为页面提供可安全启动/停止的原生 JavaScript 保活能力，包括轻量
 * 活动事件、HEAD 网络探测、可访问 WebSocket 心跳和挂机弹窗处理。
 * 所有页面 API 都按可选能力使用；缺少 API 时安全跳过，不影响真实操作。
 */
(function installKeepAlive(globalRoot) {
  'use strict';

  var MARKER = '__COURSE_HELPER_KEEP_ALIVE__';
  var DEFAULTS = {
    activityInterval: 30000,
    pingInterval: 45000,
    webSocketInterval: 35000,
    popupDelay: 300
  };
  var POPUP_KEYWORDS = /长时间未操作|继续使用|继续学习|超时|timeout|会话已结束/i;
  var POPUP_BUTTON_LABELS = {
    '确定': true,
    '继续': true,
    ok: true
  };
  // antd 确认弹窗（.ant-modal）的"我知道了"按钮：弹窗出现时间不固定、内容
  // 不含挂机关键词（如平台提示/成绩弹窗），由弹窗结构特征触发点击。
  // 仅匹配"我知道了"系标签，避免误点其他 antd 弹窗的"确定"类危险按钮。
  var ANT_MODAL_BUTTON_LABELS = {
    '我知道了': true,
    '知道了': true,
    '我知道': true
  };
  var hasOwn = Object.prototype.hasOwnProperty;

  function getDefaultRoot() {
    try {
      if (typeof window !== 'undefined' && window) {
        return window;
      }
    } catch (ignoredWindowError) {
      // 某些沙箱会让 window 读取抛异常，继续尝试 globalThis。
    }

    try {
      if (typeof globalThis !== 'undefined' && globalThis) {
        return globalThis;
      }
    } catch (ignoredGlobalError) {
      // 没有可用的全局对象时由调用者传入 root。
    }

    return null;
  }

  function readProperty(target, property) {
    if (target === null || target === undefined) {
      return undefined;
    }
    try {
      return target[property];
    } catch (ignoredReadError) {
      return undefined;
    }
  }

  function isObjectLike(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function safeString(value) {
    if (value === null || value === undefined) {
      return '';
    }
    try {
      return String(value);
    } catch (ignoredStringError) {
      return '';
    }
  }

  function copyObject(source) {
    var target = {};
    if (!isObjectLike(source)) {
      return target;
    }

    try {
      Object.keys(source).forEach(function copyKey(key) {
        try {
          target[key] = source[key];
        } catch (ignoredKeyError) {
          // 代理对象的单个属性不可读时，忽略该属性。
        }
      });
    } catch (ignoredKeysError) {
      // Object.keys 也可能被代理对象拦截。
    }
    return target;
  }

  function hasOptionShape(value) {
    if (!isObjectLike(value)) {
      return false;
    }

    var optionKeys = [
      'root', 'document', 'window', 'location', 'intervals', 'timers',
      'activityInterval', 'activityIntervalMs', 'pingInterval', 'pingIntervalMs',
      'webSocketInterval', 'websocketInterval', 'webSocketIntervalMs',
      'websocketIntervalMs', 'popupDelay', 'popupDelayMs', 'observeTarget',
      'getWebSockets', 'webSockets', 'sockets', 'fetch', 'MutationObserver',
      'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout'
    ];

    for (var index = 0; index < optionKeys.length; index += 1) {
      try {
        if (hasOwn.call(value, optionKeys[index])) {
          return true;
        }
      } catch (ignoredOptionShapeError) {
        return false;
      }
    }
    return false;
  }

  function isNodeLike(value) {
    if (!isObjectLike(value)) {
      return false;
    }
    var nodeType = readProperty(value, 'nodeType');
    return nodeType === 1 || nodeType === 9 || nodeType === 11;
  }

  function isEnvironmentLike(value) {
    if (!isObjectLike(value)) {
      return false;
    }
    if (isNodeLike(value)) {
      return true;
    }

    var environmentKeys = [
      'document', 'location', 'fetch', 'setInterval', 'setTimeout',
      'addEventListener', 'dispatchEvent', 'MutationObserver', 'WebSocket'
    ];
    for (var index = 0; index < environmentKeys.length; index += 1) {
      if (readProperty(value, environmentKeys[index]) !== undefined) {
        return true;
      }
    }
    return false;
  }

  function mergeOptions(first, second) {
    var merged = copyObject(first);
    if (!isObjectLike(second)) {
      return merged;
    }

    try {
      Object.keys(second).forEach(function mergeKey(key) {
        try {
          merged[key] = second[key];
        } catch (ignoredMergeKeyError) {
          // 忽略不可读的单个选项。
        }
      });
    } catch (ignoredSecondKeysError) {
      // 选项对象可能是跨域代理对象。
    }
    return merged;
  }

  function normalizeArguments(first, second) {
    var firstLooksLikeOptions = isObjectLike(first) &&
      !isNodeLike(first) &&
      !isEnvironmentLike(first) &&
      (hasOptionShape(first) || !isEnvironmentLike(first));
    var options;
    var suppliedRoot;

    if (firstLooksLikeOptions) {
      options = mergeOptions(first, second);
      suppliedRoot = readProperty(options, 'root') ||
        readProperty(options, 'document') ||
        readProperty(options, 'window');
    } else {
      options = copyObject(second);
      suppliedRoot = first;
      if (!suppliedRoot) {
        suppliedRoot = readProperty(options, 'root') ||
          readProperty(options, 'document') ||
          readProperty(options, 'window');
      }
    }

    if (!suppliedRoot) {
      suppliedRoot = getDefaultRoot();
    }

    var documentObject = readProperty(options, 'document');
    if (!documentObject && readProperty(suppliedRoot, 'nodeType') === 9) {
      documentObject = suppliedRoot;
    }
    if (!documentObject) {
      documentObject = readProperty(suppliedRoot, 'document');
    }
    if (!documentObject) {
      documentObject = readProperty(suppliedRoot, 'ownerDocument');
    }

    var windowObject = readProperty(options, 'window');
    if (!windowObject) {
      windowObject = readProperty(documentObject, 'defaultView');
    }
    if (!windowObject && suppliedRoot !== documentObject) {
      var candidateWindow = readProperty(suppliedRoot, 'window');
      if (candidateWindow && candidateWindow === suppliedRoot) {
        windowObject = suppliedRoot;
      }
    }
    if (!windowObject && suppliedRoot !== documentObject &&
        (readProperty(suppliedRoot, 'location') || readProperty(suppliedRoot, 'fetch'))) {
      windowObject = suppliedRoot;
    }

    return {
      root: suppliedRoot,
      document: documentObject || null,
      window: windowObject || null,
      options: options
    };
  }

  function readFromEnvironment(environment, property) {
    var sources = [
      environment.options,
      environment.root,
      environment.window,
      environment.document
    ];

    for (var index = 0; index < sources.length; index += 1) {
      var source = sources[index];
      var value = readProperty(source, property);
      if (value !== undefined && value !== null) {
        return {
          value: value,
          owner: source
        };
      }
    }

    return null;
  }

  function readFunction(environment, property) {
    var result = readFromEnvironment(environment, property);
    if (result && typeof result.value === 'function') {
      return result;
    }
    return null;
  }

  function readLocationHref(environment) {
    var locationResult = readFromEnvironment(environment, 'location');
    var locationObject = locationResult && locationResult.value;
    if (typeof locationObject === 'string') {
      return locationObject;
    }

    var href = readProperty(locationObject, 'href');
    if (href === undefined || href === null) {
      return '';
    }
    return safeString(href);
  }

  function safeRandom(environment) {
    var randomResult = readFunction(environment, 'random');
    var value;
    try {
      value = randomResult ? randomResult.value.call(randomResult.owner) : Math.random();
    } catch (ignoredRandomError) {
      value = 0.5;
    }
    if (!isFiniteNumber(value) || value < 0 || value >= 1) {
      return 0.5;
    }
    return value;
  }

  function readIntervalOption(options, aliases, fallback) {
    var intervalContainers = [options, readProperty(options, 'intervals'), readProperty(options, 'timers')];
    for (var containerIndex = 0; containerIndex < intervalContainers.length; containerIndex += 1) {
      var container = intervalContainers[containerIndex];
      if (!isObjectLike(container)) {
        continue;
      }
      for (var aliasIndex = 0; aliasIndex < aliases.length; aliasIndex += 1) {
        var value = readProperty(container, aliases[aliasIndex]);
        if (isFiniteNumber(value)) {
          return value;
        }
      }
    }
    return fallback;
  }

  function getRuntimeOptions(environment) {
    var options = environment.options || {};
    return {
      activityInterval: readIntervalOption(options, [
        'activityInterval', 'activityIntervalMs', 'activityMs', 'activityEvery'
      ], DEFAULTS.activityInterval),
      pingInterval: readIntervalOption(options, [
        'pingInterval', 'pingIntervalMs', 'networkPingInterval', 'networkPingIntervalMs'
      ], DEFAULTS.pingInterval),
      webSocketInterval: readIntervalOption(options, [
        'webSocketInterval', 'websocketInterval', 'webSocketIntervalMs',
        'websocketIntervalMs', 'wsInterval', 'wsIntervalMs'
      ], DEFAULTS.webSocketInterval),
      popupDelay: readIntervalOption(options, [
        'popupDelay', 'popupDelayMs', 'modalDelay', 'clickDelay'
      ], DEFAULTS.popupDelay),
      activityEnabled: options.activity !== false &&
        options.enableActivity !== false && options.autoActivity !== false,
      pingEnabled: options.ping !== false &&
        options.networkPing !== false && options.enablePing !== false,
      webSocketEnabled: options.webSocket !== false &&
        options.websocket !== false && options.enableWebSocket !== false &&
        options.enableWebsocket !== false,
      popupEnabled: options.popup !== false &&
        options.observe !== false && options.enablePopup !== false
    };
  }

  function makeWeakSet() {
    try {
      if (typeof WeakSet === 'function') {
        return new WeakSet();
      }
    } catch (ignoredWeakSetError) {
      // 旧环境没有可用的 WeakSet，退回小型数组集合。
    }
    return null;
  }

  function collectionHas(collection, value) {
    if (!collection) {
      return false;
    }
    if (typeof collection.has === 'function') {
      try {
        return collection.has(value);
      } catch (ignoredHasError) {
        return false;
      }
    }
    return collection.indexOf(value) !== -1;
  }

  function collectionAdd(collection, fallbackArray, value) {
    if (collection) {
      try {
        collection.add(value);
        return;
      } catch (ignoredAddError) {
        // 非对象节点不能进入 WeakSet，继续使用数组。
      }
    }
    if (fallbackArray.indexOf(value) === -1) {
      fallbackArray.push(value);
    }
  }

  function safeArrayPushUnique(array, value) {
    if (array.indexOf(value) === -1) {
      array.push(value);
    }
  }

  function getEventConstructor(environment, name) {
    var result = readFunction(environment, name);
    return result ? result.value : null;
  }

  function createSyntheticEvent(environment, type, init) {
    var documentObject = environment.document;
    var constructorName = type === 'mousemove' ? 'MouseEvent' :
      type === 'keydown' ? 'KeyboardEvent' : 'Event';
    var EventConstructor = getEventConstructor(environment, constructorName);

    if (EventConstructor) {
      try {
        return new EventConstructor(type, init);
      } catch (ignoredConstructorError) {
        // 继续尝试 document.createEvent。
      }
    }

    if (documentObject && typeof documentObject.createEvent === 'function') {
      try {
        var event;
        if (type === 'mousemove') {
          event = documentObject.createEvent('MouseEvents');
          event.initMouseEvent(
            type,
            true,
            true,
            environment.window || null,
            0,
            0,
            0,
            init.clientX || 0,
            init.clientY || 0,
            false,
            false,
            false,
            false,
            0,
            null
          );
          return event;
        }

        event = documentObject.createEvent('Event');
        event.initEvent(type, true, true);
        return event;
      } catch (ignoredCreateEventError) {
        // 继续使用最小对象；非原生测试 root 可能接受该对象。
      }
    }

    return { type: type };
  }

  function dispatchSyntheticEvent(environment, target, type, init) {
    if (!target || typeof target.dispatchEvent !== 'function') {
      return;
    }

    var event = createSyntheticEvent(environment, type, init || {});
    try {
      target.dispatchEvent(event);
    } catch (ignoredDispatchError) {
      // 合成事件仅用于辅助保活，单个目标失败不能中断其他机制。
    }
  }

  function getActivityTarget(environment, preferWindow) {
    var documentObject = environment.document;
    var windowObject = environment.window;
    var candidates = preferWindow
      ? [windowObject, documentObject, readProperty(documentObject, 'documentElement')]
      : [documentObject, readProperty(documentObject, 'documentElement'), windowObject];

    for (var index = 0; index < candidates.length; index += 1) {
      if (candidates[index] && typeof candidates[index].dispatchEvent === 'function') {
        return candidates[index];
      }
    }
    return null;
  }

  function simulateActivity(environment) {
    if (!environment || !environment.runtime || !environment.runtime.activityEnabled) {
      return;
    }

    var width = readProperty(environment.window, 'innerWidth');
    var height = readProperty(environment.window, 'innerHeight');
    width = isFiniteNumber(width) && width > 0 ? width : 1024;
    height = isFiniteNumber(height) && height > 0 ? height : 768;
    var clientX = Math.floor(safeRandom(environment) * width);
    var clientY = Math.floor(safeRandom(environment) * height);

    dispatchSyntheticEvent(environment, getActivityTarget(environment, false), 'mousemove', {
      bubbles: true,
      cancelable: true,
      view: environment.window || null,
      clientX: clientX,
      clientY: clientY
    });
    dispatchSyntheticEvent(environment, getActivityTarget(environment, true), 'scroll', {
      bubbles: false,
      cancelable: false
    });
    dispatchSyntheticEvent(environment, getActivityTarget(environment, false), 'keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Shift',
      code: 'ShiftLeft',
      keyCode: 16,
      which: 16
    });
  }

  function clearTimerRecord(record) {
    if (!record || typeof record.clear !== 'function') {
      return;
    }
    try {
      record.clear.call(record.owner, record.id);
    } catch (ignoredClearError) {
      // 定时器可能已由宿主清理。
    }
  }

  function addInterval(state, environment, callback, delay) {
    if (!isFiniteNumber(delay) || delay <= 0) {
      return;
    }

    var setResult = readFunction(environment, 'setInterval');
    var clearResult = readFunction(environment, 'clearInterval');
    if (!setResult) {
      return;
    }

    var timerId;
    try {
      timerId = setResult.value.call(setResult.owner, callback, delay);
      state.intervals.push({
        id: timerId,
        clear: clearResult && clearResult.value,
        owner: clearResult ? clearResult.owner : setResult.owner
      });
    } catch (ignoredSetIntervalError) {
      // 计时器不可用时只关闭该项能力。
    }
  }

  function addTimeout(state, environment, callback, delay) {
    if (!isFiniteNumber(delay) || delay < 0) {
      return false;
    }

    var setResult = readFunction(environment, 'setTimeout');
    var clearResult = readFunction(environment, 'clearTimeout');
    if (!setResult) {
      return false;
    }

    var record = {
      id: undefined,
      clear: clearResult && clearResult.value,
      owner: clearResult ? clearResult.owner : setResult.owner
    };
    try {
      record.id = setResult.value.call(setResult.owner, function delayedKeepAliveAction() {
        var pendingIndex = state.timeouts.indexOf(record);
        if (pendingIndex !== -1) {
          state.timeouts.splice(pendingIndex, 1);
        }
        if (state.running) {
          callback();
        }
      }, delay);
      state.timeouts.push(record);
      return true;
    } catch (ignoredSetTimeoutError) {
      return false;
    }
  }

  function safeThenableCatch(result) {
    if (!result || typeof result !== 'object' && typeof result !== 'function') {
      return;
    }

    try {
      if (typeof result.catch === 'function') {
        result.catch(function ignorePingError() {});
      } else if (typeof result.then === 'function') {
        result.then(function ignorePingResult() {}, function ignorePingError() {});
      }
    } catch (ignoredThenableError) {
      // HEAD ping 的拒绝不应形成未处理异常。
    }
  }

  function sendNetworkPing(environment) {
    if (!environment || !environment.runtime || !environment.runtime.pingEnabled) {
      return;
    }

    var fetchResult = readFunction(environment, 'fetch');
    var href = readLocationHref(environment);
    if (!fetchResult || !href) {
      return;
    }

    try {
      var response = fetchResult.value.call(fetchResult.owner, href, { method: 'HEAD' });
      safeThenableCatch(response);
    } catch (ignoredFetchError) {
      // 页面可能拒绝 HEAD 或替换 fetch；保活循环继续。
    }
  }

  function isSocketOpen(socket, environment) {
    if (!isObjectLike(socket)) {
      return false;
    }

    var readyState = readProperty(socket, 'readyState');
    if (readyState === 1) {
      return true;
    }

    var openValue = readProperty(socket, 'OPEN');
    if (openValue === undefined) {
      var constructorResult = readFunction(environment, 'WebSocket');
      openValue = constructorResult && readProperty(constructorResult.value, 'OPEN');
    }
    return openValue !== undefined && readyState === openValue;
  }

  function collectIterable(value, visit, depth) {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      for (var arrayIndex = 0; arrayIndex < value.length; arrayIndex += 1) {
        visit(value[arrayIndex], depth + 1);
      }
      return;
    }

    if (typeof value.forEach === 'function') {
      try {
        value.forEach(function visitCollection(item) {
          visit(item, depth + 1);
        });
        return;
      } catch (ignoredForEachError) {
        // 继续尝试 array-like 访问。
      }
    }

    var length = readProperty(value, 'length');
    if (isFiniteNumber(length) && length >= 0 && length < 10000) {
      for (var index = 0; index < length; index += 1) {
        visit(readProperty(value, index), depth + 1);
      }
    }
  }

  function collectSocketCandidates(environment) {
    var sockets = [];
    var visited = [];
    var socketNames = [
      'instances', 'sockets', 'webSockets', 'websockets', 'openSockets',
      'openWebSockets', 'webSocketInstances', '__webSockets__',
      '__WEBSOCKETS__', '__sockets__', '__SOCKETS__', 'socket', 'ws'
    ];

    function visit(value, depth) {
      if (!isObjectLike(value) || depth > 3) {
        return;
      }
      if (visited.indexOf(value) !== -1) {
        return;
      }
      visited.push(value);

      if (isSocketOpen(value, environment) && typeof readProperty(value, 'send') === 'function') {
        safeArrayPushUnique(sockets, value);
      }

      if (depth === 3) {
        return;
      }

      for (var nameIndex = 0; nameIndex < socketNames.length; nameIndex += 1) {
        var nested = readProperty(value, socketNames[nameIndex]);
        if (nested !== undefined && nested !== null && nested !== value) {
          if (Array.isArray(nested) || typeof nested.forEach === 'function' ||
              isFiniteNumber(readProperty(nested, 'length'))) {
            collectIterable(nested, visit, depth);
          } else {
            visit(nested, depth + 1);
          }
        }
      }
    }

    var options = environment.options || {};
    var getSocketsResult = readFunction(environment, 'getWebSockets');
    if (getSocketsResult) {
      try {
        collectIterable(
          getSocketsResult.value.call(getSocketsResult.owner),
          visit,
          0
        );
      } catch (ignoredGetSocketsError) {
        // 单个页面提供的枚举器失败时继续检查公开属性。
      }
    }

    var explicitSources = [
      readProperty(options, 'webSockets'),
      readProperty(options, 'websockets'),
      readProperty(options, 'sockets'),
      readProperty(environment.root, 'webSockets'),
      readProperty(environment.root, 'websockets'),
      readProperty(environment.root, 'sockets'),
      readProperty(environment.window, 'webSockets'),
      readProperty(environment.window, 'websockets'),
      readProperty(environment.window, 'sockets'),
      readProperty(environment.root, 'WebSocket'),
      readProperty(environment.window, 'WebSocket')
    ];
    explicitSources.forEach(function visitExplicitSource(source) {
      visit(source, 0);
    });

    var owners = [environment.root, environment.window];
    owners.forEach(function inspectOwner(owner) {
      if (!isObjectLike(owner)) {
        return;
      }
      var names = [];
      try {
        names = Object.getOwnPropertyNames(owner);
      } catch (ignoredOwnNamesError) {
        try {
          names = Object.keys(owner);
        } catch (ignoredObjectKeysError) {
          names = [];
        }
      }

      names.forEach(function inspectProperty(name) {
        var normalizedName = safeString(name).toLowerCase();
        if (normalizedName.indexOf('socket') === -1 &&
            normalizedName !== 'ws' && normalizedName.indexOf('connection') === -1) {
          return;
        }
        visit(readProperty(owner, name), 0);
      });
    });

    return sockets;
  }

  function sendWebSocketHeartbeat(environment) {
    if (!environment || !environment.runtime || !environment.runtime.webSocketEnabled) {
      return;
    }

    var sockets = collectSocketCandidates(environment);
    sockets.forEach(function sendToSocket(socket) {
      try {
        socket.send('2');
      } catch (ignoredSocketError) {
        // 一个 socket 关闭或拒绝发送时，不影响其他 socket。
      }
    });
  }

  function getNodeText(node) {
    var text = readProperty(node, 'textContent');
    if (text === undefined || text === null) {
      text = readProperty(node, 'nodeValue');
    }
    return safeString(text);
  }

  function normalizeButtonLabel(value) {
    return safeString(value)
      .replace(/[\s ]+/g, '')
      .replace(/[：:。.!！?？]+$/g, '')
      .toLowerCase();
  }

  function isButtonCandidate(node) {
    if (!isObjectLike(node)) {
      return false;
    }

    var tagName = safeString(readProperty(node, 'tagName')).toUpperCase();
    var role = safeString(readProperty(node, 'role') || readProperty(node, 'ariaRole')).toLowerCase();
    var type = safeString(readProperty(node, 'type')).toLowerCase();
    return tagName === 'BUTTON' ||
      (tagName === 'INPUT' && (type === 'button' || type === 'submit')) ||
      role === 'button' ||
      tagName === 'A';
  }

  function getButtonLabel(node) {
    var text = getNodeText(node);
    if (!text) {
      text = safeString(readProperty(node, 'value'));
    }
    if (!text) {
      text = safeString(readProperty(node, 'ariaLabel'));
    }
    if (!text) {
      text = safeString(readProperty(node, 'title'));
    }
    return normalizeButtonLabel(text);
  }

  function addQueryResults(scope, selector, candidates) {
    if (!scope || typeof scope.querySelectorAll !== 'function') {
      return;
    }
    try {
      var matches = scope.querySelectorAll(selector);
      if (!matches) {
        return;
      }
      for (var index = 0; index < matches.length; index += 1) {
        if (isButtonCandidate(matches[index]) && candidates.indexOf(matches[index]) === -1) {
          candidates.push(matches[index]);
        }
      }
    } catch (ignoredQueryError) {
      // 一个选择器不受支持时继续尝试其他选择器。
    }
  }

  function walkButtonCandidates(node, candidates, visited) {
    if (!isObjectLike(node) || visited.indexOf(node) !== -1) {
      return;
    }
    visited.push(node);

    if (isButtonCandidate(node) && candidates.indexOf(node) === -1) {
      candidates.push(node);
    }

    var children = readProperty(node, 'children') || readProperty(node, 'childNodes');
    if (children) {
      collectIterable(children, function visitChild(child) {
        walkButtonCandidates(child, candidates, visited);
      }, 0);
    }
  }

  function findPopupButton(scope) {
    if (!scope) {
      return null;
    }

    var candidates = [];
    if (isButtonCandidate(scope)) {
      candidates.push(scope);
    }

    [
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      '[role="button"]',
      'a'
    ].forEach(function queryButtonSelector(selector) {
      addQueryResults(scope, selector, candidates);
    });

    if (candidates.length === 0) {
      walkButtonCandidates(scope, candidates, []);
    }

    for (var index = 0; index < candidates.length; index += 1) {
      if (POPUP_BUTTON_LABELS[getButtonLabel(candidates[index])]) {
        return candidates[index];
      }
    }
    return null;
  }

  function schedulePopupClick(state, environment, node) {
    if (!node || !environment.runtime || !environment.runtime.popupEnabled) {
      return;
    }

    if (collectionHas(state.scheduledNodes, node)) {
      return;
    }
    collectionAdd(state.scheduledNodes, state.scheduledNodeArray, node);

    addTimeout(state, environment, function clickPopupButton() {
      if (!state.running || state.environment !== environment) {
        return;
      }
      var button = findPopupButton(node);
      if (!button || typeof button.click !== 'function') {
        return;
      }
      try {
        button.click();
      } catch (ignoredClickError) {
        // 弹窗按钮可能在延迟期间被页面销毁。
      }
    }, environment.runtime.popupDelay);
  }

  // antd 弹窗"我知道了"按钮查找：节点自身是按钮（label 匹配）直接采用；
  // 否则在节点内查 .ant-modal-confirm-btns / .ant-modal-footer 下的按钮。
  function findAntdModalConfirmButton(scope) {
    if (!scope) {
      return null;
    }
    if (isButtonCandidate(scope) && ANT_MODAL_BUTTON_LABELS[getButtonLabel(scope)]) {
      return scope;
    }
    var buttons = [];
    addQueryResults(scope, '.ant-modal-confirm-btns button', buttons);
    addQueryResults(scope, '.ant-modal-footer button', buttons);
    for (var index = 0; index < buttons.length; index += 1) {
      if (ANT_MODAL_BUTTON_LABELS[getButtonLabel(buttons[index])]) {
        return buttons[index];
      }
    }
    return null;
  }

  // 判断新增节点是否为 antd 弹窗（结构特征：ant-modal 相关 class 或含确认按钮容器）。
  function isAntdModalNode(node) {
    if (!isObjectLike(node)) {
      return false;
    }
    var classList = readProperty(node, 'classList');
    var contains = classList && typeof classList.contains === 'function'
      ? classList.contains.bind(classList)
      : null;
    try {
      if (contains &&
          (contains('ant-modal-wrap') || contains('ant-modal-content') ||
           contains('ant-modal-confirm-btns') || contains('ant-modal'))) {
        return true;
      }
    } catch (ignoredClassError) {
      // 继续尝试 querySelector 探测。
    }
    if (node && typeof node.querySelector === 'function') {
      try {
        if (node.querySelector('.ant-modal-confirm-btns, .ant-modal-content')) {
          return true;
        }
      } catch (ignoredQueryError) {
        // 探测失败按非弹窗处理。
      }
    }
    return false;
  }

  function scheduleAntdModalClick(state, environment, node) {
    if (!node || !environment.runtime || !environment.runtime.popupEnabled) {
      return;
    }
    if (collectionHas(state.scheduledNodes, node)) {
      return;
    }
    collectionAdd(state.scheduledNodes, state.scheduledNodeArray, node);

    addTimeout(state, environment, function clickAntdModalButton() {
      if (!state.running || state.environment !== environment) {
        return;
      }
      var button = findAntdModalConfirmButton(node);
      if (!button || typeof button.click !== 'function') {
        return;
      }
      try {
        button.click();
      } catch (ignoredClickError) {
        // 弹窗按钮可能在延迟期间被页面销毁。
      }
    }, environment.runtime.popupDelay);
  }

  function handleMutationRecords(state, environment, records) {
    if (!state.running || state.environment !== environment || !records) {
      return;
    }

    var recordArray = records;
    if (!Array.isArray(recordArray) && typeof recordArray.length !== 'number') {
      recordArray = [records];
    }

    for (var recordIndex = 0; recordIndex < recordArray.length; recordIndex += 1) {
      var record = recordArray[recordIndex];
      if (!record) {
        continue;
      }
      var addedNodes = readProperty(record, 'addedNodes');
      if (!addedNodes) {
        continue;
      }

      for (var nodeIndex = 0; nodeIndex < addedNodes.length; nodeIndex += 1) {
        var node = addedNodes[nodeIndex];
        if (!node) {
          continue;
        }
        if (POPUP_KEYWORDS.test(getNodeText(node))) {
          schedulePopupClick(state, environment, node);
        } else if (isAntdModalNode(node)) {
          // antd 弹窗（如 u校园"我知道了"提示）：出现时间不固定、内容不含
          // 挂机关键词，按弹窗结构特征触发（只点"我知道了"系按钮）。
          scheduleAntdModalClick(state, environment, node);
        }
      }
    }
  }

  function installMutationObserver(state, environment) {
    if (!environment.runtime || !environment.runtime.popupEnabled) {
      return;
    }

    var observerResult = readFunction(environment, 'MutationObserver');
    var target = readProperty(environment.options, 'observeTarget');
    if (!target) {
      if (isNodeLike(environment.root)) {
        target = environment.root;
      } else {
        target = environment.document;
      }
    }
    // target 只是观察目标（Document/Node），observe 方法属于观察器对象本身，
    // 因此这里只要求 target 是可用对象（真实 Document 没有 observe 属性）。
    if (!observerResult || !target || typeof target !== 'object') {
      return;
    }

    var observer;
    var callback = function mutationCallback(records) {
      try {
        handleMutationRecords(state, environment, records);
      } catch (ignoredMutationError) {
        // 观察器回调必须隔离页面节点或代理对象异常。
      }
    };

    try {
      observer = new observerResult.value(callback);
    } catch (ignoredObserverConstructorError) {
      try {
        observer = observerResult.value(callback);
      } catch (ignoredObserverCallError) {
        observer = null;
      }
    }

    if (!observer || typeof observer.observe !== 'function') {
      return;
    }

    try {
      observer.observe(target, { childList: true, subtree: true });
      state.observer = observer;
    } catch (ignoredObserveError) {
      try {
        if (typeof observer.disconnect === 'function') {
          observer.disconnect();
        }
      } catch (ignoredDisconnectError) {
        // 忽略无法启动的观察器。
      }
    }
  }

  function hasPotentialWebSockets(environment) {
    var options = environment.options || {};
    if (readProperty(options, 'webSockets') || readProperty(options, 'sockets') ||
        typeof readProperty(options, 'getWebSockets') === 'function') {
      return true;
    }
    if (readProperty(environment.root, 'WebSocket') || readProperty(environment.window, 'WebSocket')) {
      return true;
    }
    return !!(
      readProperty(environment.root, 'sockets') ||
      readProperty(environment.root, 'webSockets') ||
      readProperty(environment.window, 'sockets') ||
      readProperty(environment.window, 'webSockets')
    );
  }

  function installTimers(state, environment) {
    var runtime = environment.runtime;
    var hasActivityTarget = !!getActivityTarget(environment, false);
    if (runtime.activityEnabled && hasActivityTarget) {
      addInterval(state, environment, function activityTimerCallback() {
        if (state.running && state.environment === environment) {
          simulateActivity(environment);
        }
      }, runtime.activityInterval);
    }

    var hasFetch = !!readFunction(environment, 'fetch');
    var hasHref = !!readLocationHref(environment);
    if (runtime.pingEnabled && hasFetch && hasHref) {
      addInterval(state, environment, function pingTimerCallback() {
        if (state.running && state.environment === environment) {
          sendNetworkPing(environment);
        }
      }, runtime.pingInterval);
    }

    if (runtime.webSocketEnabled && hasPotentialWebSockets(environment)) {
      addInterval(state, environment, function webSocketTimerCallback() {
        if (state.running && state.environment === environment) {
          sendWebSocketHeartbeat(environment);
        }
      }, runtime.webSocketInterval);
    }
  }

  var state = {
    running: false,
    environment: null,
    runtime: null,
    intervals: [],
    timeouts: [],
    observer: null,
    scheduledNodes: makeWeakSet(),
    scheduledNodeArray: []
  };

  function destroy() {
    state.running = false;

    state.intervals.forEach(clearTimerRecord);
    state.timeouts.forEach(clearTimerRecord);
    state.intervals.length = 0;
    state.timeouts.length = 0;

    if (state.observer && typeof state.observer.disconnect === 'function') {
      try {
        state.observer.disconnect();
      } catch (ignoredObserverDisconnectError) {
        // observer 清理失败不能阻止其他资源释放。
      }
    }
    state.observer = null;
    state.environment = null;
    state.runtime = null;
    state.scheduledNodes = makeWeakSet();
    state.scheduledNodeArray.length = 0;
    return api;
  }

  function init(first, second) {
    if (state.running) {
      return api;
    }

    var environment = normalizeArguments(first, second);
    environment.runtime = getRuntimeOptions(environment);
    state.environment = environment;
    state.runtime = environment.runtime;
    state.running = true;
    state.scheduledNodes = makeWeakSet();
    state.scheduledNodeArray.length = 0;

    try {
      installTimers(state, environment);
    } catch (ignoredTimerInstallError) {
      // 任一宿主 API 异常都只能关闭对应能力，不能让 init 失败。
    }
    try {
      installMutationObserver(state, environment);
    } catch (ignoredObserverInstallError) {
      // MutationObserver 是可选增强能力。
    }

    return api;
  }

  function start(first, second) {
    return init(first, second);
  }

  function controller() {
    return destroy();
  }

  var api = controller;
  api.init = init;
  api.start = start;
  api.destroy = destroy;
  api.stop = destroy;
  api.isRunning = function isRunning() {
    return state.running;
  };
  api.getState = function getState() {
    return {
      running: state.running,
      intervalCount: state.intervals.length,
      timeoutCount: state.timeouts.length,
      observerInstalled: !!state.observer
    };
  };

  try {
    Object.defineProperty(api, 'running', {
      configurable: false,
      enumerable: true,
      get: function getRunning() {
        return state.running;
      }
    });
  } catch (ignoredRunningPropertyError) {
    api.running = false;
  }

  if (globalRoot) {
    var existing = readProperty(globalRoot, MARKER);
    if (existing && typeof existing.init === 'function' &&
        typeof existing.destroy === 'function') {
      api = existing;
    } else {
      try {
        Object.defineProperty(globalRoot, MARKER, {
          configurable: true,
          enumerable: false,
          writable: true,
          value: api
        });
      } catch (ignoredMarkerDefineError) {
        try {
          globalRoot[MARKER] = api;
        } catch (ignoredMarkerAssignError) {
          // 无法写入页面全局标记时仍保留局部 API。
        }
      }
    }
  }

  try {
    if (typeof module !== 'undefined' && module && module.exports) {
      module.exports = api;
    }
  } catch (ignoredModuleExportError) {
    // 浏览器环境没有 CommonJS module。
  }
}(typeof window !== 'undefined' ? window :
  (typeof globalThis !== 'undefined' ? globalThis : null)));
