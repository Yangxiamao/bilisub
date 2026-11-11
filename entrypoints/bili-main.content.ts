/**
 * MAIN world: passive capture of the player's own API responses, and a thin
 * adapter over `window.player` (Bilibili 3.x nano player API).
 *
 * Kept deliberately small: no extension APIs exist here, and anything put on
 * the page is visible to page scripts. Never throws into the player.
 */
import { TO_CONTENT, TO_MAIN, type ContentToMain, type MainToContent, type OfficialSubtitle, type VideoInfo } from '../src/bridge/protocol';
import type { PlayUrlData } from '../src/bili/playinfo';
import type { Cue } from '../src/transcriber/types';

export default defineContentScript({
  matches: ['https://www.bilibili.com/video/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const send = (msg: MainToContent) => document.dispatchEvent(new CustomEvent(TO_CONTENT, { detail: msg }));
    const PLAYURL_RE = /\/\/api\.bilibili\.com\/x\/player\/(?:wbi\/)?playurl\b/;
    const PLAYERV2_RE = /\/\/api\.bilibili\.com\/x\/player\/(?:wbi\/)?v2\b/;
    const SUBVIEW_RE = /\/\/api\.bilibili\.com\/x\/v2\/subtitle\/web\/view\b/;

    const paramsOf = (url: string) => {
      try {
        const q = new URL(url, location.href).searchParams;
        return { cid: Number(q.get('cid')) || undefined, bvid: q.get('bvid') ?? undefined };
      } catch {
        return {};
      }
    };

    const onJson = (url: string, json: unknown, source: 'xhr' | 'fetch') => {
      const env = json as { code?: number; data?: Record<string, unknown> };
      if (!env || env.code !== 0 || !env.data) return;
      if (PLAYURL_RE.test(url)) {
        const data = env.data as PlayUrlData;
        if (data.dash) send({ kind: 'playurl', source, url: url.split('?')[0], ...paramsOf(url), data });
      } else if (PLAYERV2_RE.test(url)) {
        const sub = env.data.subtitle as { subtitles?: Array<{ lan?: string; lan_doc?: string; type?: number }> } | undefined;
        const subtitles: OfficialSubtitle[] = (sub?.subtitles ?? []).map((s) => ({ lan: s.lan ?? '', lan_doc: s.lan_doc ?? '', type: s.type }));
        send({ kind: 'player-info', cid: paramsOf(url).cid ?? (env.data.cid as number | undefined), subtitles, needLoginSubtitle: !!env.data.need_login_subtitle });
      }
    };

    // --- XHR hook -----------------------------------------------------------
    const XO = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      const u = String(url);
      if (PLAYURL_RE.test(u) || PLAYERV2_RE.test(u) || SUBVIEW_RE.test(u)) {
        this.addEventListener('load', () => {
          try {
            if (SUBVIEW_RE.test(u)) {
              const n = this.response instanceof ArrayBuffer ? this.response.byteLength : 0;
              send({ kind: 'subtitle-list', url: u.split('?')[0], bytes: n });
              return;
            }
            const r = this.responseType === 'json' ? this.response
              : this.responseType === '' || this.responseType === 'text' ? JSON.parse(this.responseText) : null;
            if (r) onJson(u, r, 'xhr');
          } catch {
            /* never break the player */
          }
        });
      }
      return (XO as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof XO;

    // --- fetch hook ---------------------------------------------------------
    const F = window.fetch;
    window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const res = await F.call(this as typeof globalThis, input, init);
      try {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (PLAYURL_RE.test(u) || PLAYERV2_RE.test(u)) res.clone().json().then((j) => onJson(u, j, 'fetch')).catch(() => undefined);
      } catch {
        /* ignore */
      }
      return res;
    } as typeof fetch;

    // --- page state ---------------------------------------------------------
    type Win = Window & {
      __playinfo__?: { code?: number; data?: unknown };
      __INITIAL_STATE__?: {
        videoData?: { bvid?: string; aid?: number; cid?: number; title?: string; desc?: string; pages?: Array<{ cid: number; page: number }> };
        tags?: Array<{ tag_name?: string }>;
        p?: number;
      };
      player?: Record<string, unknown> & {
        addSubtitle?: (x: unknown) => unknown;
        updateRequestConfig?: (x: unknown) => unknown;
        getManifest?: () => Record<string, unknown>;
      };
    };
    const w = window as Win;

    const videoInfo = (): VideoInfo => {
      const s = w.__INITIAL_STATE__;
      const vd = s?.videoData;
      let m: Record<string, unknown> | undefined;
      try {
        m = w.player?.getManifest?.();
      } catch {
        /* ignore */
      }
      const p = Number(new URLSearchParams(location.search).get('p')) || s?.p || 1;
      const cidFromPages = vd?.pages?.find((x) => x.page === p)?.cid;
      const bvid = (m?.bvid as string) ?? vd?.bvid;
      // On playlist navigation the manifest switches at once but __INITIAL_STATE__
      // lags a few seconds behind (seen 2026-11-11): only trust its metadata
      // once it describes the same video.
      const fresh = !!vd && vd.bvid === bvid;
      return {
        bvid,
        aid: (m?.aid as number) ?? vd?.aid,
        cid: (m?.cid as number) ?? cidFromPages ?? vd?.cid,
        p,
        title: fresh ? vd.title : undefined,
        desc: fresh ? vd.desc : undefined,
        tags: fresh ? s?.tags?.map((t) => t.tag_name ?? '').filter(Boolean) : undefined,
      };
    };

    let lastKey = '';
    const announceVideo = () => {
      const v = videoInfo();
      const key = `${v.bvid}:${v.cid}:${v.title ? 1 : 0}`;
      if (key !== lastKey && v.cid) {
        lastKey = key;
        send({ kind: 'video', info: v });
      }
    };

    const start = () => {
      send({ kind: 'hello', at: Date.now() });
      const pi = w.__playinfo__;
      const v = videoInfo();
      if (pi && pi.code === 0 && pi.data) send({ kind: 'playurl', source: '__playinfo__', cid: v.cid, bvid: v.bvid, data: pi.data as PlayUrlData });
      announceVideo();
      // SPA navigation (next part / playlist autoplay) changes cid without a reload.
      setInterval(announceVideo, 1000);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();

    // --- commands from the content script ----------------------------------
    document.addEventListener(TO_MAIN, (ev) => {
      const msg = (ev as CustomEvent<ContentToMain>).detail;
      if (!msg || typeof msg !== 'object' || typeof (msg as { id?: unknown }).id !== 'number') return;
      const reply = (ok: boolean, result?: unknown, error?: string) => send({ kind: 'reply', id: msg.id, ok, result, error });
      void (async () => {
        try {
          switch (msg.kind) {
            case 'probe': {
              const p = w.player;
              const core = [...document.scripts].map((s) => s.src).find((s) => /\/player\/main\/core\.[0-9a-f]+\.js/.test(s));
              reply(true, {
                hasPlayer: !!p,
                playerKeys: p ? Object.keys(p).sort() : [],
                hasAddSubtitle: typeof p?.addSubtitle === 'function',
                hasUpdateRequestConfig: typeof p?.updateRequestConfig === 'function',
                hasPlayinfo: !!w.__playinfo__,
                core,
                subtitleWrap: !!document.querySelector('.bpx-player-subtitle-wrap'),
                video: videoInfo(),
              });
              break;
            }
            case 'add-subtitle': {
              const p = w.player;
              if (typeof p?.addSubtitle !== 'function') throw new Error('window.player.addSubtitle is not available');
              const t0 = performance.now();
              // Fresh objects every time: the player sorts in place and keeps a reference (mobx store).
              p.addSubtitle({ body: msg.body.map((c: Cue) => ({ from: c.from, to: c.to, content: c.content, location: 2 })) });
              reply(true, { ms: +(performance.now() - t0).toFixed(2), n: msg.body.length });
              break;
            }
            case 'video-info':
              reply(true, videoInfo());
              break;
            case 'refresh-playurl': {
              // Unsigned endpoint (works with or without login, verified 2026-11-11). Same-origin cookies apply.
              const q = new URLSearchParams({ cid: String(msg.cid), fnval: '16', fnver: '0', fourk: '1' });
              if (msg.bvid) q.set('bvid', msg.bvid);
              const r = await F.call(window, `https://api.bilibili.com/x/player/playurl?${q}`, { credentials: 'include' });
              const j = (await r.json()) as { code: number; message?: string; data?: PlayUrlData };
              if (j.code !== 0 || !j.data) throw new Error(`playurl ${j.code} ${j.message ?? ''}`);
              reply(true, j.data);
              break;
            }
          }
        } catch (e) {
          reply(false, undefined, (e as Error)?.message ?? String(e));
        }
      })();
    });
  },
});
