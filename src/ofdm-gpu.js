// Phase 5 — WebGPU DFT for OFDM demodulation
// One workgroup of 256 threads computes a single 256-point DFT.
// Each thread k accumulates sum(samples[n] * exp(-j2π·k·n/N)) via direct DFT.

const OFDM_N = 256;

const DFT_WGSL = /* wgsl */`
@group(0) @binding(0) var<storage, read>       samples: array<f32>;
@group(0) @binding(1) var<storage, read_write> out_re:  array<f32>;
@group(0) @binding(2) var<storage, read_write> out_im:  array<f32>;

const TWO_PI : f32 = 6.28318530717958647;
const N      : u32 = 256u;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= N) { return; }
  var re: f32 = 0.0;
  var im: f32 = 0.0;
  for (var n: u32 = 0u; n < N; n++) {
    let angle: f32 = -TWO_PI * f32(k) * f32(n) / f32(N);
    re += samples[n] * cos(angle);
    im += samples[n] * sin(angle);
  }
  out_re[k] = re;
  out_im[k] = im;
}
`;

// ---------------------------------------------------------------------------
// GpuDft: wraps a WebGPU device and computes 256-point DFTs on the GPU.
// ---------------------------------------------------------------------------
export class GpuDft {
  constructor(device) {
    this._device = device;
    const shader = device.createShaderModule({ code: DFT_WGSL });
    this._pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: shader, entryPoint: 'main' },
    });
    const BUF = OFDM_N * 4; // bytes for Float32Array of length N
    this._sampleBuf = device.createBuffer({
      size: BUF,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._reBuf = device.createBuffer({
      size: BUF,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this._imBuf = device.createBuffer({
      size: BUF,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this._readReBuf = device.createBuffer({
      size: BUF,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this._readImBuf = device.createBuffer({
      size: BUF,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this._bindGroup = device.createBindGroup({
      layout: this._pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._sampleBuf } },
        { binding: 1, resource: { buffer: this._reBuf } },
        { binding: 2, resource: { buffer: this._imBuf } },
      ],
    });
  }

  // dft(samples: Float32Array(N)) → { re: Float32Array(N), im: Float32Array(N) }
  async dft(samples) {
    const device = this._device;
    device.queue.writeBuffer(this._sampleBuf, 0, samples.buffer ?? samples, samples.byteOffset ?? 0, OFDM_N * 4);

    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, this._bindGroup);
    pass.dispatchWorkgroups(1); // 256 threads = 1 workgroup
    pass.end();
    enc.copyBufferToBuffer(this._reBuf, 0, this._readReBuf, 0, OFDM_N * 4);
    enc.copyBufferToBuffer(this._imBuf, 0, this._readImBuf, 0, OFDM_N * 4);
    device.queue.submit([enc.finish()]);

    await Promise.all([
      this._readReBuf.mapAsync(GPUMapMode.READ),
      this._readImBuf.mapAsync(GPUMapMode.READ),
    ]);
    const re = new Float32Array(this._readReBuf.getMappedRange().slice(0));
    const im = new Float32Array(this._readImBuf.getMappedRange().slice(0));
    this._readReBuf.unmap();
    this._readImBuf.unmap();
    return { re, im };
  }
}

// ---------------------------------------------------------------------------
// initGpuDft(device?) → GpuDft | null
// Pass an existing GPUDevice to reuse it (avoids a second requestAdapter call).
// If device is null/undefined, attempts to obtain one from navigator.gpu.
// ---------------------------------------------------------------------------
export async function initGpuDft(device = null) {
  try {
    if (!device) {
      if (typeof navigator === 'undefined' || !navigator.gpu) return null;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      device = await adapter.requestDevice();
    }
    return new GpuDft(device);
  } catch {
    return null;
  }
}
