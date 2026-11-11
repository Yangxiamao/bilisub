# B站 Gemini 中文字幕扩展：调研结论与分阶段计划

> 这是开发前写的计划，部分判断已被实测修正，以 [phase0.md](phase0.md) 为准。最重要的一条：无字幕视频上，播放器自带的字幕模块（`addSubtitle`）显示不出来，实际用的是扩展自绘的字幕层。

## Context

项目开始时只有需求文档 [requirements.md](requirements.md)。目标是做一个 Chrome MV3 扩展：对没有 CC 或 AI 字幕的 B 站视频，在播放位置前方提前拉取 DASH 音频，交给 Gemini 听写成中文字幕，并同步显示在播放器上（全屏也能显示）。RPD 要求先调研、再做 Phase 0 可行性验证，通过后再进入正式开发。本文件是计划，不含代码。

调研时间：2026-11-11。证据来源：
1. 测试视频页 HTML。
2. 播放器核心 `//s1.hdslb.com/bfs/static/player/main/core.1782590f.js`（约 2MB）和分包 `widgets/npd.pc-helper.<hash>.js`。
3. 对 playurl 接口和音频 CDN 的实际请求。
4. 当前 Gemini 文档：`ai.google.dev/gemini-api/docs/*` 已 301 到 `aistudio.google.com/docs/*`。
5. 已有开源项目源码：bilibili-ai-subtitle-forcer、cybergeek2077/bilibili-subtitle、bili-ai-whisper、Bilibili CC字幕工具。

Claude in Chrome 扩展当时未连接，所以没有在真实浏览器里抓网络请求。B 站方面的证据来自静态代码和 curl/Python 实测，凡是需要真实页面确认的都放进了 Phase 0。

---

## 1. 调研发现

### 1.1 B 站播放器初始化（视频页内联脚本）
```js
if (window.__playinfo__) primarySetting.prefetch = { playUrl: window.__playinfo__ }
window.player = nano.createPlayer(primarySetting, theme)
window.player.connect()
```
- 未登录时，SSR 页面**没有** `window.__playinfo__`（实测），播放器会自己请求 playurl。登录后是否有，需要实测。
- `nano.createPlayer` 返回 `rz(new rY(...))`，也就是一组公开 API 方法（见 1.3）。

### 1.2 DASH 音频（实测 BV1VXGL6KE9D，cid 38569313758）
- 播放器请求的是 `api.bilibili.com/x/player/wbi/playurl`（core.js 中 `N.getUrl` 的 Ugc 分支），参数含 `fnval`、`qn`、`fourk` 等。另有配置钩子 `requestConfig.reqHttpPlayUrlInfo`。
- **不带 wbi 签名的 `/x/player/playurl?bvid&cid&fnval=16` 匿名请求也返回 code 0**。可以作为兜底，但不作为主路径。
- 音轨：`30216`（67kbps）、`30232`（95k）、`30280`（179k），都是 `audio/mp4`、`mp4a.40.2`。都有 `segment_base: {initialization:"0-848", index_range:"849-7800"}`。
- **sidx 实测**：timescale 48000，**576 个 fragment，每个约 5.013 秒、约 42KB**，总时长 2886.6 秒。30216 整个文件 24.2MB；30 秒音频约 250KB。
  - 所以可以用 Range 按 fragment 精确取片段：起始时间从 sidx 累加得到，误差远小于 0.1 秒，不需要解码后再切。
- **地址过期**：URL 带 `deadline`，实测为签发时间加约 2 小时。播放器自己也会检查 `expires/wsTime/txTime/um_deadline/deadline`。
- **CORS 和 Referer 实测**：

  | 主机 | 带 B 站 Referer/Origin | 不带 Referer | Referer 为 chrome-extension:// |
  |---|---|---|---|
  | `upos-hz-mirrorakam.akamaized.net`（海外镜像） | 206，ACAO `*` | 206 | **403** |
  | `upos-sz-mirrorcosov.bilivideo.com`（国内 upos） | 206，ACAO `https://www.bilibili.com` | **403** | **403** |

  结论：**音频必须在页面上下文拉取**（content script 或 MAIN world 的 fetch 自带 bilibili.com 的 Origin 和 Referer）。从 service worker 直接拉会被拒，除非用 DNR 改 Referer。cybergeek 的 fork 也是在 isolated content script 里直接 fetch 加 Range，可以佐证。
