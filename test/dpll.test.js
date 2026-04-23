import { describe, it, expect } from 'vitest';
import { DPLL } from '../src/dpll.js';

const OMEGA_NOM = 9; // SPB/STEP = 36/4

describe('DPLL', () => {
  it('initialises with omega=OMEGA_NOM and phase=0', () => {
    const dpll = new DPLL();
    expect(dpll.omega).toBe(OMEGA_NOM);
    expect(dpll.phase).toBe(0);
  });

  it('reset restores initial state', () => {
    const dpll = new DPLL();
    // Feed enough to change state
    for (let i = 0; i < 20; i++) dpll.feed(true);
    dpll.reset();
    expect(dpll.omega).toBe(OMEGA_NOM);
    expect(dpll.phase).toBe(0);
  });

  it('emits a bit after approximately OMEGA_NOM steps of constant mark', () => {
    const dpll = new DPLL();
    let bits = [];
    for (let i = 0; i < 20; i++) {
      const b = dpll.feed(true);
      if (b !== null) bits.push(b);
    }
    // Should emit at least 1 bit in 20 steps (nominal period is 9)
    expect(bits.length).toBeGreaterThan(0);
  });

  it('emits only 0s or 1s (never other values)', () => {
    const dpll = new DPLL();
    for (let i = 0; i < 100; i++) {
      const b = dpll.feed(i % 9 < 5); // alternating mark/space
      if (b !== null) {
        expect(b === 0 || b === 1).toBe(true);
      }
    }
  });

  it('decodes constant mark (no NRZI transitions) as all-1 bits', () => {
    const dpll = new DPLL();
    const bits = [];
    // Feed 200 steps of constant mark (no transitions → NRZI stays same → all 1s)
    for (let i = 0; i < 200; i++) {
      const b = dpll.feed(true);
      if (b !== null) bits.push(b);
    }
    expect(bits.length).toBeGreaterThan(10);
    // All should be 1 (no frequency change = NRZI 1)
    expect(bits.every(b => b === 1)).toBe(true);
  });

  it('omega stays within ±15% of nominal', () => {
    const dpll = new DPLL();
    // Feed a noisy alternating signal
    for (let i = 0; i < 500; i++) {
      dpll.feed(Math.sin(i * 0.7) > 0);
    }
    expect(dpll.omega).toBeGreaterThanOrEqual(OMEGA_NOM * 0.85);
    expect(dpll.omega).toBeLessThanOrEqual(OMEGA_NOM * 1.15);
  });
});
