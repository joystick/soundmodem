// OfdmProcessor — AudioWorkletProcessor for OFDM-HF mode
// Collects input samples and forwards them to the main thread via port.postMessage.
// OFDM demodulation runs on the main thread (createOfdmDemodulator) to avoid
// bundling complexity inside the worklet scope.
class OfdmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) this.port.postMessage(ch.slice());
    return true; // keep processor alive
  }
}

registerProcessor('ofdm-processor', OfdmProcessor);
