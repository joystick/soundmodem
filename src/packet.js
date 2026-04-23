// ── File packet encode/decode ──────────────────────────────────────────────

export const FILE_MAGIC = [0xFE, 0xFF];
export const CHUNK_SIZE = 3500;

/**
 * Encode a file transfer packet payload.
 * @param {object} opts
 * @param {Uint8Array} opts.xferId  - 2-byte transfer ID
 * @param {number}     opts.seq     - fragment sequence number (0-based)
 * @param {number}     opts.total   - total number of fragments
 * @param {string}     [opts.filename] - filename (only included when seq === 0)
 * @param {Uint8Array} opts.data    - chunk data bytes
 * @returns {Uint8Array}
 */
export function encodePacket({ xferId, seq, total, filename, data }) {
  const isFirst = seq === 0;
  const fname   = isFirst && filename ? new TextEncoder().encode(filename) : null;
  const hdrSize = 8 + (isFirst && fname ? 2 + fname.length : 0);
  const payload = new Uint8Array(hdrSize + data.length);
  let p = 0;
  payload[p++] = 0xFE; payload[p++] = 0xFF;          // magic
  payload[p++] = xferId[0]; payload[p++] = xferId[1]; // transfer ID
  payload[p++] = (seq >> 8) & 0xFF; payload[p++] = seq & 0xFF;     // seq
  payload[p++] = (total >> 8) & 0xFF; payload[p++] = total & 0xFF; // total
  if (isFirst && fname) {
    payload[p++] = (fname.length >> 8) & 0xFF;
    payload[p++] = fname.length & 0xFF;
    payload.set(fname, p); p += fname.length;
  }
  payload.set(data, p);
  return payload;
}

/**
 * Decode a file transfer packet payload.
 * @param {Uint8Array} payload
 * @returns {{ xferId: string, seq: number, total: number, filename: string|null, data: Uint8Array }|null}
 */
export function decodePacket(payload) {
  if (!payload || payload.length < 8) return null;
  if (payload[0] !== 0xFE || payload[1] !== 0xFF) return null;

  const xferId = payload[2].toString(16).padStart(2, '0') +
                 payload[3].toString(16).padStart(2, '0');
  const seq    = (payload[4] << 8) | payload[5];
  const total  = (payload[6] << 8) | payload[7];

  let dataOffset = 8;
  let filename   = null;
  if (seq === 0 && payload.length >= 10) {
    const fnameLen = (payload[8] << 8) | payload[9];
    if (payload.length >= 10 + fnameLen) {
      filename   = new TextDecoder().decode(payload.slice(10, 10 + fnameLen));
      dataOffset = 10 + fnameLen;
    }
  }

  const data = payload.slice(dataOffset);
  return { xferId, seq, total, filename, data };
}
