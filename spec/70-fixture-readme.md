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

