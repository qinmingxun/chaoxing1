# 项目接口契约（冻结版）

本文件是 `E:/刷课/` 的跨 Agent 接口契约。实现 Agent 只能按照本文件的名称、字段和默认值接线；需要改变契约时，必须先由主控更新本文件并通知所有依赖 Agent。本文件不实现任何运行时代码，也不包含真实密钥。

## 0. 通用约定

- 所有消息均为可结构化克隆的普通对象，顶层字段为 `type`、`requestId`、`payload`；`requestId` 由发送方生成，非空字符串且在一次请求生命周期内唯一。
- 成功响应为 `{type:"BACKGROUND_RESULT", requestId, ok:true, data}`；失败响应为 `{type:"BACKGROUND_RESULT", requestId, ok:false, error:{code,message,retryable}}`。不得把异常对象、`Response`、DOM 节点或密钥放进消息。
- 时间统一使用毫秒时间戳；URL 必须是当前允许域名的绝对 URL。Background 只接受下列白名单消息，并校验 URL/字段后再发网络请求。
- `qtype` 固定为数字：单选 `0`、多选 `1`、填空 `2`、判断 `3`、简答 `4`。
- `answer` 始终是字符串；多选答案在跨层传输时用连续大写字母（例如 `ABD`），填空的多个空用 `#` 分隔。

## 1. content（isolated world）↔ background（service worker）

### 1.1 DeepSeek

| 请求 `type` | `payload` 必填字段 | 可选字段 | `data` 成功字段 |
|---|---|---|---|
| `DEEPSEEK_CHAT` | `domain:string`、`qtype:0|1|2|3|4`、`stem:string`、`options:string[]` | `model:string`、`temperature:number`、`timeoutMs:integer` | `answer:string` |

`domain` 是 `location.hostname`，仅用于审计/缓存关联；请求中严禁携带 `apiKey`。Background 从 `chrome.storage.local.deepseekApiKey` 读取密钥，向 `https://api.deepseek.com/chat/completions` 发 `POST`，使用 OpenAI 兼容 JSON：`model` 默认 `deepseek-chat`，`temperature` 默认 `0.1`，system prompt 固定为：`你是答题助手，只输出答案，不要任何解释。单选题和判断题只输出选项字母（如 A）；多选题输出连续字母（如 ABD）；填空题多个空用 # 分隔；简答题直接输出答案文字。`。Background 请求超时默认 `30000` ms，并发上限为 `3`；失败只返回错误，content 必须跳过本题而不能阻塞队列。

### 1.2 学习通状态/上报/完成接口

以下请求的 `origin` 必须来自当前学习通页面，Background 负责拼接路径、编码查询参数并携带页面 Cookie。所有成功响应的 `data` 都保留服务端 JSON（至少可读取 `isPassed`）。

| 请求 `type` | `payload` 字段（必填；未列出的字段禁止自创同义名） | Background 请求 |
|---|---|---|
| `CX_STATUS` | `origin:string`、`objectId:string`、`fid:string`、`cacheBust:integer` | `GET {origin}/ananas/status/{objectId}?k={fid}&flag=normal&_dc={cacheBust}` |
| `CX_REPORT` | `reportUrl:string`、`dtoken:string`、`clazzId:string`、`playingTime:number`、`duration:number`、`objectId:string`、`otherInfo:string`、`jobid:string`、`userid:string`、`isdrag:0|4`、`enc:string`、`rt:string`、`timestamp:integer` | `GET {reportUrl}/{dtoken}`，查询串固定为 `clazzId,playingTime,duration,clipTime=0_{duration},objectId,otherInfo,jobid,userid,isdrag,view=pc,enc,rt,dtype=Video,_t=timestamp` |
| `CX_DOCUMENT` | `origin:string`、`jobid:string`、`knowledgeid:string`、`courseid:string`、`clazzid:string`、`jtoken:string`、`cacheBust:integer` | `GET {origin}/ananas/job/document?...` |
| `CX_READV2` | `origin:string`、`jobid:string`、`knowledgeid:string`、`courseid:string`、`clazzid:string`、`jtoken:string`、`cacheBust:integer` | `GET {origin}/ananas/job/readv2?...` |
| `CX_JOB` | `origin:string`、`jobid:string`、`knowledgeid:string`、`courseid:string`、`clazzid:string`、`jtoken:string`、`cacheBust:integer` | `GET {origin}/ananas/job?...` |

