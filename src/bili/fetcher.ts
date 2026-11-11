/**
 * Range-based audio fetching for a Bilibili DASH audio track.
 *
 * Must run where requests carry a bilibili.com Origin/Referer (content script
 * or page). Node eval scripts pass a custom fetch that adds the Referer header.
 */
import type { AudioTrack } from './playinfo';
import { concatBytes, extractAacFrames, parseAacConfig, parseSidx, rebaseFragments, spanForFragments, spanForTime, toAdts } from './mp4';
import type { AacConfig, FragmentSpan, SegmentIndex } from './mp4';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpStatusError extends Error {
  constructor(public status: number, public url: string) {
    super(`HTTP ${status} for ${new URL(url).hostname}`);
  }
}

export interface TrackInfo {
  init: Uint8Array;
  index: SegmentIndex;
  aac: AacConfig;
}

export interface AudioClip {
  span: FragmentSpan;
  /** init + (moof mdat)* with decode times rebased to 0 — a valid fragmented MP4 file starting at span.start. */
  fmp4: Uint8Array;
  /** Lazily built ADTS stream of the same samples. */
  adts(): Uint8Array;
}

export class TrackFetcher {
  private urlIdx = 0;
  info?: TrackInfo;

  constructor(
    public track: AudioTrack,
    private fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {}

  private async range(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    let lastErr: unknown;
    // Try every candidate URL once, starting from the last one that worked.
    for (let n = 0; n < this.track.urls.length; n++) {
      const idx = (this.urlIdx + n) % this.track.urls.length;
      const url = this.track.urls[idx];
      try {
        const res = await this.fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` }, signal, credentials: 'omit' });
        if (res.status !== 206 && res.status !== 200) throw new HttpStatusError(res.status, url);
        let buf = new Uint8Array(await res.arrayBuffer());
        if (res.status === 200) buf = buf.subarray(start, end + 1); // server ignored Range
        if (buf.byteLength !== end - start + 1) throw new Error(`short read ${buf.byteLength}/${end - start + 1}`);
        this.urlIdx = idx;
        return buf;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
        if (cause && e instanceof Error && !(e instanceof HttpStatusError)) {
          e.message = `${e.message} (${cause.code ?? cause.message ?? 'unknown cause'}, ${new URL(url).hostname})`;
        }
        // Prefer reporting an HTTP status (actionable: refresh playurl) over a network error.
        if (!(lastErr instanceof HttpStatusError)) lastErr = e;
      }
    }
    throw lastErr;
  }

  /** Swap in fresh URLs (after expiry / 403) for the same stream; keeps the parsed index. */
  updateTrack(track: AudioTrack): void {
    if (track.id !== this.track.id || track.index[1] !== this.track.index[1]) this.info = undefined;
    this.track = track;
    this.urlIdx = 0;
  }

  async load(signal?: AbortSignal): Promise<TrackInfo> {
    if (this.info) return this.info;
    const [i0, i1] = this.track.init;
    const [x0, x1] = this.track.index;
    // init and sidx are adjacent on Bilibili; one request when possible.
    let init: Uint8Array;
    let sidx: Uint8Array;
    if (x0 === i1 + 1) {
      const both = await this.range(i0, x1, signal);
      init = both.subarray(0, i1 - i0 + 1);
      sidx = both.subarray(x0 - i0);
    } else {
      [init, sidx] = await Promise.all([this.range(i0, i1, signal), this.range(x0, x1, signal)]);
    }
    this.info = { init, index: parseSidx(sidx, x0), aac: parseAacConfig(init) };
    return this.info;
  }

  async clipByFragments(first: number, last: number, signal?: AbortSignal): Promise<AudioClip> {
    const info = await this.load(signal);
    return this.fetchSpan(info, spanForFragments(info.index, first, last), signal);
  }

  async clipByTime(startSec: number, endSec: number, signal?: AbortSignal): Promise<AudioClip> {
    const info = await this.load(signal);
    return this.fetchSpan(info, spanForTime(info.index, startSec, endSec), signal);
  }

  private async fetchSpan(info: TrackInfo, span: FragmentSpan, signal?: AbortSignal): Promise<AudioClip> {
    const media = await this.range(span.byteStart, span.byteEnd, signal);
    let adts: Uint8Array | undefined;
    return {
      span,
      fmp4: concatBytes(info.init, rebaseFragments(media)),
      adts: () => (adts ??= toAdts(info.aac, extractAacFrames(media))),
    };
  }
}
