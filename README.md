# 刷课助手

纯原生 JavaScript 的 Chrome 扩展（Manifest V3，零依赖、零构建），面向超星学习通、智慧树/知到、u校园 AI 版的课程视频与测验自动化。

> **重要声明（引用自 spec/10-overview）**
> - 参考脚本禁止二开。本项目只参考其中的接口地址、DOM 选择器、算法等事实性信息，所有代码均为原创实现，未逐行照抄。
> - 原脚本的冗余功能全部剔除：充值/积分/收款码/皮卡丘/第三方答题接口/Kimi 代理等，答题一律改为调用 DeepSeek。
>
> **验证状态声明：本项目各平台的真实页面 DOM 选择器、字体解密、u校园解密算法、DeepSeek 真实 API 与各平台网络链路均未在真实账号环境验证，当前仅完成静态契约、语法与本地 fixture 级验收。以下各节中标注"待核对/待补"的功能不代表已可用。**

## 1. 安装

1. 打开 Chrome，地址栏进入 `chrome://extensions`
2. 打开右上角"开发者模式"
3. 点击"加载已解压的扩展程序"，选择本目录（`E:\刷课`）
4. 点击工具栏扩展图标打开 popup 设置面板，填写 DeepSeek API Key：
   - 默认值为占位符 `<YOUR_DEEPSEEK_API_KEY>`，**必须替换为真实 key 才能使用自动答题**
   - 密钥只保存在 `chrome.storage.local`，仅由 background service worker 读取后请求 `https://api.deepseek.com/chat/completions`，content 脚本不接触密钥
   - 请勿把含真实 key 的配置导出、截图或分享

## 2. 本地 fixture 验证（免登录、免真实平台）

fixtures 目录内置本地模拟页，manifest 已允许 `*://localhost/*` 与 `*://127.0.0.1/*` 注入：

```
cd E:\刷课\fixtures
python -m http.server 8000
```

浏览器访问 `http://localhost:8000/test-page.html`，可验证四条路径：

- 一个 `<video>` 元素 + "下一集"按钮：自动播放 / 倍速 / ended 跳转
- 一组模拟学习通 PC 测验 DOM（`.CeYan > .TiMu`，含单选/多选/填空）：提取 → AI → 填答 → 提交
- 一个"模拟提交"按钮触发 XHR POST 到 `/course/api/v3/newExploration/submit`（本地服务）：验证 u校园 答案注入是否改写 payload（服务端打印收到的 JSON，核对 `value` 已填充、`usedTime` 已随机）
- 一个模拟"长时间未操作"弹窗：验证保活系统自动点击

## 3. 设置项说明（popup）

所有设置项保存在 `chrome.storage.local`，键名与默认值如下（契约见 CONTRACTS.md §3）：

| 设置键 | 默认值 | 含义 |
|---|---:|---|
| `deepseekApiKey` | `<YOUR_DEEPSEEK_API_KEY>` | DeepSeek API Key（唯一允许的占位符，需替换为真实 key） |
| `deepseekModel` | `deepseek-chat` | DeepSeek 模型名 |
| `deepseekTemperature` | `0.1` | DeepSeek 采样温度 |
| `deepseekTimeoutMs` | `30000` | 单题请求超时（毫秒） |
| `deepseekConcurrency` | `3` | 并发答题上限；失败只跳过本题，不阻塞队列 |
| `videoSpeed` | `3` | 视频倍速，范围 1–8 |
| `autoVideo` | `true` | 自动处理视频任务总开关 |
| `autoAnswer` | `true` | 自动答题总开关 |
| `autoSubmit` | `true` | 答完后自动提交总开关 |
| `cxVideoMode` | `"report"` | 学习通专属：视频处理模式，`"report"`（模拟上报，默认）或 `"play"`（正常播放） |
| `cxReportBaseInterval` | `58` | 学习通专属：模拟上报基础间隔（秒），按倍速换算（实际间隔 = max(5, floor(基础间隔 / 倍速))） |
| `showProgress` | `true` | 学习通专属：右下角进度浮窗开关 |
| `answerIntervalMs` | `5000` | 逐题作答间隔（毫秒，通用答题引擎，非学习通专属） |

## 4. 学习通（*.chaoxing.com）

### 4.1 字体解密文件核对

学习通测验题目使用内嵌 base64 woff 字体（style 文本含 `font-cxsecret`）加密，提取题目前必须先解密。解密依赖 `lib/` 下两个本地文件（MV3 禁止远程代码，必须本地打包）：

