/**
 * Look-ahead scheduling over DASH fragments (pure, unit-tested).
 *
 * Work is planned in fragment units (~5 s each on Bilibili). A job covers
 * fragments [first..last]; when the fragment before `newFirst` is already
 * done or in flight, the job also re-transcribes it (`first = newFirst - 1`)
 * so sentences cut at a chunk edge are heard whole once; mergeChunk() then
 * dedupes that overlap.
 */
export interface Frag {
  start: number;
  duration: number;
}

export interface Job {
  /** First fragment fetched (may be an overlap fragment). */
  first: number;
  /** First fragment this job is responsible for. */
  newFirst: number;
  last: number;
  urgent: boolean;
}

export interface PlanInput {
  frags: Frag[];
  /** Fragment fully transcribed (or cached). */
  done: ArrayLike<boolean>;
  /** Fragment owned by an in-flight job. */
  pending: ArrayLike<boolean>;
  currentTime: number;
  /** Seconds of video to keep transcribed ahead of the playhead. */
  lookahead: number;
  inFlight: number;
  maxInFlight: number;
  shortFrags?: number;
  longFrags?: number;
}

export function fragAt(frags: Frag[], t: number): number {
  if (!frags.length) return -1;
  let lo = 0;
  let hi = frags.length - 1;
  if (t <= frags[0].start) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frags[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function planJobs(p: PlanInput): Job[] {
  const { frags, done, currentTime, lookahead } = p;
  const short = p.shortFrags ?? 2;
  const long = p.longFrags ?? 6;
  let slots = p.maxInFlight - p.inFlight;
  if (slots <= 0 || !frags.length) return [];

  const busy = Array.from({ length: frags.length }, (_, i) => !!done[i] || !!p.pending[i]);
  const cur = fragAt(frags, currentTime);
  const endIdx = fragAt(frags, currentTime + lookahead);
  const playheadCovered = !!done[cur];
  const jobs: Job[] = [];

  for (let f = cur; f <= endIdx && slots > 0; f++) {
    if (busy[f]) continue;
    // Nothing under the playhead yet: start with a short chunk so the first
    // subtitle shows up fast, then switch to long (cheaper per token of prompt).
    const urgent = !playheadCovered && f <= cur + 1 && !jobs.length;
    const n = urgent ? short : long;
    let last = f;
    while (last + 1 < frags.length && last - f + 1 < n && !busy[last + 1]) last++;
    const overlap = f > 0 && busy[f - 1];
    for (let i = f; i <= last; i++) busy[i] = true;
    jobs.push({ first: overlap ? f - 1 : f, newFirst: f, last, urgent });
    slots--;
    f = last;
  }
  return jobs;
}

/** In-flight jobs that no longer matter after a seek. */
export function isStale(job: Job, frags: Frag[], currentTime: number, lookahead: number): boolean {
  const cur = fragAt(frags, currentTime);
  const endIdx = fragAt(frags, currentTime + lookahead);
  return job.last < cur || job.newFirst > endIdx + 1;
}

/** Mark fragments fully inside covered time intervals as done (cache restore). */
export function doneFromIntervals(frags: Frag[], covered: Array<[number, number]>): boolean[] {
  return frags.map((f) => covered.some(([a, b]) => a <= f.start + 0.01 && f.start + f.duration <= b + 0.01));
}

/** How far ahead of `t` is contiguously done (seconds of video time). */
export function bufferedAhead(frags: Frag[], done: ArrayLike<boolean>, t: number): number {
  let i = fragAt(frags, t);
  if (i < 0 || !done[i]) return 0;
  while (i + 1 < frags.length && done[i + 1]) i++;
  return frags[i].start + frags[i].duration - t;
}
