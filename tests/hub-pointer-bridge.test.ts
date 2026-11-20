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
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 0;
  clientHeight = 0;
  scrollWidth = 0;
  clientWidth = 0;
  computed = { overflowX: 'visible', overflowY: 'visible' };
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
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
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
  createElementNS(_ns: string, tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  elementFromPoint(): FakeElement | null {
    return this.hit;
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

async function load(status = 200, pointerEvents = true) {
  const document = new FakeDocument();
  const frames: Array<() => void> = [];
  const timers: Array<{ delay: number; callback: () => void }> = [];
  const fetches: string[] = [];
  const windowListeners = new Listeners();
  const sockets: FakeWebSocket[] = [];
  class Socket extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
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
    WebSocket: Socket,
    MouseEvent: FakeMouseEvent,
    ...(pointerEvents ? { PointerEvent: FakePointerEvent } : {}),
    WheelEvent: FakeWheelEvent,
    KeyboardEvent: FakeKeyboardEvent,
    requestAnimationFrame: (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    },
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ delay, callback });
      return timers.length;
    },
    clearTimeout: () => undefined,
    getComputedStyle: (element: FakeElement) => element.computed,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: (type: string, listener: Listener) =>
      windowListeners.addEventListener(type, listener),
  });
  context['window'] = context;
  runInContext(script, context);
  await settle();
  const runFrames = () => {
    for (const frame of frames.splice(0)) frame();
  };
  const cursor = () =>
    document.body.children.find((child) => child.tagName === 'svg');
  return {
    document,
    frames,
    timers,
    fetches,
    sockets,
    context,
    windowListeners,
    runFrames,
    cursor,
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
    expect(socket.sent).toEqual([{ t: 'hello', v: 1, w: 1280, h: 800 }]);
    context['innerWidth'] = 900;
    windowListeners.fire(new FakeEvent('resize'));
    expect(socket.sent.at(-1)).toEqual({ t: 'hello', v: 1, w: 900, h: 800 });
    socket.receive({ t: 'ping', id: 17 });
    expect(socket.sent.at(-1)).toEqual({ t: 'pong', id: 17 });
    socket.receive({ t: 'future', extra: true });
    expect(socket.sent.at(-1)).toEqual({ t: 'pong', id: 17 });
  });

  it('shows the cursor at the latest point once per frame and hides it on leave', async () => {
    const page = await connected();
    expect(page.cursor()).toBeUndefined();
    const button = page.document.element('button');
    page.document.hit = button;
    page.socket.receive({ t: 'enter', x: 1279, y: 400 });
    page.socket.receive({ t: 'move', x: 1200, y: 410 });
    page.socket.receive({ t: 'move', x: 1100.5, y: 420 });
    expect(page.frames).toHaveLength(1);
    page.runFrames();
    const cursor = page.cursor()!;
    expect(cursor.style['display']).toBe('block');
    expect(cursor.style['pointerEvents']).toBe('none');
    expect(cursor.style['position']).toBe('fixed');
    expect(cursor.style['zIndex']).toBe('2147483647');
    expect(cursor.style['transform']).toBe('translate3d(1098.5px, 418px, 0)');
    expect(button.hasAttribute('data-pointer-hover')).toBe(true);

    page.socket.receive({ t: 'leave' });
    expect(cursor.style['display']).toBe('none');
    expect(button.hasAttribute('data-pointer-hover')).toBe(false);
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
    page.socket.close();
    expect(held.size).toBe(0);
    expect(page.cursor()!.style['display']).toBe('none');
    expect(page.timers.map((timer) => timer.delay)).toEqual([500]);
    page.timers[0]!.callback();
    expect(page.sockets).toHaveLength(2);
    page.sockets[1]!.close();
    expect(page.timers.map((timer) => timer.delay)).toEqual([500, 1000]);
    page.timers[1]!.callback();
    page.sockets[2]!.open();
    page.sockets[2]!.close();
    expect(page.timers.map((timer) => timer.delay)).toEqual([500, 1000, 500]);
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
});
