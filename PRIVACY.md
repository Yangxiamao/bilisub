# BiliSub 隐私政策 / Privacy Policy

生效日期 / Effective date: 2026-11-11

[中文](#中文) · [English](#english)

---

## 中文

BiliSub（「B站 AI 中文字幕」Chrome 扩展，以下简称「本扩展」）是一个开源项目，源代码见 <https://github.com/Yangxiamao/bilisub>。本扩展**没有自己的服务器，开发者收不到你的任何数据**。下面说明本扩展在你的浏览器里处理哪些数据、发给谁。

### 处理哪些数据

| 数据 | 用途 | 存在哪里 / 发给谁 |
|---|---|---|
| 你的 Google Gemini API Key | 以你的身份调用 Gemini API | 用 AES-GCM 加密后保存在本机浏览器的扩展存储里；只通过 HTTPS 发送给 Google（`generativelanguage.googleapis.com`） |
| 你开启 AI 字幕的视频的音频片段 | 转写成字幕 | 只在你开启后，从 B 站读取播放位置前方的一小段音频，通过 HTTPS 发送给 Google Gemini API；本扩展不把音频保存到磁盘 |
| 该视频的标题、标签、简介 | 帮助模型写对专有名词 | 随音频一起发送给 Google Gemini API |
| 转写出的字幕、视频编号（BV 号、分 P 编号）、模型名称 | 本地缓存，重看时不再重复请求和计费 | 只保存在本机浏览器（IndexedDB） |
| 设置（模型、预读时长等）和你确认使用说明的时间 | 扩展正常运行 | 只保存在本机浏览器 |

本扩展只在 `https://www.bilibili.com/video/*` 页面上运行，**只有你在某个视频上开启 AI 字幕后**才会读取和发送音频。本扩展不读取 B 站账号信息、Cookie、评论或其他网站的内容，不记录你的浏览历史。

### 与谁共享

唯一的接收方是 **Google**（Gemini API），用于把音频转写成字幕。请求中设置了 `store: false`。Google 如何处理这些数据由你的 API Key 所属项目适用的 Google 条款决定，详见 [Gemini API 附加服务条款](https://aistudio.google.com/docs/terms)：

- 已开启结算的付费项目：Google 表示不会用你的提示和回复改进其产品；
- 免费层项目：Google 可能用提交的内容改进其产品，并可能由人工审阅。

本扩展不出售数据，不用于广告、信用评估或与字幕功能无关的任何用途，不包含任何统计或跟踪代码。

### 保留与删除

- 字幕缓存：设置页「清空字幕缓存」可以随时删除。
- API Key：在设置页清空 Key 并保存即删除。
- 卸载扩展会删除本扩展在浏览器里保存的所有数据。
- 已发送给 Google 的数据按 Google 的条款保留。

### 使用条件

Google 要求 Gemini API 的使用者年满 18 岁，并在 [Gemini API 支持的地区](https://aistudio.google.com/docs/available-regions)使用；在欧洲经济区、瑞士、英国必须使用已开启结算的付费项目。请自行确认你的使用方式符合哔哩哔哩和 Google 的服务条款。

### Chrome 应用商店用户数据政策

本扩展对所获取信息的使用遵守 [Chrome 应用商店用户数据政策](https://developer.chrome.com/docs/webstore/program-policies/policies)，包括其中的「有限使用」（Limited Use）要求。

### 变更与联系

本政策如有变更，会更新本页并修改生效日期。问题和反馈请提交到 <https://github.com/Yangxiamao/bilisub/issues>。

Gemini 是 Google LLC 的商标。本扩展与哔哩哔哩、Google 均无关联。

---

## English

BiliSub (the "BiliSub：B站 AI 中文字幕" Chrome extension, "the extension") is open source: <https://github.com/Yangxiamao/bilisub>. The extension **has no server of its own; the developer receives none of your data**. This page explains what the extension handles inside your browser and where it is sent.

### Data handled

| Data | Purpose | Where it is stored / sent |
|---|---|---|
| Your Google Gemini API key | Calling the Gemini API on your behalf | Encrypted with AES-GCM in the extension's local storage on your device; sent only to Google (`generativelanguage.googleapis.com`) over HTTPS |
| Audio clips of the video you turn AI subtitles on for | Transcription into subtitles | Only after you turn it on, short clips ahead of the playback position are read from Bilibili and sent to the Google Gemini API over HTTPS; audio is not written to disk |
| That video's title, tags and description | Helping the model spell names correctly | Sent to the Google Gemini API together with the audio |
| Transcribed subtitles, video IDs (BV id, part id), model name | Local cache so re-watching does not repeat requests or costs | Your device only (IndexedDB) |
| Settings and the time you accepted the usage notice | Normal operation | Your device only |

The extension runs only on `https://www.bilibili.com/video/*` pages and reads or sends audio **only after you turn AI subtitles on for a video**. It does not read your Bilibili account, cookies, comments or any other website, and it does not record your browsing history.

### Sharing

The only recipient is **Google** (Gemini API), for transcription. Requests set `store: false`. How Google processes the data depends on the Google terms that apply to the project your API key belongs to; see the [Gemini API Additional Terms of Service](https://aistudio.google.com/docs/terms):

- Paid projects with billing enabled: Google states it does not use your prompts or responses to improve its products.
- Free-tier projects: Google may use submitted content to improve its products, and humans may review it.

The extension does not sell data, does not use it for advertising, creditworthiness or anything unrelated to the subtitle feature, and contains no analytics or tracking code.

### Retention and deletion

- Subtitle cache: delete it at any time with "清空字幕缓存" (Clear subtitle cache) on the options page.
- API key: clear the key field on the options page and save.
- Uninstalling the extension deletes everything it stored in your browser.
- Data already sent to Google is retained according to Google's terms.

### Conditions of use

Google requires Gemini API users to be 18 or older and to use the API in an [available region](https://aistudio.google.com/docs/available-regions); in the European Economic Area, Switzerland and the UK only paid projects may be used. Make sure your use complies with Bilibili's and Google's terms of service.

### Chrome Web Store User Data Policy

The use of information received by this extension adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the Limited Use requirements.

### Changes and contact

If this policy changes, this page will be updated together with the effective date. Questions and feedback: <https://github.com/Yangxiamao/bilisub/issues>.

Gemini is a trademark of Google LLC. This extension is not affiliated with Bilibili or Google.
