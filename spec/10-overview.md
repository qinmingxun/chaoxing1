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
