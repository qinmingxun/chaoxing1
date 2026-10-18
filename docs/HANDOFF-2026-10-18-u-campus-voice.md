# Handoff

## Objective

E:\刷课「刷课助手」MV3 浏览器扩展（GitHub: qinmingxun/chaoxing1，纯原生 JS 零构建）。当前主线：u校园 AI 版全自动刷课循环（实测调试阶段）。

## Completed

- u校园两种题目加密格式破解（AES-128-ECB ZeroPadding / OpenSSL Salted AES-256-CBC）
- SPA 切页全自动循环：拦截新题 → 解密求解（DeepSeek，并发 3）→ 页面可见填答 → 自动提交（bridge 注入改写 payload）→ 点"继续学习"翻页，全程无需刷新
- 选择题：option-wrap 真实结构点击 + 题干定位题块（一页多题防错位）
- 填空题：多空按 # 拆分；题干与答案双侧剥离题号前缀
- keep-alive：antd 弹窗"我知道了"自动点掉（MutationObserver + 2 秒轮询兜底，CSS 切换显示也能点）
- 语音题：识别占位跳过 + 合成音频流注入（MAIN bridge 覆写 getUserMedia 返回 Web Audio 音轨，不用真实麦克风——用户环境嘈杂、明确拒绝收音）
- manifest all_frames 已开；录音按钮点击目标取最深子元素（事件冒泡）

## Decisions and Rationale

- 用户不接受真实麦克风收音（环境噪声）→ 合成音频流方案，不用 TTS 外放方案
- 求解间隔默认 5 秒/题保留（用户：不以速度换正确率）；提速只靠并发 3 + 消除双重求解
- quiz-solver 并发仅 unipus 显式传入 concurrency 启用，学习通保持原串行行为

## Relevant / Changed Files

- content/adapters/unipus.js — u校园主逻辑（拦截/解密/答题/填答/自动提交/语音模拟录音）
- content/main-world-bridge.js — MAIN world：XHR/fetch 钩子、提交改写、getUserMedia 覆写、MediaRecorder 观测
- content/keep-alive.js — 保活 + 弹窗处理（含 antd 轮询）
- content/quiz-solver.js — 求解器（支持 options.concurrency 并发分批）
- manifest.json — all_frames: true

## Remaining Work

1. **语音题"录音停止"卡点**：录音开始后停止点击无效（React 重渲染替换节点）。已加 MediaRecorder.stop 观测 + "停止"文本扫描兜底（提交 dc78acb）。等用户重测，看日志：`MediaRecorder.stop 被调用` 是否出现、`尝试点击停止按钮` 是否命中；并请用户描述录音开始后的 UI（停止按钮位置/形态）。
2. 若平台对录音内容有校验（要求识别出文字），下一步把在线 TTS 音频注入合成流。

## 会话管理基建（2026-10-18 完成）

- 全局 handoff skill 已安装（C:\Users\Lenovo\.claude\skills\handoff\，含 scripts/session-state.sh）
- 全局 settings.json 已配 SessionStart hook（新会话自动打印项目状态与交接文档位置）
- 用户偏好：习惯 VSCode 扩展会话；说"交接"后助手完成文档+注册+推送，用户在 VSCode 点新建会话即可（不要开终端窗口）
- 项目记忆：C:\Users\Lenovo\.claude\projects\C--Users-Lenovo\memory\（u-campus-shuake-project.md 等）

## Known Issues / Open Questions

- MediaRecorder 流来源显示"其他音频流"——可能是平台 clone 了合成流（无害），也可能是 iframe 路径（已开 all_frames，待重测确认）
- 语音题评分预计为 0（合成音非朗读内容），用户接受"跳过"即可

## Verification State

- 本地 mock 验证：C:\Users\Lenovo\AppData\Local\Temp\cx-verify\ 下 unipus-*.mjs / bridge-fake-audio-e2e.mjs 等（node 直接跑）
- 真实平台验证：用户在 Edge 实测（edge://extensions 重载 + Ctrl+Shift+R）

## Recommended Next Action

让用户重测语音题页，收集日志与录音后 UI 描述，定位停止按钮真实交互。

## 环境注意

- git 推送：`git -c http.proxy= -c https.proxy= push origin main`（空代理直连；Clash 127.0.0.1:7890 时好时坏）
- 扩展重载：edge://extensions → 🔄 → 页面 Ctrl+Shift+R
