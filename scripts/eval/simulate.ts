/**
 * End-to-end simulation of the content-script Session in Node, against the
 * real test video and the real Gemini API. Only the browser pieces are faked:
 * the <video> element (a clock), chrome.runtime messaging (routed to the same
 * code the background runs) and the renderer (records cue updates).
 *
 *   npx tsx scripts/eval/simulate.ts [--start 10:00] [--play 60] [--seek 30:00] [--after 40] [--model gemini-3.5-flash-lite]
 */
import { biliFetch, parseTime, out, trackFetcher, videoMeta, fmtTime } from './common';
import { apiKey } from './gemini-env';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const START = parseTime(opt('start', '10:00'));
const PLAY = Number(opt('play', '60'));
const SEEK = parseTime(opt('seek', '30:00'));
const AFTER = Number(opt('after', '40'));
const MODEL = opt('model', 'gemini-3.5-flash-lite');
const key = apiKey();

// ---- fake chrome.runtime, routed to the background's logic ------------------
const { DedicatedTranscriber, GenericTranscriber } = await import('../../src/transcriber/gemini');
const { transcribeRobust, classify } = await import('../../src/transcriber/robust');
const { modelInfo, DEFAULT_SETTINGS } = await import('../../src/store/settings');
const { fromBase64 } = await import('../../src/util/base64');
const { Limiter } = await import('../../src/core/limiter');
const limiter = new Limiter(2);
const jobs = new Map<string, AbortController>();
const store = new Map<string, unknown>();
let apiCalls = 0;
let audioSec = 0;

(globalThis as unknown as { browser: unknown }).browser = {
  runtime: {
    async sendMessage(msg: { type: string; [k: string]: unknown }) {
      switch (msg.type) {
        case 'transcribe': {
          const info = modelInfo(MODEL);
          const t = info.kind === 'dedicated'
            ? new DedicatedTranscriber({ apiKey: key, model: MODEL, transport: 'inline', wordTimestamp: true })
            : new GenericTranscriber({ apiKey: key, model: MODEL, format: 'compact', thinkingLevel: info.thinkingLevel ?? 'LOW' });
          const ac = new AbortController();
          jobs.set(msg.jobId as string, ac);
          try {
            return await limiter.run(async () => {
              apiCalls++;
              audioSec += msg.duration as number;
              const r = await transcribeRobust(t, { bytes: fromBase64(msg.audio as string), mimeType: msg.mimeType as string, duration: msg.duration as number }, msg.ctx as object, ac.signal);
              return { ok: true, cues: r.cues, usage: r.usage, latencyMs: r.latencyMs, attempts: r.attempts, model: MODEL };
            }, ac.signal);
          } catch (e) {
            const c = classify(ac.signal.aborted ? new DOMException('Aborted', 'AbortError') : e);
            return { ok: false, code: c.code, error: c.message };
          } finally {
            jobs.delete(msg.jobId as string);
          }
        }
        case 'abort':
          jobs.get(msg.jobId as string)?.abort();
          return { ok: true };
        case 'cache-get':
          return { ok: true, record: store.get(msg.key as string) ?? null };
        case 'cache-put':
          store.set((msg.record as { key: string }).key, structuredClone(msg.record));
          return { ok: true };
        default:
          return { ok: true };
      }
    },
  },
};

const { Session } = await import('../../src/core/session');
type Cue = { from: number; to: number; content: string };

// ---- fake video clock ---------------------------------------------------------
class FakeVideo {
  private base = START;
  private at = Date.now();
  playbackRate = 1;
  paused = false;
  get currentTime() {
    return this.paused ? this.base : this.base + ((Date.now() - this.at) / 1000) * this.playbackRate;
  }
  seek(t: number) {
    this.base = t;
    this.at = Date.now();
  }
  addEventListener() {}
  removeEventListener() {}
}
const video = new FakeVideo();

// ---- renderer that records when cues covering the playhead first appear ------
const t0 = Date.now();
let lastCues: Cue[] = [];
const firstVisible: Array<{ label: string; ms: number }> = [];
let phase = { label: 'start', at: Date.now(), seen: false };
const renderer = {
  kind: 'overlay' as const,
  setCues(c: Cue[]) {
    lastCues = c;
    const t = video.currentTime;
    if (!phase.seen && c.some((x) => x.from >= t - 1 && x.from <= t + 15)) {
      phase.seen = true;
      firstVisible.push({ label: phase.label, ms: Date.now() - phase.at });
      console.log(`  first cues near playhead after ${phase.label}: ${Date.now() - phase.at} ms`);
    }
  },
  clear() {},
  destroy() {},
};

const meta = await videoMeta();
const f = await trackFetcher(meta);
const settings = { ...DEFAULT_SETTINGS, apiKey: key, model: MODEL, consentAt: 1 };
const logs: string[] = [];
const mk = () => new Session({
  info: { ...meta, cid: meta.cid },
  settings,
  renderer,
  video: () => video as unknown as HTMLMediaElement,
  track: () => f.track,
  refreshTrack: async () => (await trackFetcher(meta)).track,
  onStatus: (s) => logs.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s.state}: ${s.message}`),
  log: (...a) => logs.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${a.join(' ')}`),
  fetchImpl: biliFetch,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
console.log(`simulating ${MODEL}: play ${fmtTime(START)} for ${PLAY}s, seek to ${fmtTime(SEEK)}, play ${AFTER}s`);
let s = mk();
await s.start();
await sleep(PLAY * 1000);
phase = { label: `seek to ${fmtTime(SEEK)}`, at: Date.now(), seen: false };
video.seek(SEEK);
await sleep(AFTER * 1000);
s.stop();
const firstRun = [...s.track];

// Re-open: should be served from cache with zero API calls.
const callsBefore = apiCalls;
phase = { label: 'reopen (cache)', at: Date.now(), seen: false };
video.seek(START);
s = mk();
await s.start();
await sleep(3000);
s.stop();

// Duplicate check: adjacent cues with near-identical text.
const { similarity } = await import('../../src/subs/cues');
const dups = firstRun.filter((c, i) => i > 0 && similarity(c.content, firstRun[i - 1].content) >= 0.8);
const overlaps = firstRun.filter((c, i) => i > 0 && c.from < firstRun[i - 1].to - 0.01);

const { toSrt } = await import('../../src/subs/srt');
out('sim/simulate.srt', toSrt(firstRun));
out('sim/log.txt', logs.join('\n'));
const report = {
  model: MODEL, apiCalls: callsBefore, audioSecondsSent: Math.round(audioSec), cues: firstRun.length,
  firstVisible, cacheReopenApiCalls: apiCalls - callsBefore, cacheReopenCues: lastCues.length,
  adjacentDuplicates: dups.map((c) => `${fmtTime(c.from)} ${c.content}`), timeOverlaps: overlaps.length,
  coveredSec: Math.round(firstRun.length ? firstRun[firstRun.length - 1].to - firstRun[0].from : 0),
};
out('sim/report.json', JSON.stringify(report, null, 2));
console.log(report);
console.log('wrote scripts/eval/out/sim/{simulate.srt,log.txt,report.json}');
process.exit(0);
