// 真实浏览器实测服务器 v2：SPA 两页刷课循环仿真
// 第 1 页：语音题（speaking，占位跳过）——验证停止策略与占位提交
// 第 2 页：判断 + 填空——验证 DeepSeek 求解（mock）、选项点击、填空填答
// 提交成功后平台展示"继续学习"按钮 → 翻页（SPA，不刷新）→ 下一页题目 XHR
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9445;
const KEY = '20261020';

function encryptUnipus(plainText, k) {
  const key = Buffer.from('1a2b3c4d' + k, 'utf8');
  let data = Buffer.from(plainText, 'utf8');
  const pad = (16 - (data.length % 16)) % 16;
  if (pad) data = Buffer.concat([data, Buffer.alloc(pad, 0)]);
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return 'unipus.' + Buffer.concat([cipher.update(data), cipher.final()]).toString('hex');
}

// ---- 两页题目载荷 ----
const innerVoice = { replyType: 'speaking', contents: [{ text: '朗读以下句子' }], children: [], quesText: 'Read the sentence aloud: Hello world, welcome to unipus.' };
const innerJudge = { replyType: 'judge', contents: [{ text: '地球是圆的' }], children: [], quesText: '地球是圆的', options: [{ optionText: 'A. 对' }, { optionText: 'B. 错' }] };
const innerFill = { replyType: 'fillblank', contents: [{ text: '1) The sky is ____1____.' }], children: [], quesText: 'The sky is ____1____.' };

const PAGE_PAYLOADS = {
  1: [
    { id: 'p1-voice', content: JSON.stringify(innerVoice), answer: JSON.stringify({ value: [] }), analysis: '', quesId: 'p1-voice' },
  ],
  2: [
    { id: 'p2-judge', content: JSON.stringify(innerJudge), answer: JSON.stringify({ value: [] }), analysis: '', quesId: 'p2-judge' },
    { id: 'p2-fill', content: JSON.stringify(innerFill), answer: JSON.stringify({ value: [], children: [{ value: [] }] }), analysis: '', quesId: 'p2-fill' },
  ],
};
const ENCRYPTED_PAGES = Object.fromEntries(
  Object.entries(PAGE_PAYLOADS).map(([page, payload]) => [page, encryptUnipus(JSON.stringify(payload), KEY)])
);

// ---- 状态 ----
const submissions = [];        // {page, body, injected:boolean}
const deepseekCalls = [];      // 收到的求解请求
let quizFetchCount = 0;        // 题目下发次数（第 1 页一次 + 翻页后一次）