`CX_STATUS` 的请求头使用当前域名 Host 与 `Referer: {origin}/ananas/modules/video/index.html`；其余请求不得由 content 直接 `fetch`。`CX_REPORT` 的 `enc` 由 content/adapter 按既定 MD5 算法算好后传入，Background 不改写业务字段。

### 1.3 缓存读写

| 请求 `type` | `payload` | 成功 `data` |
|---|---|---|
| `CACHE_GET` | `{key:string}` | `{found:boolean, value?:string}` |
| `CACHE_SET` | `{key:string, value:string}` | `{saved:true}` |

缓存操作只使用 `chrome.storage.local`，不得使用 `localStorage`、IndexedDB 或隐式内存缓存代替持久缓存。`CACHE_SET` 覆盖同 key 的旧答案。

## 2. isolated world ↔ MAIN world 事件

统一使用 `window.postMessage`，对象必须带 `source:"course-helper"`；桥接层转发给页面逻辑时使用同名 `CustomEvent`，`detail` 与下表 payload 完全一致。事件监听器必须忽略没有正确 `source` 的消息。

### 2.1 content → MAIN

| 事件名 | payload |
|---|---|
| `course-helper:main:init` | `{version:1, routes:string[]}` |
| `course-helper:main:set-confirm` | `{enabled:boolean}` |
| `course-helper:main:set-editor` | `{editorId:string, content:string}` |
| `course-helper:main:set-mobile-editor` | `{index:integer, content:string, itemId?:string}` |
| `course-helper:main:set-ucampus-answer-queue` | `{answers:string[]}` |
| `course-helper:main:dispose` | `{reason:string}` |

### 2.2 MAIN → content

| 事件名 | payload |
|---|---|
| `course-helper:main:ready` | `{version:1}` |
| `course-helper:main:editor-result` | `{editorId:string, ok:boolean, error?:string}` |
| `course-helper:main:ucampus-question-data` | `{code:0, content:string, k:string, encrypted:boolean, url:string}` |
| `course-helper:main:ucampus-submit` | `{url:string, payload:string, usedTime:number, answerCount:integer}` |
| `course-helper:main:error` | `{code:string, message:string}` |

MAIN world 的网络钩子只报告数据或改写明确授权的 UCampus 提交；`course-helper:main:ucampus-submit` 的 `payload` 是改写后的 JSON 字符串，不得泄漏 API key。`top.checkJob` 屏蔽和 `window.confirm` 覆写由 `course-helper:main:set-confirm` 的 `enabled:true` 触发，禁用时恢复原引用（若可恢复）。

## 3. `chrome.storage.local` 键与默认值

除动态缓存键外，以下是完整的保留设置键。首次读取缺失键时必须使用默认值；Popup 写入必须使用这些拼写，禁止另造别名。

| key | 默认值 | 类型/说明 |
|---|---:|---|
| `deepseekApiKey` | `"<YOUR_DEEPSEEK_API_KEY>"` | string；唯一允许的密钥占位符 |
| `deepseekModel` | `"deepseek-chat"` | string |
| `deepseekTemperature` | `0.1` | number |
| `deepseekTimeoutMs` | `30000` | integer |
| `deepseekConcurrency` | `3` | integer |
| `videoSpeed` | `3` | number，范围 1–8 |
| `autoVideo` | `true` | boolean |
| `autoAnswer` | `true` | boolean |
| `autoSubmit` | `true` | boolean |
| `cxVideoMode` | `"report"` | `"report"` 或 `"play"` |
| `cxReportBaseInterval` | `58` | number，秒 |
| `showProgress` | `true` | boolean |
| `answerIntervalMs` | `5000` | integer，毫秒 |

`showProgress:true` 是对原规格未明示默认值的冻结选择；后续实现不得以空值或平台推断覆盖。Dynamic cache key 的命名见下一节；除此之外不得向 `chrome.storage.local` 写入新键。

## 4. 题型、答案与缓存 key

### 4.1 题型编号

- `0`：单选题（single choice）
- `1`：多选题（multiple choice）
- `2`：填空题（fill blank）
- `3`：判断题（true/false）
- `4`：简答题（short answer）

选项清洗必须去 HTML、去 `A.`/`A、`/`（A）` 等前缀并 trim；比较时使用“大写且仅保留中文、字母、数字”的规范化结果。多选按 `#` 分隔后再排序/匹配，填空保持空位顺序。

### 4.2 缓存 key 规则

