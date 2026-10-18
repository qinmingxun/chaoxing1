# 规格分节索引

| 文件 | 原始小节标题/内容范围 | 负责 Agent | FULL_SPEC 行范围 |
|---|---|---|---|
| `spec/10-overview.md` | ## 项目位置；## 支持的平台；## 重要声明；## 架构（MV3）；## 目录结构（严格按此输出，每个文件完整实现） | AGENT 02, 06, 07 | 4-48 |
| `spec/20-deepseek.md` | ## AI 接口（DeepSeek，OpenAI 兼容） | AGENT 03, 11 | 49-56 |
| `spec/30-chaoxing.md` | ## 学习通参考要点（来自已验证可用的脚本，蒸馏如下） | AGENT 12–17 | 57-161 |
| `spec/40-unipus.md` | ## u校园参考要点（参考脚本被截断，已知机制如下） | AGENT 07, 08, 19, 20 | 162-198 |
| `spec/50-zhihuishu.md` | ## 智慧树要点（无参考脚本，通用实现） | AGENT 09, 18 | 199-206 |
| `spec/60-popup-manifest.md` | ## popup 设置面板（暗色简洁 UI）；## manifest.json | AGENT 02, 21, 22 | 207-226 |
| `spec/70-fixture-readme.md` | ## fixtures/test-page.html（本地免登录验证）；## README.md | AGENT 23, 25 | 227-242 |
| `spec/80-quality.md` | ## 代码质量要求 | AGENT 04, 05, 26 | 243-248 |
| `spec/30a-task-parse.md` | ### 页面路由（按 LOCATION.pathname 分发）；### 任务点解析（/knowledge/cards）；### 文档/阅读/读书任务（GET 即完成）；### 章节跳转与页面检查屏蔽 | AGENT 12 | 59-108 |
| `spec/30b-video-report.md` | ### 视频任务：模拟上报模式（默认，核心） | AGENT 13 | 76-92 |
| `spec/30c-video-play.md` | ### 视频任务：正常播放模式（降级/备用） | AGENT 14 | 93-97 |
| `spec/30d-quiz-pc.md` | ### 学习通测验（workid 任务，PC 版） | AGENT 15 | 109-122 |
| `spec/30e-quiz-phone-work-exam.md` | ### 学习通测验（手机版，iframe 导航到 /work/phone/work?workId=..&courseId=..&clazzId=..；### 作业页（/mooc2/work/dowork）；### 考试页（/exam/test/reVersionTestStartNew） | AGENT 16 | 123-142 |
| `spec/30f-font-decrypt.md` | ### 字体加密解密（font-cxsecret，学习通特有） | AGENT 17 | 153-163 |

说明：`spec/FULL_SPEC.md` 保留 MASTER_SPECIFICATION 代码块内原文；各分节文件均为对应连续原文片段，不新增需求语义。
