import { describe, expect, it } from 'vitest';
import { Limiter } from '../src/core/limiter';
import { classify, retryHintMs, transcribeRobust } from '../src/transcriber/robust';
import { GeminiError, type Transcriber } from '../src/transcriber/types';

describe('classify', () => {
  it('maps API errors', () => {
    expect(classify(new GeminiError('Gemini 400: API key not valid. Please pass a valid API key.', 400, null)).code).toBe('auth');
    expect(classify(new GeminiError('x', 403, null)).code).toBe('auth');
    expect(classify(new GeminiError('x', 429, null))).toMatchObject({ code: 'quota', retryable: true });
    expect(classify(new GeminiError('x', 503, null))).toMatchObject({ code: 'server', retryable: true });
    expect(classify(new GeminiError('x', 0, null))).toMatchObject({ code: 'network', retryable: true });
    expect(classify(new GeminiError('Thinking level MINIMAL is not supported', 400, null))).toMatchObject({ code: 'bad-request', retryable: false });
    expect(classify(new DOMException('t', 'TimeoutError'))).toMatchObject({ code: 'timeout', retryable: true });
    expect(classify(new DOMException('a', 'AbortError')).code).toBe('aborted');
  });

  it('reads retry hints', () => {
    expect(retryHintMs(new Error('Please retry in 22.226171119s.'))).toBe(22227);
    expect(retryHintMs(new Error('nope'))).toBeNull();
  });
});

describe('transcribeRobust', () => {
  const audio = { bytes: new Uint8Array(1), mimeType: 'audio/mp4', duration: 1 };

  it('retries retryable errors then succeeds', async () => {
    let n = 0;
    const t: Transcriber = {
      id: 'fake',
      async transcribe() {
        n++;
        if (n < 2) throw new GeminiError('busy', 503, null);
        return { cues: [], usage: null, raw: null, latencyMs: 1 };
      },
    };
    const r = await transcribeRobust(t, audio, {}, new AbortController().signal);
    expect(r.attempts).toBe(2);
  });

  it('does not retry fatal errors', async () => {
    let n = 0;
    const t: Transcriber = { id: 'fake', async transcribe() { n++; throw new GeminiError('bad key', 401, null); } };
    await expect(transcribeRobust(t, audio, {}, new AbortController().signal)).rejects.toThrow('bad key');
    expect(n).toBe(1);
  });
});

describe('Limiter', () => {
  it('caps concurrency', async () => {
    const l = new Limiter(2);
    let active = 0;
    let peak = 0;
    const task = () => l.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it('removes aborted waiters', async () => {
    const l = new Limiter(1);
    let release!: () => void;
    const first = l.run(() => new Promise<void>((r) => { release = r; }));
    const ac = new AbortController();
    const second = l.run(async () => 'ran', ac.signal);
    ac.abort();
    await expect(second).rejects.toBeTruthy();
    release();
    await first;
    expect(await l.run(async () => 'ok')).toBe('ok');
  });
});