// ---- 弹窗测试页（模拟平台 antd 弹窗：信息框 + 关闭动画）----
const DIALOG_TEST_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>dialog test</title>
<style>
body{font-family:system-ui;margin:20px}
.ant-modal-wrap{position:fixed;inset:0;z-index:1000;display:block}
.ant-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.45)}
.ant-modal{position:relative;width:420px;margin:120px auto;background:#fff;border-radius:8px;padding:18px;box-shadow:0 6px 20px rgba(0,0,0,.2)}
.ant-btn{padding:5px 16px;border-radius:6px;background:#1677ff;color:#fff;border:none;cursor:pointer}
.ant-modal-wrap.ant-fade-leave{opacity:.4}
.ant-modal.ant-zoom-leave{transform:scale(.96)}
#log{margin-top:16px;font-family:Consolas,monospace;color:#333}
</style></head>
<body>
<h1>dialog test page</h1>
<div id="log">clicks=0</div>
<script>
window.__clicks = 0;
window.__dialogShown = 0;
function showDialog() {
  window.__dialogShown += 1;
  var wrap = document.createElement('div');
  wrap.className = 'ant-modal-root';
  wrap.innerHTML =
    '<div class="ant-modal-mask"></div>' +
    '<div class="ant-modal-wrap">' +
      '<div class="ant-modal ant-modal-confirm ant-modal-confirm-info system-info-cloud-modal">' +
        '<div class="ant-modal-content"><div class="ant-modal-body">' +
          '<div class="ant-modal-confirm-body-wrapper">' +
            '<div class="ant-modal-confirm-body">' +
              '<span class="cloud-modal-info-icon">!</span>' +
              '<div class="ant-modal-confirm-content">还有1道题没有作答，请完成后提交。</div>' +
            '</div>' +
            '<div class="ant-modal-confirm-btns">' +
              '<button class="ant-btn ant-btn-primary system-info-cloud-ok-button"><span>我知道了</span></button>' +
            '</div>' +
          '</div>' +
        '</div></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);
  var btn = wrap.querySelector('button');
  btn.addEventListener('click', function () {
    window.__clicks += 1;
    document.getElementById('log').textContent = 'clicks=' + window.__clicks;
    wrap.querySelector('.ant-modal-wrap').classList.add('ant-fade-leave');
    wrap.querySelector('.ant-modal').classList.add('ant-zoom-leave');
    setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 1500);
  });
}
window.__showDialog = showDialog;
setTimeout(showDialog, 1200);
</script>
</body></html>`;

const page = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');

const server = https.createServer({
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
}, (req, res) => {
  const url = new URL(req.url, 'https://u.unipus.cn');
  const q = url.searchParams;

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page.replace('__K__', KEY));
    return;
  }
  // 题目下发：?page=N（页载荷）；无 page 参数默认第 1 页
  if (url.pathname === '/course/api/v3/content/quiz' && req.method === 'GET') {
    quizFetchCount += 1;
    const pageNo = q.get('page') === '2' ? 2 : 1;
    console.log('[server] quiz page ' + pageNo + ' fetched (total ' + quizFetchCount + ')');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, content: ENCRYPTED_PAGES[pageNo], k: KEY }));
    return;
  }
  // DeepSeek mock：判断题固定回 B；填空题回 blue
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let reqBody = null;
      try { reqBody = JSON.parse(raw); } catch { /* ignore */ }
      const userText = reqBody && reqBody.messages && reqBody.messages.find((m) => m.role === 'user');
      const isFill = userText && userText.content.includes('"qtype":2');
      const answer = isFill ? 'blue' : 'B';
      deepseekCalls.push({ at: Date.now(), qtype: isFill ? 2 : 3, answer });
      console.log('[server] DeepSeek mock: qtype=' + (isFill ? 2 : 3) + ' -> ' + answer);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: answer } }],
      }));
    });
    return;
  }
  if (url.pathname === '/course/api/v3/newExploration/submit' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* ignore */ }
      const page = q.get('page') === '2' ? 2 : 1;
      submissions.push({ at: Date.now(), page, body: parsed, usedTime: parsed && parsed.usedTime });
      console.log('[server] SUBMIT page ' + page + ': usedTime=' + (parsed && parsed.usedTime) +
        ' ques=' + (parsed && parsed.quesDatas ? parsed.quesDatas.length : '?') +
        ' answers=' + JSON.stringify(parsed && parsed.quesDatas && parsed.quesDatas.map((x) => x.answer)).slice(0, 200));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: 'ok' }));
    });
    return;
  }
  // 弹窗测试页（离线验证 MAIN bridge 的弹窗自动确认 + 去重逻辑，不需要登录）
  if (url.pathname === '/dialog-test' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DIALOG_TEST_PAGE);
    return;
  }
  // 状态查询（driver 轮询/断言用）
  if (url.pathname === '/__teststate' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const last = submissions.length ? submissions[submissions.length - 1] : null;
    res.end(JSON.stringify({
      submissions: submissions.length,
      deepseekCalls: deepseekCalls.length,
      quizFetchCount,
      lastAnswers: last && last.body && Array.isArray(last.body.quesDatas)
        ? last.body.quesDatas.map((q) => q.answer)
        : null,
      lastUsedTime: last ? last.usedTime : null,
    }));
    return;
  }
  // 重置状态（driver 开场调用，保证断言干净）
  if (url.pathname === '/__testreset' && req.method === 'POST') {
    submissions.length = 0; deepseekCalls.length = 0; quizFetchCount = 0;
    console.log('[server] state reset');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => console.log('[server] listening on https://u.unipus.cn:' + PORT + ' (v2 two-page cycle)'));
process.on('SIGINT', () => process.exit(0));