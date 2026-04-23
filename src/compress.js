// Compress / decompress via DeflateRaw streams (available in Node 22+ and browsers)
export async function compress(data) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  await writer.write(data); await writer.close();
  const chunks = []; const reader = cs.readable.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export async function decompress(data) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  await writer.write(data); await writer.close();
  const chunks = []; const reader = ds.readable.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
