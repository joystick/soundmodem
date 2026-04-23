import { DPLL } from './dpll.js';
import { goertzel } from './goertzel.js';

const MARK_FREQ  = 1200;
const SPACE_FREQ = 2200;
const SPB        = 36;
const STEP       = 4;

export function createDemodulator({ onMessage, onFilePacket } = {}) {
  let demodBits   = [];
  let sampleBuffer = [];
  let scanPos     = 0;
  const dpll      = new DPLL();

  // ── AX.25 frame decoder ────────────────────────────────────────────────────
  function tryDecodeFrame() {
    const FLAG      = [0, 1, 1, 1, 1, 1, 1, 0];
    const matchFlag = pos => FLAG.every((b, j) => demodBits[pos + j] === b);
    let consumed    = 0;

    // Start from where we last left off (-8 bits for safety at chunk boundaries)
    for (let i = Math.max(0, scanPos - 8); i + 8 <= demodBits.length; i++) {
      if (!matchFlag(i)) continue;
      // Search for a valid closing flag.  Use `continue` (not break) on every
      // inner failure so false flags inside the data don't abort the search.
      // Cap the scan at 32768 bits (~4 KB) to support file transfer packets.
      for (let end = i + 64; end + 8 <= demodBits.length && end - i <= 32768; end++) {
        if (!matchFlag(end)) continue;
        const frameBits = demodBits.slice(i + 8, end);
        const destuffed = []; let ones = 0, corrupt = false;
        for (const b of frameBits) {
          if (ones === 5) { if (b !== 0) { corrupt = true; break; } ones = 0; continue; }
          destuffed.push(b); ones = b === 1 ? ones + 1 : 0;
        }
        if (corrupt || destuffed.length % 8 !== 0) continue;
        const bytes = [];
        for (let k = 0; k < destuffed.length; k += 8) {
          let byte = 0;
          for (let j = 0; j < 8; j++) byte = (byte << 1) | destuffed[k + j];
          bytes.push(byte);
        }
        if (bytes.length < 3) continue;

        // CRC check — import crc16 inline to avoid circular dep issues
        let crc = 0xFFFF;
        for (const b of bytes.slice(0, -2)) {
          crc ^= (b << 8);
          for (let ii = 0; ii < 8; ii++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
          crc &= 0xFFFF;
        }
        const eH = (crc >> 8) & 0xFF, eL = crc & 0xFF;
        const [cH, cL] = bytes.slice(-2);
        if (cH !== eH || cL !== eL) continue;

        const data = new Uint8Array(bytes.slice(16, -2));
        if (data.length >= 2 && data[0] === 0xFE && data[1] === 0xFF) {
          if (onFilePacket) onFilePacket(data); // async, fire-and-forget
        } else {
          const msg = new TextDecoder().decode(data);
          if (msg && onMessage) onMessage(msg);
        }
        consumed = end + 8; i = end; break;
      }
    }
    // Keep enough tail for a full max-size frame (~32768 bits) plus preamble.
    // Trim to 36000 bits so the outer loop only scans new bits each call.
    const trimAt = Math.max(consumed, demodBits.length - 36000);
    demodBits = demodBits.slice(trimAt);
    // scanPos: advance only past what was consumed (already decoded).
    // Do NOT advance to demodBits.length — that would skip opening flags whose
    // closing flag hasn't arrived yet, breaking multi-chunk decoding.
    scanPos = Math.max(0, consumed - trimAt);
  }

  // ── CPU path: sliding-window Goertzel → DPLL ──────────────────────────────
  function cpuProcessChunk(inputSamples) {
    for (const s of inputSamples) sampleBuffer.push(s);
    // Slide by STEP samples, evaluate over SPB-wide window each time
    while (sampleBuffer.length >= SPB) {
      const win    = sampleBuffer.slice(0, SPB);
      const isMark = goertzel(win, MARK_FREQ) >= goertzel(win, SPACE_FREQ);
      const bit    = dpll.feed(isMark);
      if (bit !== null) demodBits.push(bit);
      sampleBuffer.splice(0, STEP);
    }
    tryDecodeFrame();
  }

  function reset() {
    demodBits    = [];
    sampleBuffer = [];
    scanPos      = 0;
    dpll.reset();
  }

  return { cpuProcessChunk, reset, _getDemodBits: () => demodBits };
}
