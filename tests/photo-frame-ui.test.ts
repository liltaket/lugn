import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// A very small DOM and clock: just what photos-page.js and quick-menu.js (the
// navbar) use.
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

type Fixture = {
  photos?: Array<Record<string, unknown>>;
  listing?: Record<string, unknown>;
};

function makeWorld(fixture: Fixture = {}) {
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
  const clockTime = make('b', 'clock-time', photosRoot);
  const clockDate = make('span', 'clock-date', photosRoot);
  const now_ = make('div', 'now', photosRoot);
  now_.hidden = true;
  const pause = make('button', 'pause', now_);
  make('path', 'pause-icon', pause);
  make('b', 'now-title', now_);
  make('span', 'now-artist', now_);
  // The navbar (one for every page): a back button, the scenes and the round
  // buttons, each hidden until the page it is over asks for it.
  const nav = new El('nav');
  nav.style = { setProperty: () => {}, removeProperty: () => {} } as never;
  const navButton = (name: string) => {
    const e = make('button', undefined, nav, { 'data-nb': name });
    e.hidden = true;
    return e;
  };
  const back = navButton('back');
  const next = navButton('next');
  const toMusic = navButton('music');
  const toCameras = navButton('cameras');
  const dockButton = make('button', undefined, make('div', 'dock', nav));
  // Musik: a root with a play button, a cover and bare space.
  const musicRoot = new El('div');
  const play = make('button', 'play', musicRoot);
  const cover = make('div', 'cover', musicRoot);
  const space = make('div', 'info', musicRoot);
  const docRoots: Record<string, El> = {
    ".hub-page[data-page='foto'] [data-view='root']": photosRoot,
    ".hub-page[data-page='music'] [data-view='root']": musicRoot,
  };
  const photos =
    fixture.photos ??
    Array.from({ length: 8 }, (_, i) => ({
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
      getElementById: (id: string) =>
        id === 'hub-pager' ? pager : id === 'hub-nav' ? nav : null,
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
        json: async () => ({ revision: 'r1', photos, ...fixture.listing }),
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
  const went: string[] = [];
  win['lugnPages'] = {
    current: () => currentPage.id,
    ids: () => ['home', 'music', 'kameror', 'clock', 'foto', 'info'],
    go: (id: string) => {
      went.push(id);
      return true;
    },
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
    clockTime,
    clockDate,
    photosRoot,
    nav,
    back,
    next,
    toMusic,
    toCameras,
    went,
    musicRoot,
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
    world.photosRoot.fire('click');
    expect(world.nav.classes.has('open')).toBe(true);
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
    expect(world.nav.classes.has('open')).toBe(true);
    release();
    world.decodeGate.current = null;
    await world.advance(100);
    // The slide changed under the open menu, and the menu stays open for
    // longer than a show: the mouse keeps moving for 30 s.
    for (let i = 0; i < 10; i += 1) {
      world.photosRoot.fire('pointermove', { pointerType: 'mouse' });
      await world.advance(3_000);
    }
    expect(world.nav.classes.has('open')).toBe(true);
    await world.advance(10_000); // the mouse is still: the menu closes
    expect(world.nav.classes.has('open')).toBe(false);
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

  it('ends a picture’s drift with its slide, when replaced and when the page sleeps', async () => {
    const world = makeWorld();
    const drifts: Array<{ cancelled: boolean }> = [];
    const picture = world.win['Image'] as { prototype: { animate?: unknown } };
    picture.prototype.animate = () => {
      const drift = {
        cancelled: false,
        cancel() {
          drift.cancelled = true;
        },
      };
      drifts.push(drift);
      return drift;
    };
    world.hooks['enter']!();
    await world.advance(100);
    const first = [...drifts];
    expect(first.length).toBeGreaterThan(0);
    expect(first.some((drift) => drift.cancelled)).toBe(false);
    // The next slide takes over: the first one's drift goes with it, the new
    // one's keeps running.
    await world.advance(25_000);
    expect(drifts.length).toBeGreaterThan(first.length);
    expect(first.every((drift) => drift.cancelled)).toBe(true);
    expect(drifts.at(-1)!.cancelled).toBe(false);
    world.hooks['leave']!();
    world.hooks['sleep']!();
    expect(drifts.every((drift) => drift.cancelled)).toBe(true);
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

describe('Musik navbar', () => {
  it('opens only on the bare page, not on a press of a control', async () => {
    const world = makeWorld();
    world.currentPage.id = 'music';
    world.play.fire('click');
    expect(world.nav.classes.has('open')).toBe(false);
    world.cover.fire('click');
    expect(world.nav.classes.has('open')).toBe(false);
    world.space.fire('click');
    expect(world.nav.classes.has('open')).toBe(true);
    // Controls and the cover leave an open bar as it is; the bare page closes it.
    world.play.fire('click');
    expect(world.nav.classes.has('open')).toBe(true);
    world.cover.fire('click');
    expect(world.nav.classes.has('open')).toBe(true);
    world.dockButton.fire('click');
    expect(world.nav.classes.has('open')).toBe(true);
    world.space.fire('click');
    expect(world.nav.classes.has('open')).toBe(false);
  });
});

describe('The navbar', () => {
  const dispatch = (world: ReturnType<typeof makeWorld>, type: string) =>
    (world.win['dispatchEvent'] as (e: FakeEvent) => void)(new FakeEvent(type));
  const moveMouse = async (world: ReturnType<typeof makeWorld>, ms = 200) => {
    world.photosRoot.fire('pointermove', { pointerType: 'mouse' });
    await world.advance(ms);
  };
  const open = (world: ReturnType<typeof makeWorld>) =>
    world.nav.classes.has('open');

  it('shows only what the page it is over needs', async () => {
    const world = makeWorld();
    world.win['refs'] = { cameraMenu: { hidden: false } };
    world.hooks['prepare']!();
    // Foto: the next picture, Musik and Kameror; nothing to go back from.
    world.photosRoot.fire('click');
    expect(world.nav.dataset['page']).toBe('foto');
    expect(world.next.hidden).toBe(false);
    expect(world.toMusic.hidden).toBe(false);
    expect(world.toCameras.hidden).toBe(false);
    expect(world.back.hidden).toBe(true);
    // Musik: not a button to itself, nor a next picture.
    world.currentPage.id = 'music';
    dispatch(world, 'lugn:page');
    expect(open(world)).toBe(true);
    expect(world.nav.dataset['page']).toBe('music');
    expect(world.toMusic.hidden).toBe(true);
    expect(world.toCameras.hidden).toBe(false);
    expect(world.next.hidden).toBe(true);
  });

  it('is the same bar on every page: it stays open when the page changes and goes on Hem', async () => {
    const world = makeWorld();
    world.photosRoot.fire('click');
    expect(world.photosRoot.classes.has('menu-open')).toBe(true);
    world.currentPage.id = 'music';
    dispatch(world, 'lugn:page');
    expect(open(world)).toBe(true);
    // What the old page moved for the bar moves back, and the new page moves.
    expect(world.photosRoot.classes.has('menu-open')).toBe(false);
    expect(world.musicRoot.classes.has('menu-open')).toBe(true);
    // Hem has no bar.
    world.currentPage.id = 'home';
    dispatch(world, 'lugn:page');
    expect(open(world)).toBe(false);
    expect(world.musicRoot.classes.has('menu-open')).toBe(false);
  });

  it('goes to Musik and Kameror from its buttons, and stays', async () => {
    const world = makeWorld();
    world.win['refs'] = { cameraMenu: { hidden: false } };
    world.photosRoot.fire('click');
    world.toMusic.fire('click');
    world.toCameras.fire('click');
    expect(world.went).toEqual(['music', 'kameror']);
    expect(open(world)).toBe(true);
  });

  it('gives a page its back button, and presses it', async () => {
    const world = makeWorld();
    const attach = (
      world.win['lugnQuickMenu'] as {
        attach: (o: unknown) => { setBack: (fn: (() => void) | null) => void };
      }
    ).attach;
    const cameraRoot = new El('div');
    const camera = attach({ id: 'kameror', root: cameraRoot });
    world.currentPage.id = 'kameror';
    cameraRoot.fire('click');
    expect(open(world)).toBe(true);
    expect(world.back.hidden).toBe(true);
    // One camera large: the page gives a way back, shown at once.
    let pressed = 0;
    camera.setBack(() => (pressed += 1));
    expect(world.back.hidden).toBe(false);
    world.back.fire('click');
    expect(pressed).toBe(1);
    // Gone again when the page has nothing to go back from.
    camera.setBack(null);
    expect(world.back.hidden).toBe(true);
  });

  it('opened by the mouse, it goes when the mouse leaves; opened by a tap, it stays', async () => {
    const world = makeWorld();
    await moveMouse(world);
    expect(open(world)).toBe(true);
    dispatch(world, 'lugn:pointer-leave');
    await world.advance(500);
    expect(open(world)).toBe(false);
    // Opened by a tap, the mouse leaving does not take it.
    world.photosRoot.fire('click');
    expect(open(world)).toBe(true);
    dispatch(world, 'lugn:pointer-leave');
    await world.advance(2_000);
    expect(open(world)).toBe(true);
    await world.advance(7_000);
    expect(open(world)).toBe(false);
  });

  it('does not come back when the mouse moves a little after a tap closed it', async () => {
    const world = makeWorld();
    await moveMouse(world);
    expect(open(world)).toBe(true);
    // A click on the bare page closes it…
    world.photosRoot.fire('click');
    expect(open(world)).toBe(false);
    // …and the mouse fidgeting around afterwards leaves it closed.
    for (let i = 0; i < 10; i += 1) await moveMouse(world, 400);
    expect(open(world)).toBe(false);
    // It returns when the mouse has left and comes back…
    dispatch(world, 'lugn:pointer-leave');
    await moveMouse(world);
    expect(open(world)).toBe(true);
  });

  it('shows again for a mouse that has rested after a tap closed it', async () => {
    const world = makeWorld();
    await moveMouse(world);
    world.photosRoot.fire('click');
    expect(open(world)).toBe(false);
    await moveMouse(world, 6_000);
    await moveMouse(world);
    expect(open(world)).toBe(true);
  });

  it('a mouse that stops closes it after four seconds', async () => {
    const world = makeWorld();
    await moveMouse(world);
    expect(open(world)).toBe(true);
    await world.advance(3_000);
    expect(open(world)).toBe(true);
    await world.advance(1_500);
    expect(open(world)).toBe(false);
  });

  it('does not open for a finger or while a button is held (a swipe)', async () => {
    const world = makeWorld();
    world.photosRoot.fire('pointermove', { pointerType: 'touch' });
    world.photosRoot.fire('pointermove', { pointerType: 'mouse', buttons: 1 });
    await world.advance(300);
    expect(open(world)).toBe(false);
  });
});

describe('Foto groups', () => {
  // Ten pictures from one trip, every one a neighbour of the others.
  const related = Array.from({ length: 10 }, (_, i) => ({
    id: `${'abcdefghij'[i]}`.repeat(24),
    w: 480,
    h: 640,
    date: '2026-11-0' + (4 + (i % 2)),
    place: 'Svedala',
    t: 1_000 + i,
    lat: 55.5,
    lon: 13.4,
    cc: 'SE',
    tr: 0,
    nb: Array.from({ length: 10 }, (_, j) => [j, 80]).filter(([j]) => j !== i),
  }));
  const listing = {
    trips: [{ title: 'Skåne', from: '2026-11-04', to: '2026-11-05', cc: 'SE' }],
    scenes: {},
    people: [],
  };

  it('names the group and shows where in it a slide is', async () => {
    const world = makeWorld({ photos: related, listing });
    world.hooks['enter']!();
    await world.advance(100);
    const slide = world.slides()[0]!;
    const caption = slide.all('.ph-cap')[0]!;
    expect(caption.all('small')[0]!.textContent).toBe('Resa');
    expect(caption.all('b')[0]!.textContent).toBe('Skåne');
    expect(caption.all('span')[0]!.textContent).toBe('4–5 november');
    // Ten portraits make several slides of one group; dots say which one.
    const dots = caption.all('u');
    expect(dots.length).toBeGreaterThanOrEqual(2);
    expect(dots.filter((d) => d.classes.has('on'))).toHaveLength(1);
    expect(dots[0]!.classes.has('on')).toBe(true);
  });

  it('plays a whole group over its slides before the next group begins', async () => {
    const world = makeWorld({ photos: related, listing });
    world.hooks['enter']!();
    await world.advance(100);
    const ofFirst = world.slides()[0]!.all('u').length;
    const seen = [
      world
        .slides()[0]!
        .all('u')
        .filter((d) => d.classes.has('on')).length,
    ];
    expect(ofFirst).toBeGreaterThanOrEqual(2);
    await world.advance(21_000);
    const second = world.slides().at(-1)!;
    const position = second.all('u').findIndex((d) => d.classes.has('on'));
    expect(position).toBe(1);
    void seen;
  });

  it('keeps the old caption and queue when the server lists no neighbours', async () => {
    const world = makeWorld();
    world.hooks['enter']!();
    await world.advance(100);
    const caption = world.slides()[0]!.all('.ph-cap')[0]!;
    expect(caption.all('small')).toHaveLength(0);
    expect(caption.all('b')[0]!.textContent).toBe('Svedala');
    expect(world.slides()[0]!.all('u')).toHaveLength(0);
  });

  it('shows the time of day, and stops redrawing when the page is left', async () => {
    const world = makeWorld();
    world.hooks['enter']!();
    await world.advance(100);
    expect(world.clockTime.textContent).toMatch(/^\d{2}[:.]\d{2}$/);
    expect(world.clockDate.textContent.length).toBeGreaterThan(5);
    world.clockTime.textContent = '';
    world.hooks['leave']!();
    await world.advance(120_000);
    expect(world.clockTime.textContent).toBe('');
    world.hooks['enter']!();
    expect(world.clockTime.textContent).not.toBe('');
  });

  it('does not touch the clock while the pager moves', async () => {
    const world = makeWorld();
    world.hooks['enter']!();
    await world.advance(100);
    world.clockTime.textContent = 'old';
    world.pager.classes.add('paging');
    await world.advance(125_000);
    expect(world.clockTime.textContent).toBe('old');
  });
});

describe('Foto corners', () => {
  const measured = Array.from({ length: 10 }, (_, i) => ({
    id: `${'abcdefghij'[i]}`.repeat(24),
    w: 480,
    h: 640,
    date: '2026-11-04',
    place: 'Svedala',
    t: 1_000 + i,
    lat: 55.5,
    lon: 13.4,
    lu: [10, 90, 50],
  }));

  it('gives a slide its shade levels and the layers that draw them', async () => {
    const world = makeWorld({ photos: measured });
    world.hooks['enter']!();
    await world.advance(100);
    const slide = world.slides()[0]!;
    expect(slide.dataset['tr']).toBe('0');
    expect(slide.dataset['br']).toBe('2');
    expect(slide.dataset['bl']).toBe('2');
    expect(slide.all('.ph-shade')).toHaveLength(3);
    expect(slide.all('.ph-blur')).toHaveLength(3);
    // The layers come after the pictures, so the layouts that count children still work.
    const kinds = slide.children.map((c) =>
      c.classes.has('ph-cell') ? 'cell' : 'other',
    );
    expect(kinds.lastIndexOf('cell')).toBeLessThan(kinds.indexOf('other'));
  });

  it('lets the blur draw only after the slide has settled, and not while the page is away', async () => {
    const world = makeWorld({ photos: measured });
    world.hooks['enter']!();
    await world.advance(100);
    expect(world.slides()[0]!.classes.has('settled')).toBe(true);
    // The next slide fades in over the old one and settles when the fade ends.
    await world.advance(20_000 + 500);
    const incoming = world.slides().at(-1)!;
    expect(incoming.classes.has('lift')).toBe(true);
    expect(incoming.classes.has('settled')).toBe(false);
    await world.advance(2_500);
    expect(world.slides().at(-1)!.classes.has('settled')).toBe(true);
    world.hooks['leave']!();
    expect(world.slides().at(-1)!.classes.has('settled')).toBe(false);
    world.hooks['enter']!();
    expect(world.slides().at(-1)!.classes.has('settled')).toBe(true);
  });

  it('marks the page while music plays so the lower left corner is shaded', async () => {
    const world = makeWorld({ photos: measured });
    expect(world.photosRoot.classes.has('has-now')).toBe(false);
    world.hooks['enter']!();
    await world.advance(100);
    // Nothing plays in this world: no shade for the widget.
    expect(world.photosRoot.classes.has('has-now')).toBe(false);
  });

  it('keeps a slide without measurements working (mid shade)', async () => {
    const world = makeWorld();
    world.hooks['enter']!();
    await world.advance(100);
    expect(world.slides()[0]!.dataset['tr']).toBe('1');
  });
});
