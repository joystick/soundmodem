import { describe, it, expect } from 'vitest';
import { ofdmEncodeFrame } from '../src/ofdm.js';
import { createOfdmDemodulator } from '../src/ofdm-demodulate.js';

describe('createOfdmDemodulator', () => {
  it('returns an object with processChunk and reset methods', () => {
    const demod = createOfdmDemodulator({ onMessage: () => {}, onFilePacket: () => {} });
    expect(typeof demod.processChunk).toBe('function');
    expect(typeof demod.reset).toBe('function');
  });

  it('AFC: ±5 Hz carrier offset still decodes correctly', () => {
    const received = [];
    const demod = createOfdmDemodulator({ onMessage: t => received.push(t), onFilePacket: () => {} });

    const audio = ofdmEncodeFrame('AFC test');
    // Apply a 5 Hz frequency shift: multiply each sample by e^{j 2π·5·n/44100}
    const SAMPLE_RATE = 44100;
    const shifted = new Float32Array(audio.length);
    for (let n = 0; n < audio.length; n++) {
      shifted[n] = audio[n] * Math.cos(2 * Math.PI * 5 * n / SAMPLE_RATE);
    }

    demod.processChunk(shifted);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe('AFC test');
  });

  it('end-to-end loopback: encodeFrame → processChunk → onMessage fires with original text', () => {
    const received = [];
    const demod = createOfdmDemodulator({ onMessage: t => received.push(t), onFilePacket: () => {} });

    const audio = ofdmEncodeFrame('hello OFDM');
    demod.processChunk(audio);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe('hello OFDM');
  });
});
