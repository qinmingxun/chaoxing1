/* [SECTION:VIDEO_MANAGER]
 * 职责：提供与平台无关的 video/audio 播放、完成回调和播放时长管理；只通过 options 与回调接入平台行为。
 */
(function (root, factory) {
  'use strict';

  var CourseHelperVideoManager = factory(root);

  if (root) {
    root.CourseHelperVideoManager = CourseHelperVideoManager;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CourseHelperVideoManager;
    module.exports.CourseHelperVideoManager = CourseHelperVideoManager;
    module.exports.VideoManager = CourseHelperVideoManager;
    module.exports.create = CourseHelperVideoManager.create;
    module.exports.default = CourseHelperVideoManager;
  }
})(typeof globalThis !== 'undefined' ? globalThis :
  (typeof self !== 'undefined' ? self :
    (typeof window !== 'undefined' ? window : this)), function (globalObject) {
  'use strict';

  var DEFAULT_POLL_INTERVAL = 1500;
  var DEFAULT_CLOCK_INTERVAL = 200;
  var DEFAULT_AUDIO_WAIT = 5000;
  var DEFAULT_RATE = 1;

  function noop() {}

  function isObject(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function toPositiveNumber(value, fallback) {
    var number = Number(value);
    return isFiniteNumber(number) && number > 0 ? number : fallback;
  }

  function toNonNegativeNumber(value, fallback) {
    var number = Number(value);
    return isFiniteNumber(number) && number >= 0 ? number : fallback;
  }

  function toIntegerAtLeast(value, fallback, minimum) {
    var number = Number(value);
    if (!isFiniteNumber(number) || number < minimum) {
      return fallback;
    }
    return Math.floor(number);
  }

  function now() {
    return Date.now();
  }

  function callSafely(callback, receiver, args) {
    if (typeof callback !== 'function') {
      return undefined;
    }
    try {
      return callback.apply(receiver, args || []);
    } catch (error) {
      return undefined;
    }
  }

  function asArray(value) {
    if (value === undefined || value === null) {
      return [];
    }
    if (Array.isArray(value)) {
      return value.slice();
    }
    if (typeof value.length === 'number' && typeof value !== 'string') {
      var result = [];
      for (var index = 0; index < value.length; index += 1) {
        result.push(value[index]);
      }
      return result;
    }
    return [value];
  }

  function normalizeKind(value) {
    if (value === undefined || value === null) {
      return '';
    }
    var kind = String(value).toLowerCase();
    if (kind.indexOf('audio') !== -1) {
      return 'audio';
    }
    if (kind.indexOf('video') !== -1) {
      return 'video';
    }
    return kind;
  }

  function mediaKind(media, fallback) {
    var tagName;
    try {
      tagName = media && (media.tagName || media.nodeName);
    } catch (error) {
      tagName = '';
    }
    return normalizeKind(tagName) || normalizeKind(fallback) || 'video';
  }

  function isMediaLike(value) {
    if (!isObject(value)) {
      return false;
    }
    var tagName;
    try {
      tagName = String(value.tagName || value.nodeName || '').toLowerCase();
    } catch (error) {
      tagName = '';
    }
    return tagName === 'video' || tagName === 'audio' ||
      typeof value.play === 'function' || typeof value.pause === 'function';
  }

  function getTaskMedia(task) {
    if (!isObject(task)) {
      return [];
    }
    var values = [];
    var fields = ['media', 'element', 'video', 'audio', 'mediaElements', 'elements'];
    for (var index = 0; index < fields.length; index += 1) {
      var field;
      try {
        field = task[fields[index]];
      } catch (error) {
        field = undefined;
      }
      if (field !== undefined && field !== null) {
        values = values.concat(asArray(field));
      }
    }
    return values;
  }

  function getTaskRoot(task) {
    if (!isObject(task)) {
      return undefined;
    }
    var fields = ['document', 'root', 'iframe', 'frame'];
    for (var index = 0; index < fields.length; index += 1) {
      try {
        if (task[fields[index]]) {
          return task[fields[index]];
        }
      } catch (error) {
        // 跨域 frame 的属性读取失败时继续尝试其他来源。
      }
    }
    return undefined;
  }

  function CourseHelperVideoManager(options) {
    if (!(this instanceof CourseHelperVideoManager)) {
      return new CourseHelperVideoManager(options);
    }

    this.options = isObject(options) ? options : {};
    this._global = globalObject || {};
    this._running = false;
    this._destroyed = false;
    this._pollTimer = null;
    this._clockTimer = null;
    this._clockWorker = null;
    this._clockWorkerUrl = null;
    this._clockKind = null;
    this._clockLast = 0;
    this._mediaStates = [];
    this._platformCleanups = [];
    this._taskCompletionNotified = false;
    this._rate = this._readRate(this.options.rate !== undefined ? this.options.rate : this.options.videoSpeed);
    this._playingTime = this._readInitialPlayingTime(this.options.playingTime);
    this.currentTask = null;

    if (this.options.task !== undefined && this.options.task !== null) {
      this.currentTask = this._normalizeTask(this.options.task);
      this._playingTime = this._readTaskPlayingTime(this.currentTask, this._playingTime);
    }
  }

  CourseHelperVideoManager.prototype._readRate = function (value) {
    return toPositiveNumber(value, DEFAULT_RATE);
  };

  CourseHelperVideoManager.prototype._readInitialPlayingTime = function (value) {
    return toNonNegativeNumber(value, 0);
  };

  CourseHelperVideoManager.prototype._readTaskPlayingTime = function (task, fallback) {
    var value;
    if (isObject(task)) {
      try {
        value = task.playingTime;
      } catch (error) {
        value = undefined;
      }
    }
    return toNonNegativeNumber(value, fallback);
  };

  CourseHelperVideoManager.prototype._normalizeTask = function (task) {
    if (isMediaLike(task)) {
      return { media: task };
    }
    return isObject(task) ? task : null;
  };

  CourseHelperVideoManager.prototype._taskKind = function () {
    if (!this.currentTask) {
      return normalizeKind(this.options.kind || this.options.type);
    }
    var kind;
    try {
      kind = this.currentTask.kind || this.currentTask.type || this.currentTask.mediaType;
    } catch (error) {
      kind = undefined;
    }
    return normalizeKind(kind) || normalizeKind(this.options.kind || this.options.type);
  };

  CourseHelperVideoManager.prototype._resolveWindow = function () {
    var configured;
    try {
      configured = this.options.window;
    } catch (error) {
      configured = undefined;
    }
    if (configured) {
      return configured;
    }
    if (this._global && this._global.window) {
      return this._global.window;
    }
    return this._global;
  };

  CourseHelperVideoManager.prototype._resolveDocument = function () {
    var value;
    var getter;
    try {
      getter = this.options.getDocument;
    } catch (error) {
      getter = undefined;
    }
    if (typeof getter === 'function') {
      value = callSafely(getter, this, [this]);
      if (value) {
        return value;
      }
    }
    try {
      value = this.options.document || this.options.root;
    } catch (error) {
      value = undefined;
    }
    if (value) {
      return value;
    }
    if (this._global && this._global.document) {
      return this._global.document;
    }
    return undefined;
  };

  CourseHelperVideoManager.prototype._resolvePlatformCallback = function (name, aliases) {
    var sources = [this.options];
    var callbackContainer;
    try {
      callbackContainer = this.options.callbacks || this.options.platform;
    } catch (error) {
      callbackContainer = undefined;
    }
    if (isObject(callbackContainer)) {
      sources.push(callbackContainer);
    }
    if (this.currentTask && isObject(this.currentTask)) {
      sources.push(this.currentTask);
      try {
        if (isObject(this.currentTask.callbacks)) {
          sources.push(this.currentTask.callbacks);
        }
      } catch (error) {
        // 忽略任务回调容器读取错误。
      }
    }
    var names = [name].concat(aliases || []);
    for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      var source = sources[sourceIndex];
      for (var nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
        try {
          if (typeof source[names[nameIndex]] === 'function') {
            return source[names[nameIndex]];
          }
        } catch (error) {
          // 继续查找其他回调来源。
        }
      }
    }
    return null;
  };

  CourseHelperVideoManager.prototype._callbackList = function (name, aliases) {
    var sources = [this.options];
    var callbacks;
    try {
      callbacks = this.options.callbacks || this.options.platform;
    } catch (error) {
      callbacks = undefined;
    }
    if (isObject(callbacks)) {
      sources.push(callbacks);
    }
    if (this.currentTask && isObject(this.currentTask)) {
      sources.push(this.currentTask);
      try {
        if (isObject(this.currentTask.callbacks)) {
          sources.push(this.currentTask.callbacks);
        }
      } catch (error) {
        // 忽略任务回调容器读取错误。
      }
    }
    var names = [name].concat(aliases || []);
    var result = [];
    for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      var source = sources[sourceIndex];
      for (var nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
        var callback;
        try {
          callback = source[names[nameIndex]];
        } catch (error) {
          callback = undefined;
        }
        if (typeof callback === 'function' && result.indexOf(callback) === -1) {
          result.push(callback);
        }
      }
    }
    return result;
  };

  CourseHelperVideoManager.prototype._invokeCallbacks = function (name, aliases, payload) {
    var callbacks = this._callbackList(name, aliases);
    for (var index = 0; index < callbacks.length; index += 1) {
      callSafely(callbacks[index], this, [payload, this]);
    }
  };

  CourseHelperVideoManager.prototype._readTaskOption = function (name, fallback) {
    var value;
    if (this.currentTask) {
      try {
        value = this.currentTask[name];
      } catch (error) {
        value = undefined;
      }
    }
    if (value === undefined) {
      try {
        value = this.options[name];
      } catch (error) {
        value = undefined;
      }
    }
    return value === undefined ? fallback : value;
  };

  CourseHelperVideoManager.prototype._collectDocuments = function (root, documents, seen) {
    if (!root) {
      return;
    }

    var documentLike = root;
    try {
      if (root.contentDocument) {
        documentLike = root.contentDocument;
      } else if (root.contentWindow && root.contentWindow.document) {
        documentLike = root.contentWindow.document;
      }
    } catch (error) {
      return;
    }

    if (!documentLike || seen.indexOf(documentLike) !== -1) {
      return;
    }

    var canQuery = false;
    try {
      canQuery = typeof documentLike.querySelectorAll === 'function';
    } catch (error) {
      canQuery = false;
    }
    if (!canQuery) {
      return;
    }

    seen.push(documentLike);
    documents.push(documentLike);

    var frames;
    try {
      frames = documentLike.querySelectorAll('iframe, frame');
    } catch (error) {
      frames = [];
    }

    for (var index = 0; index < (frames && frames.length ? frames.length : 0); index += 1) {
      var frame = frames[index];
      var childDocument;
      try {
        childDocument = frame && (frame.contentDocument ||
          (frame.contentWindow && frame.contentWindow.document));
      } catch (error) {
        childDocument = undefined;
      }
      if (childDocument) {
        this._collectDocuments(childDocument, documents, seen);
      }
    }
  };

  CourseHelperVideoManager.prototype._queryMedia = function (documentLike) {
    var result = [];
    var list;
    try {
      list = documentLike.querySelectorAll('video, audio');
    } catch (error) {
      list = null;
    }
    if (list && typeof list.length === 'number') {
      for (var index = 0; index < list.length; index += 1) {
        result.push(list[index]);
      }
      return result;
    }

    var tags = ['video', 'audio'];
    for (var tagIndex = 0; tagIndex < tags.length; tagIndex += 1) {
      try {
        list = documentLike.querySelectorAll(tags[tagIndex]);
      } catch (error) {
        list = null;
      }
      if (list && typeof list.length === 'number') {
        for (var mediaIndex = 0; mediaIndex < list.length; mediaIndex += 1) {
          if (result.indexOf(list[mediaIndex]) === -1) {
            result.push(list[mediaIndex]);
          }
        }
      }
    }
    return result;
  };

  CourseHelperVideoManager.prototype._collectMedia = function () {
    var entries = [];
    var expectedKind = this._taskKind();
    var taskMedia = getTaskMedia(this.currentTask);
    var configuredMedia;
    try {
      configuredMedia = this.options.media || this.options.elements;
    } catch (error) {
      configuredMedia = undefined;
    }
    var explicitMedia = taskMedia.concat(asArray(configuredMedia));
    var hasExplicitMedia = explicitMedia.length > 0;

    var addMedia = function (manager, media, fallbackKind) {
      if (!media || !isMediaLike(media)) {
        return;
      }
      var kind = mediaKind(media, fallbackKind);
      if (expectedKind && kind !== expectedKind) {
        return;
      }
      for (var existingIndex = 0; existingIndex < entries.length; existingIndex += 1) {
        if (entries[existingIndex].media === media) {
          return;
        }
      }
      entries.push({ media: media, kind: kind });
    };

    for (var explicitIndex = 0; explicitIndex < explicitMedia.length; explicitIndex += 1) {
      addMedia(this, explicitMedia[explicitIndex], expectedKind);
    }

    if (hasExplicitMedia) {
      return entries;
    }

    var roots = [];
    var taskRoot = getTaskRoot(this.currentTask);
    if (taskRoot) {
      roots.push(taskRoot);
    }
    var configuredRoot;
    try {
      configuredRoot = this.options.iframe || this.options.frame;
    } catch (error) {
      configuredRoot = undefined;
    }
    roots = roots.concat(asArray(configuredRoot));
    var defaultDocument = this._resolveDocument();
    if (defaultDocument) {
      roots.push(defaultDocument);
    }

    var documents = [];
    var seenDocuments = [];
    for (var rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      this._collectDocuments(roots[rootIndex], documents, seenDocuments);
    }

    for (var documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
      var mediaList = this._queryMedia(documents[documentIndex]);
      for (var mediaIndex = 0; mediaIndex < mediaList.length; mediaIndex += 1) {
        addMedia(this, mediaList[mediaIndex], expectedKind);
      }
    }
    return entries;
  };

  CourseHelperVideoManager.prototype._findMediaState = function (media) {
    for (var index = 0; index < this._mediaStates.length; index += 1) {
      if (this._mediaStates[index].media === media) {
        return this._mediaStates[index];
      }
    }
    return null;
  };

  CourseHelperVideoManager.prototype._attachEvent = function (target, eventName, handler, cleanups) {
    if (!target) {
      return;
    }
    try {
      if (typeof target.addEventListener === 'function') {
        target.addEventListener(eventName, handler);
        cleanups.push(function () {
          try {
            if (typeof target.removeEventListener === 'function') {
              target.removeEventListener(eventName, handler);
            }
          } catch (error) {
            // 清理阶段忽略已失效的 DOM。
          }
        });
        return;
      }
    } catch (error) {
      // 使用 on* 兼容路径。
    }

    var propertyName = 'on' + eventName;
    var previous;
    try {
      previous = target[propertyName];
      target[propertyName] = function (event) {
        callSafely(previous, target, [event]);
        handler(event);
      };
      cleanups.push(function () {
        try {
          target[propertyName] = previous;
        } catch (cleanupError) {
          // 清理阶段忽略只读属性。
        }
      });
    } catch (error) {
      // 不支持事件监听的对象安全跳过。
    }
  };

  CourseHelperVideoManager.prototype._createMediaState = function (entry) {
    var manager = this;
    var state = {
      media: entry.media,
      kind: entry.kind,
      cleanups: [],
      audioTimer: null,
      resumeTimer: null,
      resumePending: false,
      suppressPause: false,
      endedNotified: false,
      completed: false,
      started: false
    };

    this._attachEvent(entry.media, 'pause', function (event) {
      manager._handlePause(state, event);
    }, state.cleanups);
    this._attachEvent(entry.media, 'ended', function (event) {
      manager._handleEnded(state, event);
    }, state.cleanups);
    this._mediaStates.push(state);
    return state;
  };

  CourseHelperVideoManager.prototype._clearMediaStateTimers = function (state) {
    if (!state) {
      return;
    }
    if (state.audioTimer !== null) {
      clearTimeout(state.audioTimer);
      state.audioTimer = null;
    }
    if (state.resumeTimer !== null) {
      clearTimeout(state.resumeTimer);
      state.resumeTimer = null;
    }
    state.resumePending = false;
  };

  CourseHelperVideoManager.prototype._removeMediaState = function (state) {
    if (!state) {
      return;
    }
    this._clearMediaStateTimers(state);
    for (var index = 0; index < state.cleanups.length; index += 1) {
      callSafely(state.cleanups[index], this, []);
    }
    state.cleanups.length = 0;
  };

  CourseHelperVideoManager.prototype._clearMediaStates = function () {
    for (var index = 0; index < this._mediaStates.length; index += 1) {
      this._removeMediaState(this._mediaStates[index]);
    }
    this._mediaStates.length = 0;
  };

  CourseHelperVideoManager.prototype._isEnded = function (media) {
    try {
      return media.ended === true;
    } catch (error) {
      return false;
    }
  };

  CourseHelperVideoManager.prototype._resolveMediaValue = function (name, state, fallback) {
    var value = this._readTaskOption(name, fallback);
    if (typeof value === 'function') {
      return callSafely(value, this, [state.media, {
        state: state,
        task: this.currentTask,
        manager: this
      }]);
    }
    return value;
  };

  CourseHelperVideoManager.prototype._applyVolume = function (state) {
    var media = state.media;
    var context = {
      media: media,
      state: state,
      task: this.currentTask,
      manager: this
    };
    var setter = this._resolveMediaValue('setVolume', state, null);
    var volume = this._resolveMediaValue('volume', state, undefined);
    if (typeof setter === 'function') {
      callSafely(setter, this, [media, volume, context]);
      return;
    }
    if (volume === undefined || volume === null) {
      return;
    }
    try {
      media.volume = volume;
    } catch (error) {
      // 某些跨域或只读媒体对象不允许调整音量。
    }
  };

  CourseHelperVideoManager.prototype._applyMuted = function (state) {
    var media = state.media;
    var muted = this._resolveMediaValue('muted', state, true);
    if (muted === undefined || muted === null) {
      return;
    }
    try {
      media.muted = Boolean(muted);
    } catch (error) {
      // 只读媒体对象安全跳过。
    }
  };

  CourseHelperVideoManager.prototype._applyPlaybackRate = function (state) {
    var media = state.media;
    var rate = this._readRate(this._resolveMediaValue('rate', state, this._rate));
    var setter = this._resolveMediaValue('setPlaybackRate', state, null);
    var context = {
      media: media,
      state: state,
      task: this.currentTask,
      manager: this,
      rate: rate
    };
    if (typeof setter === 'function') {
      callSafely(setter, this, [media, rate, context]);
      return rate;
    }
    try {
      media.playbackRate = rate;
    } catch (error) {
      // 只读媒体对象安全跳过。
    }
    return rate;
  };

  CourseHelperVideoManager.prototype._playSafely = function (state) {
    var playResult;
    try {
      if (!state.media || typeof state.media.play !== 'function') {
        return;
      }
      playResult = state.media.play();
    } catch (error) {
      return;
    }
    if (!playResult) {
      return;
    }
    try {
      if (typeof playResult.catch === 'function') {
        playResult.catch(noop);
      } else if (typeof playResult.then === 'function') {
        playResult.then(noop, noop);
      }
    } catch (error) {
      // play() 的 thenable 或 catch 实现异常时安全忽略。
    }
  };

  CourseHelperVideoManager.prototype._prepareAndPlay = function (state) {
    if (!this._running || this._destroyed || !state || state.completed) {
      return;
    }
    if (this._isEnded(state.media)) {
      if (state.kind === 'audio') {
        this._scheduleAudioCompletion(state);
      } else {
        this._completeState(state, 'ended');
      }
      return;
    }

    state.suppressPause = true;
    try {
      if (state.media && typeof state.media.pause === 'function') {
        state.media.pause();
      }
    } catch (error) {
      // pause() 可能被跨域对象或页面脚本拒绝。
    }
    state.suppressPause = false;

    this._applyMuted(state);
    this._applyPlaybackRate(state);
    this._applyVolume(state);
    this._playSafely(state);
    state.started = true;

    if (state.kind === 'audio') {
      this._scheduleAudioCompletion(state);
    }
  };

  CourseHelperVideoManager.prototype._scheduleAudioCompletion = function (state) {
    if (!state || state.completed || state.audioTimer !== null) {
      return;
    }
    var delay = this._readTaskOption('audioWaitMs', DEFAULT_AUDIO_WAIT);
    delay = toNonNegativeNumber(delay, DEFAULT_AUDIO_WAIT);
    var manager = this;
    state.audioTimer = setTimeout(function () {
      state.audioTimer = null;
      if (!manager._running || manager._destroyed || state.completed) {
        return;
      }
      manager._completeState(state, 'audio-delay');
    }, delay);
    if (state.audioTimer && typeof state.audioTimer.unref === 'function') {
      state.audioTimer.unref();
    }
  };

  CourseHelperVideoManager.prototype._handlePause = function (state, event) {
    if (!state || state.suppressPause || state.completed || !this._running || this._destroyed) {
      return;
    }
    if (this._isEnded(state.media)) {
      return;
    }

    var payload = this._mediaPayload(state, 'pause');
    this._invokeCallbacks('onPause', ['pause'], payload);

    var autoResume = this._readTaskOption('autoResume', true);
    if (autoResume === false || state.resumePending) {
      return;
    }
    var delay = toNonNegativeNumber(this._readTaskOption('resumeDelayMs', 0), 0);
    var manager = this;
    state.resumePending = true;
    state.resumeTimer = setTimeout(function () {
      state.resumeTimer = null;
      state.resumePending = false;
      if (manager._running && !manager._destroyed && !state.completed &&
          !manager._isEnded(state.media)) {
        manager._prepareAndPlay(state);
      }
    }, delay);
    if (state.resumeTimer && typeof state.resumeTimer.unref === 'function') {
      state.resumeTimer.unref();
    }
  };

  CourseHelperVideoManager.prototype._mediaPayload = function (state, reason, event) {
    return {
      media: state && state.media,
      element: state && state.media,
      kind: state && state.kind,
      task: this.currentTask,
      reason: reason,
      event: event,
      playingTime: this._playingTime,
      manager: this
    };
  };

  CourseHelperVideoManager.prototype._handleEnded = function (state, event) {
    if (!state || state.completed || this._destroyed) {
      return;
    }
    if (!state.endedNotified) {
      state.endedNotified = true;
      this._invokeCallbacks('onEnded', ['ended'], this._mediaPayload(state, 'ended', event));
    }
    if (state.kind !== 'audio') {
      this._completeState(state, 'ended', event);
    }
  };

  CourseHelperVideoManager.prototype._completeState = function (state, reason, event) {
    if (!state || state.completed) {
      return;
    }
    state.completed = true;
    this._clearMediaStateTimers(state);

    if (this.currentTask && this._taskCompletionNotified) {
      return;
    }
    if (this.currentTask) {
      this._taskCompletionNotified = true;
    }
    this._invokeCallbacks('onComplete', ['onTaskComplete', 'completeTask', 'onDone'],
      this._mediaPayload(state, reason, event));
  };

  CourseHelperVideoManager.prototype._poll = function () {
    if (!this._running || this._destroyed) {
      return;
    }
    var entries = this._collectMedia();
    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      var state = this._findMediaState(entry.media);
      if (!state) {
        state = this._createMediaState(entry);
      }
      this._prepareAndPlay(state);
    }
  };

  CourseHelperVideoManager.prototype.poll = function () {
    if (!this._destroyed && this._running) {
      this._poll();
    }
    return this;
  };

  CourseHelperVideoManager.prototype._attachPlatformListeners = function () {
    if (this._platformCleanups.length > 0) {
      return;
    }

    var manager = this;
    var windowLike = this._resolveWindow();
    var documentLike = this._resolveDocument();
    var onBlur = this._resolvePlatformCallback('onBlur', ['blur', 'handleBlur']);
    var onVisibility = this._resolvePlatformCallback('onVisibilityChange',
      ['visibilitychange', 'handleVisibilityChange']);

    if (windowLike && (typeof onBlur === 'function' || this._readTaskOption('resumeOnBlur', true) !== false)) {
      this._attachEvent(windowLike, 'blur', function (event) {
        if (typeof onBlur === 'function') {
          callSafely(onBlur, manager, [event, manager]);
        }
        if (manager._readTaskOption('resumeOnBlur', true) !== false) {
          manager._resumeAll();
        }
      }, this._platformCleanups);
    }

    if (documentLike && (typeof onVisibility === 'function' ||
        this._readTaskOption('resumeOnVisibilityChange', true) !== false)) {
      this._attachEvent(documentLike, 'visibilitychange', function (event) {
        if (typeof onVisibility === 'function') {
          callSafely(onVisibility, manager, [event, manager]);
        }
        if (manager._readTaskOption('resumeOnVisibilityChange', true) !== false) {
          manager._resumeAll();
        }
      }, this._platformCleanups);
    }
  };

  CourseHelperVideoManager.prototype._detachPlatformListeners = function () {
    for (var index = 0; index < this._platformCleanups.length; index += 1) {
      callSafely(this._platformCleanups[index], this, []);
    }
    this._platformCleanups.length = 0;
  };

  CourseHelperVideoManager.prototype._resumeAll = function () {
    if (!this._running || this._destroyed) {
      return;
    }
    for (var index = 0; index < this._mediaStates.length; index += 1) {
      var state = this._mediaStates[index];
      if (!state.completed && !this._isEnded(state.media)) {
        this._prepareAndPlay(state);
      }
    }
    this._poll();
  };

  CourseHelperVideoManager.prototype.resume = function () {
    this._resumeAll();
    return this;
  };

  CourseHelperVideoManager.prototype._workerSource = function () {
    return [
      "(function () {",
      "  'use strict';",
      '  var timer = null;',
      '  var last = 0;',
      '  var rate = 1;',
      '  var interval = 200;',
      '  function stop() { if (timer !== null) { clearInterval(timer); timer = null; } }',
      '  function tick() {',
      '    var current = Date.now();',
      '    var elapsedMs = current - last;',
      '    if (elapsedMs < 0) { elapsedMs = 0; }',
      '    last = current;',
      '    self.postMessage({ type: "tick", now: current, elapsedMs: elapsedMs, increment: elapsedMs / 1000 * rate });',
      '  }',
      '  self.onmessage = function (event) {',
      '    var data = event && event.data ? event.data : {};',
      '    if (data.type === "stop") { stop(); return; }',
      '    if (data.type === "rate") { if (typeof data.rate === "number" && data.rate > 0) { rate = data.rate; } return; }',
      '    if (data.type === "start") {',
      '      stop();',
      '      rate = typeof data.rate === "number" && data.rate > 0 ? data.rate : 1;',
      '      interval = typeof data.intervalMs === "number" && data.intervalMs > 0 ? data.intervalMs : 200;',
      '      last = Date.now();',
      '      timer = setInterval(tick, interval);',
      '    }',
      '  };',
      '}());'
    ].join('\n');
  };

  CourseHelperVideoManager.prototype._getWorkerConstructor = function () {
    var configured;
    try {
      configured = this.options.Worker;
    } catch (error) {
      configured = undefined;
    }
    if (typeof configured === 'function') {
      return configured;
    }
    return this._global && typeof this._global.Worker === 'function' ? this._global.Worker : null;
  };

  CourseHelperVideoManager.prototype._getBlobConstructor = function () {
    var configured;
    try {
      configured = this.options.Blob;
    } catch (error) {
      configured = undefined;
    }
    if (typeof configured === 'function') {
      return configured;
    }
    return this._global && typeof this._global.Blob === 'function' ? this._global.Blob : null;
  };

  CourseHelperVideoManager.prototype._getUrlApi = function () {
    var configured;
    try {
      configured = this.options.URL;
    } catch (error) {
      configured = undefined;
    }
    if (configured) {
      return configured;
    }
    return this._global && this._global.URL ? this._global.URL : null;
  };

  CourseHelperVideoManager.prototype._startWorkerClock = function () {
    var WorkerConstructor = this._getWorkerConstructor();
    var BlobConstructor = this._getBlobConstructor();
    var urlApi = this._getUrlApi();
    if (!WorkerConstructor || !BlobConstructor || !urlApi ||
        typeof urlApi.createObjectURL !== 'function') {
      return false;
    }

    var worker;
    var workerUrl;
    try {
      var blob = new BlobConstructor([this._workerSource()], { type: 'application/javascript' });
      workerUrl = urlApi.createObjectURL(blob);
      worker = new WorkerConstructor(workerUrl);
    } catch (error) {
      if (workerUrl && typeof urlApi.revokeObjectURL === 'function') {
        callSafely(urlApi.revokeObjectURL, urlApi, [workerUrl]);
      }
      return false;
    }

    var manager = this;
    this._clockWorker = worker;
    this._clockWorkerUrl = workerUrl;
    this._clockKind = 'worker';
    this._clockLast = now();
    try {
      worker.onmessage = function (event) {
        manager._handleClockTick(event && event.data);
      };
      worker.onerror = function () {
        if (manager._running && !manager._destroyed) {
          manager._terminateWorker();
          manager._startFallbackClock();
        }
      };
      worker.postMessage({
        type: 'start',
        intervalMs: this._clockInterval(),
        rate: this._rate,
        playingTime: this._playingTime
      });
    } catch (error) {
      this._terminateWorker();
      return false;
    }
    return true;
  };

  CourseHelperVideoManager.prototype._clockInterval = function () {
    return toIntegerAtLeast(this._readTaskOption('timerIntervalMs', DEFAULT_CLOCK_INTERVAL),
      DEFAULT_CLOCK_INTERVAL, 1);
  };

  CourseHelperVideoManager.prototype._startFallbackClock = function () {
    if (!this._running || this._destroyed) {
      return;
    }
    if (this._clockTimer !== null) {
      clearInterval(this._clockTimer);
      this._clockTimer = null;
    }
    this._clockKind = 'timer';
    this._clockLast = now();
    var manager = this;
    this._clockTimer = setInterval(function () {
      manager._handleClockTick({ now: now() });
    }, this._clockInterval());
    if (this._clockTimer && typeof this._clockTimer.unref === 'function') {
      this._clockTimer.unref();
    }
  };

  CourseHelperVideoManager.prototype._terminateWorker = function () {
    var worker = this._clockWorker;
    var workerUrl = this._clockWorkerUrl;
    var urlApi = this._getUrlApi();
    this._clockWorker = null;
    this._clockWorkerUrl = null;
    if (worker) {
      try {
        if (typeof worker.postMessage === 'function') {
          worker.postMessage({ type: 'stop' });
        }
      } catch (error) {
        // worker 已失效时忽略停止消息错误。
      }
      try {
        if (typeof worker.terminate === 'function') {
          worker.terminate();
        }
      } catch (error) {
        // worker 已失效时忽略终止错误。
      }
    }
    if (workerUrl && urlApi && typeof urlApi.revokeObjectURL === 'function') {
      callSafely(urlApi.revokeObjectURL, urlApi, [workerUrl]);
    }
  };

  CourseHelperVideoManager.prototype._clearClock = function () {
    if (this._clockTimer !== null) {
      clearInterval(this._clockTimer);
      this._clockTimer = null;
    }
    this._terminateWorker();
    this._clockKind = null;
    this._clockLast = 0;
  };

  CourseHelperVideoManager.prototype._handleClockTick = function (data) {
    if (!this._running || this._destroyed) {
      return;
    }
    data = isObject(data) ? data : {};
    var elapsedMs;
    if (isFiniteNumber(data.elapsedMs)) {
      elapsedMs = data.elapsedMs;
    } else if (isFiniteNumber(data.elapsedSeconds)) {
      elapsedMs = data.elapsedSeconds * 1000;
    } else if (isFiniteNumber(data.elapsed)) {
      elapsedMs = data.elapsed * 1000;
    } else {
      var timestamp = isFiniteNumber(data.now) ? data.now : now();
      elapsedMs = timestamp - this._clockLast;
    }
    if (!isFiniteNumber(elapsedMs) || elapsedMs < 0) {
      elapsedMs = 0;
    }
    if (isFiniteNumber(data.now)) {
      this._clockLast = data.now;
    } else {
      this._clockLast = now();
    }

    var increment = elapsedMs / 1000 * this._rate;
    if (isFiniteNumber(data.increment) && data.increment >= 0 &&
        !isFiniteNumber(data.elapsedMs) && !isFiniteNumber(data.elapsedSeconds) &&
        !isFiniteNumber(data.elapsed)) {
      increment = data.increment;
    }
    this._playingTime += increment;

    var payload = {
      elapsed: increment,
      elapsedMs: elapsedMs,
      playingTime: this._playingTime,
      rate: this._rate,
      task: this.currentTask,
      manager: this
    };
    this._invokeCallbacks('onProgress', ['onTimeUpdate', 'onPlayingTime', 'onTick'], payload);
  };

  CourseHelperVideoManager.prototype.setRate = function (rate) {
    this._rate = this._readRate(rate);
    if (this._clockWorker && typeof this._clockWorker.postMessage === 'function') {
      try {
        this._clockWorker.postMessage({ type: 'rate', rate: this._rate });
      } catch (error) {
        // worker 失效时下一次降级或重启会使用新速率。
      }
    }
    for (var index = 0; index < this._mediaStates.length; index += 1) {
      if (!this._mediaStates[index].completed) {
        this._applyPlaybackRate(this._mediaStates[index]);
      }
    }
    return this;
  };

  CourseHelperVideoManager.prototype.getRate = function () {
    return this._rate;
  };

  CourseHelperVideoManager.prototype.getPlayingTime = function () {
    return this._playingTime;
  };

  CourseHelperVideoManager.prototype.resetPlayingTime = function (playingTime) {
    this._playingTime = toNonNegativeNumber(playingTime, 0);
    this._clockLast = now();
    return this;
  };

  CourseHelperVideoManager.prototype.setTask = function (task) {
    if (this._destroyed) {
      return this;
    }
    this._clearMediaStates();
    this.currentTask = this._normalizeTask(task);
    this._taskCompletionNotified = false;
    this._playingTime = this._readTaskPlayingTime(this.currentTask,
      this._readInitialPlayingTime(this.options.playingTime));
    var taskRate;
    if (this.currentTask) {
      try {
        taskRate = this.currentTask.rate;
      } catch (error) {
        taskRate = undefined;
      }
    }
    if (taskRate !== undefined) {
      this._rate = this._readRate(taskRate);
    }
    if (this._running) {
      this._startClock();
      this._poll();
    }
    return this;
  };

  CourseHelperVideoManager.prototype.switchTask = function (task) {
    return this.setTask(task);
  };

  CourseHelperVideoManager.prototype.changeTask = function (task) {
    return this.setTask(task);
  };

  CourseHelperVideoManager.prototype.start = function (task) {
    if (this._destroyed) {
      return this;
    }
    if (task !== undefined) {
      this.setTask(task);
    }
    if (this._running) {
      return this;
    }

    this._running = true;
    this._taskCompletionNotified = false;
    this._attachPlatformListeners();
    this._startClock();
    if (this._clockKind === null) {
      this._startFallbackClock();
    }

    var manager = this;
    this._pollTimer = setInterval(function () {
      manager._poll();
    }, toIntegerAtLeast(this._readTaskOption('pollIntervalMs', DEFAULT_POLL_INTERVAL),
      DEFAULT_POLL_INTERVAL, 1));
    if (this._pollTimer && typeof this._pollTimer.unref === 'function') {
      this._pollTimer.unref();
    }
    this._poll();
    return this;
  };

  CourseHelperVideoManager.prototype.stop = function () {
    if (!this._running && this._pollTimer === null && this._clockKind === null &&
        this._platformCleanups.length === 0 && this._mediaStates.length === 0) {
      return this;
    }
    this._running = false;
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._detachPlatformListeners();
    this._clearClock();
    this._clearMediaStates();
    return this;
  };

  CourseHelperVideoManager.prototype.destroy = function () {
    if (this._destroyed) {
      return this;
    }
    this.stop();
    this._destroyed = true;
    this.currentTask = null;
    this._taskCompletionNotified = false;
    return this;
  };

  CourseHelperVideoManager.prototype.dispose = function () {
    return this.destroy();
  };

  CourseHelperVideoManager.prototype.cleanup = function () {
    return this.stop();
  };

  CourseHelperVideoManager.prototype.isRunning = function () {
    return this._running;
  };

  CourseHelperVideoManager.prototype.isDestroyed = function () {
    return this._destroyed;
  };

  CourseHelperVideoManager.create = function (options) {
    return new CourseHelperVideoManager(options);
  };

  CourseHelperVideoManager.VideoManager = CourseHelperVideoManager;
  CourseHelperVideoManager.CourseHelperVideoManager = CourseHelperVideoManager;
  CourseHelperVideoManager.default = CourseHelperVideoManager;

  return CourseHelperVideoManager;
});
