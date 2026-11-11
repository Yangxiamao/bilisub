/**
 * S3: transcription quality / timing / cost matrix on the test video.
 *
 *   npm run eval:s3 -- [--samples 02:00,10:00,20:00,30:00,40:00] [--len 60] [--only A1,B1]
 *
 * Writes scripts/eval/out/s3/report.html (side-by-side, click a time to seek),
 * per-variant SRT, raw responses and summary.json (latency, tokens, $/min).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitize, shift, splitLong } from '../../src/subs/cues';
import { toSrt } from '../../src/subs/srt';
import { DedicatedTranscriber, GenericTranscriber } from '../../src/transcriber/gemini';
import { GeminiError, type AudioPayload, type Cue, type Transcriber, type TranscribeResult } from '../../src/transcriber/types';
import type { AudioClip } from '../../src/bili/fetcher';
import { fmtTime, OUT, out, parseTime, trackFetcher, videoMeta } from './common';
import { apiKey, costUsd, toWav16k } from './gemini-env';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const samples = opt('samples', '02:00,10:00,20:00,30:00,40:00').split(',').map(parseTime);
const len = Number(opt('len', '60'));
const only = opt('only', '').split(',').filter(Boolean);
const dir = opt('out', 's3');
const key = apiKey();

// Packaging + transcribe transport chosen by S2 (falls back to WAV / files).
type S2Row = { label: string; ok: boolean };
const s2Path = join(OUT, 's2', 'summary.json');
const s2: { rows: S2Row[]; storeFalseAccepted: boolean } | null = existsSync(s2Path) ? JSON.parse(readFileSync(s2Path, 'utf8')) : null;
const okLabel = (l: string) => !!s2?.rows.some((r) => r.label.startsWith(l) && r.ok);
const packaging = okLabel('fmp4 as audio/mp4') ? 'fmp4:audio/mp4'
  : okLabel('fmp4 as audio/m4a') ? 'fmp4:audio/m4a'
  : okLabel('adts as audio/aac') ? 'adts:audio/aac'
  : 'wav:audio/wav';
const transport = okLabel('transcribe inline') ? 'inline' : 'files';
const noStore = s2?.storeFalseAccepted ?? true;
console.log(`packaging=${packaging} transcribeTransport=${transport} store:false=${noStore}`);

function payload(clip: AudioClip): AudioPayload {
  const dur = clip.span.end - clip.span.start;
  const [kind, mimeType] = packaging.split(':');
  const bytes = kind === 'fmp4' ? clip.fmp4 : kind === 'adts' ? clip.adts() : toWav16k(clip.fmp4, 'm4a');
  return { bytes, mimeType, duration: dur };
}

const meta = await videoMeta();
const ctx = { title: meta.title, tags: meta.tags, desc: meta.desc };
const vocab = [...new Set([...meta.tags, ...(meta.title.match(/[A-Za-z0-9一-鿿]{2,}/g) ?? [])])].slice(0, 100);

const variants: Array<{ id: string; model: string; desc: string; make: () => Transcriber; timed: boolean }> = [
  { id: 'A1', model: 'gemini-3.5-flash-lite', desc: '3.5 Flash-Lite · MINIMAL · 紧凑文本', timed: true, make: () => new GenericTranscriber({ apiKey: key, model: 'gemini-3.5-flash-lite', format: 'compact', noStore }) },
  { id: 'A2', model: 'gemini-3.5-flash-lite', desc: '3.5 Flash-Lite · MINIMAL · JSON', timed: true, make: () => new GenericTranscriber({ apiKey: key, model: 'gemini-3.5-flash-lite', format: 'json', noStore }) },
  { id: 'A3', model: 'gemini-3.8-flash', desc: '3.8 Flash · LOW（不支持 MINIMAL）· 紧凑文本', timed: true, make: () => new GenericTranscriber({ apiKey: key, model: 'gemini-3.8-flash', format: 'compact', thinkingLevel: 'LOW', noStore }) },
  { id: 'B1', model: 'gemini-3.5-transcribe', desc: `3.5 Transcribe · 词级时间戳 · ${transport}`, timed: true, make: () => new DedicatedTranscriber({ apiKey: key, model: 'gemini-3.5-transcribe', transport, wordTimestamp: true, noStore }) },
  { id: 'B2', model: 'gemini-3.5-transcribe', desc: `3.5 Transcribe · 自定义词表（无时间戳）· ${transport}`, timed: false, make: () => new DedicatedTranscriber({ apiKey: key, model: 'gemini-3.5-transcribe', transport, customVocabulary: vocab, noStore }) },
].filter((v) => !only.length || only.includes(v.id));

const f = await trackFetcher(meta);
await f.load();

interface Cell { cues: Cue[]; text?: string; latencyMs: number; usd: number | null; usage: TranscribeResult['usage']; error?: string; timings?: unknown; attempts?: number }

/** 60 s per-attempt timeout; retry 429 (honouring "retry in Ns"), 5xx and network errors. */
async function robust(t: Transcriber, p: AudioPayload): Promise<{ r: TranscribeResult; attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { r: await t.transcribe(p, ctx, AbortSignal.timeout(60_000)), attempts: attempt };
    } catch (e) {
      const err = e as GeminiError;
      const retryable = err?.name === 'TimeoutError' || (err instanceof GeminiError && err.retryable);
      if (!retryable || attempt >= 4) throw e;
      const hinted = /retry in ([\d.]+)s/i.exec(err.message ?? '');
      const waitMs = hinted ? Math.ceil(Number(hinted[1]) * 1000) + 1000 : 2000 * 2 ** (attempt - 1);
      console.log(`    retry ${attempt} in ${Math.round(waitMs / 1000)} s (${(err.message ?? err.name).slice(0, 60)})`);
      await new Promise((res) => setTimeout(res, waitMs));
    }
  }
}
const results: Array<{ start: number; end: number; clipFile: string; cells: Record<string, Cell> }> = [];
const firstChunk: Record<string, { latencyMs: number; fetchMs: number; cues: number; error?: string }> = {};