- **`lib/table.json`**：存在（355427 字节）。已与官方源 `https://pkpkq.ucuc.net/font-decrypt/Table.json` 逐字节比对，**完全一致**；含 20903 条字符映射记录，另有 `license`/`namespace`/`version` 3 个元数据键（顶层键共 20906 个）。
- **`lib/typr.js`**：存在（54038 字节）。下载自 `https://pkpkq.ucuc.net/font-decrypt/TyprMd5.js`，仅将官方 UserScript 元数据注释头替换为项目职责注释，**其余代码与官方逐字节一致**（diff 仅头部注释，共 5 行）。

解密流程（spec/30f）：base64 → `Typr.parse` → 对可疑字符（Unicode 19968–40869）`codeToGlyph → glyphToPath → JSON.stringify → MD5` → 取 hash 后 24 位 → 查 `table.json` 得真实字符 → 全局替换并移除 `font-cxsecret` class。

**降级行为**：解密不可用或映射未命中时，**跳过含加密字符的测验并在 console 警告，不阻塞任务队列、不伪造答案**。窗口切片方案（多页分段取字体）尚未在真实页面确证。

### 4.2 两种视频模式差异

| 模式 | `cxVideoMode` | 行为 |
|---|---|---|
| 模拟上报（默认） | `"report"` | 页面视频**不真实播放**；按 58 秒基础间隔（`cxReportBaseInterval`）/ 倍速换算，定时向学习通上报状态与完成（`isdrag`、`enc` 签名、完成时 `isdrag=4`，`isPassed===true` 视为完成） |
| 正常播放 | `"play"` | 页面**真实播放**视频 + 倍速 + 自动下一集 |

> 注意：模拟上报与自动答题存在平台检测与账号风险，详见「风险提示」。

## 5. u校园 AI 版（uai.unipus.cn / ucontent.unipus.cn / birdflock.unipus.cn）

### 5.1 解密待补说明

平台通过 XHR/fetch 返回加密题目数据，响应形状为 `{code:0, content:"unipus.xxxx", k:"密钥"}`（`content` 以 `unipus.` 开头即加密题目数据，`k` 为密钥）。MAIN world 钩子已能识别并缓存该响应（`window.__UCAMPUS_ANSWER_CACHE__` 之外另有拦截数据缓存），**但解密算法在参考脚本后半部分缺失，当前未实现解密**。

当前行为：拦截到加密响应时**只在 console 记录密文与密钥（形如 `u校园加密题目：content=... k=...`），不伪造任何结果**。降级顺序：

1. 首选：在页面自身加载的 JS bundle 中搜索 `unipus.` 字符串（DevTools → Sources → 全局搜索），定位页面自己的解密逻辑并复刻；
2. 次选：按下方步骤收集"密文+密钥+对应明文"样例，人工分析算法；
3. 保底：放弃 API 路径，改从渲染后的 DOM 提取题目文本（题目必然显示在页面上，选择器需真实页面核对）。

代码结构上题目来源已抽象为 `getQuestions(): Promise<[{qtype, stem, options}]>`，补齐解密后可无缝切换。

### 5.2 提供"密文+密钥+明文"样例的调试步骤

1. 打开 u校园 含测验的页面，F12 打开 DevTools Console；
2. 在 Console 中找到 `u校园加密题目：content=... k=...` 日志，完整复制其中 `content=` 与 `k=` 的值；
3. 同时把**页面上对应显示的明文题目**（题干与选项原文）一并记录；
4. 将「密文 + 密钥 + 对应明文」三样提交给维护者分析，用于补齐解密算法。

### 5.3 DOM 选择器核对步骤

1. 在真实页面 F12 → Elements，右键题目容器/题干/选项节点 → Copy → Copy selector；
2. 与 `content/adapters/unipus.js` 中从渲染 DOM 提取题目所用的选择器逐一核对；
3. 选择器未命中时在 Console 直接调试确认正确路径，再更新 adapter 中的候选选择器。

### 5.4 提交注入机制（已按契约实现，真实平台未验证）

- MAIN world 钩住 XHR：URL 含 `/course/api/v3/newExploration/submit` 且 method=POST 时拦截；
- 预先把 AI 答案队列（按题目顺序）写入 `window.__UCAMPUS_ANSWER_CACHE__`，由 MAIN world 桥接；
- 拦截到提交时对每个 `quesDatas[i].answer`（答案树 JSON 字符串）递归遍历，**按先序遇到 `value` 叶子节点就 shift 队列填入 `[答案]`**，回写 JSON 字符串后放行原始 send；
- 同时把 `payload.usedTime` 改为随机 60–120 秒；
- 答案队列顺序 = 题目顺序（位置填充，不需要题号映射）。

## 6. 智慧树/知到（*.zhihuishu.com）

智慧树为通用实现（无参考脚本），选择器均待真实页面核对。核对步骤：

