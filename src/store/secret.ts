/**
 * The Gemini API key, encrypted at rest (AES-GCM, 256-bit).
 *
 * The AES key is a non-extractable CryptoKey kept in the extension origin's
 * IndexedDB, so only extension pages (background, options) can decrypt.
 * Content scripts run in bilibili.com's origin: they see the ciphertext in
 * chrome.storage.local but never the key itself.
 */
import { fromBase64, toBase64 } from '../util/base64';

export interface EncBlob {
  v: 1;
  /** base64, 12 random bytes per encryption */
  iv: string;
  /** base64 ciphertext + GCM tag */
  ct: string;
}

export class ApiKeyUnreadableError extends Error {
  constructor(cause?: unknown) {
    super('saved API key could not be decrypted');
    this.name = 'ApiKeyUnreadableError';
    this.cause = cause;
  }
}

// --- pure crypto (unit-tested) ---------------------------------------------------

export function newDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptWith(key: CryptoKey, plain: string): Promise<EncBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  return { v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Throws if the blob was tampered with or encrypted under another key. */
export async function decryptWith(key: CryptoKey, blob: EncBlob): Promise<string> {
  if (blob?.v !== 1) throw new Error(`unknown blob version ${String(blob?.v)}`);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(fromBase64(blob.iv)) },
    key,
    new Uint8Array(fromBase64(blob.ct)),
  );
  return new TextDecoder().decode(pt);
}

// --- device key in IndexedDB (extension origin only) ------------------------------

const DB = 'bilisub-secret';
const STORE = 'keys';
const ID = 'device';
let keyp: Promise<CryptoKey> | undefined;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb<T>(d: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r.result as T);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function loadOrCreateDeviceKey(): Promise<CryptoKey> {
  const d = await openDb();
  try {
    const existing = await idb<CryptoKey | undefined>(d, 'readonly', (s) => s.get(ID));
    if (existing) return existing;
    const fresh = await newDeviceKey();
    try {
      await idb(d, 'readwrite', (s) => s.add(fresh, ID));
      return fresh;
    } catch {
      // Another extension page created it first (ConstraintError): use theirs.
      const winner = await idb<CryptoKey | undefined>(d, 'readonly', (s) => s.get(ID));
      if (!winner) throw new Error('device key missing after race');
      return winner;
    }
  } finally {
    d.close();
  }
}

function deviceKey(): Promise<CryptoKey> {
  keyp ??= loadOrCreateDeviceKey().catch((e) => {
    keyp = undefined;
    throw e;
  });
  return keyp;
}

// --- API key in chrome.storage.local ---------------------------------------------

let memo: { iv: string; plain: string } | undefined;

/** Empty string removes the key. */
export async function saveApiKey(plain: string): Promise<void> {
  if (!plain) {
    memo = undefined;
    await browser.storage.local.remove(['apiKeyEnc', 'apiKey']);
    return;
  }
  const blob = await encryptWith(await deviceKey(), plain);
  await browser.storage.local.set({ apiKeyEnc: blob });
  await browser.storage.local.remove('apiKey');
  memo = { iv: blob.iv, plain };
}

/**
 * '' when no key is saved. Throws ApiKeyUnreadableError when a saved key can't
 * be decrypted (e.g. the device key was lost); the user has to enter it again.
 */
export async function loadApiKey(): Promise<string> {
  const s = await browser.storage.local.get(['apiKeyEnc', 'apiKey']);
  const blob = s.apiKeyEnc as EncBlob | undefined;
  if (!blob) {
    const legacy = typeof s.apiKey === 'string' ? s.apiKey : '';
    if (legacy) await saveApiKey(legacy);
    return legacy;
  }
  if (memo?.iv === blob.iv) return memo.plain;
  try {
    const plain = await decryptWith(await deviceKey(), blob);
    memo = { iv: blob.iv, plain };
    return plain;
  } catch (e) {
    throw new ApiKeyUnreadableError(e);
  }
}

/** Encrypt a plain-text key left by version 0.1.0, if any. */
export async function migratePlainApiKey(): Promise<boolean> {
  const s = await browser.storage.local.get('apiKey');
  if (typeof s.apiKey !== 'string') return false;
  await saveApiKey(s.apiKey); // '' just removes the stale field
  return true;
}
