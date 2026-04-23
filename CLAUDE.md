# SoundModem P2P Chat

Single-file browser app (`index.html`) implementing P2P text chat over audio using AX.25 UI frames modulated as Bell 202 AFSK. No build step, no dependencies, no server.

## How to run

```bash
python3 -m http.server 8765
# open http://localhost:8765/index.html
```

`file://` is blocked by browsers — `getUserMedia` and WebGPU both require a secure context (localhost qualifies).

## Tech stack

| Layer | Technology |
|---|---|
| Language | Vanilla JavaScript (ES2020), no frameworks |
| Audio I/O | Web Audio API — `AudioContext`, `MediaStreamSource`, `ScriptProcessor`, `BufferSource` |
| Mic access | `navigator.mediaDevices.getUserMedia` |
| Encryption | Web Crypto API — PBKDF2 → AES-GCM-256 |
| Framing | AX.25 UI frames |
| Modulation | Bell 202 AFSK, 1200 baud |
| RX demod (primary) | WebGPU compute — FM discriminator (WGSL) |
| RX demod (fallback 1) | WebGPU compute — parallel Goertzel (WGSL) |
| RX demod (fallback 2) | CPU Goertzel (JavaScript) |
| Clock recovery | DPLL (Digital Phase-Locked Loop) |
| Testing | Playwright MCP + `python3 -m http.server` |

---

## Signal chain

### TX

```mermaid
flowchart LR
    A[plaintext] --> B[AES-GCM encrypt\nbase64 wrap]
    B --> C[buildFrame\nAX.25 UI bytes]
    C --> D[modulate\nNRZI + AFSK]
    D --> E[preamble 30×0x7E\n+ postamble 4×0x7E]
    E --> F[AudioBufferSource\n→ destination]
```

### RX

```mermaid
flowchart LR
    M[Microphone] --> SP[ScriptProcessor\n4096-sample chunks]
    SP --> Q[processAudioChunk]
    Q --> GPU{WebGPU\navailable?}
    GPU -->|yes| GQ[gpuQueue\nasync drain]
    GPU -->|no| CPU[cpuProcessChunk\nGoertzel STEP=4]
    GQ --> DISC[GPU shader\nhigh-rate STEP=4]
    DISC --> DPLL[DPLL\nclock recovery]
    CPU --> DPLL
    DPLL --> BITS[demodBits]
    BITS --> DEC[tryDecodeFrame\nflag scan + destuff + CRC]
    DEC --> RX[receiveMsg\ndecrypt + display]
```

---

## Demodulator selection

```mermaid
flowchart TD
    A[page load] --> B{navigator.gpu?}
    B -->|no| CPU[CPU Goertzel]
    B -->|yes| C[requestAdapter]
    C -->|fail| CPU
    C -->|ok| D[try GPU Discriminator]
    D -->|ok| DISC[GPU FM Discriminator ✓]
    D -->|fail| E[try GPU Goertzel]
    E -->|ok| GOER[GPU Parallel Goertzel ✓]
    E -->|fail| CPU
```

The active mode is shown in the `#demod-mode` label next to the status indicator.

---

## Bell 202 AFSK parameters

| Constant | Value | Meaning |
|---|---|---|
| `MARK_FREQ` | 1200 Hz | Logic 1 / no NRZI transition |
| `SPACE_FREQ` | 2200 Hz | Logic 0 / NRZI transition |
| `SAMPLE_RATE` | 44100 Hz | Audio sample rate |
| `BAUD` | 1200 | Symbols per second |
| `SPB` | 36 | `⌊44100 / 1200⌋` — samples per bit |
| `STEP` | 4 | Goertzel stride — high-rate samples between estimates |
| `OMEGA_NOM` | 9 | `SPB / STEP` — nominal DPLL period in high-rate steps |

---

## Preamble and postamble

Every TX frame is wrapped with flag bytes to allow the receiver's DPLL to lock before data arrives:

| Constant | Value | Purpose |
|---|---|---|
| `PREAMBLE_FLAGS` | 30 | 30 × 0x7E before frame — 30 × 8 = 240 bits for DPLL lock |
| `POSTAMBLE_FLAGS` | 4 | 4 × 0x7E after frame — flush the decoder's bit buffer |

