const SAMPLE_RATE = 44100;

// ── CPU Goertzel (per sliding window, used in CPU fallback path) ───────────
export function goertzel(samples, freq) {
  const N = samples.length;
  const w = 2 * Math.PI * Math.round(freq * N / SAMPLE_RATE) / N;
  let re = 0, im = 0;
  for (let i = 0; i < N; i++) { re += samples[i] * Math.cos(i * w); im += samples[i] * Math.sin(i * w); }
  return Math.sqrt(re * re + im * im) / N;
}
