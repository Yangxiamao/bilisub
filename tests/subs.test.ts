import { describe, expect, it } from 'vitest';
import { cleanText, displayLength, mergeChunk, mergeChunkWindows, sanitize, similarity, splitLong, splitText } from '../src/subs/cues';
import { toSimplified } from '../src/subs/t2s';
import { addInterval, coveredUntil, covers, gaps } from '../src/subs/intervals';
import { buildPrompt, parseCompact, parseJsonCues } from '../src/transcriber/prompt';

describe('parse', () => {
  it('parses compact lines and tolerates slips', () => {
    const text = '```\n0.0|2.5|大家好\n3.1 | 5.0 | 我们开始吧！\n1. 6.0|7.5|第三句\n[00:08.0 - 00:09.5] 第四句\n乱七八糟\n```';
    expect(parseCompact(text)).toEqual([
      { from: 0, to: 2.5, content: '大家好' },
      { from: 3.1, to: 5, content: '我们开始吧！' },
      { from: 6, to: 7.5, content: '第三句' },
      { from: 8, to: 9.5, content: '第四句' },
    ]);
  });

  it('keeps pipes inside text', () => {
    expect(parseCompact('1.0|2.0|A|B')[0].content).toBe('A|B');
  });

  it('parses json cues', () => {
    expect(parseJsonCues('{"cues":[{"s":1,"e":2,"t":"好"},{"s":"x","e":2,"t":"坏"}]}')).toEqual([{ from: 1, to: 2, content: '好' }]);
  });

  it('builds a prompt with truncated context', () => {
    const p = buildPrompt({ title: '英雄连3', tags: ['游戏实况'], desc: 'x'.repeat(500) }, 30, 'compact');
    expect(p).toContain('英雄连3');
    expect(p).toContain('开始秒|结束秒|文字');
    expect(p).toContain('x'.repeat(200) + '…');
    expect(p).not.toContain('x'.repeat(201));
  });
});

describe('text', () => {
  it('cleans annotations and final full stop', () => {
    expect(cleanText('[笑声]好的。')).toBe('好的');
    expect(cleanText('（炮火声）冲啊！')).toBe('冲啊！');
    expect(cleanText('真的吗？')).toBe('真的吗？');
  });

  it('converts stray traditional characters', () => {
    expect(toSimplified('這個煙打得真好，我就沒法退回來')).toBe('这个烟打得真好，我就没法退回来');
    expect(cleanText('蘇聯坦克勝利了。')).toBe('苏联坦克胜利了');
    expect(toSimplified('著名')).toBe('著名'); // ambiguous chars are left alone
  });

  it('measures display length', () => {
    expect(displayLength('Tiger坦克')).toBe(4.5);
  });

  it('splits at punctuation first, then hard', () => {
    expect(splitText('我们先把这辆虎式拉到前面去，然后用步兵去侦察一下对面的反坦克炮')).toEqual([
      '我们先把这辆虎式拉到前面去', '然后用步兵去侦察一下对面的反坦克炮',
    ]);
    const long = splitText('一二三四五六七八九十一二三四五六七八九十一二三四五');
    expect(long).toEqual(['一二三四五六七八九十一二三四五六七八九十', '一二三四五']);
    expect(splitText('短句')).toEqual(['短句']);
    const en = splitText('This Tiger tank is the best one we have got today in this match');
    expect(en.length).toBeGreaterThan(1);
    for (const p of en) {
      expect(displayLength(p)).toBeLessThanOrEqual(20);
      expect(p.trim()).not.toBe('');
    }
    expect(en.join(' ')).toBe('This Tiger tank is the best one we have got today in this match');
  });

  it('distributes time proportionally when splitting cues', () => {
    const out = splitLong([{ from: 0, to: 10, content: '一二三四五六七八九十，一二三四五六七八九十' }], 10);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ from: 0, content: '一二三四五六七八九十' });
    expect(out[0].to).toBeCloseTo(5);
    expect(out[1].to).toBe(10);
  });

  it('sanitizes times', () => {
    const s = sanitize([
      { from: 5, to: 3, content: '反了' },
      { from: 29.9, to: 40, content: '越界' },
      { from: 1, to: 1, content: '[笑声]' },
      { from: 10, to: 10, content: '零长度' },
    ], 30);
    expect(s.map((c) => c.content)).toEqual(['反了', '零长度', '越界']);
    expect(s[0]).toMatchObject({ from: 3, to: 5 });
    expect(s[1].from).toBe(10);
    expect(s[1].to).toBeGreaterThan(10.3);
    expect(s[2]).toMatchObject({ from: 29.9, to: 30 });
  });
});

