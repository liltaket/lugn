import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(
  new URL('../src/ui/cameras-page.js', import.meta.url),
  'utf8',
);

type Rect = { x: number; y: number; w: number; h: number };
type Layout = {
  layout(count: number, width: number, height: number): Rect[];
  single(width: number, height: number): Rect;
};

/** Only the pure layout: the page needs no DOM when there is no pager. */
const { layout, single } = (() => {
  const context = createContext({ globalThis: undefined });
  context['globalThis'] = context;
  runInContext(script, context);
  return context['lugnCameras'] as Layout;
})();

const WIDTH = 888; // a 1024 px Hub (36 px each side)
const HEIGHT = 484; // 600 less the title and the dots

const inside = (rect: Rect) =>
  rect.x >= 0 &&
  rect.y >= 0 &&
  rect.x + rect.w <= WIDTH &&
  rect.y + rect.h <= HEIGHT;
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('camera grid layout', () => {
  it('fills the area with one camera and keeps 16:9', () => {
    const [only] = layout(1, WIDTH, HEIGHT);
    expect(only!.w / only!.h).toBeCloseTo(16 / 9, 1);
    expect(only!.h).toBeGreaterThan(HEIGHT - 20);
    expect(inside(only!)).toBe(true);
  });

  it('places any number of cameras (1–8) inside the area without overlap, all alike', () => {
    for (let count = 1; count <= 8; count += 1) {
      const rects = layout(count, WIDTH, HEIGHT);
      expect(rects).toHaveLength(count);
      for (const rect of rects) {
        expect(inside(rect)).toBe(true);
        expect(rect.w).toBe(rects[0]!.w);
        expect(rect.h).toBe(rects[0]!.h);
      }
      for (let i = 0; i < count; i += 1)
        for (let j = i + 1; j < count; j += 1)
          expect(overlap(rects[i]!, rects[j]!)).toBe(false);
    }
  });

  it('uses two columns for two to four cameras and three for five or six', () => {
    const columns = (count: number) =>
      new Set(layout(count, WIDTH, HEIGHT).map((r) => r.x)).size;
    expect(columns(2)).toBe(2);
    expect(columns(4)).toBe(2);
    // Five: three on the first row, two centred below.
    const five = layout(5, WIDTH, HEIGHT);
    expect(five.slice(0, 3).every((r) => r.y === five[0]!.y)).toBe(true);
    expect(five.slice(3).every((r) => r.y === five[3]!.y)).toBe(true);
    expect(five[3]!.x).toBeGreaterThan(five[0]!.x);
    expect(five.length).toBe(5);
    expect(new Set(five.map((r) => r.x)).size).toBeGreaterThanOrEqual(3);
  });

  it('centres a short last row and the whole grid', () => {
    const three = layout(3, WIDTH, HEIGHT);
    // Two cameras on the first row, the third centred under them.
    const middle = (WIDTH - three[2]!.w) / 2;
    expect(Math.abs(three[2]!.x - middle)).toBeLessThanOrEqual(1);
    const top = three[0]!.y;
    const bottom = HEIGHT - (three[2]!.y + three[2]!.h);
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
  });

  it('keeps tiles big enough on a narrower Hub and returns nothing for no cameras', () => {
    expect(layout(0, WIDTH, HEIGHT)).toEqual([]);
    const desk = layout(5, 828, HEIGHT);
    expect(desk.every((rect) => rect.x >= 0 && rect.x + rect.w <= 828)).toBe(
      true,
    );
    expect(desk[0]!.w).toBeGreaterThan(250);
  });

  it('shows one camera as large as the area allows, centred', () => {
    const one = single(WIDTH, HEIGHT);
    expect(one.h).toBeLessThanOrEqual(HEIGHT);
    expect(one.w).toBeLessThanOrEqual(WIDTH);
    expect(Math.abs(one.x - (WIDTH - one.w) / 2)).toBeLessThanOrEqual(1);
    expect(one.w / one.h).toBeCloseTo(16 / 9, 1);
  });
});

void vi;
