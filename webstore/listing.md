# Chrome 应用商店：商品详情和后台答卷

按开发者后台（https://chrome.google.com/webstore/devconsole）的标签页顺序整理，填写时直接复制。

依据的政策页面（2026-11-11 读取）：
[Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies) ·
[User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) ·
[Images](https://developer.chrome.com/docs/webstore/images) ·
[Branding](https://developer.chrome.com/docs/webstore/branding) ·
[Gemini API 附加条款](https://aistudio.google.com/docs/terms)

---

## 1. 软件包（Package）

上传 `npm run zip` 产出的 `.output/bilisub-<版本>-chrome.zip`。每次上传的版本号必须大于上一次（`package.json` 的 `version`）。

## 2. 商品详情（Store listing）

**语言**：中文（简体）

**名称**（来自 manifest，≤75 字符）：

```
BiliSub：B站 AI 中文字幕
```

**简介 / Summary**（来自 manifest description，≤132 字符）：

```
为没有字幕的 B 站视频提前听写中文字幕，同步显示在播放器上。需要你自己的 Google Gemini API Key。
```

**详细说明 / Description**：

```
很多 B 站视频没有字幕。BiliSub 在你观看时，提前把播放位置前方的一小段音频交给 Google Gemini API 听写，再把中文字幕同步显示在播放器上。

【功能】
• 预读转写：默认保持播放位置之后约 2 分钟已转写，首条字幕通常几秒内出现
• 拖动进度条、倍速、暂停、网页全屏和全屏都能跟上
• 合集和分 P 连播时自动继续（可关闭）
• 转写过的部分缓存在本机，重看不再产生费用
• 已有官方字幕的视频默认不转写，再点一次可强制转写
• 出错时在播放器内提示原因（Key 无效、网络错误等），可重试的错误自动重试
• 可选模型：Gemini 3.8 Flash（默认）、3.5 Flash-Lite（更便宜）、3.5 Transcribe（专用转写）

【使用方法】
1. 安装后在设置页填写你的 Gemini API Key（在 Google AI Studio 免费创建），阅读并确认费用和隐私说明。
2. 打开一个 B 站视频，点播放器控制栏里字幕按钮左边的「AI」按钮。

【费用】
转写会使用你自己的 Gemini API 额度，费用由你的 Google 账号支付。按测试视频实测，每小时音频约 0.07–0.24 美元（视模型而定，以 Google 官方价格为准）。只转写播放位置前方的一段，不会一次转写整部视频。

【隐私】
• 只有在你开启 AI 字幕后，才会把当前视频的音频片段和标题、标签、简介发送给 Google Gemini API。
• API Key 在本机加密保存，只发送给 Google。
• 扩展没有自己的服务器，不收集任何数据，没有统计和跟踪代码。代码开源。
• 使用免费层 Key 时，Google 可能用这些数据改进产品并可能人工审阅；付费项目不会。
隐私政策：https://github.com/Yangxiamao/bilisub/blob/main/PRIVACY.md

【使用条件】
Google 要求 Gemini API 使用者年满 18 岁，并在 Gemini API 支持的地区使用（不包括中国大陆、香港、澳门）。在欧洲经济区、瑞士、英国必须使用已开启结算的付费项目 Key。

【已知限制】
• 自绘字幕不跟随 B 站「字幕设置」里的字号和颜色。
• 转写质量取决于模型和音频，嘈杂背景或多人同时说话时会有错字和漏句。
• 依赖 B 站播放器的内部接口，播放器改版可能暂时失效。

源代码和问题反馈：https://github.com/Yangxiamao/bilisub

Gemini 是 Google LLC 的商标，其使用受 Google 许可条款约束。本扩展与哔哩哔哩、Google 均无关联，也未获得其认可。
```

**类别**：Make Chrome Yours › Accessibility（备选：Lifestyle › Entertainment）

**图片**：

| 素材 | 要求 | 文件 |
|---|---|---|
| 商店图标（必需） | 128×128 PNG，图案 96×96 + 每边 16px 透明 | `public/icon/128.png` |
| 截图（至少 1 张，最多 5 张） | 1280×800 或 640×400，直角、无留白 | `webstore/screenshots/*.png` |
| 小宣传图（可选，建议提供，否则无法被推荐） | 440×280 PNG/JPEG | `webstore/promo-440x280.png` |
| 大宣传图（可选） | 1400×560 | 不提供 |

截图清单（每张配一句说明，写在后台图片说明里）：
1. 视频播放中显示 AI 字幕，「AI」按钮为开启状态 — 「没有字幕的视频，边看边出中文字幕」
2. 鼠标悬停「AI」按钮显示「已缓冲 N 秒」 — 「提前转写播放位置前方的内容」
3. 网页全屏或全屏下的字幕 — 「全屏也能显示」
4. 设置页（Key 打码） — 「使用你自己的 Gemini API Key，费用和隐私说明一目了然」
5. 扩展弹窗 — 「在弹窗里查看状态和开关」

**官方网址 / 主页**：https://github.com/Yangxiamao/bilisub
**支持网址**：https://github.com/Yangxiamao/bilisub/issues

## 3. 隐私权规范（Privacy practices）

**单一用途说明**：

```
Generate Chinese subtitles for Bilibili videos that have none: while the user watches a video they turned the feature on for, the extension sends short audio clips ahead of the playback position to the Google Gemini API (with the user's own API key) and shows the returned subtitles on the player.

为没有字幕的 B 站视频生成中文字幕：用户在某个视频上开启后，扩展把播放位置前方的短音频片段用用户自己的 API Key 发送给 Google Gemini API，并把返回的字幕显示在播放器上。
```

**权限理由**：

| 权限 | 理由（直接复制） |
|---|---|
| `storage` | Stores the user's settings and their Gemini API key (AES-GCM encrypted) in chrome.storage.local. |
| 主机权限 `https://generativelanguage.googleapis.com/*` | The background service worker sends audio clips to the Google Gemini API for transcription. This is the only remote host the extension contacts. |
| 内容脚本 `https://www.bilibili.com/video/*` | Runs only on Bilibili video pages: reads the audio stream URL the player already loaded, fetches short audio clips ahead of the playback position, adds the "AI" button and draws the subtitles on the player. |

**是否使用远程代码**：否（No, I am not using remote code）。所有 JavaScript 都在扩展包里；Gemini API 只返回字幕文本，作为数据解析，不执行。

**数据使用 — 收集的数据类型**（勾选）：

| 类别 | 是否勾选 | 说明 |
|---|---|---|
| 身份验证信息 Authentication information | ✅ | 用户的 Gemini API Key |
| 网站内容 Website content | ✅ | 视频音频片段、标题、标签、简介 |
| 网络浏览记录 Web history | ✅ | 本地缓存里的视频编号（BV 号、分 P）；只在本机，不发送 |
| 个人身份信息、健康、财务、个人通讯、位置、用户活动 | ❌ | 不处理 |

**合规声明**（三项全部勾选）：
- 不会出于已获批准的用途之外的目的向第三方出售或传输用户数据
- 不会出于与商品单一用途无关的目的使用或传输用户数据
- 不会为确定信用度或借贷目的而使用或传输用户数据

**隐私政策网址**：https://github.com/Yangxiamao/bilisub/blob/main/PRIVACY.md（仓库公开后才能访问）

## 4. 分发（Distribution）

- **可见性**：公开（Public）。
- **地区**：选「特定地区」，只选 Gemini API 支持的地区（清单见下）。注意不包括中国大陆、香港、澳门、俄罗斯等。清单会变，提交前再核对一次 https://aistudio.google.com/docs/available-regions 。

<details>
<summary>Gemini API 支持地区（2026-11-11 抄录，按原页面顺序）</summary>

Albania, Algeria, American Samoa, Andorra, Angola, Anguilla, Antarctica, Antigua and Barbuda, Argentina, Armenia, Aruba, Australia, Austria, Azerbaijan, The Bahamas, Bahrain, Bangladesh, Barbados, Belgium, Belize, Benin, Bermuda, Bhutan, Bolivia, Bosnia and Herzegovina, Botswana, Brazil, British Indian Ocean Territory, British Virgin Islands, Brunei, Bulgaria, Burkina Faso, Burundi, Cabo Verde, Cambodia, Cameroon, Canada, Caribbean Netherlands, Cayman Islands, Central African Republic, Chad, Chile, Christmas Island, Cocos (Keeling) Islands, Colombia, Comoros, Cook Islands, Costa Rica, Côte d'Ivoire, Croatia, Curaçao, Czech Republic, Democratic Republic of the Congo, Denmark, Djibouti, Dominica, Dominican Republic, Ecuador, Egypt, El Salvador, Equatorial Guinea, Eritrea, Estonia, Eswatini, Ethiopia, Falkland Islands (Islas Malvinas), Faroe Islands, Fiji, Finland, France, French Guiana, Gabon, The Gambia, Georgia, Germany, Ghana, Gibraltar, Greece, Greenland, Grenada, Guam, Guatemala, Guernsey, Guinea, Guinea-Bissau, Guyana, Haiti, Heard Island and McDonald Islands, Honduras, Hungary, Iceland, India, Indonesia, Iraq, Ireland, Isle of Man, Israel, Italy, Jamaica, Japan, Jersey, Jordan, Kazakhstan, Kenya, Kiribati, Kosovo, Kuwait, Kyrgyzstan, Laos, Latvia, Lebanon, Lesotho, Liberia, Libya, Liechtenstein, Lithuania, Luxembourg, Madagascar, Malawi, Malaysia, Maldives, Mali, Malta, Marshall Islands, Mauritania, Mauritius, Mexico, Micronesia, Moldova, Monaco, Mongolia, Montenegro, Montserrat, Morocco, Mozambique, Namibia, Nauru, Nepal, Netherlands, New Caledonia, New Zealand, Nicaragua, Niger, Nigeria, Niue, Norfolk Island, North Macedonia, Northern Mariana Islands, Norway, Oman, Pakistan, Palau, Palestine, Panama, Papua New Guinea, Paraguay, Peru, Philippines, Pitcairn Islands, Poland, Portugal, Puerto Rico, Qatar, Republic of Cyprus, Republic of the Congo, Romania, Rwanda, Réunion, Saint Barthélemy, Saint Helena, Ascension and Tristan da Cunha, Saint Kitts and Nevis, Saint Lucia, Saint Pierre and Miquelon, Saint Vincent and the Grenadines, Samoa, San Marino, São Tomé and Príncipe, Saudi Arabia, Senegal, Serbia, Seychelles, Sierra Leone, Singapore, Slovakia, Slovenia, Solomon Islands, Somalia, South Africa, South Georgia and the South Sandwich Islands, South Korea, South Sudan, Spain, Sri Lanka, Sudan, Suriname, Sweden, Switzerland, Taiwan, Tajikistan, Tanzania, Thailand, Timor-Leste, Togo, Tokelau, Tonga, Trinidad and Tobago, Tunisia, Turkmenistan, Turks and Caicos Islands, Tuvalu, Türkiye, Uganda, Ukraine, United Arab Emirates, United Kingdom, United States, United States Minor Outlying Islands, Uruguay, U.S. Virgin Islands, Uzbekistan, Vanuatu, Vatican City, Venezuela, Vietnam, Wallis and Futuna, Western Sahara, Yemen, Zambia, Zimbabwe, Åland Islands

</details>

## 5. 给审核员的测试说明（Test instructions）

决定：不提供测试 Key（2026-11-11）。如果因为审核员无法测试而被拒，再考虑提供一个限额的临时 Key 后重新提交。

```
This extension requires the user's own Google Gemini API key; we do not provide one.
A free key can be created in about a minute at https://aistudio.google.com/apikey (Google account required; the free tier is enough for testing).

Steps:
1. After install, the options page opens. Paste the key into "Gemini API Key", click "我已了解，开始使用" (I understand, start), then "保存" (Save).
2. Open a Bilibili video without subtitles, e.g. https://www.bilibili.com/video/BV1VXGL6KE9D/
3. Click the "AI" button in the player control bar (left of the subtitle button). Chinese subtitles appear within about 10 seconds.
4. Hover the "AI" button to see the buffered seconds; click again to turn it off.
Without a key, clicking "AI" shows a prompt to open the options page; nothing is sent anywhere.
The extension only contacts generativelanguage.googleapis.com. Audio is fetched from Bilibili's CDN in the page context.
Source code: https://github.com/Yangxiamao/bilisub
```

## 6. 账号（只能你本人操作）

- 注册开发者账号：https://chrome.google.com/webstore/devconsole ，支付一次性注册费（政策页未写金额，以后台为准），同意开发者协议。
- 验证联系邮箱（必需；**注册用的邮箱以后不能更改**）。
- 交易者 / 非交易者声明：个人、非商业、免费扩展一般选「非交易者」；选择后欧盟用户会被告知消费者保护法不适用。
- 审核通常几天，可能几周（新开发者和新扩展更久）；超过 3 周可联系支持。审核通过后有 30 天可以选择发布时间。
