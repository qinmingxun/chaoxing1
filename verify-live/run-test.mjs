// 真实浏览器实测驱动：Node 24 裸 WebSocket 连 CDP，全流程断言
// 用法：node run-test.mjs <deaf|normal>
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] || 'deaf'; // deaf：停止点击被拒（复现卡点）；normal：普通
const CDP_PORT = 9444;
const PAGE_URL = 'https://u.unipus.cn:9445/?deaf=' + (mode === 'deaf' ? '1' : '0');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(process.env.TEMP || __dirname, 'edge-voice-e2e-' + mode + '-' + Date.now());

const log = (...a) => console.log('[driver]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpSend(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(method + ' -> ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function waitEvent(ws, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error('TIMEOUT waiting: ' + label)); }, timeoutMs);
    const onMsg = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.method && predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        resolve(msg);
      }
    };
    ws.addEventListener('message', onMsg);
  });
}

// 简易 CDP 客户端
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleLogs = [];
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ');
        this.consoleLogs.push('[' + msg.params.type + '] ' + text);
        log('console:', text.slice(0, 200));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleLogs.push('[exception] ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
}

async function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  // 2. 启动服务器
  log('starting https server…');
  const server = spawn('node', [path.join(__dirname, 'server.mjs')], { stdio: 'pipe' });
  server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  server.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d));
  await sleep(1200);

  // 3. 启动 Edge
  log('starting Edge headless with extension…');
  const edge = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + PROFILE,
    '--load-extension=E:\\刷课',
    '--disable-extensions-except=E:\\刷课',
    '--no-first-run',
    '--ignore-certificate-errors',
    '--disable-features=msSmartScreenProtection',
    '--allow-running-insecure-content',
    '--unsafely-treat-insecure-origin-as-secure=https://u.unipus.cn:9445',
    '--host-resolver-rules=MAP u.unipus.cn 127.0.0.1:9445',
    'about:blank',
  ], { stdio: 'ignore' });

  // 4. 等待 CDP 就绪并找到目标页面
  let targets = null;
  for (let i = 0; i < 20; i += 1) {
    try { targets = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list'); break; } catch { await sleep(500); }
  }
  if (!targets) throw new Error('CDP not reachable');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.evaluate', { expression: 'window.__consoleTail = []' });
  // 采集 console 的另一条路：写入 window 数组，供最后断言读取
    // 预置扩展配置：DeepSeek API key（值任意，mock 不校验）——通过 SW target 写 storage
  // 注意：unpacked 扩展在 headless 下可能于导航/生命周期事件中被重载，
  // storage.local 会在重载时清空（观察到的现象），因此导航后再补写一次。
  const presetStorage = async () => {
    try {
      const ts = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      const swt = ts.find((t) => (t.type === 'service_worker' || t.type === 'background_page') && /background\/service-worker\.js$/.test(t.url));
      if (!swt) { log('preset: no SW target now'); return; }
      const w = new WebSocket(swt.webSocketDebuggerUrl);
      await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
      const pn = { n: 0 };
      const snd = (method, params) => new Promise((resolve, reject) => {
        const id = ++pn.n;
        const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { w.removeEventListener('message', onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
        w.addEventListener('message', onMsg);
        w.send(JSON.stringify({ id, method, params: params || {} }));
      });
      await snd('Runtime.enable');
      const rr = await snd('Runtime.evaluate', { expression: `
        new Promise((done) => {
          chrome.storage.local.set({ deepseekApiKey: 'test-key-for-mock', deepseekModel: 'deepseek-chat', autoAnswer: true, autoSubmit: true, deepseekTimeoutMs: 8000, deepseekApiBase: 'https://u.unipus.cn:9445/v1/chat/completions' },
            () => done(chrome.runtime.lastError ? 'ERR:' + chrome.runtime.lastError.message : 'ok'));
        })`, awaitPromise: true, returnByValue: true });
      log('re-preset via SW: ' + rr.result.value);
      w.close();
    } catch (e) { log('re-preset failed: ' + e.message); }
  };
  try {
    const swTarget = targets.find((t) => (t.type === 'service_worker' || t.type === 'background_page') &&
        /background\/service-worker\.js$/.test(t.url));
      if (swTarget) log('using SW target: ' + swTarget.url.slice(0, 90));
      if (!swTarget) log('AVAILABLE targets: ' + JSON.stringify(targets.map((t) => t.type + '|' + t.url.slice(0, 80))));
    if (swTarget) {
      const swWs = new WebSocket(swTarget.webSocketDebuggerUrl);
      await new Promise((res, rej) => { swWs.onopen = res; swWs.onerror = rej; });
      const swId = { n: 0 };
      const swSend = (method, params) => new Promise((resolve, reject) => {
        const id = ++swId.n;
        const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { swWs.removeEventListener('message', onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
        swWs.addEventListener('message', onMsg);
        swWs.send(JSON.stringify({ id, method, params: params || {} }));
      });
      await swSend('Runtime.enable');
      const presetResult = await swSend('Runtime.evaluate', { expression: `
        new Promise((done) => {
          if (!chrome || !chrome.storage || !chrome.storage.local) { done('NO-STORAGE-API'); return; }
          chrome.storage.local.set({
            deepseekApiKey: 'test-key-for-mock',
            deepseekModel: 'deepseek-chat',
            autoAnswer: true,
            autoSubmit: true,
            deepseekTimeoutMs: 8000
          }, () => {
            const err = chrome.runtime.lastError;
            done(err ? 'SET-ERROR: ' + err.message : 'preset-ok');
          });
        })`, awaitPromise: true, returnByValue: true });
      log('preset evaluate result: ' + JSON.stringify(presetResult.result && presetResult.result.value));
      const idResult = await swSend('Runtime.evaluate', { expression: 'chrome.runtime.id', returnByValue: true });
      log('SW extension id: ' + idResult.result.value);
      const readBack = await swSend('Runtime.evaluate', { expression: `
        new Promise((done) => {
          chrome.storage.local.get(['deepseekApiKey'], (v) => done(JSON.stringify(v && v.deepseekApiKey)));
        })`, awaitPromise: true, returnByValue: true });
      log('storage readback after set: ' + readBack.result.value);
      // 保持 SW 连接（引用），预置后立即关闭也可能只是正常关闭
      swWs.close();
      log('extension storage preset via service worker (deepseekApiKey=test-key-for-mock)');
    } else log('no service worker target found, storage preset skipped');
  } catch (e) { log('storage preset failed (non-fatal): ' + e.message); }

  await cdp.send('Page.navigate', { url: PAGE_URL });
  await sleep(2500);

  // 5. 轮询页面状态（最多 60 秒）：等待 submitted=true
  await presetStorage(); // 导航后再补写（防 unpacked 扩展重载清 storage）
  log('polling page state (mode=' + mode + ')…');
  let submitted = false, stopOk = false, micClicks = 0, selected = null, stopCmdSent = false, rePresetDone = false;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__cycle || {})', returnByValue: true });
    const s = JSON.parse(r.result.value || '{}');
    submitted = (s.submitted || []).length; stopOk = !!s.stopOk; micClicks = s.micClicks || 0; selected = s.selectedOption;
    if (submitted >= 2) break;
    if ((s.pagesRendered || []).includes(2) && !s.selectedOption && !rePresetDone) {
      rePresetDone = true;
      await presetStorage();
    }
    await sleep(1500);
  }

  // 6. 服务端状态 + 最终页面状态
  let serverState = null;
  try {
    const resp = await fetch('https://u.unipus.cn:9445/__teststate', { agent: false, rejectUnauthorized: false }).catch(() => null);
  } catch {}
  // Node fetch 对自签证书：用 child curl 简化
  const { execSync } = await import('node:child_process');
  try {
    serverState = JSON.parse(execSync('curl -sk https://127.0.0.1:9445/__teststate', { encoding: 'utf8' }));
  } catch (e) { serverState = { submissions: -1, deepseekCalls: -1, quizFetchCount: -1 }; }
  const finalState = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({cycle:window.__cycle, st:(document.getElementById("st")||{}).textContent||"", pageTag:(document.getElementById("pageTag")||{}).textContent||"", fillVal:(document.getElementById("fill1")||{}).value||null})', returnByValue: true });
  // 页面 MAIN world 看不到 chrome API；isolated world 才看得到。用 Runtime.evaluate 的 contextId 不易拿——跳过，
  // 改从扩展 SW 侧看日志：SW console 也在 CDP（若连着）。此处打印 SW 目标列表用于诊断
  try {
    const targetsNow = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
    log('targets at end: ' + JSON.stringify(targetsNow.map((t) => t.type + '|' + t.url.slice(0, 70))));
  } catch (e) { log('targets list failed: ' + e.message); }
  const helperLogs = cdp.consoleLogs.filter((l) => l.includes('course-helper') || l.includes('[unipus]'));
  // SW 处理请求后再次 readback（排查 storage 是否中途丢失）
  try {
    const targets2 = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
    const sw2 = targets2.find((t) => (t.type === 'service_worker' || t.type === 'background_page') && /background\/service-worker\.js$/.test(t.url));
    if (sw2) {
      const ws2 = new WebSocket(sw2.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej; });
      const p2 = { n: 0 };
      const send2 = (method, params) => new Promise((resolve, reject) => {
        const id = ++p2.n;
        const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws2.removeEventListener('message', onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
        ws2.addEventListener('message', onMsg);
        ws2.send(JSON.stringify({ id, method, params: params || {} }));
      });
      await send2('Runtime.enable');
      const rb2 = await send2('Runtime.evaluate', { expression: `
        new Promise((done) => {
          chrome.storage.local.get(null, (v) => done(JSON.stringify(v)));
        })`, awaitPromise: true, returnByValue: true });
      log('storage full readback (late): ' + String(rb2.result.value).slice(0, 300));
      ws2.close();
    } else log('late readback: no SW target');
  } catch (e) { log('late readback failed: ' + e.message); }

  // 7. 输出报告
  console.log('\n===== 实测报告（mode=' + mode + '，两页循环）=====');
  console.log('页面最终状态:', finalState.result.value);
  console.log('服务端状态:', JSON.stringify(serverState));
  console.log('--- 扩展 console 日志（course-helper 相关，共 ' + helperLogs.length + ' 条）---');
  for (const l of helperLogs) console.log('  ' + l.slice(0, 240));
  console.log('--- 关键断言 ---');
  const cycle = (() => { try { return JSON.parse(finalState.result.value).cycle; } catch { return {}; } })();
  console.log((serverState.submissions === 2 ? 'PASS' : 'FAIL') + ' 两次提交（page1 语音 + page2 判断/填空），服务器收到 ' + serverState.submissions);
  console.log((cycle.stopOk ? 'PASS' : 'FAIL') + ' 语音题录音已停止（第 1 页）');
  console.log((cycle.micClicks >= 1 ? 'PASS' : 'FAIL') + ' 录音开始按钮被扩展点击（micClicks=' + cycle.micClicks + '，停止被拒 ' + (cycle.stopRejected || 0) + ' 次）');
  console.log((serverState.deepseekCalls >= 2 ? 'PASS' : 'FAIL') + ' DeepSeek mock 被调用（判断+填空，共 ' + serverState.deepseekCalls + ' 次）');
  console.log((cycle.selectedOption === 'B. 错' ? 'PASS' : 'FAIL') + ' 判断题选中 mock 答案 B（实际：' + (cycle.selectedOption || 'none') + '）');
  console.log((cycle.fillValue === 'blue' ? 'PASS' : 'FAIL') + ' 填空题填入 mock 答案 blue（实际：' + (cycle.fillValue || 'empty') + '）');
  console.log((cycle.pagesRendered && cycle.pagesRendered.includes(2) ? 'PASS' : 'FAIL') + ' SPA 翻页到第 2 页（渲染历史：' + JSON.stringify(cycle.pagesRendered) + '）');
  console.log((serverState.quizFetchCount === 2 ? 'PASS' : 'FAIL') + ' 题目 XHR 两次下发（第 1 页 + 翻页后），实际 ' + serverState.quizFetchCount);
  const injectedOk = serverState.submissions === 2; // 提交本身成功（注入改写在 bridge 日志里看）
  const pass = cycle.stopOk && cycle.micClicks >= 1 && serverState.submissions === 2 &&
    serverState.deepseekCalls >= 2 && cycle.selectedOption === 'B. 错' && cycle.fillValue === 'blue' &&
    cycle.pagesRendered && cycle.pagesRendered.includes(2);
  console.log('\n===== ' + (pass ? 'ALL-PASS ✓' : 'HAS-FAILURES ✗') + ' =====');

  ws.close();
  try { edge.kill(); } catch {}
  try { server.kill(); } catch {}
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('[driver] FATAL:', e); try { edge.kill(); } catch {} try { server.kill(); } catch {} process.exit(2); });
