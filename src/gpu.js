// ── WebGPU demodulators ────────────────────────────────────────────────────

const MARK_FREQ   = 1200;
const SPACE_FREQ  = 2200;
const SAMPLE_RATE = 44100;
const SPB         = Math.floor(SAMPLE_RATE / 1200); // 36
const STEP        = 4;

// ── WebGPU: high-rate parallel Goertzel (Option 2) ────────────────────────
const GOERTZEL_WGSL = /* wgsl */`
struct Params {
  num_samples   : u32,
  num_positions : u32,
  step          : u32,
  spb           : u32,
  mark_k        : f32,  // MARK_FREQ  * spb / SAMPLE_RATE
  space_k       : f32,  // SPACE_FREQ * spb / SAMPLE_RATE
}
@group(0) @binding(0) var<uniform>             p       : Params;
@group(0) @binding(1) var<storage, read>       samples : array<f32>;
@group(0) @binding(2) var<storage, read_write> ismark  : array<u32>;

const TWO_PI : f32 = 6.28318530718;

fn goertzel_sq(off : u32, k : f32) -> f32 {
  let w = TWO_PI * k / f32(p.spb);
  var re : f32 = 0.0; var im : f32 = 0.0;
  for (var i : u32 = 0u; i < p.spb; i++) {
    let s = samples[off + i];
    re += s * cos(f32(i) * w);
    im += s * sin(f32(i) * w);
  }
  return re * re + im * im;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  let pos = id.x;
  if (pos >= p.num_positions) { return; }
  let off = pos * p.step;
  if (off + p.spb > p.num_samples) { ismark[pos] = 1u; return; }
  ismark[pos] = select(0u, 1u, goertzel_sq(off, p.mark_k) >= goertzel_sq(off, p.space_k));
}`;

// ── WebGPU: high-rate FM discriminator (Option 3) ─────────────────────────
const DISCRIMINATOR_WGSL = /* wgsl */`
struct Params {
  num_samples      : u32,
  num_positions    : u32,
  step             : u32,
  spb              : u32,
  center_phase_inc : f32,  // 2π * 1700 / 44100
}
@group(0) @binding(0) var<uniform>             p      : Params;
@group(0) @binding(1) var<storage, read>       samples: array<f32>;
@group(0) @binding(2) var<storage, read_write> ismark : array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  let pos = id.x;
  if (pos >= p.num_positions) { return; }
  let off = pos * p.step;
  if (off + p.spb > p.num_samples) { ismark[pos] = 1u; return; }
  // Need one prior sample for the differential; skip pos 0.
  if (off == 0u) { ismark[pos] = 1u; return; }

  let pi  = p.center_phase_inc;
  var I_p = samples[off - 1u] * cos(f32(off - 1u) * pi);
  var Q_p = samples[off - 1u] * sin(f32(off - 1u) * pi);
  var disc : f32 = 0.0;

  for (var i : u32 = 0u; i < p.spb; i++) {
    let n = off + i;
    let ph = f32(n) * pi;
    let I  = samples[n] * cos(ph);
    let Q  = samples[n] * sin(ph);
    disc  += Q * I_p - I * Q_p;
    I_p = I; Q_p = Q;
  }
  ismark[pos] = select(0u, 1u, disc < 0.0);
}`;

// ── GpuDemodulator ────────────────────────────────────────────────────────
export class GpuDemodulator {
  constructor(device, mode) {
    this.device       = device;
    this.mode         = mode;   // 'goertzel' | 'discriminator'
    this.MAX_SAMPLES  = 4096;
    this.MAX_POSITIONS = Math.ceil(this.MAX_SAMPLES / STEP); // 1024
    this.PARAM_BYTES  = 32;     // multiple of 16 required for uniform buffers
  }

