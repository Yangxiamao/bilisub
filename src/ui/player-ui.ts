/**
 * In-player UI: a toggle button in the control bar (next to the official
 * subtitle button) with a status tooltip, and lightweight toasts. Everything
 * lives inside the player container so it works in web-fullscreen/fullscreen.
 */
export type ButtonState = 'off' | 'busy' | 'on' | 'warn' | 'error';

const CSS = `
.bilisub-btn{position:relative;display:flex;align-items:center;justify-content:center;width:36px;height:22px;cursor:pointer;
  color:hsla(0,0%,100%,.8);font:700 13px/1 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;user-select:none}
.bilisub-btn:hover{color:#fff}
.bilisub-btn .bilisub-label{border:1.5px solid currentColor;border-radius:4px;padding:2px 3px;letter-spacing:.5px}
.bilisub-btn[data-state="on"],.bilisub-btn[data-state="busy"]{color:#00aeec}
.bilisub-btn[data-state="busy"] .bilisub-label{animation:bilisub-pulse 1.2s ease-in-out infinite}
.bilisub-btn[data-state="warn"]{color:#ffb027}
.bilisub-btn[data-state="error"]{color:#ff6a6a}
@keyframes bilisub-pulse{50%{opacity:.45}}
.bilisub-tip{position:absolute;bottom:34px;left:50%;transform:translateX(-50%);white-space:nowrap;padding:5px 9px;border-radius:4px;
  background:rgba(21,21,21,.9);color:#fff;font:400 12px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  pointer-events:none;opacity:0;transition:opacity .15s}
.bilisub-btn:hover .bilisub-tip{opacity:1}
.bilisub-toast{position:absolute;left:16px;top:16px;z-index:80;max-width:60%;padding:6px 12px;border-radius:4px;
  background:rgba(21,21,21,.85);color:#fff;font:400 13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  pointer-events:auto;transition:opacity .3s;opacity:0}
.bilisub-toast.show{opacity:1}
.bilisub-toast a{color:#00aeec;cursor:pointer;margin-left:8px}
`;

export class PlayerUI {
  private btn?: HTMLDivElement;
  private tip?: HTMLDivElement;
  private toastEl?: HTMLDivElement;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private state: ButtonState = 'off';
  private tipText = 'AI 字幕（Gemini 听写）：点击开启';
  private iv: ReturnType<typeof setInterval>;

  constructor(private onClick: () => void) {
    if (!document.getElementById('bilisub-ui-style')) {
      const st = document.createElement('style');
      st.id = 'bilisub-ui-style';
      st.textContent = CSS;
      (document.head ?? document.documentElement).appendChild(st);
    }
    // The player re-renders its control bar (SPA navigation, mode switches): keep re-attaching.
    this.iv = setInterval(() => this.ensure(), 1000);
    this.ensure();
  }

  private ensure(): void {
    const bar = document.querySelector('.bpx-player-control-bottom-right');
    if (!bar) return;
    if (this.btn && bar.contains(this.btn)) return;
    const btn = document.createElement('div');
    btn.className = 'bpx-player-ctrl-btn bilisub-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Gemini AI 字幕');
    btn.innerHTML = '<span class="bilisub-label">AI</span><div class="bilisub-tip"></div>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClick();
    });
    const sub = bar.querySelector('.bpx-player-ctrl-subtitle');
    if (sub) bar.insertBefore(btn, sub);
    else bar.prepend(btn);
    this.btn = btn;
    this.tip = btn.querySelector('.bilisub-tip') as HTMLDivElement;
    this.render();
  }

  set(state: ButtonState, tip: string): void {
    this.state = state;
    this.tipText = tip;
    this.render();
  }

  private render(): void {
    if (!this.btn || !this.tip) return;
    this.btn.dataset.state = this.state;
    this.tip.textContent = this.tipText;
  }

  /** Small message in the player's top-left corner. */
  toast(text: string, opts: { ms?: number; action?: { label: string; run: () => void } } = {}): void {
    const host = document.querySelector('.bpx-player-container') ?? document.body;
    if (!this.toastEl || !host.contains(this.toastEl)) {
      this.toastEl = document.createElement('div');
      this.toastEl.className = 'bilisub-toast';
      host.appendChild(this.toastEl);
    }
    const el = this.toastEl;
    el.textContent = text;
    if (opts.action) {
      const a = document.createElement('a');
      a.textContent = opts.action.label;
      a.addEventListener('click', (e) => {
        e.stopPropagation();
        el.classList.remove('show');
        opts.action!.run();
      });
      el.appendChild(a);
    }
    el.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), opts.ms ?? 4000);
  }

  destroy(): void {
    clearInterval(this.iv);
    this.btn?.remove();
    this.toastEl?.remove();
  }
}
