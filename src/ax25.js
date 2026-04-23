import { crc16 } from './crc16.js';

export function bitStuff(bits) {
  const out = []; let ones = 0;
  for (const b of bits) {
    out.push(b); ones = b === 1 ? ones + 1 : 0;
    if (ones === 5) { out.push(0); ones = 0; }
  }
  return out;
}

export function encodeCallsign(cs, isLast) {
  const bytes = cs.toUpperCase().padEnd(6, ' ').split('').map(c => c.charCodeAt(0) << 1);
  bytes.push(0x60 | (isLast ? 0x01 : 0x00));
  return bytes;
}

export function buildFrame(msg, dst, src) {
  const content = [...encodeCallsign(dst, false), ...encodeCallsign(src, true),
                    0x03, 0xF0, ...new TextEncoder().encode(msg)];
  return [0x7E, ...content, ...crc16(content), 0x7E];
}

export function buildFrameRaw(dataBytes, dst, src) {
  const content = [...encodeCallsign(dst, false), ...encodeCallsign(src, true),
                    0x03, 0xF0, ...dataBytes];
  return [0x7E, ...content, ...crc16(content), 0x7E];
}
