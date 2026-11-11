# Phase 0 验证记录

测试视频：BV1VXGL6KE9D（cid 38569313758，48:07，英雄连3 实况）

## S1 获取音频流

**状态**：通过（Node 和 Chrome，2026-11-11）。

- **Chrome 实测**：MAIN world 被动捕获到 `playurl via xhr` 和 `__playinfo__`；调试命令 `s1 {start:600,end:630}` 取到 fragment 119–125，共 295,603 字节，耗时 117 ms，走 akamaized 主机，**没有 CORS 问题**。
- 播放器会**预取合集相邻视频和推荐视频**的 playurl 和 `/x/player/wbi/v2`（日志里会出现别的 cid）。代码按 cid 存储，没有串。

- 不签名的 `/x/player/playurl?bvid&cid&fnval=16` 匿名返回 code 0。选中音轨 30216（67 kbps，mp4a.40.2），主机为 `upos-sz-mirrorcosov.bilivideo.com` 和 `upos-hz-mirrorakam.akamaized.net`，地址有效期约 7200 秒。
- init（0–848）和 sidx（849–7800）一次 Range 取回，耗时约 200 ms。sidx 有 576 个 fragment，每个 5.0133 秒，总时长 2886.614 秒，与 `timelength` 2886.666 一致。
- 请求 10:00–10:30，实际取到 fragment 119–125，即 09:56.591–10:31.684，共 295 KB，耗时 1.45 秒。
- `/x/web-interface/view` 对不带 Cookie 的请求返回 412（风控）。评估脚本改为从视频页的 `__INITIAL_STATE__` 读取元数据；扩展本来就在页面里读取。
- 待浏览器验证：
  - MAIN world 能否被动捕获播放器自己的 `/x/player/wbi/playurl`（XHR 还是 fetch）；
  - 登录状态下 `__playinfo__` 是否存在；
  - content script 里的 Range fetch 是否被 CORS 拦截；
  - 切换合集下一集时 cid 能否更新。

## S2 音频切片与格式

**状态**：本地封装通过；Gemini 是否接受这些格式待测（需要 Key）。

- fMP4 片段（init 加 moof/mdat）和 ADTS 重封装，ffmpeg 解码后的 16k 单声道 PCM 的 md5 **完全一致**（dbeb71dc…），说明 ADTS 重封装无损、不转码。
- 发现并修复一个问题：直接拼接的 fMP4 片段保留了原始 tfdt，ffprobe 会把它当作从 0 开始、前面有 596 秒的空白（duration 631 秒）。如果 Gemini 也这样解析，计费和时间戳都会出错。现在拼接时把 tfdt 改为从 0 开始，改完后 start_time 为 0.004，duration 为 35.093 秒（7 × 5.0133）。
- 切点精度：片段起止由 sidx 精确给出，误差为 0（只取整 fragment，不在 fragment 中间切）。
- **Gemini 实测（2026-11-11，35.09 秒片段，3.5 Flash-Lite）**：

  | 打包 | 结果 | 音频 token |
  |---|---|---|
  | fMP4 / `audio/mp4` | 200 | 878 |
  | fMP4 / `audio/m4a` | 200 | 878 |
  | fMP4 / `audio/aac` | 200 | 878 |
  | ADTS / `audio/aac` | 200 | 878 |
  | WAV 16k / `audio/wav` | 200 | 878 |

  - **计费按 25 token/秒**（878 / 35.09），不是文档里写的 32。各格式计费一致，说明 tfdt 修正有效，没有被多算空白。
  - **结论：直接发送 fMP4（`audio/mp4`）**，零转码、体积最小。ADTS 和 WAV 保留为备选。
  - `store:false` 被接受；MINIMAL 思考级别下思考 token 为 0。
  - `gemini-3.5-transcribe` 支持 inline 音频，耗时 3.8 秒；走 Files API 是 6.5 秒（上传 2.1、转写 2.8、删除 1.5）。
- 浏览器内的 WAV 兜底（`decodeToWav16k`）待测（调试面板「S2 浏览器解码」）。

## S3 转写质量、时间戳和费用

**状态**：完成。用户抽查后（2026-11-11）**选定 A3（`gemini-3.8-flash`，LOW）为默认模型**。

5 个样本，每个约 65 秒（02:00 / 10:00 / 20:00 / 30:00 / 40:00 附近），提示词 p2：