for (const [i, s] of samples.entries()) {
  const clip = await f.clipByTime(s, s + len);
  const p = payload(clip);
  const clipFile = `clips/sample${i + 1}.m4a`;
  out(`${dir}/${clipFile}`, clip.fmp4);
  const row = { start: clip.span.start, end: clip.span.end, clipFile, cells: {} as Record<string, Cell> };
  console.log(`\nsample ${i + 1}: ${fmtTime(clip.span.start)}–${fmtTime(clip.span.end)}`);
  for (const v of variants) {
    const t = v.make();
    try {
      const { r, attempts } = await robust(t, p);
      const cues = v.timed ? splitLong(sanitize(r.cues, p.duration)) : [];
      row.cells[v.id] = { cues, text: r.text, latencyMs: r.latencyMs, usd: costUsd(v.model, r.usage), usage: r.usage, timings: (t as DedicatedTranscriber).lastTimings, attempts };
      out(`${dir}/raw/sample${i + 1}_${v.id}.json`, JSON.stringify(r.raw, null, 2));
      console.log(`  ${v.id}: ${cues.length} cues, ${r.latencyMs} ms, $${costUsd(v.model, r.usage)?.toFixed(5)}`);
    } catch (e) {
      row.cells[v.id] = { cues: [], latencyMs: 0, usd: null, usage: null, error: (e as Error).message };
      console.log(`  ${v.id}: ERROR ${(e as Error).message}`);
    }
  }
  results.push(row);
}

// First-chunk latency: 2 fragments (~10 s) at the first sample, end to end incl. Range fetch.
for (const v of variants.filter((x) => x.timed)) {
  const t0 = Date.now();
  try {
    const info = await f.load();
    const k = info.index.refs.findIndex((r) => r.start + r.duration > samples[0]);
    const clip = await f.clipByFragments(k, k + 1);
    const fetchMs = Date.now() - t0;
    const r = await v.make().transcribe(payload(clip), ctx, AbortSignal.timeout(60_000));
    firstChunk[v.id] = { latencyMs: Date.now() - t0, fetchMs, cues: r.cues.length };
  } catch (e) {
    firstChunk[v.id] = { latencyMs: Date.now() - t0, fetchMs: 0, cues: 0, error: (e as Error).message };
  }
  console.log(`first-chunk ${v.id}:`, firstChunk[v.id]);
}

