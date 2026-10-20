/* [SECTION:SERVICE_WORKER] 原生 MV3 后台消息路由：DeepSeek、学习通接口与持久缓存。 */

const DEEPSEEK_URL_DEFAULT = 'https://api.deepseek.com/chat/completions';
// 端点可经 storage.local.deepseekApiBase 覆盖（自建代理/测试 mock 用；默认官方直连不变）。
// 值填 origin 或完整路径（如 https://api.deepseek.com 或 https://mock.local/v1/chat/completions）。
const DEEPSEEK_SYSTEM_PROMPT = '你是答题助手，只输出答案，不要任何解释。单选题和判断题只输出选项字母（如 A）；多选题输出连续字母（如 ABD）；填空题多个空用 # 分隔；简答题直接输出答案文字。';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';
const DEEPSEEK_DEFAULT_TEMPERATURE = 0.1;
const DEEPSEEK_DEFAULT_TIMEOUT_MS = 30000;
const DEEPSEEK_MAX_CONCURRENCY = 3;
const DEEPSEEK_KEY_PLACEHOLDER = '<YOUR_DEEPSEEK_API_KEY>';
const CHAOXING_HOST_SUFFIXES = ['chaoxing.com'];
const ALLOWED_MESSAGE_TYPES = new Set([
  'DEEPSEEK_CHAT',
  'CX_STATUS',
  'CX_REPORT',
  'CX_DOCUMENT',
  'CX_READV2',
  'CX_JOB',
  'CACHE_GET',
  'CACHE_SET'
]);

let deepSeekActive = 0;
const deepSeekWaiters = [];

function makeSuccess(requestId, data) {
  return { type: 'BACKGROUND_RESULT', requestId, ok: true, data };
}

function makeFailure(requestId, code, message, retryable = false) {
  return {
    type: 'BACKGROUND_RESULT',
    requestId,
    ok: false,
    error: { code, message, retryable: Boolean(retryable) }
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(payload, field) {
  if (!isRecord(payload) || typeof payload[field] !== 'string' || payload[field].length === 0) {
    throw new RequestError('INVALID_FIELD', `${field} must be a non-empty string`, false);
  }
  return payload[field];
}

function requireNumber(payload, field) {
  if (!isRecord(payload) || typeof payload[field] !== 'number' || !Number.isFinite(payload[field])) {
    throw new RequestError('INVALID_FIELD', `${field} must be a finite number`, false);
  }
  return payload[field];
}

function requireInteger(payload, field) {
  const value = requireNumber(payload, field);
  if (!Number.isInteger(value)) {
    throw new RequestError('INVALID_FIELD', `${field} must be an integer`, false);
  }
  return value;
}

class RequestError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.retryable = retryable;
  }
}

function assertPlainOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch (_error) {
    throw new RequestError('INVALID_URL', 'origin must be an absolute URL', false);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' && url.pathname !== '') {
    throw new RequestError('INVALID_URL', 'origin must be an HTTPS origin', false);
  }
  if (!isChaoxingHost(url.hostname)) {
    throw new RequestError('URL_NOT_ALLOWED', 'origin host is not allowlisted', false);
  }
  return `${url.protocol}//${url.host}`;
}

function isChaoxingHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return CHAOXING_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function assertAbsoluteChaoxingUrl(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new RequestError('INVALID_URL', `${field} must be an absolute URL`, false);
  }
  if (url.protocol !== 'https:' || !isChaoxingHost(url.hostname)) {
    throw new RequestError('URL_NOT_ALLOWED', `${field} host is not allowlisted`, false);
  }
  return url;
}

function assertDeepSeekPayload(payload) {
  if (!isRecord(payload)) {
    throw new RequestError('INVALID_PAYLOAD', 'payload must be an object', false);
  }
  const domain = requireString(payload, 'domain');
  if (!/^[a-z0-9.-]+$/i.test(domain) || domain.includes('..')) {
    throw new RequestError('INVALID_FIELD', 'domain is invalid', false);
  }
  const qtype = requireInteger(payload, 'qtype');
  if (![0, 1, 2, 3, 4].includes(qtype)) {
    throw new RequestError('INVALID_FIELD', 'qtype is invalid', false);
  }
  const stem = requireString(payload, 'stem');
  if (!Array.isArray(payload.options) || payload.options.some((option) => typeof option !== 'string')) {
    throw new RequestError('INVALID_FIELD', 'options must be a string array', false);
  }
  const model = payload.model === undefined ? undefined : requireString(payload, 'model');
  const temperature = payload.temperature === undefined ? undefined : requireNumber(payload, 'temperature');
  const timeoutMs = payload.timeoutMs === undefined ? undefined : requireInteger(payload, 'timeoutMs');
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    throw new RequestError('INVALID_FIELD', 'temperature must be between 0 and 2', false);
  }
  if (timeoutMs !== undefined && (timeoutMs < 1 || timeoutMs > 120000)) {
    throw new RequestError('INVALID_FIELD', 'timeoutMs is out of range', false);
  }
  return { domain, qtype, stem, options: payload.options, model, temperature, timeoutMs };
}

