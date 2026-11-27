import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync(
  new URL('../src/ui/hub-policy.js', import.meta.url),
  'utf8',
);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const TARGET = 'music.room';

type Listener = () => void;
function listeners() {
  const map = new Map<string, Listener[]>();
  return {
    addEventListener: (type: string, fn: Listener) => {
      map.set(type, [...(map.get(type) ?? []), fn]);
    },
    fire: (type: string) => {
      for (const fn of map.get(type) ?? []) fn();
    },
  };
}

type Player = {
  availability: string;
  observedAt?: number;
  observed: { playback: string };
};
type Payload = {
  musicObservationConnected?: boolean;
  musicObservationTrust?: Record<string, boolean>;
  computerNowPlaying?: Record<string, { status: string }>;
  state: {
    music: {
      devices: Record<string, Player>;
      computerPlayback?: Record<string, { active: boolean; playback: string }>;
      commands?: unknown[];
    };
  };
};

const player = (playback: string, availability = 'available'): Player => ({
  availability,
  observed: { playback },
});
const payload = (playback = 'paused'): Payload => ({
  state: { music: { devices: { [TARGET]: player(playback) } } },
});

/** A Hub with the policy script, display.js's globals and a clock. */
function setup(initial: Payload = payload()) {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const document = listeners();
  const events = listeners();
  const moves: string[] = [];
  let page = 'home';
  let ids = ['home', 'music', 'foto', 'clock'];
  let held = false;
  const go = (next: string) => {
    if (held || !ids.includes(next)) return false;
    if (next === page) return true;
    page = next;
    events.fire('lugn:page');
    return true;
  };
  // Lugn's heartbeat: fresh data every five seconds while it is reachable.
  const lugn = { reachable: true, unavailable: false };
  const context = createContext({
    window: {
      ...events,
      setTimeout: (fn: () => void, ms: number) => {
        timers.set(++id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (timer: number) => timers.delete(timer),
      requestAnimationFrame: () => 0,
      performance: { now: () => now },
    },
    document: {
      ...document,
      documentElement: { dataset: {} },
      getElementById: () => null,
    },
    URLSearchParams,
    Date: { now: () => now },
    latestPayload: initial,
    lastFreshAt: 0,
    musicTarget: TARGET,
    isUnavailable: () => lugn.unavailable,
    lugnPages: {
      all: () => ids,
      ids: () => ids,
      current: () => page,
      go: (next: string) => {
        const went = go(next);
        if (went) moves.push(next);
        return went;
      },
      setAvailable: (list: string[] | null) => {
        if (list) ids = list;
        return true;
      },
    },
  });
  const globals = context as Record<string, unknown>;
  globals['globalThis'] = context;
  runInContext(script, context);
  const policy = globals['lugnHubPolicy'] as { apply(policy: unknown): void };

  function advance(ms: number) {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + SECOND);
      if (lugn.reachable && now % (5 * SECOND) === 0)
        globals['lastFreshAt'] = now;
      for (const [timer, due] of [...timers])
        if (due.at <= now && timers.delete(timer)) due.fn();
    }
  }

  return {
    advance,
    lugn,
    apply: (value: unknown) => policy.apply(value),
    /** The user (or the cover on Hem) opens a page. */
    open: (next: string) => go(next),
    page: () => page,
    moves,
    press: () => document.fire('pointerdown'),
    drag: () => document.fire('pointermove'),
    mouse: () => events.fire('lugn:pointer-move'),
    data: (next: Payload) => {
      globals['latestPayload'] = next;
      globals['lastFreshAt'] = now;
    },
    /** Timers do not run for this long (a hidden or sleeping page). */
    sleep: (ms: number) => {
      now += ms;
      globals['lastFreshAt'] = now;
      advance(SECOND);
    },
    hold: (value: boolean) => (held = value),
    pages: (list: string[]) => (ids = list),
  };
}

