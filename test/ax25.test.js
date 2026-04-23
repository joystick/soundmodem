import { describe, it, expect } from 'vitest';
import { bitStuff, encodeCallsign, buildFrame, buildFrameRaw } from '../src/ax25.js';
import { crc16 } from '../src/crc16.js';

describe('bitStuff', () => {
  it('inserts 0 after exactly 5 consecutive 1s', () => {
    const input  = [1, 1, 1, 1, 1];
    const result = bitStuff(input);
    expect(result).toEqual([1, 1, 1, 1, 1, 0]);
  });

  it('inserts 0 after 5 consecutive 1s in a longer sequence', () => {
    const input  = [1, 1, 1, 1, 1, 1]; // 6 ones
    const result = bitStuff(input);
    // After 5 ones insert 0; the 6th one follows
    expect(result).toEqual([1, 1, 1, 1, 1, 0, 1]);
  });

  it('does not insert after 4 consecutive ones', () => {
    const input  = [1, 1, 1, 1];
    expect(bitStuff(input)).toEqual([1, 1, 1, 1]);
  });

  it('resets count on 0', () => {
    const input  = [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1];
    const result = bitStuff(input);
    // First run of 5 ones → insert 0; then a 0; then another 5 ones → insert 0
    expect(result).toEqual([1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0]);
  });

  it('passes through empty input', () => {
    expect(bitStuff([])).toEqual([]);
  });
});

describe('encodeCallsign', () => {
  it('encodes ALL (non-last) to 7 bytes with each ASCII char shifted left 1', () => {
    const enc = encodeCallsign('ALL', false);
    expect(enc.length).toBe(7);
    // 'A'=65 → 130, 'L'=76 → 152, ' '=32 → 64
    expect(enc[0]).toBe('A'.charCodeAt(0) << 1);
    expect(enc[1]).toBe('L'.charCodeAt(0) << 1);
    expect(enc[2]).toBe('L'.charCodeAt(0) << 1);
    // Padded with spaces
    expect(enc[3]).toBe(' '.charCodeAt(0) << 1);
    // SSID byte: not last → 0x60
    expect(enc[6]).toBe(0x60);
  });

  it('sets last bit in SSID byte when isLast=true', () => {
    const enc = encodeCallsign('TEST01', true);
    expect(enc[6]).toBe(0x61);
  });

  it('pads short callsign to 6 chars', () => {
    const enc = encodeCallsign('AB', false);
    expect(enc.length).toBe(7);
    expect(enc[2]).toBe(' '.charCodeAt(0) << 1); // padded space
  });
});

describe('buildFrame', () => {
  it('starts and ends with 0x7E flag', () => {
    const frame = buildFrame('hello', 'ALL', 'TEST01');
    expect(frame[0]).toBe(0x7E);
    expect(frame[frame.length - 1]).toBe(0x7E);
  });

  it('contains CTRL=0x03 and PID=0xF0 at correct positions', () => {
    const frame = buildFrame('hello', 'ALL', 'TEST01');
    // Frame: [0x7E, DST(7), SRC(7), CTRL, PID, DATA..., CRC(2), 0x7E]
    // CTRL at index 1+7+7=15, PID at 16
    expect(frame[15]).toBe(0x03);
    expect(frame[16]).toBe(0xF0);
  });

  it('CRC validates: crc16 of frame content (excl flags and CRC) matches appended bytes', () => {
    const frame   = buildFrame('test', 'ALL', 'TEST01');
    // content = frame[1..-2] (between the two 0x7E flags)
    const content = frame.slice(1, -1);
    // The last two bytes of content are the CRC
    const data    = content.slice(0, -2);
    const [eH, eL] = crc16(data);
    expect(content[content.length - 2]).toBe(eH);
    expect(content[content.length - 1]).toBe(eL);
  });

  it('encodes message text in the data field', () => {
    const msg   = 'hello world';
    const frame = buildFrame(msg, 'ALL', 'TEST01');
    // DATA starts at index 17 (1+7+7+1+1), ends before CRC+flag = -3
    const data = new TextDecoder().decode(new Uint8Array(frame.slice(17, -3)));
    expect(data).toBe(msg);
  });
});

describe('buildFrameRaw', () => {
  it('starts and ends with 0x7E', () => {
    const frame = buildFrameRaw(new Uint8Array([0x01, 0x02, 0x03]), 'ALL', 'TEST01');
    expect(frame[0]).toBe(0x7E);
    expect(frame[frame.length - 1]).toBe(0x7E);
  });

  it('CRC validates', () => {
    const frame   = buildFrameRaw(new Uint8Array([0xAA, 0xBB]), 'ALL', 'TEST01');
    const content = frame.slice(1, -1);
    const data    = content.slice(0, -2);
    const [eH, eL] = crc16(data);
    expect(content[content.length - 2]).toBe(eH);
    expect(content[content.length - 1]).toBe(eL);
  });
});