async function readStorage(keys) {
  if (!globalThis.chrome || !chrome.storage || !chrome.storage.local) {
    throw new RequestError('STORAGE_UNAVAILABLE', 'chrome.storage.local is unavailable', false);
  }
  return chrome.storage.local.get(keys);
}

// 解析 DeepSeek 端点：storage.deepseekApiBase（origin 或完整 URL）→ 覆盖默认官方端点。
// 仅接受 http(s) URL；补全默认 path；非法值回退默认（不抛错，不影响答题主流程）。
async function resolveDeepSeekUrl(apiBase) {
  if (typeof apiBase !== 'string' || !apiBase.trim()) {
    return DEEPSEEK_URL_DEFAULT;
  }
  try {
    const parsed = new URL(apiBase.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return DEEPSEEK_URL_DEFAULT;
    }
    if (!parsed.pathname || parsed.pathname === '/') {
      return parsed.origin + '/chat/completions';
    }
    return parsed.origin + parsed.pathname;
  } catch (_error) {
    return DEEPSEEK_URL_DEFAULT;
  }
}

function acquireDeepSeekSlot() {
  if (deepSeekActive < DEEPSEEK_MAX_CONCURRENCY) {
    deepSeekActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => deepSeekWaiters.push(resolve));
}

function releaseDeepSeekSlot() {
  const next = deepSeekWaiters.shift();
  if (next) {
    next();
    return;
  }
  deepSeekActive = Math.max(0, deepSeekActive - 1);
}

async function withDeepSeekSlot(task) {
  await acquireDeepSeekSlot();
  try {
    return await task();
  } finally {
    releaseDeepSeekSlot();
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new RequestError('TIMEOUT', 'request timed out', true);
    }
    throw new RequestError('NETWORK_ERROR', error && error.message ? error.message : 'network request failed', true);
  } finally {
    clearTimeout(timer);
  }
}

async function handleDeepSeek(payload) {
  const request = assertDeepSeekPayload(payload);
  const stored = await readStorage(['deepseekApiKey', 'deepseekModel', 'deepseekTemperature', 'deepseekTimeoutMs', 'deepseekApiBase']);
  const deepseekUrl = await resolveDeepSeekUrl(stored.deepseekApiBase);
  const apiKey = typeof stored.deepseekApiKey === 'string' ? stored.deepseekApiKey : '';
  if (!apiKey || apiKey === DEEPSEEK_KEY_PLACEHOLDER) {
    throw new RequestError('MISSING_API_KEY', 'DeepSeek API key is not configured', false);
  }
  const model = request.model || stored.deepseekModel || DEEPSEEK_DEFAULT_MODEL;
  const temperature = request.temperature === undefined
    ? (typeof stored.deepseekTemperature === 'number' ? stored.deepseekTemperature : DEEPSEEK_DEFAULT_TEMPERATURE)
    : request.temperature;
  const timeoutMs = request.timeoutMs || (Number.isInteger(stored.deepseekTimeoutMs) ? stored.deepseekTimeoutMs : DEEPSEEK_DEFAULT_TIMEOUT_MS);
  const userContent = JSON.stringify({ qtype: request.qtype, stem: request.stem, options: request.options });
  return withDeepSeekSlot(async () => {
    const response = await fetchWithTimeout(deepseekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: 'system', content: DEEPSEEK_SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ]
      })
    }, timeoutMs);
    let body;
    try {
      body = await response.json();
    } catch (_error) {
      throw new RequestError('BAD_RESPONSE', 'DeepSeek response was not valid JSON', true);
    }
    if (!response.ok) {
      const message = body && body.error && typeof body.error.message === 'string' ? body.error.message : `DeepSeek HTTP ${response.status}`;
      throw new RequestError('DEEPSEEK_HTTP_ERROR', message, response.status >= 500 || response.status === 429);
    }
    const answer = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
    if (typeof answer !== 'string') {
      throw new RequestError('BAD_RESPONSE', 'DeepSeek response did not contain an answer', true);
    }
    return { answer: answer.trim() };
  });
}

function buildStatusUrl(payload) {
  const origin = assertPlainOrigin(requireString(payload, 'origin'));
  const objectId = requireString(payload, 'objectId');
  const fid = requireString(payload, 'fid');
  const cacheBust = requireInteger(payload, 'cacheBust');
  const url = new URL(`/ananas/status/${encodeURIComponent(objectId)}`, origin);
  url.search = new URLSearchParams({ k: fid, flag: 'normal', _dc: String(cacheBust) }).toString();
  return { url, origin };
}

