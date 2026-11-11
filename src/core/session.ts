/**
 * One transcription session = one video part (cid) in one tab.
 *
 * Keeps [playhead, playhead + lookahead] transcribed: plans fragment jobs,
 * fetches audio by Range, asks the background to transcribe, merges results
 * into one cue track, renders it and persists it to the cache.
 */
import { HttpStatusError, TrackFetcher } from '../bili/fetcher';
import { isExpiring, type AudioTrack } from '../bili/playinfo';
import type { VideoInfo } from '../bridge/protocol';
import { send, type ErrorCode, type TranscribeResponse } from '../bridge/runtime';
import type { Renderer } from '../render/renderers';
import { cacheKey, type TrackRecord } from '../store/cache';
import type { Settings } from '../store/settings';
import { mergeChunkWindows, sanitize, shift, splitLong, type OverlapWindow } from '../subs/cues';
import { addInterval, type Interval } from '../subs/intervals';
import { PROMPT_VERSION } from '../transcriber/prompt';
import type { Cue } from '../transcriber/types';
import { toBase64 } from '../util/base64';
import { bufferedAhead, doneFromIntervals, isStale, planJobs, type Frag, type Job } from './scheduler';

export type SessionState = 'starting' | 'transcribing' | 'buffered' | 'retrying' | 'error' | 'stopped';

export interface SessionStatus {
  state: SessionState;
  message: string;
  bufferedSec: number;
  inFlight: number;
  cues: number;
  errorCode?: ErrorCode | 'audio';
}

export interface SessionDeps {
  info: VideoInfo & { cid: number };
  settings: Settings;
  renderer: Renderer;
  video: () => HTMLMediaElement | null;
  /** Latest captured track for this cid (may be undefined until the player requests playurl). */
  track: () => AudioTrack | undefined;
  /** Ask the page for a fresh playurl (expired / 403). */
  refreshTrack: () => Promise<AudioTrack>;
  onStatus: (s: SessionStatus) => void;
  log: (...a: unknown[]) => void;
  /** Audio fetch implementation (tests / Node simulation inject one that adds a Referer). */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Debug sink for raw responses. */
  onResponse?: (job: Job, res: TranscribeResponse, span: { start: number; end: number }) => void;
}

interface Running {
  job: Job;
  id: string;
  ac: AbortController;
}

const FATAL: ReadonlySet<string> = new Set(['no-key', 'auth', 'bad-request']);
let jobSeq = 0;

export class Session {
  private fetcher?: TrackFetcher;
  private frags: Frag[] = [];
  private done: boolean[] = [];
  private pending: boolean[] = [];
  /** Fragments backing off after a failed job (treated as busy by the planner). */
  private blocked: boolean[] = [];
  private covered: Interval[] = [];
  private cues: Cue[] = [];
  private running = new Map<string, Running>();
  private failures = new Map<number, number>();
  private timer?: ReturnType<typeof setInterval>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private fatal?: { code: ErrorCode | 'audio'; message: string };
  private lastStatus = '';
  private listeners: Array<[string, () => void]> = [];
  readonly key: string;

  constructor(private d: SessionDeps) {
    this.key = cacheKey({ bvid: d.info.bvid, cid: d.info.cid, model: d.settings.model, promptVersion: PROMPT_VERSION });
  }

  get cid(): number {
    return this.d.info.cid;
  }

  /** Prompt context that arrived late; used by jobs started from now on. */
  updateMeta(m: { title?: string; desc?: string; tags?: string[] }): void {
    if (m.title) this.d.info = { ...this.d.info, ...m };
  }

  get track(): Cue[] {
    return this.cues;
  }