describe('mergeChunk', () => {
  it('resolves overlap duplicates by ownership and similarity', () => {
    const old = [
      { from: 20, to: 23, content: '第一句话' },
      { from: 26, to: 29.9, content: '这句被切' }, // truncated at chunk end (overlap 25-30)
    ];
    const neu = [
      { from: 25.8, to: 28.5, content: '这句被切断了' },
      { from: 29, to: 32, content: '下一句' },
    ];
    const m = mergeChunk(old, neu, 25, 30);
    expect(m.map((c) => c.content)).toEqual(['第一句话', '这句被切断了', '下一句']);
  });

  it('handles an earlier chunk arriving after the later one', () => {
    // later chunk (already merged) heard 25-30 as its leading overlap; earlier chunk arrives now
    const later = [{ from: 25.2, to: 26.5, content: '错听的半句' }, { from: 29, to: 32, content: '下一句' }];
    const earlier = [{ from: 20, to: 23, content: '第一句话' }, { from: 25, to: 26.8, content: '完整的一句' }];
    const m = mergeChunkWindows(later, earlier, [{ start: 25, end: 30, incomingIsLater: false }]);
    expect(m.map((c) => c.content)).toEqual(['第一句话', '完整的一句', '下一句']);
  });

  it('keeps distinct cues and removes time overlaps', () => {
    const m = mergeChunk([{ from: 0, to: 3, content: '甲' }], [{ from: 2, to: 4, content: '完全不同的话' }]);
    expect(m).toHaveLength(2);
    expect(m[0].to).toBe(2);
  });

  // Seen in Chrome 2026-11-11 (BV1VXGL6KE9D 16:17-16:22): one chunk's long line was split
  // mid-phrase by splitLong, the neighbouring chunk heard the phrase whole.
  const splitRun = [
    { from: 977.6, to: 979.2, content: '我尽力了，兄弟们。我这边我也不' },
    { from: 979.2, to: 981.8, content: '知道能打多久，能打多久打多久吧，' },
    { from: 981.9, to: 982.6, content: '我尽力了' },
  ];
  const whole = { from: 979.0, to: 980.6, content: '我这边我也不知道能打多久' };

  it('drops an incoming phrase already spread across existing split cues', () => {
    const m = mergeChunkWindows(splitRun, [whole], [{ start: 977.6, end: 982.6, incomingIsLater: true }]);
    expect(m.map((c) => c.content)).toEqual(splitRun.map((c) => c.content));
  });

  it('drops an existing phrase the incoming chunk carries across split cues', () => {
    const m = mergeChunkWindows([whole], splitRun, [{ start: 977.6, end: 982.6, incomingIsLater: false }]);
    expect(m.map((c) => c.content)).toEqual(splitRun.map((c) => c.content));
    for (let i = 1; i < m.length; i++) expect(m[i].from).toBeGreaterThanOrEqual(m[i - 1].to);
  });

  it('keeps a repeated phrase away from chunk seams', () => {
    const m = mergeChunkWindows(splitRun, [whole], []);
    expect(m.map((c) => c.content)).toContain(whole.content);
  });

  it('similarity sanity', () => {
    expect(similarity('我们开始吧', '我们开始吧！')).toBe(1);
    expect(similarity('完全不同', '风马牛')).toBe(0);
  });
});

describe('intervals', () => {
  it('merges and finds gaps', () => {
    let l = addInterval([], [10, 20]);
    l = addInterval(l, [30, 40]);
    l = addInterval(l, [19, 31]);
    expect(l).toEqual([[10, 40]]);
    l = addInterval(l, [0, 5]);
    expect(l).toEqual([[0, 5], [10, 40]]);
    expect(gaps(l, 0, 50)).toEqual([[5, 10], [40, 50]]);
    expect(gaps(l, 12, 30)).toEqual([]);
    expect(covers(l, 4.9)).toBe(true);
    expect(covers(l, 5)).toBe(false);
    expect(coveredUntil(l, 12)).toBe(40);
    expect(coveredUntil(l, 7)).toBe(7);
  });
});
