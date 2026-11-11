/**
 * Transcript cache in IndexedDB. Lives in the background service worker so it
 * uses the extension's origin, not bilibili.com's (page scripts can't read it).
 */
import type { Interval } from '../subs/intervals';
import type { Cue } from '../transcriber/types';

export interface TrackRecord {
  key: string;
  bvid?: string;
  cid: number;
  model: string;
  promptVersion: string;
  cues: Cue[];
  /** Video-time intervals already transcribed (including silent stretches). */
  covered: Interval[];
  updatedAt: number;
}

export function cacheKey(p: { bvid?: string; cid: number; model: string; promptVersion: string }): string {
  return `${p.bvid ?? ''}:${p.cid}:${p.model}:${p.promptVersion}`;
}

const DB = 'bilisub';
const STORE = 'tracks';
let dbp: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'key' });
      s.createIndex('updatedAt', 'updatedAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbp = undefined;
      reject(req.error);
    };
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const cache = {
  get: (key: string) => tx<TrackRecord | undefined>('readonly', (s) => s.get(key)),
  put: (rec: TrackRecord) => tx('readwrite', (s) => s.put(rec)),
  clear: () => tx('readwrite', (s) => s.clear()),
  count: () => tx<number>('readonly', (s) => s.count()),
};
