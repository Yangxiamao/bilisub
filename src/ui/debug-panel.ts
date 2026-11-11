/** Debug panel (settings.debug): Phase-0 style checks and exports. Shadow DOM, bottom-right of the page. */
export interface DebugCommand {
  id: string;
  label: string;
  args?: Record<string, unknown>;
}

export class DebugPanel {
  private host: HTMLDivElement;
  private pre: HTMLPreElement;

  constructor(commands: DebugCommand[], run: (id: string, args: Record<string, unknown>) => void) {
    this.host = document.createElement('div');
    this.host.id = 'bilisub-debug';
    const root = this.host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial}
      .p{position:fixed;right:12px;bottom:12px;z-index:2147483646;width:380px;max-height:50vh;display:flex;flex-direction:column;
        font:12px/1.4 system-ui,sans-serif;background:rgba(20,20,24,.94);color:#eee;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4)}
      .h{display:flex;justify-content:space-between;padding:6px 8px;font-weight:600;cursor:pointer}
      .b{display:flex;flex-wrap:wrap;gap:4px;padding:0 8px 6px}
      button{font:inherit;background:#334;color:#eee;border:1px solid #556;border-radius:4px;padding:2px 6px;cursor:pointer}
      pre{margin:0;padding:6px 8px;overflow:auto;white-space:pre-wrap;word-break:break-all;border-top:1px solid #333;flex:1}
      .c .b,.c pre{display:none}
    </style><div class="p c"><div class="h"><span>BiliSub debug</span><span>▾</span></div><div class="b"></div><pre></pre></div>`;
    const box = root.querySelector('.p')!;
    root.querySelector('.h')!.addEventListener('click', () => box.classList.toggle('c'));
    const bar = root.querySelector('.b')!;
    for (const c of commands) {
      const b = document.createElement('button');
      b.textContent = c.label;
      b.addEventListener('click', () => run(c.id, c.args ?? {}));
      bar.appendChild(b);
    }
    this.pre = root.querySelector('pre')!;
    document.documentElement.appendChild(this.host);
  }

  log(line: string): void {
    this.pre.textContent = `${new Date().toLocaleTimeString()} ${line}\n${this.pre.textContent}`.slice(0, 30000);
  }

  destroy(): void {
    this.host.remove();
  }
}

export function download(name: string, data: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([data], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
