# 项目执行计划

本计划只描述辅助文件与各 Agent 的边界，不实现运行时代码。所有 Agent 必须先读取列出的只读 spec；共同约束来自 `spec/INDEX.md` 和 `CONTRACTS.md`。验收命令均应在 `E:/刷课` 执行；命令失败时先修正自身文件并重试一次，仍失败则保留失败证据、在状态卡报告并交回主控，不得擅自改 spec 或跨边界实现。

| Agent | 职责 | 负责文件 | 只读 spec | 依赖 | 验收命令 | 失败重试策略 |
|---|---|---|---|---|---|---|
| AGENT 00 | 规格汇总、分节复核与冻结证据 | `spec/FULL_SPEC.md`, `spec/INDEX.md`, `spec/*.md`（只读交付） | `spec/INDEX.md`, `spec/FULL_SPEC.md` | 无 | `python -I -c "from pathlib import Path; print(Path('spec/INDEX.md').exists() and Path('spec/FULL_SPEC.md').exists())"` | 重读索引与原文校验；失败交主控，不改原文 |
| AGENT 01 | 项目辅助文件、契约与状态初始化 | `CONTRACTS.md`, `PROJECT_PLAN.md`, `PROJECT_STATE.json`, `AGENT_STATUS.md`, `TEST_REPORT.md`, `REMAINING_TODO.md` | `spec/INDEX.md`, `spec/10-overview.md`, `spec/20-deepseek.md`, `spec/80-quality.md` | AGENT 00 | `python -I -m json.tool PROJECT_STATE.json`; `test -f CONTRACTS.md && ...` | 修正文档/JSON后重复命令；仍失败报告具体行 |
| AGENT 02 | MV3 manifest.json 清单实现 | `manifest.json` | `spec/10-overview.md`, `spec/60-popup-manifest.md` | AGENT 01 | `python -I -m json.tool manifest.json` | 修正 JSON、权限和域名后重跑一次；仍失败交回主控并保留证据 |
| AGENT 03 | background service worker 网络代理与 DeepSeek 请求 | `background/service-worker.js`（background 部分） | `spec/20-deepseek.md`, `spec/10-overview.md` | AGENT 01, 02 | `node --check background/service-worker.js` | 修正消息字段、超时和占位符后重跑一次；API 不联网验证 |
| AGENT 04 | MD5 实现与质量边界 | `lib/md5.js` | `spec/80-quality.md`, `CONTRACTS.md` | AGENT 01 | `node --check lib/md5.js` | 修正标准 MD5 输出后重跑一次；仍失败交回主控 |
| AGENT 05 | Typr 字体库与 table 数据 | `lib/typr.js`, `lib/table.json` | `spec/80-quality.md`, `spec/30f-font-decrypt.md` | AGENT 01 | `node --check lib/typr.js; python -I -m json.tool lib/table.json` | 资源无法核验则保留降级 TODO 并报告，不伪造 PASS |
| AGENT 06 | 通用 loader、路由与配置注册 | `content/loader.js` | `spec/10-overview.md`, `spec/60-popup-manifest.md` | AGENT 01, 02 | `node --check content/loader.js` | 修正导出、域名、路由和配置读取后重跑一次 |
| AGENT 07 | MAIN world bridge 事件桥接 | `content/main-world-bridge.js` | `spec/10-overview.md`, `spec/40-unipus.md` | AGENT 01, 06 | `node --check content/main-world-bridge.js` | 按 CONTRACTS 事件表修正后重跑一次；冲突交主控 |
| AGENT 08 | keep-alive 保活系统 | `content/keep-alive.js` | `spec/40-unipus.md`, `spec/10-overview.md` | AGENT 01, 07 | `node --check content/keep-alive.js` | 修正定时器、弹窗观察与清理后重跑一次 |
| AGENT 09 | 通用 video-manager | `content/video-manager.js` | `spec/10-overview.md`, `spec/30b-video-report.md`, `spec/30c-video-play.md` | AGENT 06, 07 | `node --check content/video-manager.js` | 修正计时、倍速、播放恢复和清理后重跑一次 |
| AGENT 10 | quiz-solver 区块 A：题型、清洗、缓存、请求 | `content/quiz-solver.js`（区块 A） | `spec/20-deepseek.md`, `spec/30-chaoxing.md`, `CONTRACTS.md` | AGENT 03, 04, 06 | `node --check content/quiz-solver.js` | 修正题型映射、缓存 key 和消息契约后重跑一次 |
| AGENT 11 | quiz-solver 区块 B：匹配、填答、提交 | `content/quiz-solver.js`（区块 B） | `spec/30-chaoxing.md`, `spec/30d-quiz-pc.md`, `CONTRACTS.md` | AGENT 10 | `node --check content/quiz-solver.js` | 以 fixture DOM 修正匹配、填空和提交后重跑一次 |
| AGENT 12 | 学习通分区 A：路由、任务解析、文档阅读读书 | `content/adapters/chaoxing.js`（分区 A） | `spec/30-chaoxing.md`, `spec/30a-task-parse.md` | AGENT 06, 10 | `node --check content/adapters/chaoxing.js` | 逐路由复验并标注待真实页面核对；仍失败交回主控 |
| AGENT 13 | 学习通分区 B：视频模拟上报 | `content/adapters/chaoxing.js`（分区 B） | `spec/30-chaoxing.md`, `spec/30b-video-report.md` | AGENT 03, 09, 12 | `node --check content/adapters/chaoxing.js` | 复核签名、时长、间隔和完成字段后重跑一次 |
| AGENT 14 | 学习通分区 C：正常播放降级 | `content/adapters/chaoxing.js`（分区 C） | `spec/30-chaoxing.md`, `spec/30c-video-play.md` | AGENT 09, 12 | `node --check content/adapters/chaoxing.js` | 修正 pause/ended 分支后重跑一次 |
| AGENT 15 | 学习通分区 D：PC 测验 | `content/adapters/chaoxing.js`（分区 D） | `spec/30-chaoxing.md`, `spec/30d-quiz-pc.md` | AGENT 10, 11, 12 | `node --check content/adapters/chaoxing.js` | 以 fixture DOM 修正选择器和填答后重跑一次 |
| AGENT 16 | 学习通分区 E：手机版作业与考试 | `content/adapters/chaoxing.js`（分区 E） | `spec/30-chaoxing.md`, `spec/30e-quiz-phone-work-exam.md` | AGENT 10, 11, 12 | `node --check content/adapters/chaoxing.js` | 分页/编辑器问题降级跳过并告警，重跑一次 |
| AGENT 17 | 学习通分区 F：font-cxsecret 字体解密 | `content/adapters/chaoxing.js`（分区 F） | `spec/30-chaoxing.md`, `spec/30f-font-decrypt.md` | AGENT 04, 05, 12 | `node --check content/adapters/chaoxing.js` | 资源或算法缺失时保留降级逻辑和 TODO，不伪造 PASS |
| AGENT 18 | 智慧树适配器 | `content/adapters/zhihuishu.js` | `spec/50-zhihuishu.md`, `spec/80-quality.md` | AGENT 07, 09, 11 | `node --check content/adapters/zhihuishu.js` | 未确认选择器标注需在真实页面核对；修语法后重跑一次 |
| AGENT 19 | u校园题目拦截、来源抽象与 DOM 降级 | `content/adapters/unipus.js`（题目分区） | `spec/40-unipus.md`, `spec/20-deepseek.md` | AGENT 07, 08, 10 | `node --check content/adapters/unipus.js` | 保留密文日志和 DOM fallback；缺解密不得记 PASS，重跑一次 |
| AGENT 20 | u校园提交拦截与答案注入 | `content/adapters/unipus.js`, `content/main-world-bridge.js`（提交分区） | `spec/40-unipus.md`, `spec/20-deepseek.md` | AGENT 07, 08, 19 | `node --check content/adapters/unipus.js; node --check content/main-world-bridge.js` | 用 fixture 验证 payload/value/usedTime，失败回派并重测一次 |
| AGENT 21 | Popup HTML/CSS 设置面板 | `popup/popup.html`, `popup/popup.css` | `spec/60-popup-manifest.md`, `spec/20-deepseek.md` | AGENT 01, 02 | `test -f popup/popup.html && test -f popup/popup.css` | 修正控件、默认值和暗色样式后重跑一次 |
| AGENT 22 | Popup JS 设置交互 | `popup/popup.js` | `spec/60-popup-manifest.md`, `spec/20-deepseek.md`, `CONTRACTS.md` | AGENT 21, 03 | `node --check popup/popup.js` | 修正键名、默认值和范围后重跑一次 |
| AGENT 23 | 本地 fixture 页面 | `fixtures/test-page.html` | `spec/70-fixture-readme.md`, `spec/30d-quiz-pc.md`, `spec/40-unipus.md` | AGENT 09, 15, 20 | `test -f fixtures/test-page.html` | 修正 HTML/测试端点后重跑一次；不改 spec |
| AGENT 24 | 集成测试与缺陷复测 | 全项目只读审查，必要时回派 | `spec/10-overview.md`, `spec/80-quality.md` | AGENT 02–23 | `node --check` 所有 JS；fixture smoke test | 记录最小复现并回派原负责人，修复后复测一次 |
| AGENT 25 | README 安装与风险说明 | `README.md` | `spec/70-fixture-readme.md`, `spec/10-overview.md` | AGENT 02, 05, 17, 19, 23 | `test -f README.md` | 补资源/解密 TODO，禁止声称未验证功能完成；再核对一次 |
| AGENT 26 | 最终代码质量只读验证 | 全项目只读审查 | `spec/80-quality.md`, `CONTRACTS.md` | AGENT 04, 05, 24, 25 | `node --check` 所有 JS；敏感字符串扫描 | 失败回派原 Agent，修复后复验一次；无法解决报告阻塞 |
| AGENT 27 | 最终需求覆盖只读审计 | 全项目只读审查 | `spec/INDEX.md`, `spec/FULL_SPEC.md`, `CONTRACTS.md` | AGENT 26 | 逐项需求清单核对；`git diff --check` | 标记遗漏并回派，不自行扩展功能；修复后复核一次 |
| AGENT 28 | 发布前状态、证据与需求完成度只读验证 | 全项目只读审查 | `spec/INDEX.md`, `spec/80-quality.md`, `CONTRACTS.md` | AGENT 26, 27 | `python -I -m json.tool PROJECT_STATE.json`; 六个辅助文件、Agent 覆盖和占位符全量检查 | 只记录验证证据并报告阻塞，不修改任何文件；发现问题回派主控复核 |


## 顺序与交接

1. AGENT 00 先完成规格证据；AGENT 01 冻结本文件和初始状态。
2. AGENT 02–11 先建立基础设施，再由 AGENT 12–20 实现平台适配；21–23 做 UI、清单和 fixture 验收。
3. AGENT 24–28 只做联调、质量、覆盖和状态汇总。所有“需在真实页面核对”、资源下载失败、平台解密缺失都必须进入 `REMAINING_TODO.md`，不能改写为 PASS。
4. 任何 Agent 发现另一个 Agent 的文件已被修改，应保留接口契约，避免覆盖无关变更；冲突由主控解决。