  init() {
    const d = this.device;
    this.paramBuf  = d.createBuffer({ size: this.PARAM_BYTES,        usage: GPUBufferUsage.UNIFORM  | GPUBufferUsage.COPY_DST });
    this.sampleBuf = d.createBuffer({ size: this.MAX_SAMPLES * 4,    usage: GPUBufferUsage.STORAGE  | GPUBufferUsage.COPY_DST });
    this.ismarkBuf = d.createBuffer({ size: this.MAX_POSITIONS * 4,  usage: GPUBufferUsage.STORAGE  | GPUBufferUsage.COPY_SRC });
    this.readBuf   = d.createBuffer({ size: this.MAX_POSITIONS * 4,  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const src = this.mode === 'discriminator' ? DISCRIMINATOR_WGSL : GOERTZEL_WGSL;
    const mod = d.createShaderModule({ code: src });
    const bgl = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ]});
    this.bindGroup = d.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer: this.paramBuf } },
      { binding: 1, resource: { buffer: this.sampleBuf } },
      { binding: 2, resource: { buffer: this.ismarkBuf } },
    ]});
    this.pipeline = d.createComputePipeline({
      layout:  d.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      compute: { module: mod, entryPoint: 'main' },
    });
  }

  // Returns Uint32Array of isMark values at STEP-sample rate.
  async processChunk(samples) {
    const d = this.device;
    const n = samples.length;
    const numPos = Math.floor((n - SPB) / STEP) + 1;
    if (numPos <= 0) return new Uint32Array(0);

    const pv = new DataView(new ArrayBuffer(this.PARAM_BYTES));
    pv.setUint32( 0, n,      true);
    pv.setUint32( 4, numPos, true);
    pv.setUint32( 8, STEP,   true);
    pv.setUint32(12, SPB,    true);
    if (this.mode === 'goertzel') {
      pv.setFloat32(16, MARK_FREQ  * SPB / SAMPLE_RATE, true);
      pv.setFloat32(20, SPACE_FREQ * SPB / SAMPLE_RATE, true);
    } else {
      pv.setFloat32(16, 2 * Math.PI * (MARK_FREQ + SPACE_FREQ) / 2 / SAMPLE_RATE, true);
    }
    d.queue.writeBuffer(this.paramBuf,  0, pv.buffer);
    d.queue.writeBuffer(this.sampleBuf, 0, samples.buffer, samples.byteOffset, n * 4);

    const enc  = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(numPos / 64));
    pass.end();
    enc.copyBufferToBuffer(this.ismarkBuf, 0, this.readBuf, 0, numPos * 4);
    d.queue.submit([enc.finish()]);

    await this.readBuf.mapAsync(GPUMapMode.READ, 0, numPos * 4);
    const result = new Uint32Array(this.readBuf.getMappedRange(0, numPos * 4)).slice();
    this.readBuf.unmap();
    return result;
  }

  destroy() {
    [this.paramBuf, this.sampleBuf, this.ismarkBuf, this.readBuf].forEach(b => b.destroy());
  }
}

// Shared GPU device — exposed so other modules can reuse the same device
// instead of calling requestDevice() a second time.
let _gpuDevice = null;
export function getSharedGpuDevice() { return _gpuDevice; }

export async function initWebGpu(addChat) {
  const el = document.getElementById('demod-mode');
  if (!navigator.gpu) { el.textContent = 'using CPU'; el.style.color = '#b8860b'; return null; }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no adapter');
    const device  = await adapter.requestDevice();
    _gpuDevice = device;
    device.lost.then(info => {
      const dm = document.getElementById('demod-mode');
      dm.textContent = 'using CPU'; dm.style.color = '#b8860b';
      if (addChat) addChat(`GPU lost: ${info.message}`, 'err');
    });
    for (const mode of ['discriminator', 'goertzel']) {
      try {
        const dem = new GpuDemodulator(device, mode);
        dem.init();
        el.textContent = `using GPU (${mode === 'discriminator' ? 'FM discriminator' : 'Goertzel'})`;
        el.style.color = 'green';
        return dem;
      } catch { /* try next mode */ }
    }
    throw new Error('all GPU modes failed');
  } catch (e) {
    el.textContent = 'using CPU'; el.style.color = '#b8860b';
    return null;
  }
}
