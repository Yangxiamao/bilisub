import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  entrypointsDir: 'entrypoints',
  manifest: {
    name: 'BiliSub - Gemini 中文字幕',
    description: '为没有字幕的 B 站视频，用 Gemini 提前听写中文字幕',
    permissions: ['storage'],
    // Audio is fetched from the page context (CDN needs a bilibili.com Referer),
    // so the only extra host is the Gemini API, called from the service worker.
    host_permissions: ['https://generativelanguage.googleapis.com/*'],
  },
});
