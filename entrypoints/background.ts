/**
 * Service worker: owns the API key, talks to Gemini (concurrency-limited,
 * with timeouts and retries), and keeps the transcript cache.
 * Audio arrives from the content script, which can reach the Bilibili CDN
 * with the page's Origin/Referer.
 */
import type { RuntimeRequest, TranscribeRequest, TranscribeResponse } from '../src/bridge/runtime';
import { Limiter } from '../src/core/limiter';
import { cache } from '../src/store/cache';
import { ApiKeyUnreadableError, loadApiKey, migratePlainApiKey } from '../src/store/secret';
import { getSettings, modelInfo, onSettingsChanged } from '../src/store/settings';
import { DedicatedTranscriber, GenericTranscriber } from '../src/transcriber/gemini';
import { classify, transcribeRobust } from '../src/transcriber/robust';
import type { Transcriber } from '../src/transcriber/types';
import { fromBase64 } from '../src/util/base64';

export default defineBackground(() => {
  void migratePlainApiKey()
    .then((done) => { if (done) console.info('[bilisub] encrypted the API key saved by an older version'); })
    .catch((e) => console.warn('[bilisub] API key migration failed', e));

  const limiter = new Limiter(2);
  void getSettings().then((s) => limiter.setLimit(s.concurrency));
  onSettingsChanged((p) => {
    if (p.concurrency) limiter.setLimit(p.concurrency);
  });

  const jobs = new Map<string, AbortController>();

  function makeTranscriber(apiKey: string, model: string): Transcriber {
    const info = modelInfo(model);
    if (info.kind === 'dedicated') return new DedicatedTranscriber({ apiKey, model, transport: 'inline', wordTimestamp: true });
    return new GenericTranscriber({ apiKey, model, format: 'compact', thinkingLevel: info.thinkingLevel ?? 'LOW' });
  }

  async function transcribe(msg: TranscribeRequest): Promise<TranscribeResponse> {
    const s = await getSettings();
    let apiKey: string;
    try {
      apiKey = await loadApiKey();
    } catch (e) {
      if (!(e instanceof ApiKeyUnreadableError)) throw e;
      console.warn('[bilisub]', e.message, e.cause);
      return { ok: false, code: 'no-key', error: '已保存的 API Key 无法读取，请在设置页重新填写' };
    }
    if (!apiKey) return { ok: false, code: 'no-key', error: '未设置 Gemini API Key' };
    const model = msg.model ?? s.model;
    const ac = new AbortController();
    jobs.set(msg.jobId, ac);
    try {
      return await limiter.run(async () => {
        const r = await transcribeRobust(
          makeTranscriber(apiKey, model),
          { bytes: fromBase64(msg.audio), mimeType: msg.mimeType, duration: msg.duration },
          msg.ctx,
          ac.signal,
          (n, wait, why) => console.warn(`[bilisub] job ${msg.jobId} retry ${n} in ${Math.round(wait)} ms: ${why}`),
        );
        return {
          ok: true as const, cues: r.cues, usage: r.usage, latencyMs: r.latencyMs, attempts: r.attempts, model,
          text: s.debug ? r.text : undefined, raw: s.debug ? r.raw : undefined,
        };
      }, ac.signal);
    } catch (e) {
      const c = classify(ac.signal.aborted ? new DOMException('Aborted', 'AbortError') : e);
      return { ok: false, code: c.code, error: c.message, status: c.status };
    } finally {
      jobs.delete(msg.jobId);
    }
  }

  browser.runtime.onMessage.addListener((msg: RuntimeRequest, _sender, sendResponse) => {
    const reply = (p: Promise<unknown>) => {
      p.then(sendResponse, (e) => sendResponse({ ok: false, code: 'internal', error: String((e as Error)?.message ?? e) }));
      return true;
    };
    switch (msg?.type) {
      case 'ping':
        sendResponse({ ok: true });
        return false;
      case 'transcribe':
        return reply(transcribe(msg));
      case 'abort':
        jobs.get(msg.jobId)?.abort();
        sendResponse({ ok: true });
        return false;
      case 'cache-get':
        return reply(cache.get(msg.key).then((record) => ({ ok: true, record: record ?? null })));
      case 'cache-put':
        return reply(cache.put(msg.record).then(() => ({ ok: true })));
      case 'cache-clear':
        return reply(cache.clear().then(() => ({ ok: true })));
      case 'cache-count':
        return reply(cache.count().then((count) => ({ ok: true, count })));
      case 'open-options':
        return reply(browser.runtime.openOptionsPage().then(() => ({ ok: true })));
      default:
        return false;
    }
  });

  browser.runtime.onInstalled.addListener((d) => {
    if (d.reason === 'install') void browser.runtime.openOptionsPage();
  });
});