  async start(): Promise<void> {
    this.status('starting', '正在读取音频信息…');
    try {
      const t = this.d.track() ?? (await this.d.refreshTrack());
      this.fetcher = new TrackFetcher(t, this.d.fetchImpl);
      const info = await this.loadIndex();
      this.frags = info.index.refs.map((r) => ({ start: r.start, duration: r.duration }));
      this.done = new Array(this.frags.length).fill(false);
      this.pending = new Array(this.frags.length).fill(false);
      this.blocked = new Array(this.frags.length).fill(false);
    } catch (e) {
      return this.fail('audio', `无法读取音频：${(e as Error).message}`);
    }
    if (this.stopped) return;

    try {
      const r = await send<{ ok: boolean; record: TrackRecord | null }>({ type: 'cache-get', key: this.key });
      if (r?.record) {
        this.cues = r.record.cues;
        this.covered = r.record.covered;
        this.done = doneFromIntervals(this.frags, this.covered);
        this.d.renderer.setCues(this.cues);
        this.d.log(`cache hit: ${this.cues.length} cues, covered ${JSON.stringify(this.covered.map(([a, b]) => [Math.round(a), Math.round(b)]))}`);
      }
    } catch (e) {
      this.d.log('cache read failed', (e as Error).message);
    }

    const v = this.d.video();
    const on = (ev: string) => {
      const fn = () => this.tick();
      v?.addEventListener(ev, fn);
      this.listeners.push([ev, fn]);
    };
    ['seeking', 'seeked', 'play', 'ratechange'].forEach(on);
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const v = this.d.video();
    for (const [ev, fn] of this.listeners) v?.removeEventListener(ev, fn);
    for (const r of this.running.values()) this.abort(r);
    this.flushSave();
    this.d.renderer.clear();
    this.status('stopped', '已关闭');
  }

  // ---------------------------------------------------------------------------

  private async loadIndex() {
    try {
      return await this.fetcher!.load();
    } catch (e) {
      if (!(e instanceof HttpStatusError)) throw e;
      this.fetcher!.updateTrack(await this.d.refreshTrack());
      return this.fetcher!.load();
    }
  }

  private tick(): void {
    if (this.stopped || this.fatal || !this.frags.length) return;
    const v = this.d.video();
    const t = v?.currentTime ?? 0;
    const lookahead = this.d.settings.lookahead;

    for (const r of [...this.running.values()]) {
      if (isStale(r.job, this.frags, t, lookahead)) {
        this.d.log(`abort stale job ${r.job.newFirst}-${r.job.last}`);
        this.abort(r);
      }
    }

    const rate = v?.playbackRate ?? 1;
    const maxInFlight = this.d.settings.concurrency + (rate >= 1.5 ? 1 : 0);
    const jobs = planJobs({
      frags: this.frags, done: this.done, pending: this.pending.map((p, i) => p || this.blocked[i]), currentTime: t, lookahead,
      inFlight: this.running.size, maxInFlight,
    });
    for (const j of jobs) void this.run(j);
    this.report(t);
  }

  private report(t = this.d.video()?.currentTime ?? 0): void {
    const buffered = bufferedAhead(this.frags, this.done, t);
    if (this.fatal) return;
    const retrying = [...this.failures.values()].some((n) => n > 0);
    if (this.running.size) {
      this.status(retrying ? 'retrying' : 'transcribing', buffered > 0 ? `转写中，已缓冲 ${Math.round(buffered)} 秒` : '转写中…', buffered);
    } else if (buffered >= Math.min(this.d.settings.lookahead, this.remaining(t)) - 6) {
      this.status('buffered', `已缓冲 ${Math.round(buffered)} 秒`, buffered);
    } else {
      this.status(retrying ? 'retrying' : 'transcribing', '等待中…', buffered);
    }
  }

  private remaining(t: number): number {
    const last = this.frags[this.frags.length - 1];
    return last ? last.start + last.duration - t : 0;
  }

  private mark(job: Job, arr: boolean[], value: boolean): void {
    for (let i = job.newFirst; i <= job.last; i++) arr[i] = value;
  }

  private abort(r: Running): void {
    r.ac.abort();
    this.running.delete(r.id);
    this.mark(r.job, this.pending, false);
    void send({ type: 'abort', jobId: r.id }).catch(() => undefined);
  }

