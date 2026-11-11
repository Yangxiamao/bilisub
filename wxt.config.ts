import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  entrypointsDir: 'entrypoints',
  // Ship readable code: the store package should match the repository source.
  vite: () => ({ build: { minify: false } }),
  manifest: {
    name: 'BiliSub：B站 AI 中文字幕',
    description: '为没有字幕的 B 站视频提前听写中文字幕，同步显示在播放器上。需要你自己的 Google Gemini API Key。',
    homepage_url: 'https://github.com/Yangxiamao/bilisub',
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    action: { default_icon: { 16: 'icon/16.png', 32: 'icon/32.png' } },
    permissions: ['storage'],
    // Audio is fetched from the page context (CDN needs a bilibili.com Referer),
    // so the only extra host is the Gemini API, called from the service worker.
    host_permissions: ['https://generativelanguage.googleapis.com/*'],
  },
});
