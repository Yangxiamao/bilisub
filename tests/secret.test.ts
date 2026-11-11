import { describe, expect, it } from 'vitest';
import { decryptWith, encryptWith, newDeviceKey } from '../src/store/secret';
import { fromBase64, toBase64 } from '../src/util/base64';

describe('API key encryption', () => {
  // Deliberately NOT shaped like a real Google API key, so secret scanners stay quiet.
  const KEY = 'test-api-key-not-real-0123456789';

  it('round-trips', async () => {
    const k = await newDeviceKey();
    const blob = await encryptWith(k, KEY);
    expect(blob.v).toBe(1);
    expect(fromBase64(blob.iv).length).toBe(12);
    expect(blob.ct).not.toContain('test-api-key');
    expect(await decryptWith(k, blob)).toBe(KEY);
  });

  it('uses a fresh IV every time', async () => {
    const k = await newDeviceKey();
    const a = await encryptWith(k, KEY);
    const b = await encryptWith(k, KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('rejects tampered ciphertext', async () => {
    const k = await newDeviceKey();
    const blob = await encryptWith(k, KEY);
    const ct = fromBase64(blob.ct);
    ct[0] ^= 1;
    await expect(decryptWith(k, { ...blob, ct: toBase64(ct) })).rejects.toThrow();
  });

  it('rejects another device key', async () => {
    const blob = await encryptWith(await newDeviceKey(), KEY);
    await expect(decryptWith(await newDeviceKey(), blob)).rejects.toThrow();
  });

  it('keeps the device key non-extractable', async () => {
    const k = await newDeviceKey();
    expect(k.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', k)).rejects.toThrow();
  });
});
