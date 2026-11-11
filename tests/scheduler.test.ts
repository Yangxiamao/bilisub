import { describe, expect, it } from 'vitest';
import { bufferedAhead, doneFromIntervals, fragAt, isStale, planJobs, type Frag } from '../src/core/scheduler';

const frags: Frag[] = Array.from({ length: 100 }, (_, i) => ({ start: i * 5, duration: 5 }));
const none = () => new Array<boolean>(100).fill(false);

describe('scheduler', () => {
  it('finds fragment at time', () => {
    expect(fragAt(frags, 0)).toBe(0);
    expect(fragAt(frags, 4.99)).toBe(0);
    expect(fragAt(frags, 5)).toBe(1);
    expect(fragAt(frags, 9999)).toBe(99);
    expect(fragAt(frags, -3)).toBe(0);
  });

  it('starts with a short urgent chunk, then long chunks', () => {
    const jobs = planJobs({ frags, done: none(), pending: none(), currentTime: 61, lookahead: 120, inFlight: 0, maxInFlight: 2 });
    expect(jobs).toEqual([
      { first: 12, newFirst: 12, last: 13, urgent: true },
      { first: 13, newFirst: 14, last: 19, urgent: false }, // overlaps the urgent chunk by one fragment
    ]);
  });

  it('respects in-flight slots and skips done/pending fragments', () => {
    const done = none();
    for (let i = 12; i <= 19; i++) done[i] = true;
    const pending = none();
    pending[20] = true;
    const jobs = planJobs({ frags, done, pending, currentTime: 61, lookahead: 120, inFlight: 1, maxInFlight: 2 });
    expect(jobs).toEqual([{ first: 20, newFirst: 21, last: 26, urgent: false }]);
  });

  it('stops once the look-ahead window is covered', () => {
    const done = none();
    for (let i = 0; i <= 40; i++) done[i] = true;
    expect(planJobs({ frags, done, pending: none(), currentTime: 10, lookahead: 120, inFlight: 0, maxInFlight: 2 })).toEqual([]);
  });

  it('does not run past the end', () => {
    const jobs = planJobs({ frags, done: none(), pending: none(), currentTime: 492, lookahead: 120, inFlight: 0, maxInFlight: 3 });
    expect(jobs).toEqual([{ first: 98, newFirst: 98, last: 99, urgent: true }]);
  });

  it('flags stale jobs after a seek', () => {
    const job = { first: 11, newFirst: 12, last: 17, urgent: false };
    expect(isStale(job, frags, 60, 120)).toBe(false);
    expect(isStale(job, frags, 300, 120)).toBe(true);
    expect(isStale(job, frags, 0, 30)).toBe(true);
  });

  it('restores done fragments from cached intervals and measures buffer', () => {
    const done = doneFromIntervals(frags, [[10, 30.004]]);
    expect(done.slice(0, 7)).toEqual([false, false, true, true, true, true, false]);
    expect(bufferedAhead(frags, done, 12)).toBe(18);
    expect(bufferedAhead(frags, done, 31)).toBe(0);
  });
});
