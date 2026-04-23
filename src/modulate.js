import { bitStuff } from './ax25.js';

export const MARK_FREQ        = 1200;
export const SPACE_FREQ       = 2200;
export const SAMPLE_RATE      = 44100;
export const BAUD             = 1200;
export const SPB              = Math.floor(SAMPLE_RATE / BAUD); // 36 samples per bit
export const STEP             = 4;
export const PREAMBLE_FLAGS   = 30;
export const POSTAMBLE_FLAGS  = 4;

// ── Modulator: bytes → AFSK Float32Array ──────────────────────────────────
// TX structure: [PREAMBLE_FLAGS × 0x7E] [frame with opening+closing flags] [POSTAMBLE_FLAGS × 0x7E]
// Preamble flags give the receiver's DPLL time to lock before data arrives.
// Postamble flushes the last bits through the decoder's shift register.
export function modulate(frameBytes) {
  const flagBits = [0, 1, 1, 1, 1, 1, 1, 0]; // 0x7E

  // Frame content bits (between the AX.25 opening/closing flags), bit-stuffed
  const rawBits = [];
  for (const byte of frameBytes.slice(1, -1))
    for (let i = 7; i >= 0; i--) rawBits.push((byte >> i) & 1);

  // Flags are exempt from bit stuffing
  const preamble  = Array.from({ length: PREAMBLE_FLAGS  }, () => flagBits).flat();
  const postamble = Array.from({ length: POSTAMBLE_FLAGS }, () => flagBits).flat();
  const bits = [...preamble, ...flagBits, ...bitStuff(rawBits), ...flagBits, ...postamble];

  // NRZI + AFSK synthesis (continuous phase)
  let freq = MARK_FREQ, phase = 0;
  const audio = new Float32Array(bits.length * SPB);
  let idx = 0;
  for (const bit of bits) {
    if (bit === 0) freq = (freq === MARK_FREQ) ? SPACE_FREQ : MARK_FREQ;
    const inc = 2 * Math.PI * freq / SAMPLE_RATE;
    for (let s = 0; s < SPB; s++) {
      phase = (phase + inc) % (2 * Math.PI);
      audio[idx++] = Math.sin(phase);
    }
  }
  return audio;
}
