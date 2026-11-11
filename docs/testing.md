# 手动测试

单元测试覆盖纯函数（`npm test`）。和播放器、网络、Gemini 打交道的部分需要在真实浏览器里测。

## 准备

1. `npm run build`，在 `chrome://extensions` 加载 `.output/chrome-mv3`（改代码后点「重新加载」，并刷新视频页）。
2. 在扩展的设置页填写 Gemini API Key，确认费用和隐私说明，**勾选调试模式**，保存。
3. 找一个没有字幕的视频，以及一个有 CC 或 AI 字幕的视频备用。建议测试时静音。

## 调试手段

调试模式下页面右下角有 debug 面板，按钮对应下面的命令。也可以在页面控制台里触发：

```js
document.dispatchEvent(new CustomEvent('bilisub:debug', { detail: { cmd: 'state' } }))
// cmd：state | probe | s1 {start,end} | s2decode | s4static | s4incremental {n} | toggle | srt | raw | clearSubs
```

- 日志同时输出到控制台（前缀 `[bilisub]`）和 debug 面板。读面板 DOM 往往更方便（最新的在最上面）：
  ```js
  document.getElementById('bilisub-debug').shadowRoot.querySelector('pre').textContent
  ```
- 页面控制台（MAIN world）里可以直接用 `player.seek(秒)`、`player.pause()`、`player.setPlaybackRate(2)`、`player.setMuted(true)`。

## 检查清单

1. **注入**：刷新视频页，面板里应出现 `playurl via xhr|fetch|__playinfo__`、`video {...}`、`official subtitles for cid=... none`。
2. **probe**：`hasAddSubtitle: true`，记下 `core` 脚本 URL（播放器版本，排查改版时有用）。
3. **拉音频**：`s1 {start:600,end:630}` 返回若干 fragment 和字节数，不应有 CORS 错误。
4. **开启**：点控制栏的「AI」按钮。几秒内出现字幕；日志里有 `official renderer failed (official subtitle layer is hidden ...) switched to overlay`（无字幕视频的正常行为）；悬停按钮能看到「已缓冲 N 秒」。
5. **拖动**：拖到后面的位置，10 秒内续上字幕。
6. **倍速**：1.5x、2x 下缓冲不被追上。
7. **暂停**：缓冲补满后不再发请求。
8. **屏幕模式**：普通、网页全屏、全屏下字幕都可见。
9. **连播**：在合集里点下一集，旧任务停止；开启了「自动继续」时约 2.5 秒后自动开始转写新视频，`video` 日志里的标题要和新视频一致。
10. **缓存**：刷新后再开启，日志出现 `cache hit`，已转写的区间立即显示且不发请求。
11. **已有字幕的视频**：点「AI」提示「已有字幕，再点一次仍然转写」；按钮悬停提示「本视频已有官方字幕」。
12. **错误处理**：把 Key 改错应提示「API Key 无效或没有权限」、按钮变红、不重试；改回正确的 Key 后自动恢复。断网时提示网络错误并退避重试，恢复后续上。
13. **导出**：`srt`、`raw` 能下载文件；SRT 里没有相邻重复和时间重叠。

## 已知限制

- 播放器自带的字幕模块只在用户选中某个官方字幕语言时才会显示 `addSubtitle` 的内容，无字幕视频一律使用自绘字幕层。自绘层不跟随 B 站的字号和颜色设置。原因见 [phase0.md](phase0.md) 的 S4 节。
- 已有字幕的判断依赖 `/x/player/wbi/v2` 的 JSON；未登录时可能拿不到 AI 字幕信息。
- 播放器改版可能让音频获取或注入失效，按钮会变红并给出提示，日志里的 `core` 版本和错误信息有助于排查。
