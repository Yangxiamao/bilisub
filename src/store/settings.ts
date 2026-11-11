/** Extension settings in chrome.storage.local (API key stored in plain text, per RPD). */
export type RendererMode = 'auto' | 'official' | 'overlay';

export interface Settings {
  apiKey: string;
  model: string;
  /** Seconds of video to keep transcribed ahead of the playhead. */
  lookahead: number;
  /** Max Gemini requests in flight (global, all tabs). */
  concurrency: number;
  /** Keep transcribing when the player moves on to the next part / playlist item. */
  autoContinue: boolean;
  /** Debug panel, raw response capture, exports. */
  debug: boolean;
  /** auto = player's own subtitle module if available, else overlay. */
  renderer: RendererMode;
  /** Timestamp when the user accepted the cost / privacy notice. */
  consentAt: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'gemini-3.8-flash',
  lookahead: 120,
  concurrency: 2,
  autoContinue: true,
  debug: false,
  renderer: 'auto',
  consentAt: 0,
};

export interface ModelInfo {
  id: string;
  label: string;
  kind: 'generic' | 'dedicated';
  thinkingLevel?: 'MINIMAL' | 'LOW';
  /** Measured on the test video (S3, 2026-11-11), USD per hour of audio. */
  usdPerHour: number;
}

export const MODELS: ModelInfo[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash（默认，更准确）', kind: 'generic', thinkingLevel: 'LOW', usdPerHour: 0.13 },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite（最便宜）', kind: 'generic', thinkingLevel: 'MINIMAL', usdPerHour: 0.07 },
  { id: 'gemini-3.5-transcribe', label: 'Gemini 3.5 Transcribe（专用转写，词级时间戳）', kind: 'dedicated', usdPerHour: 0.24 },
];

export const modelInfo = (id: string): ModelInfo => MODELS.find((m) => m.id === id) ?? { id, label: id, kind: 'generic', thinkingLevel: 'LOW', usdPerHour: NaN };

const KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>;

export async function getSettings(): Promise<Settings> {
  const s = await browser.storage.local.get(KEYS);
  return { ...DEFAULT_SETTINGS, ...(s as Partial<Settings>) };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await browser.storage.local.set(patch);
}

export function onSettingsChanged(fn: (s: Partial<Settings>) => void): () => void {
  const l = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local') return;
    const patch: Partial<Settings> = {};
    for (const k of KEYS) if (k in changes) (patch as Record<string, unknown>)[k] = changes[k].newValue;
    if (Object.keys(patch).length) fn(patch);
  };
  browser.storage.onChanged.addListener(l);
  return () => browser.storage.onChanged.removeListener(l);
}
