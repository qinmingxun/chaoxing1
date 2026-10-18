请为我开发一个 Chrome/Edge 浏览器插件（Manifest V3，纯原生 JavaScript，零依赖、零构建），
用于网课平台自动挂机积累视频学习时长 + 调用 DeepSeek 大模型自动完成测验答题。

## 项目位置
在 E:\刷课\ 创建全部文件。

## 支持的平台
1. 超星学习通（*.chaoxing.com）—— 有完整参考，按下方"学习通参考要点"实现
2. 智慧树/知到（*.zhihuishu.com）—— 无参考脚本，按通用结构实现，选择器留待真实页面核对
3. u校园AI版（入口 uai.unipus.cn，内容实际在 ucontent.unipus.cn / birdflock.unipus.cn）
   —— 参考脚本不完整（缺解密函数），按下方"u校园参考要点"实现，缺失部分按降级方案处理

## 重要声明
- 参考脚本禁止二开。你只能参考其中的接口地址、DOM 选择器、算法等事实性信息，
  所有代码必须原创实现，不得逐行照抄。
- 原脚本的冗余功能全部剔除：充值/积分/收款码/皮卡丘/第三方答题接口/Kimi 代理等，
  答题一律改为调用 DeepSeek。

## 架构（MV3）
- content script 运行在 isolated world，负责 DOM 操作与任务调度
- 需要访问页面上下文（XHR/fetch 钩子、confirm 覆写、UE 编辑器等）的逻辑放在
  content/main-world-bridge.js，用 chrome.scripting.executeScript({world:'MAIN'}) 注入，
  通过 window.postMessage / CustomEvent 与 content script 通信
- 所有网络请求（DeepSeek + 学习通上报/状态/任务接口）走 background service worker
  （host_permissions 自动携带页面 cookie），content 通过 chrome.runtime.sendMessage 调用
- 注意：MV3 禁止远程代码，任何库（MD5/Typr 等）必须本地打包进扩展

## 目录结构（严格按此输出，每个文件完整实现）
刷课/
├── manifest.json
├── background/service-worker.js   # 网络代理：DeepSeek 答题 + 学习通接口
├── content/
│   ├── loader.js                  # 按域名注册适配器、路由、读配置
│   ├── main-world-bridge.js       # MAIN world 注入：XHR/fetch 钩子、confirm 覆写
│   ├── video-manager.js           # 通用视频播放/任务循环
│   ├── quiz-solver.js             # DeepSeek 答题引擎 + 答案匹配 + 填答
│   ├── keep-alive.js              # 保活系统（u校园 + 通用挂机弹窗处理）
│   └── adapters/
│       ├── chaoxing.js            # 学习通：任务点/上报/测验/字体解密
│       ├── zhihuishu.js           # 智慧树：通用实现 + 选择器待核对
│       └── unipus.js              # u校园：拦截器 + 保活 + 解密待补
├── lib/
│   ├── md5.js                     # 自实现标准 MD5（约100行，禁止远程加载）
│   ├── typr.js                    # 下载自 https://pkpkq.ucuc.net/font-decrypt/TyprMd5.js
│   └── table.json                 # 下载自 https://pkpkq.ucuc.net/font-decrypt/Table.json
├── popup/popup.html|js|css        # 设置面板（暗色简洁 UI）
├── fixtures/test-page.html        # 本地模拟页（详见下文）
└── README.md
## AI 接口（DeepSeek，OpenAI 兼容）
- POST https://api.deepseek.com/chat/completions，Authorization: Bearer <key>
- model 默认 "deepseek-chat"（popup 可改），temperature 0.1，超时 30s，并发 3
- system prompt："你是答题助手，只输出答案，不要任何解释。单选题和判断题只输出选项
  字母（如 A）；多选题输出连续字母（如 ABD）；填空题多个空用 # 分隔；简答题直接输出答案文字。"
- 答题缓存：chrome.storage.local，key = 站点域名 + MD5(题干+选项)，命中直接复用
- 失败处理：跳过该题并 console.warn，不阻塞其余题目

## 学习通参考要点（来自已验证可用的脚本，蒸馏如下）

### 页面路由（按 LOCATION.pathname 分发）
- /knowledge/cards：任务点页（主战场）
- /mycourse/studentstudy：课程学习页（仅展示面板）
- /exam/test/reVersionTestStartNew：考试页
- /mooc2/work/dowork：作业页
- /work/phone/doHomeWork：手机端作业页（仅覆写 alert/confirm）

### 任务点解析（/knowledge/cards）
- 页面内联 script 中存在 `try{mArg=...;}catch` 包裹的 JSON（用正则提取，注意去空白）
- JSON.parse 后：attachments[] = 任务点列表，defaults = {clazzId, courseid, knowledgeid,
  reportUrl, jtoken 等}
