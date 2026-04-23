Since you are leveraging **WebGPU** for FFT, you have a massive computational advantage for parallel processing. In a $5\text{--}10\text{ kHz}$ HF channel at $0.9\text{ SNR}$, the "brute force" of the GPU can be used to run multiple candidate Viterbi paths or large-scale correlations simultaneously.

Here is the **Product Requirements Document (PRD)** for your WebGPU-based HF modem.

---

# PRD: Robust-OFDM Modem for AX.25 (HF-Band)

## 1. Objective
To implement a high-resilience digital modem utilizing WebGPU acceleration to transmit and receive AX.25 bitstreams over HF frequencies ($3\text{--}30\text{ MHz}$) within a $5\text{--}10\text{ kHz}$ bandwidth, optimized for extremely low SNR ($0.9$ or $\approx -0.5\text{ dB}$).

## 2. Technical Specifications

### 2.1 Modulation Layer (OFDM)
* **Subcarriers:** $N = 32$ to $64$ orthogonal subcarriers.
* **Modulation per Subcarrier:** BPSK (Binary Phase Shift Keying) to maximize Euclidean distance in the $I/Q$ plane.
* **Pilot Tones:** Minimum of $4$ fixed-position pilot subcarriers for phase tracking and frequency offset correction.
* **Guard Interval:** Cyclic Prefix (CP) length of $25\%$ of the symbol duration to mitigate HF multipath/selective fading.
* **Pulse Shaping:** Raised Cosine windowing to minimize side-lobe leakage into adjacent channels.

### 2.2 Coding & Error Correction (The Polynomials)
* **Inner Code:** Convolutional Code, Rate $R=1/2$, Constraint Length $K=7$. 
    * *Polynomials:* $G_0 = 171_8, G_1 = 133_8$.
* **Interleaving:** Block Interleaver to spread burst errors caused by HF "fades" across multiple OFDM symbols.
* **Outer Integrity:** Standard AX.25 CRC-16 (FCS) for final frame validation.
* **Decoding Algorithm:** Hard or Soft-Decision Viterbi implemented via WebGPU compute shaders.

### 2.3 Synchronization & Framing
* **Preamble:** A "Class 1" Chirp or Barker Sequence for robust Frame Sync in noise.
* **Clock Recovery:** DPLL logic translated into the frequency domain using phase-difference measurements between pilot tones.

---

## 3. WebGPU Implementation Requirements

### 3.1 Compute Shader Architecture
* **FFT/IFFT Station:** 1D Radix-2 FFT kernels to handle modulation/demodulation.
* **The Viterbi Decoder:** Parallelized Trellis processing. Each workgroup handles a different branch of the trace-back to find the maximum likelihood path through the noise.
* **Matched Filter Kernel:** Time-domain cross-correlation for initial signal detection, utilizing GPU shared memory for high-speed sliding window calculations.

### 3.2 Memory Buffering
* **Circular I/O:** Ring buffers for 16-bit PCM audio samples from the soundcard.
* **$I/Q$ Texture/Buffer:** Storage for the complex-valued constellations prior to FFT processing.

---

## 4. Performance Goals

| Metric | Target Requirement |
| :--- | :--- |
| **Minimum SNR** | $0.9$ (Successful decode of $>80\%$ packets). |
| **Bandwidth** | Software-selectable $5\text{ kHz}$ or $10\text{ kHz}$. |
| **Latency** | $<200\text{ms}$ (End-to-end processing). |
| **Throughput** | Variable; roughly $1200\text{--}4800\text{ bps}$ depending on CP and Code Rate. |

---

## 5. Functional Requirements (UX/UI)
1.  **Waterfall Display:** Real-time $I/Q$ visualization using WebGPU rendering to identify signal presence in the $10\text{ kHz}$ window.
2.  **Constellation View:** Radial chart (Real/Imaginary) to monitor "cloud" spread and EVM (Error Vector Magnitude).
3.  **Tuning Offset:** Automatic Frequency Control (AFC) to compensate for transceiver drift (common in HF).

---

## 6. Constraints & Risks
* **Browser Audio Jitter:** Use `AudioWorklet` to ensure the bitstream remains continuous and is not interrupted by the main JS thread.
* **HF Fading:** High-order MFSK might be needed as a fallback if selective fading destroys specific OFDM subcarriers.
* **WebGPU Availability:** Requires fallback or warning for non-supported browsers (specifically older versions of Safari/Firefox).

---

### Implementation Tip for WebGPU
Since you are using polynomials for the Rate 1/2 code, consider representing your state machine as a **Look-Up Table (LUT)** inside a `read-only` storage buffer in your shader. This allows the GPU to compute the "metric" (distance from the expected BPSK point) for all possible paths in the trellis simultaneously.

Do you want to focus on the **WGSL (WebGPU Shading Language)** logic for the Viterbi decoder, or the **IFFT/FFT** pipeline first?
