// OFDM demodulator — Phase 3: CPU path with pilot-phase AFC
// Phase 5: optional GPU DFT path via gpuDft option or preferGpu flag.
// Pipeline: DFT (CPU or GPU) → pilot AFC → Viterbi FEC → frame parse → callbacks

import { ofdmDemodulateRaw, OFDM_N, OFDM_CP, OFDM_DATA_CARRIERS, OFDM_PILOT_BINS } from './ofdm.js';
import { viterbiDecode, deinterleave } from './fec.js';
import { initGpuDft } from './ofdm-gpu.js';

export const INTERLEAVE_DEPTH = OFDM_DATA_CARRIERS.length; // 52 — one symbol per row

const SYM_LEN = OFDM_N + OFDM_CP; // 320 samples per symbol

// ---------------------------------------------------------------------------
// Pilot-phase AFC: rotate each symbol's subcarriers by the mean pilot error.
// Pilot tones are transmitted as BPSK +1 (real, zero imaginary).
// After FFT, a carrier offset θ rotates every bin by θ·bin. We measure the
// phase at each pilot bin and rotate all bins by the negative mean phase.
// ---------------------------------------------------------------------------
function applyPilotAfc(re, im) {
  // Measure phase at each pilot bin
  let phaseSum = 0;
  for (const b of OFDM_PILOT_BINS) {
    phaseSum += Math.atan2(im[b], re[b]);
  }
  const correction = -phaseSum / OFDM_PILOT_BINS.length;
  const cosC = Math.cos(correction);
  const sinC = Math.sin(correction);

  // Rotate all bins (only the active ones matter for decoding)
  for (let i = 0; i < OFDM_N; i++) {
    const r = re[i] * cosC - im[i] * sinC;
    const newIm = re[i] * sinC + im[i] * cosC;
    re[i] = r;
    im[i] = newIm;
  }
}

// ---------------------------------------------------------------------------
// ofdmDemodulateWithAfc(samples) → boolean[]
// Like ofdmDemodulateRaw but applies per-symbol pilot-phase correction.
// ---------------------------------------------------------------------------
function ofdmDemodulateWithAfc(samples) {
  const dataCarriers = OFDM_DATA_CARRIERS;
  const numSymbols = samples.length / SYM_LEN;
  const bits = [];

  // Inline FFT (same radix-2 as in ofdm.js — duplicated here to avoid exporting internals)
  function fft(re, im) {
    const n = re.length;
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
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;
        for (let k = 0; k < len / 2; k++) {
          const uRe = re[i + k], uIm = im[i + k];
          const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
          const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
          re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
          re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
          const nextRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe; curRe = nextRe;
        }
      }
    }
  }

  const re = new Float64Array(OFDM_N);
  const im = new Float64Array(OFDM_N);

  for (let s = 0; s < numSymbols; s++) {
    const base = s * SYM_LEN + OFDM_CP;
    for (let i = 0; i < OFDM_N; i++) { re[i] = samples[base + i]; im[i] = 0; }

    fft(re, im);
    applyPilotAfc(re, im);

    for (const bin of dataCarriers) {
      bits.push(re[bin] >= 0);
    }
  }

  return bits;
}

// ---------------------------------------------------------------------------
// Frame decode: deinterleave → Viterbi → parse [2-byte length][payload bytes]
// Returns the decoded text string, or null if decode failed.
// ---------------------------------------------------------------------------
function decodeFrame(rawBits) {
  const deintBits = deinterleave(rawBits, INTERLEAVE_DEPTH);
  const decoded = viterbiDecode(deintBits);

  // Read 16-bit payload byte count (big-endian, MSB first)
  if (decoded.length < 16) return null;
  let byteCount = 0;
  for (let i = 0; i < 16; i++) {
    byteCount = (byteCount << 1) | (decoded[i] ? 1 : 0);
  }
  if (byteCount <= 0 || byteCount > 4096) return null;

  const payloadBits = decoded.slice(16, 16 + byteCount * 8);
  if (payloadBits.length < byteCount * 8) return null;

  const bytes = new Uint8Array(byteCount);
  for (let b = 0; b < byteCount; b++) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (payloadBits[b * 8 + bit]) byte |= (1 << bit); // LSB first
    }
    bytes[b] = byte;
  }

  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// GPU DFT demodulation path