- 页面元素 `.wrap .ans-cc .ans-attach-ct` 与 attachments 按下标对应，每个内含 iframe
- 任务类型 task.type（或 task.property.module）：
  video=视频, audio=音频, workid=测验, document=文档, read=阅读,
  insertbook=读书, insertimage=跳过
- 已完成判断：task.isPassed === true（跳过）；处理完一个 splice 一个，全部完成进入下一章

### 视频任务：模拟上报模式（默认，核心）
- 获取视频信息：GET `{origin}/ananas/status/{objectId}?k={cookie:fid}&flag=normal&_dc={ts}`
  （请求头 Host=当前域名、Referer={origin}/ananas/modules/video/index.html）
  返回 {duration, dtoken, playingTime, isPassed}
- 后台计时用 Blob Worker（内容脚本创建，避开后台标签页定时器节流）：
  currentTime 从 playingTime 起，每 200ms 累计 elapsed*rate
- 上报间隔 = max(5, floor(58 / rate))，rate 为倍速（最高 8x），基础间隔 58s 可在 popup 调整
- 达到上报间隔或播放完成时上报，上报 URL：
  {defaults.reportUrl}/{dtoken}?clazzId={clazzId}&playingTime={t}&duration={d}
  &clipTime=0_{d}&objectId={objectId}&otherInfo={otherInfo}&jobid={jobid}
  &userid={uid}&isdrag={0|4}&view=pc&enc={enc}&rt={rt}&dtype=Video&_t={ts}
  （isdrag：完成时为 4，否则 0；uid 取 cookie `_uid` 或 `UID`；rt 取 attachments 中 property.rt）
