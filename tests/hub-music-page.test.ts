import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const script = readFileSync(
  new URL('../src/ui/page-views.js', import.meta.url),
  'utf8',
);

type Listener = (event: Record<string, unknown>) => void;

class El {
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  properties = new Map<string, string>();
  style: Record<string, unknown> = {
    setProperty: (name: string, value: string) =>
      this.properties.set(name, value),
    removeProperty: (name: string) => this.properties.delete(name),
  };
  children: El[] = [];
  textContent = '';
  hidden = false;
  disabled = false;
  offsetWidth = 200;
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, init: Record<string, unknown> = {}) {
    const event = {
      type,
      button: 0,
      pointerId: 1,
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      preventDefault: vi.fn(),
      ...init,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  getBoundingClientRect() {
    return { left: 100, width: 200 };
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  replaceChildren(...children: El[]): void {
    this.children = children;
  }
  closest(): null {
    return null;
  }
}

/** The Musik page over a playing track: 200 s long, 20 s in, volume 30 %. */
function setup({ computer }: { computer?: Record<string, unknown> } = {}) {
  vi.useFakeTimers();
  const views = new Map<string, El>();
  const view = (name: string) => {
    const element = views.get(name) ?? new El();
    views.set(name, element);
    return element;
  };
  const appRoot = new El();
  appRoot.dataset['musicVisible'] = 'true';
  const document = new El() as El & Record<string, unknown>;
  Object.assign(document, {
    querySelector: (selector: string) => {
      const match =
        /^\.hub-page\[data-page='music'\] \[data-view='([\w-]+)'\]$/.exec(
          selector,
        );
      return match ? view(match[1]!) : null;
    },
    querySelectorAll: () => [],
    getElementById: (id: string) => (id === 'app-root' ? appRoot : null),
    createElement: () => new El(),
  });
  const window = Object.assign(new El(), {
    innerWidth: 1024,
    innerHeight: 600,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  });
  const pages = new Map<string, Record<string, () => void>>();
  const device = { availability: 'available', observed: { volume: 0.3 } };
  const sent: Array<[string, unknown]> = [];
  const button = { disabled: false, getAttribute: () => 'false' };
  const text = (textContent: string) => ({ textContent, hidden: false });
  const context = createContext({
    document,
    window,
    performance: { now: () => Date.now() },
    Date,
    matchMedia: () => ({ matches: true }),
    lugnPages: {
      define: (id: string, hooks: Record<string, () => void>) =>
        pages.set(id, hooks),
      go: () => true,
      onChange: () => () => undefined,
      current: () => 'music',
      probe: { enabled: false },
    },
    refs: {
      musicTitle: text('Låten'),
      musicArtist: text('Artisten'),
      musicSource: text('Spotify'),
      musicPlayback: { disabled: false, getAttribute: () => 'false' },
      musicPlaybackLabel: text('Pausa'),
      musicVolumeDown: button,
      musicVolumeUp: button,
    },
    latestPayload: {
      state: {
        music: {
          devices: { 'music.room': device },
          ...(computer ? { computerPlayback: { 'music.room': computer } } : {}),
        },
      },
      musicTrackControl: { 'music.room': !computer },
    },
    musicTarget: 'music.room',
    musicProgress: {
      position: 20,
      duration: 200,
      at: Date.now(),
      playing: false,
    },
    estimatedServerNow: () => Date.now(),
    isUnavailable: () => false,
    pending: new Set<string>(),
    runCommand: vi.fn(async (key: string, body: { request: unknown }) => {
      sent.push([key, body.request]);
    }),
  });
  context['globalThis'] = context;
  runInContext(script, context);
  pages.get('music')!['enter']!();
  return { view, document, device, sent, pages };
}

describe('the Musik page', () => {
  afterEach(() => vi.useRealTimers());

  it('seeks where a drag on the time bar lets go, and only then', async () => {
    const s = setup();
    const bar = s.view('seek');
    expect(bar.getAttribute('role')).toBe('slider');
    // The pager leaves a swipe that starts here alone.
    expect(bar.getAttribute('data-pager')).toBe('ignore');
    bar.fire('pointerdown', { clientX: 120 });
    s.document.fire('pointermove', { clientX: 250 });
    // The knob and the time follow; a redraw does not pull them back.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.view('elapsed').textContent).toBe('2:30');
    expect(s.sent).toEqual([]);
    s.document.fire('pointerup', { clientX: 250 });
    expect(s.sent).toEqual([
      ['music-seek:music.room', { property: 'seek', value: 150 }],
    ]);
    // Shown there until the player reports, or the wait is over.
    expect(s.view('elapsed').textContent).toBe('2:30');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(s.view('elapsed').textContent).toBe('0:20');
  });

  it('sends nothing for a drag that is cancelled or left', async () => {
    const s = setup();
    s.view('seek').fire('pointerdown', { clientX: 200 });
    s.document.fire('pointercancel');
    s.document.fire('pointerup', { clientX: 200 });
    s.view('seek').fire('pointerdown', { clientX: 200 });
    s.pages.get('music')!['leave']!();
    s.document.fire('pointerup', { clientX: 200 });
    expect(s.sent).toEqual([]);
    expect(s.view('elapsed').textContent).toBe('0:20');
  });

  it('sets the volume while dragging, without flooding the player', async () => {
    const s = setup();
    const bar = s.view('volume-slider');
    bar.fire('pointerdown', { clientX: 160 });
    for (const clientX of [180, 200, 220])
      s.document.fire('pointermove', { clientX });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.sent.length).toBeLessThanOrEqual(1);
    s.document.fire('pointerup', { clientX: 240 });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.sent.at(-1)).toEqual([
      'music-volume:music.room',
      { property: 'volume', value: 0.7 },
    ]);
    // The chosen level stands before the player has reported it.
    expect(bar.getAttribute('aria-valuenow')).toBe('70');
  });

  it('steps with the wheel and the arrow keys, sending once the wheel rests', async () => {
    const s = setup();
    const volume = s.view('volume-slider');
    for (let notch = 0; notch < 3; notch += 1)
      expect(
        volume.fire('wheel', { deltaY: -48 }).preventDefault,
      ).toHaveBeenCalled();
    expect(s.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(s.sent).toEqual([
      ['music-volume:music.room', { property: 'volume', value: 0.36 }],
    ]);
    const key = s.view('seek').fire('keydown', { key: 'ArrowRight' });
    expect(key.preventDefault).toHaveBeenCalled();
    expect(s.sent.at(-1)).toEqual([
      'music-seek:music.room',
      { property: 'seek', value: 25 },
    ]);
  });

  it('sends Föregående and Nästa', () => {
    const s = setup();
    s.view('previous').fire('click');
    s.view('next').fire('click');
    expect(s.sent.map(([, request]) => request)).toEqual([
      { property: 'track', value: 'previous' },
      { property: 'track', value: 'next' },
    ]);
  });

  it("offers on a computer input only what the computer's media can take", () => {
    const s = setup({
      computer: {
        active: true,
        pending: false,
        playback: 'playing',
        canNext: true,
        canPrevious: false,
        canSeek: false,
      },
    });
    expect(s.view('previous').hidden).toBe(false);
    expect(s.view('previous').disabled).toBe(true);
    expect(s.view('next').disabled).toBe(false);
    s.view('previous').fire('click');
    // A bar that cannot be adjusted takes no press, and a swipe turns the page.
    const bar = s.view('seek');
    expect(bar.getAttribute('role')).toBeNull();
    expect(bar.getAttribute('data-pager')).toBeNull();
    bar.fire('pointerdown', { clientX: 200 });
    s.document.fire('pointerup', { clientX: 200 });
    expect(
      bar.fire('wheel', { deltaY: -48 }).preventDefault,
    ).not.toHaveBeenCalled();
    expect(s.sent).toEqual([]);
  });
});
