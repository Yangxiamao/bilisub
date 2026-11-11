/**
 * Subtitle renderers.
 *  - OfficialRenderer: the player's own subtitle module via window.player.addSubtitle
 *    (official styles, settings and fullscreen for free).
 *  - OverlayRenderer: plan B, our own element inside the player container,
 *    styled like Bilibili subtitles and driven by requestAnimationFrame.
 */
import type { MainBridge } from '../bridge/main-client';
import type { Cue } from '../transcriber/types';

export interface Renderer {
  readonly kind: 'official' | 'overlay' | 'auto';
  setCues(cues: Cue[]): void;
  clear(): void;
  destroy(): void;
}

export class OfficialRenderer implements Renderer {
  readonly kind = 'official' as const;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest: Cue[] = [];
  private lastSentAt = 0;
  onError?: (e: Error) => void;

  constructor(private bridge: MainBridge, private minIntervalMs = 400) {}

  setCues(cues: Cue[]): void {
    this.latest = cues;
    if (this.timer) return;
    const wait = Math.max(0, this.lastSentAt + this.minIntervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.lastSentAt = Date.now();
      this.bridge.call({ kind: 'add-subtitle', body: this.latest }).catch((e: Error) => this.onError?.(e));
    }, wait);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.latest = [];
    this.bridge.call({ kind: 'add-subtitle', body: [] }).catch(() => undefined);
  }

  destroy(): void {
    this.clear();
  }
}

/**
 * Official renderer that permanently falls back to the overlay when the
 * player API throws, when the player's subtitle layer is hidden, or when a cue
 * that should be on screen isn't visible in it on two consecutive checks.
 */
export class FallbackRenderer implements Renderer {
  readonly kind = 'auto' as const;
  private inner: Renderer;
  private cues: Cue[] = [];
  private misses = 0;
  private check: ReturnType<typeof setInterval>;

  constructor(
    primary: OfficialRenderer,
    private makeFallback: () => Renderer,
    private onSwitch?: (why: string) => void,
    private video?: () => HTMLMediaElement | null,
  ) {
    this.inner = primary;
    primary.onError = (e) => this.switch(e.message);
    this.check = setInterval(() => this.verify(), 1500);
  }

  private switch(why: string): void {
    if (this.inner.kind !== 'official') return;
    clearInterval(this.check);
    this.onSwitch?.(why);
    this.inner.destroy();
    this.inner = this.makeFallback();
    this.inner.setCues(this.cues);
  }

  private verify(): void {
    if (this.inner.kind !== 'official') return;
    // When no official subtitle language is selected (always the case on videos
    // without subtitles) the player keeps its subtitle engine hidden with the
    // render loop stopped; addSubtitle feeds data but nothing is ever drawn.
    // Verified in Chrome 2026-11-11, player core.a3c25289.
    const panel = document.querySelector<HTMLElement>('.bili-subtitle-x-subtitle-panel');
    if (this.cues.length && panel && getComputedStyle(panel).display === 'none') {
      this.switch('official subtitle layer is hidden (no subtitle language selected)');
      return;
    }
    const t = this.video?.()?.currentTime;
    if (t == null) return;
    // a cue that has been active for at least ~0.8 s
    const c = this.cues.find((x) => x.from + 0.8 <= t && t < x.to - 0.2);
    if (!c) return;
    const wrap = document.querySelector('.bpx-player-subtitle-wrap');
    const shown = !!wrap?.textContent?.includes(c.content.slice(0, Math.min(4, c.content.length)));
    this.misses = shown ? 0 : this.misses + 1;
    if (this.misses >= 2) this.switch('cue not visible in .bpx-player-subtitle-wrap');
  }

  get current(): 'official' | 'overlay' {
    return this.inner.kind === 'official' ? 'official' : 'overlay';
  }

  setCues(cues: Cue[]): void {
    this.cues = cues;
    this.inner.setCues(cues);
  }

  clear(): void {
    this.cues = [];
    this.inner.clear();
  }

  destroy(): void {
    clearInterval(this.check);
    this.inner.destroy();
  }
}

const OVERLAY_CSS = `
.bilisub-overlay{position:absolute;left:0;right:0;bottom:8%;display:flex;justify-content:center;pointer-events:none;z-index:17}
.bilisub-overlay span{max-width:80%;padding:2px 8px;border-radius:4px;background:rgba(0,0,0,.5);color:#fff;
  font:500 calc(18px + 0.6vw)/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-align:center;
  text-shadow:0 0 2px rgba(0,0,0,.8)}
.bilisub-overlay span:empty{display:none}
.bpx-player-container[data-screen="full"] .bilisub-overlay span{font-size:calc(22px + 0.8vw)}
`;

export class OverlayRenderer implements Renderer {
  readonly kind = 'overlay' as const;
  private cues: Cue[] = [];
  private el: HTMLDivElement;
  private span: HTMLSpanElement;
  private raf = 0;
  private lastIdx = -1;

  constructor(private video: () => HTMLMediaElement | null) {
    if (!document.getElementById('bilisub-overlay-style')) {
      const st = document.createElement('style');
      st.id = 'bilisub-overlay-style';
      st.textContent = OVERLAY_CSS;
      document.head.appendChild(st);
    }
    this.el = document.createElement('div');
    this.el.className = 'bilisub-overlay';
    this.span = document.createElement('span');
    this.el.appendChild(this.span);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  private mount(): void {
    // Inside the player container so it follows web-fullscreen and fullscreen.
    const host = document.querySelector('.bpx-player-subtitle-wrap') ?? document.querySelector('.bpx-player-video-area') ?? document.querySelector('.bpx-player-container');
    if (host && this.el.parentElement !== host) host.appendChild(this.el);
  }

  private loop(): void {
    this.raf = requestAnimationFrame(this.loop);
    this.mount();
    const t = this.video()?.currentTime ?? -1;
    // cues are sorted and non-overlapping; binary search
    let lo = 0;
    let hi = this.cues.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.cues[mid];
      if (t < c.from) hi = mid - 1;
      else if (t >= c.to) lo = mid + 1;
      else {
        idx = mid;
        break;
      }
    }
    if (idx !== this.lastIdx) {
      this.lastIdx = idx;
      this.span.textContent = idx >= 0 ? this.cues[idx].content : '';
    }
  }

  setCues(cues: Cue[]): void {
    this.cues = cues;
    this.lastIdx = -2;
  }

  clear(): void {
    this.setCues([]);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.el.remove();
  }
}