// Uses the GPU for the per-symbol DFT; pilot AFC and Viterbi run on CPU.
// ---------------------------------------------------------------------------
async function ofdmDemodulateWithGpu(samples, gpuDftFn) {
  const dataCarriers = OFDM_DATA_CARRIERS;
  const numSymbols = Math.floor(samples.length / SYM_LEN);
  const bits = [];

  for (let s = 0; s < numSymbols; s++) {
    const base = s * SYM_LEN + OFDM_CP;
    const window = samples.slice(base, base + OFDM_N);
    // GPU DFT returns Float32Arrays; convert to Float64-compatible objects for AFC
    const { re: reF32, im: imF32 } = await gpuDftFn(new Float32Array(window));
    // Copy to mutable arrays for pilot AFC rotation
    const re = new Float64Array(reF32);
    const im = new Float64Array(imF32);
    applyPilotAfc(re, im);
    for (const bin of dataCarriers) {
      bits.push(re[bin] >= 0);
    }
  }

  return bits;
}

// ---------------------------------------------------------------------------
// createOfdmDemodulator({ onMessage, onFilePacket, gpuDft?, preferGpu? })
//   → { processChunk, reset }
//
// gpuDft    — a pre-initialized GpuDft instance (or null for CPU fallback)
// preferGpu — if true and gpuDft not supplied, initialise GPU internally
//
// processChunk accepts a Float32Array of audio samples (any length).
// A frame is decoded when a complete set of symbols has been received.
// ---------------------------------------------------------------------------
export function createOfdmDemodulator({ onMessage, onFilePacket, gpuDft = null, preferGpu = false }) {
  let sampleBuffer = new Float32Array(0);
  let resolvedGpu = gpuDft;       // GpuDft instance or null
  let gpuReady    = !!gpuDft;     // true once we know GPU state
  let pendingChunks = [];         // queued while GPU init is in-flight

  // Start GPU init if requested and not already supplied
  if (!gpuDft && preferGpu) {
    initGpuDft().then(inst => {
      resolvedGpu = inst;
      gpuReady    = true;
      // Drain any samples that arrived during init
      const queued = pendingChunks.splice(0);
      for (const chunk of queued) _enqueue(chunk);
    });
  } else {
    gpuReady = true;
  }

  function _enqueue(samples) {
    const merged = new Float32Array(sampleBuffer.length + samples.length);
    merged.set(sampleBuffer);
    merged.set(samples, sampleBuffer.length);
    sampleBuffer = merged;

    while (sampleBuffer.length >= SYM_LEN) {
      const numSymbols = Math.floor(sampleBuffer.length / SYM_LEN);
      const frameLen   = numSymbols * SYM_LEN;
      const frame      = sampleBuffer.slice(0, frameLen);
      sampleBuffer     = sampleBuffer.slice(frameLen);

      if (resolvedGpu) {
        ofdmDemodulateWithGpu(frame, s => resolvedGpu.dft(s))
          .then(rawBits => {
            const text = decodeFrame(rawBits);
            if (text !== null) onMessage(text);
          })
          .catch(() => {});
      } else {
        const rawBits = ofdmDemodulateWithAfc(frame);
        const text    = decodeFrame(rawBits);
        if (text !== null) onMessage(text);
      }
    }
  }

  function processChunk(samples) {
    if (!gpuReady) {
      pendingChunks.push(new Float32Array(samples)); // copy — caller buffer may be reused
      return;
    }
    _enqueue(samples);
  }

  function reset() {
    sampleBuffer  = new Float32Array(0);
    pendingChunks = [];
  }

  return { processChunk, reset };
}
