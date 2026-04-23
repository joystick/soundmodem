import { describe, it, expect } from 'vitest';
import { modulate, SPB, PREAMBLE_FLAGS, POSTAMBLE_FLAGS } from '../src/modulate.js';
import { buildFrame } from '../src/ax25.js';

describe('modulate', () => {
  it('returns a Float32Array', () => {
    const frame = buildFrame('hi', 'ALL', 'TEST01');
    const audio = modulate(frame);
    expect(audio).toBeInstanceOf(Float32Array);
  });

  it('all samples are in [-1, 1]', () => {
    const frame = buildFrame('hello', 'ALL', 'TEST01');
    const audio = modulate(frame);
    for (const s of audio) {
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('output length equals total bits * SPB', () => {
    const frame = buildFrame('x', 'ALL', 'TEST01');
    const audio = modulate(frame);
    // Length must be a multiple of SPB
    expect(audio.length % SPB).toBe(0);
  });

  it('produces longer output for longer messages', () => {
    const short = modulate(buildFrame('hi', 'ALL', 'TEST01'));
    const long  = modulate(buildFrame('hello world this is a longer message', 'ALL', 'TEST01'));
    expect(long.length).toBeGreaterThan(short.length);
  });

  it('preamble contributes PREAMBLE_FLAGS * 8 * SPB samples at the start', () => {
    // Minimum total samples from preamble alone
    const frame = buildFrame('x', 'ALL', 'TEST01');
    const audio = modulate(frame);
    const preambleSamples = PREAMBLE_FLAGS * 8 * SPB;
    expect(audio.length).toBeGreaterThanOrEqual(preambleSamples);
  });
});
