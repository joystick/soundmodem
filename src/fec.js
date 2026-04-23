// Convolutional FEC — Rate 1/2, Constraint Length K=7
// Polynomials: G0=171₈ (0b1111001), G1=133₈ (0b1011011)
// Viterbi decoder: hard-decision, 64-state trellis

const K = 7;               // constraint length
const NUM_STATES = 1 << (K - 1); // 64
const G0 = 0b1111001;      // 171 octal
const G1 = 0b1011011;      // 133 octal

function parityBit(x) {
  x ^= x >> 4;
  x ^= x >> 2;
  x ^= x >> 1;
  return x & 1;
}

// ---------------------------------------------------------------------------
// convEncode(bits) → boolean[]
// Flushes the shift register with K-1 tail zeros so the trellis terminates.
// Output length = (bits.length + K - 1) * 2  (includes tail)
// ---------------------------------------------------------------------------
export function convEncode(bits) {
  const out = [];
  let reg = 0; // K-1 = 6 bit shift register

  const encode = (bit) => {
    reg = ((bit ? 1 : 0) << (K - 1) | reg) >>> 0;
    out.push(parityBit(reg & G0) !== 0);
    out.push(parityBit(reg & G1) !== 0);
    reg = (reg >> 1) & (NUM_STATES - 1);
  };

  for (const b of bits) encode(b);
  // Flush: K-1 tail zeros to return encoder to zero state
  for (let i = 0; i < K - 1; i++) encode(false);

  return out;
}

// ---------------------------------------------------------------------------
// viterbiDecode(encoded) → boolean[]
// Hard-decision Viterbi. Input length must be even (pairs of bits).
// Returns decoded bits excluding the K-1 tail zeros.
// ---------------------------------------------------------------------------
export function viterbiDecode(encoded) {
  const numPairs = encoded.length >> 1;
  const INF = 1e9;

  // Path metrics for each state
  let metrics = new Float64Array(NUM_STATES).fill(INF);
  metrics[0] = 0;

  // Survivor paths: survivors[t][state] = previous state
  const survivors = Array.from({ length: numPairs }, () => new Uint8Array(NUM_STATES));

  for (let t = 0; t < numPairs; t++) {
    const r0 = encoded[t * 2] ? 1 : 0;
    const r1 = encoded[t * 2 + 1] ? 1 : 0;
    const next = new Float64Array(NUM_STATES).fill(INF);

    for (let s = 0; s < NUM_STATES; s++) {
      if (metrics[s] === INF) continue;
      for (const bit of [0, 1]) {
        const reg = (bit << (K - 1) | s) >>> 0;
        const o0 = parityBit(reg & G0);
        const o1 = parityBit(reg & G1);
        const nextState = (reg >> 1) & (NUM_STATES - 1);
        const hamming = (o0 ^ r0) + (o1 ^ r1);
        const m = metrics[s] + hamming;
        if (m < next[nextState]) {
          next[nextState] = m;
          survivors[t][nextState] = s | (bit << 7); // pack bit into high byte
        }
      }
    }

    metrics = next;
  }

  // Traceback from best final state
  let state = 0;
  let best = metrics[0];
  for (let s = 1; s < NUM_STATES; s++) {
    if (metrics[s] < best) { best = metrics[s]; state = s; }
  }

  const decoded = new Array(numPairs);
  for (let t = numPairs - 1; t >= 0; t--) {
    const packed = survivors[t][state];
    decoded[t] = (packed >> 7) !== 0;
    state = packed & 0x7F;
  }

  // Strip K-1 tail zeros
  return decoded.slice(0, numPairs - (K - 1));
}

// ---------------------------------------------------------------------------
// interleave(bits, depth) / deinterleave(bits, depth)
// Block interleaver: write row-by-row, read column-by-column.
// Pads with false to fill the last row if needed.
// ---------------------------------------------------------------------------
export function interleave(bits, depth) {
  const cols = Math.ceil(bits.length / depth);
  const total = depth * cols;
  const padded = [...bits, ...new Array(total - bits.length).fill(false)];
  const out = [];
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < depth; r++)
      out.push(padded[r * cols + c]);
  return out;
}

export function deinterleave(bits, depth) {
  const cols = Math.ceil(bits.length / depth);
  const out = new Array(bits.length);
  let idx = 0;
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < depth; r++)
      out[r * cols + c] = bits[idx++];
  return out;
}
