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

