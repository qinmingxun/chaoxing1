# 刷课助手（MV3 浏览器扩展）

u校园/超星/智慧树自动刷课扩展。纯原生 JS 零构建，GitHub: qinmingxun/chaoxing1。
实测平台：Edge 浏览器，u校园 AI 版为主。

## 状态文档（按权威顺序，动手前必读）

1. `PROJECT_STATE.json` — 多 Agent 总控状态机（AGENT 00–28 的 PASS/PENDING/BLOCKED）
2. `AGENT_STATUS.md` — Agent 事件流水（含 AGENT 29/30：语音停止加固与真实浏览器实测）
3. `docs/HANDOFF-2026-10-19-voice-stop-hardening.md` — 最近交接文档（语音停止加固 + 实测结果）
4. `REMAINING_TODO.md` — 刻意保持的遗留项（DOM 待核对、u校园题目解密已破解等）
5. `spec/INDEX.md` — 规格分节索引（FULL_SPEC 拆分）
6. `CONTRACTS.md` / `FINAL_AUDIT.md` / `TEST_REPORT.md` — 契约与验收

## 当前主线

u校园 AI 版全自动刷课循环：拦截新题 → 解密求解（DeepSeek，并发 3）→ 填答 → 自动提交 → 翻页。已完成并实测。语音题"录音停止"卡点已做三级停止加固（2026-10-19，AGENT 29：组内停止文本 → 全页扫描 → MAIN bridge 强制 MediaRecorder.stop + 回执验证 + 录音中 DOM 快照日志），**等用户重测确认**；若仍失败，日志含自动快照可直接定位。

## 关键约束

- 用户拒绝真实麦克风收音（环境噪声）→ 语音题走合成音频流注入（getUserMedia 覆写）
- 求解间隔 5 秒/题保留，不以速度换正确率
- 语音题评分为 0 可接受（合成音非朗读内容），跳过即可

## 环境注意

- 测试：用户在 Edge 实测（edge://extensions 重载扩展 + 页面 Ctrl+Shift+R）；本地真实浏览器实测环境见 `verify-live/`（`node run-test.mjs deaf|normal`，AGENT 30 双模式全通）
- git 推送（FastGithub 反向代理模式，2026-10-19 实测可用；原空代理直连已被墙）：
  1. 确认 FastGithub 在运行：`D:\FastGithub\publish\fastgithub_win-x64\FastGithub.UI.exe`（服务进程 fastgithub.exe 监听 127.0.0.1:443）
  2. `git -c credential.helper=wincred -c http.sslBackend=schannel -c http.schannelCheckRevoke=false -c http.curloptResolve=github.com:443:127.0.0.1 push origin main`
  （原理：curloptResolve 把 github.com 钉到本机走 FastGithub 隧道；schannelCheckRevoke=false 绕过其自签 CA 的吊销检查失败；openssl 后端本机 git 不支持，用 schannel）
- DeepSeek API：官方直连 `https://api.deepseek.com`，key 在扩展配置里由用户填写
- **调试接管 Edge（AI 直接操作浏览器，2026-10-20 实测）**：
  1. Edge 155 对**已有 profile** 会忽略 `--load-extension`（安全策略），必须用**全新 profile 目录**
  2. 启动：`msedge.exe --remote-debugging-port=9222 --user-data-dir=<全新目录> --load-extension=E:\刷课 --disable-extensions-except=E:\刷课 --window-size=1600,1000`
  3. 新 profile 无登录态 → 需在调试窗口登录一次 u校园
  4. CDP 驱动：`curl http://127.0.0.1:9222/json/list` 拿 webSocketDebuggerUrl，Node 24 原生 WebSocket 直连
  5. 视口太小用 `Emulation.setDeviceMetricsOverride {width:1600,height:950,deviceScaleFactor:1}` 修正
  6. 验证扩展版本：页面执行 `document.documentElement.dataset.courseHelperVersion` 取运行时版本串，再与 `git log --oneline -1` 及 `content/loader.js` 的 `ADAPTER_VERSION` 对齐——**不要在本文件写死版本号**（此前写死的 v2026-10-20.6 已过期 70+ 个版本，本身即是漂移源；权威值见 PROJECT_STATE.json 的 version_authority）
- **真实平台域名**：AI 版主站 `uai.unipus.cn`（U校园5.0）；刷课页在 `ucontent.unipus.cn/_explorationpc_default/pc.html`（SPA hash 路由）——两者均被 manifest 的 `*://*.unipus.cn/*` 覆盖

## 记忆沉淀（跨会话防丢失）

- 本文件是权威指令；另维护 `MEMORY.md`（一行一条、带日期前缀、只追加）：新踩的坑、新发现的页面结构/选择器变化、新的硬约束数字（端口/路径/版本）写入那里
- 动手前先读本文件 + `PROJECT_STATE.json` + 工作区记忆 `D:\UserData\Documents\deepseek-harness\default-workspace\MEMORY.md`（该文件不在本仓库内，随 DSH 工作区走；其末尾有【防漂移锚点】区块，迁移前先更新）
- 会话结束或换会话（含 Bridge 迁移）前：检查本次会话有无应沉淀进 MEMORY.md 的新事实；交接摘要的"关键文件"段必须列出本文件和 MEMORY.md
