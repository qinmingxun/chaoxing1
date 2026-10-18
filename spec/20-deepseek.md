## AI 接口（DeepSeek，OpenAI 兼容）
- POST https://api.deepseek.com/chat/completions，Authorization: Bearer <key>
- model 默认 "deepseek-chat"（popup 可改），temperature 0.1，超时 30s，并发 3
- system prompt："你是答题助手，只输出答案，不要任何解释。单选题和判断题只输出选项
  字母（如 A）；多选题输出连续字母（如 ABD）；填空题多个空用 # 分隔；简答题直接输出答案文字。"
- 答题缓存：chrome.storage.local，key = 站点域名 + MD5(题干+选项)，命中直接复用
- 失败处理：跳过该题并 console.warn，不阻塞其余题目

