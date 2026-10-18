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