- 视频内核是 dash.js（`window.dashjs`），API 里还有 `__core()`，可以作为再次兜底，从内核读 manifest。

### 1.3 字幕模块（3.x 播放器，关键发现）
- **字幕列表接口已经换了**：不再从 `/x/player/wbi/v2` 的 JSON 读取，而是 `//api.bilibili.com/x/v2/subtitle/web/view?oid=<cid>&pid=<aid>&type=1&...`，`responseType:"arraybuffer"`，**返回 protobuf**，用 `pb2Json.toJson(..., {type:"subtitle"})` 解码。`subtitle_url` 是 `//subtitle.bilibili.com/<混淆串>`，前端做 XOR 解码后拼成 `//aisubtitle.hdslb.com/...`。
  - 所以 forcer 那种改 `/x/player/wbi/v2` JSON 的办法，对当前版本大概率无效；CC字幕工具的 `updateSubtitle` 在 3.x 上也不存在了。
- 列表请求有官方钩子：`configStore.requestConfig.reqHttpSubtitleView`。存在时会改用调用方提供的函数，并跳过 URL 解码。
- **播放器公开 API**（`window.player` 上，core.js 的 `rZ` 数组）包含：
  - `addSubtitle(r) → subtitleStore.addSubtitle(r)`：接收 `{body:[{from,to,content}]}` 或 `[major, minor]`。它会按 `from` 排序，发出 `PLAYER_CLEAR_SUBTITLE`，再 `setRenderData(Major, body)`。
  - `updateRequestConfig(r) → configStore.updateRequestConfig(r)`。
- **渲染链路**（pc-helper 分包）：`SubtitleStore` 是 mobx 可观察对象，`dp.lanSwitch` 这个 reaction 监听 `renderData.Major/Minor`。数据一变就调用 `subtitleInstance.inputData({source, type:BILI, options})`。`options` 取自 `subtitleStore.state` 里的 color、fontsize、opacity、fade、scale、位置等，也就是 **B 站自己的字幕设置**。
  - 字幕层容器是 `.bpx-player-subtitle-wrap`，在播放器容器内部，所以全屏和网页全屏都在里面。
  - **推论**：反复调用 `player.addSubtitle({body: 当前全部条目})` 就能增量更新，用的是官方渲染器和官方样式，不需要重新加载轨道。待 S4 实测，重点看闪烁和 `isclosed` 状态。
- 选中某条语言轨道时，`fetchSubtitle(lan)` 会用 `findLanguageItem(lan).subtitle_url` 去拉内容，结果是 `{body:{list:[...]}}`。
- 代码里没找到 `attachShadow`。forcer 说的字幕在 shadow DOM 里，未经证实。

### 1.4 Gemini API（当前文档）
- **模型**：
  - `gemini-3.5-flash-lite`：GA 2026-07-21。$0.30/M 输入（含音频），$2.50/M 输出。思考级别默认 MINIMAL。
  - `gemini-3.6-flash`：GA。$0.75/$3.75，2027-01-01 起 $1.50/$7.50。默认 MEDIUM。
  - **新：`gemini-3.8-flash`**：GA 2026-09-02，"最智能的 Flash"，与 3.6 Flash 同价，也同样在 2027-01 涨价。
  - `gemini-3.5-transcribe`：GA 2026-08-26。
- **思考级别**：REST 字段是 `generationConfig.thinkingConfig.thinkingLevel`（`MINIMAL|LOW|MEDIUM|HIGH`）。**Gemini 3 系列不能完全关闭思考**，文档原话的意思是"minimal 不保证思考关闭"。思考 token 按输出计费，用 `thoughtsTokenCount` 监控。
  - `temperature`、`top_p`、`top_k` 已弃用，不要再传。
- **音频**：
  - 支持 wav、mp3、aiff、**aac**、ogg、flac、**m4a**、opus、webm 等，**列表里没有 `audio/mp4`**。fMP4 用哪个 MIME 能被接受，要在 S2 实测。
  - 32 token/秒，降采样到 16Kbps，单个请求最长 9.5 小时。
  - inline 大小限制文档自相矛盾（20MB 和 100MB 都有），但我们每段只有几百 KB，不受影响。
  - 文档建议时间戳用 `MM:SS` 格式，精度只到秒。
