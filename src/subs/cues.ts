/**
 * Cue post-processing: cleanup, splitting long lines, merging overlapping
 * chunks. All pure; times in seconds.
 */
import type { Cue } from '../transcriber/types';
import { toSimplified } from './t2s';

export const MAX_CHARS = 20;
const MIN_DURATION = 0.4;

/** Sound-effect style annotations the model sometimes emits despite the prompt. */
const ANNOTATION_RE = /[\[［【(（](?:笑声?|笑|音乐|背景音乐|BGM|bgm|音效|炮火声?|枪声|爆炸声?|掌声|叹气|咳嗽|无人声|听不清|静音|噪音|杂音|[^\]］】)）]{0,6}声)[\]］】)）]/g;

/** Visible length; ASCII words count roughly half a CJK character. */
export function displayLength(s: string): number {
  let n = 0;
  for (const ch of s) n += /[\x00-\x7f]/.test(ch) ? 0.5 : 1;
  return n;
}

export function cleanText(s: string): string {
  return toSimplified(s)
    .replace(ANNOTATION_RE, '')
    .replace(/\s+/g, ' ')
    .replace(/[。．.]+$/u, '') // drop sentence-final full stop (Bilibili AI subtitle style)
    .replace(/^[，,、\s]+/, '')
    .trim();
}

/** Clamp to [0, clipDuration], clean text, drop empties, fix inverted/zero-length cues. */
export function sanitize(cues: Cue[], clipDuration: number): Cue[] {
  const out: Cue[] = [];
  for (const c of [...cues].sort((a, b) => a.from - b.from)) {
    const content = cleanText(c.content);
    if (!content) continue;
    let from = Math.max(0, Math.min(c.from, clipDuration));
    let to = Math.max(0, Math.min(c.to, clipDuration));
    if (to < from) [from, to] = [to, from];
    if (to - from < MIN_DURATION) to = Math.min(clipDuration, from + Math.max(MIN_DURATION, displayLength(content) * 0.2));
    if (to <= from) continue;
    out.push({ from, to, content });
  }
  return out;
}

/** Split text at punctuation into pieces of at most `max` display chars. */
export function splitText(text: string, max = MAX_CHARS): string[] {
  if (displayLength(text) <= max) return [text];
  // break after soft punctuation, keeping it attached to the left piece
  const parts = text.split(/(?<=[，,、；;：:？?！!…])/u).map((s) => s.trim()).filter(Boolean);
  const pieces: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur && displayLength(cur + p) > max) {
      pieces.push(cur);
      cur = '';
    }
    if (displayLength(p) > max) {
      // hard split long runs without punctuation, avoiding cutting ASCII words
      const tokens = p.match(/[A-Za-z0-9'’\-.]+|\s+|./gu) ?? [p];
      for (const t of tokens) {
        if (cur && displayLength(cur + t) > max) {
          pieces.push(cur.trim());
          cur = '';
        }
        cur += t;
      }
    } else {
      cur += p;
    }
  }
  if (cur.trim()) pieces.push(cur.trim());
  return pieces.map((s) => s.replace(/[，,、；;：:]$/u, '')).filter(Boolean);
}

/** Split long cues, distributing time proportionally to display length. */
export function splitLong(cues: Cue[], max = MAX_CHARS): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    const pieces = splitText(c.content, max);
    if (pieces.length === 1) {
      out.push({ ...c, content: pieces[0] });
      continue;
    }
    const total = pieces.reduce((n, p) => n + displayLength(p), 0);
    let t = c.from;
    pieces.forEach((p, i) => {
      const to = i === pieces.length - 1 ? c.to : t + ((c.to - c.from) * displayLength(p)) / total;
      out.push({ from: t, to, content: p });
      t = to;
    });
  }
  return out;
}

export function shift(cues: Cue[], offset: number): Cue[] {
  return cues.map((c) => ({ ...c, from: c.from + offset, to: c.to + offset }));
}

