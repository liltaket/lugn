import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const script = readFileSync(
  new URL('../src/ui/lyrics-view.js', import.meta.url),
  'utf8',
);

class El {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classes = new Set<string>();
  classList = { contains: (name: string) => this.classes.has(name) };
  children: El[] = [];
  textContent = '';
  className = '';
  hidden = false;
  offsetHeight = 70;
  offsetTop = 0;
  replaceChildren(...children: El[]): void {
    children.forEach((child, index) => (child.offsetTop = index * 70));
    this.children = children;
  }
}

const lines = [
  { at: 10, text: 'One' },
  { at: 20, text: 'Two' },
  { at: 30, text: '' },
];

function setup({
  stored,
  answer = { status: 'synced', lines } as Record<string, unknown>,
}: { stored?: string; answer?: Record<string, unknown> } = {}) {
  vi.useFakeTimers();
  const views = new Map<string, El>();
  const view = (name: string) => {
    const element = views.get(name) ?? new El();
    views.set(name, element);
    return element;
  };
  const storage = new Map<string, string>(
    stored === undefined ? [] : [['lugn.musicLyrics', stored]],
  );
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => answer }));
  const context = createContext({
    document: {
      querySelector: (selector: string) =>
        view(/\[data-view='([\w-]+)'\]$/.exec(selector)![1]!),
      createElement: () => new El(),
    },
    window: {
      localStorage: {
        getItem: (name: string) => storage.get(name) ?? null,
        setItem: (name: string, value: string) => storage.set(name, value),
      },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    },
    lugnPages: {},
    BASE_PATH: '/k/secret/',
    fetch: fetcher,
    performance: { now: () => Date.now() },
    encodeURIComponent,
  });
  context['globalThis'] = context;
  runInContext(script, context);
  const api = context['lugnLyrics'] as {
    shown(): boolean;
    toggle(): void;
    draw(info: Record<string, unknown>): void;
  };
  const draw = (changes: Record<string, unknown> = {}) =>
    api.draw({
      target: 'music.room',
      shown: true,
      ready: true,
      active: true,
      title: 'Song',
      artist: 'Band',
      progress: {
        position: 12,
        duration: 200,
        at: Date.now(),
        playing: true,
      },
      serverNow: () => Date.now(),
      ...changes,
    });
  const current = () =>
    view('lyrics-track').children.find((line) => line.dataset['at'] === '0')
      ?.textContent;
  const settle = () => vi.advanceTimersByTimeAsync(0);
  return { api, view, draw, current, settle, fetcher, storage };
}

describe('Musik lyrics', () => {
  afterEach(() => vi.useRealTimers());

  it('is off until chosen, asks nothing then, and remembers the choice', async () => {
    const s = setup();
    s.draw();
    expect(s.api.shown()).toBe(false);
    expect(s.view('lyrics').hidden).toBe(true);
    expect(s.fetcher).not.toHaveBeenCalled();
    s.api.toggle();
    expect(s.view('root').dataset['lyrics']).toBe('true');
    expect(s.storage.get('lugn.musicLyrics')).toBe('1');
    expect(setup({ stored: '1' }).api.shown()).toBe(true);
  });

  it('asks only while the page is shown, once per track', async () => {
    const s = setup({ stored: '1' });
    s.draw({ shown: false });
    expect(s.fetcher).not.toHaveBeenCalled();
    s.draw();
    s.draw();
    await s.settle();
    s.draw();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(s.fetcher).toHaveBeenCalledWith(
      '/k/secret/display-api/lyrics/music.room',
      { cache: 'no-store' },
    );
  });

  it('follows playback line by line and stops where it pauses', async () => {
    const s = setup({ stored: '1' });
    s.draw();
    await s.settle();
    expect(s.current()).toBe('One');
    // The next line lights up on its own, just before its time.
    await vi.advanceTimersByTimeAsync(7_800);
    expect(s.current()).toBe('Two');
    // Paused on a computer: no position, the lines stay.
    s.draw({ progress: null });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.current()).toBe('Two');
    // A seek moves at once; a pause in the song shows a note sign.
    s.draw({
      progress: { position: 31, duration: 200, at: Date.now(), playing: false },
    });
    expect(s.current()).toBe('♪');
  });

  it('says why there is nothing to follow', async () => {
    const s = setup({ stored: '1', answer: { status: 'none' } });
    s.draw();
    expect(s.view('lyrics').dataset['status']).toBe('loading');
    await s.settle();
    expect(s.view('lyrics-heading').textContent).toBe('Ingen synkad text');
    s.draw({ active: false });
    expect(s.view('lyrics-heading').textContent).toBe('Ingen musik spelar');
    const unsynced = setup({ stored: '1' });
    unsynced.draw({ progress: null });
    await unsynced.settle();
    expect(unsynced.view('lyrics').dataset['status']).toBe('unsynced');
  });

  it('does not keep lines that belong to another track', async () => {
    const answer: Record<string, unknown> = {
      status: 'synced',
      lines,
      track: { title: 'The next song', artist: 'Band' },
    };
    const s = setup({ stored: '1', answer });
    s.draw();
    await s.settle();
    expect(s.view('lyrics-track').children).toHaveLength(0);
    answer['track'] = { title: 'Song', artist: 'Band' };
    await vi.advanceTimersByTimeAsync(2_000);
    s.draw();
    await s.settle();
    expect(s.current()).toBe('One');
  });

  it('retries a failed fetch later', async () => {
    const s = setup({ stored: '1', answer: { status: 'unavailable' } });
    s.draw();
    await s.settle();
    s.draw();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    s.draw();
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });
});
