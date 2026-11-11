/** Shared helpers for Phase-0 eval scripts (Node only). */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickAudioTrack, unwrapPlayUrl } from '../../src/bili/playinfo';
import { TrackFetcher } from '../../src/bili/fetcher';

export const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
export const TEST_BVID = 'BV1VXGL6KE9D';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const BILI_HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com' };

export function out(name: string, data: string | Uint8Array): string {
  const p = join(OUT, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
}

/** fetch that looks like it came from a bilibili.com page (what a content script gets for free). */
export const biliFetch = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...BILI_HEADERS, ...(init.headers as Record<string, string>) } });

export interface VideoMeta {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  desc: string;
  tags: string[];
  duration: number;
}

export async function videoMeta(bvid = TEST_BVID, page = 1): Promise<VideoMeta> {
  // /x/web-interface/view answers 412 (risk control) to cookie-less clients, so
  // read the SSR state from the video page, the same data the extension sees.
  const html = await (await biliFetch(`https://www.bilibili.com/video/${bvid}/`)).text();
  const m = /window\.__INITIAL_STATE__=(\{.*?\});\(function/s.exec(html);
  if (!m) throw new Error('__INITIAL_STATE__ not found in video page');
  const d = JSON.parse(m[1]).videoData;
  const p = d.pages[page - 1] ?? d.pages[0];
  let tags: string[] = [];
  try {
    const t = await (await biliFetch(`https://api.bilibili.com/x/tag/archive/tags?bvid=${bvid}`)).json();
    tags = (t.data ?? []).map((x: { tag_name: string }) => x.tag_name);
  } catch {
    /* tags are optional */
  }
  return { bvid, aid: d.aid, cid: p.cid, title: d.title, desc: d.desc ?? '', tags, duration: p.duration };
}

export async function trackFetcher(meta: VideoMeta): Promise<TrackFetcher> {
  // Unsigned playurl works anonymously (verified 2026-11-11). The extension uses the player's own response instead.
  const r = await (await biliFetch(`https://api.bilibili.com/x/player/playurl?bvid=${meta.bvid}&cid=${meta.cid}&fnval=16&fnver=0&fourk=1`)).json();
  const data = unwrapPlayUrl(r);
  if (!data) throw new Error(`playurl: ${r.code} ${r.message}`);
  const track = pickAudioTrack(data);
  if (!track) throw new Error('no AAC track');
  return new TrackFetcher(track, biliFetch);
}

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

export function parseTime(s: string): number {
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}
