import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../src/ui/display.js', import.meta.url),
  'utf8',
);
const start = source.indexOf('function artworkShape(');
const end = source.indexOf('\n}\n', start) + 2;
const artworkShape = runInNewContext(`(${source.slice(start, end)})`) as (
  width: number,
  height: number,
) => string;

describe('Hub artwork shapes', () => {
  it('maps every image to one of the shared hero boxes', () => {
    expect(artworkShape(640, 640)).toBe('square');
    expect(artworkShape(1000, 860)).toBe('square');
    expect(artworkShape(1280, 720)).toBe('wide');
    expect(artworkShape(1500, 1000)).toBe('wide');
    expect(artworkShape(2400, 1000)).toBe('panorama');
    expect(artworkShape(720, 1280)).toBe('tall');
    expect(artworkShape(800, 1000)).toBe('square');
  });

  it('keeps only extreme strips whole, and treats missing sizes as square', () => {
    expect(artworkShape(2000, 400)).toBe('strip');
    expect(artworkShape(300, 1000)).toBe('strip');
    expect(artworkShape(0, 0)).toBe('square');
  });
});
