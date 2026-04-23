// OFDM modem — Phase 1: modulator + raw demodulator (no FEC, no AFC)
//
// Parameters
// ----------
// N=256: FFT size → subcarrier spacing Δf = 44100/256 ≈ 172 Hz
// CP=64: cyclic prefix (N/4) → symbol duration = (256+64)/44100 ≈ 7.26 ms
// Data subcarriers: bins 6–31 + 33–58 (52 total, skip DC at 0 and guard bands)
// Pilot subcarriers: bins 8, 22, 36, 50 (fixed BPSK +1, used by Phase 3 AFC)
// Span: ~9 kHz

export const OFDM_N = 256;
export const OFDM_CP = 64;

// Active data bin indices (pilot bins are excluded)
const PILOT_BINS = new Set([8, 22, 36, 50]);
export const OFDM_PILOT_BINS = [...PILOT_BINS];

// Data bins: 6–31 + 33–58, excluding pilot positions
export const OFDM_DATA_CARRIERS = (() => {
  const bins = [];
  for (let b = 6; b <= 31; b++) if (!PILOT_BINS.has(b)) bins.push(b);
  for (let b = 33; b <= 58; b++) if (!PILOT_BINS.has(b)) bins.push(b);
  return bins;
})();

// ---------------------------------------------------------------------------
// Radix-2 Cooley-Tukey FFT (in-place, complex)
// re[] and im[] are Float64Arrays of length N (must be power of 2)
// ---------------------------------------------------------------------------
function fft(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// IFFT: conjugate → FFT → conjugate → scale
function ifft(re, im) {
  // conjugate input
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  fft(re, im);
  // conjugate output and scale
  const n = re.length;
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

// ---------------------------------------------------------------------------
// ofdmModulate(bits) → Float32Array
// bits: boolean[] or 0/1 array, length need not be a multiple of DATA_CARRIERS
// Pads with zeros to fill the last symbol.
// ---------------------------------------------------------------------------
export function ofdmModulate(bits) {
  const dataCarriers = OFDM_DATA_CARRIERS;
  const numSymbols = Math.ceil(bits.length / dataCarriers.length);
  const symLen = OFDM_N + OFDM_CP;
  const out = new Float32Array(symLen * numSymbols);

  const re = new Float64Array(OFDM_N);
  const im = new Float64Array(OFDM_N);

  for (let s = 0; s < numSymbols; s++) {
    re.fill(0);
    im.fill(0);

    // Map data bits to BPSK (+1 / -1) on data subcarriers
    for (let c = 0; c < dataCarriers.length; c++) {
      const bitIdx = s * dataCarriers.length + c;
      const bit = bitIdx < bits.length ? (bits[bitIdx] ? 1 : 0) : 0;
      re[dataCarriers[c]] = bit ? 1.0 : -1.0;
    }

    // Pilot tones: fixed +1 BPSK for AFC reference
    for (const b of PILOT_BINS) re[b] = 1.0;

    // IFFT → time domain
    ifft(re, im);

    // The IFFT divides by N=256, so raw RMS ≈ sqrt(K)/N ≈ 0.029 (K=56 active bins).
    // Multiply by N/(4·sqrt(K)) to target RMS ≈ 0.25, safe against OFDM PAPR peaks.
    const norm = OFDM_N / (4 * Math.sqrt(dataCarriers.length + PILOT_BINS.size));

    // Write cyclic prefix then symbol
    const base = s * symLen;
    for (let i = 0; i < OFDM_CP; i++) {
      out[base + i] = re[OFDM_N - OFDM_CP + i] * norm;
    }
    for (let i = 0; i < OFDM_N; i++) {
      out[base + OFDM_CP + i] = re[i] * norm;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// ofdmDemodulateRaw(samples) → boolean[]
// No FEC, no AFC. Strips CP, runs FFT, makes hard BPSK decisions.
// Returns exactly the same number of bits that were passed to ofdmModulate
// (padding zeros are included — caller must know original length).
// ---------------------------------------------------------------------------
export function ofdmDemodulateRaw(samples) {
  const dataCarriers = OFDM_DATA_CARRIERS;
  const symLen = OFDM_N + OFDM_CP;
  const numSymbols = samples.length / symLen;
  const bits = [];

  const re = new Float64Array(OFDM_N);
  const im = new Float64Array(OFDM_N);

  for (let s = 0; s < numSymbols; s++) {
    const base = s * symLen + OFDM_CP; // skip CP
    for (let i = 0; i < OFDM_N; i++) {
      re[i] = samples[base + i];
      im[i] = 0;
    }

    fft(re, im);

    for (const bin of dataCarriers) {
      bits.push(re[bin] >= 0);
    }
  }

  return bits;
}

// ---------------------------------------------------------------------------
// ofdmEncodeFrame(text) → Float32Array
// Encodes a UTF-8 string as an OFDM frame:
//   [16-bit byte count (MSB first)] [UTF-8 bytes (LSB-first bits)]
// → convEncode → interleave(INTERLEAVE_DEPTH) → ofdmModulate
// Import INTERLEAVE_DEPTH from ofdm-demodulate.js to keep encoding symmetric.
// ---------------------------------------------------------------------------
import { convEncode, interleave } from './fec.js';

export const OFDM_INTERLEAVE_DEPTH = OFDM_DATA_CARRIERS.length; // 52

/** Encode raw bytes into an OFDM audio frame (FEC + interleave + IFFT). */
export function ofdmEncodeFrameRaw(bytes) {
  const byteCount = bytes.length;
  const bits = [];
  for (let i = 15; i >= 0; i--) bits.push(((byteCount >> i) & 1) !== 0);
  for (const byte of bytes) {
    for (let bit = 0; bit < 8; bit++) bits.push(((byte >> bit) & 1) !== 0);
  }
  const encoded = convEncode(bits);
  const interleaved = interleave(encoded, OFDM_INTERLEAVE_DEPTH);
  return ofdmModulate(interleaved);
}

/** Encode a UTF-8 text string into an OFDM audio frame. */
export function ofdmEncodeFrame(text) {
  return ofdmEncodeFrameRaw(new TextEncoder().encode(text));
}
