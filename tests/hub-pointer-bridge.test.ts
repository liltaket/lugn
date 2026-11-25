import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync(
  new URL('../src/ui/pointer-bridge.js', import.meta.url),
  'utf8',
);

type Listener = (event: FakeEvent) => void;

class FakeEvent {
  type: string;
  target: FakeElement | FakeDocument | undefined;
  defaultPrevented = false;
  bubbles = false;
  cancelable = false;
  [key: string]: unknown;
  constructor(type: string, init: Record<string, unknown> = {}) {
    Object.assign(this, init);
    this.type = type;
  }
  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }
}
class FakeMouseEvent extends FakeEvent {}
class FakePointerEvent extends FakeMouseEvent {}
class FakeWheelEvent extends FakeMouseEvent {}
class FakeKeyboardEvent extends FakeEvent {}

class Listeners {
  listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(event: FakeEvent): void {
    for (const listener of this.listeners.get(event.type) ?? [])
      listener(event);
  }
}

class FakeElement extends Listeners {
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  style: Record<string, string> = {};
  disabled = false;
  /** A label's labelled control. */
  control: FakeElement | null = null;
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 0;
  clientHeight = 0;
  scrollWidth = 0;
  clientWidth = 0;
  computed: Record<string, string> = {
    overflowX: 'visible',
    overflowY: 'visible',
    borderTopLeftRadius: '0px',
  };
  rect = { left: 0, top: 0, width: 0, height: 0 };
  animations: Array<{
    keyframes: Array<Record<string, string>>;
    options: Record<string, unknown>;
  }> = [];
  constructor(
    readonly document: FakeDocument,
    readonly tagName: string,
  ) {
    super();
  }
  /** This element, then each ancestor up to the root. */
  *path(): Generator<FakeElement> {
    yield this;
    for (let node = this.parentElement; node; node = node.parentElement)
      yield node;
  }
  get isConnected(): boolean {
    return [...this.path()].at(-1) === this.document.documentElement;
  }
  attributeWrites = 0;
  setAttribute(name: string, value: string): void {
    this.attributeWrites += 1;
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributeWrites += 1;
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  getBoundingClientRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    return { ...this.rect };
  }
  animate(
    keyframes: Array<Record<string, string>>,
    options: Record<string, unknown>,
  ): void {
    this.animations.push({ keyframes, options });
  }
  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      const trimmed = part.trim();
      const attribute = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(trimmed);
      if (attribute)
        return attribute[2] === undefined
          ? this.attributes.has(attribute[1]!)
          : this.attributes.get(attribute[1]!) === attribute[2];
      return trimmed === this.tagName;
    });
  }
  closest(selector: string): FakeElement | null {
    for (const node of this.path()) if (node.matches(selector)) return node;
    return null;
  }
  focus(): void {
    this.document.activeElement = this;
  }
  dispatchEvent(event: FakeEvent): boolean {
    event.target = this;
    this.document.log.push({ type: event.type, target: this, event });
    for (const node of this.path()) {
      node.fire(event);
      if (!event.bubbles) return !event.defaultPrevented;
    }
    this.document.fire(event);
    return !event.defaultPrevented;
  }
}