// Per-variant SRT (absolute video time) + summary
const summary: Record<string, unknown> = {};
for (const v of variants) {
  const all = results.flatMap((r) => shift(r.cells[v.id]?.cues ?? [], r.start));
  if (v.timed) out(`${dir}/${v.id}.srt`, toSrt(all));
  const cells = results.map((r) => r.cells[v.id]).filter((c) => c && !c.error);
  const minutes = results.reduce((n, r) => n + (r.end - r.start), 0) / 60;
  const usd = cells.reduce((n, c) => n + (c.usd ?? 0), 0);
  summary[v.id] = {
    desc: v.desc,
    errors: results.filter((r) => r.cells[v.id]?.error).length,
    avgLatencyMs: Math.round(cells.reduce((n, c) => n + c.latencyMs, 0) / Math.max(1, cells.length)),
    usdPerAudioMinute: +(usd / minutes).toFixed(5),
    usdPerAudioHour: +((usd / minutes) * 60).toFixed(3),
    tokens: cells.reduce((acc, c) => {
      if (c.usage) for (const k of Object.keys(c.usage) as Array<keyof typeof c.usage>) acc[k] = (acc[k] ?? 0) + c.usage[k];
      return acc;
    }, {} as Record<string, number>),
    firstChunk: firstChunk[v.id],
  };
}
out(`${dir}/summary.json`, JSON.stringify({ video: meta.bvid, packaging, transport, samples: results.map((r) => [r.start, r.end]), summary }, null, 2));

// HTML report
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cellHtml = (c: Cell | undefined) => {
  if (!c) return '<td></td>';
  if (c.error) return `<td class="err">${esc(c.error)}</td>`;
  const body = c.cues.length
    ? c.cues.map((q) => `<div class="cue"><a href="#" data-t="${q.from}">${q.from.toFixed(1)}–${q.to.toFixed(1)}</a> ${esc(q.content)}</div>`).join('')
    : `<div class="plain">${esc(c.text ?? '') || '<i>（空）</i>'}</div>`;
  return `<td>${body}<div class="meta">${c.latencyMs} ms · $${c.usd?.toFixed(5) ?? '?'}</div></td>`;
};
const html = `<!doctype html><meta charset="utf-8"><title>S3 对照表</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:16px;background:#fff;color:#111}
table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{border:1px solid #ccc;padding:6px;vertical-align:top}
th{background:#f4f4f4;position:sticky;top:0}.cue a{font-family:monospace;color:#06c;margin-right:4px}
.meta{color:#888;font-size:12px;margin-top:4px}.err{color:#c00}.plain{white-space:pre-wrap}
audio{width:100%}h2{margin-top:28px}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}th{background:#222}td,th{border-color:#444}}
</style>
<h1>S3 转写对照：${esc(meta.title)}</h1>
<p>打包格式 ${esc(packaging)}；点击时间可跳转到该片段的音频位置（相对片段起点）。</p>
<pre>${esc(JSON.stringify(summary, null, 2))}</pre>
${results.map((r, i) => `<h2>样本 ${i + 1}：${fmtTime(r.start)}–${fmtTime(r.end)}</h2>
<audio id="a${i}" controls preload="metadata" src="${r.clipFile}"></audio>
<table data-audio="a${i}"><tr>${variants.map((v) => `<th>${v.id} ${esc(v.desc)}</th>`).join('')}</tr>
<tr>${variants.map((v) => cellHtml(r.cells[v.id])).join('')}</tr></table>`).join('\n')}
<script>
document.addEventListener('click',e=>{const a=e.target.closest('a[data-t]');if(!a)return;e.preventDefault();
const au=document.getElementById(a.closest('table').dataset.audio);au.currentTime=+a.dataset.t;au.play();});
</script>`;
out(`${dir}/report.html`, html);
console.log(`\nwrote scripts/eval/out/${dir}/report.html and summary.json`);
