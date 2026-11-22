import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// A very small DOM and clock: just what photos-page.js and quick-menu.js use.
type Handler = (event: FakeEvent) => void;
class FakeEvent {
  target: El | null = null;
  detail: unknown;
  buttons = 0;
  pointerType = 'mouse';
  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }
}
class El {
  children: El[] = [];
  parent: El | null = null;
  classes = new Set<string>();
  attrs = new Map<string, string>();
  listeners = new Map<string, Handler[]>();
  hidden = false;
  disabled = false;
  textContent = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  width = 0;
  height = 0;
  naturalWidth = 0;
  naturalHeight = 0;
  complete = true;
  decodeGate: Promise<void> | null = null;
  constructor(readonly tagName: string) {}
  get classList() {
    const set = this.classes;
    return {
      add: (name: string) => void set.add(name),
      remove: (name: string) => void set.delete(name),
      contains: (name: string) => set.has(name),
    };
  }
  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this.classes].join(' ');
  }
  set src(value: string) {
    this.attrs.set('src', value);
    this.naturalWidth = 100;
    this.naturalHeight = 100;
  }
  get src() {
    return this.attrs.get('src') ?? '';
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  appendChild(child: El) {
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: El) {
    this.children = this.children.filter((c) => c !== child);
    child.parent = null;
  }
  remove() {
    this.parent?.removeChild(this);
  }
  contains(other: El | null): boolean {
    return other ? other.path().includes(this) : false;
  }
  path(): El[] {
    const out: El[] = [this];
    while (out[out.length - 1]!.parent) out.push(out[out.length - 1]!.parent!);
    return out;
  }
  closest(selector: string): El | null {
    return this.path().find((node) => node.matches(selector)) ?? null;
  }
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      const p = part.trim();
      const attr = /^\[([a-z-]+)(?:='([^']*)')?\]$/.exec(p);
      if (attr)
        return attr[2] === undefined
          ? this.attrs.has(attr[1]!)
          : this.attrs.get(attr[1]!) === attr[2];
      if (p.startsWith('.')) return this.classes.has(p.slice(1));
      return this.tagName === p;
    });
  }
  all(selector: string): El[] {
    const out: El[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) out.push(child);
      out.push(...child.all(selector));
    }
    return out;
  }
  querySelectorAll(selector: string) {
    return this.all(selector);
  }
  querySelector(selector: string) {
    return this.all(selector)[0] ?? null;
  }
  addEventListener(type: string, fn: Handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Handler) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  /** Fires on this element and bubbles to its ancestors. */
  fire(type: string, init: Record<string, unknown> = {}) {
    const event = new FakeEvent(type, { target: this, ...init });
    for (const node of this.path())
      for (const fn of node.listeners.get(type) ?? []) fn(event);
  }
  getContext() {
    throw new Error('no canvas in tests');
  }
  decode() {
    return this.decodeGate ?? Promise.resolve();
  }
}

