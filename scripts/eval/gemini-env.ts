import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function apiKey(): string {
  const k = process.env.GEMINI_API_KEY?.trim();
  if (!k) {
    console.error('GEMINI_API_KEY is not set. Copy .env.example to .env and fill it in.');
    process.exit(2);
  }
  return k;
}

/** USD per 1M tokens (paid Standard tier, checked 2026-11-11 on aistudio.google.com/docs/pricing). */
export const PRICES: Record<string, { in: number; audioIn: number; out: number }> = {
  'gemini-3.5-flash-lite': { in: 0.3, audioIn: 0.3, out: 2.5 },
  'gemini-3.8-flash': { in: 0.75, audioIn: 0.75, out: 3.75 }, // doubles on 2027-01-01
  'gemini-3.6-flash': { in: 0.75, audioIn: 0.75, out: 3.75 },
  'gemini-3.5-transcribe': { in: 2.0, audioIn: 2.0, out: 12.0 },
};

export function costUsd(model: string, u: { promptTokens: number; audioTokens: number; outputTokens: number; thoughtsTokens: number } | null): number | null {
  const p = PRICES[model];
  if (!p || !u) return null;
  const text = Math.max(0, u.promptTokens - u.audioTokens);
  return (text * p.in + u.audioTokens * p.audioIn + (u.outputTokens + u.thoughtsTokens) * p.out) / 1e6;
}

/** Decode any audio to 16 kHz mono 16-bit WAV with ffmpeg (stand-in for the browser's decodeAudioData path). */
export function toWav16k(bytes: Uint8Array, ext: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'bilisub-'));
  try {
    const inp = join(dir, `in.${ext}`);
    const outp = join(dir, 'out.wav');
    writeFileSync(inp, bytes);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', inp, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outp]);
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
    return new Uint8Array(readFileSync(outp));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
