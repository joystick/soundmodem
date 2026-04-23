// ── CRC-16-CCITT (init 0xFFFF) ─────────────────────────────────────────────
const CRC_POLY = 0x1021;

export function crc16(data) {
  let crc = 0xFFFF;
  for (const b of data) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ CRC_POLY) : (crc << 1);
    crc &= 0xFFFF;
  }
  return [(crc >> 8) & 0xFF, crc & 0xFF];
}
