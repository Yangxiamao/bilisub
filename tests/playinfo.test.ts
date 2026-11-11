import { describe, expect, it } from 'vitest';
import { hostScore, isExpiring, pickAudioTrack, unwrapPlayUrl, urlExpiry } from '../src/bili/playinfo';

const seg = { initialization: '0-848', index_range: '849-7800' };
const data = {
  dash: {
    duration: 2887,
    audio: [
      { id: 30280, baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/a-30280.m4s?deadline=2000', backupUrl: [], bandwidth: 178518, codecs: 'mp4a.40.2', segment_base: seg },
      {
        id: 30216,
        baseUrl: 'https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/a-30216.m4s?deadline=1500',
        backupUrl: ['https://upos-hz-mirrorakam.akamaized.net/a-30216.m4s?deadline=1800', 'http://upos-sz-mirrorcos.bilivideo.com/a-30216.m4s?deadline=1900'],
        bandwidth: 67176, codecs: 'mp4a.40.2', segment_base: seg,
      },
      { id: 30250, baseUrl: 'https://upos/x.m4s', bandwidth: 1000, codecs: 'ec-3', segment_base: seg },
    ],
  },
};

describe('playinfo', () => {
  it('unwraps envelopes', () => {
    expect(unwrapPlayUrl({ code: 0, data: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapPlayUrl({ code: -404, data: null })).toBeNull();
    expect(unwrapPlayUrl({ dash: {} })).toEqual({ dash: {} });
  });

  it('picks the lowest-bitrate AAC track and orders hosts', () => {
    const t = pickAudioTrack(data)!;
    expect(t.id).toBe(30216);
    expect(t.init).toEqual([0, 848]);
    expect(t.index).toEqual([849, 7800]);
    expect(t.urls.map((u) => new URL(u).hostname)).toEqual([
      'upos-hz-mirrorakam.akamaized.net', 'upos-sz-mirrorcos.bilivideo.com', 'xy1x2x3x4xy.mcdn.bilivideo.cn',
    ]);
    expect(t.urls[1].startsWith('https:')).toBe(true);
    expect(t.expiresAt).toBe(1500);
  });

  it('reads expiry params', () => {
    expect(urlExpiry('https://a/b?x=1&deadline=123')).toBe(123);
    expect(urlExpiry('https://a/b?wsTime=77')).toBe(77);
    expect(urlExpiry('https://a/b')).toBeNull();
    expect(isExpiring({ expiresAt: 1000 } as never, 800, 300)).toBe(true);
    expect(isExpiring({ expiresAt: 1000 } as never, 600, 300)).toBe(false);
  });

  it('scores hosts', () => {
    expect(hostScore('https://upos-sz-mirrorcos.bilivideo.com/x')).toBeLessThan(hostScore('https://cn-gdfs-ct-01-01.bilivideo.com/x'));
    expect(hostScore('https://1.2.3.4/x')).toBe(50);
  });
});
