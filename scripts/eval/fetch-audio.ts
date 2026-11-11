/**
 * S1/S2 offline check: fetch an arbitrary time span of the test video's audio
 * with Range requests, and write it as fMP4 (.m4a) and ADTS (.aac).
 *
 *   npm run eval:fetch -- 10:00 10:30 [BVID]
 */
import { fmtTime, out, parseTime, trackFetcher, videoMeta } from './common';

const [a = '10:00', b = '10:30', bvid] = process.argv.slice(2);
const meta = await videoMeta(bvid);
const t0 = performance.now();
const f = await trackFetcher(meta);
const info = await f.load();
const tLoad = performance.now();
const clip = await f.clipByTime(parseTime(a), parseTime(b));
const tClip = performance.now();
const adts = clip.adts();

const tag = `${meta.bvid}_${Math.round(clip.span.start)}-${Math.round(clip.span.end)}`;
const p1 = out(`clips/${tag}.m4a`, clip.fmp4);
const p2 = out(`clips/${tag}.aac`, adts);

console.log(JSON.stringify({
  video: { bvid: meta.bvid, cid: meta.cid, title: meta.title, duration: meta.duration },
  track: { id: f.track.id, bandwidth: f.track.bandwidth, codecs: f.track.codecs, hosts: f.track.urls.map((u) => new URL(u).hostname), expiresInSec: f.track.expiresAt && f.track.expiresAt - Math.floor(Date.now() / 1000) },
  aac: info.aac,
  index: { fragments: info.index.refs.length, duration: info.index.duration, firstFragDur: info.index.refs[0].duration },
  requested: [a, b],
  span: { ...clip.span, startFmt: fmtTime(clip.span.start), endFmt: fmtTime(clip.span.end) },
  bytes: { fmp4: clip.fmp4.byteLength, adts: adts.byteLength },
  ms: { initAndSidx: Math.round(tLoad - t0), clip: Math.round(tClip - tLoad) },
  files: [p1, p2],
}, null, 2));
