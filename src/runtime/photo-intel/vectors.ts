/** Float32 vectors as base64 (little-endian), for compact JSON caches. */
export function encodeVector(vector: ArrayLike<number>): string {
  const floats = Float32Array.from(vector as ArrayLike<number>);
  return Buffer.from(
    floats.buffer,
    floats.byteOffset,
    floats.byteLength,
  ).toString('base64');
}

export function decodeVector(
  encoded: unknown,
  length: number,
): Float32Array | null {
  if (typeof encoded !== 'string') return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== length * 4) return null;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = bytes.readFloatLE(i * 4);
  for (let i = 0; i < length; i += 1)
    if (!Number.isFinite(out[i]!)) return null;
  return out;
}
