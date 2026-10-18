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

