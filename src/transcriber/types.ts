/** A subtitle cue. Same shape as Bilibili's BCC `body[]` items. Seconds. */
export interface Cue {
  from: number;
  to: number;
  content: string;
}

export interface AudioPayload {
  bytes: Uint8Array;
  mimeType: string;
  /** Clip duration in seconds. */
  duration: number;
}

export interface PromptCtx {
  title?: string;
  tags?: string[];
  desc?: string;
}

export interface Usage {
  promptTokens: number;
  audioTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
}

export interface TranscribeResult {
  /** Cues relative to the clip start (0 = first sample of the clip). */
  cues: Cue[];
  usage: Usage | null;
  /** Raw API response (debug export; never contains the key). */
  raw: unknown;
  /** Model text before parsing, if any. */
  text?: string;
  latencyMs: number;
}

export interface Transcriber {
  readonly id: string;
  transcribe(audio: AudioPayload, ctx: PromptCtx, signal?: AbortSignal): Promise<TranscribeResult>;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
  /** 429 / 5xx / network-ish: worth retrying with backoff. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}
