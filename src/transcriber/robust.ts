/** Timeouts, retries and error classification around a Transcriber. */
import { sleep } from '../core/limiter';
import type { ErrorCode } from '../bridge/runtime';
import { GeminiError, type AudioPayload, type PromptCtx, type TranscribeResult, type Transcriber } from './types';

export const ATTEMPT_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 4;

export function classify(e: unknown): { code: ErrorCode; retryable: boolean; message: string; status?: number } {
  const err = e as Error & { status?: number };
  if (err?.name === 'AbortError') return { code: 'aborted', retryable: false, message: '已取消' };
  if (err?.name === 'TimeoutError') return { code: 'timeout', retryable: true, message: 'Gemini 请求超时' };
  if (e instanceof GeminiError) {
    const s = e.status;
    const m = e.message;
    if (s === 401 || s === 403 || (s === 400 && /api[_ ]?key/i.test(m))) return { code: 'auth', retryable: false, message: 'API Key 无效或没有权限', status: s };
    if (s === 429) return { code: 'quota', retryable: true, message: '请求太频繁（429），稍后重试', status: s };
    if (s === 0) return { code: 'network', retryable: true, message: '网络错误，无法连接 Gemini', status: s };
    if (s >= 500) return { code: 'server', retryable: true, message: `Gemini 服务端错误（${s}）`, status: s };
    return { code: 'bad-request', retryable: false, message: m.slice(0, 200), status: s };
  }
  return { code: 'internal', retryable: false, message: String(err?.message ?? e) };
}

/** Server hint like "Please retry in 22.2s" (429 bodies). */
export function retryHintMs(e: unknown): number | null {
  const m = /retry in ([\d.]+)\s*s/i.exec((e as Error)?.message ?? '');
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

export async function transcribeRobust(
  t: Transcriber,
  audio: AudioPayload,
  ctx: PromptCtx,
  signal: AbortSignal,
  onRetry?: (attempt: number, waitMs: number, reason: string) => void,
): Promise<TranscribeResult & { attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      const s = AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]);
      const r = await t.transcribe(audio, ctx, s);
      return { ...r, attempts: attempt };
    } catch (e) {
      if (signal.aborted) throw signal.reason ?? e;
      const c = classify(e);
      if (!c.retryable || attempt >= MAX_ATTEMPTS) throw e;
      const wait = Math.min(60_000, (retryHintMs(e) ?? 1000 * 2 ** (attempt - 1)) + Math.random() * 500);
      onRetry?.(attempt, wait, c.message);
      await sleep(wait, signal);
    }
  }
}
