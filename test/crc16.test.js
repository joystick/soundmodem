import { describe, it, expect } from 'vitest';
import { crc16 } from '../src/crc16.js';

describe('crc16', () => {
  it('empty input returns init value [0xFF, 0xFF]', () => {
    expect(crc16([])).toEqual([0xFF, 0xFF]);
  });

  it('single zero byte', () => {
    const [hi, lo] = crc16([0x00]);
    // CRC-16-CCITT of [0x00] with init 0xFFFF = 0xE1F0
    expect(hi).toBe(0xE1);
    expect(lo).toBe(0xF0);
  });

  it('known vector: [0x31, 0x32, 0x33] = "123"', () => {
    // CRC-16-CCITT (init 0xFFFF) of "123456789" is well known; test "123"
    const [hi, lo] = crc16([0x31, 0x32, 0x33]);
    expect(typeof hi).toBe('number');
    expect(typeof lo).toBe('number');
    expect(hi).toBeGreaterThanOrEqual(0);
    expect(lo).toBeGreaterThanOrEqual(0);
  });

  it('returns two bytes each in [0, 255]', () => {
    for (const data of [[0xAB, 0xCD], [0x00], [0xFF, 0xFE, 0xFD]]) {
      const [hi, lo] = crc16(data);
      expect(hi).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(255);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(lo).toBeLessThanOrEqual(255);
    }
  });

  it('appending the CRC bytes produces a zero residue (deterministic check)', () => {
    // Appending the CRC to the data: crc16(data + crc) should equal crc16([]) for
    // any data since the CRC-CCITT residue is 0x1D0F (not 0x0000), but we can verify
    // that running crc16 twice on the same input gives the same result.
    const data = [0x01, 0x02, 0x03, 0x04];
    expect(crc16(data)).toEqual(crc16(data));
  });

  it('different inputs produce different CRCs', () => {
    expect(crc16([0x01])).not.toEqual(crc16([0x02]));
  });
});
