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

