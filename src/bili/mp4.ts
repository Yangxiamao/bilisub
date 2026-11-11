/**
 * Minimal ISO-BMFF helpers for Bilibili DASH audio (fMP4, AAC-LC, SegmentBase).
 *
 * A Bilibili audio .m4s looks like:
 *   ftyp | moov            <- segment_base.initialization (e.g. "0-848")
 *   sidx                   <- segment_base.index_range    (e.g. "849-7800")
 *   (moof mdat) x N        <- one fragment per sidx reference (~5.013 s each)
 *
 * Everything here is pure (no DOM / no network) so it runs in content scripts,
 * service workers, Node eval scripts and unit tests alike.
 */

export interface Box {
  type: string;
  /** Absolute offset of the box header within the buffer. */
  start: number;
  /** Offset of the payload (after size/type, and after 64-bit size if present). */
  payloadStart: number;
  /** Exclusive end offset. */
  end: number;
}

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'udta']);

function view(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

function fourcc(buf: Uint8Array, off: number): string {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

/** Iterate boxes in [from, to). Stops (without throwing) at a truncated box. */
export function readBoxes(buf: Uint8Array, from = 0, to = buf.byteLength): Box[] {
  const dv = view(buf);
  const out: Box[] = [];
  let off = from;
  while (off + 8 <= to) {
    let size = dv.getUint32(off);
    const type = fourcc(buf, off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > to) break;
      const hi = dv.getUint32(off + 8);
      const lo = dv.getUint32(off + 12);
      size = hi * 2 ** 32 + lo;
      header = 16;
    } else if (size === 0) {
      size = to - off;
    }
    if (size < header || off + size > to) break;
    out.push({ type, start: off, payloadStart: off + header, end: off + size });
    off += size;
  }
  return out;
}

/** Find the first box matching a path like ['moov','trak','mdia','mdhd']. */
export function findBox(buf: Uint8Array, path: string[], from = 0, to = buf.byteLength): Box | undefined {
  const [head, ...rest] = path;
  for (const b of readBoxes(buf, from, to)) {
    if (b.type !== head) continue;
    if (rest.length === 0) return b;
    if (CONTAINER_BOXES.has(b.type)) {
      const found = findBox(buf, rest, b.payloadStart, b.end);
      if (found) return found;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// sidx
// ---------------------------------------------------------------------------

export interface FragmentRef {
  index: number;
  /** Absolute byte offset of the fragment (moof) in the .m4s file. */
  offset: number;
  size: number;
  /** Presentation start in seconds (media timeline, starts ~0). */
  start: number;
  duration: number;
}

export interface SegmentIndex {
  timescale: number;
  refs: FragmentRef[];
  /** Total duration in seconds. */
  duration: number;
}

/**
 * Parse a sidx box.
 * @param buf bytes that start with the sidx box (i.e. the index_range response)
 * @param fileOffset absolute file offset of buf[0] (index_range start)
 */
export function parseSidx(buf: Uint8Array, fileOffset: number): SegmentIndex {
  const box = readBoxes(buf).find((b) => b.type === 'sidx');
  if (!box) throw new Error('sidx box not found');
  const dv = view(buf);
  let p = box.payloadStart;
  const version = buf[p];
  p += 4; // version + flags
  p += 4; // reference_ID
  const timescale = dv.getUint32(p);
  p += 4;
  let ept: number;
  let firstOffset: number;
  if (version === 0) {
    ept = dv.getUint32(p);
    firstOffset = dv.getUint32(p + 4);
    p += 8;
  } else {
    ept = dv.getUint32(p) * 2 ** 32 + dv.getUint32(p + 4);
    firstOffset = dv.getUint32(p + 8) * 2 ** 32 + dv.getUint32(p + 12);
    p += 16;
  }
  p += 2; // reserved
  const count = dv.getUint16(p);
  p += 2;

  const refs: FragmentRef[] = [];
  let offset = fileOffset + box.end + firstOffset;
  let t = ept;
  for (let i = 0; i < count; i++) {
    const a = dv.getUint32(p);
    const dur = dv.getUint32(p + 4);
    p += 12;
    if (a >>> 31) throw new Error('hierarchical sidx (reference_type=1) not supported');
    const size = a & 0x7fffffff;
    refs.push({ index: i, offset, size, start: t / timescale, duration: dur / timescale });
    offset += size;
    t += dur;
  }
  return { timescale, refs, duration: (t - ept) / timescale };
}

export interface FragmentSpan {
  first: number;
  last: number;
  /** Inclusive byte range for an HTTP Range header. */
  byteStart: number;
  byteEnd: number;
  /** Exact media time covered by [first..last]. */
  start: number;
  end: number;
}

/** Fragments overlapping [startSec, endSec). Throws if the range is outside the media. */
export function spanForTime(index: SegmentIndex, startSec: number, endSec: number): FragmentSpan {
  const refs = index.refs;
  if (!refs.length) throw new Error('empty segment index');
  const s = Math.max(0, startSec);
  const e = Math.min(endSec, index.refs[refs.length - 1].start + refs[refs.length - 1].duration);
  if (!(e > s)) throw new Error(`empty time span ${startSec}-${endSec}`);
  let first = refs.findIndex((r) => r.start + r.duration > s);
  if (first < 0) first = refs.length - 1;
  let last = first;
  while (last + 1 < refs.length && refs[last + 1].start < e) last++;
  return spanForFragments(index, first, last);
}

export function spanForFragments(index: SegmentIndex, first: number, last: number): FragmentSpan {
  const a = index.refs[first];
  const b = index.refs[last];
  if (!a || !b || last < first) throw new Error(`bad fragment span ${first}-${last}`);
  return {
    first,
    last,
    byteStart: a.offset,
    byteEnd: b.offset + b.size - 1,
    start: a.start,
    end: b.start + b.duration,
  };
}

// ---------------------------------------------------------------------------
// init segment: AAC AudioSpecificConfig
// ---------------------------------------------------------------------------

export interface AacConfig {
  audioObjectType: number;
  samplingFrequencyIndex: number;
  sampleRate: number;
  channelConfiguration: number;
  /** mdhd timescale of the audio track. */
  timescale: number;
}

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function readDescriptorLength(buf: Uint8Array, p: number): [len: number, next: number] {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const b = buf[p++];
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return [len, p];
}

/** Extract the AAC config from an init segment (ftyp+moov). */
export function parseAacConfig(init: Uint8Array): AacConfig {
  const mdhd = findBox(init, ['moov', 'trak', 'mdia', 'mdhd']);
  if (!mdhd) throw new Error('mdhd not found');
  const dv = view(init);
  const mv = init[mdhd.payloadStart];
  const timescale = dv.getUint32(mdhd.payloadStart + 4 + (mv === 1 ? 16 : 8));

  const stsd = findBox(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
  if (!stsd) throw new Error('stsd not found');
  // stsd: fullbox(4) + entry_count(4), then sample entries
  const entries = readBoxes(init, stsd.payloadStart + 8, stsd.end);
  const mp4a = entries.find((b) => b.type === 'mp4a');
  if (!mp4a) throw new Error(`audio sample entry is not mp4a (${entries.map((b) => b.type).join(',')})`);
  // AudioSampleEntry fixed part is 28 bytes
  const esds = readBoxes(init, mp4a.payloadStart + 28, mp4a.end).find((b) => b.type === 'esds');
  if (!esds) throw new Error('esds not found');

  // Walk descriptors: 0x03 ES_Descriptor > 0x04 DecoderConfig > 0x05 DecoderSpecificInfo
  let p = esds.payloadStart + 4;
  const end = esds.end;
  let asc: Uint8Array | undefined;
  while (p < end) {
    const tag = init[p++];
    const [len, next] = readDescriptorLength(init, p);
    p = next;
    if (tag === 0x03) {
      const flags = init[p + 2];
      p += 3; // ES_ID(2) + flags(1)
      if (flags & 0x80) p += 2; // dependsOn_ES_ID
      if (flags & 0x40) p += 1 + init[p]; // URL
      if (flags & 0x20) p += 2; // OCR_ES_Id
    } else if (tag === 0x04) {
      p += 13; // objectTypeIndication(1) streamType(1) bufferSize(3) maxBitrate(4) avgBitrate(4)
    } else if (tag === 0x05) {
      asc = init.subarray(p, p + len);
      break;
    } else {
      p += len;
    }
  }
  if (!asc || asc.length < 2) throw new Error('AudioSpecificConfig not found');

  const aot = asc[0] >> 3;
  const sfi = ((asc[0] & 0x07) << 1) | (asc[1] >> 7);
  if (aot === 31 || sfi === 15) throw new Error('extended AudioSpecificConfig not supported');
  const ch = (asc[1] >> 3) & 0x0f;
  return { audioObjectType: aot, samplingFrequencyIndex: sfi, sampleRate: SAMPLE_RATES[sfi], channelConfiguration: ch, timescale };
}

// ---------------------------------------------------------------------------
// media fragments -> raw AAC access units
// ---------------------------------------------------------------------------

export interface AacFrame {
  /** Decode time in timescale units. */
  dts: number;
  duration: number;
  data: Uint8Array;
}

/**
 * Split a byte run of (moof mdat)+ into AAC frames using tfhd/tfdt/trun.
 * Assumes one track per fragment (true for Bilibili audio).
 */
export function extractAacFrames(media: Uint8Array): AacFrame[] {
  const dv = view(media);
  const frames: AacFrame[] = [];
  for (const moof of readBoxes(media).filter((b) => b.type === 'moof')) {
    for (const traf of readBoxes(media, moof.payloadStart, moof.end).filter((b) => b.type === 'traf')) {
      const kids = readBoxes(media, traf.payloadStart, traf.end);
      const tfhd = kids.find((b) => b.type === 'tfhd');
      if (!tfhd) throw new Error('tfhd missing');
      let p = tfhd.payloadStart;
      const tfFlags = dv.getUint32(p) & 0xffffff;
      p += 8; // version/flags + track_ID
      // Bilibili uses default-base-is-moof; an absolute base-data-offset would
      // need the fragment's file offset, which callers don't pass in.
      if (tfFlags & 0x01) throw new Error('base-data-offset in tfhd not supported');
      const base = moof.start;
      if (tfFlags & 0x02) p += 4;
      let defDur = 0;
      let defSize = 0;
      if (tfFlags & 0x08) { defDur = dv.getUint32(p); p += 4; }
      if (tfFlags & 0x10) { defSize = dv.getUint32(p); p += 4; }

      const tfdt = kids.find((b) => b.type === 'tfdt');
      let dts = 0;
      if (tfdt) {
        const v = media[tfdt.payloadStart];
        dts = v === 1
          ? dv.getUint32(tfdt.payloadStart + 4) * 2 ** 32 + dv.getUint32(tfdt.payloadStart + 8)
          : dv.getUint32(tfdt.payloadStart + 4);
      }

      for (const trun of kids.filter((b) => b.type === 'trun')) {
        let q = trun.payloadStart;
        const flags = dv.getUint32(q) & 0xffffff;
        q += 4;
        const count = dv.getUint32(q);
        q += 4;
        let dataOff = base;
        if (flags & 0x01) { dataOff = base + dv.getInt32(q); q += 4; }
        else {
          const mdat = readBoxes(media, moof.end).find((b) => b.type === 'mdat');
          if (!mdat) throw new Error('mdat missing');
          dataOff = mdat.payloadStart;
        }
        if (flags & 0x04) q += 4;
        for (let i = 0; i < count; i++) {
          let dur = defDur;
          let size = defSize;
          if (flags & 0x100) { dur = dv.getUint32(q); q += 4; }
          if (flags & 0x200) { size = dv.getUint32(q); q += 4; }
          if (flags & 0x400) q += 4;
          if (flags & 0x800) q += 4;
          if (dataOff + size > media.byteLength) throw new Error('sample data out of range (truncated fragment?)');
          frames.push({ dts, duration: dur, data: media.subarray(dataOff, dataOff + size) });
          dataOff += size;
          dts += dur;
        }
      }
    }
  }
  return frames;
}

/**
 * Return a copy of (moof mdat)+ whose tfdt decode times start at 0.
 * Without this a clip cut from 10:00 claims to start at 600 s, and some
 * decoders (ffprobe reports duration = 600 + clip) pad the gap with silence.
 */
export function rebaseFragments(media: Uint8Array): Uint8Array {
  const out = media.slice();
  const dv = view(out);
  const tfdts: Box[] = [];
  for (const moof of readBoxes(out).filter((b) => b.type === 'moof')) {
    for (const traf of readBoxes(out, moof.payloadStart, moof.end).filter((b) => b.type === 'traf')) {
      const t = readBoxes(out, traf.payloadStart, traf.end).find((b) => b.type === 'tfdt');
      if (t) tfdts.push(t);
    }
  }
  const read = (b: Box) => (out[b.payloadStart] === 1
    ? dv.getUint32(b.payloadStart + 4) * 2 ** 32 + dv.getUint32(b.payloadStart + 8)
    : dv.getUint32(b.payloadStart + 4));
  if (!tfdts.length) return out;
  const base = read(tfdts[0]);
  for (const b of tfdts) {
    const v = read(b) - base;
    if (out[b.payloadStart] === 1) {
      dv.setUint32(b.payloadStart + 4, Math.floor(v / 2 ** 32));
      dv.setUint32(b.payloadStart + 8, v >>> 0);
    } else {
      dv.setUint32(b.payloadStart + 4, v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ADTS
// ---------------------------------------------------------------------------

export function adtsHeader(cfg: AacConfig, payloadLength: number): Uint8Array {
  if (cfg.audioObjectType < 1 || cfg.audioObjectType > 4) {
    throw new Error(`ADTS cannot carry audioObjectType ${cfg.audioObjectType}`);
  }
  const len = payloadLength + 7;
  if (len > 0x1fff) throw new Error('AAC frame too large for ADTS');
  const profile = cfg.audioObjectType - 1;
  const sfi = cfg.samplingFrequencyIndex;
  const ch = cfg.channelConfiguration;
  return Uint8Array.of(
    0xff,
    0xf1, // MPEG-4, layer 0, protection absent
    ((profile & 3) << 6) | ((sfi & 0xf) << 2) | ((ch >> 2) & 1),
    ((ch & 3) << 6) | ((len >> 11) & 3),
    (len >> 3) & 0xff,
    ((len & 7) << 5) | 0x1f,
    0xfc,
  );
}

/** Repackage fMP4 media fragments as an ADTS (.aac) stream. No transcoding. */
export function toAdts(cfg: AacConfig, frames: AacFrame[]): Uint8Array {
  const total = frames.reduce((n, f) => n + f.data.byteLength + 7, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const f of frames) {
    out.set(adtsHeader(cfg, f.data.byteLength), p);
    p += 7;
    out.set(f.data, p);
    p += f.data.byteLength;
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.byteLength, 0));
  let p = 0;
  for (const b of parts) {
    out.set(b, p);
    p += b.byteLength;
  }
  return out;
}
