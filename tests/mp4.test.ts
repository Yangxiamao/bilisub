import { describe, expect, it } from 'vitest';
import {
  adtsHeader, concatBytes, extractAacFrames, parseAacConfig, parseSidx, readBoxes,
  rebaseFragments, spanForFragments, spanForTime, toAdts,
} from '../src/bili/mp4';

// --- tiny box builders ------------------------------------------------------
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const u16 = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b; };
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const box = (type: string, ...payload: Uint8Array[]) => {
  const body = concatBytes(...payload);
  return concatBytes(u32(body.byteLength + 8), ascii(type), body);
};
const full = (type: string, version: number, flags: number, ...payload: Uint8Array[]) =>
  box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);

function sidx(timescale: number, ept: number, firstOffset: number, refs: Array<[size: number, dur: number]>) {
  return full('sidx', 0, 0,
    u32(1), u32(timescale), u32(ept), u32(firstOffset), u16(0), u16(refs.length),
    ...refs.flatMap(([s, d]) => [u32(s & 0x7fffffff), u32(d), u32(0x90000000)]));
}

/** moof+mdat with N samples of the given sizes, decode time `dts`, default duration 1024. */
function fragment(dts: number, sizes: number[], fill: number) {
  const tfhd = full('tfhd', 0, 0x020008, u32(1), u32(1024)); // default-base-is-moof + default duration
  const tfdt = full('tfdt', 1, 0, u32(0), u32(dts));
  const trunFlags = 0x000201; // data-offset + sample-size
  const trunLen = 8 + 4 + 4 + 4 + sizes.length * 4;
  const moofLen = 8 + 16 /* mfhd */ + 8 + tfhd.byteLength + tfdt.byteLength + trunLen;
  const trun = full('trun', 0, trunFlags, u32(sizes.length), u32(moofLen + 8), ...sizes.map(u32));
  const moof = box('moof', full('mfhd', 0, 0, u32(1)), box('traf', tfhd, tfdt, trun));
  expect(moof.byteLength).toBe(moofLen);
  const data = concatBytes(...sizes.map((s, i) => new Uint8Array(s).fill(fill + i)));
  return concatBytes(moof, box('mdat', data));
}

function initSegment() {
  // AudioSpecificConfig: AAC-LC (2), 48 kHz (idx 3), stereo (2) -> 0x11 0x90
  const asc = Uint8Array.of(0x11, 0x90);
  const dsi = concatBytes(Uint8Array.of(0x05, asc.length), asc);
  const dcd = concatBytes(Uint8Array.of(0x04, 13 + dsi.length, 0x40, 0x15), new Uint8Array(11), dsi);
  const esd = concatBytes(Uint8Array.of(0x03, 3 + dcd.length, 0, 1, 0), dcd);
  const esds = full('esds', 0, 0, esd);
  const mp4a = box('mp4a', new Uint8Array(6), u16(1), new Uint8Array(8), u16(2), u16(16), u16(0), u16(0), u32(48000 << 16), esds);
  const stsd = full('stsd', 0, 0, u32(1), mp4a);
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(48000), u32(0), u32(0));
  const moov = box('moov', box('trak', box('mdia', mdhd, box('minf', box('stbl', stsd)))));
  return concatBytes(box('ftyp', ascii('iso5'), u32(1)), moov);
}

describe('sidx', () => {
  it('computes absolute offsets and times', () => {
    const s = sidx(48000, 0, 0, [[1000, 240640], [1100, 240640], [900, 240000]]);
    const idx = parseSidx(s, 849);
    expect(idx.refs.map((r) => r.offset)).toEqual([849 + s.byteLength, 849 + s.byteLength + 1000, 849 + s.byteLength + 2100]);
    expect(idx.refs[1].start).toBeCloseTo(5.01333, 4);
    expect(idx.duration).toBeCloseTo((240640 * 2 + 240000) / 48000, 6);
  });

  it('maps time spans to fragment byte ranges', () => {
    const idx = parseSidx(sidx(1000, 0, 0, [[10, 5000], [20, 5000], [30, 5000], [40, 5000]]), 0);
    const base = idx.refs[0].offset;
    expect(spanForTime(idx, 6, 11)).toMatchObject({ first: 1, last: 2, start: 5, end: 15, byteStart: base + 10, byteEnd: base + 59 });
    expect(spanForTime(idx, 0, 5)).toMatchObject({ first: 0, last: 0 });
    expect(spanForTime(idx, 19, 99)).toMatchObject({ first: 3, last: 3, end: 20 });
    expect(spanForFragments(idx, 0, 3)).toMatchObject({ byteStart: base, byteEnd: base + 99 });
    expect(() => spanForTime(idx, 30, 40)).toThrow();
  });
});

describe('init segment', () => {
  it('reads AAC config', () => {
    expect(parseAacConfig(initSegment())).toEqual({
      audioObjectType: 2, samplingFrequencyIndex: 3, sampleRate: 48000, channelConfiguration: 2, timescale: 48000,
    });
  });
});

describe('fragments', () => {
  const media = concatBytes(fragment(48000 * 600, [3, 4], 10), fragment(48000 * 600 + 2048, [5], 20));

  it('extracts samples via trun', () => {
    const frames = extractAacFrames(media);
    expect(frames.map((f) => f.data.byteLength)).toEqual([3, 4, 5]);
    expect(frames.map((f) => f.data[0])).toEqual([10, 11, 20]);
    expect(frames.map((f) => f.dts)).toEqual([28800000, 28801024, 28802048]);
  });

  it('rebases tfdt to zero without touching the input', () => {
    const r = rebaseFragments(media);
    expect(extractAacFrames(r).map((f) => f.dts)).toEqual([0, 1024, 2048]);
    expect(extractAacFrames(media)[0].dts).toBe(28800000);
    expect(readBoxes(r).map((b) => b.type)).toEqual(['moof', 'mdat', 'moof', 'mdat']);
  });

  it('packs ADTS frames', () => {
    const cfg = parseAacConfig(initSegment());
    expect(Array.from(adtsHeader(cfg, 100))).toEqual([0xff, 0xf1, 0x4c, 0x80, 0x0d, 0x7f, 0xfc]);
    const adts = toAdts(cfg, extractAacFrames(media));
    expect(adts.byteLength).toBe(3 + 4 + 5 + 7 * 3);
    expect(adts[7]).toBe(10);
  });
});
