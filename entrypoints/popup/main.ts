import type { TabRequest, TabStatus } from '../../src/bridge/runtime';
import { getSettings, hasApiKey, modelInfo } from '../../src/store/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLDivElement>('status');
const toggle = $<HTMLButtonElement>('toggle');

$('options').addEventListener('click', () => void browser.runtime.openOptionsPage());

const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

async function ask<T>(msg: TabRequest): Promise<T | null> {
  if (tab?.id == null) return null;
  try {
    return (await browser.tabs.sendMessage(tab.id, msg)) as T;
  } catch {
    return null; // no content script: not a supported page
  }
}

async function refresh(): Promise<void> {
  const s = await getSettings();
  const st = await ask<TabStatus>({ type: 'tab-status' });
  if (!st) {
    status.textContent = '当前页面不是 B 站普通视频页（www.bilibili.com/video/…）。';
    toggle.disabled = true;
    return;
  }
  const lines = [
    st.active ? `状态：${st.detail ?? st.state}` : '状态：未开启',
    `模型：${modelInfo(s.model).label}`,
  ];
  if (st.hasOfficialSubs) lines.push('本视频已有官方字幕');
  if (!hasApiKey(s)) lines.push('⚠ 还没有填写 API Key（点「设置」）');
  if (!s.consentAt) lines.push('⚠ 首次使用请先在「设置」里确认费用和隐私说明');
  status.textContent = lines.join('\n');
  status.style.whiteSpace = 'pre-line';
  toggle.disabled = false;
  toggle.textContent = st.active ? '关闭 AI 字幕' : '开启 AI 字幕';
}

toggle.addEventListener('click', async () => {
  await ask({ type: 'tab-toggle' });
  setTimeout(() => void refresh(), 400);
});

void refresh();
setInterval(() => void refresh(), 1500);
