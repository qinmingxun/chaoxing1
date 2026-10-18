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

