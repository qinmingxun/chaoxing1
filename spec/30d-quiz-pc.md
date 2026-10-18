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

