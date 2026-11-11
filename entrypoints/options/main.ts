import { send } from '../../src/bridge/runtime';
import { getSettings, MODELS, setSettings, type RendererMode } from '../../src/store/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const apiKey = $<HTMLInputElement>('apiKey');
const model = $<HTMLSelectElement>('model');
const lookahead = $<HTMLInputElement>('lookahead');
const concurrency = $<HTMLInputElement>('concurrency');
const autoContinue = $<HTMLInputElement>('autoContinue');
const renderer = $<HTMLSelectElement>('renderer');
const debug = $<HTMLInputElement>('debug');

for (const m of MODELS) model.add(new Option(`${m.label} · 约 $${m.usdPerHour.toFixed(2)}/小时`, m.id));
$('costs').textContent = MODELS.map((m) => `${m.id} 约 $${m.usdPerHour.toFixed(2)}`).join('，');

async function load(): Promise<void> {
  const s = await getSettings();
  apiKey.value = s.apiKey;
  model.value = s.model;
  lookahead.value = String(s.lookahead);
  concurrency.value = String(s.concurrency);
  autoContinue.checked = s.autoContinue;
  renderer.value = s.renderer;
  debug.checked = s.debug;
  $('consentState').textContent = s.consentAt ? `已于 ${new Date(s.consentAt).toLocaleString()} 确认` : '';
  $('consentState').className = s.consentAt ? 'hint ok' : 'hint';
  refreshCount();
}

function refreshCount(): void {
  send<{ ok: boolean; count: number }>({ type: 'cache-count' })
    .then((r) => { $('cacheState').textContent = `已缓存 ${r.count} 个视频分 P`; })
    .catch(() => undefined);
}

const clamp = (v: string, lo: number, hi: number, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
};

$('save').addEventListener('click', async () => {
  await setSettings({
    apiKey: apiKey.value.trim(),
    model: model.value,
    lookahead: clamp(lookahead.value, 30, 600, 120),
    concurrency: clamp(concurrency.value, 1, 6, 2),
    autoContinue: autoContinue.checked,
    renderer: renderer.value as RendererMode,
    debug: debug.checked,
  });
  $('saved').textContent = '已保存';
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
  void load();
});

$('consent').addEventListener('click', async () => {
  await setSettings({ consentAt: Date.now() });
  void load();
});

$('clearCache').addEventListener('click', async () => {
  await send({ type: 'cache-clear' });
  refreshCount();
});

void load();