| 方案 | 成功 | 平均延迟 | 首段 10 秒端到端 | 每小时音频费用 |
|---|---|---|---|---|
| A1 3.5 Flash-Lite，MINIMAL，紧凑文本 | 5/5 | 3.1 秒 | 2.5 秒 | $0.062 |
| A2 3.5 Flash-Lite，MINIMAL，JSON | 4/5（1 次 503） | 3.4 秒 | 1.9 秒 | $0.086 |
| A3 3.8 Flash，**LOW** | 4/5（1 次网络错误） | 约 5 秒（另有 1 次 **284 秒**挂起） | 3.6 秒 | $0.106 |
| B1 3.5 Transcribe，词级时间戳，inline | 4/5（1 次 429） | 4.0 秒 | 2.1 秒 | $0.188 |
| B2 3.5 Transcribe，自定义词表 | 前 2 个样本返回**空文本**，其余被 429 | — | — | — |

发现：
- **3.8 Flash 不支持 `MINIMAL`**（返回 400），最低只能用 LOW。LOW 下思考 token 仍为 0。
- **API Key 所属项目是免费层**：报 429 时的配额名是 `generate_content_free_tier_requests`，transcribe 每分钟限 3 次。免费层的数据可能被 Google 用于改进产品，**需要用户换成已关联结算账户的项目的 Key**。
- 出现过一次请求挂起 284 秒、一次 `fetch failed`。正式代码必须设置单请求超时（建议 30 秒）并重试。
- 繁体字：提示词 p1 下夹杂繁体（這個、沒法），改为 p2（明确要求简体）后只剩 1 处。计划再加一层繁转简后处理兜底。
- transcribe 模型（B1）漏掉了一部分语句，词级时间戳在 S2 样本里有跳变（"个"一个字持续 1.8 秒，前后相邻的词相差 10 秒）。准确率需要用户抽查后再判断。

### S3 重跑（付费 Tier 1，提示词 p2，加了超时和重试）

5 个样本 × 5 个方案，共 25 次请求，**全部成功，没有触发重试**。报告：`scripts/eval/out/s3/report.html`。

| 方案 | 平均延迟 | 首段 10 秒端到端 | 每小时音频费用 |
|---|---|---|---|
| A1 3.5 Flash-Lite，MINIMAL，紧凑文本 | 2.2 秒 | 2.1 秒 | **$0.067** |
| A2 3.5 Flash-Lite，MINIMAL，JSON | 2.6 秒 | 2.0 秒 | $0.095 |
| A3 3.8 Flash，LOW | 4.3 秒 | 2.2 秒 | $0.125 |
| B1 3.5 Transcribe，词级时间戳 | 3.3 秒 | 1.8 秒 | $0.241 |
| B2 3.5 Transcribe，自定义词表 | 1.9 秒 | — | $0.228 |

各方案转写出的汉字数差异明显（例如样本 4：A1 202 字，A3 115 字，B1 105 字）。是 A1 多听出了内容还是编造了内容，需要用户试听判断。

## Phase 1/2 的 Node 端到端模拟（`scripts/eval/simulate.ts`）

用真实的 `Session` 代码、真实视频和真实 Gemini（3.5 Flash-Lite）。播放器时钟和消息通道是模拟的。流程：从 10:00 播放 60 秒，拖到 30:00 再播放 40 秒，然后重新打开：

- 开启后第一条字幕出现：**3.6 秒**；拖动后：**2.4 秒**。
- 重新打开：从缓存显示，44 毫秒，**0 次 API 调用**。
- 一共 13 次请求，96 条字幕；相邻重复 **0**，时间重叠 **0**。
- 排查中发现：模拟时 `Session` 自己创建的 `TrackFetcher` 用的是不带 Referer 的 fetch，bilivideo 主机因此返回 403（浏览器里不会出现，因为页面会自动带 Referer）。已改为可注入 fetch，并且出错时优先报告 HTTP 状态码。

## S4 官方字幕模块

**状态**：已在 Chrome 测试（2026-11-11，播放器 `core.a3c25289.js`）。**结论：没有字幕的视频上，官方渲染器不能用，要走 overlay。**

