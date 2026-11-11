import type { Cue } from '../transcriber/types';
import { cleanText, displayLength, MAX_CHARS } from './cues';

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

const HARD_PUNCT = /[。？?！!…]$/u;
const SOFT_PUNCT = /[，,、；;：:]$/u;

/**
 * Group word-level timestamps into subtitle cues: break on sentence
 * punctuation, long pauses, or when the line would exceed `max` chars.
 */
export function wordsToCues(words: TimedWord[], max = MAX_CHARS, pause = 0.6): Cue[] {
  const cues: Cue[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    const content = cleanText(joinWords(cur.map((w) => w.word)).replace(/[，,、；;：:]$/u, ''));
    if (content) cues.push({ from: cur[0].start, to: cur[cur.length - 1].end, content });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > pause || displayLength(joinWords([...cur, w].map((x) => x.word))) > max)) flush();
    cur.push(w);
    if (HARD_PUNCT.test(w.word)) flush();
    else if (SOFT_PUNCT.test(w.word) && displayLength(joinWords(cur.map((x) => x.word))) >= max * 0.6) flush();
  }
  flush();
  return cues;
}

/** Join tokens: no space between CJK, a space between Latin words. */
export function joinWords(tokens: string[]): string {
  let s = '';
  for (const t of tokens) {
    const tok = t.trim();
    if (!tok) continue;
    if (s && /[A-Za-z0-9]$/.test(s) && /^[A-Za-z0-9]/.test(tok)) s += ' ';
    s += tok;
  }
  return s;
}

/** "0.100s" -> 0.1 */
export function parseDuration(s: string | number | undefined): number {
  if (typeof s === 'number') return s;
  if (!s) return NaN;
  return Number(String(s).replace(/s$/, ''));
}
