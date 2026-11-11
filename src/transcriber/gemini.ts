/**
 * Gemini transcribers.
 *  - GenericTranscriber: generateContent + prompt (gemini-3.5-flash-lite, gemini-3.8-flash, ...)
 *  - DedicatedTranscriber: gemini-3.5-transcribe via generateContent + audioTranscriptionConfig,
 *    with inline audio or a Files API upload.
 *
 * Requests only carry `x-goog-api-key` and `Content-Type` (extra headers break
 * CORS preflight in browsers), and always send `store: false`.
 */
import { toBase64 } from '../util/base64';
import { parseDuration, wordsToCues, type TimedWord } from '../subs/words';
import { buildPrompt, CUE_SCHEMA, parseCompact, parseJsonCues, type OutputFormat } from './prompt';
import { GeminiError, type AudioPayload, type PromptCtx, type TranscribeResult, type Transcriber, type Usage } from './types';

export const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Send store:false (default true). Set false only to diagnose a 400 about the field. */
  noStore?: boolean;
}

interface GenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean; audioTranscription?: AudioTranscription }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    promptTokensDetails?: Array<{ modality: string; tokenCount: number }>;
  };
  promptFeedback?: { blockReason?: string };
}

interface AudioTranscription {
  words?: Array<{ word?: string; text?: string; startOffset?: string; endOffset?: string; speakerLabel?: string }>;
  text?: string;
}

function usageOf(r: GenerateResponse): Usage | null {
  const u = r.usageMetadata;
  if (!u) return null;
  return {
    promptTokens: u.promptTokenCount ?? 0,
    audioTokens: u.promptTokensDetails?.find((d) => d.modality === 'AUDIO')?.tokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    thoughtsTokens: u.thoughtsTokenCount ?? 0,
  };
}

async function postJson<T>(fetchImpl: FetchLike, url: string, apiKey: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new GeminiError(`network error: ${(e as Error)?.message ?? e}`, 0, null);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message ?? text.slice(0, 300);
    throw new GeminiError(`Gemini ${res.status}: ${msg}`, res.status, json);
  }
  return json as T;
}

function textOf(r: GenerateResponse): string {
  if (r.promptFeedback?.blockReason) throw new GeminiError(`blocked: ${r.promptFeedback.blockReason}`, 400, r);
  return (r.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
}

// ---------------------------------------------------------------------------

export interface GenericOptions extends GeminiOptions {
  format?: OutputFormat;
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
  maxOutputTokens?: number;
}

export class GenericTranscriber implements Transcriber {
  readonly id: string;
  constructor(private o: GenericOptions) {
    this.id = `${o.model}:${o.format ?? 'compact'}`;
  }

  async transcribe(audio: AudioPayload, ctx: PromptCtx, signal?: AbortSignal): Promise<TranscribeResult> {
    const { apiKey, model, baseUrl = DEFAULT_API_BASE, fetchImpl = (u, i) => fetch(u, i), format = 'compact' } = this.o;
    const generationConfig: Record<string, unknown> = {
      thinkingConfig: { thinkingLevel: this.o.thinkingLevel ?? 'MINIMAL' },
      maxOutputTokens: this.o.maxOutputTokens ?? 4096,
    };
    if (format === 'json') {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseJsonSchema = CUE_SCHEMA;
    }
    const body: Record<string, unknown> = {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: audio.mimeType, data: toBase64(audio.bytes) } },
          { text: buildPrompt(ctx, audio.duration, format) },
        ],
      }],
      generationConfig,
    };
    if (this.o.noStore !== false) body.store = false;

    const t0 = Date.now();
    const raw = await postJson<GenerateResponse>(fetchImpl, `${baseUrl}/v1beta/models/${model}:generateContent`, apiKey, body, signal);
    const latencyMs = Date.now() - t0;
    const text = textOf(raw);
    const cues = format === 'json' ? (text.trim() ? parseJsonCues(text) : []) : parseCompact(text);
    return { cues, usage: usageOf(raw), raw, text, latencyMs };
  }
}

// ---------------------------------------------------------------------------

export interface DedicatedOptions extends GeminiOptions {
  /** 'inline' = base64 inlineData; 'files' = Files API upload, then fileData. */
  transport: 'inline' | 'files';
  wordTimestamp?: boolean;
  /** Cannot be combined with wordTimestamp (API rejects it). */
  customVocabulary?: string[];
  languageCodes?: string[];
}

