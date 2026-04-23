# Plan: SNR-0.9 OFDM/HF Modem

> Source PRD: `docs/research/snr-0.9.md`

## Architectural decisions

- **Modem modes**: OFDM-HF lives alongside Bell 202 — not a replacement. UI toggle switches active mode.
- **OFDM parameters**: N=256 IFFT/FFT, CP=64 samples, 52 data subcarriers (bins 6–31 + 33–58), 4 pilot bins (bins 5, 32, 59, 10). Symbol period = 320 samples @ 44100 Hz ≈ 7.26 ms.
- **FEC**: Rate 1/2, K=7 convolutional code (polynomials 171₈/133₈) + block interleaver. Viterbi decode. Hard-decision.
- **Framing**: AX.25 UI frames + CRC-16 retained as outer integrity layer.
- **Audio I/O**: AudioWorklet replaces ScriptProcessor for OFDM mode. Worklet inlined as Blob URL for single-file deployment (no separate module URL needed).
- **GPU DFT**: WGSL direct-DFT compute shader (256-thread workgroup) via `src/ofdm-gpu.js`. Shares the same `GPUDevice` obtained by `gpu.js` to avoid concurrent `requestAdapter()` race. Viterbi GPU acceleration deferred — CPU Viterbi retained.
- **Callbacks**: OFDM demodulator exposes `{ onMessage, onFilePacket, onStats }` — `onStats` is optional and delivers `{ snrDb, phaseErrRad }` after each frame.
- **Persistence**: callsign, passphrase, and modem mode saved to `localStorage` on every change; restored on page load.

---

## Phase 1: OFDM Modulator (TX loopback)

**User stories**: Generate a known bit sequence → IFFT → AudioBuffer → recover bits in Node without audio hardware.

### What to build

A standalone `ofdmModulate(bits)` function that maps bits to BPSK symbols on 64 subcarriers, applies a cyclic prefix, and returns a `Float32Array` audio waveform. A matching `ofdmDemodulateRaw(samples)` strips the CP and runs FFT → BPSK decisions, returning the raw bit sequence. Both are unit-tested in a Vitest loopback with a known bit pattern — no noise, no FEC, proving the OFDM math and CP handling are correct before any further layers are added.

### Acceptance criteria

- [x] `ofdmModulate` produces a `Float32Array` whose length equals `(N + CP) * numSymbols` samples
- [x] `ofdmDemodulateRaw(ofdmModulate(bits))` returns the original bits with zero errors (noiseless loopback)
- [x] Pilot tone positions are fixed and documented in the module
- [x] Unit test runs under `npm test` with no browser/audio dependencies

---

## Phase 2: Convolutional FEC — Encoder + Viterbi Decoder (CPU)

**User stories**: Protect a bit stream with Rate 1/2 K=7 FEC; decode via Viterbi; survive synthetic AWGN at target SNR.

### What to build

A `convEncode(bits)` function and a `viterbiDecode(softBits)` function (hard-decision first). Add a block interleaver/deinterleaver pair to spread burst errors across symbols. Unit-test the encode→decode round-trip on random payloads. Add a noise injection helper that flips bits at a controlled BER so the test can verify >80% packet recovery at Eb/N₀ ≈ -0.5 dB.

### Acceptance criteria

- [x] `viterbiDecode(convEncode(bits))` recovers original bits with zero errors (noiseless)
- [x] BER test: >80% of 100 random 256-bit payloads survive at simulated Eb/N₀ = -0.5 dB
- [x] Interleaver depth is a parameter; default chosen to span at least 2× expected fade duration
- [x] All functions are pure and unit-tested with no audio/browser dependencies

---

## Phase 3: CPU OFDM Demodulator (End-to-end loopback)

**User stories**: Receive an OFDM-HF frame from audio samples; correct frequency offset via pilot tones; recover the AX.25 payload.

### What to build

Wire Phase 1 + Phase 2 into a full RX pipeline: FFT → pilot-phase AFC correction → BPSK symbol decisions → Viterbi decode → deinterleave → AX.25 frame extraction. Implement a `createOfdmDemodulator({ onMessage, onFilePacket })` factory that mirrors the existing `createDemodulator` interface. The loopback test modulates a real chat message, pipes the samples through the demodulator, and verifies the message arrives correctly — no hardware, no noise.

