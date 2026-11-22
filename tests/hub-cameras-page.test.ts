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

const WIDTH = 952; // a 1024 px Hub (36 px each side)
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
    if (selector === '.cams-tile' && this.className.includes('cams-tile'))
      return this;
    return this.parent?.closest(selector) ?? null;
  }
}

type Hooks = { enter(): void; leave(): void; sleep(): void };

function setup(count = 5) {
  vi.useFakeTimers();
  const names = ['Entré', 'Framsida', 'Norr', 'Syd', 'Baksida'].slice(0, count);
  const ids = ['entry', 'front', 'north', 'south', 'back'].slice(0, count);
  const views: Record<string, El> = {
    root: new El('div'),
    stage: new El('div'),
    notice: new El('div'),
    sub: new El('span'),
    back: new El('button'),
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

  it('shows one camera large when tapped, faster and alone, and returns on a tap', async () => {
    const s = setup();
    s.hooks.enter();
    await s.flush(0);
    await s.answerAll();
    s.tiles()[2]!.fire('click');
    s.stage.fire('click', { target: s.tiles()[2] });
    await s.flush(0);
    const shown = s.tiles().filter((t) => !t.hidden);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.dataset['camera']).toBe('north');
    expect(shown[0]!.attrs.get('aria-label')).toContain('tillbaka');
    // Only that camera is asked for, one at a time.
    const before = s.fetchMock.mock.calls.length;
    await s.flush(0);
    expect(s.fetches.every((f) => f.url.includes('/north/'))).toBe(true);
    expect(s.fetchMock.mock.calls.length).toBeGreaterThanOrEqual(before);
    s.stage.fire('click', { target: shown[0] });
    await s.flush(0);
    expect(s.tiles().filter((t) => !t.hidden)).toHaveLength(5);
  });
});
