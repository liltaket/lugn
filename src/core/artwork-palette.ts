import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export type Rgb = [number, number, number];

export type DecodedImage = {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel. */
  data: Uint8Array;
};

/** Hard ceiling before any decoder allocates: cover art is a thumbnail, not a photo. */
const MAX_PIXELS = 16_000_000;
const SAMPLE_TARGET = 4096;
const HUE_BINS = 24;
const MIN_SATURATION = 0.28;
const MIN_VALUE = 0.2;
const MIN_HUE_DISTANCE = 36;
/** Below this share of colourful pixels the artwork is effectively monochrome. */
const MIN_CHROMATIC_SHARE = 0.04;

/**
 * Decodes JPEG and PNG artwork. WebP and GIF are not decoded: callers treat
 * `null` as "no palette" and keep the room's static look.
 */
export function decodeArtwork(asset: {
  body: Uint8Array;
  contentType: string;
}): DecodedImage | null {
  try {
    const body = Buffer.from(asset.body);
    if (asset.contentType === 'image/jpeg') {
      const image = jpeg.decode(body, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: 16,
        maxMemoryUsageInMB: 96,
      });
      return image.width * image.height <= MAX_PIXELS
        ? { width: image.width, height: image.height, data: image.data }
        : null;
    }
    if (asset.contentType === 'image/png') {
      // IHDR is fixed at bytes 16..24; refuse a decompression bomb before inflating.
      if (body.length < 24) return null;
      if (body.readUInt32BE(16) * body.readUInt32BE(20) > MAX_PIXELS)
        return null;
      const image = PNG.sync.read(body);
      return { width: image.width, height: image.height, data: image.data };
    }
  } catch {
    // A corrupt or unsupported image never reaches the lamps.
  }
  return null;
}

type Bin = { weight: number; r: number; g: number; b: number };

/**
 * Picks up to three vivid, well-separated colours from artwork, strongest
 * first. Returns an empty list for monochrome or near-black artwork.
 * The colours are normalized for lamps: full value and at least moderate
 * saturation, because brightness is a separate lamp setting.
 */
export function extractPalette(image: DecodedImage): Rgb[] {
  const pixels = image.width * image.height;
  if (pixels <= 0) return [];
  const stride = Math.max(1, Math.floor(Math.sqrt(pixels / SAMPLE_TARGET)));
  const bins: Bin[] = Array.from({ length: HUE_BINS }, () => ({
    weight: 0,
    r: 0,
    g: 0,
    b: 0,
  }));
  let sampled = 0;
  let chromatic = 0;
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const offset = (y * image.width + x) * 4;
      const alpha = image.data[offset + 3]!;
      if (alpha < 128) continue;
      const r = image.data[offset]!;
      const g = image.data[offset + 1]!;
      const b = image.data[offset + 2]!;
      sampled++;
      const [hue, saturation, value] = rgbToHsv(r, g, b);
      if (saturation < MIN_SATURATION || value < MIN_VALUE) continue;
      chromatic++;
      const bin = bins[Math.floor((hue / 360) * HUE_BINS) % HUE_BINS]!;
      // Vivid, bright pixels speak for the artwork; muddy ones barely count.
      const weight = saturation * saturation * value;
      bin.weight += weight;
      bin.r += r * weight;
      bin.g += g * weight;
      bin.b += b * weight;
    }
  }
  if (sampled === 0 || chromatic / sampled < MIN_CHROMATIC_SHARE) return [];

  const ranked = bins
    .map((bin, index) => ({ bin, index }))
    .filter(({ bin }) => bin.weight > 0)
    .sort((a, b) => b.bin.weight - a.bin.weight || a.index - b.index);
  const picked: Array<{ rgb: Rgb; hue: number }> = [];
  for (const { bin } of ranked) {
    const rgb: Rgb = [
      Math.round(bin.r / bin.weight),
      Math.round(bin.g / bin.weight),
      Math.round(bin.b / bin.weight),
    ];
    const [hue] = rgbToHsv(...rgb);
    if (picked.some((other) => hueDistance(other.hue, hue) < MIN_HUE_DISTANCE))
      continue;
    picked.push({ rgb: vivid(rgb), hue });
    if (picked.length === 3) break;
  }
  return picked.map((entry) => entry.rgb);
}

/** Convenience for callers that start from encoded bytes. */
export function paletteFromArtwork(asset: {
  body: Uint8Array;
  contentType: string;
}): Rgb[] {
  const image = decodeArtwork(asset);
  return image ? extractPalette(image) : [];
}

export function rgbToHsv(
  r: number,
  g: number,
  b: number,
): [hue: number, saturation: number, value: number] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r / 255) hue = ((g - b) / 255 / delta) % 6;
    else if (max === g / 255) hue = (b - r) / 255 / delta + 2;
    else hue = (r - g) / 255 / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return [hue, max === 0 ? 0 : delta / max, max];
}

export function hsvToRgb(hue: number, saturation: number, value: number): Rgb {
  const h = ((hue % 360) + 360) % 360;
  const c = value * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = value - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function vivid(rgb: Rgb): Rgb {
  const [hue, saturation] = rgbToHsv(...rgb);
  return hsvToRgb(hue, Math.max(saturation, 0.6), 1);
}

export function hueDistance(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return difference > 180 ? 360 - difference : difference;
}