class FakeDocument extends Listeners {
  log: Array<{ type: string; target: FakeElement; event: FakeEvent }> = [];
  documentElement: FakeElement;
  body: FakeElement;
  activeElement: FakeElement | null = null;
  hit: FakeElement | null = null;
  constructor() {
    super();
    this.documentElement = new FakeElement(this, 'html');
    this.body = this.documentElement.appendChild(new FakeElement(this, 'body'));
    this.activeElement = this.body;
  }
  created = 0;
  createElementNS(_ns: string, tag: string): FakeElement {
    this.created += 1;
    return new FakeElement(this, tag);
  }
  createElement(tag: string): FakeElement {
    this.created += 1;
    return new FakeElement(this, tag);
  }
  elementFromPoint(): FakeElement | null {
    return this.hit;
  }
  ids = new Map<string, FakeElement>();
  getElementById(id: string): FakeElement | null {
    return this.ids.get(id) ?? null;
  }
  element(tag: string, parent: FakeElement = this.body): FakeElement {
    return parent.appendChild(new FakeElement(this, tag));
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

type Timer = {
  id: number;
  delay: number;
  due: number;
  callback: () => void;
  cleared: boolean;
};

async function load(status = 200, pointerEvents = true) {
  const document = new FakeDocument();
  const frames: Array<() => void> = [];
  const timers: Timer[] = [];
  const fetches: string[] = [];
  const windowListeners = new Listeners();
  const sockets: FakeWebSocket[] = [];
  const windowEvents: string[] = [];
  const clock = { now: 1000 };
  const observers: Array<
    (list: { getEntries: () => Array<Record<string, number>> }) => void
  > = [];
  const hitTimes: number[] = [];
  const elementFromPoint = document.elementFromPoint.bind(document);
  document.elementFromPoint = () => {
    hitTimes.push(clock.now);
    return elementFromPoint();
  };
  class Socket extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  class Observer {
    constructor(
      callback: (list: {
        getEntries: () => Array<Record<string, number>>;
      }) => void,
    ) {
      observers.push(callback);
    }
    observe(options: { entryTypes: string[] }): void {
      if (!options.entryTypes.includes('longtask'))
        throw new Error('unexpected entry types');
    }
  }
  const context = createContext({
    console: { debug: () => undefined },
    document,
    location: { pathname: `/k/${'d'.repeat(32)}/` },
    fetch: async (url: string) => {
      fetches.push(url);
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () =>
          status === 200
            ? { url: 'ws://192.168.10.20:8791/hub-pointer', token: 'a b&c' }
            : { error: 'pointer_bridge_not_configured' },
      };
    },
    performance: { now: () => clock.now },
    PerformanceObserver: Observer,
    WebSocket: Socket,
    MouseEvent: FakeMouseEvent,
    Event: FakeEvent,
    dispatchEvent: (event: FakeEvent) => {
      windowEvents.push(event.type);
      return true;
    },
    ...(pointerEvents ? { PointerEvent: FakePointerEvent } : {}),
    WheelEvent: FakeWheelEvent,
    KeyboardEvent: FakeKeyboardEvent,
    requestAnimationFrame: (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    },
    setTimeout: (callback: () => void, delay: number) => {
      const timer = {
        id: timers.length + 1,
        delay,
        due: clock.now + delay,
        callback,
        cleared: false,
      };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout: (id: number) => {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    },
    getComputedStyle: (element: FakeElement) => element.computed,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    addEventListener: (type: string, listener: Listener) =>
      windowListeners.addEventListener(type, listener),
  });
  context['window'] = context;
  runInContext(script, context);
  await settle();
  const runFrames = () => {
    for (const frame of frames.splice(0)) frame();
  };
  /** Moves the clock forward, firing due timers in order. */
  const advance = (ms: number) => {
    const end = clock.now + ms;
    for (;;) {
      const next = timers
        .filter((timer) => !timer.cleared && timer.due <= end)
        .sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      clock.now = Math.max(clock.now, next.due);
      next.cleared = true;
      next.callback();
    }
    clock.now = end;
  };
  const pending = () => timers.filter((timer) => !timer.cleared);
  const layer = (role: string) =>
    document.body.children.find(
      (child) => child.attributes.get('data-hub-pointer') === role,
    );
  const cursor = () => layer('dot');
  const plates = () =>
    document.body.children.filter(
      (child) => child.attributes.get('data-hub-pointer') === 'plate',
    );
  /** Plates currently faded in. */
  const shown = () =>
    plates().filter((plate) => plate.style['opacity'] === '1');
  return {
    document,
    windowEvents,
    frames,
    timers,
    pending,
    fetches,
    sockets,
    context,
    clock,
    observers,
    hitTests: () => hitTimes.length,
    hitTimes,
    windowListeners,
    runFrames,
    advance,
    cursor,
    plates,
    shown,
  };
}

async function connected(pointerEvents = true) {
  const page = await load(200, pointerEvents);
  const socket = page.sockets[0]!;
  socket.open();
  return { ...page, socket };
}

describe('Hub pointer bridge page script', () => {
  it('does nothing when the bridge is not configured for this Hub', async () => {
    const page = await load(404);
    expect(page.fetches).toEqual([
      `/k/${'d'.repeat(32)}/display-api/pointer-bridge`,
    ]);
    expect(page.sockets).toHaveLength(0);
    expect(page.timers).toHaveLength(0);
    expect(page.frames).toHaveLength(0);
    expect(page.document.body.children).toHaveLength(0);
  });

  it('connects with the encoded token, says hello on open and resize, and answers ping', async () => {
    const { socket, windowListeners, context } = await connected();
    expect(socket.url).toBe(
      'ws://192.168.10.20:8791/hub-pointer?token=a%20b%26c',
    );
    expect(socket.sent).toEqual([{ t: 'hello', v: 2, w: 1280, h: 800 }]);
    context['innerWidth'] = 900;
    windowListeners.fire(new FakeEvent('resize'));
    expect(socket.sent.at(-1)).toEqual({ t: 'hello', v: 2, w: 900, h: 800 });
    socket.receive({ t: 'ping', id: 17 });
    expect(socket.sent.at(-1)).toEqual({ t: 'pong', id: 17 });
    socket.receive({ t: 'future', extra: true });
    expect(socket.sent.at(-1)).toEqual({ t: 'pong', id: 17 });
  });

  it('builds the hidden dot and plates as soon as the bridge is configured', async () => {
    const page = await load();
    const cursor = page.cursor()!;
    const plates = page.plates();
    expect(page.sockets[0]!.readyState).toBe(0);
    // Two plates under the dot, all outside the dashboard.
    expect(plates).toHaveLength(2);
    expect(page.document.body.children).toEqual([...plates, cursor]);
    for (const layer of [cursor, ...plates])
      expect(layer.style).toMatchObject({
        visibility: 'hidden',
        display: 'block',
        position: 'fixed',
        pointerEvents: 'none',
      });
    expect(cursor.style).toMatchObject({
      transform: 'translate3d(-100px, -100px, 0)',
      zIndex: '2147483647',
      contain: 'strict',
      willChange: 'transform',
      transition: 'none',
      width: '30px',
      height: '30px',
    });
    const dot = cursor.children[0]!;
    expect(dot.style).toMatchObject({
      width: '20px',
      height: '20px',
      borderRadius: '50%',
      background: 'rgba(236, 240, 232, 0.55)',
      border: '1px solid rgba(12, 18, 16, 0.32)',
      boxShadow: '0 1px 4px rgba(0, 0, 0, 0.24)',
    });
    // The dot never eases, shrinks or fades.
    expect(dot.style['transition']).toBeUndefined();
    expect(dot.style['transform']).toBeUndefined();
    expect(dot.style['opacity']).toBeUndefined();
    for (const plate of plates) {
      expect(plate.style).toMatchObject({
        zIndex: '2147483646',
        opacity: '0',
        willChange: 'opacity',
        transition: 'opacity 110ms ease-out',
      });
      // A plate never moves.
      expect(plate.style['transform']).toBeUndefined();
    }
    for (const layer of [cursor, dot, ...plates]) {
      expect(layer.style['filter']).toBeUndefined();
      expect(layer.style['backdropFilter']).toBeUndefined();
    }
  });

  it('centres the dot on the hotspot', async () => {
    const page = await connected();
    page.socket.receive({ t: 'enter', x: 100, y: 50 });
    page.runFrames();
    const cursor = page.cursor()!;
    const dot = cursor.children[0]!;
    const box = Number.parseFloat(cursor.style['width']!);
    const offset = Number.parseFloat(dot.style['left']!);
    const size = Number.parseFloat(dot.style['width']!);
    expect(offset + size / 2).toBe(box / 2);
    expect(Number.parseFloat(dot.style['top']!) + size / 2).toBe(box / 2);
    expect(cursor.style['transform']).toBe('translate3d(85px, 35px, 0)');
  });

  it('shows the cursor by flipping visibility only, at the latest point once per frame', async () => {
    const page = await connected();
    const button = page.document.element('button');
    page.document.hit = button;
    const created = page.document.created;
    const children = page.document.body.children.length;
    page.socket.receive({ t: 'enter', x: 1279, y: 400 });
    const cursor = page.cursor()!;
    expect(cursor.style['visibility']).toBe('visible');
    expect(page.document.created).toBe(created);
    expect(page.document.body.children).toHaveLength(children);
    expect(page.hitTests()).toBe(0);

    page.socket.receive({ t: 'move', x: 1200, y: 410 });
    page.socket.receive({ t: 'move', x: 1100.5, y: 420 });
    expect(page.frames).toHaveLength(1);
    const before = { ...cursor.style };
    page.runFrames();
    const changed = Object.keys(cursor.style).filter(
      (key) => cursor.style[key] !== before[key],
    );
    expect(changed).toEqual(['transform']);
    expect(cursor.style['transform']).toBe('translate3d(1086px, 405px, 0)');
    // No hit test or hover write inside the frame.
    expect(page.hitTests()).toBe(0);
    expect(button.hasAttribute('data-pointer-hover')).toBe(false);

    page.advance(30);
    expect(page.hitTests()).toBe(1);
    expect(button.hasAttribute('data-pointer-hover')).toBe(true);

    page.socket.receive({ t: 'leave' });
    expect(cursor.style['visibility']).toBe('hidden');
    expect(cursor.style['transform']).toBe('translate3d(-100px, -100px, 0)');
    expect(button.hasAttribute('data-pointer-hover')).toBe(false);
    expect(page.cursor()).toBe(cursor);
  });

  it('tells the window about mouse movement, rarely and only when the dot moved', async () => {
    const page = await connected();
    const moves = () =>
      page.windowEvents.filter((type) => type === 'lugn:pointer-move').length;
    page.socket.receive({ t: 'enter', x: 100, y: 100 });
    page.runFrames();
    const afterEnter = moves();
    // Standing still tells nothing, however many frames pass.
    for (let index = 0; index < 20; index += 1) {
      page.advance(16);
      page.runFrames();
    }
    expect(moves()).toBe(afterEnter);
    // A move is told, and a burst of moves is told at most every 150 ms.
    page.advance(500);
    for (let x = 140; x <= 400; x += 20) {
      page.socket.receive({ t: 'move', x, y: 100 });
      page.advance(16);
      page.runFrames();
    }
    const burst = moves() - afterEnter;
    expect(burst).toBeGreaterThanOrEqual(1);
    expect(burst).toBeLessThanOrEqual(3);
    // A move below 2 px is not told.
    page.advance(1000);
    for (let index = 0; index < 40; index += 1) {
      page.advance(16);
      page.runFrames();
    }
    const settled = moves();
    page.socket.receive({ t: 'move', x: 400.4, y: 100 });
    page.advance(16);
    page.runFrames();
    expect(moves()).toBe(settled);
  });

  it('tells nothing while a button is held (a swipe, not a hover)', async () => {
    const page = await connected();
    const moves = () =>
      page.windowEvents.filter((type) => type === 'lugn:pointer-move').length;
    page.document.hit = page.document.element('button');
    page.socket.receive({ t: 'enter', x: 100, y: 100 });
    page.runFrames();
    page.advance(500);
    const before = moves();
    page.socket.receive({
      t: 'button',
      button: 'left',
      down: true,
      x: 100,
      y: 100,
    });
    for (let x = 140; x <= 500; x += 40) {
      page.socket.receive({ t: 'move', x, y: 100 });
      page.advance(200);
      page.runFrames();
    }
    expect(moves()).toBe(before);
    page.socket.receive({
      t: 'button',
      button: 'left',
      down: false,
      x: 500,
      y: 100,
    });
    page.advance(500);
    page.socket.receive({ t: 'move', x: 600, y: 100 });
    page.advance(16);
    page.runFrames();
    expect(moves()).toBeGreaterThan(before);
  });

  it('follows moves smoothly across frames and snaps after a pause or a jump', async () => {
    const page = await connected();
    page.socket.receive({ t: 'enter', x: 100, y: 100 });
    page.runFrames();
    const cursor = page.cursor()!;
    const shownX = () =>
      Number(/translate3d\((-?[\d.]+)px/.exec(cursor.style['transform']!)![1]) +
      15;
    expect(shownX()).toBeCloseTo(100, 0);
    // A new position a frame later is approached, not jumped to.
    page.advance(16);
    page.socket.receive({ t: 'move', x: 200, y: 100 });
    page.runFrames();
    const first = shownX();
    expect(first).toBeGreaterThan(100);
    expect(first).toBeLessThan(200);
    // The dot keeps moving without another move and arrives exactly.
    let last = first;
    for (let index = 0; index < 40; index += 1) {
      page.advance(16);
      page.runFrames();
      expect(shownX()).toBeGreaterThanOrEqual(last);
      last = shownX();
    }
    expect(last).toBe(200);
    // After a pause the next position is taken at once, and so is a jump.
    page.advance(500);
    page.socket.receive({ t: 'move', x: 260, y: 100 });
    page.runFrames();
    expect(shownX()).toBe(260);
    page.advance(16);
    page.socket.receive({ t: 'move', x: 900, y: 100 });
    page.runFrames();
    expect(shownX()).toBe(900);
    // The distance counts, not each axis: 300 px across and 300 px down is
    // about 424 px.
    page.advance(16);
    page.socket.receive({ t: 'move', x: 600, y: 400 });
    page.runFrames();
    expect(shownX()).toBe(600);
    // Once the dot has arrived no frame is left queued.
    page.advance(300);
    page.runFrames();
    expect(page.frames).toHaveLength(0);
  });

  it('rounds the cursor to device pixels', async () => {
    const page = await load();
    page.context['devicePixelRatio'] = 2;
    page.sockets[0]!.open();
    page.sockets[0]!.receive({ t: 'enter', x: 10.3, y: 20.8 });
    page.runFrames();
    expect(page.cursor()!.style['transform']).toBe(
      'translate3d(-4.5px, 6px, 0)',
    );
  });

  it('hit tests for hover at most every 40 ms while moving and once after it settles', async () => {
    const page = await connected();
    const first = page.document.element('button');
    const second = page.document.element('button');
    page.document.hit = first;
    page.socket.receive({ t: 'enter', x: 0, y: 0 });
    page.runFrames();
    // 200 moves 8 ms apart, the second half over another button.
    for (let index = 1; index <= 200; index += 1) {
      page.advance(8);
      if (index === 100) page.document.hit = second;
      page.socket.receive({ t: 'move', x: index, y: 10 });
      page.runFrames();
    }
    const { hitTimes } = page;
    expect(hitTimes.length).toBeGreaterThanOrEqual(20);
    expect(hitTimes.length).toBeLessThanOrEqual(Math.ceil(1600 / 40) + 1);
    for (let index = 1; index < hitTimes.length; index += 1)
      expect(hitTimes[index]! - hitTimes[index - 1]!).toBeGreaterThanOrEqual(
        40,
      );
    // Hover changes touch attributes only when the control changes.
    expect(first.attributeWrites).toBe(2);
    expect(second.attributeWrites).toBe(1);
    expect(second.hasAttribute('data-pointer-hover')).toBe(true);

    // Motion stops on a third control: hover catches up after the settle.
    const third = page.document.element('button');
    page.document.hit = third;
    page.advance(8);
    page.socket.receive({ t: 'move', x: 300, y: 10 });
    page.runFrames();
    page.advance(70);
    expect(third.hasAttribute('data-pointer-hover')).toBe(true);
    const settled = page.hitTests();
    page.advance(1000);
    page.runFrames();
    expect(page.hitTests()).toBe(settled);
    expect(page.pending().filter((timer) => timer.delay < 500)).toHaveLength(0);
  });

  it('hit tests immediately before a press', async () => {
    const page = await connected();
    const button = page.document.element('button');
    page.document.hit = button;
    page.socket.receive({ t: 'enter', x: 10, y: 10 });
    expect(page.hitTests()).toBe(0);
    page.socket.receive({
      t: 'button',
      button: 'left',
      down: true,
      x: 12,
      y: 12,
    });
    expect(page.hitTests()).toBe(1);
    expect(button.hasAttribute('data-pointer-hover')).toBe(true);
    expect(button.hasAttribute('data-pointer-pressed')).toBe(true);
    expect(page.document.log[0]).toMatchObject({
      type: 'pointerdown',
      target: button,
    });
  });

  it('runs a frame heartbeat while warm, without touching the DOM', async () => {
    const page = await connected();
    const button = page.document.element('button');
    page.document.hit = button;
    const cursor = page.cursor()!;
    const style = { ...cursor.style };
    page.socket.receive({ t: 'warm', on: true });
    expect(page.hitTests()).toBe(1);
    expect(button.attributeWrites).toBe(0);
    expect(page.frames).toHaveLength(1);
    for (let index = 0; index < 10; index += 1) {
      page.clock.now += 16;
      page.runFrames();
      expect(page.frames).toHaveLength(1);
    }
    expect(cursor.style).toEqual(style);
    page.socket.receive({ t: 'warm', on: false });
    page.clock.now += 16;
    page.runFrames();
    expect(page.frames).toHaveLength(0);

    // The heartbeat gives up after 3 s without an enter.
    page.socket.receive({ t: 'warm', on: true });
    let count = 0;
    while (page.frames.length && count < 1000) {
      page.clock.now += 16;
      page.runFrames();
      count += 1;
    }
    expect(count).toBeGreaterThanOrEqual(3000 / 16 - 1);
    expect(count).toBeLessThanOrEqual(3000 / 16 + 1);

    // Enter ends the warm heartbeat; frames then only follow motion.
    page.socket.receive({ t: 'warm', on: true });
    page.socket.receive({ t: 'enter', x: 5, y: 0 });
    count = 0;
    while (page.frames.length && count < 1000) {
      page.clock.now += 16;
      page.runFrames();
      count += 1;
    }
    expect(count).toBeLessThanOrEqual(8);
  });

  it('reports frame telemetry while shown and once after leave, and still pongs at once', async () => {
    const page = await connected();
    page.document.hit = page.document.element('div');
    page.socket.receive({ t: 'enter', x: 0, y: 0 });
    page.clock.now += 16;
    page.runFrames();
    const lagsMs = [2, 4, 6, 8, 12];
    for (const [index, lag] of lagsMs.entries()) {
      page.socket.receive({ t: 'move', x: index + 1, y: 1 });
      page.socket.receive({ t: 'move', x: index + 1.5, y: 1 });
      page.clock.now += lag;
      page.runFrames();
      page.clock.now += 16 - lag;
    }
    // A stalled frame.
    page.socket.receive({ t: 'move', x: 50, y: 1 });
    page.clock.now += 120;
    page.socket.receive({ t: 'ping', id: 3 });
    expect(page.socket.sent.at(-1)).toEqual({ t: 'pong', id: 3 });
    expect(page.frames).toHaveLength(1);
    page.runFrames();
    page.observers[0]!({
      getEntries: () => [{ startTime: page.clock.now - 100, duration: 80 }],
    });
    page.socket.receive({ t: 'leave' });
    const perf = page.socket.sent.at(-1)!;
    expect(perf).toEqual({
      t: 'perf',
      // Frames and lag count a visible change of the dot, which follows the
      // position instead of jumping to it.
      frames: 6,
      moves: 11,
      lagP50: 8,
      lagP95: 120,
      lagMax: 120,
      gapMax: 124,
      longTasks: 1,
      longTaskMs: 80,
      span: 216,
    });
    // Reset after sending: a second leave reports nothing new.
    page.socket.receive({ t: 'leave' });
    expect(page.socket.sent.at(-1)).toBe(perf);
  });

  it('sends perf about every 2 s while the cursor is shown', async () => {
    const page = await connected();
    page.document.hit = page.document.element('div');
    page.socket.receive({ t: 'enter', x: 0, y: 0 });
    page.runFrames();
    page.advance(2000);
    const perfs = () =>
      page.socket.sent.filter((entry) => entry['t'] === 'perf');
    expect(perfs()).toHaveLength(1);
    expect(perfs()[0]).toMatchObject({ frames: 1, moves: 0, span: 2000 });
    page.advance(2000);
    expect(perfs()).toHaveLength(2);
    expect(perfs()[1]).toMatchObject({ frames: 0, span: 2000 });
    page.socket.receive({ t: 'leave' });
    expect(perfs()).toHaveLength(3);
    page.advance(10000);
    expect(perfs()).toHaveLength(3);
  });

  it('pairs pointerdown and pointerup and clicks when released on the same control', async () => {
    const page = await connected();
    const button = page.document.element('button');
    const label = page.document.element('span', button);
    const downIds: unknown[] = [];
    const upIds: unknown[] = [];
    page.document.addEventListener('pointerdown', (event) =>
      downIds.push(event['pointerId']),
    );
    page.document.addEventListener('pointerup', (event) =>
      upIds.push(event['pointerId']),
    );
    page.document.hit = label;
    page.socket.receive({ t: 'enter', x: 1279, y: 300 });
    page.socket.receive({
      t: 'button',
      button: 'left',
      down: true,
      x: 50,
      y: 60,
    });
    expect(button.hasAttribute('data-pointer-pressed')).toBe(true);
    page.socket.receive({ t: 'move', x: 52, y: 61 });
    page.runFrames();
    page.socket.receive({
      t: 'button',
      button: 'left',
      down: false,
      x: 52,
      y: 61,
    });
    expect(button.hasAttribute('data-pointer-pressed')).toBe(false);
    expect(page.document.log.map((entry) => entry.type)).toEqual([
      'pointerdown',
      'mousedown',
      'pointermove',
      'pointerup',
      'mouseup',
      'click',
    ]);
    const down = page.document.log[0]!.event;
    expect(down).toBeInstanceOf(FakePointerEvent);
    expect(down).toMatchObject({
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: 50,
      clientY: 60,
      bubbles: true,
      cancelable: true,
    });
    expect(page.document.log.at(-1)!.event).toMatchObject({
      clientX: 52,
      clientY: 61,
      button: 0,
    });
    expect(downIds).toEqual([4242]);
    expect(upIds).toEqual([4242]);
  });

  it('keeps press and release paired with MouseEvent when PointerEvent is missing', async () => {
    const page = await connected(false);
    page.document.hit = page.document.element('button');
    page.socket.receive({ t: 'enter', x: 10, y: 10 });
    page.socket.receive({
      t: 'button',
      button: 'left',
      down: true,
      x: 10,
      y: 10,
    });
    page.socket.receive({
      t: 'button',
      button: 'left',
      down: false,
      x: 10,
      y: 10,
    });
    const pointer = page.document.log.filter((entry) =>
      entry.type.startsWith('pointer'),
    );
    expect(pointer.map((entry) => entry.type)).toEqual([
      'pointerdown',
      'pointerup',
    ]);
    for (const entry of pointer) {
      expect(entry.event).toBeInstanceOf(FakeMouseEvent);
      expect(entry.event['pointerId']).toBe(4242);
    }
    expect(page.document.log.at(-1)!.type).toBe('click');
  });

  it('does not click when released over a different control', async () => {
    const page = await connected();
    const first = page.document.element('button');
    const second = page.document.element('button');
    page.document.hit = first;
    page.socket.receive({ t: 'enter', x: 10, y: 10 });
    page.socket.receive({
      t: 'button',
      button: 'left',
      down: true,
      x: 10,
      y: 10,
    });
    page.document.hit = second;
    page.socket.receive({
      t: 'button',
      button: 'left',
      down: false,
      x: 90,
      y: 10,
    });
    const types = page.document.log.map((entry) => entry.type);
    expect(types).toContain('pointerup');
    expect(types).not.toContain('click');
  });

  it('cancels a held press on leave and on disconnect, then reconnects with backoff', async () => {
    const page = await connected();
    const button = page.document.element('button');
    const held = new Set<unknown>();
    page.document.addEventListener('pointerdown', (event) =>
      held.add(event['pointerId']),
    );
    page.document.addEventListener('pointercancel', (event) =>
      held.delete(event['pointerId']),
    );
    page.document.hit = button;
    page.socket.receive({ t: 'enter', x: 10, y: 10 });
    page.socket.receive({
      t: 'button',
      button: 'left',
      down: true,
      x: 10,
      y: 10,
    });
    expect(held.size).toBe(1);
    page.socket.receive({ t: 'leave' });
    expect(held.size).toBe(0);
    expect(button.hasAttribute('data-pointer-pressed')).toBe(false);
    expect(page.document.log.map((entry) => entry.type)).toEqual([
      'pointerdown',
      'mousedown',
      'pointercancel',
    ]);

    page.socket.receive({ t: 'enter', x: 10, y: 10 });
    page.socket.receive({
      t: 'button',
      button: 'left',
      down: true,
      x: 10,
      y: 10,
    });
    expect(held.size).toBe(1);
    const before = page.timers.length;
    const reconnects = () =>
      page.timers.slice(before).map((timer) => timer.delay);
    page.socket.close();
    expect(held.size).toBe(0);
    expect(page.cursor()!.style['visibility']).toBe('hidden');
    expect(page.pending().map((timer) => timer.delay)).toEqual([500]);
    expect(reconnects()).toEqual([500]);
    page.timers[before]!.callback();
    expect(page.sockets).toHaveLength(2);
    page.sockets[1]!.close();
    expect(reconnects()).toEqual([500, 1000]);
    page.timers[before + 1]!.callback();
    page.sockets[2]!.open();
    page.sockets[2]!.close();
    expect(reconnects()).toEqual([500, 1000, 500]);
  });

  it('turns the right button into an Escape keydown on the focused element', async () => {
    const page = await connected();
    const keys: unknown[] = [];
    page.document.addEventListener('keydown', (event) =>
      keys.push(event['key']),
    );
    page.document.hit = page.document.element('div');
    page.socket.receive({ t: 'enter', x: 10, y: 10 });
    page.socket.receive({
      t: 'button',
      button: 'right',
      down: true,
      x: 10,
      y: 10,
    });
    page.socket.receive({
      t: 'button',
      button: 'right',
      down: false,
      x: 10,
      y: 10,
    });
    page.socket.receive({
      t: 'button',
      button: 'middle',
      down: true,
      x: 10,
      y: 10,
    });
    expect(keys).toEqual(['Escape']);
    expect(page.document.log[0]!.target).toBe(page.document.body);
    expect(page.document.log[0]!.event).toBeInstanceOf(FakeKeyboardEvent);
    expect(page.document.log.map((entry) => entry.type)).toEqual(['keydown']);
  });

  it('sends the side buttons as mouse events with button 3 and 4', async () => {
    const page = await connected();
    const target = page.document.element('div');
    page.document.hit = target;
    page.socket.receive({ t: 'enter', x: 10, y: 10 });
    for (const button of ['back', 'forward'])
      for (const down of [true, false])
        page.socket.receive({ t: 'button', button, down, x: 10, y: 10 });
    expect(
      page.document.log.map((entry) => [
        entry.type,
        entry.event['button'],
        entry.target === target,
      ]),
    ).toEqual([
      ['mousedown', 3, true],
      ['mouseup', 3, true],
      ['mousedown', 4, true],
      ['mouseup', 4, true],
    ]);
  });

  it('scrolls the nearest scrollable ancestor under the cursor', async () => {
    const page = await connected();
    const outer = page.document.element('section');
    outer.computed = { overflowX: 'visible', overflowY: 'auto' };
    outer.scrollHeight = 900;
    outer.clientHeight = 300;
    const notOverflowing = page.document.element('div', outer);
    notOverflowing.computed = { overflowX: 'auto', overflowY: 'auto' };
    const text = page.document.element('p', notOverflowing);
    page.document.hit = text;
    page.socket.receive({ t: 'enter', x: 10, y: 10 });
    page.socket.receive({ t: 'wheel', dx: 0, dy: 120, x: 10, y: 10 });
    page.socket.receive({ t: 'wheel', dx: 0, dy: -20, x: 10, y: 10 });
    expect(outer.scrollTop).toBe(100);
    expect(notOverflowing.scrollTop).toBe(0);
    expect(page.document.log.map((entry) => entry.type)).toEqual([
      'wheel',
      'wheel',
    ]);
  });

  it('does not send a wheel to an element a page change made inert', async () => {
    const page = await connected();
    const before = page.document.element('p');
    const after = page.document.element('p');
    page.document.hit = before;
    page.socket.receive({ t: 'enter', x: 10, y: 10 });
    page.socket.receive({ t: 'wheel', dx: 0, dy: 10, x: 10, y: 10 });
    // The pager made the old page inert; another element is under the cursor.
    before.setAttribute('inert', '');
    page.document.hit = after;
    page.socket.receive({ t: 'wheel', dx: 0, dy: 10, x: 10, y: 10 });
    expect(page.document.log.map((entry) => entry.target)).toEqual([
      before,
      after,
    ]);
    // A page event also drops the cached element on its own.
    page.document.hit = before;
    page.windowListeners.fire(new FakeEvent('lugn:page'));
    page.document.hit = after;
    page.socket.receive({ t: 'wheel', dx: 0, dy: 10, x: 10, y: 10 });
    expect(page.document.log.at(-1)!.target).toBe(after);
  });

  describe('highlight plate', () => {
    type Page = Awaited<ReturnType<typeof connected>>;

    function control(
      page: Page,
      rect: { left: number; top: number; width: number; height: number },
      radius = '22px',
      tag = 'button',
      parent?: FakeElement,
    ): FakeElement {
      const element = page.document.element(tag, parent);
      element.rect = rect;
      element.computed = { ...element.computed, borderTopLeftRadius: radius };
      return element;
    }

    function appRoot(page: Page, zoom: string, width: number): void {
      const root = page.document.element('main');
      root.style['zoom'] = zoom;
      root.rect = { left: 0, top: 0, width, height: 600 };
      page.document.ids.set('app-root', root);
    }

    /** Moves to the point over `hit` and lets the hover timer run. */
    function hover(page: Page, hit: FakeElement, x: number, y: number): void {
      page.document.hit = hit;
      page.socket.receive({ t: 'move', x, y });
      page.runFrames();
      page.advance(70);
    }

    function box(plate: FakeElement) {
      const { left, top, width, height } = plate.style;
      return { left, top, width, height };
    }

    const tile = { left: 100, top: 200, width: 200, height: 100 };
    const tileBox = {
      left: '94px',
      top: '194px',
      width: '212px',
      height: '112px',
    };

    it('sits still around the hovered control under a dot that stays as it is', async () => {
      const page = await connected();
      const button = control(page, tile);
      const dot = page.cursor()!.children[0]!;
      const dotStyle = { ...dot.style };
      page.document.hit = page.document.element('div');
      page.socket.receive({ t: 'enter', x: 10, y: 10 });
      page.runFrames();
      for (const plate of page.plates())
        expect(plate.style['visibility']).toBe('visible');
      expect(page.shown()).toHaveLength(0);

      hover(page, button, 200, 250);
      expect(page.shown()).toHaveLength(1);
      const plate = page.shown()[0]!;
      expect(box(plate)).toEqual(tileBox);
      expect(plate.style['borderRadius']).toBe('28px');
      expect(plate.style['background']).toBe('rgba(255, 255, 255, 0.14)');
      expect(dot.style).toEqual(dotStyle);
      // The dot follows the pointer exactly over the control.
      expect(page.cursor()!.style['transform']).toBe(
        'translate3d(185px, 235px, 0)',
      );

      hover(page, page.document.element('div'), 400, 250);
      expect(page.shown()).toHaveLength(0);
      // It fades out where it was.
      expect(box(plate)).toEqual(tileBox);
      expect(dot.style).toEqual(dotStyle);

      hover(page, button, 200, 250);
      page.socket.receive({ t: 'leave' });
      for (const entry of page.plates()) {
        expect(entry.style['visibility']).toBe('hidden');
        expect(entry.style['opacity']).toBe('0');
      }
      expect(button.hasAttribute('data-pointer-hover')).toBe(false);
    });

    it('uses zoomed rects as they are when the root reports viewport px', async () => {
      const page = await connected();
      appRoot(page, '1.25', 1280);
      const button = control(page, tile);
      page.socket.receive({ t: 'enter', x: 10, y: 10 });
      hover(page, button, 200, 250);
      const plate = page.shown()[0]!;
      expect(box(plate)).toEqual(tileBox);
      // The computed radius is in the control's own px.
      expect(plate.style['borderRadius']).toBe('33.5px');
    });

    it('scales rects by the zoom when the root reports its own px', async () => {
      const page = await connected();
      appRoot(page, '1.25', 1024);
      const button = control(page, tile);
      page.socket.receive({ t: 'enter', x: 10, y: 10 });
      hover(page, button, 250, 312);
      const plate = page.shown()[0]!;
      expect(box(plate)).toEqual({
        left: '119px',
        top: '244px',
        width: '262px',
        height: '137px',
      });
      expect(plate.style['borderRadius']).toBe('33.5px');
    });

    it('rounds the plate into a pill for a round button', async () => {
      const page = await connected();
      const play = control(
        page,
        { left: 900, top: 450, width: 62, height: 62 },
        '50%',
      );
      page.socket.receive({ t: 'enter', x: 10, y: 10 });
      hover(page, play, 931, 481);
      expect(page.shown()[0]!.style['width']).toBe('74px');
      expect(page.shown()[0]!.style['borderRadius']).toBe('37px');
    });

    it('highlights large controls too, with an outline once they are big', async () => {
      const page = await connected();
      // Wider than the old 420 px cap: still a fill.
      const wide = control(page, {
        left: 10,
        top: 300,
        width: 426,
        height: 60,
      });
      const big = control(page, { left: 0, top: 0, width: 700, height: 500 });
      page.socket.receive({ t: 'enter', x: 10, y: 10 });
      hover(page, wide, 200, 330);
      expect(page.shown()).toHaveLength(1);
      expect(page.shown()[0]!.style['width']).toBe('438px');
      expect(page.shown()[0]!.style['background']).toBe(
        'rgba(255, 255, 255, 0.14)',
      );
      hover(page, big, 350, 250);
      expect(page.shown()).toHaveLength(1);
      const plate = page.shown()[0]!;
      expect(box(plate)).toEqual({
        left: '-6px',
        top: '-6px',
        width: '712px',
        height: '512px',
      });
      expect(plate.style['background']).toBe('rgba(255, 255, 255, 0.04)');
      expect(plate.style['boxShadow']).toContain('inset 0 0 0 2px');
    });

    it('shows no plate for disabled controls', async () => {
      const page = await connected();
      const dot = page.cursor()!.children[0]!;
      const dotStyle = { ...dot.style };
      const off = control(page, tile);
      off.disabled = true;
      const ariaOff = control(page, tile);
      ariaOff.setAttribute('aria-disabled', 'true');
      const label = control(page, tile, '0px', 'label');
      const radio = page.document.element('input', label);
      radio.disabled = true;
      label.control = radio;
      page.socket.receive({ t: 'enter', x: 10, y: 10 });
      for (const [index, target] of [off, ariaOff, label].entries()) {
        hover(page, target, 150 + index, 250);
        expect(target.hasAttribute('data-pointer-hover')).toBe(true);
        expect(page.shown()).toHaveLength(0);
        expect(dot.style).toEqual(dotStyle);
      }
    });

    it('resolves the hovered point to the element a click acts on', async () => {
      const page = await connected();
      page.socket.receive({ t: 'enter', x: 10, y: 10 });
      // A scene tile: the grid delegates to the button, not its spans.
      const grid = page.document.element('div');
      const scene = control(page, tile, '22px', 'button', grid);
      scene.setAttribute('data-scene', 'scene.soft_light');
      const name = page.document.element(
        'span',
        page.document.element('span', scene),
      );
      hover(page, name, 150, 250);
      expect(scene.hasAttribute('data-pointer-hover')).toBe(true);
      expect(box(page.shown()[0]!)).toEqual(tileBox);

      // A radio inside its label: the whole label row.
      const row = { left: 20, top: 400, width: 600, height: 44 };
      const label = control(page, row, '0px', 'label');
      const radio = page.document.element('input', label);
      radio.rect = { left: 24, top: 412, width: 20, height: 20 };
      hover(page, radio, 30, 420);
      expect(label.hasAttribute('data-pointer-hover')).toBe(true);
      expect(page.shown()[0]!.style['width']).toBe('612px');
      hover(page, page.document.element('span', label), 300, 420);
      expect(label.hasAttribute('data-pointer-hover')).toBe(true);

      // A role="button" element counts.
      const custom = control(page, tile, '0px', 'div');
      custom.setAttribute('role', 'button');
      hover(page, custom, 160, 250);
      expect(custom.hasAttribute('data-pointer-hover')).toBe(true);

      // Focus-only panels and scroll areas do nothing on a click.
      for (const attribute of ['0', '-1']) {
        const panel = control(
          page,
          { left: 0, top: 0, width: 600, height: 300 },
          '0px',
          'section',
        );
        panel.setAttribute('tabindex', attribute);
        hover(
          page,
          page.document.element('p', panel),
          300 + Number(attribute),
          150,
        );
        expect(panel.hasAttribute('data-pointer-hover')).toBe(false);
        expect(page.shown()).toHaveLength(0);
      }

      // Nothing inside an aria-hidden subtree.
      const hiddenGroup = page.document.element('div');
      hiddenGroup.setAttribute('aria-hidden', 'true');
      const hiddenButton = control(page, tile, '0px', 'button', hiddenGroup);
      hover(page, hiddenButton, 170, 250);
      expect(hiddenButton.hasAttribute('data-pointer-hover')).toBe(false);
      expect(page.shown()).toHaveLength(0);
    });

    it('writes nothing but the dot transform per frame', async () => {
      const page = await connected();
      const button = control(page, tile);
      const layers = [
        page.cursor()!,
        page.cursor()!.children[0]!,
        ...page.plates(),
      ];
      page.socket.receive({ t: 'enter', x: 10, y: 10 });
      hover(page, button, 200, 250);
      const before = layers.map((layer) => ({ ...layer.style }));
      const hits = page.hitTests();
      page.socket.receive({ t: 'move', x: 240, y: 260 });
      page.runFrames();
      page.socket.receive({ t: 'move', x: 299, y: 299 });
      page.runFrames();
      const changed = layers.map((layer, index) =>
        Object.keys(layer.style).filter(
          (key) => layer.style[key] !== before[index]![key],
        ),
      );
      expect(changed).toEqual([['transform'], [], [], []]);
      expect(page.cursor()!.style['transform']).toBe(
        'translate3d(284px, 284px, 0)',
      );
      expect(page.hitTests()).toBe(hits);
    });

    it('fades between controls without sliding', async () => {
      const page = await connected();
      const first = control(page, tile);
      const second = control(page, { ...tile, left: 310 });
      page.socket.receive({ t: 'enter', x: 10, y: 10 });
      hover(page, first, 200, 250);
      const [a] = page.shown();
      hover(page, second, 410, 250);
      const [b] = page.shown();
      expect(page.shown()).toHaveLength(1);
      expect(b).not.toBe(a);
      // The old plate fades out where it is; the new one fades in in place.
      expect(a!.style['opacity']).toBe('0');
      expect(a!.style['left']).toBe('94px');
      expect(b!.style['left']).toBe('304px');
      // Back while the first is still fading: it simply fades back in.
      hover(page, first, 200, 250);
      expect(page.shown()).toEqual([a]);
      expect(b!.style['opacity']).toBe('0');
      for (const plate of page.plates()) {
        expect(plate.animations).toHaveLength(0);
        expect(plate.style['transform']).toBeUndefined();
      }
    });

    it('measures again at once when the page pager has settled', async () => {
      const page = await connected();
      const button = control(page, tile);
      page.socket.receive({ t: 'enter', x: 10, y: 10 });
      hover(page, button, 200, 250);
      const plate = page.shown()[0]!;
      // The pager moved the control while the plate was hidden.
      button.rect = { ...tile, left: 300 };
      const hits = page.hitTests();
      page.windowListeners.fire(new FakeEvent('lugn:pages-settled'));
      page.advance(0);
      expect(page.hitTests()).toBe(hits + 1);
      expect(page.shown()).toEqual([plate]);
      expect(plate.style['left']).toBe('294px');
    });

    it('measures again after a click, Escape or wheel under a still cursor', async () => {
      const page = await connected();
      const button = control(page, tile);
      page.socket.receive({ t: 'enter', x: 10, y: 10 });
      hover(page, button, 200, 250);
      const plate = page.shown()[0]!;
      const click = (down: boolean) =>
        page.socket.receive({
          t: 'button',
          button: 'left',
          down,
          x: 200,
          y: 250,
        });
      click(true);
      click(false);
      // The click moved the control; the same plate is resized in place.
      button.rect = { ...tile, top: 150 };
      const hits = page.hitTests();
      page.advance(299);
      expect(page.hitTests()).toBe(hits);
      page.advance(1);
      expect(page.hitTests()).toBe(hits + 1);
      expect(page.shown()).toEqual([plate]);
      expect(plate.style['top']).toBe('144px');
      expect(plate.animations).toHaveLength(0);

      // Escape closed what was under the cursor.
      page.document.hit = page.document.element('div');
      page.socket.receive({
        t: 'button',
        button: 'right',
        down: true,
        x: 200,
        y: 250,
      });
      page.advance(300);
      expect(button.hasAttribute('data-pointer-hover')).toBe(false);
      expect(page.shown()).toHaveLength(0);

      // Wheel scrolled a control in under the cursor.
      page.document.hit = button;
      page.socket.receive({ t: 'wheel', dx: 0, dy: 40, x: 200, y: 250 });
      page.advance(300);
      expect(page.shown()).toHaveLength(1);
      page.advance(5000);
      expect(page.pending().filter((timer) => timer.delay < 500)).toHaveLength(
        0,
      );
    });

    it('brightens the plate while the button is held, never the dot', async () => {
      const page = await connected();
      const button = control(page, tile);
      const dot = page.cursor()!.children[0]!;
      const dotStyle = { ...dot.style };
      const press = (down: boolean, x: number) =>
        page.socket.receive({ t: 'button', button: 'left', down, x, y: 250 });
      page.document.hit = page.document.element('div');
      page.socket.receive({ t: 'enter', x: 10, y: 10 });
      press(true, 10);
      expect(dot.style).toEqual(dotStyle);
      press(false, 10);

      page.document.hit = button;
      press(true, 200);
      expect(button.hasAttribute('data-pointer-pressed')).toBe(true);
      const plate = page.shown()[0]!;
      expect(plate.style['background']).toBe('rgba(255, 255, 255, 0.24)');
      expect(dot.style).toEqual(dotStyle);
      press(false, 200);
      expect(button.hasAttribute('data-pointer-pressed')).toBe(false);
      expect(plate.style['background']).toBe('rgba(255, 255, 255, 0.14)');
      expect(dot.style).toEqual(dotStyle);
    });
  });
});
