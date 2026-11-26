import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const script = readFileSync(
  new URL('../src/ui/lyrics-view.js', import.meta.url),
  'utf8',
);

type Animation = {
  keyframes: Array<Record<string, unknown>>;
  delay: number;
  cancelled: boolean;
};

class El {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classes = new Set<string>();
  classList = { contains: (name: string) => this.classes.has(name) };
  children: El[] = [];
  animations: Animation[] = [];
  textContent = '';
  className = '';
  hidden = false;
  offsetHeight = 70;
  offsetTop = 0;
  replaceChildren(...children: El[]): void {
    children.forEach((child, index) => (child.offsetTop = index * 70));
    this.children = children;
  }
  animate(
    keyframes: Array<Record<string, unknown>>,
    options: { delay?: number },
  ) {
    const animation = {
      keyframes,
      delay: options.delay ?? 0,
      cancelled: false,
    };
    this.animations.push(animation);
    return { cancel: () => (animation.cancelled = true) };
  }
}

const lines = [
  { at: 10, text: 'One' },
  { at: 20, text: 'Two' },
  { at: 30, text: '' },
];

function setup({
  stored = {},
  answer = { status: 'synced', lines } as Record<string, unknown>,
  // The player's position when the page opens, or no answer of its own.
  at = 12 as number | null,
  rtt = 20,
}: {
  stored?: Record<string, string>;
  answer?: Record<string, unknown>;
  at?: number | null;
  rtt?: number;
} = {}) {
  vi.useFakeTimers({ now: 0 });
  const views = new Map<string, El>();
  const view = (name: string) => {
    const element = views.get(name) ?? new El();
    views.set(name, element);
    return element;
  };
  const storage = new Map<string, string>(Object.entries(stored));
  const player = { position: at, since: 0, playing: true };
  const seek = (to: number) => {
    player.position = to;
    player.since = Date.now();
  };
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/playhead/')) {
      await new Promise((resolve) => setTimeout(resolve, rtt));
      // Measured halfway through the question.
      const measured = Date.now() - rtt / 2;
      return {
        ok: true,
        json: async () =>
          player.position === null
            ? { source: 'none' }
            : {
                source: 'player',
                playing: player.playing,
                position:
                  player.position +
                  (player.playing ? (measured - player.since) / 1000 : 0),
                duration: 200,
              },
      };
    }
    return { ok: true, json: async () => answer };
  });
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
    full(): boolean;
    toggle(): void;
    toggleFull(): void;
    nudge(direction: number): void;
    delayText(): string;
    seek(position: number): void;
    draw(info: Record<string, unknown>): void;
    sleep(): void;
  };
  const draw = (changes: Record<string, unknown> = {}) =>
    api.draw({
      target: 'music.room',
      shown: true,
      ready: true,
      active: true,
      title: 'Song',
      artist: 'Band',
      progress: null,
      playing: true,
      serverNow: () => Date.now(),
      ...changes,
    });
  // The line shown as current: the one that is fully lit.
  const current = () =>
    view('lyrics-track').children.find((line) => line.style['opacity'] === '1')
      ?.textContent;
  const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const asked = (kind: string) =>
    fetcher.mock.calls.filter(([url]) => url.includes(`/display-api/${kind}/`))
      .length;
  return {
    api,
    view,
    draw,
    current,
    wait,
    asked,
    seek,
    player,
    fetcher,
    storage,
  };
}

const on = { 'lugn.musicLyrics': '1' };

