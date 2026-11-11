/** Sorted, non-overlapping [start, end) intervals in seconds. */
export type Interval = [number, number];

const EPS = 1e-6;

export function addInterval(list: Interval[], iv: Interval): Interval[] {
  const [s, e] = iv;
  if (!(e > s)) return list;
  const out: Interval[] = [];
  let cur: Interval = [s, e];
  let placed = false;
  for (const x of list) {
    if (x[1] < cur[0] - EPS) out.push(x);
    else if (x[0] > cur[1] + EPS) {
      if (!placed) { out.push(cur); placed = true; }
      out.push(x);
    } else cur = [Math.min(cur[0], x[0]), Math.max(cur[1], x[1])];
  }
  if (!placed) out.push(cur);
  return out;
}

/** Parts of [s, e) not covered by `list`. */
export function gaps(list: Interval[], s: number, e: number): Interval[] {
  const out: Interval[] = [];
  let t = s;
  for (const [a, b] of list) {
    if (b <= t + EPS) continue;
    if (a >= e - EPS) break;
    if (a > t + EPS) out.push([t, Math.min(a, e)]);
    t = Math.max(t, b);
    if (t >= e - EPS) break;
  }
  if (t < e - EPS) out.push([t, e]);
  return out;
}

export function covers(list: Interval[], t: number): boolean {
  return list.some(([a, b]) => a <= t + EPS && t < b - EPS);
}

/** End of the covered run containing t (or t itself if uncovered). */
export function coveredUntil(list: Interval[], t: number): number {
  for (const [a, b] of list) if (a <= t + EPS && t < b) return b;
  return t;
}