function makeWorld() {
  const timers: Array<{
    id: number;
    due: number;
    fn: () => void;
    cleared: boolean;
  }> = [];
  let now = 1_000_000;
  const windowListeners = new Map<string, Handler[]>();
  let nextId = 1;
  const pager = new El('div');
  const photosRoot = new El('div');
  const make = (
    tag: string,
    view?: string,
    parent?: El,
    extra: Record<string, string> = {},
  ) => {
    const e = new El(tag);
    if (view) e.attrs.set('data-view', view);
    for (const [k, v] of Object.entries(extra)) e.attrs.set(k, v);
    parent?.appendChild(e);
    return e;
  };
  const stage = make('div', 'stage', photosRoot);
  make('div', 'notice', photosRoot).hidden = true;
  const now_ = make('div', 'now', photosRoot);
  now_.hidden = true;
  const pause = make('button', 'pause', now_);
  make('path', 'pause-icon', pause);
  make('b', 'now-title', now_);
  make('span', 'now-artist', now_);
  const menu = make('div', 'menu', photosRoot);
  const actions = make('div', undefined, menu);
  const camera = make('button', undefined, actions, { 'data-qm': 'camera' });
  camera.hidden = true;
  const next = make('button', 'next', actions);
  make('div', 'dock', menu);
  // Musik: a root with a menu, a play button, a cover and bare space.
  const musicRoot = new El('div');
  const musicMenu = make('div', 'menu', musicRoot);
  make('button', undefined, musicMenu, { 'data-qm': 'camera' }).hidden = true;
  const dockButton = make('button', undefined, make('div', 'dock', musicMenu));
  const play = make('button', 'play', musicRoot);
  const cover = make('div', 'cover', musicRoot);
  const space = make('div', 'info', musicRoot);
  const docRoots: Record<string, El> = {
    ".hub-page[data-page='foto'] [data-view='root']": photosRoot,
    ".hub-page[data-page='music'] [data-view='root']": musicRoot,
  };
  const photos = Array.from({ length: 8 }, (_, i) => ({
    id: `${'abcdefgh'[i]}`.repeat(24),
    w: 1024,
    h: 768,
    date: '2026-11-04',
    place: 'Svedala',
    t: 1_000 + i,
    lat: 55.5,
    lon: 13.4,
  }));
  const fetches: string[] = [];
  const decodeGate = { current: null as Promise<void> | null };
  const sandbox: Record<string, unknown> = {
    document: {
      querySelector: (selector: string) => docRoots[selector] ?? null,
      getElementById: (id: string) => (id === 'hub-pager' ? pager : null),
      createElement: (tag: string) => new El(tag),
    },
    Image: class extends El {
      constructor() {
        super('img');
        this.decodeGate = decodeGate.current;
      }
    },
    Event: FakeEvent,
    CustomEvent: FakeEvent,
    location: { pathname: '/k/x/' },
    fetch: async (url: string) => {
      fetches.push(url);
      return {
        status: 200,
        ok: true,
        json: async () => ({ revision: 'r1', photos }),
      };
    },
    performance: { now: () => now },
    setTimeout: undefined,
  };
  const win = sandbox;
  win['window'] = win;
  win['globalThis'] = win;
  win['setTimeout'] = (fn: () => void, ms: number) => {
    const timer = { id: nextId++, due: now + ms, fn, cleared: false };
    timers.push(timer);
    return timer.id;
  };
  win['clearTimeout'] = (id: number) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  };
  win['setInterval'] = (fn: () => void, ms: number) => {
    const timer = {
      id: nextId++,
      due: now + ms,
      fn: () => {},
      cleared: false,
    };
    const tick = () => {
      if (timer.cleared) return;
      fn();
      timer.due = now + ms;
      timer.fn = tick;
      timers.push({ ...timer });
    };
    timer.fn = tick;
    timers.push(timer);
    return timer.id;
  };
  win['clearInterval'] = win['clearTimeout'];
  win['addEventListener'] = (type: string, fn: Handler) =>
    windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]);
  win['removeEventListener'] = (type: string, fn: Handler) =>
    windowListeners.set(
      type,
      (windowListeners.get(type) ?? []).filter((f) => f !== fn),
    );
  win['dispatchEvent'] = (event: FakeEvent) => {
    for (const fn of windowListeners.get(event.type) ?? []) fn(event);
  };
  const definitions = new Map<string, Record<string, () => void>>();
  win['lugnPages'] = {
    current: () => currentPage.id,
    ids: () => ['home', 'music', 'kameror', 'clock', 'foto', 'info'],
    go: () => true,
    define: (id: string, hooks: Record<string, () => void>) =>
      definitions.set(id, hooks),
  };
  const currentPage = { id: 'foto' };
  const context = createContext(sandbox);
  for (const file of ['quick-menu.js', 'photos-page.js']) {
    runInContext(
      readFileSync(new URL(`../src/ui/${file}`, import.meta.url), 'utf8'),
      context,
    );
  }
  const flush = async () => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    await flush();
    for (;;) {
      const due = timers
        .filter((t) => !t.cleared && t.due <= end)
        .sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      now = Math.max(now, due.due);
      due.cleared = true;
      due.fn();
      await flush();
    }
    now = end;
    await flush();
  };
  return {
    stage,
    photosRoot,
    menu,
    next,
    musicRoot,
    musicMenu,
    play,
    cover,
    space,
    dockButton,
    pager,
    fetches,
    decodeGate,
    currentPage,
    hooks: definitions.get('foto')!,
    win,
    flush,
    advance,
    slides: () => stage.children.filter((c) => c.classes.has('ph-slide')),
  };
}

