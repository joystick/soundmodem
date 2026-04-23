// ── DPLL — Digital Phase-Locked Loop for symbol clock recovery ────────────
// Consumes high-rate isMark estimates (one per STEP samples).
// Tracks symbol boundaries using frequency transitions as a phase reference.
// Emits one NRZI-decoded bit per recovered symbol.
//
// Loop parameters (tuned for Bell 202 over VHF audio):
//   α = 0.05  — phase correction gain  (responds quickly to timing errors)
//   β = 0.002 — frequency correction gain (slow drift compensation ±50 ppm)
//   ω limits  ±15% of nominal — prevents lock on harmonics

const SAMPLE_RATE = 44100;
const BAUD        = 1200;
const SPB         = Math.floor(SAMPLE_RATE / BAUD); // 36 samples per bit
const STEP        = 4;

export class DPLL {
  constructor() {
    this.OMEGA_NOM = SPB / STEP; // nominal period = 9.0 steps/symbol
    this.reset();
  }

  reset() {
    this.omega       = this.OMEGA_NOM;
    this.phase       = 0;
    this.lastFreq    = true;  // freq at previous step (for transition detect)
    this.lastSymFreq = true;  // freq at previous symbol boundary (for NRZI)
    this.snapshot    = true;  // captured freq at symbol start (for bit decision)
  }

  // Feed one high-rate isMark estimate.
  // Returns NRZI-decoded bit (0 or 1) at each symbol boundary, else null.
  feed(isMark) {
    const prevPhase = this.phase;
    this.phase += 1;

    // Capture the symbol's frequency at the very first step after phase reset.
    // At that step the Goertzel window [n*STEP, n*STEP+SPB) is perfectly aligned
    // with the symbol boundary, giving the cleanest (non-straddling) reading.
    if (prevPhase < 1) this.snapshot = isMark;

    // Frequency transition → use as phase reference for clock recovery.
    // With a Goertzel window of SPB samples sampled every STEP samples, transitions
    // appear at phase ≈ omega/2 + 1.5 (half-window delay + DPLL early-fire offset).
    if (isMark !== this.lastFreq) {
      const target = this.omega * 0.5 + 1.5;
      let err = this.phase - target;
      if (err >  this.omega / 2) err -= this.omega;
      if (err < -this.omega / 2) err += this.omega;
      this.phase -= err * 0.1;                             // α: phase correction
      this.omega  = Math.max(this.OMEGA_NOM * 0.85,
                   Math.min(this.OMEGA_NOM * 1.15,
                   this.omega - err * 0.0002));            // β: freq correction
    }
    this.lastFreq = isMark;

    if (this.phase >= this.omega) {
      this.phase -= this.omega;
      // NRZI: same frequency as previous symbol = data 1, different = data 0
      const bit = (this.snapshot === this.lastSymFreq) ? 1 : 0;
      this.lastSymFreq = this.snapshot;
      return bit;
    }
    return null;
  }
}