The 0x7E flag (`01111110` LSB-first) produces an alternating pattern under NRZI: 7 symbols of one frequency then 1 symbol of the other, giving 2 transitions per flag for the DPLL to lock onto.

---

## High-rate demodulation and DPLL

All three demodulators produce a **high-rate frequency stream** at `SAMPLE_RATE / STEP = 11025` estimates/sec (one isMark boolean every 4 audio samples). This ~9× oversampling drives the DPLL for clock recovery.

### Why STEP=4 with a full SPB=36 window is tricky

The Goertzel window is SPB=36 samples wide — exactly one symbol period. Each high-rate step advances the window by only STEP=4 samples. This means the window at step `n` covers `[n×4, n×4+36)`. At the **last step** of a symbol period, the window already extends 32 samples into the *next* symbol, making a majority vote over all 9 steps incorrect (it would vote for the wrong symbol at transitions).

**Solution:** sample the frequency at the **first step** of each symbol period (`phase < 1` after phase reset), where the window `[k×36, k×36+36)` is perfectly aligned with symbol `k` — no inter-symbol bleed.

### DPLL algorithm

```
OMEGA_NOM = SPB / STEP = 9.0      nominal steps per symbol
α = 0.1                            phase correction gain
β = 0.0002                         frequency correction gain
```

```mermaid
flowchart TD
    START[phase reset → 0] --> INC[phase += 1]
    INC --> SNAP{phase crossed 1?}
    SNAP -->|yes| CAPTURE[snapshot = isMark\nclean symbol sample]
    SNAP -->|no| TRANS
    CAPTURE --> TRANS
    TRANS{transition\nisMark ≠ lastFreq?}
    TRANS -->|yes| ERR[err = phase − target\ntarget = ω/2 + 1.5\nwrap err to ±ω/2\nphase −= err × α\nω −= err × β]
    TRANS -->|no| OVF
    ERR --> OVF
    OVF{phase ≥ ω?}
    OVF -->|yes| EMIT[phase −= ω\nbit = snapshot XOR lastSym\nemit bit]
    OVF -->|no| START
    EMIT --> START
```

**Phase target derivation:** When an NRZI transition occurs at sample boundary `T = k×SPB`, the Goertzel output flips at high-rate step `n ≈ (T − SPB/2) / STEP = k×OMEGA_NOM − OMEGA_NOM/2`. Relative to the last symbol emission (which fires 1 step early due to phase-first increment), transitions arrive at phase ≈ `OMEGA_NOM/2 + 1.5 = 6.0`. This is the correction target.

**Symbol sampling:** `snapshot` is captured at `prevPhase < 1` (the step where `phase` first crosses 1 after a reset). At that step the Goertzel window is exactly `[k×SPB, k×SPB+SPB)` — one clean symbol, no straddling.

### DPLL state variables

| Variable | Initial | Purpose |
|---|---|---|
| `omega` | `OMEGA_NOM` | Current estimated symbol period in high-rate steps |
| `phase` | `0` | Phase accumulator within current symbol |
| `snapshot` | `true` | Frequency captured at symbol start for bit decision |
| `lastFreq` | `true` | Previous high-rate sample (for transition detection) |
| `lastSymFreq` | `true` | Frequency at previous symbol (for NRZI decode) |

---

## WebGPU demodulators

Both GPU demodulators produce a **high-rate** frequency stream (one isMark per STEP=4 samples), fed into the same DPLL as the CPU path. NRZI decoding and DPLL always run on the CPU after the GPU returns.

### Shared GPU buffer layout

```
paramBuf   (32 B, uniform)    — shader params (see per-mode fields below)
sampleBuf  (16 KB, storage)   — input Float32 audio samples (max 4096)
bitsBuf    (~4 KB, storage)   — output u32 isMark flags (max positions = ⌊4096/STEP⌋)
readBuf    (~4 KB, MAP_READ)  — CPU readback copy of bitsBuf
```

### Option 2 — Parallel Goertzel (`GOERTZEL_WGSL`)