- **结构化输出**：新写法是 `generationConfig.responseFormat.text = {mimeType:"APPLICATION_JSON", schema}`，旧的 `responseMimeType`/`responseJsonSchema` 仍可用。`maxLength` 之类的约束会被去掉。
- **gemini-3.5-transcribe**：
  - 两种调用方式：Interactions（`POST /v1beta/interactions`），或 `models/gemini-3.5-transcribe:generateContent` 加 `audioTranscriptionConfig`（`languageCodes`、`wordTimestamp`、`customVocabulary`、`mode` 为 VERBATIM 或 SMART）。
  - **文档示例全部先用 Files API 上传**，没有写明支持 inline base64，要实测。
  - 词级时间戳 `mode:{type:"verbatim", timestamp_granularities:["word"]}`，文档提醒会降低准确率。`custom_vocabulary`（最多 1000 词）不能和词级时间戳或说话人分离同时用。
  - 返回格式 `annotations:[{type:"word_info", text, start_offset:"0.100s", end_offset}]`。
  - 价格：输入 $0.003/分钟，**按 25 token/秒计**；输出 $0.002/分钟。单次最长 1 小时，开时间戳则最长 30 分钟。
- **数据存储（与 RPD 第 2 节的"首次使用说明"有关）**：
  - 付费层不拿数据训练，但会日志留存一段时间。
  - Interactions 默认 `store:true`，付费层保留 55 天，可以传 `store:false`。
  - 2026-10-26 的 changelog 说：新建的付费项目，**generateContent 也默认存储请求**。需要找到关闭方法，并写进说明。
- **CORS**：没有官方说明。社区反馈原生 fetch 加 `x-goog-api-key` 可以；SDK 额外加的 header 会导致预检失败。我们在 service worker 里配 `host_permissions` 调用，不受 CORS 限制。
- **费用估算**（用于首次使用说明）：
  - 3.5 Flash-Lite：1 小时音频输入约 115k token，合 $0.035；输出加最低思考约 30–40k token，合 $0.08–0.10；提示词和重叠部分再加约 15%。合计**约 $0.12–0.15/小时**。
  - Transcribe：约 $0.30/小时。

---

## 2. Phase 0：可行性验证（S1–S4）

**第 0 步（开始执行时）**：
- 在项目目录执行 `git init`，默认分支 `main`；
- 添加 `.gitignore`（`.env`、`node_modules/`、`.output/`、`.wxt/`、`scripts/eval/out/`）和 `.env.example`；
- 首次提交需求文档和本计划的副本 `docs/plan.md`；
- 之后小步提交，每项验证一个 commit。

形式：一个最小的 WXT 骨架扩展（只放验证用代码），加上 `scripts/eval/` 下的 Node 评估脚本（从 `.env` 读 Key）。每项完成后写一份结果报告给你，确认后再进 Phase 1。

### S1 获取音频流（预计 0.5–1 天）
- **目标**：稳定拿到任意时间段（例如 10:00–10:30）对应的 fMP4 片段，包括 init 和对应的 fragment。
- **做法**：
  1. MAIN world 脚本在 `document_start` 时 hook XHR 和 fetch，**被动**捕获播放器的 `/x/player/wbi/playurl` 响应；同时读取 `window.__playinfo__`。
  2. 两者都没有时，兜底请求不签名的 `/x/player/playurl`（已实测可用），再不行就从 `player.__core()` 读 manifest。
  3. 选 bandwidth 最小的 AAC 轨。主机按 baseUrl 加 backupUrl 排序，`upos-*` 和 akamaized 优先，mcdn 和 PCDN 端口靠后。
  4. Range 拉 `initialization`，再拉 `index_range` 并解析 sidx，得到 fragment 时间表。之后按时间区间计算字节区间，用一次 Range 取回。
  5. **在 isolated content script 里 fetch**，带页面的 Origin 和 Referer，不需要 DNR。
  6. 过期处理：取地址前检查 `deadline`，剩余不到 5 分钟就重取；收到 403/404 时也重取 playurl。
  7. 切换分 P 或合集连播：在 hook 里观察 playurl 请求中 cid 的变化，同时用 `__INITIAL_STATE__` 和 URL 轮询作为辅助。
- **成功标准**：在你的 Chrome 里，测试视频任意 3 个区间都能取回字节，sidx 时间和 `video.currentTime` 对得上。切换合集下一集后能拿到新的 cid 和音频。
- **备选**：被动捕获失败，就主动请求 playurl，必要时自己实现 wbi 签名（参考 bili-ai-whisper，要注意签名错误时会"返回 200 加其他视频的数据"这个坑）。页面上下文 fetch 被拒，就改为 SW 拉取加 DNR 设置 Referer。

