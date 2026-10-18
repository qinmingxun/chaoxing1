### 视频任务：正常播放模式（降级/备用）
- 任务点 iframe 内查找 video/audio 元素（1.5s 轮询），pause → muted=true →
  playbackRate=rate → play()；监听 pause 事件自动恢复播放（ended 除外）；
  ended → 任务完成。音频任务：原脚本等待 5 秒直接标记完成。

