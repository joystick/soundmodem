import { describe, it, expect } from 'vitest';
import { compress, decompress } from '../src/compress.js';

describe('compress / decompress', () => {
  it('round-trips identical data', async () => {
    const original    = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const compressed  = await compress(original);
    const decompressed = await decompress(compressed);
    expect(Array.from(decompressed)).toEqual(Array.from(original));
  });

  it('round-trips empty data', async () => {
    const original     = new Uint8Array([]);
    const compressed   = await compress(original);
    const decompressed = await decompress(compressed);
    expect(Array.from(decompressed)).toEqual([]);
  });

  it('compressed output is smaller for repetitive data', async () => {
    const repetitive = new Uint8Array(1000).fill(0x41); // 1000 'A's
    const compressed = await compress(repetitive);
    expect(compressed.length).toBeLessThan(repetitive.length);
  });

  it('round-trips text data', async () => {
    const text  = 'Hello, SoundModem! '.repeat(50);
    const bytes = new TextEncoder().encode(text);
    const compressed   = await compress(bytes);
    const decompressed = await decompress(compressed);
    expect(new TextDecoder().decode(decompressed)).toBe(text);
  });
});
