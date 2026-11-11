/**
 * Isolated content script: the per-tab controller.
 *
 * - collects audio info / video info / official subtitle info from the MAIN world
 * - owns the on/off state for this tab and one Session per video part (cid)
 * - renders through the player's own subtitle module, or an overlay fallback
 * - talks to the popup (status / toggle) and shows a debug panel if enabled
 *
 * Automated testing hook (debug only, page -> content):
 *   document.dispatchEvent(new CustomEvent('bilisub:debug', { detail: { cmd: 'probe' } }))
 * Results are logged to the console with the "[bilisub]" prefix.
 */
import { TrackFetcher } from '../src/bili/fetcher';
import { pickAudioTrack, type AudioTrack, type PlayUrlData } from '../src/bili/playinfo';
import { MainBridge } from '../src/bridge/main-client';
import type { MainToContent, OfficialSubtitle, VideoInfo } from '../src/bridge/protocol';
import { send, type TabRequest, type TabStatus, type TranscribeResponse } from '../src/bridge/runtime';
import { decodeToWav16k } from '../src/audio/wav';
import { Session, type SessionStatus } from '../src/core/session';
import { FallbackRenderer, OfficialRenderer, OverlayRenderer, type Renderer } from '../src/render/renderers';
import { getSettings, hasApiKey, modelInfo, onSettingsChanged, type Settings } from '../src/store/settings';
import { toSrt } from '../src/subs/srt';
import type { Cue } from '../src/transcriber/types';
import { DebugPanel, download } from '../src/ui/debug-panel';
import { PlayerUI, type ButtonState } from '../src/ui/player-ui';

interface ProbeResult {
  hasPlayer: boolean;
  hasAddSubtitle: boolean;
  hasPlayinfo: boolean;
  core?: string;
  playerKeys: string[];
}

