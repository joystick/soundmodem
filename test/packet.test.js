import { describe, it, expect } from 'vitest';
import { encodePacket, decodePacket, FILE_MAGIC, CHUNK_SIZE } from '../src/packet.js';

describe('encodePacket / decodePacket', () => {
  it('FILE_MAGIC is [0xFE, 0xFF]', () => {
    expect(FILE_MAGIC).toEqual([0xFE, 0xFF]);
  });

  it('CHUNK_SIZE is 3500', () => {
    expect(CHUNK_SIZE).toBe(3500);
  });

  it('single fragment round-trips data', () => {
    const xferId = new Uint8Array([0x12, 0x34]);
    const data   = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const payload = encodePacket({ xferId, seq: 0, total: 1, filename: 'test.txt', data });
    const decoded = decodePacket(payload);

    expect(decoded).not.toBeNull();
    expect(decoded.seq).toBe(0);
    expect(decoded.total).toBe(1);
    expect(decoded.filename).toBe('test.txt');
    expect(Array.from(decoded.data)).toEqual(Array.from(data));
  });

  it('non-first fragment has no filename', () => {
    const xferId  = new Uint8Array([0xAB, 0xCD]);
    const data    = new Uint8Array([0x10, 0x20]);
    const payload = encodePacket({ xferId, seq: 1, total: 3, data });
    const decoded = decodePacket(payload);

    expect(decoded).not.toBeNull();
    expect(decoded.seq).toBe(1);
    expect(decoded.total).toBe(3);
    expect(decoded.filename).toBeNull();
    expect(Array.from(decoded.data)).toEqual(Array.from(data));
  });

  it('decodePacket returns null for wrong magic', () => {
    const bad = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);
    expect(decodePacket(bad)).toBeNull();
  });

  it('decodePacket returns null for too-short input', () => {
    expect(decodePacket(new Uint8Array([0xFE, 0xFF, 0x00]))).toBeNull();
  });

  it('decodePacket returns null for null input', () => {
    expect(decodePacket(null)).toBeNull();
  });

  it('xferId is encoded as hex string in decoded result', () => {
    const xferId = new Uint8Array([0xAB, 0xCD]);
    const data   = new Uint8Array([0xFF]);
    const payload = encodePacket({ xferId, seq: 1, total: 2, data });
    const decoded = decodePacket(payload);
    expect(decoded.xferId).toBe('abcd');
  });

  it('encodes FILE_MAGIC bytes at start of payload', () => {
    const xferId = new Uint8Array([0x01, 0x02]);
    const data   = new Uint8Array([0x00]);
    const payload = encodePacket({ xferId, seq: 0, total: 1, data });
    expect(payload[0]).toBe(0xFE);
    expect(payload[1]).toBe(0xFF);
  });
});
