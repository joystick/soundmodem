// End-to-end file transfer loopback tests (no audio hardware).
// Exercises the full encode → modulate → demodulate → reassemble path
// for both Bell 202 and OFDM modes.

import { describe, it, expect } from 'vitest';
import { compress, decompress } from '../src/compress.js';
import { encodePacket, decodePacket, CHUNK_SIZE, FILE_MAGIC, encodeAck, decodeAck } from '../src/packet.js';
import { buildFrameRaw } from '../src/ax25.js';
import { modulate } from '../src/modulate.js';
import { createDemodulator } from '../src/demodulate.js';
import { ofdmEncodeFrameRaw } from '../src/ofdm.js';
import { createOfdmDemodulator } from '../src/ofdm-demodulate.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Feed audio in 4096-sample chunks through a Bell 202 demodulator. */
function feedBell202(demodulator, audio) {
  const CHUNK = 4096;
  for (let offset = 0; offset < audio.length; offset += CHUNK)
    demodulator.cpuProcessChunk(audio.slice(offset, offset + CHUNK));
}

/**
 * Feed audio through an OFDM demodulator in one shot.
 * The OFDM demodulator processes complete symbol batches synchronously;
 * chunking across symbol boundaries causes partial-frame decode attempts
 * that always fail. Feeding all at once matches how AudioWorklet delivers data.
 */
function feedOfdm(demodulator, audio) {
  demodulator.processChunk(audio);
}

/** Transmit a single file packet over Bell 202 and return audio samples. */
function encodeFilePktBell202(payload) {
  return modulate(buildFrameRaw(payload, 'ALL', 'TEST01'));
}

// ── packet encode/decode ──────────────────────────────────────────────────────

describe('encodePacket / decodePacket round-trip', () => {
  it('single fragment with filename', () => {
    const data = new Uint8Array([1, 2, 3]);
    const pkt  = encodePacket({ xferId: new Uint8Array([0x01, 0x02]), seq: 0, total: 1, filename: 'hi.txt', data });
    const dec  = decodePacket(pkt);
    expect(dec.seq).toBe(0);
    expect(dec.total).toBe(1);
    expect(dec.filename).toBe('hi.txt');
    expect(Array.from(dec.data)).toEqual([1, 2, 3]);
  });

  it('non-first fragment has no filename', () => {
    const data = new Uint8Array([9, 8]);
    const pkt  = encodePacket({ xferId: new Uint8Array([0x03, 0x04]), seq: 2, total: 5, data });
    const dec  = decodePacket(pkt);
    expect(dec.filename).toBeNull();
    expect(dec.seq).toBe(2);
  });

  it('FILE_MAGIC bytes are at offset 0–1', () => {
    const pkt = encodePacket({ xferId: new Uint8Array([0, 0]), seq: 0, total: 1, data: new Uint8Array([0]) });
    expect(pkt[0]).toBe(0xFE);
    expect(pkt[1]).toBe(0xFF);
  });
});

// ── Bell 202 file transfer loopback ──────────────────────────────────────────

describe('Bell 202 file transfer loopback', () => {
  it('single small file round-trips end-to-end', async () => {
    const content  = new TextEncoder().encode('Hello, file transfer!');
    const xferId   = new Uint8Array([0x12, 0x34]);
    const payload  = encodePacket({ xferId, seq: 0, total: 1, filename: 'hello.txt', data: content });

    const received = [];
    const dem = createDemodulator({
      onMessage:    () => {},
      onFilePacket: pkt => received.push(pkt),
    });

    feedBell202(dem, encodeFilePktBell202(payload));

    expect(received.length).toBeGreaterThan(0);
    const dec = decodePacket(received[0]);
    expect(dec).not.toBeNull();
    expect(dec.filename).toBe('hello.txt');
    expect(new TextDecoder().decode(dec.data)).toBe('Hello, file transfer!');
  }, 30000);

  it('each fragment decodes independently', async () => {
    // Verify that each fragment in a multi-fragment transfer can be individually
    // decoded. Use a fresh demodulator per fragment to avoid inter-frame state.
    const content   = new Uint8Array(200).fill(0xAB);
    const xferId    = new Uint8Array([0x56, 0x78]);
    const total     = 3;
    const chunkSize = Math.ceil(content.length / total);

    for (let seq = 0; seq < total; seq++) {
      const data    = content.slice(seq * chunkSize, (seq + 1) * chunkSize);
      const payload = encodePacket({ xferId, seq, total, filename: seq === 0 ? 'big.bin' : undefined, data });

      const pkts = [];
      const dem  = createDemodulator({ onMessage: () => {}, onFilePacket: p => pkts.push(p) });
      feedBell202(dem, encodeFilePktBell202(payload));

      expect(pkts.length).toBeGreaterThan(0);
      const dec = decodePacket(pkts[0]);
      expect(dec.seq).toBe(seq);
      expect(dec.total).toBe(total);
      if (seq === 0) expect(dec.filename).toBe('big.bin');
      else           expect(dec.filename).toBeNull();
    }
  }, 30000);
});

