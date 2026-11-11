/** Types and helpers for Bilibili playurl (DASH) responses. */

export interface DashAudio {
  id: number;
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[] | null;
  backup_url?: string[] | null;
  bandwidth: number;
  mimeType?: string;
  mime_type?: string;
  codecs: string;
  segment_base?: { initialization: string; index_range: string };
  SegmentBase?: { Initialization: string; indexRange: string };
}

export interface PlayUrlData {
  timelength?: number;
  dash?: {
    duration: number;
    audio?: DashAudio[] | null;
    dolby?: { audio?: DashAudio[] | null } | null;
    flac?: { audio?: DashAudio | null } | null;
  } | null;
}

export interface AudioTrack {
  id: number;
  bandwidth: number;
  codecs: string;
  /** Candidate URLs, best first. */
  urls: string[];
  /** Inclusive byte ranges. */
  init: [number, number];
  index: [number, number];
  /** Earliest `deadline`-style expiry among urls (unix seconds), if any. */
  expiresAt: number | null;
}

function parseRange(s: string): [number, number] {
  const m = /^(\d+)-(\d+)$/.exec(s.trim());
  if (!m) throw new Error(`bad byte range "${s}"`);
  return [Number(m[1]), Number(m[2])];
}

/** Accept either `{code,data}` envelopes or bare data (window.__playinfo__ is an envelope). */
export function unwrapPlayUrl(json: unknown): PlayUrlData | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if ('code' in o) {
    if (o.code !== 0) return null;
    return (o.data ?? o.result ?? null) as PlayUrlData | null;
  }
  return o as PlayUrlData;
}

/** Expiry param used by Bilibili CDNs (mirrors the player's own check). */
export function urlExpiry(url: string): number | null {
  try {
    const q = new URL(url, 'https://x.invalid').searchParams;
    for (const k of ['deadline', 'expires', 'wsTime', 'txTime', 'um_deadline']) {
      const v = q.get(k);
      if (v && /^\d+$/.test(v)) return Number(v);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Host preference: regular upos / akamai mirrors first; PCDN-style hosts
 * (mcdn, :4483/:8082 ports, raw IPs) last because they are flaky and often
 * reject cross-origin Range requests.
 */
export function hostScore(url: string): number {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 99;
  }
  const h = u.hostname;
  if (u.port && u.port !== '443') return 50;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return 50;
  if (h.includes('mcdn') || h.includes('szbdyd')) return 40;
  // Keep the server's own order among regular upos hosts (it already picks by region).
  if (h.startsWith('upos-')) return 0;
  return 20;
}

/** Pick the lowest-bitrate AAC track (ignores Dolby / FLAC). */
export function pickAudioTrack(data: PlayUrlData): AudioTrack | null {
  const list = (data.dash?.audio ?? []).filter((a) => /^mp4a/.test(a.codecs));
  if (!list.length) return null;
  const a = [...list].sort((x, y) => x.bandwidth - y.bandwidth)[0];
  const sb = a.segment_base ?? (a.SegmentBase ? { initialization: a.SegmentBase.Initialization, index_range: a.SegmentBase.indexRange } : undefined);
  if (!sb) return null;
  const raw = [a.baseUrl ?? a.base_url, ...(a.backupUrl ?? a.backup_url ?? [])].filter((u): u is string => !!u);
  const urls = [...new Set(raw.map((u) => u.replace(/^http:/, 'https:')))]
    .map((u, i) => ({ u, i, s: hostScore(u) }))
    .sort((x, y) => x.s - y.s || x.i - y.i)
    .map((x) => x.u);
  const exps = urls.map(urlExpiry).filter((x): x is number => x != null);
  return {
    id: a.id,
    bandwidth: a.bandwidth,
    codecs: a.codecs,
    urls,
    init: parseRange(sb.initialization),
    index: parseRange(sb.index_range),
    expiresAt: exps.length ? Math.min(...exps) : null,
  };
}

/** True if the track's URLs expire within `marginSec`. */
export function isExpiring(track: AudioTrack, nowSec: number, marginSec = 300): boolean {
  return track.expiresAt != null && track.expiresAt - nowSec < marginSec;
}