interface UploadedFile {
  file?: { name: string; uri: string; mimeType?: string; state?: string };
}

export class DedicatedTranscriber implements Transcriber {
  readonly id: string;
  /** Timings of the last call, for latency analysis. */
  lastTimings: { uploadMs?: number; generateMs?: number; deleteMs?: number } = {};

  constructor(private o: DedicatedOptions) {
    this.id = `${o.model}:${o.transport}:${o.wordTimestamp ? 'words' : o.customVocabulary?.length ? 'vocab' : 'plain'}`;
    if (o.wordTimestamp && o.customVocabulary?.length) throw new Error('wordTimestamp and customVocabulary are mutually exclusive');
  }

  private get f(): FetchLike {
    return this.o.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  private get base(): string {
    return this.o.baseUrl ?? DEFAULT_API_BASE;
  }

  /** Resumable upload (two requests). Returns the file resource. */
  async upload(audio: AudioPayload, signal?: AbortSignal): Promise<{ name: string; uri: string }> {
    const start = await this.f(`${this.base}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.o.apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(audio.bytes.byteLength),
        'X-Goog-Upload-Header-Content-Type': audio.mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: `bilisub-${Date.now()}` } }),
      signal,
    });
    if (!start.ok) throw new GeminiError(`upload start ${start.status}: ${(await start.text()).slice(0, 300)}`, start.status, null);
    const url = start.headers.get('x-goog-upload-url');
    if (!url) throw new GeminiError('upload start: no x-goog-upload-url header', 500, null);
    const up = await this.f(url, {
      method: 'POST',
      headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
      body: audio.bytes as BodyInit,
      signal,
    });
    const json = (await up.json()) as UploadedFile;
    if (!up.ok || !json.file?.uri) throw new GeminiError(`upload ${up.status}`, up.status, json);
    return { name: json.file.name, uri: json.file.uri };
  }

  async deleteFile(name: string): Promise<void> {
    await this.f(`${this.base}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': this.o.apiKey } }).catch(() => undefined);
  }

  async transcribe(audio: AudioPayload, _ctx: PromptCtx, signal?: AbortSignal): Promise<TranscribeResult> {
    this.lastTimings = {};
    const t0 = Date.now();
    let file: { name: string; uri: string } | undefined;
    let part: unknown;
    if (this.o.transport === 'files') {
      file = await this.upload(audio, signal);
      this.lastTimings.uploadMs = Date.now() - t0;
      part = { fileData: { mimeType: audio.mimeType, fileUri: file.uri } };
    } else {
      part = { inlineData: { mimeType: audio.mimeType, data: toBase64(audio.bytes) } };
    }

    const audioTranscriptionConfig: Record<string, unknown> = {
      languageCodes: this.o.languageCodes ?? ['cmn-Hans-CN'],
    };
    if (this.o.wordTimestamp) audioTranscriptionConfig.wordTimestamp = true;
    if (this.o.customVocabulary?.length) audioTranscriptionConfig.customVocabulary = this.o.customVocabulary.slice(0, 1000);
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [part] }],
      generationConfig: { audioTranscriptionConfig },
    };
    if (this.o.noStore !== false) body.store = false;

    const t1 = Date.now();
    let raw: GenerateResponse;
    try {
      raw = await postJson<GenerateResponse>(this.f, `${this.base}/v1beta/models/${this.o.model}:generateContent`, this.o.apiKey, body, signal);
    } finally {
      this.lastTimings.generateMs = Date.now() - t1;
      if (file) {
        const t2 = Date.now();
        await this.deleteFile(file.name);
        this.lastTimings.deleteMs = Date.now() - t2;
      }
    }
    const latencyMs = Date.now() - t0;

    const parts = raw.candidates?.[0]?.content?.parts ?? [];
    const words: TimedWord[] = [];
    for (const p of parts) {
      for (const w of p.audioTranscription?.words ?? []) {
        const word = w.word ?? w.text ?? '';
        const start = parseDuration(w.startOffset);
        const end = parseDuration(w.endOffset);
        if (word && Number.isFinite(start) && Number.isFinite(end)) words.push({ word, start, end });
      }
    }
    const text = parts.map((p) => p.text ?? p.audioTranscription?.text ?? '').join('');
    // Without word timestamps there is no timing; the caller aligns plain text to the clip.
    const cues = words.length ? wordsToCues(words) : [];
    return { cues, usage: usageOf(raw), raw, text, latencyMs };
  }
}