- probe：`hasAddSubtitle: true`。`addSubtitle` 调用耗时约 23 ms，但在无字幕视频上**什么都不显示**。
- 根因（读了 `core.*.js` 和 `npd.community-helper.*.js`）：`addSubtitle` 只做了 `setState({enable:true})` 和 `setRenderData(Major, body)`。字幕插件里有个 reaction：`!isclosed && lan` 为假时调用 `subtitleInstance.hide()`，面板设为 `display:none` 并**停止渲染循环**。没有字幕语言时 `isclosed` 恒为 true，所以数据送进去了也不会画。手动把面板设成 `display:block` 也没用，因为渲染循环已经停了。
- 对照：有官方字幕的视频（BV1vjdzBgEji），在菜单里选中「中文」后，`s4static` 的测试字幕能正常显示，会替换掉官方字幕内容。官方字幕默认是关闭状态时，同样不显示。
- 播放器没有公开能改 `isclosed`/`lan` 的 API（`player.subtitle` 只有 `willShowBubble`/`downloadLog`/`setDebugMode`）。
- 处理：`FallbackRenderer` 检测到 `.bili-subtitle-x-subtitle-panel` 是隐藏状态时**立即**切到 overlay（原来要等两次可见性检查失败，实测约 7 秒）。
- 以后如果想用官方渲染：可以考虑在 `/x/player/wbi/v2` 的响应里注入一条假的字幕语言，让播放器自己 show。但字幕列表接口已经改成 protobuf，工作量较大，暂不做。

## 浏览器端到端（Chrome，2026-11-11，旧构建，`gemini-3.8-flash`）

| 检查项 | 结果 |
|---|---|
| 注入 | 通过。`playurl via xhr`、`video`、`official subtitles ... none` 都有。面板挂载前的日志原来会丢，已修。 |
| 开启后首条字幕 | 2.6 秒（job 122-123）。之后每个 job 2.5–5.5 秒。 |
| 悬停提示 | 「AI 字幕：已缓冲 142 秒（点击关闭）」 |
| 拖到 30:00 | **4.0 秒**出现字幕 |
| 2 倍速 | 30 秒内缓冲一直在 114–135 秒之间 |
| 暂停 | 缓冲补满后 25 秒内 0 个新请求 |
| overlay 网页全屏 | 正常，字号 27.6px，挂在 `.bpx-player-subtitle-wrap` 里 |
| overlay 真全屏 | 用户目测有字幕 |
| 连播 | 切换 cid 后旧会话立即停止，约 3 秒后在新 cid 上自动开始。发现**标题错位**：manifest 立刻切换，`__INITIAL_STATE__` 晚几秒，新 bvid 配上了旧标题（进提示词）。已修。 |
| 缓存 | 刷新后 `cache hit: 147 cues, covered [[612,1103],[1800,2050]]`；跳到缓存区间内 255 ms 显示字幕，0 个请求 |
| 已有字幕的视频 | 提示「本视频已有字幕（中文）。再点一次仍然用 Gemini 转写」；6 秒内再点一次才开始。按钮悬停提示原来没刷新，已修。 |
| 导出 | SRT 180 条，时长全部合法，无繁体。发现 1 处 chunk 交界重复（见下），已修。Chrome 设置了「下载前询问保存位置」，会弹另存为对话框 |
| Key 错误 | 用户手动测：提示「API Key 无效或没有权限」+「打开设置」，按钮红色（data-state=error），只请求 1 次不重试。新增：改 Key 后自动重启出错的会话（未在浏览器验证） |
| 断网 | 用户手动测：音频请求 `Failed to fetch`，按 5 秒、10 秒退避重试，恢复网络后自动续上（18:58:11 断，18:58:31 恢复），没丢区间。提示原来直接显示英文 `Failed to fetch`，已改成「网络连接失败，无法读取音频」（未在浏览器验证） |

**新构建复测（同日）**：早期日志进了面板；会话开启 2 秒后就切到 overlay（早于第一批字幕的 4 秒）；连播时先发不带标题的 `video`，3 秒后补发正确标题；有官方字幕的视频按钮提示「本视频已有官方字幕，点击仍可转写」。这次点下一集没有自己跳集，之前那次应该是 B 站记住的进度在片尾、触发了自动连播（用户也这么认为）。

**导出 SRT 里的交界重复**：16:17–16:22 出现「我尽力了，兄弟们。我这边我也不」「我这边我也不知道能打多久」「知道能打多久，…」。原因是一个 chunk 的长句被 `splitLong` 从词中间拆开，相邻 chunk 听到的整句跨了两段，逐条比较时相似度不够。修法：在重叠窗口内，如果一条字幕的文字被另一个 chunk 中与它时间重叠的 2 条以上字幕拼起来的文字包含，就当作重复。另外两处相邻重复（「他还来了个we can win」「力神发功了」，间隔 3 秒）看起来是主播真的说了两遍，没有处理。旧缓存里的这段数据不会自动修正。

另外注意：页面上同时有 3 个 `<video>` 元素（预览等），我们的选择器优先取 `.bpx-player-video-wrap video`，实测时间轴正确。