  private async run(job: Job): Promise<void> {
    const id = `j${++jobSeq}`;
    const ac = new AbortController();
    const r: Running = { job, id, ac };
    this.running.set(id, r);
    this.mark(job, this.pending, true);
    try {
      const clip = await this.fetchClip(job, ac.signal);
      if (ac.signal.aborted) return;
      const dur = clip.span.end - clip.span.start;
      const res = await send<TranscribeResponse>({
        type: 'transcribe', jobId: id, audio: toBase64(clip.fmp4), mimeType: 'audio/mp4', duration: dur,
        ctx: { title: this.d.info.title, tags: this.d.info.tags, desc: this.d.info.desc },
      });
      if (ac.signal.aborted || this.stopped) return;
      this.d.onResponse?.(job, res, { start: clip.span.start, end: clip.span.end });
      if (!res.ok) return this.onJobError(job, res.code, res.error);

      const abs = shift(splitLong(sanitize(res.cues, dur)), clip.span.start);
      const windows: OverlapWindow[] = [];
      if (job.first < job.newFirst) {
        const a = this.frags[job.first];
        windows.push({ start: a.start, end: a.start + a.duration, incomingIsLater: true });
      }
      if (this.done[job.last + 1] || this.pending[job.last + 1]) {
        // a later chunk (re-)hears our last fragment as its leading overlap
        const b = this.frags[job.last];
        windows.push({ start: b.start, end: b.start + b.duration, incomingIsLater: false });
      }
      this.cues = mergeChunkWindows(this.cues, abs, windows);
      this.mark(job, this.done, true);
      this.failures.delete(job.newFirst);
      const ownStart = this.frags[job.newFirst].start;
      const ownEnd = this.frags[job.last].start + this.frags[job.last].duration;
      this.covered = addInterval(this.covered, [ownStart, ownEnd]);
      this.d.renderer.setCues(this.cues);
      this.d.log(`job ${job.newFirst}-${job.last} ok: +${abs.length} cues, ${res.latencyMs} ms${res.attempts > 1 ? `, ${res.attempts} attempts` : ''}`);
      this.scheduleSave();
    } catch (e) {
      if (ac.signal.aborted || this.stopped) return;
      const raw = (e as Error).message;
      // fetch() rejects with a TypeError ("Failed to fetch") when the network is down.
      if (e instanceof TypeError) this.d.log(`audio fetch: ${raw}`);
      this.onJobError(job, 'audio', e instanceof TypeError ? '网络连接失败，无法读取音频' : raw);
    } finally {
      if (this.running.get(id) === r) {
        this.running.delete(id);
        this.mark(job, this.pending, false);
      }
      if (!this.stopped) setTimeout(() => this.tick(), 0);
    }
  }

  private async fetchClip(job: Job, signal: AbortSignal) {
    const f = this.fetcher!;
    if (isExpiring(f.track, Math.floor(Date.now() / 1000))) {
      this.d.log('audio URL about to expire, refreshing playurl');
      f.updateTrack(await this.d.refreshTrack());
    }
    try {
      return await f.clipByFragments(job.first, job.last, signal);
    } catch (e) {
      if (!(e instanceof HttpStatusError) || signal.aborted) throw e;
      this.d.log(`audio ${e.message}, refreshing playurl`);
      f.updateTrack(await this.d.refreshTrack());
      return f.clipByFragments(job.first, job.last, signal);
    }
  }

  private onJobError(job: Job, code: ErrorCode | 'audio', message: string): void {
    if (code === 'aborted') return;
    this.d.log(`job ${job.newFirst}-${job.last} failed [${code}]: ${message}`);
    if (FATAL.has(code)) return this.fail(code, message);
    // The background already retried a few times; back off here before replanning this range.
    const n = (this.failures.get(job.newFirst) ?? 0) + 1;
    this.failures.set(job.newFirst, n);
    const wait = Math.min(60, 5 * 2 ** (n - 1));
    this.mark(job, this.blocked, true);
    this.status('retrying', `${message}，${wait} 秒后重试`);
    setTimeout(() => {
      this.mark(job, this.blocked, false);
      this.tick();
    }, wait * 1000);
  }

  private fail(code: ErrorCode | 'audio', message: string): void {
    this.fatal = { code, message };
    for (const r of this.running.values()) this.abort(r);
    this.status('error', message, undefined, code);
  }

  private status(state: SessionState, message: string, bufferedSec = 0, errorCode?: ErrorCode | 'audio'): void {
    const s: SessionStatus = { state, message, bufferedSec, inFlight: this.running.size, cues: this.cues.length, errorCode };
    const k = `${state}|${message}|${s.inFlight}|${s.cues}`;
    if (k === this.lastStatus) return;
    this.lastStatus = k;
    this.d.onStatus(s);
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flushSave(), 2000);
  }

  private flushSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.covered.length) return;
    const rec: TrackRecord = {
      key: this.key, bvid: this.d.info.bvid, cid: this.d.info.cid, model: this.d.settings.model,
      promptVersion: PROMPT_VERSION, cues: this.cues, covered: this.covered, updatedAt: Date.now(),
    };
    void send({ type: 'cache-put', record: rec }).catch((e) => this.d.log('cache write failed', (e as Error).message));
  }
}