function bigrams(s: string): Map<string, number> {
  const t = s.replace(/[\s，,。.、？?！!…；;：:"“”'‘’]/gu, '');
  const m = new Map<string, number>();
  const chars = [...t];
  if (chars.length === 1) m.set(chars[0], 1);
  for (let i = 0; i + 1 < chars.length; i++) {
    const k = chars[i] + chars[i + 1];
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient on character bigrams, 0..1. */
export function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let na = 0;
  let nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  if (!na || !nb) return 0;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return (2 * inter) / (na + nb);
}

/** True if b's text is (mostly) contained in a's or vice versa. */
function contained(a: string, b: string): boolean {
  const x = a.replace(/[\s，,。.、？?！!…]/gu, '');
  const y = b.replace(/[\s，,。.、？?！!…]/gu, '');
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

function overlaps(a: Cue, b: Cue, slack = 0.5): boolean {
  return a.from < b.to + slack && b.from < a.to + slack;
}

function overlapRatio(a: Cue, b: Cue): number {
  const inter = Math.min(a.to, b.to) - Math.max(a.from, b.from);
  return inter <= 0 ? 0 : inter / Math.min(a.to - a.from, b.to - b.from);
}

/**
 * Merge cues from a newly transcribed chunk into an existing (sorted,
 * absolute-time) track. Both inputs are absolute-time.
 *
 * Adjacent chunks overlap by about one fragment ([ovStart, ovEnd]); speech in
 * that window is heard twice, and either copy may be cut off at a chunk edge.
 *  1. Same text heard twice (similar / contained, overlapping in time):
 *     keep the longer text, which is the copy that wasn't truncated.
 *  2. Different texts competing for the same time inside the overlap: the
 *     chunk that heard it further from its own edge wins, i.e. the earlier
 *     chunk before the overlap midpoint, the newer chunk after it.
 *  3. Otherwise both are kept.
 */
export interface OverlapWindow {
  start: number;
  end: number;
  /** True if the incoming chunk is the later of the two chunks sharing this window. */
  incomingIsLater: boolean;
}

export function mergeChunk(existing: Cue[], incoming: Cue[], ovStart?: number, ovEnd?: number, incomingIsLater = true): Cue[] {
  const windows = ovStart != null && ovEnd != null && ovEnd > ovStart ? [{ start: ovStart, end: ovEnd, incomingIsLater }] : [];
  return mergeChunkWindows(existing, incoming, windows);
}

/**
 * True if `c`'s text appears inside the joined text of two or more cues in
 * `others` that overlap it in time. Catches a phrase that one chunk heard
 * whole and the other chunk's long line was split across (seen in Chrome
 * 2026-11-11: "我这边我也不知道能打多久" vs "…我这边我也不" + "知道能打多久，…").
 */
function containedInRun(c: Cue, others: Cue[]): boolean {
  const run = others.filter((o) => overlaps(o, c)).sort((a, b) => a.from - b.from);
  if (run.length < 2) return false;
  const norm = (s: string) => s.replace(/[\s，,。.、？?！!…；;：:]/gu, '');
  const y = norm(c.content);
  return [...y].length >= 2 && norm(run.map((o) => o.content).join('')).includes(y);
}

export function mergeChunkWindows(existing: Cue[], incoming: Cue[], windows: OverlapWindow[]): Cue[] {
  const mid = (c: Cue) => (c.from + c.to) / 2;

  // Only at chunk seams: elsewhere a short phrase can legitimately repeat.
  const atSeam = (c: Cue) => windows.some((w) => c.from < w.end && c.to > w.start);
  // Existing cues whose text the incoming chunk carries across several of its own cues.
  const merged = existing.filter((o) => !(atSeam(o) && containedInRun(o, incoming))).map((c) => ({ ...c }));
  for (const c of incoming) {
    if (atSeam(c) && containedInRun(c, merged)) continue;
    const dupIdx = merged.findIndex((o) => overlaps(o, c) && (similarity(o.content, c.content) >= 0.6 || contained(o.content, c.content)));
    if (dupIdx >= 0) {
      const o = merged[dupIdx];
      if (displayLength(c.content) > displayLength(o.content)) {
        merged[dupIdx] = { from: Math.min(o.from, c.from), to: Math.max(o.to, c.to), content: c.content };
      }
      continue;
    }
    const w = windows.find((x) => c.from < x.end && c.to > x.start);
    if (w) {
      const rivals = merged.filter((o) => o.to > w.start && o.from < w.end && overlapRatio(o, c) > 0.5);
      if (rivals.length) {
        // The earlier chunk owns the first half of the overlap, the later chunk the second half.
        const cut = (w.start + w.end) / 2;
        const incomingOwns = w.incomingIsLater ? mid(c) >= cut : mid(c) < cut;
        if (!incomingOwns) continue;
        for (const r of rivals) merged.splice(merged.indexOf(r), 1);
      }
    }
    merged.push(c);
  }
  merged.sort((a, b) => a.from - b.from || a.to - b.to);
  // Remove time overlaps between consecutive cues (renderer shows one major line at a time).
  for (let i = 1; i < merged.length; i++) {
    const p = merged[i - 1];
    const c = merged[i];
    if (c.from < p.to) p.to = Math.max(p.from + 0.2, c.from);
  }
  return merged;
}
