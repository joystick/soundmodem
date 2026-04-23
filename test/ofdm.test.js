import { describe, it, expect } from 'vitest';
import { ofdmModulate, ofdmDemodulateRaw, OFDM_N, OFDM_CP, OFDM_DATA_CARRIERS, OFDM_PILOT_BINS } from '../src/ofdm.js';

describe('ofdmModulate', () => {
  it('output length equals (N + CP) * numSymbols', () => {
    const bits = Array.from({ length: 52 }, (_, i) => i % 2 === 0);
    const audio = ofdmModulate(bits);
    const numSymbols = Math.ceil(bits.length / OFDM_DATA_CARRIERS.length);
    expect(audio).toBeInstanceOf(Float32Array);
    expect(audio.length).toBe((OFDM_N + OFDM_CP) * numSymbols);
  });
});

describe('ofdmModulate pilot tones', () => {
  it('guard band bins (0–5 and 59+) carry no energy', () => {
    const bits = new Array(OFDM_DATA_CARRIERS.length).fill(true);
    const audio = ofdmModulate(bits);

    // Reconstruct spectrum of first symbol (skip CP)
    const re = new Float64Array(OFDM_N);
    const im = new Float64Array(OFDM_N);
    for (let i = 0; i < OFDM_N; i++) re[i] = audio[OFDM_CP + i];

    // inline DFT magnitude check for guard bins only (small set — not full FFT)
    const guardBins = [...Array.from({ length: 6 }, (_, i) => i),          // 0–5
                       ...Array.from({ length: OFDM_N / 2 - 58 }, (_, i) => 59 + i)]; // 59+
    for (const b of guardBins) {
      let sumRe = 0, sumIm = 0;
      for (let n = 0; n < OFDM_N; n++) {
        const angle = (2 * Math.PI * b * n) / OFDM_N;
        sumRe += re[n] * Math.cos(angle);
        sumIm -= re[n] * Math.sin(angle);
      }
      const mag = Math.sqrt(sumRe ** 2 + sumIm ** 2) / OFDM_N;
      expect(mag).toBeLessThan(1e-9);
    }
  });
});

describe('ofdmDemodulateRaw', () => {
  it('noiseless loopback recovers original bits exactly', () => {
    const bits = Array.from({ length: 104 }, (_, i) => (i * 7 + 3) % 3 !== 0);
    const recovered = ofdmDemodulateRaw(ofdmModulate(bits));
    // recovered may be padded to a symbol boundary — check original slice
    expect(recovered.slice(0, bits.length)).toEqual(bits);
  });

  it('recovers payload when bit count is not a multiple of DATA_CARRIERS', () => {
    // 70 bits — not divisible by 52, so last symbol is partly zero-padded
    const bits = Array.from({ length: 70 }, (_, i) => i % 3 !== 1);
    const recovered = ofdmDemodulateRaw(ofdmModulate(bits));
    expect(recovered.slice(0, bits.length)).toEqual(bits);
  });
});
