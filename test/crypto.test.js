import { describe, it, expect } from 'vitest';
import { deriveKey, encryptBytes, decryptBytes } from '../src/crypto.js';

describe('crypto', () => {
  it('deriveKey returns a CryptoKey', async () => {
    const key = await deriveKey('test-passphrase');
    expect(key).toBeTruthy();
    expect(typeof key).toBe('object');
    // CryptoKey has a type property
    expect(key.type).toBe('secret');
  });

  it('encryptBytes + decryptBytes round-trips', async () => {
    const key     = await deriveKey('my-password');
    const plain   = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const cipher  = await encryptBytes(key, plain);
    const result  = await decryptBytes(key, cipher);
    expect(Array.from(result)).toEqual(Array.from(plain));
  });

  it('encrypted output includes 12-byte IV prefix', async () => {
    const key    = await deriveKey('pass');
    const plain  = new Uint8Array([0xAA, 0xBB]);
    const cipher = await encryptBytes(key, plain);
    // AES-GCM ciphertext = IV(12) + ciphertext(plainLen) + tag(16)
    expect(cipher.length).toBe(12 + plain.length + 16);
  });

  it('decryptBytes with wrong key returns null', async () => {
    const key1   = await deriveKey('correct-password');
    const key2   = await deriveKey('wrong-password');
    const plain  = new Uint8Array([0x01, 0x02, 0x03]);
    const cipher = await encryptBytes(key1, plain);
    const result = await decryptBytes(key2, cipher);
    expect(result).toBeNull();
  });

  it('two encryptions of same plaintext produce different ciphertexts (random IV)', async () => {
    const key    = await deriveKey('pass');
    const plain  = new Uint8Array([0x01, 0x02, 0x03]);
    const c1     = await encryptBytes(key, plain);
    const c2     = await encryptBytes(key, plain);
    // IVs should differ (random)
    expect(Array.from(c1.slice(0, 12))).not.toEqual(Array.from(c2.slice(0, 12)));
  });
});
