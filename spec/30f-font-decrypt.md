### 字体加密解密（font-cxsecret，学习通特有）
- 页面 <style> 内嵌 base64 woff 字体（style 文本含 font-cxsecret），解析流程：
  base64 → Typr.parse → 对 `.font-cxsecret` 元素文本的每个可疑字符（Unicode
  19968–40869）：Typr.U.codeToGlyph → glyphToPath → JSON.stringify → MD5 →
  取 hash 后 24 位 → Table.json[该key] → 真实字符 → 全局替换并移除 font-cxsecret class
- 题目提取前必须先解密，否则 AI 读到乱码
- Typr.js 与 Table.json 本地打包到 lib/：下载上述两个 URL；若下载失败，
  在 README 标注 TODO 并让答题流程遇到含加密字符的题时跳过并警告

