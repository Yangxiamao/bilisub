# 商店素材

这个目录是 Chrome 应用商店上架用的素材和文案，**不会打进扩展包**（扩展包只来自 `npm run zip` 的构建产物）。

| 文件 | 用途 |
|---|---|
| `icon.svg` | 128px 图标源文件（96×96 图案 + 每边 16px 透明边，符合商店图标要求） |
| `icon-small.svg` | 32/48px 图标源文件（铺满，元素更粗） |
| `icon-16.svg` | 16px 图标源文件（按像素对齐） |
| `promo-440x280.html` → `promo-440x280.png` | 小宣传图 |
| `listing.md` | 商品详情文案、隐私权规范答卷、分发设置、给审核员的测试说明 |
| `screenshots/` | 1280×800 截图 |
| `render.py` | 重新生成图标和宣传图 |

## 重新生成图标和宣传图

需要 Google Chrome、Python 3 和 Pillow（`pip install pillow`）：

```bash
python webstore/render.py          # 写入 public/icon/{16,32,48,128}.png 和 webstore/promo-440x280.png
python webstore/render.py --check  # 另外生成 webstore/out/preview.png 预览各尺寸
```

`webstore/out/` 是中间文件，已加入 .gitignore。

设计约定：深青绿底 `#0E7C66`、琥珀色声波 `#FBBF24`、白色字幕条。不使用哔哩哔哩的小电视图形和品牌蓝，也不使用 Gemini 的四角星和渐变，避免让人误以为是官方产品。