### S2 音频切片与格式（预计 0.5–1 天）
- **目标**：30–60 秒的片段 Gemini 能正常识别，切点误差 ≤0.1 秒。
- **做法**：按顺序试三种格式，用第一个可行的。
  1. init 加 N 个 `moof+mdat`，原样发送，MIME 依次试 `audio/mp4`、`audio/m4a`、`audio/aac`。零转码，体积最小。
  2. **fMP4 转 ADTS**（`audio/aac` 在官方列表里）：解析 `trun` 拿到每个 AAC 帧的大小，给每帧加 7 字节 ADTS 头。纯字节操作，可以在 content script 里做，不需要 AudioContext。
  3. 兜底：`OfflineAudioContext(1, n, 16000).decodeAudioData` 解码后编码成 16kHz 单声道 WAV（30 秒约 960KB）。在 content script（window 上下文）里能用 AudioContext，**不需要 offscreen document**。
- 片段边界对齐到 fragment（约 5 秒粒度）：首段 2–3 个 fragment（10–15 秒），后续 6–12 个（30–60 秒）。相邻片段**重叠 1 个 fragment**，用来补被切断的句子，之后去重。
- **成功标准**：同一段音频三种格式里至少有一种 API 返回 200 且内容正确。用一段有明显开头句的音频核对时间偏移，误差 ≤0.1 秒（sidx 时间是精确的）。
- **备选**：三种都不行，就走 Files API 上传（会增加延迟）。

### S3 转写质量、时间戳和费用（预计 1–2 天，需要你抽查）
- **样本**：测试视频里取 5 段，各 60 秒，包括密集炮火段、纯解说段、角色台词段和静音段。Node 脚本直接拉取（akamaized 主机不需要 Referer，bilivideo 主机设置 Referer 即可）。
- **对比矩阵**：
  - A1：`gemini-3.5-flash-lite`，MINIMAL，紧凑文本格式，每行 `起始秒|结束秒|文字`，秒数相对片段起点、保留 1 位小数。
  - A2：同一模型，JSON schema 输出。
  - A3：`gemini-3.8-flash`，MINIMAL（已确认替代 3.6 Flash）。
  - B1：`gemini-3.5-transcribe`，词级时间戳。先试 generateContent 加 inline 音频，不行再试 Files API。
  - B2：transcribe 加 `custom_vocabulary`（从标题和标签提取），再用 B1 的时间或片段对齐。
  - 可选实验：1.25 倍速音频；简单能量 VAD 跳过静音段。
- **输出**：每组生成 SRT 和对照表 HTML（音频时间、各方案文本并排）。记录 `usageMetadata`（输入、输出、思考 token），用来算每分钟实际费用，并记录端到端延迟（从 Range 拉取开始到拿到解析结果）。
- **成功标准**：你认为默认方案可读；时间误差 ≤±1 秒（抽 20 句和人工标注比对）；静音和炮火段没有编造内容；首段 10–15 秒切片端到端 <10 秒。
- **备选**：时间戳不准，就缩短片段（15–20 秒），或用 transcribe 的词级时间戳做对齐。有幻觉，就加 VAD 门限，并在提示词里明确"无人声输出空"。

### S4 注入 B 站官方字幕模块（预计 1–2 天）
- **目标**：用官方渲染器显示我们的字幕，支持增量更新、全屏和 B 站字幕设置，最好还能出现在字幕菜单里。
- **做法**（由易到难，逐级尝试）：
  - **A1 `player.addSubtitle`**：在 MAIN world 调用 `window.player.addSubtitle({body})`。每有新内容，就把完整的有序 body 重新传进去，验证：
    - 能不能显示，需不需要先把 `isclosed` 状态设成打开；
    - 增量更新时有没有闪烁，或当前句被清空；
    - 普通、网页全屏、全屏三种模式；
    - 改字号、透明度后是否生效；
    - 用户切到别的语言或关闭字幕时的行为。
  - **A2 菜单项**：
    - (a) 用 `player.updateRequestConfig({reqHttpSubtitleView})` 返回原列表加一条 `{lan:"gemini-zh", lan_doc:"Gemini 字幕", subtitle_url:"//bilisub.invalid/..."}`。原列表要先调用原接口再解 protobuf，或者在 XHR hook 层修改 protobuf 响应。
    - (b) hook 播放器的 `subtitle_url` 内容请求，返回我们的数据。
    - 选中这条轨道后，后续增量更新仍然用 A1 的 `addSubtitle`。
    - 重点验证：钩子要在 `onLoaded → fetchSubtitle` 之前生效；如果来不及，就调用 `requestSubtitleOnLanguageChange` 之类的路径重新触发。
  - **B 自绘**：在 `.bpx-player-subtitle-wrap` 里插入我们自己的元素，复用 `bpx-player-subtitle-panel-*` 的类名，并读取 `localStorage` 里播放器的字幕设置。
