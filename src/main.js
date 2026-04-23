import { crc16 } from './crc16.js';
import { bitStuff, encodeCallsign, buildFrame, buildFrameRaw } from './ax25.js';
import { DPLL } from './dpll.js';
import { modulate, MARK_FREQ, SPACE_FREQ, SAMPLE_RATE, SPB, STEP, PREAMBLE_FLAGS, POSTAMBLE_FLAGS } from './modulate.js';
import { goertzel } from './goertzel.js';
import { createDemodulator } from './demodulate.js';
import { compress, decompress } from './compress.js';
import { deriveKey, encryptBytes as cryptoEncryptBytes, decryptBytes as cryptoDecryptBytes } from './crypto.js';
import { GpuDemodulator, initWebGpu, getSharedGpuDevice } from './gpu.js';
import { addChat as addChatFn, populateMicList as populateMicListFn } from './ui.js';
import { ofdmEncodeFrame, ofdmEncodeFrameRaw } from './ofdm.js';
import { encodePacket, decodePacket, CHUNK_SIZE } from './packet.js';
import { createOfdmDemodulator } from './ofdm-demodulate.js';
import { initGpuDft } from './ofdm-gpu.js';
import { S, E, transition, isAudioActive } from './fsm.js';

// ── FSM state ─────────────────────────────────────────────────────────────
let fsmState   = S.IDLE;
let fsmContext = { mode: 'bell202', errorMessage: null };

// ── File transfer pause gate ───────────────────────────────────────────────
// sendFile awaits _pauseGate between fragments; pause replaces it with a
// pending Promise, resume/cancel resolve it.
let _pauseGate    = Promise.resolve();
let _pauseResolve = null;  // resolver for the current gate; null when not paused
let _cancelXfer   = false; // set true by cancelTx() to break the send loop

// ── Runtime state ─────────────────────────────────────────────────────────
let audioContext, micNode, scriptNode;
let _micStream = null; // held between requesting-mic → initializing
let callsign = '', passphrase = '', cryptoKey = null;
let ofdmWorkletNode = null;
let ofdmDemodInstance = null;
const incomingTransfers = new Map();

const chatEl   = document.getElementById('chat');

let gpuDemodulator = null;
let gpuQueue       = [];
let gpuBusy        = false;

// ── Helpers ───────────────────────────────────────────────────────────────
function addChat(text, cls) {
  addChatFn(chatEl, text, cls);
}

function setModemMode(mode) {
  dispatch({ type: E.MODE_CHANGE, mode });
  document.getElementById('modemMode').value = fsmContext.mode;
  localStorage.setItem('modemMode', fsmContext.mode);
}

async function ensureCryptoKey() {
  if (cryptoKey || !passphrase) return;
  cryptoKey = await deriveKey(passphrase);
}

async function encryptMsg(msg) {
  if (!passphrase) return msg;
  await ensureCryptoKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(enc)));
}

async function decryptMsg(payload) {
  if (!passphrase || !cryptoKey) return payload;
  try {
    const b = Uint8Array.from(atob(payload), c => c.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b.slice(0, 12) }, cryptoKey, b.slice(12)));
  } catch { return '[decrypt failed]'; }
}

async function encryptBytesLocal(plainBytes) {
  await ensureCryptoKey();
  if (!cryptoKey) return plainBytes;
  return cryptoEncryptBytes(cryptoKey, plainBytes);
}

async function decryptBytesLocal(cipherBytes) {
  await ensureCryptoKey();
  if (!cryptoKey) return cipherBytes;
  return cryptoDecryptBytes(cryptoKey, cipherBytes);
}

// ── Demodulator ───────────────────────────────────────────────────────────
const demodulator = createDemodulator({
  onMessage: receiveMsg,
  onFilePacket: receiveFilePacket,
});