describe('a quiet Musik page', () => {
  it('is left for Hem after five minutes, without any rules', () => {
    const t = setup();
    t.apply(undefined);
    t.open('music');
    t.advance(5 * MINUTE - SECOND);
    expect(t.page()).toBe('music');
    t.advance(SECOND);
    expect(t.page()).toBe('home');
  });

  it('gives the full delay however long it has been quiet before', () => {
    const t = setup();
    t.advance(30 * MINUTE);
    t.open('music');
    t.advance(4 * MINUTE);
    t.open('home');
    t.open('music');
    t.advance(4 * MINUTE);
    expect(t.page()).toBe('music');
    t.advance(2 * MINUTE);
    expect(t.moves).toEqual(['home']);
  });

  it('is not gone back to afterwards', () => {
    const t = setup();
    t.open('music');
    t.advance(6 * MINUTE);
    t.data(payload('playing'));
    t.advance(MINUTE);
    t.data(payload());
    t.advance(10 * MINUTE);
    expect(t.moves).toEqual(['home']);
    expect(t.page()).toBe('home');
  });

  it('counts from the end of playback, through pauses and track changes', () => {
    const t = setup(payload('playing'));
    t.open('music');
    t.advance(60 * MINUTE);
    expect(t.page()).toBe('music');
    for (const playback of ['idle', 'playing', 'paused']) {
      t.data(payload(playback));
      t.advance(3 * MINUTE);
    }
    t.data(payload('playing'));
    t.advance(10 * SECOND);
    t.data(payload('paused'));
    t.advance(4 * MINUTE);
    expect(t.page()).toBe('music');
    t.advance(2 * MINUTE);
    expect(t.page()).toBe('home');
  });

  it.each([
    ['a press', 'press'],
    ['a drag', 'drag'],
    ['the bridged mouse moving', 'mouse'],
  ] as const)('starts over after %s', (_, use) => {
    const t = setup();
    t.open('music');
    t.advance(4 * MINUTE);
    t[use]();
    t.advance(5 * MINUTE - SECOND);
    expect(t.page()).toBe('music');
    t.advance(10 * SECOND);
    expect(t.page()).toBe('home');
  });

  it.each([
    [
      'Lugn stops sending',
      (t: ReturnType<typeof setup>) => {
        t.lugn.reachable = false;
      },
    ],
    [
      'the Hub calls Lugn unreachable',
      (t: ReturnType<typeof setup>) => {
        t.lugn.unavailable = true;
      },
    ],
  ])('stays while %s, and waits in full afterwards', (_, cut) => {
    const t = setup();
    t.open('music');
    t.advance(4 * MINUTE);
    cut(t);
    t.advance(20 * MINUTE);
    expect(t.page()).toBe('music');
    t.lugn.reachable = true;
    t.lugn.unavailable = false;
    t.advance(4 * MINUTE);
    expect(t.page()).toBe('music');
    t.advance(2 * MINUTE);
    expect(t.page()).toBe('home');
  });

  const onComputer = (
    status: string,
    playback = 'playing',
    desktop?: string,
  ): Payload => ({
    ...payload(playback),
    computerNowPlaying: { [TARGET]: { status } },
    state: {
      music: {
        devices: { [TARGET]: player(playback) },
        ...(desktop
          ? {
              computerPlayback: {
                [TARGET]: { active: true, playback: desktop },
              },
            }
          : {}),
      },
    },
  });

  it.each<[string, Payload]>([
    ['the player plays', payload('playing')],
    ['the computer plays', onComputer('playing', 'playing', 'playing')],
    ['the computer plays several things', onComputer('ambiguous')],
    [
      'the computer plays and the player says paused',
      onComputer('playing', 'paused'),
    ],
    ['the computer’s media is unknown', onComputer('unavailable')],
    [
      'the computer’s control cannot be matched to the input',
      {
        state: {
          music: {
            devices: { [TARGET]: player('playing') },
            computerPlayback: {
              [TARGET]: { active: true, playback: 'paused' },
            },
          },
        },
      },
    ],
    [
      'another player plays',
      {
        state: {
          music: {
            devices: {
              [TARGET]: player('paused'),
              'music.kitchen': player('playing'),
            },
          },
        },
      },
    ],
    ['playback is unknown', payload('unknown')],
    [
      'the player is unavailable',
      {
        state: {
          music: {
            devices: { [TARGET]: player('paused', 'unavailable') },
          },
        },
      },
    ],
    [
      'the player is not trusted',
      { ...payload(), musicObservationTrust: { [TARGET]: false } },
    ],
    [
      'no music source is connected',
      { ...payload(), musicObservationConnected: false },
    ],
    [
      'a later check disagrees with the player',
      {
        state: {
          music: {
            devices: { [TARGET]: player('paused') },
            commands: [
              {
                target: TARGET,
                recovery: {
                  verifiedAt: 1,
                  reported: { playback: 'playing' },
                },
              },
            ],
          },
        },
      },
    ],
    ['there is no player', { state: { music: { devices: {} } } }],
  ])('stays while %s', (_, data) => {
    const t = setup(data);
    t.open('music');
    t.advance(20 * MINUTE);
    expect(t.page()).toBe('music');
  });

  it.each<[string, Payload]>([
    ['the player is off', payload('off')],
    [
      'the computer behind the open input plays nothing',
      onComputer('idle', 'playing', 'paused'),
    ],
    [
      'the player is paused and its computer is gone',
      onComputer('unavailable', 'idle'),
    ],
    [
      'another player cannot be told',
      {
        state: {
          music: {
            devices: {
              [TARGET]: player('paused'),
              'music.kitchen': player('unknown', 'unavailable'),
            },
          },
        },
      },
    ],
  ])('is left when %s', (_, data) => {
    const t = setup(data);
    t.open('music');
    t.advance(5 * MINUTE);
    expect(t.page()).toBe('home');
  });

  it('starts over after the page has not run for a while', () => {
    const t = setup();
    t.open('music');
    t.advance(4 * MINUTE);
    t.sleep(30 * MINUTE);
    expect(t.page()).toBe('music');
    t.advance(5 * MINUTE);
    expect(t.page()).toBe('home');
  });

  it('asks again when the pages are held', () => {
    const t = setup();
    t.open('music');
    t.hold(true);
    t.advance(6 * MINUTE);
    expect(t.page()).toBe('music');
    t.hold(false);
    t.advance(5 * SECOND);
    expect(t.page()).toBe('home');
  });

  const focus = (page: string, extra: Record<string, unknown> = {}) => ({
    pages: null,
    dim: 1,
    focus: { page, returnTo: null, token: `rule@${page}`, ...extra },
  });

  it('goes to the page a rule in force brings up', () => {
    const t = setup();
    // The Hub is taken there once; someone then opens Musik.
    t.apply(focus('foto'));
    t.open('music');
    t.advance(5 * MINUTE);
    expect(t.moves).toEqual(['foto', 'foto']);
  });

  it('goes to Hem when that rule does not take over from Musik', () => {
    const t = setup();
    t.apply(focus('foto', { fromPages: ['clock'] }));
    t.open('music');
    t.advance(5 * MINUTE);
    expect(t.page()).toBe('home');
  });

  it('stays while a rule brings up Musik', () => {
    const t = setup();
    // Taken to Musik from Hem, as such a rule is usually written.
    t.apply(focus('music', { fromPages: ['home'] }));
    t.advance(20 * MINUTE);
    expect(t.page()).toBe('music');
    t.apply({ pages: null, dim: 1, focus: null });
    t.advance(5 * SECOND);
    expect(t.page()).toBe('home');
  });

  it('goes to the first page the rules leave when Hem is gone', () => {
    const t = setup();
    t.apply({ pages: ['music', 'clock'], dim: 1, focus: null });
    t.open('music');
    t.advance(5 * MINUTE);
    expect(t.page()).toBe('clock');
  });

  it('stays when it is the only page', () => {
    const t = setup();
    t.apply({ pages: ['music'], dim: 1, focus: null });
    t.open('music');
    t.advance(20 * MINUTE);
    expect(t.moves).toEqual([]);
  });
});
