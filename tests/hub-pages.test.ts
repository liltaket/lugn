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

const focus: { active: FakeElement | null } = { active: null };

class FakeElement extends Target {
  blurred = 0;
  focus(): void {
    focus.active = this;
  }
  blur(): void {
    this.blurred += 1;
    if (focus.active === this) focus.active = null;
  }
  closest(selector: string): FakeElement | null {
    if (selector !== '.hub-page') return null;
    if (this.classes.has('hub-page')) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
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
  focus.active = null;
  Object.defineProperty(document, 'activeElement', {
    get: () => focus.active,
  });
  document['body'] = new FakeElement('BODY');
  const window = new Target() as Target & Record<string, unknown>;
  const resize = (width: number) => {
    window['innerWidth'] = width;
    window.fire(new FakeEvent('resize'));
  };
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let timerId = 0;
  const frames: Array<(t: number) => void> = [];
  const idle: Array<() => void> = [];
  let settled = 0;
  const pageEvents: unknown[] = [];
  Object.assign(window, {
    innerWidth: 1000,
    dispatchEvent: (event: FakeEvent) => {
      if (event.type === 'lugn:pages-settled') settled += 1;
      if (event.type === 'lugn:page') pageEvents.push(event['detail']);
      window.fire(event);
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
    // Idle callbacks wait until the test lets the main thread go idle.
    requestIdleCallback: (fn: () => void) => idle.push(fn),
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
  const runTimers = () => {
    for (;;) {
      const due = timers
        .filter((t) => t.at <= now)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
  };
  const flushIdle = () => {
    for (const fn of idle.splice(0)) fn();
  };
  // Time passes and the main thread goes idle (unless `busy`).
  const advance = (ms: number, { busy = false } = {}) => {
    now += ms;
    runTimers();
    for (const fn of frames.splice(0)) fn(now);
    if (!busy) flushIdle();
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
    flushIdle,
    api,
    pager,
    wheel,
    resize,
    settledEvents: () => settled,
    window,
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
    // Only pages out of reach are inert; a neighbour is only aria-hidden.
    expect(pages.map(({ page }) => page.inert)).toEqual([false, false, true]);
    expect(pages[1]?.page.attributes.get('aria-hidden')).toBe('true');
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
    // A vertical move scrolls the page (not prevented) and turns nothing;
    // having moved past a tap's wobble, it is not a tap either.
    pointer('pointerdown', pages[0]!.button, 500, 300);
    const move = pointer('pointermove', pages[0]!.button, 508, 340);
    pointer('pointerup', pages[0]!.button, 508, 340);
    expect(move.defaultPrevented).toBe(false);
    expect(click(pages[0]!.button).defaultPrevented).toBe(true);
    expect(api.current()).toBe('home');
    expect(track.animations).toHaveLength(0);
  });

  it('swallows the click of a diagonal bridge drag', () => {
    // 8 px down is within a tap's wobble; the release 60 px left at once is
    // a fast swipe: the click is swallowed (the page may turn).
    const quick = setup();
    quick.pointer('pointerdown', quick.pages[0]!.button, 260, 550, 'mouse');
    quick.pointer('pointermove', quick.pages[0]!.button, 260, 558, 'mouse');
    quick.pointer('pointerup', quick.pages[0]!.button, 200, 558, 'mouse');
    expect(quick.click(quick.pages[0]!.button).defaultPrevented).toBe(true);

    // 12 px down locks the press as vertical: no turn, and no click either.
    const vertical = setup();
    vertical.pointer(
      'pointerdown',
      vertical.pages[0]!.button,
      260,
      540,
      'mouse',
    );
    vertical.pointer(
      'pointermove',
      vertical.pages[0]!.button,
      260,
      552,
      'mouse',
    );
    vertical.pointer('pointerup', vertical.pages[0]!.button, 200, 552, 'mouse');
    expect(vertical.click(vertical.pages[0]!.button).defaultPrevented).toBe(
      true,
    );
    expect(vertical.api.current()).toBe('home');
  });

  it('still clicks a press that wobbles less than a tap allows', () => {
    const { pages, pointer, click } = setup();
    pointer('pointerdown', pages[0]!.button, 260, 550, 'mouse');
    pointer('pointermove', pages[0]!.button, 262, 558, 'mouse');
    pointer('pointerup', pages[0]!.button, 263, 558, 'mouse');
    expect(click(pages[0]!.button).defaultPrevented).toBe(false);
  });

  it('still clicks a press that wobbles 8 px sideways', () => {
    const { pages, pointer, click, track } = setup();
    pointer('pointerdown', pages[0]!.button, 260, 550, 'mouse');
    pointer('pointermove', pages[0]!.button, 268, 550, 'mouse');
    pointer('pointerup', pages[0]!.button, 268, 550, 'mouse');
    expect(click(pages[0]!.button).defaultPrevented).toBe(false);
    expect(track.animations).toHaveLength(0);
  });

  it('flicks with a real move that arrives only with the release after a pause', () => {
    const { api, pages, pointer, advance } = setup();
    pointer('pointerdown', pages[0]!.button, 800, 350, 'mouse');
    advance(16);
    pointer('pointermove', pages[0]!.button, 760, 350, 'mouse');
    advance(75);
    pointer('pointerup', pages[0]!.button, 660, 350, 'mouse');
    expect(api.current()).toBe('clock');
  });

  it('lets a horizontal wheel page while a press is held vertically', () => {
    const { api, pages, pointer, wheel, advance, click } = setup();
    pointer('pointerdown', pages[0]!.button, 500, 300, 'mouse');
    pointer('pointermove', pages[0]!.button, 500, 330, 'mouse');
    wheel(pages[0]!.button, 250);
    advance(200);
    expect(api.current()).toBe('clock');
    pointer('pointerup', pages[0]!.button, 500, 330, 'mouse');
    expect(click(pages[0]!.button).defaultPrevented).toBe(true);
  });

  it('does not revive a flick with a last pixel after a pause', () => {
    const { api, pages, pointer, advance } = setup();
    pointer('pointerdown', pages[0]!.button, 700, 300, 'mouse');
    advance(16);
    pointer('pointermove', pages[0]!.button, 640, 300, 'mouse');
    advance(70);
    pointer('pointerup', pages[0]!.button, 639, 300, 'mouse');
    expect(api.current()).toBe('home');
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
    advance(100);
    advance(500);
    expect(api.current()).toBe('clock');
    expect(pages.map(({ page }) => page.dataset['state'])).toEqual([
      'near',
      'active',
      'near',
    ]);
    expect(pages[0]!.page.inert).toBe(false);
    expect(pages[0]!.page.attributes.get('aria-hidden')).toBe('true');
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

  it('still swallows the click of a swipe held through a resize', () => {
    const { api, pages, pointer, click, resize, advance } = setup();
    pointer('pointerdown', pages[0]!.button, 700, 300, 'mouse');
    advance(16);
    pointer('pointermove', pages[0]!.button, 640, 300, 'mouse');
    resize(1000 - 24);
    advance(16);
    pointer('pointermove', pages[0]!.button, 300, 300, 'mouse');
    pointer('pointerup', pages[0]!.button, 300, 300, 'mouse');
    expect(click(pages[0]!.button).defaultPrevented).toBe(true);
    expect(api.current()).toBe('home');
  });

  it('tells a swipe from a tap after a resize before the first move', () => {
    const swipe = setup();
    swipe.pointer('pointerdown', swipe.pages[0]!.button, 700, 300, 'mouse');
    swipe.resize(976);
    swipe.pointer('pointerup', swipe.pages[0]!.button, 640, 300, 'mouse');
    expect(swipe.click(swipe.pages[0]!.button).defaultPrevented).toBe(true);
    expect(swipe.api.current()).toBe('home');

    const tap = setup();
    tap.pointer('pointerdown', tap.pages[0]!.button, 700, 300, 'mouse');
    tap.resize(976);
    tap.pointer('pointerup', tap.pages[0]!.button, 702, 300, 'mouse');
    expect(tap.click(tap.pages[0]!.button).defaultPrevented).toBe(false);
  });

  it('swallows the click of a swipe that moved vertically first after a resize', () => {
    const { api, pages, pointer, click, resize } = setup();
    pointer('pointerdown', pages[0]!.button, 700, 300, 'mouse');
    resize(952);
    pointer('pointermove', pages[0]!.button, 700, 308, 'mouse');
    pointer('pointerup', pages[0]!.button, 640, 308, 'mouse');
    expect(click(pages[0]!.button).defaultPrevented).toBe(true);
    expect(api.current()).toBe('home');
  });

  it('turns on a quick flick that adds a pixel on release', () => {
    const { api, pages, pointer, advance } = setup();
    pointer('pointerdown', pages[0]!.button, 700, 300, 'mouse');
    advance(25);
    pointer('pointermove', pages[0]!.button, 640, 300, 'mouse');
    advance(16);
    pointer('pointerup', pages[0]!.button, 639, 300, 'mouse');
    expect(api.current()).toBe('clock');
  });

  it('keeps hover hidden while a change listener starts another motion', () => {
    const { api, pager, wheel, pages, advance } = setup();
    api.onChange((page) => {
      if (page === 'clock') api.go('info');
    });
    wheel(pages[0]!.button, 1000);
    advance(200);
    expect(api.current()).toBe('info');
    expect(pager.classes.has('paging')).toBe(true);
  });

  it('lowers the layer after a swipe held through a resize is released', () => {
    const { pages, pager, pointer, resize, advance } = setup();
    pointer('pointerdown', pages[0]!.button, 700, 300, 'mouse');
    advance(16);
    pointer('pointermove', pages[0]!.button, 600, 300, 'mouse');
    resize(976);
    advance(100);
    advance(550);
    pointer('pointerup', pages[0]!.button, 600, 300, 'mouse');
    advance(100);
    advance(500);
    expect(pager.classes.has('moving')).toBe(false);
  });

  it('does not fling one move after a long press and a hold', () => {
    const { api, pages, pointer, advance } = setup();
    pointer('pointerdown', pages[0]!.button, 700, 300, 'mouse');
    advance(400);
    pointer('pointermove', pages[0]!.button, 536, 300, 'mouse');
    advance(300);
    pointer('pointerup', pages[0]!.button, 536, 300, 'mouse');
    expect(api.current()).toBe('home');
  });

  it('tells changes in order when a settled listener goes on', () => {
    const { api, window: win, wheel, pages, advance } = setup();
    const seen: string[] = [];
    api.onChange((page, previous) => seen.push(`${previous}>${page}`));
    win.addEventListener('lugn:pages-settled', () => {
      if (api.current() === 'clock') api.go('info');
    });
    // Exactly one page of wheel: the turn needs no animation.
    wheel(pages[0]!.button, 1000);
    advance(200);
    expect(seen).toEqual(['home>clock', 'clock>info']);
  });

  it('turns no page when a dialog opens during a wheel gesture', () => {
    const { api, pages, pager, wheel, advance } = setup();
    wheel(pages[0]!.button, 400);
    pager.modal = new FakeElement();
    advance(200);
    expect(api.current()).toBe('home');
  });

  it('does not fling a release after the pointer was held still', () => {
    const { api, pages, pointer, advance } = setup();
    pointer('pointerdown', pages[0]!.button, 700);
    for (let x = 680; x >= 450; x -= 23) {
      advance(16);
      pointer('pointermove', pages[0]!.button, x);
    }
    advance(65);
    pointer('pointerup', pages[0]!.button, 450);
    expect(api.current()).toBe('home');
  });

  it('swallows only a click in the same task as the swipe release', () => {
    const { pages, drag, click, advance } = setup();
    drag(pages[0]!.button, 800, 200);
    advance(0);
    expect(click(pages[1]!.button).defaultPrevented).toBe(false);
  });

  it('tells every listener about each change in order when one goes on', () => {
    const { api } = setup();
    const seen: string[] = [];
    api.onChange((page) => {
      if (page === 'clock') api.go('info');
    });
    api.onChange((page, previous) => seen.push(`${previous}>${page}`));
    api.go('clock');
    expect(seen).toEqual(['home>clock', 'clock>info']);
  });

  it('leaves the page states alone when a swipe starts before the idle time', () => {
    const { pages, drag, pointer, advance, flushIdle, finishAnimations } =
      setup();
    drag(pages[0]!.button, 800, 200);
    finishAnimations();
    // The settle's tidy-up is queued, but the main thread is not idle yet…
    advance(100, { busy: true });
    // …when the next swipe starts (which itself readies the page beyond).
    pointer('pointerdown', pages[1]!.button, 800);
    advance(16, { busy: true });
    pointer('pointermove', pages[1]!.button, 700);
    const during = pages.map(({ page }) => [page.dataset['state'], page.inert]);
    flushIdle();
    // The late tidy-up changes nothing mid-drag: Hem is not made a
    // neighbour (inert, hidden from assistive tech) under the finger.
    expect(
      pages.map(({ page }) => [page.dataset['state'], page.inert]),
    ).toEqual(during);
    expect(pages[0]!.page.dataset['state']).toBe('active');
    pointer('pointerup', pages[1]!.button, 700);
  });

  it('enters and leaves a page once the motion has ended', () => {
    const { api, pages, drag, finishAnimations } = setup();
    const calls: string[] = [];
    const define = (
      api as unknown as {
        define(id: string, hooks: Record<string, () => void>): void;
      }
    ).define;
    define('clock', {
      enter: () => calls.push('clock.enter'),
      leave: () => calls.push('clock.leave'),
    });
    define('info', {
      enter: () => calls.push('info.enter'),
      leave: () => calls.push('info.leave'),
    });
    drag(pages[0]!.button, 800, 200);
    expect(api.current()).toBe('clock');
    // Released, but still moving: the page has not started its work.
    expect(calls).toEqual([]);
    finishAnimations();
    expect(calls).toEqual(['clock.enter']);
    drag(pages[1]!.button, 800, 200);
    finishAnimations();
    expect(calls).toEqual(['clock.enter', 'clock.leave', 'info.enter']);
  });

  it('lets go of focus left on the page a swipe leaves', () => {
    const { pages, drag, finishAnimations } = setup();
    pages[0]!.button.focus();
    drag(pages[0]!.button, 800, 200);
    expect(pages[0]!.button.blurred).toBe(0);
    finishAnimations();
    expect(pages[0]!.button.blurred).toBe(1);
  });

  it('sends back focus that lands on a neighbour, not on the current page', () => {
    const { pages, pager } = setup();
    const focusin = (target: FakeElement) =>
      pager.fire(new FakeEvent('focusin', { target }));
    focusin(pages[0]!.button);
    expect(pages[0]!.button.blurred).toBe(0);
    focusin(pages[1]!.button);
    expect(pages[1]!.button.blurred).toBe(1);
  });

  it('toggles inert only for pages going out of or into reach', () => {
    const { api, pages, advance, finishAnimations } = setup(4);
    const inert = () => pages.map(({ page }) => page.inert);
    expect(inert()).toEqual([false, false, true, true]);
    api.go('four');
    finishAnimations();
    advance(1_000);
    // Jumped: Hem and Klocka are now out of reach, Info is the neighbour.
    expect(inert()).toEqual([true, true, false, false]);
  });

  it('enters only the final page when a settle is caught and dragged back', () => {
    const { api, pages, drag, pointer, advance, track, finishAnimations } =
      setup();
    const calls: string[] = [];
    (
      api as unknown as {
        define(id: string, hooks: Record<string, () => void>): void;
      }
    ).define('clock', {
      enter: () => calls.push('clock.enter'),
      leave: () => calls.push('clock.leave'),
    });
    drag(pages[0]!.button, 800, 200);
    track.animations.at(-1)!.animation.currentTime = 50;
    // Caught mid-settle and taken back to Hem.
    pointer('pointerdown', pages[1]!.button, 300);
    for (let x = 340; x <= 900; x += 40) {
      advance(16);
      pointer('pointermove', pages[1]!.button, x);
    }
    pointer('pointerup', pages[1]!.button, 900);
    finishAnimations();
    expect(api.current()).toBe('home');
    expect(calls).toEqual([]);
  });

  it('enters the page a change listener goes on to, once', () => {
    const { api, finishAnimations } = setup();
    const calls: string[] = [];
    const define = (
      api as unknown as {
        define(id: string, hooks: Record<string, () => void>): void;
      }
    ).define;
    define('clock', { enter: () => calls.push('clock.enter') });
    define('info', { enter: () => calls.push('info.enter') });
    api.onChange((page) => {
      if (page === 'clock') api.go('info');
    });
    api.go('clock');
    finishAnimations();
    expect(calls).toEqual(['info.enter']);
  });

  it('keeps a neighbour drawn in idle time, not when a press starts', () => {
    const { api, pages, pointer, advance } = setup();
    let prepared = 0;
    (
      api as unknown as {
        define(id: string, hooks: Record<string, () => void>): void;
      }
    ).define('clock', { prepare: () => (prepared += 1) });
    expect(prepared).toBe(1);
    // The press that may start a swipe does no page work.
    pointer('pointerdown', pages[0]!.button, 500);
    pointer('pointerup', pages[0]!.button, 500);
    expect(prepared).toBe(1);
    // Soon after load, and then every few seconds while nothing moves.
    advance(1_500);
    expect(prepared).toBe(2);
    advance(2_000);
    expect(prepared).toBe(3);
    // Not while a swipe is under way.
    pointer('pointerdown', pages[0]!.button, 800);
    advance(16);
    pointer('pointermove', pages[0]!.button, 700);
    advance(2_000);
    expect(prepared).toBe(3);
    pointer('pointerup', pages[0]!.button, 700);
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

describe('Hub page markup', () => {
  const html = readFileSync(
    new URL('../src/ui/display.html', import.meta.url),
    'utf8',
  );
  it('has one dot per page, Hem first, Musik next and Inställningar last', () => {
    const pages = [
      ...html.matchAll(/class="hub-page" data-page="([a-z]+)"/g),
    ].map((match) => match[1]);
    // The conditional pages (greeting, computer) are in the pager only when
    // Hub rules let them in; the usual pages keep their order.
    expect(
      pages.filter((page) => !['halsning', 'dator'].includes(page!)),
    ).toEqual([
      'home',
      'music',
      'foto',
      'kameror',
      'clock',
      'info',
      'installningar',
    ]);
    expect(pages[0]).toBe('home');
    expect(pages.at(-1)).toBe('installningar');
    expect(html).toMatch(/data-page="halsning" data-conditional/);
    expect(html).toMatch(/data-page="dator" data-conditional/);
    const dots = /<div class="hub-dots"[^>]*>(.*?)<\/div>/.exec(html)?.[1];
    expect(dots?.match(/<i><\/i>/g)).toHaveLength(pages.length);
  });
});

describe('Hub pager: pages taken out by Hub rules', () => {
  type Rules = {
    setAvailable(ids: string[] | null): boolean;
    ids(): string[];
    all(): string[];
  };
  const rules = (api: unknown) => api as Rules;
  // setup() names its pages home, clock, info, four.

  it('closes up around a page that is left out and skips it', () => {
    const { api, pages, dots } = setup(4);
    expect(rules(api).setAvailable(['home', 'info', 'four'])).toBe(true);
    expect(rules(api).ids()).toEqual(['home', 'info', 'four']);
    // Every page is still known, for those that ask why one is missing.
    expect(rules(api).all()).toEqual(['home', 'clock', 'info', 'four']);
    expect(pages.map(({ page }) => page.style['display'])).toEqual([
      '',
      'none',
      '',
      '',
    ]);
    expect(
      pages.map(({ page }) => page.style['left']).filter((x) => x),
    ).toContain('200%');
    expect(pages[2]?.page.style['left']).toBe('100%');
    expect(pages[3]?.page.style['left']).toBe('200%');
    expect(pages[1]?.page.inert).toBe(true);
    // One dot for each page that remains.
    expect(dots.children.map((dot) => dot.style['display'])).toEqual([
      '',
      '',
      '',
      'none',
    ]);
    expect(api.go('clock')).toBe(false);
    expect(api.go('info')).toBe(true);
  });

  it('moves to the first page that is left when the one on screen goes', () => {
    const { api, advance, finishAnimations } = setup(4);
    const seen: string[] = [];
    api.onChange((page, previous) => seen.push(`${previous}>${page}`));
    api.go('info');
    advance(20);
    finishAnimations();
    advance(400);
    expect(api.current()).toBe('info');
    seen.length = 0;
    expect(rules(api).setAvailable(['home', 'four'])).toBe(true);
    expect(api.current()).toBe('home');
    expect(seen).toEqual(['info>home']);
  });

  it('keeps the page on screen when the list changes around it', () => {
    const { api, advance, finishAnimations } = setup(4);
    api.go('info');
    advance(20);
    finishAnimations();
    advance(400);
    expect(rules(api).setAvailable(['info', 'four'])).toBe(true);
    expect(api.current()).toBe('info');
    expect(rules(api).ids()).toEqual(['info', 'four']);
  });

  it('brings every page back, and never leaves none', () => {
    const { api, pages } = setup(4);
    rules(api).setAvailable(['home']);
    expect(rules(api).ids()).toEqual(['home']);
    expect(rules(api).setAvailable(null)).toBe(true);
    expect(rules(api).ids()).toEqual(['home', 'clock', 'info', 'four']);
    expect(rules(api).setAvailable([])).toBe(true);
    expect(rules(api).ids()).toHaveLength(4);
    expect(pages.every(({ page }) => page.style['display'] === '')).toBe(true);
  });

  it('does not rearrange the pages under a finger', () => {
    const { api, pages, pointer, advance } = setup(4);
    pointer('pointerdown', pages[0]!.button, 600);
    advance(16);
    pointer('pointermove', pages[0]!.button, 500);
    expect(rules(api).setAvailable(['home', 'four'])).toBe(false);
    expect(rules(api).ids()).toHaveLength(4);
    pointer('pointerup', pages[0]!.button, 500);
    advance(50);
    expect(rules(api).setAvailable(['home', 'four'])).toBe(true);
  });
});