function consumeIsMarkArray(isMarkArr) {
  // This wraps the GPU output into the shared DPLL path.
  // For GPU path we feed directly into a secondary dpll instance.
  // We replicate the logic here so we can use the demodulator's internal state.
  // Actually: feed through a separate path that mirrors what cpuProcessChunk does.
  // The GPU path needs its own DPLL state (separate from the CPU demodulator's).
  for (const m of isMarkArr) {
    const bit = gpuDpll.feed(m === 1);
    if (bit !== null) gpuDemodBits.push(bit);
  }
  if (gpuDemodBits.length >= 160) tryDecodeGpuFrame();
}

// GPU path state (separate from CPU demodulator)
const gpuDpll = new DPLL();
let gpuDemodBits = [];
let gpuScanPos = 0;

function tryDecodeGpuFrame() {
  const FLAG      = [0, 1, 1, 1, 1, 1, 1, 0];
  const matchFlag = pos => FLAG.every((b, j) => gpuDemodBits[pos + j] === b);
  let consumed    = 0;

  for (let i = Math.max(0, gpuScanPos - 8); i + 8 <= gpuDemodBits.length; i++) {
    if (!matchFlag(i)) continue;
    for (let end = i + 64; end + 8 <= gpuDemodBits.length && end - i <= 32768; end++) {
      if (!matchFlag(end)) continue;
      const frameBits = gpuDemodBits.slice(i + 8, end);
      const destuffed = []; let ones = 0, corrupt = false;
      for (const b of frameBits) {
        if (ones === 5) { if (b !== 0) { corrupt = true; break; } ones = 0; continue; }
        destuffed.push(b); ones = b === 1 ? ones + 1 : 0;
      }
      if (corrupt || destuffed.length % 8 !== 0) continue;
      const bytes = [];
      for (let k = 0; k < destuffed.length; k += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | destuffed[k + j];
        bytes.push(byte);
      }
      if (bytes.length < 3) continue;
      let crc = 0xFFFF;
      for (const b of bytes.slice(0, -2)) {
        crc ^= (b << 8);
        for (let ii = 0; ii < 8; ii++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xFFFF;
      }
      const eH = (crc >> 8) & 0xFF, eL = crc & 0xFF;
      const [cH, cL] = bytes.slice(-2);
      if (cH !== eH || cL !== eL) continue;
      const data = new Uint8Array(bytes.slice(16, -2));
      if (data.length >= 2 && data[0] === 0xFE && data[1] === 0xFF) {
        receiveFilePacket(data);
      } else {
        const msg = new TextDecoder().decode(data);
        if (msg) receiveMsg(msg);
      }
      consumed = end + 8; i = end; break;
    }
  }
  const trimAt = Math.max(consumed, gpuDemodBits.length - 36000);
  gpuDemodBits = gpuDemodBits.slice(trimAt);
  gpuScanPos = Math.max(0, gpuDemodBits.length);
}

// ── GPU async queue drain ──────────────────────────────────────────────────
async function drainGpuQueue() {
  gpuBusy = true;
  while (gpuQueue.length > 0) {
    const chunk = gpuQueue.shift();
    consumeIsMarkArray(await gpuDemodulator.processChunk(chunk));
  }
  gpuBusy = false;
}

// ── processAudioChunk: routes to GPU or CPU ────────────────────────────────
function processAudioChunk(inputSamples) {
  if (gpuDemodulator) {
    gpuQueue.push(new Float32Array(inputSamples)); // copy before SP buffer reuse
    // Cap queue to prevent unbounded growth if GPU can't keep up
    while (gpuQueue.length > 8) gpuQueue.shift();
    if (!gpuBusy) drainGpuQueue();
  } else {
    demodulator.cpuProcessChunk(inputSamples);
  }
}

// ── Send / receive ─────────────────────────────────────────────────────────
async function sendMsg() {
  const msgEl = document.getElementById('message');
  const msg   = msgEl.value.trim();
  if (!msg) return;
  if (!callsign)              { alert('Enter callsign first'); return; }
  if (fsmState !== S.RUNNING) { alert('Click "Start Audio" first'); return; }
  msgEl.value = '';
  dispatch({ type: E.START_TX });
  try {
    let audioData;
    if (fsmContext.mode === 'ofdm') {
      audioData = ofdmEncodeFrame(`${callsign}>${await encryptMsg(msg)}`);
    } else {
      const frameBytes = buildFrame(`${callsign}>${await encryptMsg(msg)}`, 'ALL', callsign);
      audioData = modulate(frameBytes);
    }
    const buf = audioContext.createBuffer(1, audioData.length, SAMPLE_RATE);
    buf.getChannelData(0).set(audioData);
    const src = audioContext.createBufferSource();
    src.buffer = buf; src.connect(audioContext.destination);
    await new Promise(resolve => { src.onended = resolve; src.start(); });
    addChat(`TX ${callsign}: ${msg}`, 'tx');
  } catch (err) {
    addChat(`TX error: ${err.message}`, 'err');
    console.error('sendMsg error:', err);
  } finally {
    dispatch({ type: E.TX_DONE });
  }
}

async function receiveMsg(raw) {
  const sep = raw.indexOf('>');
  addChat(`RX ${sep > 0 ? raw.slice(0, sep) : '?'}: ${
    passphrase ? await decryptMsg(sep > 0 ? raw.slice(sep + 1) : raw)
               : (sep > 0 ? raw.slice(sep + 1) : raw)}`, 'rx');
}

// ── File transfer: play frame ──────────────────────────────────────────────
function playFrame(frameBytes) {
  return new Promise(resolve => {
    const audioData = modulate(frameBytes);
    const buf = audioContext.createBuffer(1, audioData.length, SAMPLE_RATE);
    buf.getChannelData(0).set(audioData);
    const src = audioContext.createBufferSource();
    src.buffer = buf; src.connect(audioContext.destination);
    src.onended = resolve; src.start();
  });
}

function playOfdmFrame(bytes) {
  return new Promise(resolve => {
    const audioData = ofdmEncodeFrameRaw(bytes);
    const buf = audioContext.createBuffer(1, audioData.length, SAMPLE_RATE);
    buf.getChannelData(0).set(audioData);
    const src = audioContext.createBufferSource();
    src.buffer = buf; src.connect(audioContext.destination);
    src.onended = resolve; src.start();
  });
}

async function sendFile() {
  const fileInput = document.getElementById('fileInput');
  const file = fileInput.files[0];
  if (!file) return;
  if (!callsign)              { alert('Enter callsign first'); return; }
  if (fsmState !== S.RUNNING) { alert('Click "Start Audio" first'); return; }
  fileInput.value = '';

  _cancelXfer   = false;
  _pauseGate    = Promise.resolve();
  _pauseResolve = null;

  dispatch({ type: E.START_TX });
  try {
    await ensureCryptoKey();

    addChat(`TX FILE ${file.name} — ${file.size} B, compressing…`, 'file');
    const raw        = new Uint8Array(await file.arrayBuffer());
    const compressed = await compress(raw);
    const ratio      = (raw.length / compressed.length).toFixed(1);
    addChat(`TX FILE ${file.name} — compressed ${raw.length}→${compressed.length} B (${ratio}×)`, 'file');

    const xferId = crypto.getRandomValues(new Uint8Array(2));
    const total  = Math.max(1, Math.ceil(compressed.length / CHUNK_SIZE));
    updateXferProgress(file.name, 0, total);

    for (let seq = 0; seq < total; seq++) {
      // Wait if paused (resolves immediately when running); bail if cancelled
      await _pauseGate;
      if (_cancelXfer) break;

      const data    = compressed.slice(seq * CHUNK_SIZE, (seq + 1) * CHUNK_SIZE);
      const payload = encodePacket({ xferId, seq, total, filename: seq === 0 ? file.name : undefined, data });

      const encrypted = await encryptBytesLocal(payload);

      if (fsmContext.mode === 'ofdm') {
        await playOfdmFrame(encrypted);
      } else {
        await playFrame(buildFrameRaw(encrypted, 'ALL', callsign));
      }

      updateXferProgress(file.name, seq + 1, total);
    }

    if (_cancelXfer) {
      addChat(`TX FILE ${file.name} — cancelled`, 'file');
    } else {
      addChat(`TX FILE ${file.name} — all ${total} fragment(s) sent`, 'file');
    }
  } catch (err) {
    addChat(`TX FILE ${file.name} — error: ${err.message}`, 'err');
    console.error('sendFile error:', err);
  } finally {
    _cancelXfer   = false;
    _pauseResolve = null;
    _pauseGate    = Promise.resolve();
    dispatch({ type: E.TX_DONE });
  }
}

function updateXferProgress(filename, sent, total) {
  document.getElementById('xfer-filename').textContent  = filename;
  document.getElementById('xfer-frag-count').textContent = `${sent} / ${total}`;
  document.getElementById('xfer-bar').style.width = `${total ? (sent / total) * 100 : 0}%`;
}

function togglePauseTx() {
  if (fsmState === S.TX) {
    // Pause: replace gate with a pending Promise
    _pauseGate = new Promise(resolve => { _pauseResolve = resolve; });
    dispatch({ type: E.PAUSE_TX });
  } else if (fsmState === S.TX_PAUSED) {
    // Resume: resolve the gate
    if (_pauseResolve) { _pauseResolve(); _pauseResolve = null; }
    _pauseGate = Promise.resolve();
    dispatch({ type: E.RESUME_TX });
  }
}

function cancelTx() {
  _cancelXfer = true;
  if (_pauseResolve) { _pauseResolve(); _pauseResolve = null; }
  _pauseGate = Promise.resolve();
  if (fsmState === S.TX_PAUSED) dispatch({ type: E.CANCEL_TX });
  // If currently TX (playing a fragment), let TX_DONE fire normally;
  // _cancelXfer will break the loop before the next fragment starts.
}

async function receiveFilePacket(rawData) {
  const decrypted = await decryptBytesLocal(rawData);
  const pkt = decodePacket(decrypted);
  if (!pkt) return;

  const { xferId, seq, total, filename, data } = pkt;
  if (!incomingTransfers.has(xferId)) {
    incomingTransfers.set(xferId, { total, filename: null, fragments: new Array(total) });
  }
  const xfer = incomingTransfers.get(xferId);
  if (filename) xfer.filename = filename;
  xfer.fragments[seq] = data;

  const received = xfer.fragments.filter(Boolean).length;
  addChat(`RX FILE ${xfer.filename || '?'} — fragment ${seq + 1}/${total} (${received}/${total})`, 'file');

  if (received === total && xfer.fragments.every(Boolean)) {
    const combined = new Uint8Array(xfer.fragments.reduce((n, f) => n + f.length, 0));
    let off = 0; for (const f of xfer.fragments) { combined.set(f, off); off += f.length; }

    let decompressed;
    try { decompressed = await decompress(combined); }
    catch (e) { addChat(`RX FILE ${xfer.filename} — decompress failed: ${e.message}`, 'err'); return; }

    const blob = new Blob([decompressed]);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = xfer.filename || 'received-file'; a.click();
    URL.revokeObjectURL(url);

    addChat(`RX FILE ${xfer.filename} — complete! ${decompressed.length} B — saved ↓`, 'file');
    incomingTransfers.delete(xferId);
  }
}

// ── Mic device list ────────────────────────────────────────────────────────
async function populateMicList() {
  await populateMicListFn(document.getElementById('micSelect'));
}

// ── FSM: dispatch + render + side effects ─────────────────────────────────

function dispatch(event) {
  const next = transition(fsmState, event, fsmContext);
  if (next.state === fsmState && next.context === fsmContext) return;
  fsmState   = next.state;
  fsmContext = next.context;
  renderState(fsmState, fsmContext);
  handleStateEntry(fsmState, fsmContext);
}

function renderState(state, context) {
  const btn      = document.getElementById('toggleBtn');
  const demodEl  = document.getElementById('demod-mode');
  const snrEl    = document.getElementById('ofdm-snr');
  const phaseEl  = document.getElementById('ofdm-phase-err');
  const statusEl = document.getElementById('status');

  // Toggle button
  const busy = state === S.REQUESTING_MIC || state === S.INITIALIZING || state === S.STOPPING;
  if (state === S.RUNNING || state === S.TX) {
    btn.textContent = '⏹ Stop Audio';
    btn.className   = 'btn btn-sm btn-outline-danger';
    btn.disabled    = false;
  } else if (busy) {
    btn.textContent = '⏳ …';
    btn.className   = 'btn btn-sm btn-outline-secondary';
    btn.disabled    = true;
  } else {
    btn.textContent = '▶ Start Audio';
    btn.className   = 'btn btn-sm btn-outline-success';
    btn.disabled    = false;
  }

  // Disable inputs while audio is active
  const active = isAudioActive(state);
  for (const id of ['modemMode', 'callsign', 'passphrase', 'micSelect'])
    document.getElementById(id).disabled = active;

  // Disable chat controls while actively transmitting (not while paused)
  const txing = state === S.TX;
  document.getElementById('message').disabled = txing;
  for (const tid of ['send-btn', 'send-file-btn'])
    document.querySelector(`[data-testid="${tid}"]`).disabled = txing;

  // File transfer progress panel
  const xferPanel   = document.getElementById('xfer-progress');
  const pauseBtn    = document.querySelector('[data-testid="pause-resume-btn"]');
  const xferBar     = document.getElementById('xfer-bar');
  const inXfer      = state === S.TX || state === S.TX_PAUSED;
  xferPanel.classList.toggle('d-none', !inXfer);
  if (inXfer) {
    if (state === S.TX_PAUSED) {
      pauseBtn.textContent = '▶ Resume';
      pauseBtn.className   = 'btn btn-sm btn-outline-success';
      xferBar.classList.remove('progress-bar-animated');
    } else {
      pauseBtn.textContent = '⏸ Pause';
      pauseBtn.className   = 'btn btn-sm btn-outline-warning';
      xferBar.classList.add('progress-bar-animated');
    }
  }

  // Status badge
  const statusMap = {
    [S.IDLE]:           ['Stopped',    'bg-warning text-dark'],
    [S.REQUESTING_MIC]: ['Mic…',       'bg-info text-dark'],
    [S.MIC_DENIED]:     ['Mic denied', 'bg-danger text-light'],
    [S.INITIALIZING]:   ['Init…',      'bg-info text-dark'],
    [S.RUNNING]:        ['Running',    'bg-success text-light'],
    [S.TX]:             ['TX…',        'bg-primary text-light'],
    [S.STOPPING]:       ['Stopping…',  'bg-warning text-dark'],
    [S.ERROR]:          ['Error',      'bg-danger text-light'],
  };
  const [label, cls] = statusMap[state] || statusMap[S.IDLE];
  statusEl.textContent = label;
  statusEl.className   = `badge rounded-pill ${cls}`;

  // OFDM graphs — only while running or tx in OFDM mode
  if ((state !== S.RUNNING && state !== S.TX) || context.mode !== 'ofdm') {
    snrEl.classList.add('d-none');
    phaseEl.classList.add('d-none');
  }
  if (state !== S.RUNNING && state !== S.TX) demodEl.textContent = '';
}

async function handleStateEntry(state, context) {
  switch (state) {

    case S.REQUESTING_MIC: {
      const deviceId = document.getElementById('micSelect').value;
      try {
        _micStream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
        dispatch({ type: E.MIC_GRANTED });
      } catch (err) {
        addChat(`Mic access denied: ${err.message}`, 'err');
        dispatch({ type: E.MIC_DENIED });
      }
      break;
    }

    case S.INITIALIZING: {
      try {
        await initAudioHardware(context);
        dispatch({ type: E.HARDWARE_READY });
        populateMicList();
      } catch (err) {
        addChat(`Audio init failed: ${err.message}`, 'err');
        await teardownAudio();
        dispatch({ type: E.HARDWARE_ERROR, message: err.message });
      }
      break;
    }

    case S.STOPPING: {
      await teardownAudio();
      dispatch({ type: E.STOPPED });
      break;
    }
  }
}

// ── Hardware init / teardown ───────────────────────────────────────────────

async function initAudioHardware(context) {
  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  micNode      = audioContext.createMediaStreamSource(_micStream);

  if (context.mode === 'ofdm') {
    const gpuDftInst = await getGpuDft();
    const workletSrc = `class OfdmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) this.port.postMessage(ch.slice());
    return true;
  }
}
registerProcessor('ofdm-processor', OfdmProcessor);`;
    const workletUrl = `data:application/javascript,${encodeURIComponent(workletSrc)}`;
    await audioContext.audioWorklet.addModule(workletUrl);

    function drawSparkline(canvas, history, { min, max, color, label }) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath(); ctx.roundRect(0, 0, w, h, 4); ctx.fill();
      if (history.length >= 2) {
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
        ctx.beginPath();
        history.forEach((v, i) => {
          const x = (i / (history.length - 1)) * w;
          const y = h - ((Math.min(Math.max(v, min), max) - min) / (max - min)) * (h - 4) - 2;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
      ctx.fillStyle = color; ctx.font = 'bold 9px monospace';
      ctx.fillText(label, 3, h - 3);
    }

    const STATS_ALPHA = 0.15, HISTORY_LEN = 120, GRAPH_INTERVAL_MS = 500;
    let smoothSnr = null, smoothPhase = null, lastGraphUpdate = 0;
    const snrHistory = [], phaseHistory = [];

    ofdmDemodInstance = createOfdmDemodulator({
      onMessage:    receiveMsg,
      onFilePacket: receiveFilePacket,
      gpuDft:       gpuDftInst,
      onStats: ({ snrDb, phaseErrRad }) => {
        if (fsmState !== S.RUNNING) return;
        smoothSnr   = smoothSnr   === null ? snrDb       : smoothSnr   + STATS_ALPHA * (snrDb       - smoothSnr);
        smoothPhase = smoothPhase === null ? phaseErrRad : smoothPhase + STATS_ALPHA * (phaseErrRad - smoothPhase);
        const now = Date.now();
        if (now - lastGraphUpdate < GRAPH_INTERVAL_MS) return;
        lastGraphUpdate = now;
        snrHistory.push(smoothSnr);     if (snrHistory.length   > HISTORY_LEN) snrHistory.shift();
        phaseHistory.push(smoothPhase); if (phaseHistory.length > HISTORY_LEN) phaseHistory.shift();
        const snrLabel   = `SNR ${Math.min(Math.max(smoothSnr, -9.9), 99.9).toFixed(1)} dB`;
        const phaseLabel = `φ ${(smoothPhase * 180 / Math.PI).toFixed(1)}°`;
        drawSparkline(document.getElementById('ofdm-snr-graph'),   snrHistory,   { min: -10, max: 30,       color: '#0dcaf0', label: snrLabel });
        drawSparkline(document.getElementById('ofdm-phase-graph'), phaseHistory, { min: -Math.PI, max: Math.PI, color: '#adb5bd', label: phaseLabel });
      },
    });

    document.getElementById('ofdm-snr').classList.remove('d-none');
    document.getElementById('ofdm-phase-err').classList.remove('d-none');

    ofdmWorkletNode = new AudioWorkletNode(audioContext, 'ofdm-processor');
    ofdmWorkletNode.port.onmessage = e => {
      if (fsmState === S.RUNNING) ofdmDemodInstance.processChunk(e.data);
    };
    micNode.connect(ofdmWorkletNode);
    const silent = audioContext.createGain(); silent.gain.value = 0;
    ofdmWorkletNode.connect(silent); silent.connect(audioContext.destination);
    document.getElementById('demod-mode').textContent = gpuDftInst ? 'OFDM-GPU' : 'OFDM-CPU';

  } else {
    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = e => { if (fsmState === S.RUNNING) processAudioChunk(e.inputBuffer.getChannelData(0)); };
    micNode.connect(scriptNode);
    const silent = audioContext.createGain(); silent.gain.value = 0;
    scriptNode.connect(silent); silent.connect(audioContext.destination);
  }
}

async function teardownAudio() {
  if (scriptNode)      { scriptNode.disconnect();      scriptNode      = null; }
  if (ofdmWorkletNode) { ofdmWorkletNode.disconnect(); ofdmWorkletNode = null; }
  if (ofdmDemodInstance) { ofdmDemodInstance.reset();  ofdmDemodInstance = null; }
  if (audioContext)    { await audioContext.close();   audioContext    = null; }
  if (_micStream)      { _micStream.getTracks().forEach(t => t.stop()); _micStream = null; }
  demodulator.reset();
  gpuDpll.reset(); gpuDemodBits = []; gpuScanPos = 0;
  gpuQueue = []; cryptoKey = null;
}

// ── Audio toggle (called from HTML onclick) ────────────────────────────────
function toggleAudio() {
  if (fsmState === S.RUNNING) {
    dispatch({ type: E.STOP });
  } else if (fsmState === S.IDLE || fsmState === S.MIC_DENIED || fsmState === S.ERROR) {
    callsign   = document.getElementById('callsign').value.trim().toUpperCase();
    passphrase = document.getElementById('passphrase').value;
    if (!callsign) { alert('Enter callsign'); return; }
    localStorage.setItem('callsign', callsign);
    dispatch({ type: E.START });
  }
}

// ── WebGPU init ────────────────────────────────────────────────────────────
// Both initWebGpu and initGpuDft call requestAdapter. Running them concurrently
// can cause the second requestAdapter to return null. Chain the OFDM DFT init
// so it only starts after the Bell-202 GPU init has fully settled.
const _webGpuSettled = initWebGpu(addChat).then(dem => { gpuDemodulator = dem; });
let _gpuDftPromise = null;
function getGpuDft() {
  if (!_gpuDftPromise) {
    // Chain after Bell-202 GPU init so the shared device is ready; reuse it.
    _gpuDftPromise = _webGpuSettled.then(() => initGpuDft(getSharedGpuDevice()));
  }
  return _gpuDftPromise;
}

// ── Init ───────────────────────────────────────────────────────────────────
populateMicList();

// Restore persisted settings from last session
{
  const s = localStorage.getItem('callsign');
  if (s) document.getElementById('callsign').value = s;
  const p = localStorage.getItem('passphrase');
  if (p) document.getElementById('passphrase').value = p;
  const m = localStorage.getItem('modemMode');
  if (m) setModemMode(m);
}

// ── Expose globals for Playwright tests ───────────────────────────────────
window.buildFrame      = (msg, dst, src) => buildFrame(msg, dst, src || 'TEST01');
window.buildFrameRaw   = (dataBytes, dst, src) => buildFrameRaw(dataBytes, dst, src || 'TEST01');
window.modulate        = modulate;
window.DPLL            = DPLL;
window.crc16           = crc16;
window.bitStuff        = bitStuff;
window.encodeCallsign  = encodeCallsign;
window.goertzel        = goertzel;
window.createDemodulator = createDemodulator;
window.cpuProcessChunk   = (samples) => demodulator.cpuProcessChunk(samples);
window.resetDemodulator  = () => demodulator.reset();
window.compress          = compress;
window.decompress        = decompress;
window.toggleAudio       = toggleAudio;
window.sendMsg           = sendMsg;
window.setModemMode      = setModemMode;
window.ofdmEncodeFrame   = ofdmEncodeFrame;
window.createOfdmDemodulator = createOfdmDemodulator;
window.ofdmProcessChunk      = (samples) => ofdmDemodInstance?.processChunk(samples);
window.gpuDft            = async (samples) => {
  const inst = await getGpuDft();
  if (!inst) throw new Error('WebGPU not available');
  return inst.dft(samples instanceof Float32Array ? samples : new Float32Array(samples));
};
window.sendFile        = sendFile;
window.togglePauseTx  = togglePauseTx;
window.cancelTx       = cancelTx;
window.MARK_FREQ       = MARK_FREQ;
window.SPACE_FREQ      = SPACE_FREQ;
window.SAMPLE_RATE     = SAMPLE_RATE;
window.SPB             = SPB;
window.STEP            = STEP;
window.PREAMBLE_FLAGS  = PREAMBLE_FLAGS;
window.POSTAMBLE_FLAGS = POSTAMBLE_FLAGS;
