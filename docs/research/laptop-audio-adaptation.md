# Laptop Audio Device Adaptation for OFDM-HF

## Problem

The OFDM-HF modem uses 52 data subcarriers spanning bins 6–58, which maps to **1,034 Hz – 9,991 Hz** at Fs=44100, N=256. Laptop speakers and microphones have uneven frequency response across this range — particularly at the upper end — causing subcarrier dropouts that degrade or prevent decoding.

Bell 202 AFSK is unaffected because it uses only 1200 Hz and 2200 Hz, comfortably within every audio device's passband.

## Current OFDM-HF frequency map

```
Bin     Freq (Hz)   Role
─────   ─────────   ────────────────
6       1,034       first data carrier
8       1,378       pilot
22      3,790       pilot
31      5,340       last lower-band data
33      5,685       first upper-band data
36      6,203       pilot
50      8,614       pilot
58      9,991       last data carrier
```

Subcarrier spacing: Δf = 44100/256 ≈ 172.27 Hz

## Typical laptop audio characteristics

### Speakers

| Parameter           | Typical range         | Notes                                    |
|---------------------|-----------------------|------------------------------------------|
| Useful bandwidth    | 300 Hz – 8 kHz       | Varies widely by model                   |
| Low-end rolloff     | 12 dB/oct below 500 Hz | Tiny driver, no bass reflex            |
| High-end rolloff    | Steep above 8–10 kHz | Dome resonance, enclosure damping        |
| Resonance peaks     | 1–4 kHz typical      | +6 to +10 dB peaks common                |
| Enclosure nulls     | Model-specific        | Can be 15–20 dB deep at certain freqs    |
| Max SPL             | 65–75 dBA @ 30 cm    | Limited by driver excursion              |

**The speaker is almost always the bottleneck.** Bins above ~46 (≈7,929 Hz) are at risk on many laptops. Bins above 52 (≈8,959 Hz) are likely dead on most.

### Microphones

| Parameter           | Typical range         | Notes                                    |
|---------------------|-----------------------|------------------------------------------|
| Useful bandwidth    | 100 Hz – 12 kHz      | Better than speakers                     |
| Noise floor         | -50 to -60 dBFS      | Varies with fan speed, environment       |
| AGC                 | OS-managed            | Causes level fluctuations between frames |
| Directivity         | Omnidirectional       | Picks up room reflections                |

### Room acoustics (over-the-air path)

When TX and RX are separate devices communicating over air:
- Multipath delay spread: 1–5 ms typical indoor (our CP = 64/44100 ≈ 1.45 ms — may be insufficient for large rooms)
- Ambient noise: fan, keyboard, environment — broadband, affects all subcarriers
- Distance attenuation: 1/r² in free space; indoor reflections partially compensate

## Adaptation strategies

### Strategy 1: Conservative "laptop-safe" preset

**Approach:** Narrow the active band to frequencies that work on any hardware.

Safe band: bins 6–40 → **1,034 Hz – 6,891 Hz**

| Parameter        | Current    | Laptop-safe | Change     |
|------------------|------------|-------------|------------|
| Data carriers    | 52         | ~30         | -42%       |
| Frequency span   | 1–10 kHz   | 1–7 kHz    | -30%       |
| Pilots           | 4          | 3 (drop bin 50) | -1     |
| Bits/symbol      | 52         | ~30         | -42%       |
| Raw bitrate      | 7,151 bps  | ~4,128 bps  | -42%       |

**Pros:** Zero runtime complexity. Works on any device without calibration.
**Cons:** Wastes bandwidth on devices that can handle 10 kHz.

### Strategy 2: Channel sounding probe

**Approach:** TX a known wideband signal; RX measures per-subcarrier amplitude and SNR; feed results back to TX.

Protocol:
1. TX sends N "probe symbols" — all subcarriers at known amplitude (+1 BPSK)
2. RX computes `|H(k)|²` at each subcarrier k from the received FFT magnitudes
3. RX computes per-subcarrier SNR: `SNR(k) = |H(k)|² / noise_floor`
4. Subcarriers with `SNR(k) < threshold` are marked dead
5. Active subcarrier mask is displayed to user or auto-applied

This is a **one-shot calibration** — run once when setting up, not per-frame.

**Pros:** Optimal — uses every usable subcarrier, skips dead ones.
**Cons:** Requires both TX and RX to cooperate; need to communicate the mask; adds protocol complexity.

### Strategy 3: Pilot-interpolated adaptation (RX-only)

**Approach:** Use existing pilot tones to estimate the channel shape; disable subcarriers in estimated dead zones.

We have pilots at bins 8, 22, 36, 50. After AFC, their received amplitudes give us 4 points on the channel frequency response curve. Interpolate (linear or spline) to estimate |H(k)| for all data carriers. If the interpolated SNR at a data carrier falls below a threshold, mark the bit as an erasure for Viterbi (soft-decision) or simply ignore it.

```
Pilot SNR measurements:
  bin 8  (1,378 Hz) → strong (typical)
  bin 22 (3,790 Hz) → strong (typical)
  bin 36 (6,203 Hz) → moderate to strong
  bin 50 (8,614 Hz) → weak to dead (common on laptops)
```

If pilot 50 shows SNR < 3 dB, we can infer that bins ~46–58 are unreliable and mask them out.

**Pros:** RX-only, no protocol change, works with existing TX.
**Cons:** 4 pilots give coarse resolution; misses narrow nulls between pilots.

### Strategy 4: Adaptive power loading (water-filling)

**Approach:** Boost TX power on weak subcarriers, reduce on strong ones, keeping total power constant.

Requires channel knowledge at the TX side (from Strategy 2 feedback or pre-shared calibration). Allocate more power to subcarriers with poor channel gain, less to strong ones.

**Pros:** Maximizes capacity (Shannon-optimal).
**Cons:** Complex; requires TX-side adaptation; PAPR increases; marginal benefit over simple masking for BPSK.

## Recommendation

**Phase 1 (immediate):** Implement Strategy 1 — add a `laptop-safe` OFDM profile as a mode option. Costs nothing, unblocks users with poor speakers.

**Phase 2 (near-term):** Implement Strategy 3 — pilot-interpolated subcarrier masking at RX. This is RX-only, needs no protocol changes, and automatically adapts to whatever hardware is in use. If pilot 50 is dead, mask the upper band.

**Phase 3 (future):** Implement Strategy 2 — channel sounding probe for optimal TX+RX adaptation. Only worth doing once we have bidirectional communication (ARQ) where we can feed the mask back.

Strategy 4 (water-filling) is overkill for BPSK and adds PAPR problems. Skip unless we move to higher-order modulation (QPSK/16-QAM).

## Open questions

- Should `laptop-safe` mode also increase the cyclic prefix? Current CP=64 samples (1.45 ms) may be tight for over-the-air multipath in a room. CP=128 (2.9 ms) halves throughput but handles longer delay spreads.
- Should we add more pilot tones in the laptop-safe band for better channel estimation? E.g., pilots at bins 8, 16, 24, 32 (4 pilots across 1–5.5 kHz) instead of the current wide-spaced set.
- AGC on the OS microphone input may cause inter-symbol amplitude variation. Should we add per-symbol amplitude normalization before BPSK decisions?
