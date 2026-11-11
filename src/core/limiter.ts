/** Counting semaphore with an adjustable limit. */
export class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private limit: number) {}

  setLimit(n: number): void {
    this.limit = Math.max(1, n);
    this.drain();
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.active--;
      this.drain();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        this.queue = this.queue.filter((q) => q !== go);
        reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(go);
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length) this.queue.shift()!();
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