export default defineContentScript({
  matches: ['https://www.bilibili.com/video/*'],
  runAt: 'document_start',
  async main() {
    const bridge = new MainBridge();
    const tracks = new Map<number, AudioTrack>();
    const officialSubs = new Map<number, OfficialSubtitle[]>();
    let video: VideoInfo = {};
    let settings: Settings = await getSettings();
    let session: Session | undefined;
    let renderer: Renderer | undefined;
    let enabled = false; // user turned it on in this tab
    let lastStatus: SessionStatus | undefined;
    let confirmUntil = 0;
    let probe: ProbeResult | undefined;
    let ui: PlayerUI | undefined;
    let panel: DebugPanel | undefined;
    const responses: Array<{ at: number; span: { start: number; end: number }; res: TranscribeResponse }> = [];

    // Lines logged before the panel exists (document_start, before DOMContentLoaded).
    const early: string[] = [];
    const log = (...a: unknown[]) => {
      if (!settings.debug) return;
      console.log('[bilisub]', ...a);
      const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
      if (panel) panel.log(line);
      else if (early.length < 50) early.push(`${new Date().toLocaleTimeString()} ${line}`);
    };
    const videoEl = () => document.querySelector<HTMLVideoElement>('.bpx-player-video-wrap video, .bpx-player-video-wrap bwp-video, video');

    // --- data from the MAIN world -----------------------------------------------
    const acceptPlayUrl = (data: PlayUrlData, cid: number | undefined, source: string) => {
      const t = pickAudioTrack(data);
      const c = cid ?? video.cid;
      if (!t || !c) return;
      tracks.set(c, t);
      log(`playurl via ${source}: cid=${c} audio=${t.id} ${Math.round(t.bandwidth / 1000)}kbps hosts=${t.urls.map((u) => new URL(u).hostname).join(',')}`);
    };

    bridge.on((m: MainToContent) => {
      switch (m.kind) {
        case 'playurl':
          acceptPlayUrl(m.data, m.cid, m.source);
          break;
        case 'player-info':
          if (m.cid) officialSubs.set(m.cid, m.subtitles);
          log(`official subtitles for cid=${m.cid}: ${m.subtitles.map((s) => s.lan_doc || s.lan).join(', ') || 'none'}`);
          if (m.cid === video.cid) setButton();
          break;
        case 'video':
          onVideo(m.info);
          break;
        case 'subtitle-list':
          log(`player requested subtitle list (${m.bytes} bytes)`);
          break;
      }
    });

    async function refreshTrack(): Promise<AudioTrack> {
      const cid = video.cid;
      if (!cid) throw new Error('cid unknown');
      const data = await bridge.call<PlayUrlData>({ kind: 'refresh-playurl', bvid: video.bvid, cid }, 10_000);
      acceptPlayUrl(data, cid, 'refresh');
      const t = tracks.get(cid);
      if (!t) throw new Error('playurl has no AAC audio track');
      return t;
    }

    // --- renderer -----------------------------------------------------------------
    async function makeRenderer(): Promise<Renderer> {
      // Explicit modes are for testing: no automatic fallback.
      if (settings.renderer === 'official') return new OfficialRenderer(bridge);
      if (settings.renderer === 'overlay') return new OverlayRenderer(videoEl);
      probe ??= await bridge.call<ProbeResult>({ kind: 'probe' }).catch(() => undefined);
      if (probe?.hasAddSubtitle) {
        return new FallbackRenderer(new OfficialRenderer(bridge), () => new OverlayRenderer(videoEl), (why) => {
          log(`official renderer failed (${why}); switched to overlay`);
        }, videoEl);
      }
      return new OverlayRenderer(videoEl);
    }

    // --- session lifecycle ----------------------------------------------------------
    function hasOfficial(cid: number | undefined): OfficialSubtitle[] {
      return (cid && officialSubs.get(cid)) || [];
    }

    let starting = false;
    async function startSession(opts: { force?: boolean; auto?: boolean } = {}): Promise<void> {
      if (starting) return;
      starting = true;
      try {
        await startSessionInner(opts);
      } finally {
        starting = false;
      }
    }

    async function startSessionInner(opts: { force?: boolean; auto?: boolean }): Promise<void> {
      Object.assign(settings, await getSettings());
      if (!settings.consentAt) {
        ui?.toast('首次使用前请先阅读费用和隐私说明', { ms: 8000, action: { label: '打开设置', run: () => void send({ type: 'open-options' }) } });
        return;
      }
      if (!hasApiKey(settings)) {
        ui?.toast('还没有填写 Gemini API Key', { ms: 8000, action: { label: '打开设置', run: () => void send({ type: 'open-options' }) } });
        return;
      }
      const info = await bridge.call<VideoInfo>({ kind: 'video-info' }).catch(() => video);
      video = { ...video, ...info };
      if (!video.cid) {
        ui?.toast('还没识别到视频信息，请稍后再试');
        return;
      }
      const subs = hasOfficial(video.cid);
      if (subs.length && !opts.force) {
        if (opts.auto) {
          ui?.toast(`本视频已有字幕（${subs.map((s) => s.lan_doc).join('、')}），未自动转写`);
          setButton();
          return;
        }
        if (Date.now() > confirmUntil) {
          confirmUntil = Date.now() + 6000;
          ui?.toast(`本视频已有字幕（${subs.map((s) => s.lan_doc).join('、')}）。再点一次仍然用 Gemini 转写`, { ms: 6000 });
          return;
        }
      }
      stopSession();
      enabled = true;
      renderer = await makeRenderer();
      const cid = video.cid;
      const s = new Session({
        info: { ...video, cid },
        settings,
        renderer,
        video: videoEl,
        track: () => tracks.get(cid),
        refreshTrack,
        onStatus: (st) => {
          if (session !== s) return;
          lastStatus = st;
          setButton();
          if (st.state === 'error') ui?.toast(`AI 字幕出错：${st.message}`, { ms: 8000, action: st.errorCode === 'auth' || st.errorCode === 'no-key' ? { label: '打开设置', run: () => void send({ type: 'open-options' }) } : undefined });
          log(`status ${st.state}: ${st.message} (inFlight=${st.inFlight}, cues=${st.cues})`);
        },
        log,
        onResponse: (_job, res, span) => {
          if (!settings.debug) return;
          responses.push({ at: Date.now(), span, res });
          if (responses.length > 100) responses.shift();
        },
      });
      session = s;
      log(`session start cid=${cid} model=${settings.model} renderer=${renderer.kind}`);
      ui?.toast(`AI 字幕已开启（${modelInfo(settings.model).label.replace(/（.*）/, '')}）`, { ms: 2500 });
      await s.start();
    }

    function stopSession(): void {
      session?.stop();
      session = undefined;
      renderer?.destroy();
      renderer = undefined;
      lastStatus = undefined;
      setButton();
    }

    function toggle(): void {
      if (starting) return;
      if (session) {
        enabled = false;
        stopSession();
        ui?.toast('AI 字幕已关闭', { ms: 2000 });
      } else {
        void startSession({ force: Date.now() <= confirmUntil });
      }
    }

    function onVideo(info: VideoInfo): void {
      const prevCid = video.cid;
      video = { ...video, ...info };
      log('video', { bvid: video.bvid, cid: video.cid, p: video.p, title: video.title });
      if (session && info.cid === session.cid) {
        // Title / tags may arrive after the session started (playlist navigation).
        session.updateMeta({ title: video.title, desc: video.desc, tags: video.tags });
        return;
      }
      if (!session || info.cid === prevCid) return;
      // Next part / playlist item.
      stopSession();
      if (enabled && settings.autoContinue) {
        // Give the player a moment to request playurl / player info for the new cid.
        setTimeout(() => void startSession({ auto: true }), 2500);
      } else {
        enabled = false;
      }
    }

    function setButton(): void {
      if (!ui) return;
      const st = lastStatus;
      let state: ButtonState = 'off';
      let tip = 'AI 字幕（Gemini 听写）：点击开启';
      if (session && st) {
        state = st.state === 'error' ? 'error' : st.state === 'retrying' ? 'warn' : st.state === 'buffered' ? 'on' : 'busy';
        tip = `AI 字幕：${st.message}（点击关闭）`;
      } else if (session) {
        state = 'busy';
        tip = 'AI 字幕：启动中…';
      } else if (hasOfficial(video.cid).length) {
        tip = 'AI 字幕：本视频已有官方字幕，点击仍可转写';
      }
      ui.set(state, tip);
    }

    onSettingsChanged((p) => {
      const modelChanged = p.model && p.model !== settings.model;
      Object.assign(settings, p); // Session holds this object: lookahead/concurrency apply live
      if ('debug' in p) mountDebug();
      if ((modelChanged || 'renderer' in p) && session) {
        log('model/renderer changed, restarting session');
        void startSession({ force: true });
      } else if ('apiKeyEnc' in p && session && lastStatus?.state === 'error' && (lastStatus.errorCode === 'auth' || lastStatus.errorCode === 'no-key')) {
        // User fixed the key from the error toast's "打开设置": resume without extra clicks.
        log('api key changed after auth error, restarting session');
        void startSession({ force: true });
      }
    });

    // --- popup ------------------------------------------------------------------
    browser.runtime.onMessage.addListener((msg: TabRequest, _sender, sendResponse) => {
      if (msg?.type === 'tab-status') {
        const st: TabStatus = {
          supported: true, active: !!session, state: lastStatus?.state ?? (session ? 'starting' : 'off'), detail: lastStatus?.message,
          bvid: video.bvid, cid: video.cid, bufferedSec: lastStatus?.bufferedSec, hasOfficialSubs: hasOfficial(video.cid).length > 0,
        };
        sendResponse(st);
        return false;
      }
      if (msg?.type === 'tab-toggle') {
        toggle();
        sendResponse({ ok: true });
        return false;
      }
      return false;
    });

    // --- debug ------------------------------------------------------------------
    const cmds: Record<string, (a: Record<string, unknown>) => Promise<unknown>> = {
      async probe() {
        probe = await bridge.call<ProbeResult>({ kind: 'probe' });
        return probe;
      },
      async s1(a) {
        const t = tracks.get(video.cid!) ?? (await refreshTrack());
        const f = new TrackFetcher(t);
        const t0 = performance.now();
        const info = await f.load();
        const start = Number(a.start ?? videoEl()?.currentTime ?? 0);
        const clip = await f.clipByTime(start, Number(a.end ?? start + 30));
        return { span: clip.span, fragments: info.index.refs.length, bytes: clip.fmp4.byteLength, ms: Math.round(performance.now() - t0), host: new URL(f.track.urls[0]).hostname };
      },
      async s2decode() {
        const t = tracks.get(video.cid!) ?? (await refreshTrack());
        const f = new TrackFetcher(t);
        const start = videoEl()?.currentTime ?? 0;
        const clip = await f.clipByTime(start, start + 30);
        const t0 = performance.now();
        const { duration, wav } = await decodeToWav16k(clip.fmp4);
        return { decodedDuration: duration, wavBytes: wav.byteLength, ms: Math.round(performance.now() - t0) };
      },
      async s4static() {
        const t = videoEl()?.currentTime ?? 0;
        const body: Cue[] = Array.from({ length: 30 }, (_, i) => ({ from: t + i * 2, to: t + i * 2 + 1.8, content: `Gemini 测试字幕 ${i + 1}，全屏也应显示` }));
        return bridge.call({ kind: 'add-subtitle', body });
      },
      async s4incremental(a) {
        const n = Number(a.n ?? 20);
        const body: Cue[] = [];
        const times: number[] = [];
        for (let i = 0; i < n; i++) {
          const t = videoEl()?.currentTime ?? 0;
          body.push({ from: t + 0.5, to: t + 1.5, content: `增量 ${i + 1} @${t.toFixed(1)}s` });
          times.push((await bridge.call<{ ms: number }>({ kind: 'add-subtitle', body: [...body] })).ms);
          await new Promise((r) => setTimeout(r, 1000));
        }
        return { calls: n, maxMs: Math.max(...times) };
      },
      async state() {
        const rk = renderer instanceof FallbackRenderer ? renderer.current : renderer?.kind;
        return { video, enabled, session: session ? { cid: session.cid, key: session.key, cues: session.track.length } : null, lastStatus, renderer: rk, tracks: [...tracks.keys()], officialSubs: Object.fromEntries(officialSubs) };
      },
      async toggle() {
        toggle();
        return 'ok';
      },
      async srt() {
        const s = toSrt(session?.track ?? []);
        download(`${video.bvid}_${video.cid}.srt`, s);
        return `${session?.track.length ?? 0} cues`;
      },
      async raw() {
        download(`${video.bvid}_${video.cid}_responses.json`, JSON.stringify(responses, null, 2), 'application/json');
        return `${responses.length} responses`;
      },
      async clearSubs() {
        return bridge.call({ kind: 'add-subtitle', body: [] });
      },
    };

    const run = async (cmd: string, a: Record<string, unknown> = {}) => {
      const fn = cmds[cmd];
      if (!fn) return console.log('[bilisub]', `unknown cmd ${cmd}`);
      try {
        const r = await fn(a);
        console.log('[bilisub]', cmd, r);
        panel?.log(`${cmd} ${JSON.stringify(r)}`);
      } catch (e) {
        console.log('[bilisub]', `${cmd} FAILED: ${(e as Error).message}`);
        panel?.log(`${cmd} FAILED: ${(e as Error).message}`);
      }
    };
    document.addEventListener('bilisub:debug', (ev) => {
      if (!settings.debug) return;
      const d = (ev as CustomEvent<{ cmd: string } & Record<string, unknown>>).detail;
      if (d && typeof d.cmd === 'string') void run(d.cmd, d);
    });

    function mountDebug(): void {
      if (settings.debug && !panel && document.documentElement) {
        panel = new DebugPanel([
          { id: 'state', label: '状态' }, { id: 'probe', label: '探测播放器' }, { id: 's1', label: 'S1 拉音频' },
          { id: 's2decode', label: 'S2 解码' }, { id: 's4static', label: 'S4 静态' }, { id: 's4incremental', label: 'S4 增量' },
          { id: 'toggle', label: '开/关' }, { id: 'srt', label: '导出 SRT' }, { id: 'raw', label: '导出响应' }, { id: 'clearSubs', label: '清空字幕' },
        ], (id, a) => void run(id, a));
        for (const l of early.splice(0)) panel.log(`(early ${l})`);
      } else if (!settings.debug && panel) {
        panel.destroy();
        panel = undefined;
      }
    }

    const onReady = () => {
      ui = new PlayerUI(toggle);
      mountDebug();
      setButton();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
    else onReady();
  },
});