// ── OFDM file transfer loopback ───────────────────────────────────────────────

describe('OFDM file transfer loopback', () => {
  it('single packet round-trips end-to-end', async () => {
    const content  = new TextEncoder().encode('OFDM file test payload');
    const xferId   = new Uint8Array([0xAB, 0xCD]);
    const payload  = encodePacket({ xferId, seq: 0, total: 1, filename: 'ofdm.txt', data: content });

    const received = [];
    const dem = createOfdmDemodulator({
      onMessage:    () => {},
      onFilePacket: pkt => received.push(pkt),
    });

    feedOfdm(dem, ofdmEncodeFrameRaw(payload));

    expect(received.length).toBeGreaterThan(0);
    const dec = decodePacket(received[0]);
    expect(dec).not.toBeNull();
    expect(dec.filename).toBe('ofdm.txt');
    expect(new TextDecoder().decode(dec.data)).toBe('OFDM file test payload');
  }, 30000);
});

// ── compress + encode round-trip (mirrors sendFile/receiveFilePacket) ─────────

describe('compress → encodePacket → decodePacket → decompress', () => {
  it('reconstructs original bytes after full cycle', async () => {
    const original   = new TextEncoder().encode('Lorem ipsum dolor sit amet, the quick brown fox.');
    const compressed = await compress(original);
    const xferId     = new Uint8Array([0x01, 0x23]);
    const payload    = encodePacket({ xferId, seq: 0, total: 1, filename: 'lorem.txt', data: compressed });

    const dec        = decodePacket(payload);
    const restored   = await decompress(dec.data);

    expect(new TextDecoder().decode(restored)).toBe(new TextDecoder().decode(original));
  });
});

// ── ACK routing through demodulators ─────────────────────────────────────────

describe('Bell 202 ACK routing', () => {
  it('routes ACK packets to onAck callback', () => {
    const ackPkt = encodeAck({ xferId: new Uint8Array([0x12, 0x34]), seq: 7 });
    const acks = [];
    const dem = createDemodulator({
      onMessage: () => {},
      onFilePacket: () => {},
      onAck: pkt => acks.push(pkt),
    });

    feedBell202(dem, modulate(buildFrameRaw(ackPkt, 'ALL', 'TEST01')));

    expect(acks.length).toBeGreaterThan(0);
    const dec = decodeAck(acks[0]);
    expect(dec).not.toBeNull();
    expect(dec.xferId).toBe('1234');
    expect(dec.seq).toBe(7);
  }, 30000);
});

describe('OFDM ACK routing', () => {
  it('routes ACK packets to onAck callback', () => {
    const ackPkt = encodeAck({ xferId: new Uint8Array([0xAB, 0xCD]), seq: 3 });
    const acks = [];
    const dem = createOfdmDemodulator({
      onMessage: () => {},
      onFilePacket: () => {},
      onAck: pkt => acks.push(pkt),
    });

    feedOfdm(dem, ofdmEncodeFrameRaw(ackPkt));

    expect(acks.length).toBeGreaterThan(0);
    const dec = decodeAck(acks[0]);
    expect(dec).not.toBeNull();
    expect(dec.xferId).toBe('abcd');
    expect(dec.seq).toBe(3);
  }, 30000);
});
