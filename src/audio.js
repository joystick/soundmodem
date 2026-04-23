import { buildFrame, buildFrameRaw } from './ax25.js';
import { modulate, SAMPLE_RATE } from './modulate.js';
import { compress, decompress } from './compress.js';
import { CHUNK_SIZE } from './packet.js';
import { addChat } from './ui.js';

// ── Play a frame as audio ──────────────────────────────────────────────────
export function playFrame(audioContext, chatEl, frameBytes) {
  return new Promise(resolve => {
    const audioData = modulate(frameBytes);
    const buf = audioContext.createBuffer(1, audioData.length, SAMPLE_RATE);
    buf.getChannelData(0).set(audioData);
    const src = audioContext.createBufferSource();
    src.buffer = buf; src.connect(audioContext.destination);
    src.onended = resolve; src.start();
  });
}

// ── Send a text message ────────────────────────────────────────────────────
export async function sendMsg({ audioContext, callsign, chatEl, encryptMsg }) {
  const msgEl = document.getElementById('message');
  const msg   = msgEl.value.trim();
  if (!msg) return;
  if (!callsign)     { alert('Enter callsign first'); return; }
  if (!audioContext) { alert('Click "Start Audio" first'); return; }
  msgEl.value = '';
  const frameBytes = buildFrame(`${callsign}>${await encryptMsg(msg)}`, 'ALL', callsign);
  const audioData  = modulate(frameBytes);
  const buf        = audioContext.createBuffer(1, audioData.length, SAMPLE_RATE);
  buf.getChannelData(0).set(audioData);
  const src = audioContext.createBufferSource();
  src.buffer = buf; src.connect(audioContext.destination); src.start();
  addChat(chatEl, `TX ${callsign}: ${msg}`, 'tx');
}

// ── Receive a text message ─────────────────────────────────────────────────
export async function receiveMsg(chatEl, raw, { passphrase, decryptMsg }) {
  const sep = raw.indexOf('>');
  addChat(chatEl, `RX ${sep > 0 ? raw.slice(0, sep) : '?'}: ${
    passphrase ? await decryptMsg(sep > 0 ? raw.slice(sep + 1) : raw)
               : (sep > 0 ? raw.slice(sep + 1) : raw)}`, 'rx');
}

// ── File transfer: send ────────────────────────────────────────────────────
export async function sendFile({ audioContext, callsign, chatEl, encryptBytes, ensureCryptoKey }) {
  const fileInput = document.getElementById('fileInput');
  const file = fileInput.files[0];
  if (!file) return;
  if (!callsign)     { alert('Enter callsign first'); return; }
  if (!audioContext) { alert('Click "Start Audio" first'); return; }
  fileInput.value = '';

  await ensureCryptoKey();

  addChat(chatEl, `TX FILE ${file.name} — ${file.size} B, compressing…`, 'file');
  const raw        = new Uint8Array(await file.arrayBuffer());
  const compressed = await compress(raw);
  const ratio      = (raw.length / compressed.length).toFixed(1);
  addChat(chatEl, `TX FILE ${file.name} — compressed ${raw.length}→${compressed.length} B (${ratio}×)`, 'file');

  const xferId = crypto.getRandomValues(new Uint8Array(2));
  const fname  = new TextEncoder().encode(file.name);
  const total  = Math.max(1, Math.ceil(compressed.length / CHUNK_SIZE));

  for (let seq = 0; seq < total; seq++) {
    const chunkData = compressed.slice(seq * CHUNK_SIZE, (seq + 1) * CHUNK_SIZE);
    const isFirst   = seq === 0;
    const hdrSize   = 8 + (isFirst ? 2 + fname.length : 0);
    const payload   = new Uint8Array(hdrSize + chunkData.length);
    let p = 0;
    payload[p++] = 0xFE; payload[p++] = 0xFF;          // magic
    payload[p++] = xferId[0]; payload[p++] = xferId[1]; // transfer ID
    payload[p++] = (seq >> 8) & 0xFF; payload[p++] = seq & 0xFF;   // seq
    payload[p++] = (total >> 8) & 0xFF; payload[p++] = total & 0xFF; // total
    if (isFirst) {
      payload[p++] = (fname.length >> 8) & 0xFF;
      payload[p++] = fname.length & 0xFF;
      payload.set(fname, p); p += fname.length;
    }
    payload.set(chunkData, p);

    const encrypted  = await encryptBytes(payload);
    const frameBytes = buildFrameRaw(encrypted, 'ALL', callsign);
    addChat(chatEl, `TX FILE ${file.name} — fragment ${seq + 1}/${total} (${encrypted.length} B)`, 'file');
    await playFrame(audioContext, chatEl, frameBytes);
  }
  addChat(chatEl, `TX FILE ${file.name} — all ${total} fragment(s) sent`, 'file');
}

// ── File transfer: receive ─────────────────────────────────────────────────
export async function receiveFilePacket(chatEl, rawData, { decryptBytes, incomingTransfers }) {
  const payload = await decryptBytes(rawData);
  if (!payload || payload.length < 8) return;
  if (payload[0] !== 0xFE || payload[1] !== 0xFF) return;

  const xferKey = payload[2].toString(16).padStart(2, '0') +
                  payload[3].toString(16).padStart(2, '0');
  const seq     = (payload[4] << 8) | payload[5];
  const total   = (payload[6] << 8) | payload[7];

  if (!incomingTransfers.has(xferKey)) {
    incomingTransfers.set(xferKey, { total, filename: null, fragments: new Array(total) });
  }
  const xfer = incomingTransfers.get(xferKey);

  let dataOffset = 8;
  if (seq === 0) {
    const fnameLen  = (payload[8] << 8) | payload[9];
    xfer.filename   = new TextDecoder().decode(payload.slice(10, 10 + fnameLen));
    dataOffset      = 10 + fnameLen;
  }
  xfer.fragments[seq] = payload.slice(dataOffset);

  const received = xfer.fragments.filter(Boolean).length;
  addChat(chatEl, `RX FILE ${xfer.filename || '?'} — fragment ${seq + 1}/${total} (${received}/${total})`, 'file');

  if (received === total && xfer.fragments.every(Boolean)) {
    const combined = new Uint8Array(xfer.fragments.reduce((n, f) => n + f.length, 0));
    let off = 0; for (const f of xfer.fragments) { combined.set(f, off); off += f.length; }

    let decompressed;
    try { decompressed = await decompress(combined); }
    catch (e) { addChat(chatEl, `RX FILE ${xfer.filename} — decompress failed: ${e.message}`, 'err'); return; }

    const blob = new Blob([decompressed]);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = xfer.filename || 'received-file'; a.click();
    URL.revokeObjectURL(url);

    addChat(chatEl, `RX FILE ${xfer.filename} — complete! ${decompressed.length} B — saved ↓`, 'file');
    incomingTransfers.delete(xferKey);
  }
}