- **成功标准**（已确认）：A1 通过就算 S4 通过，即官方渲染器显示、1–2 秒内生效、不卡顿、三种屏幕模式、字号等设置生效。A2 的菜单项是加分项，做不出来不算失败。
- **失败判定**：A1 调用报错、不渲染、每次更新都明显闪烁，或者在 1–2 个播放器版本里方法签名不稳定，就判定失败，改走 B。

---

## 3. Phase 1（MVP）：在测试视频上看到同步字幕
1. WXT 工程：
   - `entrypoints/bili.main.ts`：MAIN world，hook playurl，调用 player API。
   - `entrypoints/bili.content.ts`：isolated，负责调度、Range 拉取、切片、UI。
   - `entrypoints/background.ts`：调用 Gemini。
   - `entrypoints/popup/`：开关和 Key 输入。
2. 调度器：围绕 `video.currentTime`，保持 [当前位置, 当前位置+预读] 已覆盖。首段短切片，之后长切片。并发上限默认 2。暂停时补满缓冲后停止。拖动进度条时 abort 不再需要的请求。
3. 转写器接口（先只实现 S3 选出的默认模型），解析结果，换算成绝对时间，拆成每条 ≤20 字，按重叠区去重。
4. 字幕渲染走 S4 选定的方案。播放器控制栏加一个开关按钮。
5. 通信：content 和 background 之间用 `chrome.runtime` 消息传 base64 音频（每段几百 KB）。MAIN 和 content 之间用 `window.postMessage`，带随机 token 校验来源。
- **验收**：打开测试视频，开启后 20 秒内（目标 10 秒）出现第一条字幕；之后持续同步；拖动到 30:00 能续上。

## 4. Phase 2
- IndexedDB 缓存：key 由 bvid、cid、模型、提示词版本组成，记录已覆盖区间，重看直接命中。
- 设置页：Key、模型、预读时长（默认 120 秒）、连播是否自动继续（默认继续）、并发数、调试模式（导出 SRT、原始请求和响应、音频片段）、清空缓存。
- 首次使用说明：费用估算；音频会发送给 Google；数据条款链接；`store:false` 和数据保留说明。
- 错误处理：401/403（Key 无效）、429、5xx、网络错误用指数退避；播放地址过期时自动刷新；播放器内轻提示。
- 分 P 和合集连播：cid 变化时停掉旧任务，按设置决定是否自动继续。
- 已有 CC 或 AI 字幕：根据字幕列表判断，默认不转写，可以手动开启。
- 第二个转写器（transcribe 或通用模型）做成可切换。

---

## 5. 模块与文件结构、主要数据结构
```
wxt.config.ts / package.json / .env.example / .gitignore(.env)
entrypoints/
  bili.main.ts        # MAIN world: hooks(playurl/subtitle), player API 适配, postMessage 桥
  bili.content.ts     # isolated: 会话控制、调度、UI 按钮/状态
  background.ts       # Gemini 调用、并发/重试
  popup/  options/
src/
  bili/playinfo.ts    # playurl 解析、选轨、过期判断、主机排序
  bili/sidx.ts        # sidx/moof/trun 解析、时间→字节区间
  audio/package.ts    # fMP4 直发 / ADTS 封装 / WAV 兜底
  transcriber/types.ts, generic.ts(generateContent), transcribe.ts(3.5-transcribe), prompt.ts
  subs/parse.ts, split.ts, dedupe.ts, intervals.ts   # 纯函数，Vitest 覆盖
  render/official.ts (addSubtitle), overlay.ts (方案 B)
  store/cache.ts (IndexedDB), settings.ts
scripts/eval/         # Phase 0 Node 评估脚本，读取 .env
tests/                # Vitest 单测
```
```ts
type Cue = { from: number; to: number; content: string }              // 绝对秒，与 B 站 body 同构
type Interval = [start: number, end: number]                          // 已覆盖区间，合并存储
type ChunkJob = { cid: number; start: number; end: number; fragIdx: [number, number]; overlapPrev: number }
interface Transcriber { id: string; transcribe(audio: AudioPayload, ctx: PromptCtx, signal: AbortSignal): Promise<{ cues: Cue[]; usage: Usage; raw: unknown }> }
// IndexedDB: store "tracks" key=`${bvid}:${cid}:${modelId}:${promptVer}` → { cues: Cue[]; covered: Interval[]; updatedAt }
```