- enc 签名 = MD5("[{clazzId}][{uid}][{jobId}][{objectId}][{playingTime*1000}]
  [d_yHJ!$pdA~5][{duration*1000}][0_{duration}]")
- 上报响应 JSON.isPassed === true → 任务完成 → 处理下一个任务点
- 进度条：页面右下角浮窗显示当前进度百分比（可选开关）

### 视频任务：正常播放模式（降级/备用）
- 任务点 iframe 内查找 video/audio 元素（1.5s 轮询），pause → muted=true →
  playbackRate=rate → play()；监听 pause 事件自动恢复播放（ended 除外）；
  ended → 任务完成。音频任务：原脚本等待 5 秒直接标记完成。

### 文档/阅读/读书任务（GET 即完成）
- 文档：GET /ananas/job/document?jobid=..&knowledgeid=..&courseid=..&clazzid=..&jtoken=..&_dc=..
- 阅读：GET /ananas/job/readv2?jobid=..（其余参数同上）
- 读书：GET /ananas/job?jobid=..（其余参数同上）

### 章节跳转与页面检查屏蔽
- 下一章按钮：`#mainid > .prev_next.next:not(.disabled)` 或
  `#prevNextFocusNext:not(.disabled)`，点击后 3s 间隔防连点
- 屏蔽平台检查：`top.checkJob = function(){return false}`（MAIN world）
- 覆写 `window.confirm = () => true`（MAIN world，配合自动提交）

### 学习通测验（workid 任务，PC 版）
- 任务 iframe 内状态文本 `.newTestCon .newTestTitle .testTit_status`：
  含"待做"/"待完成" → 继续；含"已完成"/"已交"/"待批阅" → 跳过
- 题目容器 `.CeYan` 内的 `.TiMu`，每题：
  - 题干：`.Zy_TItle.clearfix > div` 的 html，题型从 `【单选题】` 等前缀提取
  - 选项：`.Zy_ulTop li a`（html 含 "A." 前缀需清洗），点击目标为 a 的父级 li
  - 判断题：选项 li 内含 `span[val-param=true|false]`
  - 填空：textarea 位于 `.Zy_ulTk .XztiHover1` / `.stem_answer .Answer .divText .textDIV` /
    `.subEditor` 下；若对应 UE 编辑器存在则 `UE.getEditor(id).setContent(答案)`（MAIN world）
  - 简答：`textarea[name^="answerEditor"]` / `.eidtDiv textarea`，UE 优先
- 已答检测：选择题看 li 的 aria-label 属性，填空看 textarea 值，已答跳过
- 提交：`.ZY_sub .btnSubmit`；确认弹窗 `#confirmSubWin > div > div > a.bluebtn`；
  保存：`.ZY_sub .btnSave`（自动提交关闭时用保存）

### 学习通测验（手机版，iframe 导航到 /work/phone/work?workId=..&courseId=..&clazzId=..
&knowledgeId=..&jobId=..&enc=.. 后处理）
- 题目容器 `.zquestions .Py-mian1`，题干 `.Py-m1-title`，题型从 `[..题]` 提取
- 选项：`.answerList.singleChoice li` / `.answerList.multiChoice li` /
  `.answerList.panduan li`（判断题看 li 的 val-param 属性）
- 填空：`.blankList2 input` 或 `[data-editorindex]`（编辑器：contextWindow.editors[idx]
  .ueditor.setContent()，同时写隐藏 input `#answer{itemId}`）
- 简答：`textarea[name^="answer"]`
- 提交：`.zquestions .zsubmit .btn-ok-bottom`；确认 `#okBtn`

### 作业页（/mooc2/work/dowork）
- 容器 `.mark_table form`，每题 `.questionLi`，题干 `.mark_name`
- 选项 `.stem_answer .answer_p`（点击父级），填空 `.stem_answer .Answer .divText
  .textDIV textarea`，简答 `.stem_answer .eidtDiv textarea`

### 考试页（/exam/test/reVersionTestStartNew）
- 容器 `.mark_table .whiteDiv`，题干 `h3.mark_name`
- 选项 `.clearfix.answerBg .fl.answer_p`（点击父级），填空 `.Answer .divText .subEditor
  textarea`；下一题按钮 `a.jb_btn`（可选自动跳转）

### 答题通用逻辑（蒸馏，全部平台复用）
- 题型映射：单选题0/多选题1/填空题2/判断题3/简答题4
- 选项文本清洗：去 HTML 标签、去 "A." "A、" "（A）" 等前缀、trim
- 题干清洗：去 HTML（保留 img）、去【题型】前缀、去"（x.x分）"、去题号
- 答案匹配：normalizeForCompare（大写 + 仅保留中文/字母/数字）后与选项比对，
  全等优先，包含关系兜底
- 多选答案按 # 分隔；填空数量检测多方法兜底（input name/id 去重 → [data-editorindex]
  去重 → textarea 去重 → 题干"第X空" → 题干"（X）"数字 → 默认 1）
- 每题填答间隔默认 5000ms（popup 可调），已答题跳过，无答案跳过继续

### 字体加密解密（font-cxsecret，学习通特有）
- 页面 <style> 内嵌 base64 woff 字体（style 文本含 font-cxsecret），解析流程：
  base64 → Typr.parse → 对 `.font-cxsecret` 元素文本的每个可疑字符（Unicode
  19968–40869）：Typr.U.codeToGlyph → glyphToPath → JSON.stringify → MD5 →
  取 hash 后 24 位 → Table.json[该key] → 真实字符 → 全局替换并移除 font-cxsecret class
- 题目提取前必须先解密，否则 AI 读到乱码
- Typr.js 与 Table.json 本地打包到 lib/：下载上述两个 URL；若下载失败，
  在 README 标注 TODO 并让答题流程遇到含加密字符的题时跳过并警告

## u校园参考要点（参考脚本被截断，已知机制如下）

### 保活系统（完整可用，直接实现）
- 每 ~30s 随机模拟 mousemove/scroll/keydown 事件（不影响真实操作）
- 每 ~45s fetch(location.href, {method:'HEAD'}) 网络 ping
- 每 ~35s 向所有 open 的 WebSocket 发送 '2'（socket.io 心跳）
- MutationObserver 监听新增节点，文本含 ["长时间未操作","继续使用","继续学习","超时",
  "timeout","会话已结束"] 任一关键词 → 300ms 后点击其内 ["确定","继续","OK"] 按钮

### 加密题目数据拦截（已知格式，解密算法缺失）
- 平台通过 XHR/fetch 返回题目数据，响应 JSON 形状 {code:0, content:"unipus.xxxx", k:"密钥"}
  （content 以 "unipus." 开头即加密题目数据，k 为解密密钥）
- 在 MAIN world 钩住 XHR.prototype.open/send 和 window.fetch，识别上述响应并缓存到
  unsafeWindow.__interceptedQuestionData
- 解密算法在原参考脚本后半部分（已丢失），按以下顺序降级处理：
  1. 首选：搜索页面自身加载的 JS bundle（开发者工具 → Sources → 搜 "unipus." 字符串），
     定位页面自己的解密代码并复刻（平台要显示题目必然有客户端解密逻辑）
  2. 次选：拦截后 console.log 密文+密钥，README 写明让用户提供一条
     "密文+密钥+对应明文题目"样例，人工分析算法
  3. 保底：放弃 API 路径，从渲染后的 DOM 提取题目文本（题目必然显示在页面上），
     选择器在真实页面用 console.log 调试核对
- 无论如何，代码结构上把"题目来源"抽象成接口（getQuestions(): Promise<[{qtype, stem,
  options}]>），后续补上解密即可无缝切换

### 提交拦截 + 答案注入（核心机制，已知完整，直接实现）
- MAIN world 钩住 XHR：URL 含 `/course/api/v3/newExploration/submit` 且 method=POST 时拦截
- 提交 payload JSON 结构：{quesDatas:[{answer:"<答案树JSON字符串>", ...}], usedTime:n, ...}
- 答案树：节点含 children 数组则递归；叶子节点含 value 属性 → value 为数组
- 注入逻辑：预先把 AI 答案队列（按题目顺序）存在 unsafeWindow.__UCAMPUS_ANSWER_CACHE__；
  拦截到提交时对每个 quesDatas[i].answer 递归遍历，按先序遇到 value 叶子就 shift 队列
  填入 `[答案]`，回写 JSON 字符串后放行原始 send
- 同时把 payload.usedTime 改为随机 60–120 秒
- 答案队列顺序 = 题目顺序（位置填充，不需要题号映射）

### 录音功能
v1 不做，代码留 TODO 注释即可。

## 智慧树要点（无参考脚本，通用实现）
- video 元素自动 play + playbackRate（默认3x），静音用 volume=0 而非 muted（降低检测概率）
- 失焦暂停：监听 blur/visibilitychange 后重新 play；pause 事件自动恢复（ended 除外）
- ended → 点击"下一集/下一个"按钮（选择器待真实页面核对，console.log 调试）
- 挂机弹窗：复用 keep-alive.js 的关键词检测（智慧树常见"继续学习"弹窗）
- 题目提取与填答：按常见结构实现（radio/checkbox click + input 原生 value setter +
  dispatch input 事件），选择器待真实页面核对

## popup 设置面板（暗色简洁 UI）
- API Key 输入框（默认预填 <YOUR_DEEPSEEK_API_KEY>，可修改）
- 模型输入框（默认 deepseek-chat）
- 倍速滑杆 1–8x（默认 3，学习通上限 8）
- 三个开关：视频挂机 / 自动答题 / 自动提交（默认全开）
- 学习通专属：视频模式单选（模拟上报/正常播放，默认模拟上报）、上报基础间隔（默认58s）、
  显示进度条开关
- 答题间隔输入（默认 5000ms）
- 全部存 chrome.storage.local，content script 启动时读取

## manifest.json
- manifest_version: 3
- content_scripts matches：*://*.chaoxing.com/*、*://*.zhihuishu.com/*、*://*.unipus.cn/*、
  另加 *://localhost/* 和 *://127.0.0.1/*（本地 fixture 测试用）
- permissions：["storage", "scripting"]（scripting 用于 MAIN world 注入）
- host_permissions：https://api.deepseek.com/*、*://*.chaoxing.com/*、*://*.zhihuishu.com/*、
  *://*.unipus.cn/*
- background：service_worker 指向 background/service-worker.js
- action.default_popup 指向 popup/popup.html

## fixtures/test-page.html（本地免登录验证）
用 python -m http.server 在 fixtures 目录起本地服务后访问：
- 一个 <video> 元素 + "下一集"按钮：验证自动播放/倍速/ended 跳转
- 一组模拟学习通 PC 测验 DOM（.CeYan > .TiMu，含单选/多选/填空）：验证提取→AI→填答→提交
- 一个"模拟提交"按钮触发 XHR POST 到 /course/api/v3/newExploration/submit（本地服务）：
  验证 u校园 答案注入是否改写 payload（服务端打印收到的 JSON 核对 value 已填充、usedTime 已随机）
- 一个模拟"长时间未操作"弹窗：验证保活系统自动点击

## README.md
- 安装步骤（chrome://extensions → 开发者模式 → 加载已解压）
- 各开关/模式说明
- 学习通：字体解密文件核对（lib/table.json 是否存在）、两种视频模式差异
- u校园：解密待补说明 + 提供"密文+密钥+明文"样例的调试步骤 + DOM 选择器核对步骤
- 智慧树：选择器核对步骤（F12 → 复制 selector → 改 adapter）
- 风险提示：平台有挂机检测，账号风险用户自担

## 代码质量要求
- 纯原生 JS，禁止第三方库和 npm（lib/md5.js 自写、lib/typr.js 为本地打包例外）
- 每个 adapter 顶部用常量对象集中定义该站点所有选择器
- 每个文件开头注释说明职责；无法确认的部分标注"需在真实页面核对"
- 完成后用 node --check 校验所有 js 文件语法（不执行代码）
- 代码必须原创，仅参考本文中的接口/选择器/算法事实