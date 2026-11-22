import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync(
  new URL('../src/ui/pages.js', import.meta.url),
  'utf8',
);

type Listener = (event: FakeEvent) => void;

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  cancelable = true;
  [key: string]: unknown;
  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }
  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopImmediatePropagation(): void {
    this.propagationStopped = true;
  }
}

class Target {
  listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(event: FakeEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
      if (event.propagationStopped) return;
    }
  }
}

class FakeElement extends Target {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  classes = new Set<string>();
  inert = false;
  scrollHeight = 0;
  clientHeight = 0;
  animations: Array<{
    keyframes: Array<{ transform: string }>;
    options: { duration: number };
    animation: FakeAnimation;
  }> = [];
  classList = {
    toggle: (name: string, on: boolean) =>
      on ? this.classes.add(name) : this.classes.delete(name),
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
  };
  constructor(readonly tagName = 'DIV') {
    super();
  }
  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  contains(node: FakeElement | null): boolean {
    for (let n = node; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  modal: FakeElement | null = null;
  querySelector(): FakeElement | null {
    return this.modal;
  }
  querySelectorAll(): FakeElement[] {
    return this.children.filter((child) => child.classes.has('hub-page'));
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  setPointerCapture(): void {
    throw new Error('NotFoundError');
  }
  animate(
    keyframes: Array<{ transform: string }>,
    options: { duration: number },
  ): FakeAnimation {
    const animation = new FakeAnimation();
    this.animations.push({ keyframes, options, animation });
    return animation;
  }
}

class FakeAnimation {
  currentTime = 0;
  onfinish: (() => void) | null = null;
  cancelled = false;
  cancel(): void {
    this.cancelled = true;
  }
  finish(): void {
    this.onfinish?.();
  }
}

function setup(count = 3) {
  const pager = new FakeElement();
  const track = new FakeElement();
  const dots = new FakeElement();
  pager.append(track, dots);
  const pages = Array.from({ length: count }, (_, i) => {
    const page = new FakeElement('SECTION');
    page.classes.add('hub-page');
    page.dataset['page'] = ['home', 'clock', 'info', 'four'][i] ?? `p${i}`;
    const button = new FakeElement('BUTTON');
    page.append(button);
    track.append(page);
    dots.append(new FakeElement('I'));
    return { page, button };
  });
  const byId: Record<string, FakeElement> = {
    'hub-pager': pager,
    'hub-track': track,
    'hub-dots': dots,
  };
  const document = new Target() as Target & Record<string, unknown>;
  document['getElementById'] = (id: string) => byId[id] ?? null;
  Object.defineProperty(document, 'activeElement', { value: null });
  const window = new Target() as Target & Record<string, unknown>;
  const resize = (width: number) => {
    window['innerWidth'] = width;
    window.fire(new FakeEvent('resize'));
  };
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let timerId = 0;
  const frames: Array<(t: number) => void> = [];
  let settled = 0;
  const pageEvents: unknown[] = [];
  Object.assign(window, {
    innerWidth: 1000,
    dispatchEvent: (event: FakeEvent) => {
      if (event.type === 'lugn:pages-settled') settled += 1;
      if (event.type === 'lugn:page') pageEvents.push(event['detail']);
      return true;
    },
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ at: now + ms, fn, id: ++timerId });
      return timerId;
    },
    clearTimeout: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const context = createContext({
    window,
    document,
    globalThis: undefined,
    performance: { now: () => now },
    requestAnimationFrame: (fn: (t: number) => void) => frames.push(fn),
    getComputedStyle: () => ({ overflowY: 'visible' }),
    console,
    Event: FakeEvent,
    CustomEvent: class extends FakeEvent {
      constructor(type: string, init: { detail?: unknown } = {}) {
        super(type, { detail: init.detail });
      }
    },
  });
  context['globalThis'] = context;
  Object.assign(context, window);
  runInContext(script, context);
  const api = context['lugnPages'] as {
    go(target: string | number): boolean;
    current(): string;
    onChange(fn: (page: string, previous: string) => void): () => void;
  };
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers
        .filter((t) => t.at <= now)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
    for (const fn of frames.splice(0)) fn(now);
  };
  const pointer = (
    type: string,
    target: FakeElement,
    x: number,
    y = 300,
    pointerType = 'touch',
  ) => {
    const event = new FakeEvent(type, {
      target,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType,
      button: 0,
      timeStamp: now,
    });
    if (type === 'pointerdown') pager.fire(event);
    else document.fire(event);
    return event;
  };
  // A drag from x0 to x1 in `steps` moves, 16 ms apart, then a release.
  const drag = (
    target: FakeElement,
    x0: number,
    x1: number,
    { steps = 10, hold = 0, pointerType = 'touch', y = () => 300 } = {},
  ) => {
    pointer('pointerdown', target, x0, 300, pointerType);
    for (let i = 1; i <= steps; i += 1) {
      advance(16);
      pointer(
        'pointermove',
        target,
        x0 + ((x1 - x0) * i) / steps,
        y(),
        pointerType,
      );
    }
    advance(hold || 8);
    pointer('pointerup', target, x1, 300, pointerType);
  };
  const click = (target: FakeElement) => {
    const event = new FakeEvent('click', { target });
    window.fire(event);
    return event;
  };
  const finishAnimations = () => {
    for (const a of track.animations) a.animation.finish();
  };
  const wheel = (target: FakeElement, deltaX: number, deltaY = 0) => {
    const event = new FakeEvent('wheel', {
      target,
      deltaX,
      deltaY,
      deltaMode: 0,
      timeStamp: now,
    });
    pager.fire(event);
    return event;
  };
  return {
    api,
    pager,
    wheel,
    resize,
    settledEvents: () => settled,
    pageEvents,
    pages,
    track,
    dots,
    drag,
    pointer,
    click,
    advance,
    finishAnimations,
  };
}

describe('Hub pager', () => {
  it('starts on Hem with only its neighbour prepared', () => {
    const { api, pages, dots } = setup();
    expect(api.current()).toBe('home');
    expect(pages.map(({ page }) => page.dataset['state'])).toEqual([
      'active',
      'near',
      'off',
    ]);
    expect(pages[1]?.page.inert).toBe(true);
    expect(dots.children[0]?.classes.has('current')).toBe(true);
  });

  it('turns the page on a long swipe and settles with a spring animation', () => {
    const {
      api,
      pager,
      track,
      pages,
      drag,
      advance,
      finishAnimations,
      settledEvents,
      pageEvents,
    } = setup();
    drag(pages[0]!.button, 800, 200);
    expect(api.current()).toBe('clock');
    const settle = track.animations.at(-1)!;
    expect(settle.keyframes.at(-1)?.transform).toBe(
      'translate3d(-1000px, 0, 0)',
    );
    expect(track.style['transform']).toBe('translate3d(-1000px, 0, 0)');
    expect(pager.classes.has('moving')).toBe(true);
    finishAnimations();
    advance(100);
    expect(pages.map(({ page }) => page.dataset['state'])).toEqual([
      'near',
      'active',
      'near',
    ]);
    // At rest the track is painted with the page again, not as its own layer.
    advance(400);
    expect(pager.classes.has('moving')).toBe(false);
    expect(settledEvents()).toBe(1);
    expect(pageEvents).toEqual([{ page: 'clock', previous: 'home' }]);
    expect(track.style['transform']).toBe('translate(-1000px, 0)');
  });

  it('turns the page on a short fast flick but not on a slow short drag', () => {
    const flick = setup();
    flick.drag(flick.pages[0]!.button, 600, 450, { steps: 4 });
    expect(flick.api.current()).toBe('clock');

    const slow = setup();
    slow.drag(slow.pages[0]!.button, 600, 450, { steps: 20, hold: 200 });
    expect(slow.api.current()).toBe('home');
    expect(slow.track.animations.at(-1)?.keyframes.at(-1)?.transform).toBe(
      'translate3d(0px, 0, 0)',
    );
  });

  it('rubber-bands past the first page and returns to it', () => {
    const { api, track, pages, pointer, advance } = setup();
    pointer('pointerdown', pages[0]!.button, 100);
    for (let x = 120; x <= 900; x += 60) {
      advance(16);
      pointer('pointermove', pages[0]!.button, x);
    }
    const shown = Number(
      /translate3d\((-?[\d.]+)px/.exec(track.style['transform']!)![1],
    );
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(400); // far less than the 800 px dragged
    advance(8);
    pointer('pointerup', pages[0]!.button, 900);
    expect(api.current()).toBe('home');
    expect(track.animations.at(-1)?.keyframes.at(-1)?.transform).toBe(
      'translate3d(0px, 0, 0)',
    );
  });

  it('swallows the click that ends a swipe, and only that one', () => {
    const { pages, drag, click, advance } = setup();
    drag(pages[0]!.button, 800, 200);
    expect(click(pages[0]!.button).defaultPrevented).toBe(true);
    advance(16);
    expect(click(pages[1]!.button).defaultPrevented).toBe(false);
  });

  it('leaves taps and vertical moves to the page', () => {
    const { api, pages, pointer, click, track } = setup();
    pointer('pointerdown', pages[0]!.button, 500);
    pointer('pointerup', pages[0]!.button, 503);
    expect(click(pages[0]!.button).defaultPrevented).toBe(false);
    pointer('pointerdown', pages[0]!.button, 500, 300);
    const move = pointer('pointermove', pages[0]!.button, 508, 340);
    pointer('pointerup', pages[0]!.button, 508, 340);
    expect(move.defaultPrevented).toBe(false);
    expect(click(pages[0]!.button).defaultPrevented).toBe(false);
    expect(api.current()).toBe('home');
    expect(track.animations).toHaveLength(0);
  });

  it('follows the bridge mouse, whose pointers cannot be captured', () => {
    const { api, pages, drag } = setup();
    drag(pages[0]!.button, 800, 200, { pointerType: 'mouse' });
    expect(api.current()).toBe('clock');
  });

  it('moves at most one page per swipe and stops at the last page', () => {
    const { api, pages, drag, finishAnimations } = setup();
    drag(pages[0]!.button, 990, 10, { steps: 3 });
    expect(api.current()).toBe('clock');
    finishAnimations();
    drag(pages[1]!.button, 990, 10, { steps: 3 });
    finishAnimations();
    drag(pages[2]!.button, 990, 10, { steps: 3 });
    expect(api.current()).toBe('info');
  });

  it('catches a settling page under the finger', () => {
    const { api, track, pages, drag, pointer, advance } = setup();
    drag(pages[0]!.button, 800, 200);
    const settle = track.animations.at(-1)!;
    settle.animation.currentTime = 50;
    pointer('pointerdown', pages[1]!.button, 500);
    expect(settle.animation.cancelled).toBe(true);
    const caught = Number(
      /translate3d\((-?[\d.]+)px/.exec(track.style['transform']!)![1],
    );
    expect(caught).toBeGreaterThan(-1000);
    expect(caught).toBeLessThan(-600);
    advance(16);
    pointer('pointerup', pages[1]!.button, 500);
    expect(api.current()).toBe('clock');
  });

  it('reads a fast bridge swipe from its release alone, and swallows its click', () => {
    const { api, pages, pointer, click } = setup();
    // The bridge sends held moves once per frame but the release at once:
    // a quick swipe across Släck can arrive as down then up, 300 px apart.
    pointer('pointerdown', pages[0]!.button, 700, 300, 'mouse');
    pointer('pointerup', pages[0]!.button, 398, 300, 'mouse');
    expect(api.current()).toBe('clock');
    expect(click(pages[0]!.button).defaultPrevented).toBe(true);
  });

  it('keeps a long first move beyond the slop', () => {
    const { track, pages, pointer } = setup();
    pointer('pointerdown', pages[0]!.button, 700);
    pointer('pointermove', pages[0]!.button, 500);
    expect(track.style['transform']).toBe('translate3d(-190px, 0, 0)');
  });

  it('lets a new press end swallowing when a swipe produced no click', () => {
    const { pages, drag, pointer, click, advance, finishAnimations } = setup();
    drag(pages[0]!.button, 800, 200);
    finishAnimations();
    advance(50);
    pointer('pointerdown', pages[1]!.button, 500);
    pointer('pointerup', pages[1]!.button, 500);
    expect(click(pages[1]!.button).defaultPrevented).toBe(false);
  });

  it('hands an unsettled horizontal wheel over to a press', () => {
    const { api, pages, wheel, pointer, advance } = setup();
    wheel(pages[0]!.button, 300);
    pointer('pointerdown', pages[0]!.button, 500);
    advance(200); // the wheel's idle timer would have settled by now
    expect(api.current()).toBe('home');
    for (let x = 520; x <= 700; x += 20) {
      advance(16);
      pointer('pointermove', pages[0]!.button, x);
    }
    advance(8);
    pointer('pointerup', pages[0]!.button, 700);
    expect(api.current()).toBe('home');
  });

  it('cleans up page states when resized during a settle', () => {
    const { api, pages, drag, resize, advance, pager, track } = setup();
    drag(pages[0]!.button, 800, 200);
    resize(800);
    advance(1000);
    expect(api.current()).toBe('clock');
    expect(pages.map(({ page }) => page.dataset['state'])).toEqual([
      'near',
      'active',
      'near',
    ]);
    expect(pages[0]!.page.inert).toBe(true);
    expect(pager.classes.has('moving')).toBe(false);
    expect(track.style['transform']).toBe('translate(-800px, 0)');
  });

  it('lets a change listener go on to another page', () => {
    const { api, track } = setup();
    api.onChange((page) => {
      if (page === 'clock') api.go('info');
    });
    api.go('clock');
    expect(api.current()).toBe('info');
    expect(track.animations.at(-1)?.keyframes.at(-1)?.transform).toBe(
      'translate3d(-2000px, 0, 0)',
    );
  });

  it('stays put while a modal dialog is open', () => {
    const { api, pages, pager, drag, wheel, pointer } = setup();
    pager.modal = new FakeElement();
    drag(pages[0]!.button, 800, 200);
    wheel(pages[0]!.button, 0, 120);
    expect(api.go('clock')).toBe(false);
    expect(api.current()).toBe('home');
    pager.modal = null;
    pointer('pointerdown', pages[0]!.button, 500);
    pointer('pointerup', pages[0]!.button, 500);
    expect(api.go('clock')).toBe(true);
  });

  it('goes to a page by id, and refuses unknown ones', () => {
    const { api, track } = setup(4);
    expect(api.go('four')).toBe(true);
    expect(api.current()).toBe('four');
    // A jump starts next to the target, so only one neighbour is crossed.
    expect(track.animations.at(-1)?.keyframes[0]?.transform).toBe(
      'translate3d(-2000px, 0, 0)',
    );
    expect(api.go('nope')).toBe(false);
  });
});
