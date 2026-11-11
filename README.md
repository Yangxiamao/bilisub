# BiliSub：B站 AI 中文字幕

为没有字幕的 B 站视频，用 Google Gemini API 实时听写中文字幕的 Chrome 扩展。

开启后，扩展会在播放位置前方提前拉取视频的音频片段，交给 Gemini 转写，再把字幕同步显示在播放器上（网页全屏和全屏也能显示）。拖动进度条、倍速、暂停、合集连播都能跟上；转写过的区间会缓存在本地，重看不再产生费用。

> 本项目与哔哩哔哩、Google 均无关联。Gemini 是 Google LLC 的商标。使用前请阅读下方的[费用与隐私](#费用与隐私)。

## 功能

- 预读转写：默认保持播放位置之后 120 秒已转写；暂停时补满缓冲后停止请求。
- 首条字幕通常 3 秒左右出现，拖动后约 4 秒续上（实测数据见 [docs/phase0.md](docs/phase0.md)）。
- 合集 / 分 P 连播时自动切换到下一个视频继续转写（可关闭）。
- 本地缓存（IndexedDB）：按视频、分 P、模型和提示词版本存储。
- 已有 CC 或 AI 字幕的视频默认不转写，再点一次可以强制转写。
- 出错时按钮变红并在播放器内提示原因（Key 无效、网络错误等），可重试的错误自动退避重试。
- 可选模型：Gemini 3.8 Flash（默认）、3.5 Flash-Lite（更便宜）、3.5 Transcribe（专用转写模型）。
- 调试模式：debug 面板、导出 SRT 和原始响应。

## 安装

目前需要从源码构建：

```bash
git clone https://github.com/Yangxiamao/bilisub.git
cd bilisub
npm install
npm run build
```

然后在 Chrome 打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择 `.output/chrome-mv3` 目录。

需要 Node.js 20 或更新版本（开发时使用 Node 24）。

## 使用

1. 安装后会自动打开设置页。填写 [Gemini API Key](https://aistudio.google.com/apikey)，阅读并确认费用和隐私说明。
2. 打开一个没有字幕的 B 站视频，点播放器控制栏里字幕按钮左边的「AI」按钮（或者在扩展弹窗里开启）。
3. 鼠标悬停在「AI」按钮上可以看到状态：转写中、已缓冲多少秒，或出错原因。再点一次关闭。

设置页还可以调整模型、预读时长、并发数、连播时是否自动继续，以及清空缓存。

## 费用与隐私

- **会产生 Gemini API 费用**，由你自己的 Google 账号支付。按测试视频实测，每小时音频大约：3.8 Flash $0.13、3.5 Flash-Lite $0.07、3.5 Transcribe $0.24（价格以 Google 官方为准，可能变动）。
- **视频的音频会发送给 Google** 进行转写，同时发送视频的标题、标签和简介（帮助写对专有名词）。请求里在支持的地方都设置了 `store: false`。使用免费层 API Key 时，Google 可能把数据用于改进产品并可能由人工审阅，详见 [Gemini API 附加服务条款](https://aistudio.google.com/docs/terms)。
- API Key 用 AES-GCM 加密后保存在浏览器的扩展存储里（密钥不可导出，只有扩展自己的页面能解密），只发送给 `generativelanguage.googleapis.com`。
- 扩展不收集任何数据，没有自己的服务器。完整说明见[隐私政策](PRIVACY.md)。
- Google 要求 Gemini API 使用者年满 18 岁，并在 [Gemini API 支持的地区](https://aistudio.google.com/docs/available-regions)使用；在欧洲经济区、瑞士、英国必须使用已开启结算的付费项目 Key。
- 请自行确认你的使用方式符合哔哩哔哩和 Google 的服务条款。

## 工作原理

1. MAIN world 脚本被动捕获播放器自己请求到的 playurl（DASH 音频地址）和官方字幕信息。
2. 内容脚本解析音频的 sidx 索引，按播放位置用 HTTP Range 拉取若干完整 fragment，拼成一个小的 fMP4，不转码。
3. 后台 service worker 把音频发给 Gemini，模型返回带时间戳的文本；在相邻片段的重叠区去重，换算成视频的绝对时间。
4. 字幕先尝试用播放器自带的字幕模块（`window.player.addSubtitle`）显示；在无字幕视频上播放器会隐藏这个模块，于是自动改用扩展自绘的字幕层。

设计和调研过程见 [docs/plan.md](docs/plan.md)，验证数据见 [docs/phase0.md](docs/phase0.md)，最初的需求见 [docs/requirements.md](docs/requirements.md)。

## 已知限制

- 无字幕视频上用的是自绘字幕层，不跟随 B 站「字幕设置」里的字号和颜色。
- 转写质量取决于模型和音频。游戏、嘈杂背景或多人同时说话时会有错字和漏句。
- 依赖 B 站播放器的内部接口，播放器改版可能导致失效。

## 开发

```bash
npm test            # 单元测试（Vitest）
npm run typecheck
npm run build       # 输出 .output/chrome-mv3
npm run dev         # WXT 开发模式
```

> Windows：请在 PowerShell 或 VS Code 终端里运行 `npm test`。在 Git Bash 里用 `/d/...` 形式的路径会导致 vitest 被加载两次而报错。

浏览器内的手动测试清单和调试命令见 [docs/testing.md](docs/testing.md)。

### 目录

```
entrypoints/
  bili-main.content.ts  MAIN world：被动捕获 playurl 和官方字幕信息、刷新 playurl、视频切换监听、window.player 适配
  bili.content.ts       isolated：每个标签页的控制器（开关、连播、渲染器选择、弹窗消息、调试面板）
  background.ts         调用 Gemini（持有 Key、并发限制、超时重试）、IndexedDB 缓存
  options/              设置页、费用与隐私说明、清空缓存
  popup/                当前标签页状态和开关
src/
  core/                 scheduler（预读调度）、session（单个视频的转写流水线）、limiter
  bili/                 playurl 解析、sidx/fMP4 解析、Range 拉取
  transcriber/          Gemini 转写器、提示词、重试
  subs/                 字幕清洗、繁转简、拆分、重叠合并、区间、SRT
  render/               播放器字幕模块渲染器（带可见性自检）和自绘字幕层
  ui/                   控制栏按钮、播放器内提示、调试面板
  audio/ bridge/ store/ util/
tests/                  单元测试
docs/                   需求、计划、验证记录、手动测试
```

## 许可证

[MIT](LICENSE)