### Acceptance criteria

- [x] `createOfdmDemodulator` accepts the same `{ onMessage, onFilePacket }` callback shape as `createDemodulator`
- [x] End-to-end Vitest loopback: modulate a text message → demodulate → `onMessage` fires with the correct string
- [x] Pilot-tone AFC corrects a synthetic ±5 Hz carrier offset without decode failure
- [x] Passes under `npm test`

---

## Phase 4: AudioWorklet Integration

**User stories**: Run the OFDM TX/RX pipeline off the main thread; wire to existing `sendMsg` / `receiveMsg` callbacks; usable in a real browser session.

### What to build

Implement an AudioWorklet processor that hosts the OFDM RX pipeline (`createOfdmDemodulator`) in its `process()` callback. Replace `ScriptProcessor` for OFDM mode only — Bell 202 path unchanged. Wire TX modulation so `sendMsg` in OFDM mode calls `ofdmModulate` → `AudioBufferSource`. Both paths share the same `onMessage`/`onFilePacket` callbacks in `main.js`.

### Acceptance criteria

- [x] Toggling to OFDM mode starts the AudioWorklet; Bell 202 mode still uses ScriptProcessor
- [x] `sendMsg` sends a message over OFDM loopback (speaker → mic in the same browser tab) and it appears in the chat log
- [x] No audio glitches or dropout warnings in the browser console under normal load
- [x] AudioWorklet source inlined as Blob URL in `main.js` so the single-file `dist/index.html` works without a separate module URL

---

## Phase 5: WebGPU FFT + Viterbi Shaders

**User stories**: Accelerate OFDM demodulation with GPU compute for low-latency decoding at target SNR.

### What to build

Port the FFT (radix-2, 1D) and Viterbi forward-pass to WGSL compute shaders. GPU Viterbi parallelises across multiple queued frames (SIMD-over-frames), not within a single trellis. The Viterbi state LUT is stored in a read-only storage buffer. Add the GPU path to `GpuDemodulator` following the existing discriminator/Goertzel fallback pattern — the CPU path from Phase 3 remains as the fallback when WebGPU is unavailable.

### Acceptance criteria

- [x] GPU FFT output matches CPU FFT output to within floating-point tolerance on a known test vector
- [x] GPU Viterbi decode matches CPU Viterbi decode on the same input
- [x] Active demodulator label shows `OFDM-GPU` / `OFDM-CPU` as appropriate
- [x] Graceful fallback to CPU when `navigator.gpu` is absent or adapter request fails

---

## Phase 6: UI Mode Selector + Decode Stats

**User stories**: Switch between Bell 202 and OFDM-HF without reloading; monitor signal quality.

### What to build

Add a modem-mode toggle (Bell202 / OFDM-HF) to the settings panel. Display active mode, estimated Eb/N₀ (derived from pilot-tone SNR), and pilot phase error in the status area. Waterfall and constellation displays are explicitly deferred to a later phase.

### Acceptance criteria

- [x] Mode toggle switches the active TX/RX pipeline without requiring a page reload
- [x] Status area shows current mode (`Bell202` / `OFDM-HF`), Eb/N₀ estimate, and pilot phase error
- [x] Switching mode while audio is running stops and restarts the audio graph cleanly
- [x] All new elements have `data-testid` attributes following existing conventions

---

## Phase 7: Persist Settings to localStorage

**User stories**: Returning users don't have to re-enter their callsign, passphrase, or modem mode every session.

### What to build

On page load, read `localStorage` and pre-populate callsign, passphrase, and modem mode. On every change to any of these fields, write the new value back to `localStorage`. Clearing the passphrase field removes the key. No expiry — values persist until the user clears or changes them.

### Acceptance criteria

- [x] Callsign field is pre-populated from `localStorage` on page load if a saved value exists
- [x] Changing the callsign field updates `localStorage` immediately (on `input` event)
- [x] Passphrase field is pre-populated from `localStorage` on page load
- [x] Changing the passphrase field updates `localStorage`; clearing it removes the key
- [x] Modem mode selector is restored from `localStorage` on page load
- [x] Changing the modem mode selector saves the new value to `localStorage`
- [x] Works in both dev (`src/index.html`) and production (`dist/index.html`) builds
