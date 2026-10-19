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
const PAGE_URL = 'https://u.unipus.cn:9445/?case=voice&deaf=' + (mode === 'deaf' ? '1' : '0');
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
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await sleep(2500);

  // 5. 轮询页面状态（最多 60 秒）：等待 submitted=true
  log('polling page state (mode=' + mode + ')…');
  let submitted = false, stopOk = false, micClicks = 0, selected = null, stopCmdSent = false;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({submitted:!!window.__submitted,stopOk:!!window.__stopOk,micClicks:window.__micClicks||0,selected:window.__selectedOption,recError:window.__recordError||null,st:(document.getElementById("st")||{}).textContent||"",rec:(document.getElementById("recState1")||{}).textContent||""})', returnByValue: true });
    const s = JSON.parse(r.result.value);
    submitted = s.submitted; stopOk = s.stopOk; micClicks = s.micClicks; selected = s.selected;
    if (submitted) break;
    await sleep(1500);
  }

  // 6. 收集扩展日志（页面 console 里 course-helper 相关行）与最终状态
  const finalState = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({st:(document.getElementById("st")||{}).textContent||"",rec:(document.getElementById("recState1")||{}).textContent||"",groupChildren:[...(window.__groupEl?window.__groupEl.children:[])].map(c=>c.id+":"+c.textContent)})', returnByValue: true });
  const helperLogs = cdp.consoleLogs.filter((l) => l.includes('course-helper') || l.includes('[unipus]'));

  // 7. 输出报告
  console.log('\n===== 实测报告（mode=' + mode + '）=====');
  console.log('页面最终状态:', finalState.result.value);
  console.log('--- 扩展 console 日志（course-helper 相关，共 ' + helperLogs.length + ' 条）---');
  for (const l of helperLogs) console.log('  ' + l.slice(0, 240));
  console.log('--- 关键断言 ---');
  console.log((stopOk ? 'PASS' : 'FAIL') + ' 录音已停止（__stopOk）');
  console.log((submitted ? 'PASS' : 'FAIL') + ' 页面提交成功（__submitted）');
  console.log((micClicks >= 1 ? 'PASS' : 'FAIL') + ' 录音开始按钮被扩展点击（micClicks=' + micClicks + '）');
  console.log((selected !== null ? 'PASS' : 'INFO') + ' 判断题选项（本场景为纯语音页，值为 ' + (selected || 'none') + '）');
  const pass = stopOk && submitted && micClicks >= 1;
  console.log('\n===== ' + (pass ? 'ALL-PASS ✓' : 'HAS-FAILURES ✗') + ' =====');

  ws.close();
  try { edge.kill(); } catch {}
  try { server.kill(); } catch {}
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('[driver] FATAL:', e); process.exit(2); });