import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import {
  decodeArtwork,
  paletteFromArtwork,
  rgbToHsv,
  type Rgb,
} from '../src/core/artwork-palette.js';

function png(
  width: number,
  height: number,
  colour: (x: number, y: number) => [number, number, number, number],
): Uint8Array {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = colour(x, y);
      const offset = (y * width + x) * 4;
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = a;
    }
  return PNG.sync.write(image);
}
const hue = (rgb: Rgb) => rgbToHsv(...rgb)[0];

describe('artwork palette', () => {
  it('returns vivid, separated colours strongest first', () => {
    // 60% red, 30% blue, 10% dark grey.
    const body = png(100, 100, (x) =>
      x < 60
        ? [200, 30, 30, 255]
        : x < 90
          ? [30, 40, 210, 255]
          : [40, 40, 40, 255],
    );
    const palette = paletteFromArtwork({ body, contentType: 'image/png' });
    expect(palette).toHaveLength(2);
    expect(hue(palette[0]!)).toBeLessThan(10);
    expect(Math.abs(hue(palette[1]!) - 235)).toBeLessThan(15);
    for (const colour of palette) {
      const [, saturation, value] = rgbToHsv(...colour);
      expect(value).toBeCloseTo(1, 1);
      expect(saturation).toBeGreaterThanOrEqual(0.6);
    }
  });

  it('merges shades of one hue instead of repeating them', () => {
    const body = png(80, 80, (x) =>
      x % 2 ? [220, 40, 40, 255] : [170, 20, 25, 255],
    );
    expect(paletteFromArtwork({ body, contentType: 'image/png' })).toHaveLength(
      1,
    );
  });

  it('gives no palette for monochrome, near-black or transparent artwork', () => {
    for (const colour of [
      [128, 128, 128, 255],
      [10, 5, 5, 255],
      [255, 0, 0, 0],
    ] as const)
      expect(
        paletteFromArtwork({
          body: png(40, 40, () => [...colour]),
          contentType: 'image/png',
        }),
      ).toEqual([]);
  });

  it('decodes JPEG', () => {
    const data = Buffer.alloc(64 * 64 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 30;
      data[i + 1] = 200;
      data[i + 2] = 60;
      data[i + 3] = 255;
    }
    const encoded = jpeg.encode({ data, width: 64, height: 64 }, 90).data;
    const palette = paletteFromArtwork({
      body: encoded,
      contentType: 'image/jpeg',
    });
    expect(Math.abs(hue(palette[0]!) - 130)).toBeLessThan(15);
  });

  it('refuses corrupt, unsupported and oversized images without throwing', () => {
    expect(
      decodeArtwork({
        body: new Uint8Array([1, 2, 3]),
        contentType: 'image/png',
      }),
    ).toBeNull();
    expect(
      decodeArtwork({ body: new Uint8Array(64), contentType: 'image/jpeg' }),
    ).toBeNull();
    expect(
      decodeArtwork({
        body: png(4, 4, () => [255, 0, 0, 255]),
        contentType: 'image/webp',
      }),
    ).toBeNull();
    // A PNG whose header claims 20000 x 20000 pixels is rejected before inflating.
    const bomb = Buffer.from(png(4, 4, () => [255, 0, 0, 255]));
    bomb.writeUInt32BE(20_000, 16);
    bomb.writeUInt32BE(20_000, 20);
    expect(decodeArtwork({ body: bomb, contentType: 'image/png' })).toBeNull();
  });
});
