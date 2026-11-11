/**
 * S2: which audio packaging does Gemini accept, and is billing ~32 tok/s of
 * *clip* time (no phantom leading silence)?
 *
 *   npm run eval:s2 -- [start=10:00] [end=10:30] [model=gemini-3.5-flash-lite]
 */
import { GenericTranscriber, DedicatedTranscriber } from '../../src/transcriber/gemini';
import { GeminiError, type AudioPayload } from '../../src/transcriber/types';
import { fmtTime, out, parseTime, trackFetcher, videoMeta } from './common';
import { apiKey, costUsd, toWav16k } from './gemini-env';

const [a = '10:00', b = '10:30', model = 'gemini-3.5-flash-lite'] = process.argv.slice(2);
const key = apiKey();
const meta = await videoMeta();
const f = await trackFetcher(meta);
const clip = await f.clipByTime(parseTime(a), parseTime(b));
const dur = clip.span.end - clip.span.start;
const adts = clip.adts();
const wav = toWav16k(clip.fmp4, 'm4a');
console.log(`clip ${fmtTime(clip.span.start)}–${fmtTime(clip.span.end)} (${dur.toFixed(2)} s), fmp4 ${clip.fmp4.byteLength} B, adts ${adts.byteLength} B, wav ${wav.byteLength} B`);

const variants: Array<[label: string, payload: AudioPayload]> = [
  ['fmp4 as audio/mp4', { bytes: clip.fmp4, mimeType: 'audio/mp4', duration: dur }],
  ['fmp4 as audio/m4a', { bytes: clip.fmp4, mimeType: 'audio/m4a', duration: dur }],
  ['fmp4 as audio/aac', { bytes: clip.fmp4, mimeType: 'audio/aac', duration: dur }],
  ['adts as audio/aac', { bytes: adts, mimeType: 'audio/aac', duration: dur }],
  ['wav16k as audio/wav', { bytes: wav, mimeType: 'audio/wav', duration: dur }],
];

const ctx = { title: meta.title, tags: meta.tags };
const rows: unknown[] = [];
let storeOk = true;
for (const [label, payload] of variants) {
  const t = new GenericTranscriber({ apiKey: key, model, noStore: storeOk });
  try {
    const r = await t.transcribe(payload, ctx);
    const row = {
      label, ok: true, latencyMs: r.latencyMs, cues: r.cues.length,
      audioTokens: r.usage?.audioTokens, tokPerSec: r.usage ? +(r.usage.audioTokens / dur).toFixed(1) : null,
      outputTokens: r.usage?.outputTokens, thoughtsTokens: r.usage?.thoughtsTokens, usd: costUsd(model, r.usage),
      lastCueEnd: r.cues.at(-1)?.to, preview: r.text?.slice(0, 160),
    };
    rows.push(row);
    out(`s2/${label.replace(/\W+/g, '_')}.json`, JSON.stringify({ row, raw: r.raw }, null, 2));
    console.log(row);
  } catch (e) {
    const err = e as GeminiError;
    if (storeOk && err.status === 400 && /store/i.test(err.message)) {
      console.warn('store:false rejected by API -> retrying without it (record this!)');
      storeOk = false;
      variants.push([label, payload]);
      continue;
    }
    const row = { label, ok: false, status: err.status, error: err.message?.slice(0, 300) };
    rows.push(row);
    console.log(row);
  }
}

// Does the dedicated transcribe model take inline audio?
const best = variants.find(([l]) => (rows as Array<{ label: string; ok: boolean }>).some((r) => r.label === l && r.ok));
if (best) {
  for (const transport of ['inline', 'files'] as const) {
    const t = new DedicatedTranscriber({ apiKey: key, model: 'gemini-3.5-transcribe', transport, wordTimestamp: true, noStore: storeOk });
    try {
      const r = await t.transcribe(best[1], ctx);
      const row = { label: `transcribe ${transport} (${best[0]})`, ok: true, latencyMs: r.latencyMs, timings: t.lastTimings, cues: r.cues.length, audioTokens: r.usage?.audioTokens, outputTokens: r.usage?.outputTokens, preview: r.text?.slice(0, 160) };
      rows.push(row);
      out(`s2/transcribe_${transport}.json`, JSON.stringify({ row, raw: r.raw }, null, 2));
      console.log(row);
    } catch (e) {
      const err = e as GeminiError;
      const row = { label: `transcribe ${transport}`, ok: false, status: err.status, error: err.message?.slice(0, 300), timings: t.lastTimings };
      rows.push(row);
      console.log(row);
    }
  }
}

out('s2/summary.json', JSON.stringify({ model, clip: clip.span, duration: dur, storeFalseAccepted: storeOk, rows }, null, 2));
console.log('\nwrote scripts/eval/out/s2/summary.json');
