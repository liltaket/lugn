// A small QR code encoder for the pairing code on the Telefoner page.
// Byte mode, error correction level M, versions 1–40, automatic mask choice,
// following ISO/IEC 18004 (the structure mirrors Project Nayuki's MIT
// qrcodegen). It runs in the browser with no network access, so the code
// never leaves the panel.

// Error correction codewords per block and number of blocks, level M.
const ECC_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26,
  26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28,
];
const BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17,
  18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
// Two format bits for level M.
const ECC_FORMAT_BITS = 0;

/** Returns `{ version, size, modules }`, where `modules[y][x]` is true for dark. */
export function encodeQr(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  for (; ; version++) {
    if (version > 40) throw new RangeError('Text is too long for a QR code');
    const countBits = version < 10 ? 8 : 16;
    if (bytes.length < 2 ** countBits) {
      const needed = 4 + countBits + bytes.length * 8;
      if (needed <= dataCodewords(version) * 8) break;
    }
  }
  const capacity = dataCodewords(version) * 8;
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) appendBits(bits, byte, 8);
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11)
    appendBits(bits, pad, 8);
  const data = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) byte = (byte << 1) | bits[index + bit];
    data.push(byte);
  }

  const qr = new Matrix(version);
  qr.drawFunctionPatterns();
  qr.drawCodewords(addEccAndInterleave(data, version));
  let best = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    qr.applyMask(mask);
    qr.drawFormatBits(mask);
    const penalty = qr.penalty();
    if (penalty < bestPenalty) {
      best = mask;
      bestPenalty = penalty;
    }
    qr.applyMask(mask);
  }
  qr.applyMask(best);
  qr.drawFormatBits(best);
  return { version, size: qr.size, mask: best, modules: qr.modules };
}

function appendBits(bits, value, length) {
  for (let index = length - 1; index >= 0; index--)
    bits.push((value >>> index) & 1);
}

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version) {
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_PER_BLOCK[version] * BLOCKS[version]
  );
}

function addEccAndInterleave(data, version) {
  const blockCount = BLOCKS[version];
  const eccLength = ECC_PER_BLOCK[version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortLength = Math.floor(rawCodewords / blockCount);
  const divisor = reedSolomonDivisor(eccLength);
  const blocks = [];
  for (let index = 0, offset = 0; index < blockCount; index++) {
    const length = shortLength - eccLength + (index < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    const ecc = reedSolomonRemainder(block, divisor);
    if (index < shortBlocks) block.push(0);
    blocks.push([...block, ...ecc]);
  }
  const result = [];
  for (let column = 0; column < blocks[0].length; column++)
    for (let row = 0; row < blocks.length; row++)
      // Short blocks carry a placeholder where long blocks have data.
      if (column !== shortLength - eccLength || row >= shortBlocks)
        result.push(blocks[row][column]);
  return result;
}

function gfMultiply(x, y) {
  let product = 0;
  for (let bit = 7; bit >= 0; bit--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((y >>> bit) & 1) * x;
  }
  return product;
}

export function reedSolomonDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index++) {
    for (let term = 0; term < degree; term++) {
      result[term] = gfMultiply(result[term], root);
      if (term + 1 < degree) result[term] ^= result[term + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

export function reedSolomonRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, index) => {
      result[index] ^= gfMultiply(coefficient, factor);
    });
  }
  return result;
}

const bit = (value, index) => ((value >>> index) & 1) !== 0;

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array(this.size).fill(false),
    );
    this.reserved = Array.from({ length: this.size }, () =>
      new Array(this.size).fill(false),
    );
  }

  set(x, y, dark) {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }

  drawFunctionPatterns() {
    const size = this.size;
    for (let index = 0; index < size; index++) {
      this.set(6, index, index % 2 === 0);
      this.set(index, 6, index % 2 === 0);
    }
    for (const [x, y] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ])
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size)
            this.set(xx, yy, distance !== 2 && distance !== 4);
        }
    const positions = this.alignmentPositions();
    const last = positions.length - 1;
    for (let i = 0; i <= last; i++)
      for (let j = 0; j <= last; j++) {
        // The three corners hold finder patterns.
        if ((i === 0 && j === 0) || (i === 0 && j === last)) continue;
        if (i === last && j === 0) continue;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            this.set(
              positions[i] + dx,
              positions[j] + dy,
              Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
            );
      }
    this.drawFormatBits(0);
    this.drawVersion();
  }

  alignmentPositions() {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step =
      Math.floor((this.version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const result = [6];
    for (let position = this.size - 7; result.length < count; position -= step)
      result.splice(1, 0, position);
    return result;
  }

  drawFormatBits(mask) {
    const data = (ECC_FORMAT_BITS << 3) | mask;
    let remainder = data;
    for (let index = 0; index < 10; index++)
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const size = this.size;
    for (let index = 0; index <= 5; index++)
      this.set(8, index, bit(bits, index));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let index = 9; index < 15; index++)
      this.set(14 - index, 8, bit(bits, index));
    for (let index = 0; index < 8; index++)
      this.set(size - 1 - index, 8, bit(bits, index));
    for (let index = 8; index < 15; index++)
      this.set(8, size - 15 + index, bit(bits, index));
    this.set(8, size - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let index = 0; index < 12; index++)
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let index = 0; index < 18; index++) {
      const a = this.size - 11 + (index % 3);
      const b = Math.floor(index / 3);
      this.set(a, b, bit(bits, index));
      this.set(b, a, bit(bits, index));
    }
  }

  drawCodewords(data) {
    const size = this.size;
    let index = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          if (!this.reserved[y][x] && index < data.length * 8) {
            this.modules[y][x] = bit(data[index >>> 3], 7 - (index & 7));
            index++;
          }
        }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++) {
        if (this.reserved[y][x]) continue;
        let invert;
        if (mask === 0) invert = (x + y) % 2 === 0;
        else if (mask === 1) invert = y % 2 === 0;
        else if (mask === 2) invert = x % 3 === 0;
        else if (mask === 3) invert = (x + y) % 3 === 0;
        else if (mask === 4)
          invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
        else if (mask === 5) invert = ((x * y) % 2) + ((x * y) % 3) === 0;
        else if (mask === 6) invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
        else invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
  }

  penalty() {
    const size = this.size;
    const modules = this.modules;
    let result = 0;
    const lines = (read) => {
      for (let a = 0; a < size; a++) {
        let color = false;
        let run = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          if (read(a, b) === color) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else {
            this.addHistory(run, history);
            if (!color) result += this.finderLike(history) * 40;
            color = read(a, b);
            run = 1;
          }
        }
        if (color) {
          this.addHistory(run, history);
          run = 0;
        }
        this.addHistory(run + size, history);
        result += this.finderLike(history) * 40;
      }
    };
    lines((y, x) => modules[y][x]);
    lines((x, y) => modules[y][x]);
    let dark = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) dark++;
        if (
          y < size - 1 &&
          x < size - 1 &&
          modules[y][x] === modules[y][x + 1] &&
          modules[y][x] === modules[y + 1][x] &&
          modules[y][x] === modules[y + 1][x + 1]
        )
          result += 3;
      }
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }

  addHistory(run, history) {
    // The light quiet zone extends the first run of each line.
    if (history[0] === 0) run += this.size;
    history.pop();
    history.unshift(run);
  }

  finderLike(history) {
    const n = history[1];
    const core =
      n > 0 &&
      history[2] === n &&
      history[3] === n * 3 &&
      history[4] === n &&
      history[5] === n;
    return (
      (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
      (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
    );
  }
}
