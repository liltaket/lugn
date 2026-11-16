import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Qr = {
  version: number;
  size: number;
  mask: number;
  modules: boolean[][];
};
type QrModule = {
  encodeQr: (text: string) => Qr;
  reedSolomonDivisor: (degree: number) => number[];
  reedSolomonRemainder: (data: number[], divisor: number[]) => number[];
};

/** Loads the browser module the same way the panel tests load app.js. */
function loadQrModule(): QrModule {
  const source = readFileSync(
    new URL('../web/qr.js', import.meta.url),
    'utf8',
  ).replace(/^export /gm, '');
  const context = createContext({ TextEncoder });
  runInContext(source, context);
  return runInContext(
    '({ encodeQr, reedSolomonDivisor, reedSolomonRemainder })',
    context,
  ) as QrModule;
}

const qr = loadQrModule();
const payload =
  'lugn://pair?server=https%3A%2F%2Flugn.example.ts.net%3A8789&code=7K3Q-M9TD';

function format(matrix: Qr): { level: number; mask: number } {
  // The copy around the top-left finder, read from bit 14 down to bit 0.
  const m = matrix.modules;
  const bits = [
    ...[0, 1, 2, 3, 4, 5].map((y) => m[y]![8]!),
    m[7]![8]!,
    m[8]![8]!,
    m[8]![7]!,
    ...[5, 4, 3, 2, 1, 0].map((x) => m[8]![x]!),
  ];
  const value =
    bits.reduce((sum, dark, index) => sum | (Number(dark) << index), 0) ^
    0x5412;
  return { level: value >> 13, mask: (value >> 10) & 7 };
}

describe('QR code encoder', () => {
  it('computes Reed–Solomon error correction for the published 1-M example', () => {
    // "HELLO WORLD" as version 1-M, from the Thonky QR code tutorial.
    const data = [
      32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17,
    ];
    expect(qr.reedSolomonRemainder(data, qr.reedSolomonDivisor(10))).toEqual([
      196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
    ]);
  });

  it('matches the pairing payload decoded by an independent reader', () => {
    // Fixture verified with jsQR 1.4.0 on 2026-11-16 ('#' is dark).
    const golden = readFileSync(
      new URL('./fixtures/phones/pairing-qr.txt', import.meta.url),
      'utf8',
    )
      .trimEnd()
      .split('\n');
    const encoded = qr.encodeQr(payload);
    expect(encoded.version).toBe(5);
    expect(
      encoded.modules.map((row) =>
        row.map((dark) => (dark ? '#' : '.')).join(''),
      ),
    ).toEqual(golden);
    expect(format(encoded)).toEqual({ level: 0, mask: encoded.mask });
  });

  it('draws finder, timing and format structure at every size', () => {
    for (const length of [1, 40, 120, 400, 1200]) {
      const encoded = qr.encodeQr('x'.repeat(length));
      const { size, modules } = encoded;
      expect(size).toBe(encoded.version * 4 + 17);
      expect(modules).toHaveLength(size);
      for (const [x0, y0] of [
        [0, 0],
        [size - 7, 0],
        [0, size - 7],
      ])
        for (let y = 0; y < 7; y++)
          for (let x = 0; x < 7; x++) {
            const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
            expect(modules[y0! + y]![x0! + x]).toBe(ring !== 2);
          }
      for (let index = 8; index < size - 8; index++) {
        expect(modules[6]![index]).toBe(index % 2 === 0);
        expect(modules[index]![6]).toBe(index % 2 === 0);
      }
      // The fixed dark module beside the lower-left finder.
      expect(modules[size - 8]![8]).toBe(true);
      expect(format(encoded)).toEqual({ level: 0, mask: encoded.mask });
    }
  });

  it('encodes UTF-8 and refuses text beyond version 40', () => {
    expect(qr.encodeQr('å').version).toBe(1);
    expect(qr.encodeQr('z'.repeat(2331)).version).toBe(40);
    expect(() => qr.encodeQr('z'.repeat(2332))).toThrow(
      'Text is too long for a QR code',
    );
  });
});
