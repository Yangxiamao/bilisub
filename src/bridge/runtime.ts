/** content script / popup / options <-> background messages (chrome.runtime). */
import type { TrackRecord } from '../store/cache';
import type { Cue, PromptCtx, Usage } from '../transcriber/types';

export type ErrorCode = 'no-key' | 'auth' | 'quota' | 'timeout' | 'network' | 'server' | 'bad-request' | 'aborted' | 'internal';

export interface TranscribeRequest {
  type: 'transcribe';
  jobId: string;
  /** base64 audio */
  audio: string;
  mimeType: string;
  duration: number;
  ctx: PromptCtx;
  /** Overrides settings.model (debug). */
  model?: string;
}

export type TranscribeResponse =
  | { ok: true; cues: Cue[]; usage: Usage | null; latencyMs: number; attempts: number; model: string; text?: string; raw?: unknown }
  | { ok: false; code: ErrorCode; error: string; status?: number };

export type RuntimeRequest =
  | TranscribeRequest
  | { type: 'abort'; jobId: string }
  | { type: 'cache-get'; key: string }
  | { type: 'cache-put'; record: TrackRecord }
  | { type: 'cache-clear' }
  | { type: 'cache-count' }
  | { type: 'open-options' }
  | { type: 'ping' };

/** Messages the popup sends to the content script of the active tab. */
export type TabRequest = { type: 'tab-status' } | { type: 'tab-toggle' };

export interface TabStatus {
  supported: boolean;
  active: boolean;
  state: string;
  detail?: string;
  bvid?: string;
  cid?: number;
  bufferedSec?: number;
  hasOfficialSubs?: boolean;
}

export async function send<T = unknown>(msg: RuntimeRequest): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>;
}