describe('Musik lyrics', () => {
  afterEach(() => vi.useRealTimers());

  it('is off until chosen, asks nothing then, and remembers the layout', async () => {
    const s = setup();
    s.draw();
    await s.wait(3_000);
    expect(s.api.shown()).toBe(false);
    expect(s.view('lyrics').hidden).toBe(true);
    // Only the player is asked, and nothing about lyrics.
    expect(s.asked('lyrics')).toBe(0);
    expect(
      s.fetcher.mock.calls.every(([url]) =>
        url.endsWith('/playhead/music.room'),
      ),
    ).toBe(true);
    s.api.toggle();
    expect(s.view('root').dataset['lyrics']).toBe('true');
    expect(s.storage.get('lugn.musicLyrics')).toBe('1');
    s.api.toggleFull();
    expect(s.storage.get('lugn.musicLyrics')).toBe('full');
    expect(s.view('root').dataset['lyricsFull']).toBe('true');
    expect(setup({ stored: { 'lugn.musicLyrics': 'full' } }).api.full()).toBe(
      true,
    );
  });

  it('asks once per track, and for the position only while shown', async () => {
    const s = setup({ stored: on });
    s.draw({ shown: false });
    expect(s.fetcher).not.toHaveBeenCalled();
    s.draw();
    await s.wait(3_100);
    expect(s.asked('lyrics')).toBe(1);
    // About once a second.
    expect(s.asked('playhead')).toBe(4);
    expect(s.fetcher).toHaveBeenCalledWith(
      '/k/secret/display-api/lyrics/music.room',
      { cache: 'no-store' },
    );
    s.api.sleep();
    await s.wait(5_000);
    expect(s.asked('playhead')).toBe(4);
  });

  it('hands each line change to the compositor ahead of its time', async () => {
    const s = setup({ stored: on });
    s.draw();
    await s.wait(100);
    expect(s.current()).toBe('One');
    // Planned for 150 ms before the line is sung, at 20 s of the track: the
    // player was at 12 s at time 0.
    const planned = s
      .view('lyrics-track')
      .animations.filter((a) => !a.cancelled && a.delay > 0);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.delay).toBeGreaterThan(7_500);
    await s.wait(7_650);
    expect(s.current()).toBe('One');
    await s.wait(400);
    expect(s.current()).toBe('Two');
  });

  it('keeps its own count between answers and ignores slow ones', async () => {
    const s = setup({ stored: on });
    s.draw();
    await s.wait(2_500);
    const before = s.view('lyrics-track').animations.length;
    await s.wait(3_000);
    // Answers that agree leave the planned change as it is.
    expect(s.view('lyrics-track').animations.length).toBe(before);
  });

  it('follows a seek, here at once and elsewhere with the next answer', async () => {
    const s = setup({ stored: on });
    s.draw();
    await s.wait(100);
    s.seek(31);
    await s.wait(1_100);
    expect(s.current()).toBe('♪');
    s.api.seek(11);
    expect(s.current()).toBe('One');
    // An answer from before the player caught up is not believed.
    await s.wait(1_100);
    expect(s.current()).toBe('One');
    s.seek(11 + 1.1);
    await s.wait(3_000);
    expect(s.current()).toBe('One');
  });

  it('stays where the player pauses', async () => {
    const s = setup({ stored: on });
    s.draw();
    await s.wait(100);
    s.player.playing = false;
    s.player.position = 21;
    s.draw({ playing: false });
    await s.wait(30_000);
    expect(s.current()).toBe('Two');
  });

  it('shows the lines later or earlier by a chosen delay', async () => {
    const s = setup({ stored: { ...on, 'lugn.lyricsDelay': '90' } });
    s.draw();
    await s.wait(100);
    // 12 s into the track, shown 5 s late (the most): before the first line.
    expect(s.current()).toBe('♪');
    expect(s.api.delayText()).toBe('+5,0 s');
    for (let i = 0; i < 60; i += 1) s.api.nudge(-1);
    expect(s.api.delayText()).toBe('−1,0 s');
    expect(s.storage.get('lugn.lyricsDelay')).toBe('-10');
  });

  it("counts on the page's progress without a position of the player's", async () => {
    const s = setup({ stored: on, at: null });
    s.draw({
      progress: { position: 21, duration: 200, at: 0, playing: false },
      playing: false,
    });
    await s.wait(100);
    expect(s.current()).toBe('Two');
    // Paused on a computer: no position at all, the lines stay.
    s.draw({ progress: null, playing: false });
    await s.wait(5_000);
    expect(s.current()).toBe('Two');
    const unsynced = setup({ stored: on, at: null });
    unsynced.draw();
    await unsynced.wait(100);
    expect(unsynced.view('lyrics').dataset['status']).toBe('unsynced');
  });

  it('says why there is nothing to follow, beside the rail', async () => {
    const s = setup({
      stored: { 'lugn.musicLyrics': 'full' },
      answer: { status: 'none' },
    });
    s.draw();
    expect(s.view('lyrics').dataset['status']).toBe('loading');
    await s.wait(100);
    expect(s.view('lyrics-heading').textContent).toBe('Ingen synkad text');
    expect(s.view('root').dataset['lyricsFull']).toBe('false');
    s.draw({ active: false });
    expect(s.view('lyrics-heading').textContent).toBe('Ingen musik spelar');
  });

  it('does not keep lines that belong to another track', async () => {
    const answer: Record<string, unknown> = {
      status: 'synced',
      lines,
      track: { title: 'The next song', artist: 'Band' },
    };
    const s = setup({ stored: on, answer });
    s.draw();
    await s.wait(100);
    expect(s.view('lyrics-track').children).toHaveLength(0);
    answer['track'] = { title: 'Song', artist: 'Band' };
    await s.wait(2_500);
    expect(s.current()).toBe('One');
  });

  it('asks at once when the server says the track changed', async () => {
    const s = setup({ stored: on });
    s.draw({ announced: { title: 'Song', artist: 'Band' } });
    await s.wait(100);
    const before = s.asked('playhead');
    s.draw({ announced: { title: 'Song', artist: 'Band' } });
    await s.wait(10);
    expect(s.asked('playhead')).toBe(before);
    s.draw({ announced: { title: 'Next', artist: 'Band' } });
    await s.wait(10);
    expect(s.asked('playhead')).toBe(before + 1);
  });

  it('retries a failed fetch later', async () => {
    const s = setup({ stored: on, answer: { status: 'unavailable' } });
    s.draw();
    await s.wait(5_000);
    expect(s.asked('lyrics')).toBe(1);
    await s.wait(27_000);
    expect(s.asked('lyrics')).toBe(2);
  });

  it('tells Lugn once a minute how it keeps time', async () => {
    const s = setup({ stored: on });
    s.draw();
    await s.wait(62_000);
    const report = s.fetcher.mock.calls.find(([url]) => url.endsWith('/probe'));
    const body = JSON.parse(
      (report as unknown as [string, { body: string }])[1].body,
    ) as { phase: string; data: Record<string, unknown> };
    expect(body.phase).toBe('lyrics');
    expect(body.data).toMatchObject({ source: 'player', jumps: 0 });
    expect(body.data['rttP50']).toBe(20);
  });
});