function buildReportUrl(payload) {
  const reportUrl = assertAbsoluteChaoxingUrl(requireString(payload, 'reportUrl'), 'reportUrl');
  const dtoken = requireString(payload, 'dtoken');
  const params = {
    clazzId: requireString(payload, 'clazzId'),
    playingTime: String(requireNumber(payload, 'playingTime')),
    duration: String(requireNumber(payload, 'duration')),
    clipTime: `0_${String(payload.duration)}`,
    objectId: requireString(payload, 'objectId'),
    otherInfo: requireString(payload, 'otherInfo'),
    jobid: requireString(payload, 'jobid'),
    userid: requireString(payload, 'userid'),
    isdrag: String(requireInteger(payload, 'isdrag')),
    view: 'pc',
    enc: requireString(payload, 'enc'),
    rt: requireString(payload, 'rt'),
    dtype: 'Video',
    _t: String(requireInteger(payload, 'timestamp'))
  };
  if (!['0', '4'].includes(params.isdrag)) {
    throw new RequestError('INVALID_FIELD', 'isdrag must be 0 or 4', false);
  }
  const url = new URL(dtoken, `${reportUrl.origin}${reportUrl.pathname.endsWith('/') ? reportUrl.pathname : `${reportUrl.pathname}/`}`);
  url.search = new URLSearchParams(params).toString();
  return url;
}

function buildJobUrl(payload, kind) {
  const origin = assertPlainOrigin(requireString(payload, 'origin'));
  const pathByKind = {
    CX_DOCUMENT: '/ananas/job/document',
    CX_READV2: '/ananas/job/readv2',
    CX_JOB: '/ananas/job'
  };
  const url = new URL(pathByKind[kind], origin);
  url.search = new URLSearchParams({
    jobid: requireString(payload, 'jobid'),
    knowledgeid: requireString(payload, 'knowledgeid'),
    courseid: requireString(payload, 'courseid'),
    clazzid: requireString(payload, 'clazzid'),
    jtoken: requireString(payload, 'jtoken'),
    _dc: String(requireInteger(payload, 'cacheBust'))
  }).toString();
  return url;
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch (_error) {
    throw new RequestError('BAD_RESPONSE', 'server response was not valid JSON', true);
  }
}

async function handleChaoxingRequest(type, payload) {
  let url;
  let headers;
  if (type === 'CX_STATUS') {
    const built = buildStatusUrl(payload);
    url = built.url;
    const originUrl = new URL(built.origin);
    headers = { Host: originUrl.host, Referer: `${built.origin}/ananas/modules/video/index.html` };
  } else if (type === 'CX_REPORT') {
    url = buildReportUrl(payload);
  } else {
    url = buildJobUrl(payload, type);
  }
  const response = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    credentials: 'include',
    headers
  }, DEEPSEEK_DEFAULT_TIMEOUT_MS);
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new RequestError('CX_HTTP_ERROR', `Learning platform HTTP ${response.status}`, response.status >= 500 || response.status === 429);
  }
  return data;
}

async function handleCache(type, payload) {
  if (!isRecord(payload)) {
    throw new RequestError('INVALID_PAYLOAD', 'payload must be an object', false);
  }
  const key = requireString(payload, 'key');
  if (!/^cache:[^:]+:[0-9a-f]{32}$/.test(key)) {
    throw new RequestError('INVALID_FIELD', 'cache key is invalid', false);
  }
  if (type === 'CACHE_GET') {
    const values = await readStorage([key]);
    return values[key] === undefined ? { found: false } : { found: true, value: String(values[key]) };
  }
  const value = requireString(payload, 'value');
  await chrome.storage.local.set({ [key]: value });
  return { saved: true };
}

async function dispatchMessage(message) {
  if (!isRecord(message) || !ALLOWED_MESSAGE_TYPES.has(message.type)) {
    throw new RequestError('UNSUPPORTED_MESSAGE', 'message type is not allowed', false);
  }
  switch (message.type) {
    case 'DEEPSEEK_CHAT':
      return handleDeepSeek(message.payload);
    case 'CX_STATUS':
    case 'CX_REPORT':
    case 'CX_DOCUMENT':
    case 'CX_READV2':
    case 'CX_JOB':
      return handleChaoxingRequest(message.type, message.payload);
    case 'CACHE_GET':
    case 'CACHE_SET':
      return handleCache(message.type, message.payload);
    default:
      throw new RequestError('UNSUPPORTED_MESSAGE', 'message type is not allowed', false);
  }
}

if (globalThis.chrome && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const requestId = isRecord(message) && typeof message.requestId === 'string' ? message.requestId : '';
    Promise.resolve()
      .then(() => dispatchMessage(message))
      .then((data) => sendResponse(makeSuccess(requestId, data)))
      .catch((error) => {
        const normalized = error instanceof RequestError
          ? error
          : new RequestError('INTERNAL_ERROR', error && error.message ? error.message : 'request failed', false);
        sendResponse(makeFailure(requestId, normalized.code, normalized.message, normalized.retryable));
      });
    return true;
  });
}