1. F12 → Elements 右键目标节点 → Copy → Copy selector；
2. 把 selector 填入 `content/adapters/zhihuishu.js` 顶部的候选常量：
   - `NEXT_VIDEO_SELECTOR_CANDIDATES`（"下一集/下一节"按钮）
   - `QUESTION_CONTAINER_SELECTORS`（题目容器）
   - `STEM_SELECTOR_CANDIDATES`（题干）
   - `OPTION_LIST_SELECTOR_CANDIDATES`（选项列表）
   - `SUBMIT_BUTTON_SELECTOR_CANDIDATES`（提交按钮）
3. 未命中的 selector 直接在 Console 验证后替换。

静音说明：视频静音使用 `volume=0` 而非 `muted` 属性（降低被检测的概率）；失焦/暂停自动恢复播放（ended 除外），ended 后点击下一集。

## 7. 风险提示

- **平台检测与账号风险**：学习通模拟上报、自动答题、自动提交、自动挂机等行为，平台存在挂机/异常行为检测机制，可能导致任务不计分、课程成绩作废甚至封号，**账号风险由用户自行承担**。
- **仅限本地科研实验**：本项目仅用于本地科研实验目的，请勿用于违反平台服务条款或校规的场景；使用前请自行评估合规性。
- **API Key 安全**：DeepSeek 请求由 background service worker 携带 API key 发出（host_permissions 限定 `https://api.deepseek.com/*`），key 不进入页面上下文、不随答案消息跨层传输；请勿泄露 key，也不要使用他人 key。

## 8. 项目结构

```
刷课/
├── manifest.json                  # MV3 清单：content_scripts 匹配 3 平台 + localhost；storage/scripting 权限
├── background/service-worker.js   # 网络代理：DeepSeek 答题 + 学习通状态/上报/完成接口（白名单校验）
├── content/
│   ├── loader.js                  # 按域名注册适配器、路由、读配置、注入 MAIN world 桥
│   ├── main-world-bridge.js       # MAIN world 注入：XHR/fetch 钩子、confirm 覆写、u校园答案队列
│   ├── video-manager.js           # 通用视频播放/任务循环
│   ├── quiz-solver.js             # DeepSeek 答题引擎 + 答案匹配 + 填答（含缓存）
│   ├── keep-alive.js              # 保活系统（u校园 + 通用挂机弹窗处理）
│   └── adapters/
│       ├── chaoxing.js            # 学习通：任务点/上报/测验/字体解密（选择器待真实页面核对）
│       ├── zhihuishu.js           # 智慧树：通用实现 + 选择器待核对
│       └── unipus.js              # u校园：拦截器 + 保活 + 解密待补
├── lib/
│   ├── md5.js                     # 自实现标准 MD5（本地打包，禁止远程加载）
│   ├── typr.js                    # Typr 字体解析（来自官方 TyprMd5.js，仅注释头替换）
│   └── table.json                 # 字体解密映射表（与官方 Table.json 逐字节一致）
├── popup/popup.html|js|css        # 设置面板（暗色简洁 UI，13 个设置键）
├── fixtures/test-page.html        # 本地模拟页（视频/PC 测验/u校园提交注入/保活弹窗）
├── spec/                          # 需求规格（含各平台参考要点与验收标准）
└── README.md                      # 本文件
```

## 9. 当前完成度与待核对清单

以下遗留事项来自 REMAINING_TODO.md，**刻意保持为遗留项，不伪装为已完成**：

- **真实页面选择器待核对**：超星、智慧树、u校园 的实际页面 DOM 选择器、iframe 路由、按钮文案和登录态行为均未在真实页面核对；spec 中标注待核对的选择器必须在联调时用 DevTools/console 复验。
- **智慧树无真实页面证据**：下一集按钮、题目容器和选项结构均为通用实现，尚未有真实页面证据。
- **u校园解密算法待补**：`unipus.` 密文解密需搜索页面 JS bundle 或收集"密文+密钥+明文"样例人工分析；补齐前使用渲染 DOM 降级并告警。
- **u校园录音功能 v1 不做**：代码保留 TODO 注释。
- **学习通字体解密需真实页面确证**：本地 `lib/typr.js`/`lib/table.json` 已与官方源核对（见 4.1），但窗口切片方案与真实字体解析仍需在真实页面确证；失败时保留降级：含加密字符的题目跳过并警告。
- **DeepSeek 真实 API 未验证**：DeepSeek 真实 API、平台接口、Cookie、上报签名和权限只能在用户自己的浏览器/真实账号环境验证；当前只做静态契约与语法/fixture 级验收，不声称网络调用 PASS。
- **本地 fixture 待实际运行**：需实际启动 HTTP server 验证视频、PC 测验、u校园 payload 注入、保活弹窗四条路径。
