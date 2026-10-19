// 真实浏览器实测服务器：仿真 u.unipus.cn 语音题页（加密题目下发 + 提交端点记录）
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9445;
const KEY = '20261019';

// 与 unipus.js 同款加密：AES-128-ECB ZeroPadding，key = UTF8("1a2b3c4d" + k)
function encryptUnipus(plainText, k) {
  const key = Buffer.from('1a2b3c4d' + k, 'utf8');
  let data = Buffer.from(plainText, 'utf8');
  const pad = (16 - (data.length % 16)) % 16;
  if (pad) data = Buffer.concat([data, Buffer.alloc(pad, 0)]);
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return 'unipus.' + Buffer.concat([cipher.update(data), cipher.final()]).toString('hex');
}

// 题目载荷：1 道语音题（speaking）+ 1 道判断题（验证完整链路 + DeepSeek mock）
const inner1 = { replyType: 'speaking', contents: [{ text: '朗读以下句子' }], children: [], quesText: 'Read the sentence aloud: Hello world, welcome to unipus.' };
const questionPayload = [
  { id: 'q1', content: JSON.stringify(inner1), answer: JSON.stringify({ value: [] }), analysis: '', quesId: 'q1' },
];
const encrypted = encryptUnipus(JSON.stringify(questionPayload), KEY);

const submissions = [];
const stopRequests = [];

const page = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');

const server = https.createServer({
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
}, (req, res) => {
  const url = new URL(req.url, 'https://u.unipus.cn');
  console.log(`[server] ${req.method} ${url.pathname}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const body = page.replace('__QUESTION_PAYLOAD__', encrypted).replace('__K__', KEY);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }
  if (url.pathname === '/course/api/v3/content/quiz' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, content: encrypted, k: KEY }));
    return;
  }
  if (url.pathname === '/course/api/v3/newExploration/submit' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* ignore */ }
      submissions.push({ at: Date.now(), body: parsed, usedTime: parsed && parsed.usedTime });
      console.log('[server] SUBMIT received: usedTime=' + (parsed && parsed.usedTime) +
        ' answerLeaf=' + JSON.stringify(parsed && parsed.quesDatas && parsed.quesDatas[0] && parsed.quesDatas[0].answer).slice(0, 120));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: 'ok' }));
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => console.log('[server] listening on https://u.unipus.cn:' + PORT + ' (via --host-resolver-rules)'));
process.on('SIGINT', () => process.exit(0));