One GPU thread per high-rate position. Each thread computes squared Goertzel magnitude for MARK and SPACE over a SPB-sample window.

```mermaid
flowchart LR
    subgraph GPU ["GPU — one thread per high-rate position"]
        T0["Thread 0\nwindow [0..35]"] --> G0["goertzel_sq(mark_k)\ngoertzel_sq(space_k)"]
        T1["Thread 1\nwindow [4..39]"] --> G1["goertzel_sq(mark_k)\ngoertzel_sq(space_k)"]
        TN["Thread N\nwindow [N*4..]"] --> GN["goertzel_sq(mark_k)\ngoertzel_sq(space_k)"]
    end
    G0 --> B0["bits[0] = mark≥space ? 1 : 0"]
    G1 --> B1["bits[1]"]
    GN --> BN["bits[N]"]
```

Uniform params:

| Offset | Field | Value |
|---|---|---|
| 0 | `num_samples` | chunk length (≤ 4096) |
| 4 | `num_positions` | `⌊(num_samples − SPB) / STEP⌋ + 1` |
| 8 | `spb` | 36 |
| 12 | `step` | 4 |
| 16 | `mark_k` | `2π × 1200 / 44100 ≈ 0.1711` |
| 20 | `space_k` | `2π × 2200 / 44100 ≈ 0.3138` |

Uses **squared** DFT magnitude (avoids `sqrt`).

### Option 3 — FM Discriminator (`DISCRIMINATOR_WGSL`)

One GPU thread per high-rate position. Mixes with a complex carrier at `fc = 1700 Hz` (midpoint of MARK/SPACE) then computes the cross-product FM discriminant.

```mermaid
flowchart LR
    subgraph GPU ["GPU — one thread per high-rate position"]
        direction TB
        MIX["Mix x[n] with\ncomplex carrier fc=1700Hz\nI[n] = x[n]·cos(2π·fc·n/Fs)\nQ[n] = x[n]·sin(2π·fc·n/Fs)"]
        CROSS["Cross-product discriminant\ndisc = Σ(Q[n]·I[n-1] − I[n]·Q[n-1])"]
        DEC["disc < 0 → MARK → 1\ndisc ≥ 0 → SPACE → 0"]
        MIX --> CROSS --> DEC
    end
```

Uniform params:

| Offset | Field | Value |
|---|---|---|
| 0 | `num_samples` | chunk length |
| 4 | `num_positions` | `⌊(num_samples − SPB) / STEP⌋ + 1` |
| 8 | `spb` | 36 |
| 12 | `step` | 4 |
| 16 | `center_phase_inc` | `2π × 1700 / 44100 ≈ 0.2422` |

**Why the discriminator is better than Goertzel:**
- Phase-invariant — result does not depend on where in the carrier cycle the symbol starts
- Naturally implements an FM discriminator — the cross-product `Q[n]·I[n-1] − I[n]·Q[n-1]` is proportional to instantaneous frequency deviation from `fc`
- Better noise rejection on weak or distorted signals

**Edge case:** The first position in each chunk (`off == 0`) has no prior sample for the differential; it defaults to MARK (`bits[0] = 1u`) and is harmless at 93 ms chunk intervals.

---

## GPU async processing

```mermaid
sequenceDiagram
    participant SP as ScriptProcessor
    participant Q  as gpuQueue
    participant G  as GpuDemodulator
    participant D  as DPLL + demodBits

    SP->>Q: push Float32Array copy
    Note over Q: copy needed — SP buffer reused after callback
    Q->>G: processChunk(samples)
    G->>G: writeBuffer → dispatch → copyBuffer → mapAsync
    G-->>Q: Uint32Array isMark[] (high-rate, STEP=4)
    Q->>D: feed each isMark into DPLL → push recovered bits
    D->>D: tryDecodeFrame if len ≥ 160
```

`gpuBusy` flag serialises queue draining — only one `mapAsync` in flight at a time.

---

## AX.25 frame format

```
[0x7E] [DST 7B] [SRC 7B] [CTRL 0x03] [PID 0xF0] [DATA ... ] [FCS HI] [FCS LO] [0x7E]
```

