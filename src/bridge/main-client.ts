/** Content-script side of the MAIN world bridge. */
import { TO_CONTENT, TO_MAIN, type ContentToMain, type MainToContent } from './protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class MainBridge {
  private seq = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(m: MainToContent) => void>();

  constructor() {
    document.addEventListener(TO_CONTENT, (ev) => {
      const msg = (ev as CustomEvent<MainToContent>).detail;
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'reply') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? 'main world error'));
        return;
      }
      if (!this.listeners.size) {
        // Nobody listening yet (content script still initialising): keep it for later.
        if (this.backlog.length < 200) this.backlog.push(msg);
        return;
      }
      for (const l of this.listeners) l(msg);
    });
  }

  private backlog: MainToContent[] = [];

  on(fn: (m: MainToContent) => void): () => void {
    this.listeners.add(fn);
    const queued = this.backlog.splice(0);
    for (const m of queued) fn(m);
    return () => this.listeners.delete(fn);
  }

  call<T = unknown>(msg: DistributiveOmit<ContentToMain, 'id'>, timeoutMs = 3000): Promise<T> {
    const id = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`main world did not answer "${msg.kind}" (is the MAIN script injected?)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      document.dispatchEvent(new CustomEvent(TO_MAIN, { detail: { ...msg, id } }));
    });
  }
}
