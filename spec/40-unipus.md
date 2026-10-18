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

