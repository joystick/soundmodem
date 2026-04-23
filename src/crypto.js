// ── AES-GCM encryption with explicit key parameter ────────────────────────

export async function deriveKey(passphrase) {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new Uint8Array(16), iterations: 100000, hash: 'SHA-256' },
    raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBytes(key, plainBytes) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);
  const out = new Uint8Array(12 + enc.byteLength);
  out.set(iv); out.set(new Uint8Array(enc), 12);
  return out;
}

export async function decryptBytes(key, cipherBytes) {
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: cipherBytes.slice(0, 12) }, key, cipherBytes.slice(12)));
  } catch { return null; }
}
