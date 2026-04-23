import { describe, it, expect } from 'vitest';
import { buildFrame } from '../src/ax25.js';
import { modulate } from '../src/modulate.js';
import { createDemodulator } from '../src/demodulate.js';

describe('loopback (modulate → demodulate)', () => {
  it('recovers a short text message end-to-end', async () => {
    const message  = 'TEST01>hello';
    const frame    = buildFrame(message, 'ALL', 'TEST01');
    const audio    = modulate(frame);

    const received = [];
    const dem = createDemodulator({ onMessage: m => received.push(m) });

    // Feed audio in chunks matching ScriptProcessor size
    const CHUNK = 4096;
    for (let offset = 0; offset < audio.length; offset += CHUNK) {
      dem.cpuProcessChunk(audio.slice(offset, offset + CHUNK));
    }

    expect(received.length).toBeGreaterThan(0);
    expect(received[0]).toBe(message);
  }, 30000); // allow up to 30s for the CPU demodulator on slow machines

  it('recovers message with special characters', async () => {
    const message = 'K1ABC>ping 123!';
    const frame   = buildFrame(message, 'ALL', 'K1ABC');
    const audio   = modulate(frame);

    const received = [];
    const dem = createDemodulator({ onMessage: m => received.push(m) });

    const CHUNK = 4096;
    for (let offset = 0; offset < audio.length; offset += CHUNK) {
      dem.cpuProcessChunk(audio.slice(offset, offset + CHUNK));
    }

    expect(received.length).toBeGreaterThan(0);
    expect(received[0]).toBe(message);
  }, 30000);
});
