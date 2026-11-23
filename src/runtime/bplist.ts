/**
 * A bounded reader for Apple's binary property lists (`bplist00`), enough for
 * the small blobs an iCloud album stores per picture: image properties, a
 * location, keywords. Every read is checked against the buffer and the
 * structure against hard limits, so a hostile blob ends in `undefined`, never
 * in a loop or a large allocation.
 *
 * Dictionaries come back as null-prototype objects, arrays as arrays, `data`
 * and anything unsupported as `undefined`; strings are cut at 512 characters.
 */
export type PlistValue =
  | null
  | boolean
  | number
  | string
  | PlistValue[]
  | { [key: string]: PlistValue };

export type PlistLimits = {
  maxBytes: number;
  maxDepth: number;
  maxObjects: number;
};
const DEFAULT_LIMITS: PlistLimits = {
  maxBytes: 64 * 1024,
  maxDepth: 8,
  maxObjects: 4096,
};
const MAX_STRING = 512;
const MAX_ENTRIES = 256;

export function parseBinaryPlist(
  data: Uint8Array,
  limits: Partial<PlistLimits> = {},
): PlistValue | undefined {
  const { maxBytes, maxDepth, maxObjects } = { ...DEFAULT_LIMITS, ...limits };
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (
    buffer.length < 40 ||
    buffer.length > maxBytes ||
    buffer.subarray(0, 8).toString('latin1') !== 'bplist00'
  )
    return undefined;
  const byte = (at: number): number => {
    if (!Number.isInteger(at) || at < 0 || at >= buffer.length)
      throw new RangeError('bplist out of range');
    return buffer[at]!;
  };
  const unsigned = (at: number, size: number): number => {
    if (size < 1 || size > 6) throw new RangeError('bplist integer size');
    let n = 0;
    for (let i = 0; i < size; i += 1) n = n * 256 + byte(at + i);
    return n;
  };
  try {
    const trailer = buffer.subarray(buffer.length - 32);
    const offsetSize = trailer[6]!;
    const refSize = trailer[7]!;
    const objectCount = Number(trailer.readBigUInt64BE(8));
    const topObject = Number(trailer.readBigUInt64BE(16));
    const tableOffset = Number(trailer.readBigUInt64BE(24));
    if (
      objectCount < 1 ||
      objectCount > maxObjects ||
      topObject >= objectCount ||
      offsetSize < 1 ||
      offsetSize > 4 ||
      refSize < 1 ||
      refSize > 2 ||
      tableOffset + objectCount * offsetSize > buffer.length - 32
    )
      return undefined;
    const offsetOf = (index: number): number => {
      if (index < 0 || index >= objectCount)
        throw new RangeError('bplist object index');
      return unsigned(tableOffset + index * offsetSize, offsetSize);
    };
    const lengthAndStart = (at: number): { length: number; start: number } => {
      const nibble = byte(at) & 0x0f;
      if (nibble !== 0x0f) return { length: nibble, start: at + 1 };
      const sizeLog = byte(at + 1) & 0x0f;
      if (sizeLog > 2) throw new RangeError('bplist length size');
      const size = 1 << sizeLog;
      return { length: unsigned(at + 2, size), start: at + 2 + size };
    };
    let visited = 0;
    const read = (index: number, depth: number): PlistValue | undefined => {
      visited += 1;
      if (visited > maxObjects * 2 || depth > maxDepth) return undefined;
      const at = offsetOf(index);
      const marker = byte(at);
      const kind = marker >> 4;
      switch (marker) {
        case 0x00:
          return null;
        case 0x08:
          return false;
        case 0x09:
          return true;
        default:
      }
      if (kind === 0x1) {
        const size = 1 << (marker & 0x0f);
        if (size > 8) return undefined;
        if (size === 8) {
          if (at + 9 > buffer.length) return undefined;
          return Number(buffer.readBigInt64BE(at + 1));
        }
        return unsigned(at + 1, size);
      }
      if (kind === 0x2) {
        const size = 1 << (marker & 0x0f);
        if (at + 1 + size > buffer.length) return undefined;
        if (size === 4) return buffer.readFloatBE(at + 1);
        if (size === 8) return buffer.readDoubleBE(at + 1);
        return undefined;
      }
      if (marker === 0x33) {
        // A date: seconds since 2001-01-01, as a double.
        if (at + 9 > buffer.length) return undefined;
        return buffer.readDoubleBE(at + 1);
      }
      if (kind === 0x5) {
        const { length, start } = lengthAndStart(at);
        if (start + length > buffer.length) return undefined;
        return buffer
          .subarray(start, start + Math.min(length, MAX_STRING))
          .toString('latin1');
      }
      if (kind === 0x6) {
        const { length, start } = lengthAndStart(at);
        if (start + length * 2 > buffer.length) return undefined;
        const units = Math.min(length, MAX_STRING);
        let text = '';
        for (let i = 0; i < units; i += 1)
          text += String.fromCharCode(buffer.readUInt16BE(start + i * 2));
        return text;
      }
      if (kind === 0xa) {
        const { length, start } = lengthAndStart(at);
        if (length > objectCount) return undefined;
        const items: PlistValue[] = [];
        for (let i = 0; i < Math.min(length, MAX_ENTRIES); i += 1) {
          const item = read(unsigned(start + i * refSize, refSize), depth + 1);
          if (item !== undefined) items.push(item);
        }
        return items;
      }
      if (kind === 0xd) {
        const { length, start } = lengthAndStart(at);
        if (length > objectCount) return undefined;
        const entries: { [key: string]: PlistValue } = Object.create(null) as {
          [key: string]: PlistValue;
        };
        for (let i = 0; i < Math.min(length, MAX_ENTRIES); i += 1) {
          const key = read(unsigned(start + i * refSize, refSize), depth + 1);
          const value = read(
            unsigned(start + (length + i) * refSize, refSize),
            depth + 1,
          );
          if (typeof key === 'string' && value !== undefined)
            entries[key] = value;
        }
        return entries;
      }
      return undefined;
    };
    return read(topObject, 0);
  } catch {
    return undefined;
  }
}

/** The numeric entries of a top-level dictionary (a location blob, say). */
export function plistNumbers(
  data: Uint8Array,
  maxBytes = 4096,
): Map<string, number> {
  const out = new Map<string, number>();
  const parsed = parseBinaryPlist(data, { maxBytes, maxDepth: 2 });
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    for (const [key, value] of Object.entries(parsed))
      if (typeof value === 'number' && Number.isFinite(value))
        out.set(key, value);
  return out;
}
