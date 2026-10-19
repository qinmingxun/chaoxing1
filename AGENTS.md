# 刷课助手（MV3 浏览器扩展）

u校园/超星/智慧树自动刷课扩展。纯原生 JS 零构建，GitHub: qinmingxun/chaoxing1。
实测平台：Edge 浏览器，u校园 AI 版为主。

## 状态文档（按权威顺序，动手前必读）

1. `PROJECT_STATE.json` — 多 Agent 总控状态机（AGENT 00–28 的 PASS/PENDING/BLOCKED）
2. `AGENT_STATUS.md` — Agent 事件流水
3. `docs/HANDOFF-2026-10-18-u-campus-voice.md` — 最近交接文档（当前主线卡点）
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

- 测试：用户在 Edge 实测（edge://extensions 重载扩展 + 页面 Ctrl+Shift+R）
- git 推送：`git -c http.proxy= -c https.proxy= push origin main`（空代理直连）
- DeepSeek API：官方直连 `https://api.deepseek.com`，key 在扩展配置里由用户填写