## 6. 风险清单
| 风险 | 应对 |
|---|---|
| 播放器改版（core.js 的 hash 会变，`addSubtitle` 或 `requestConfig` 被删改） | 特性检测加版本日志；方案 B 一直保留为后备；选择器和方法名集中放在一个适配层 |
| playurl 被动捕获失效，或接口加强签名要求 | 三级兜底：`__playinfo__`、不签名 playurl、自己实现 wbi 签名 |
| CDN 地址过期（约 2 小时）或某个主机 403 | 检查 deadline，提前刷新；轮换 backupUrl |
| Gemini 时间戳不准或有幻觉 | 片段对齐 fragment、缩短片段、重叠加去重；提示词禁止编造；VAD 门限 |
| 模型下线或改名，参数弃用（例如 temperature） | 模型 ID 放配置；请求只带必要字段；出错时给出明确提示 |
| transcribe 不支持 inline，必须上传 | 评估上传延迟；不行就只用通用模型 |
| 请求被 Google 默认存储 | 能传 `store:false` 的地方都传；首次使用说明里写清楚 |
| MAIN world 注入顺序（forcer 报告过 Edge 上的问题） | 用 WXT 的 `world:"MAIN"` 在 `document_start` 注入；加注入自检，失败时回退到 `scripting.executeScript` |
| 上架审核（权限） | 只申请 storage，以及 `*.bilibili.com`、`generativelanguage.googleapis.com` 的 host 权限；音频 CDN 在页面上下文拉取，不需要 CDN 的 host 权限 |

## 7. 需要你配合的事项
安装 Node 和 pnpm；在 `.env` 填入 `GEMINI_API_KEY`；在 `chrome://extensions` 用开发者模式加载 `.output/chrome-mv3`；按测试清单在测试视频上操作，并把控制栏日志或导出文件发给我；S3 抽查对照表；（可选）连接 Claude in Chrome，这样我可以自己驱动 S1 和 S4 的验证。

## 8. 验证方式
- 单元测试（Vitest）：sidx、trun 解析，时间和字节区间换算，字幕解析、拆分、去重，区间合并。
- Phase 0：每项有一份书面报告（数据、截图或日志），你确认后再继续。
- Phase 1 和 2：手动测试清单，包括开启后首条字幕的耗时、拖动、倍速、暂停、三种屏幕模式、改字幕样式、分 P 和合集连播、缓存命中、Key 错误和断网。
- 如果用 Playwright：指定 `channel:'chrome'`。

## 9. 已确认的决定（2026-11-11）
1. **S4 的菜单项不是硬性要求**。成功标准改为：用官方渲染器显示（`addSubtitle`）、能增量更新、三种屏幕模式都能显示、B 站样式设置生效。开关放在控制栏按钮上。菜单项（A2）会尝试，但做不出来不算失败。
2. **高精度对照模型改用 `gemini-3.8-flash`**，不再测 3.6 Flash。S3 只测三类：3.5 Flash-Lite、3.8 Flash、3.5-transcribe。
3. **transcribe 如果必须走 Files API**：先测"上传加转写"的首段延迟。≤20 秒就保留为可切换的转写器，否则只作为离线对照。
4. **Phase 0 的浏览器验证由我通过 Claude in Chrome 驱动**。开始前需要你确认扩展已连接（在 claude.ai 用同一账号登录，必要时重启 Chrome）。如果没连上，就退回到"我写测试清单、你手动执行"。
5. 我自己定的默认值（如有异议请提出）：
   - Gemini 请求在 API 支持的地方都传 `store:false`；
   - 预读默认 120 秒；
   - 并发默认 2；
   - 首段切片约 10 秒（2 个 fragment），之后约 30 秒（6 个 fragment），相邻片段重叠 1 个 fragment。最终数值由 S3 决定。