```mermaid
packet-beta
  0-7: "0x7E flag"
  8-63: "DST callsign (7 bytes)"
  64-119: "SRC callsign (7 bytes)"
  120-127: "CTRL 0x03 (UI)"
  128-135: "PID 0xF0"
  136-167: "DATA (variable)"
  168-175: "FCS hi"
  176-183: "FCS lo"
  184-191: "0x7E flag"
```

- **Callsigns:** 6 ASCII chars padded with spaces, each byte **shifted left 1 bit**, followed by a 7th SSID byte (`0x60` for dst, `0x61` for src)
- **FCS:** CRC-16-CCITT (poly `0x1021`, init `0xFFFF`) over `DST + SRC + CTRL + PID + DATA` — excludes the `0x7E` flags and the FCS itself
- **Bit stuffing:** insert `0` after every 5 consecutive `1`s in the frame content, **before** NRZI; the `0x7E` flag bytes are exempt
- **NRZI:** `0` bit → toggle frequency; `1` bit → keep current frequency

### Modulation pipeline

```mermaid
flowchart LR
    FB[Frame bytes\n0x7E…0x7E] --> RAW[Raw bits\nLSB first]
    RAW --> STUFF[bitStuff\ninsert 0 after 5 ones]
    STUFF --> WRAP[Prepend 30×flag\nappend 4×flag]
    WRAP --> NRZI[NRZI encode\n0→toggle freq\n1→keep freq]
    NRZI --> AFSK[AFSK sine wave\nMARK=1200Hz\nSPACE=2200Hz]
```

---

## Encryption

Optional symmetric encryption. Both peers must use the same passphrase.

- Key derivation: PBKDF2 (SHA-256, 100 000 iterations, 16-byte zero salt) → AES-GCM-256
- Wire format: `base64(12-byte-IV ‖ AES-GCM-ciphertext)` in the AX.25 data field
- `cryptoKey` is derived once and cached; stopping and restarting audio clears it

---

## Audio graph

```mermaid
flowchart LR
    MIC[Mic stream] --> MS[MediaStreamSource]
    MS --> SP[ScriptProcessor\n4096 samples]
    SP --> SG[GainNode\ngain=0\nkeeps SP alive]
    SG --> DST[destination\nspeakers]

    TX[BufferSource\nmodulated AFSK] --> DST
```

The zero-gain node is required: `ScriptProcessor` only fires `onaudioprocess` when connected to the graph. Gain=0 prevents mic passthrough (no feedback). TX audio connects directly to `destination`, bypassing the RX chain.

---

## Microphone selection

On page load `populateMicList()` does a temporary `getUserMedia` grant to read device labels, then populates the `<select>`. Devices whose label contains `"webcam"` or `"general"` are pre-selected (targets "General - Webcam Microphone"). After `toggleAudio()` grants the real permission, `populateMicList()` re-runs so full labels are visible.

---

## `data-testid` attributes

| Value | Element |
|---|---|
| `callsign-input` | Callsign text field |
| `passphrase-input` | Passphrase password field |
| `mic-select` | Microphone device dropdown |
| `toggle-btn` | Start / Stop Audio button |
| `status` | Status label (Stopped / Running / Error) |
| `demod-mode` | Active demodulator label |
| `chat-log` | Chat message container |
| `message-input` | Outgoing message text field |
| `send-btn` | Send button |
| `chat-entry-tx` | TX message div (green) |
| `chat-entry-rx` | RX message div (blue) |
| `chat-entry-err` | Error message div (red) |

---

## Known limitations / future work

- `ScriptProcessor` is deprecated — migrate to `AudioWorklet` for production use
- Zero-salt PBKDF2 is weak against offline dictionary attacks
- No carrier detect — demodulator starts immediately on any audio; add squelch for VHF use
- Broadcast only (destination hardcoded to `ALL`)
- First high-rate position per GPU chunk is skipped by the discriminator (needs prior-sample differential)
- WebGPU `mapAsync` adds ~1–5 ms latency per chunk; imperceptible at 1200 baud
- DPLL uses phase-first-increment, making the effective sample point `phase < 1` (symbol start); midpoint sampling would give better noise margin on weak signals
