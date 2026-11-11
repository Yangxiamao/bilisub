import { describe, expect, it } from 'vitest';
import { joinWords, parseDuration, wordsToCues } from '../src/subs/words';

describe('words', () => {
  it('groups by punctuation and pauses', () => {
    const w = (word: string, start: number, end: number) => ({ word, start, end });
    const cues = wordsToCues([
      w('我们', 0, 0.3), w('先', 0.3, 0.5), w('上。', 0.5, 0.8),
      w('Tiger', 1.0, 1.4), w('坦克', 1.4, 1.8),
      w('然后', 3.0, 3.3), w('撤退', 3.3, 3.7),
    ]);
    expect(cues).toEqual([
      { from: 0, to: 0.8, content: '我们先上' },
      { from: 1.0, to: 1.8, content: 'Tiger坦克' },
      { from: 3.0, to: 3.7, content: '然后撤退' },
    ]);
  });

  it('joins latin words with spaces', () => {
    expect(joinWords(['Panzer', 'IV', '来了'])).toBe('Panzer IV来了');
  });

  it('parses duration strings', () => {
    expect(parseDuration('0.100s')).toBe(0.1);
    expect(parseDuration(undefined)).toBeNaN();
  });
});