- `domain = location.hostname.toLowerCase()`，不含协议、端口和路径。
- `questionMaterial = cleanedStem + cleanedOption1 + cleanedOption2 + ...`，不插入分隔符；没有选项时就是 `cleanedStem`。
- `digest = MD5(questionMaterial)`，输出 32 位小写十六进制。
- 实际 `chrome.storage.local` key 固定为 `cache:{domain}:{digest}`，例如 `cache:example.chaoxing.com:0123456789abcdef0123456789abcdef`。值是最终答案字符串；不得把不同站点答案共用同 key。

## 5. 区段/运行标记命名（冻结）

源文件中需要可检索的区段标记时，只能使用下列大写名称，格式为 `[SECTION:<NAME>]`，不得使用同义词：

`MESSAGES`、`STORAGE`、`LOADER`、`MAIN_BRIDGE`、`VIDEO_MANAGER`、`QUIZ_SOLVER`、`KEEP_ALIVE`、`ADAPTER_CHAOXING`、`ADAPTER_ZHIHUISU`、`ADAPTER_UNIPUS`、`SERVICE_WORKER`、`POPUP`、`MANIFEST`、`LIB_MD5`、`LIB_TYPR`、`LIB_TABLE`、`FIXTURE`、`QUALITY`。

路由标记只能是 `[ROUTE:KNOWLEDGE_CARDS]`、`[ROUTE:STUDENT_STUDY]`、`[ROUTE:EXAM]`、`[ROUTE:WORK]`、`[ROUTE:PHONE_HOMEWORK]`；任务标记只能是 `[TASK:VIDEO]`、`[TASK:AUDIO]`、`[TASK:WORKID]`、`[TASK:DOCUMENT]`、`[TASK:READ]`、`[TASK:INSERTBOOK]`、`[TASK:INSERTIMAGE]`。标记仅用于日志/代码区段，不改变消息字段。

## 6. Adapter 导出函数签名

下列是每个 adapter 的公共导出；参数对象字段按名称传递，禁止以位置参数替代。`AdapterContext` 至少含 `{document:Document, location:Location, sendMessage:Function, settings:Object, log:Function}`；`TaskResult` 为 `{done:boolean, skipped:boolean, reason?:string}`。

### `content/adapters/chaoxing.js`

```js
export function matches(url: URL): boolean;
export function init(ctx: AdapterContext): Promise<void>;
export function destroy(): void;
export function parseTasks(doc: Document): { tasks: Array<Object>, defaults: Object };
export function processTask(task: Object, defaults: Object, ctx: AdapterContext): Promise<TaskResult>;
export function getVideoStatus(input: {origin:string, objectId:string, fid:string}): Promise<Object>;
export function reportVideo(input: {reportUrl:string, dtoken:string, clazzId:string, playingTime:number, duration:number, objectId:string, otherInfo:string, jobid:string, userid:string, isdrag:0|4, enc:string, rt:string}): Promise<Object>;
export function completeJob(kind: "document"|"readv2"|"job", input: {origin:string, jobid:string, knowledgeid:string, courseid:string, clazzid:string, jtoken:string}): Promise<Object>;
export function solvePcQuiz(doc: Document, ctx: AdapterContext): Promise<TaskResult>;
export function solvePhoneWorkExam(doc: Document, ctx: AdapterContext): Promise<TaskResult>;
export function decryptFont(doc: Document): Promise<void>;
```

### `content/adapters/zhihuishu.js`

```js
export function matches(url: URL): boolean;
export function init(ctx: AdapterContext): Promise<void>;
export function destroy(): void;
export function handleVideo(video: HTMLMediaElement, ctx: AdapterContext): Promise<void>;
export function extractQuestions(doc: Document): Array<Object>;
export function fillAnswers(questions: Array<Object>, answers: string[], ctx: AdapterContext): Promise<void>;
export function handleKeepAlive(root: Document): void;
```

### `content/adapters/unipus.js`

```js
export function matches(url: URL): boolean;
export function init(ctx: AdapterContext): Promise<void>;
export function destroy(): void;
export function getQuestions(): Promise<Array<Object>>;
export function installQuestionInterceptor(): void;
export function setAnswerQueue(answers: string[]): void;
export function installSubmitInterceptor(): void;
export function startKeepAlive(doc: Document): () => void;
```

所有 adapter 的 `init` 必须幂等，`destroy` 必须清理定时器、Observer、事件监听和网络钩子；无法在真实页面确认的选择器只能按规格标注“需在真实页面核对”，不得把猜测写成已验证事实。
