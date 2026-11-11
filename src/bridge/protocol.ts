/**
 * MAIN world <-> isolated content script messages, carried as CustomEvents on
 * `document` (both worlds share the DOM). `detail` is structured-cloned.
 */
import type { Cue } from '../transcriber/types';
import type { PlayUrlData } from '../bili/playinfo';

export const TO_CONTENT = 'bilisub:to-content';
export const TO_MAIN = 'bilisub:to-main';

export interface VideoInfo {
  bvid?: string;
  aid?: number;
  cid?: number;
  p?: number;
  title?: string;
  desc?: string;
  tags?: string[];
}

export interface OfficialSubtitle {
  lan: string;
  lan_doc: string;
  /** 0 = uploader CC, 1 = AI (as seen in player responses). */
  type?: number;
}

export type MainToContent =
  | { kind: 'hello'; at: number }
  | { kind: 'playurl'; source: 'xhr' | 'fetch' | '__playinfo__' | 'refresh'; url?: string; cid?: number; bvid?: string; data: PlayUrlData }
  | { kind: 'video'; info: VideoInfo }
  | { kind: 'player-info'; cid?: number; subtitles: OfficialSubtitle[]; needLoginSubtitle?: boolean }
  | { kind: 'subtitle-list'; url: string; bytes: number }
  | { kind: 'reply'; id: number; ok: boolean; result?: unknown; error?: string };

export type ContentToMain =
  | { kind: 'probe'; id: number }
  | { kind: 'add-subtitle'; id: number; body: Cue[] }
  | { kind: 'video-info'; id: number }
  | { kind: 'refresh-playurl'; id: number; bvid?: string; cid: number };