describe('Foto page lifecycle', () => {
  it('never shows the slide it is building twice: a tap on "next" while the first is built', async () => {
    const world = makeWorld();
    let release!: () => void;
    world.decodeGate.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.hooks['prepare']!();
    await world.flush();
    // The page is entered and the tap on Nästa bild comes while building.
    world.hooks['enter']!();
    world.next.fire('click');
    await world.flush();
    release();
    await world.advance(3_000);
    expect(world.slides()).toHaveLength(1);
    expect(world.slides()[0]!.classes.has('in')).toBe(true);
    // And it keeps going: the next slide arrives on the timer.
    world.decodeGate.current = null;
    await world.advance(21_000);
    expect(world.slides().length).toBeGreaterThanOrEqual(1);
    expect(world.slides().some((s) => s.classes.has('in'))).toBe(true);
  });

  it('goes on after a long stay in the quick menu', async () => {
    const world = makeWorld();
    world.hooks['enter']!();
    await world.advance(100);
    const first = world.slides()[0]!;
    expect(first).toBeDefined();
    // The show timer fires and the next slide is being built (its pictures are
    // slow) when the mouse moves and the menu opens.
    let release!: () => void;
    world.decodeGate.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    await world.advance(20_100);
    world.photosRoot.fire('pointermove', { pointerType: 'mouse' });
    await world.advance(100);
    expect(world.menu.classes.has('open')).toBe(true);
    release();
    world.decodeGate.current = null;
    await world.advance(100);
    // The slide changed under the open menu, and the menu stays open for
    // longer than a show: the mouse keeps moving for 30 s.
    for (let i = 0; i < 10; i += 1) {
      world.photosRoot.fire('pointermove', { pointerType: 'mouse' });
      await world.advance(3_000);
    }
    expect(world.menu.classes.has('open')).toBe(true);
    await world.advance(10_000); // the mouse is still: the menu closes
    expect(world.menu.classes.has('open')).toBe(false);
    // The show goes on after the menu: another change comes within a show.
    const shown = world.slides().at(-1)!;
    await world.advance(25_000);
    expect(world.slides().at(-1)).not.toBe(shown);
  });

  it('releases its pictures and timers when the page sleeps', async () => {
    const world = makeWorld();
    world.hooks['enter']!();
    await world.advance(100);
    expect(world.slides().length).toBe(1);
    world.hooks['leave']!();
    world.hooks['sleep']!();
    expect(world.slides()).toHaveLength(0);
    await world.advance(60_000);
    expect(world.slides()).toHaveLength(0);
  });

  it('waits with a pending change while the pager moves', async () => {
    const world = makeWorld();
    world.hooks['enter']!();
    await world.advance(100);
    const before = world.slides();
    world.pager.classes.add('paging');
    await world.advance(25_000);
    expect(world.slides()).toEqual(before);
    world.pager.classes.delete('paging');
    (world.win['dispatchEvent'] as (e: FakeEvent) => void)(
      new FakeEvent('lugn:pages-settled'),
    );
    await world.advance(3_000);
    expect(world.slides().length).toBeGreaterThanOrEqual(1);
  });
});

describe('Musik quick menu', () => {
  it('opens only on the bare page, not on a press of a control', async () => {
    const world = makeWorld();
    world.currentPage.id = 'music';
    world.play.fire('click');
    expect(world.musicMenu.classes.has('open')).toBe(false);
    world.cover.fire('click');
    expect(world.musicMenu.classes.has('open')).toBe(false);
    world.space.fire('click');
    expect(world.musicMenu.classes.has('open')).toBe(true);
    // Controls and the cover leave an open menu as it is; the bare page closes it.
    world.play.fire('click');
    expect(world.musicMenu.classes.has('open')).toBe(true);
    world.cover.fire('click');
    expect(world.musicMenu.classes.has('open')).toBe(true);
    world.dockButton.fire('click');
    expect(world.musicMenu.classes.has('open')).toBe(true);
    world.space.fire('click');
    expect(world.musicMenu.classes.has('open')).toBe(false);
  });
});
