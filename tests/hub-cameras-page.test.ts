import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const WIDTH = 976; // a 1024 px Hub: the stage is 12 px from each side
const HEIGHT = 560; // 600 less the top margin and the dots

const inside = (rect: Rect) =>
  rect.x >= 0 &&
  rect.y >= 0 &&
  rect.x + rect.w <= WIDTH &&
  rect.y + rect.h <= HEIGHT;
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const rowsOf = (rects: Rect[]) => [...new Set(rects.map((r) => r.y))].length;
const covered = (rects: Rect[]) =>
  rects.reduce((sum, r) => sum + r.w * r.h, 0) / (WIDTH * HEIGHT);
// A tile is 16:9 or a little taller (its picture is cropped at the sides).
const crop = (rect: Rect) => 1 - rect.w / rect.h / (16 / 9);

describe('camera grid layout', () => {
  it('fills the area with one camera', () => {
    const [only] = layout(1, WIDTH, HEIGHT);
    expect(only!.h).toBeGreaterThanOrEqual(HEIGHT - 1);
    expect(only!.w).toBeGreaterThan(WIDTH - 40);
    expect(inside(only!)).toBe(true);
  });

  it('places 1–8 cameras inside the area without overlap and without cropping a picture by more than 15 %', () => {
    for (let count = 1; count <= 8; count += 1) {
      const rects = layout(count, WIDTH, HEIGHT);
      expect(rects).toHaveLength(count);
      for (const rect of rects) {
        expect(inside(rect)).toBe(true);
        expect(crop(rect)).toBeLessThanOrEqual(0.155);
        expect(crop(rect)).toBeGreaterThanOrEqual(-0.02);
      }
      for (let i = 0; i < count; i += 1)
        for (let j = i + 1; j < count; j += 1)
          expect(overlap(rects[i]!, rects[j]!)).toBe(false);
      // Tiles in a row are alike.
      for (const y of new Set(rects.map((r) => r.y))) {
        const row = rects.filter((r) => r.y === y);
        expect(new Set(row.map((r) => r.w)).size).toBe(1);
      }
    }
  });

  it('uses the screen: three to eight cameras cover well over half of it, and no row is left half empty', () => {
    for (let count = 3; count <= 8; count += 1)
      expect(covered(layout(count, WIDTH, HEIGHT))).toBeGreaterThan(0.6);
    // Four fill it as a 2 × 2.
    const four = layout(4, WIDTH, HEIGHT);
    expect(rowsOf(four)).toBe(2);
    expect(new Set(four.map((r) => r.x)).size).toBe(2);
    expect(covered(four)).toBeGreaterThan(0.85);
  });

  it('gives the first cameras the biggest tiles: five are two big ones over three', () => {
    const five = layout(5, WIDTH, HEIGHT);
    expect(rowsOf(five)).toBe(2);
    expect(five[0]!.y).toBe(five[1]!.y);
    expect(five[2]!.y).toBe(five[4]!.y);
    expect(five[0]!.w).toBeGreaterThan(five[2]!.w);
    expect(five[0]!.h).toBeGreaterThan(five[2]!.h);
    // The two rows use the height.
    const bottom = five[2]!.y + five[2]!.h;
    expect(five[0]!.y + HEIGHT - bottom).toBeLessThanOrEqual(30);
  });

  it('centres the rows and the whole grid', () => {
    for (const count of [2, 3, 5, 7]) {
      const rects = layout(count, WIDTH, HEIGHT);
      const top = Math.min(...rects.map((r) => r.y));
      const bottom = HEIGHT - Math.max(...rects.map((r) => r.y + r.h));
      expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
      for (const y of new Set(rects.map((r) => r.y))) {
        const row = rects.filter((r) => r.y === y);
        const left = Math.min(...row.map((r) => r.x));
        const right = WIDTH - Math.max(...row.map((r) => r.x + r.w));
        expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('copes with a narrower Hub and returns nothing for no cameras', () => {
    expect(layout(0, WIDTH, HEIGHT)).toEqual([]);
    const desk = layout(5, 828, HEIGHT);
    expect(desk.every((rect) => rect.x >= 0 && rect.x + rect.w <= 828)).toBe(
      true,
    );
    expect(Math.min(...desk.map((r) => r.w))).toBeGreaterThan(230);
  });

  it('shows one camera as large as the area allows, centred', () => {
    const one = single(WIDTH, HEIGHT);
    expect(one.h).toBeLessThanOrEqual(HEIGHT);
    expect(one.w).toBeLessThanOrEqual(WIDTH);
    expect(one.h).toBeGreaterThanOrEqual(HEIGHT - 1);
    expect(Math.abs(one.x - (WIDTH - one.w) / 2)).toBeLessThanOrEqual(1);
  });
});

// ── The page itself: lease, pace, pictures and what happens when it stops ──

type Listener = (event?: unknown) => void;
class El {
  children: El[] = [];
  parent: El | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  hidden = false;
  className = '';
  textContent = '';
  src = '';
  decoding = '';
  alt = '';
  draggable = true;
  constructor(readonly tag: string) {}
  append(...items: El[]) {
    for (const item of items) {
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items: El[]) {
    this.children = [];
    this.append(...items);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
    if (name === 'src') this.src = value;
  }
  getAttribute(name: string) {
    return name === 'src' ? this.src || null : (this.attrs.get(name) ?? null);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
    if (name === 'src') this.src = '';
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, event: Record<string, unknown> = {}) {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ target: this, ...event });
  }
  closest(selector: string): El | null {
    const name = selector.replace(/^\./, '');
    if (this.className.split(' ').includes(name)) return this;
    return this.parent?.closest(selector) ?? null;
  }
  contains(node: El | null): boolean {
    for (let n = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
}

type Hooks = { enter(): void; leave(): void; sleep(): void };
type MenuOptions = {
  id: string;
  root: El;
  handleTap(event: { target: El }): boolean;
};

function setup(count = 5) {
  vi.useFakeTimers();
  const names = ['Entré', 'Framsida', 'Norr', 'Syd', 'Baksida'].slice(0, count);
  const ids = ['entry', 'front', 'north', 'south', 'back'].slice(0, count);
  const views: Record<string, El> = {
    root: new El('div'),
    stage: new El('div'),
    notice: new El('div'),
  };
  views['root']!.style['--W'] = '1024';
  const pager = new El('div');
  const classes = new Set<string>();
  (pager as unknown as Record<string, unknown>)['classList'] = {
    contains: (name: string) => classes.has(name),
  };
  const root = views['root'] as El & { querySelector(s: string): El | null };
  root.querySelector = (selector: string) =>
    views[/data-view='(\w+)'/.exec(selector)?.[1] ?? ''] ?? null;
  (root as unknown as Record<string, unknown>)['style'] = {
    getPropertyValue: (name: string) => views['root']!.style[name] ?? '',
  };
  const document = {
    readyState: 'complete',
    addEventListener: () => undefined,
    querySelector: () => root,
    getElementById: (id: string) => (id === 'hub-pager' ? pager : null),
    createElement: (tag: string) => {
      const element = new El(tag);
      (element as unknown as Record<string, unknown>)['type'] = '';
      return element;
    },
  };
  const windowListeners = new Map<string, Listener[]>();
  const window = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    addEventListener: (type: string, fn: Listener) =>
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]),
  };
  const posts: string[] = [];
  const postResults: Array<() => Promise<unknown>> = [];
  const list = () => ({
    cameraGrid: {
      cameras: ids.map((id, i) => ({
        id,
        name: names[i],
        imageUrl: `/k/t/display-api/camera-grid/${id}/image`,
      })),
    },
  });
  let postCount = 0;
  const postJson = vi.fn(async (_url: string, body: { action: string }) => {
    posts.push(body.action);
    const custom = postResults[postCount];
    postCount += 1;
    if (custom) return custom();
    return body.action === 'grid' ? list() : { ok: true };
  });
  const fetches: Array<{ url: string; finish: () => void }> = [];
  const fetchMock = vi.fn(
    (url: string) =>
      new Promise((resolve) => {
        fetches.push({
          url,
          finish: () =>
            resolve({
              ok: true,
              status: 200,
              blob: async () => ({ size: 100 }),
            }),
        });
      }),
  );
  let objectUrls = 0;
  const revoked: string[] = [];
  class FakeImage extends El {
    constructor() {
      super('img');
    }
    async decode() {
      return undefined;
    }
  }
  const hooks: { current?: Hooks } = {};
  const menu: {
    options?: MenuOptions;
    back: (() => void) | null;
    shown: number;
  } = { back: null, shown: 0 };
  const context = createContext({
    document,
    window,
    postJson,
    fetch: fetchMock,
    BASE_PATH: '/k/t/',
    latestPayload: { cameraDashboard: { definitions: [] } },
    matchMedia: () => ({ matches: true }),
    URL: {
      createObjectURL: () => `blob:${(objectUrls += 1)}`,
      revokeObjectURL: (url: string) => revoked.push(url),
    },
    Image: FakeImage,
    AbortController,
    Date,
    Promise,
    Math,
    Number,
    console,
    globalThis: undefined,
  });
  context['globalThis'] = context;
  // The navbar (quick-menu.js): the page gives it a way back while one camera
  // is large, and may ask it to show.
  context['lugnQuickMenu'] = {
    attach: (options: MenuOptions) => {
      menu.options = options;
      return {
        setBack: (fn: (() => void) | null) => (menu.back = fn),
        show: () => (menu.shown += 1),
      };
    },
  };
  context['lugnPages'] = {
    go: vi.fn(() => true),
    define: (_id: string, h: Hooks) => (hooks.current = h),
  };
  runInContext(script, context);
  const stage = views['stage']!;
  const tiles = () =>
    stage.children.filter((child) => child.className.includes('cams-tile'));
  const picture = (tile: El) => tile.children[0]!;
  const flush = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  return {
    menu,
    hooks: hooks.current!,
    views,
    stage,
    tiles,
    picture,
    posts,
    postResults,
    fetches,
    fetchMock,
    revoked,
    classes,
    windowListeners,
    flush,
    answerAll: async () => {
      for (const pending of fetches.splice(0)) pending.finish();
      await flush(0);
    },
  };
}

describe('camera grid page', () => {
  afterEach(() => vi.useRealTimers());

  it('asks for nothing as a neighbour, and for pictures three at a time once shown', async () => {
    const s = setup();
    await s.flush(5_000);
    expect(s.posts).toEqual([]);
    expect(s.fetchMock).not.toHaveBeenCalled();
    s.hooks.enter();
    await s.flush(0);
    expect(s.posts).toEqual(['grid']);
    expect(s.tiles()).toHaveLength(5);
    // Three pictures at once, the rest when one has come in.
    expect(s.fetches).toHaveLength(3);
    s.fetches.shift()!.finish();
    await s.flush(100);
    expect(s.fetches).toHaveLength(3);
    expect(s.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('shows a picture decoded off screen and releases the old one', async () => {
    const s = setup(1);
    s.hooks.enter();
    await s.flush(0);
    s.fetches.shift()!.finish();
    await s.flush(0);
    const tile = s.tiles()[0]!;
    expect(tile.dataset['state']).toBe('live');
    expect(s.picture(tile).src).toBe('blob:1');
    await s.flush(1_600);
    s.fetches.shift()!.finish();
    await s.flush(0);
    expect(s.picture(tile).src).toBe('blob:2');
    expect(s.revoked).toContain('blob:1');
  });

  it('holds pictures while the pages move and shows them when they stop', async () => {
    const s = setup(1);
    s.hooks.enter();
    await s.flush(0);
    s.classes.add('paging');
    s.fetches.shift()!.finish();
    await s.flush(0);
    expect(s.picture(s.tiles()[0]!).src).toBe('');
    s.classes.delete('paging');
    for (const fn of s.windowListeners.get('lugn:pages-settled') ?? []) fn();
    await s.flush(0);
    expect(s.picture(s.tiles()[0]!).src).toBe('blob:1');
  });

  it('stops asking, closes the lease and keeps no request going when it is left', async () => {
    const s = setup();
    s.hooks.enter();
    await s.flush(0);
    s.hooks.leave();
    await s.flush(0);
    expect(s.posts).toEqual(['grid', 'grid-close']);
    const asked = s.fetchMock.mock.calls.length;
    await s.flush(10_000);
    expect(s.fetchMock.mock.calls.length).toBe(asked);
    // A picture that comes in after leaving shows nothing and leaks nothing.
    await s.answerAll();
    expect(s.tiles().every((t) => s.picture(t).src === '')).toBe(true);
    expect(s.revoked.length).toBeGreaterThanOrEqual(0);
  });

  it('takes a new visit while the last one is still waiting for its lease', async () => {
    const s = setup();
    let release!: () => void;
    s.postResults[0] = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            cameraGrid: {
              cameras: [
                { id: 'entry', name: 'Entré', imageUrl: '/k/t/i/entry' },
              ],
            },
          });
      });
    s.hooks.enter();
    await s.flush(400);
    s.hooks.leave();
    await s.flush(500);
    s.hooks.enter();
    await s.flush(0);
    // The second visit asked for its own lease and got pictures at once…
    expect(s.posts.filter((p) => p === 'grid')).toHaveLength(2);
    expect(s.fetches.length).toBeGreaterThan(0);
    // …and the first visit's late answer neither changes it nor closes it.
    release();
    await s.flush(0);
    expect(s.posts).not.toContain('grid-close');
    expect(s.tiles()).toHaveLength(5);
  });

  it('clears every picture when the server says cameras are off', async () => {
    const s = setup();
    s.hooks.enter();
    await s.flush(0);
    await s.answerAll();
    expect(s.tiles().some((t) => s.picture(t).src !== '')).toBe(true);
    const refused = Object.assign(new Error('command_409'), { status: 409 });
    s.postResults[1] = () => Promise.reject(refused);
    await s.flush(20_000);
    expect(s.tiles()).toHaveLength(0);
    expect(s.views['notice']!.hidden).toBe(false);
    expect(s.views['notice']!.textContent).toContain('avstängd');
    expect(s.revoked.length).toBeGreaterThan(0);
  });

  it("shows one camera large when tapped, faster and alone; the navbar's back button returns", async () => {
    const s = setup();
    s.hooks.enter();
    await s.flush(0);
    await s.answerAll();
    const tap = s.menu.options!.handleTap;
    // A tap on a camera in the grid is the page's own.
    expect(tap({ target: s.tiles()[2]! })).toBe(true);
    await s.flush(0);
    const shown = s.tiles().filter((t) => !t.hidden);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.dataset['camera']).toBe('north');
    expect(shown[0]!.attrs.get('aria-label')).toContain('tillbaka');
    // The navbar comes up with its way back.
    expect(s.menu.back).toBeTypeOf('function');
    expect(s.menu.shown).toBe(1);
    // Only that camera is asked for, one at a time.
    await s.flush(0);
    expect(s.fetches.every((f) => f.url.includes('/north/'))).toBe(true);
    s.menu.back!();
    await s.flush(0);
    expect(s.tiles().filter((t) => !t.hidden)).toHaveLength(5);
    // In the grid there is nothing to go back from.
    expect(s.menu.back).toBeNull();
  });

  it("shares the navbar of Foto and Musik: taps on cameras are the page's, the rest the bar's", async () => {
    const s = setup();
    expect(s.menu.options?.id).toBe('kameror');
    // Without a large camera there is no way back to give.
    expect(s.menu.back).toBeNull();
    // Not before the page is shown.
    expect(s.menu.options!.handleTap({ target: s.views['stage']! })).toBe(
      false,
    );
    s.hooks.enter();
    await s.flush(0);
    const tap = s.menu.options!.handleTap;
    // Empty space beside the cameras opens or closes the bar.
    expect(tap({ target: s.views['stage']! })).toBe(false);
    // A camera in the grid is taken (and shown large)…
    expect(tap({ target: s.tiles()[0]! })).toBe(true);
    await s.flush(0);
    // …and a tap on the large camera is the bar's (it opens or closes).
    expect(tap({ target: s.tiles()[0]! })).toBe(false);
    expect(s.tiles().filter((t) => !t.hidden)).toHaveLength(1);
    expect(s.menu.back).toBeTypeOf('function');
  });
});
