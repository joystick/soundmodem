import { describe, it, expect } from 'vitest';
import { createDemodulator } from '../src/demodulate.js';

describe('createDemodulator', () => {
  it('returns object with cpuProcessChunk and reset', () => {
    const dem = createDemodulator();
    expect(typeof dem.cpuProcessChunk).toBe('function');
    expect(typeof dem.reset).toBe('function');
  });

  it('feeding silence produces no messages', () => {
    const messages = [];
    const dem = createDemodulator({ onMessage: m => messages.push(m) });
    const silence = new Float32Array(4096); // all zeros
    dem.cpuProcessChunk(silence);
    expect(messages).toHaveLength(0);
  });

  it('reset clears internal state', () => {
    const dem = createDemodulator();
    const noise = new Float32Array(4096).map(() => Math.random() * 2 - 1);
    dem.cpuProcessChunk(noise);
    dem.reset();
    // After reset, demodBits should be empty
    expect(dem._getDemodBits()).toHaveLength(0);
  });
});
