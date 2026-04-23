// Compress / decompress via pako (synchronous deflate-raw)
import pako from 'pako';

export async function compress(data) {
  return pako.deflateRaw(data);
}

export async function decompress(data) {
  return pako.inflateRaw(data);
}
