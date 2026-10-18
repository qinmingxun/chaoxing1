## 智慧树要点（无参考脚本，通用实现）
- video 元素自动 play + playbackRate（默认3x），静音用 volume=0 而非 muted（降低检测概率）
- 失焦暂停：监听 blur/visibilitychange 后重新 play；pause 事件自动恢复（ended 除外）
- ended → 点击"下一集/下一个"按钮（选择器待真实页面核对，console.log 调试）
- 挂机弹窗：复用 keep-alive.js 的关键词检测（智慧树常见"继续学习"弹窗）
- 题目提取与填答：按常见结构实现（radio/checkbox click + input 原生 value setter +
  dispatch input 事件），选择器待真实页面核对

