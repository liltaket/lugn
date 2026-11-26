import { describe, expect, it } from 'vitest';
import {
  HubPolicyEngine,
  computerFact,
  watchingFact,
} from '../src/application/hub-policy.js';
import {
  composeHubPolicy,
  evaluateCondition,
  HubRulesSchema,
  NEUTRAL_HUB_POLICY,
  stockholmClock,
  type Condition,
  type HubFacts,
  type HubRule,
} from '../src/core/hub-rules.js';
import { greetingSkin } from '../src/core/greetings.js';
import type { RoomState } from '../src/core/schemas.js';

// 2026-11-24 is a Tuesday. Stockholm is UTC+1 in November.
const at = (hhmm: string, day = '2026-11-24') =>
  Date.parse(`${day}T${hhmm}:00+01:00`);

function facts(overrides: Partial<HubFacts> = {}): HubFacts {
  return {
    now: at('20:00'),
    hub: { id: 'bed', role: 'bed' },
    clock: stockholmClock(at('20:00')),
    home: 'home',
    arrivedAt: null,
    room: { presence: 'occupied', people: 1 },
    computers: {},
    lights: { anyOn: null, firstOnToday: null },
    musicPlaying: null,
    watching: null,
    airStuffy: null,
    ...overrides,
  };
}

const parse = (rules: unknown[]): HubRule[] => HubRulesSchema.parse(rules);

describe('Stockholm clock', () => {
  it('reads wall time and weekday in Europe/Stockholm, with daylight time', () => {
    expect(stockholmClock(at('23:30'))).toEqual({
      minutes: 23 * 60 + 30,
      weekday: 'tue',
    });
    // Midsummer: UTC+2.
    expect(stockholmClock(Date.parse('2026-06-24T00:10:00+02:00'))).toEqual({
      minutes: 10,
      weekday: 'wed',
    });
  });
});

describe('conditions', () => {
  it('matches home and away, and never treats unknown as either', () => {
    expect(evaluateCondition({ home: 'away' }, facts({ home: 'away' }))).toBe(
      true,
    );
    expect(evaluateCondition({ home: 'away' }, facts({ home: 'home' }))).toBe(
      false,
    );
    expect(
      evaluateCondition({ home: 'away' }, facts({ home: 'unknown' })),
    ).toBeNull();
    expect(
      evaluateCondition({ home: 'home' }, facts({ home: 'unknown' })),
    ).toBeNull();
    expect(
      evaluateCondition({ home: 'unknown' }, facts({ home: 'unknown' })),
    ).toBe(true);
  });

  it('is three-valued through all, any and not', () => {
    const unknownHome = facts({ home: 'unknown' });
    const yes: Condition = { hub: { role: 'bed' } };
    const no: Condition = { hub: { role: 'desk' } };
    const maybe: Condition = { home: 'away' };
    expect(evaluateCondition({ all: [yes, maybe] }, unknownHome)).toBeNull();
    expect(evaluateCondition({ all: [no, maybe] }, unknownHome)).toBe(false);
    expect(evaluateCondition({ any: [yes, maybe] }, unknownHome)).toBe(true);
    expect(evaluateCondition({ any: [no, maybe] }, unknownHome)).toBeNull();
    expect(evaluateCondition({ not: maybe }, unknownHome)).toBeNull();
    expect(evaluateCondition({ not: no }, unknownHome)).toBe(true);
  });

  it('measures time since arrival and only while at home', () => {
    const arrived = at('18:00');
    const within = { arrived: { withinMinutes: 15 } } as const;
    expect(
      evaluateCondition(
        within,
        facts({ now: at('18:14'), arrivedAt: arrived }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        within,
        facts({ now: at('18:15'), arrivedAt: arrived }),
      ),
    ).toBe(false);
    // Left again within the window.
    expect(
      evaluateCondition(
        within,
        facts({ now: at('18:10'), arrivedAt: arrived, home: 'away' }),
      ),
    ).toBe(false);
    // No arrival on record (a restart is not an arrival).
    expect(evaluateCondition(within, facts({ arrivedAt: null }))).toBe(false);
    expect(
      evaluateCondition(
        within,
        facts({ home: 'unknown', arrivedAt: arrived, now: at('18:01') }),
      ),
    ).toBeNull();
  });

  it('counts people and leaves an uncountable room undecided', () => {
    const crowd: Condition = { people: { atLeast: 2 } };
    expect(
      evaluateCondition(
        crowd,
        facts({ room: { presence: 'occupied', people: 3 } }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        crowd,
        facts({ room: { presence: 'occupied', people: 1 } }),
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        crowd,
        facts({ room: { presence: 'occupied', people: null } }),
      ),
    ).toBeNull();
    expect(
      evaluateCondition(
        { people: { atMost: 0 } },
        facts({ room: { presence: 'confirmed_empty', people: 0 } }),
      ),
    ).toBe(true);
  });

  it('reads the room as occupied, empty or unknown', () => {
    const empty = facts({ room: { presence: 'confirmed_empty', people: 0 } });
    expect(evaluateCondition({ room: 'empty' }, empty)).toBe(true);
    expect(evaluateCondition({ room: 'occupied' }, empty)).toBe(false);
    const unknown = facts({ room: { presence: 'unknown', people: null } });
    expect(evaluateCondition({ room: 'empty' }, unknown)).toBeNull();
    expect(evaluateCondition({ room: 'unknown' }, unknown)).toBe(true);
  });

  it('asks whether someone is at a computer, any or a named one', () => {
    const f = facts({ computers: { desktop: 'active', laptop: 'idle' } });
    expect(evaluateCondition({ computer: { is: 'active' } }, f)).toBe(true);
    expect(
      evaluateCondition({ computer: { device: 'laptop', is: 'active' } }, f),
    ).toBe(false);
    expect(
      evaluateCondition({ computer: { device: 'tablet', is: 'active' } }, f),
    ).toBeNull();
    // One computer unknown could still be the active one.
    expect(
      evaluateCondition(
        { computer: { is: 'active' } },
        facts({ computers: { desktop: 'unknown', laptop: 'idle' } }),
      ),
    ).toBeNull();
    expect(
      evaluateCondition({ computer: { is: 'active' } }, facts()),
    ).toBeNull();
  });

  it('handles time windows, including past midnight and weekdays', () => {
    const night: Condition = { time: { from: '22:00', to: '06:00' } };
    const check = (hhmm: string, day?: string) =>
      evaluateCondition(night, facts({ clock: stockholmClock(at(hhmm, day)) }));
    expect(check('21:59')).toBe(false);
    expect(check('22:00')).toBe(true);
    expect(check('03:00')).toBe(true);
    expect(check('06:00')).toBe(false);
    // The days name the day a window starts on: Friday night runs to Saturday.
    const fridayNight: Condition = {
      time: { from: '22:00', to: '06:00', days: ['fri'] },
    };
    const when = (hhmm: string, day: string) =>
      evaluateCondition(
        fridayNight,
        facts({ clock: stockholmClock(at(hhmm, day)) }),
      );
    expect(when('23:00', '2026-11-27')).toBe(true); // Friday
    expect(when('02:00', '2026-11-28')).toBe(true); // Saturday morning
    expect(when('23:00', '2026-11-28')).toBe(false); // Saturday night
    expect(when('02:00', '2026-11-27')).toBe(false); // Friday morning
  });

  it('selects by hub id and role', () => {
    expect(evaluateCondition({ hub: { role: 'bed' } }, facts())).toBe(true);
    expect(evaluateCondition({ hub: { id: 'desk' } }, facts())).toBe(false);
    expect(
      evaluateCondition({ hub: { id: 'bed', role: 'desk' } }, facts()),
    ).toBe(false);
  });
});

describe('rule schema', () => {
  it('accepts a rule and fills in defaults', () => {
    const [rule] = parse([
      { id: 'away-clock', when: { home: 'away' }, then: { only: ['clock'] } },
    ]);
    expect(rule).toMatchObject({
      enabled: true,
      priority: 0,
      holdMinutes: 0,
    });
  });

  it.each([
    [
      'unknown condition keys',
      { when: { weather: 'rain' }, then: { dim: 0.5 } },
    ],
    [
      'two keys in one condition',
      { when: { home: 'away', room: 'empty' }, then: { dim: 0.5 } },
    ],
    ['an empty all', { when: { all: [] }, then: { dim: 0.5 } }],
    ['an unknown page', { when: { home: 'away' }, then: { hide: ['stereo'] } }],
    ['no effect', { when: { home: 'away' }, then: {} }],
    ['people without a bound', { when: { people: {} }, then: { dim: 0.5 } }],
    [
      'an empty time window',
      { when: { time: { from: '07:00', to: '07:00' } }, then: { dim: 0.5 } },
    ],
    [
      'a malformed time',
      { when: { time: { from: '7:00', to: '8:00' } }, then: { dim: 0.5 } },
    ],
    ['dim to black', { when: { home: 'away' }, then: { dim: 0 } }],
    ['a bad tag', { when: { home: 'away' }, then: { tags: ['Night'] } }],
  ])('rejects %s', (_name, rule) => {
    expect(HubRulesSchema.safeParse([{ id: 'x', ...rule }]).success).toBe(
      false,
    );
  });

  it('rejects duplicate ids', () => {
    const rule = { id: 'x', when: { home: 'away' }, then: { dim: 0.5 } };
    expect(HubRulesSchema.safeParse([rule, rule]).success).toBe(false);
  });
});

describe('composing a policy', () => {
  const rules = parse([
    { id: 'a', when: { home: 'away' }, then: { hide: ['kameror'] } },
    {
      id: 'b',
      priority: 5,
      when: { home: 'away' },
      then: { only: ['clock', 'kameror', 'foto'], dim: 0.6, tags: ['away'] },
    },
    {
      id: 'c',
      when: { home: 'away' },
      then: { only: ['clock', 'music'], dim: 0.3, tags: ['calm'] },
    },
  ]);

  it('is neutral when nothing applies', () => {
    expect(composeHubPolicy(rules, new Map())).toBe(NEUTRAL_HUB_POLICY);
  });

  it('hides win, only intersects, dim takes the darkest, tags are a union', () => {
    const policy = composeHubPolicy(
      rules,
      new Map([
        ['a', 1],
        ['b', 1],
        ['c', 1],
      ]),
    );
    expect(policy.pages).toEqual(['clock']);
    expect(policy.dim).toBe(0.3);
    expect(policy.tags).toEqual(['away', 'calm']);
    // Applied by priority, then config order.
    expect(policy.rules).toEqual(['a', 'c', 'b']);
  });

  it('lets the later rule win a focus and drops a focus on a hidden page', () => {
    const focusing = parse([
      {
        id: 'first',
        when: { home: 'home' },
        then: { focus: { page: 'foto' } },
      },
      {
        id: 'second',
        when: { home: 'home' },
        then: { focus: { page: 'clock', returnTo: 'home' } },
      },
      { id: 'ban', when: { home: 'home' }, then: { hide: ['clock'] } },
    ]);
    expect(
      composeHubPolicy(
        focusing,
        new Map([
          ['first', 10],
          ['second', 20],
        ]),
      ).focus,
    ).toEqual({
      page: 'clock',
      returnTo: 'home',
      fromPages: null,
      idleSeconds: null,
      rule: 'second',
      token: 'second@20',
    });
    expect(
      composeHubPolicy(
        focusing,
        new Map([
          ['second', 20],
          ['ban', 20],
        ]),
      ).focus,
    ).toBeNull();
  });

  it('ignores restrictions that would leave no page', () => {
    const none = parse([
      {
        id: 'bad',
        when: { home: 'home' },
        then: { only: ['clock'], hide: ['clock'] },
      },
    ]);
    expect(composeHubPolicy(none, new Map([['bad', 1]])).pages).toBeNull();
  });
});

function roomState(overrides: {
  home?: 'home' | 'away' | 'unknown';
  arrivedAt?: number | null;
  presence?: 'occupied' | 'confirmed_empty' | 'unknown';
  personCount?: number | null;
  computers?: RoomState['computer']['devices'];
  lamps?: Record<string, unknown>;
  music?: Record<string, unknown>;
}): RoomState {
  // Only the parts the rules read; the rest of a RoomState is irrelevant here.
  return {
    revision: 1,
    updatedAt: 0,
    session: null,
    presence: {
      state: overrides.presence ?? 'occupied',
      personCount: overrides.personCount ?? 1,
      continuityExpiresAt: null,
      home: {
        state: overrides.home ?? 'home',
        observedAt: 1,
        arrivedAt: overrides.arrivedAt ?? null,
      },
    },
    lighting: {
      currentScene: null,
      sceneRevision: 0,
      devices: overrides.lamps ?? {},
    },
    switches: {},
    music: { devices: overrides.music ?? {} },
    computer: { devices: overrides.computers ?? {} },
    commands: [],
    diagnostics: [],
    timings: [],
  } as unknown as RoomState;
}

describe('HubPolicyEngine', () => {
  const bed = { id: 'bed', role: 'bed' as const };
  const desk = { id: 'desk', role: 'desk' as const };

  it('is neutral and cheap without rules', () => {
    const engine = new HubPolicyEngine([]);
    expect(engine.hasRules).toBe(false);
    expect(engine.evaluate(bed, roomState({}), at('20:00'))).toBe(
      NEUTRAL_HUB_POLICY,
    );
  });

  it('plays out the examples: away, arrival, hubs, desk, crowd and night', () => {
    const engine = new HubPolicyEngine(
      parse([
        {
          id: 'away-calm',
          description: 'Away: only the clock, dimmed',
          when: { home: 'away' },
          then: { only: ['clock'], dim: 0.5, tags: ['away'] },
        },
        {
          id: 'welcome-home',
          description: 'First 15 minutes after coming home: the photos',
          when: { arrived: { withinMinutes: 15 } },
          then: { focus: { page: 'foto', returnTo: 'home' } },
        },
        {
          id: 'desk-cameras',
          hubs: { role: 'desk' },
          when: { computer: { is: 'active' } },
          then: { focus: { page: 'kameror' } },
        },
        {
          id: 'bed-no-cameras',
          hubs: { role: 'bed' },
          when: { home: 'home' },
          then: { hide: ['kameror'] },
        },
        {
          id: 'crowded',
          when: { people: { atLeast: 2 } },
          then: { tags: ['crowded'] },
        },
        {
          id: 'night',
          hubs: { role: 'bed' },
          when: { time: { from: '22:30', to: '06:30' } },
          then: { dim: 0.25, tags: ['night'], hide: ['info'] },
        },
      ]),
    );

    // Away: the screen goes quiet on both Hubs.
    const away = roomState({ home: 'away', presence: 'confirmed_empty' });
    expect(engine.evaluate(bed, away, at('14:00'))).toMatchObject({
      pages: ['clock'],
      dim: 0.5,
      tags: ['away'],
      focus: null,
    });
    expect(engine.evaluate(desk, away, at('14:00')).pages).toEqual(['clock']);

    // Back home: the photos are offered, tied to this arrival.
    const arrived = at('18:00');
    const home = roomState({ arrivedAt: arrived });
    const first = engine.evaluate(bed, home, at('18:01'));
    expect(first.focus).toMatchObject({ page: 'foto', returnTo: 'home' });
    expect(first.pages).toEqual([
      'home',
      'music',
      'foto',
      'clock',
      'info',
      'installningar',
    ]);
    expect(first.tags).toEqual([]);
    // The same activation keeps the same token, so a Hub acts on it once.
    expect(engine.evaluate(bed, home, at('18:10')).focus?.token).toBe(
      first.focus?.token,
    );
    // After fifteen minutes the offer ends.
    expect(engine.evaluate(bed, home, at('18:16')).focus).toBeNull();
    // A new arrival is a new activation.
    const later = roomState({ arrivedAt: at('21:00') });
    const again = engine.evaluate(bed, later, at('21:01'));
    expect(again.focus?.token).not.toBe(first.focus?.token);

    // The desk Hub follows the computer; the bed Hub does not see it.
    const sitting = roomState({
      computers: {
        desktop: {
          deviceId: 'desktop',
          availability: 'online',
          freshness: 'fresh',
          reason: 'live',
          observedAt: 1,
          receivedAt: 1,
          sessionId: null,
          sequence: null,
          observed: {
            networkOnline: true,
            locked: false,
            idle: false,
            activeApplication: null,
            fullscreen: null,
            audio: null,
            media: null,
          },
          activity: {
            classification: 'desktop',
            source: 'desktop-agent',
            basis: null,
          },
          lastEvent: null,
        },
      },
    });
    expect(engine.evaluate(desk, sitting, at('19:00')).focus?.page).toBe(
      'kameror',
    );
    expect(engine.evaluate(bed, sitting, at('19:00')).focus).toBeNull();

    // Several people: a label for the page to react to.
    expect(
      engine.evaluate(desk, roomState({ personCount: 3 }), at('19:00')).tags,
    ).toEqual(['crowded']);

    // Night on the bed Hub only.
    const night = engine.evaluate(bed, roomState({}), at('23:15'));
    expect(night).toMatchObject({ dim: 0.25, tags: ['night'] });
    expect(night.pages).not.toContain('info');
    expect(engine.evaluate(desk, roomState({}), at('23:15')).dim).toBe(1);
  });

  it('does not act on unknown home status', () => {
    const engine = new HubPolicyEngine(
      parse([
        { id: 'away', when: { home: 'away' }, then: { only: ['clock'] } },
      ]),
    );
    expect(
      engine.evaluate(bed, roomState({ home: 'unknown' }), at('12:00')).pages,
    ).toBeNull();
  });

  it('holds a rule for its hold time after the condition stops', () => {
    const engine = new HubPolicyEngine(
      parse([
        {
          id: 'crowd',
          when: { people: { atLeast: 2 } },
          then: { tags: ['crowded'] },
          holdMinutes: 5,
        },
      ]),
    );
    const two = roomState({ personCount: 2 });
    const one = roomState({ personCount: 1 });
    expect(engine.evaluate(bed, two, at('19:00')).tags).toEqual(['crowded']);
    expect(engine.evaluate(bed, one, at('19:03')).tags).toEqual(['crowded']);
    expect(engine.evaluate(bed, one, at('19:06')).tags).toEqual([]);
  });

  it('keeps each hub’s activations apart', () => {
    const engine = new HubPolicyEngine(
      parse([
        {
          id: 'crowd',
          when: { people: { atLeast: 2 } },
          then: { focus: { page: 'foto' } },
        },
      ]),
    );
    const two = roomState({ personCount: 2 });
    const a = engine.evaluate(bed, two, at('19:00'));
    const b = engine.evaluate(desk, two, at('19:30'));
    expect(a.focus?.token).toBe(`crowd@${at('19:00')}`);
    expect(b.focus?.token).toBe(`crowd@${at('19:30')}`);
  });

  it('reads a stale or locked computer as not active', () => {
    const base = roomState({}).computer.devices;
    expect(base).toEqual({});
    const reading = (patch: Record<string, unknown>) =>
      ({
        deviceId: 'desktop',
        availability: 'online',
        freshness: 'fresh',
        reason: 'live',
        observedAt: 1,
        receivedAt: 1,
        sessionId: null,
        sequence: null,
        observed: {
          networkOnline: true,
          locked: false,
          idle: false,
          activeApplication: null,
          fullscreen: null,
          audio: null,
          media: null,
        },
        activity: {
          classification: 'desktop',
          source: 'desktop-agent',
          basis: null,
        },
        lastEvent: null,
        ...patch,
      }) as never;
    expect(computerFact(reading({}))).toBe('active');
    expect(computerFact(reading({ freshness: 'stale' }))).toBe('unknown');
    expect(computerFact(reading({ availability: 'offline' }))).toBe('offline');
    expect(
      computerFact(
        reading({
          observed: { locked: true, idle: false },
        }),
      ),
    ).toBe('locked');
    expect(
      computerFact(
        reading({
          observed: { locked: false, idle: true },
        }),
      ),
    ).toBe('idle');
  });
});

describe('lights, music, scenes and greeting days', () => {
  const bed = { id: 'bed', role: 'bed' as const };
  const lamp = (power: boolean) => ({
    availability: 'available',
    observed: { power },
  });
  const player = (playback: string) => ({
    availability: 'available',
    observed: { playback },
  });

  it('reads the lamps and the music as true, false or unknown', () => {
    const on = facts({ lights: { anyOn: true, firstOnToday: at('07:00') } });
    expect(evaluateCondition({ lights: 'on' }, on)).toBe(true);
    expect(evaluateCondition({ lights: 'off' }, on)).toBe(false);
    expect(evaluateCondition({ lights: 'off' }, facts())).toBeNull(); // no reading: neither
    expect(
      evaluateCondition(
        { lightsOnFor: { atLeastMinutes: 15 } },
        facts({
          now: at('07:20'),
          lights: { anyOn: true, firstOnToday: at('07:00') },
        }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { lightsOnFor: { atLeastMinutes: 15 } },
        facts({
          now: at('07:10'),
          lights: { anyOn: true, firstOnToday: at('07:00') },
        }),
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { lightsOnFor: { atLeastMinutes: 15 } },
        facts({ lights: { anyOn: false, firstOnToday: null } }),
      ),
    ).toBe(false);
    expect(evaluateCondition({ music: 'playing' }, facts())).toBeNull();
    expect(
      evaluateCondition({ music: 'playing' }, facts({ musicPlaying: true })),
    ).toBe(true);
    expect(
      evaluateCondition({ music: 'quiet' }, facts({ musicPlaying: true })),
    ).toBe(false);
  });

  it('keeps conditional pages out unless a rule shows them', () => {
    const rules = parse([
      { id: 'pc', when: { home: 'home' }, then: { show: ['dator'] } },
    ]);
    expect(composeHubPolicy(rules, new Map()).pages).toBeNull();
    expect(composeHubPolicy(rules, new Map([['pc', 1]])).pages).toEqual([
      'home',
      'music',
      'foto',
      'kameror',
      'clock',
      'dator',
      'info',
      'installningar',
    ]);
    // Hiding beats showing.
    const hidden = parse([
      { id: 'pc', when: { home: 'home' }, then: { show: ['dator'] } },
      { id: 'no', when: { home: 'home' }, then: { hide: ['dator'] } },
    ]);
    expect(
      composeHubPolicy(
        hidden,
        new Map([
          ['pc', 1],
          ['no', 1],
        ]),
      ).pages,
    ).toBeNull();
  });

  it('turns a scene into a page, a focus and, at night, a lock', () => {
    const rules = parse([
      { id: 'morning', when: { home: 'home' }, then: { scene: 'godmorgon' } },
      {
        id: 'night',
        priority: 5,
        when: { home: 'home' },
        then: { scene: 'natt' },
      },
    ]);
    const skin = { id: 'jul' };
    const morning = composeHubPolicy(rules, new Map([['morning', 7]]), skin);
    expect(morning.scene).toEqual({ kind: 'godmorgon', skin, rule: 'morning' });
    expect(morning.pages).toContain('halsning');
    expect(morning.focus).toMatchObject({
      page: 'halsning',
      returnTo: 'home',
      token: 'morning@7',
    });
    // The higher-priority scene wins, locks the Hub and carries no skin.
    const night = composeHubPolicy(
      rules,
      new Map([
        ['morning', 7],
        ['night', 9],
      ]),
      skin,
    );
    expect(night.scene).toEqual({ kind: 'natt', skin: null, rule: 'night' });
    expect(night.pages).toEqual(['halsning']);
    expect(night.focus?.token).toBe('night@9');
  });

  it('locks the Hub to the night sheet only while it is the scene that wins', () => {
    const rules = parse([
      {
        id: 'night',
        priority: 10,
        when: { home: 'home' },
        then: { scene: 'natt' },
      },
      {
        id: 'bedtime',
        priority: 20,
        when: { home: 'home' },
        then: { scene: 'godnatt' },
      },
    ]);
    const both = composeHubPolicy(
      rules,
      new Map([
        ['night', 1],
        ['bedtime', 2],
      ]),
    );
    expect(both.scene?.kind).toBe('godnatt');
    expect(both.pages).toContain('music');
    expect(composeHubPolicy(rules, new Map([['night', 1]])).pages).toEqual([
      'halsning',
    ]);
  });

  it('carries the limits of a focus to the Hub', () => {
    const rules = parse([
      {
        id: 'music',
        when: { music: 'playing' },
        then: {
          focus: {
            page: 'music',
            fromPages: ['home', 'foto'],
            idleSeconds: 30,
          },
        },
      },
    ]);
    expect(
      composeHubPolicy(rules, new Map([['music', 3]])).focus,
    ).toMatchObject({
      page: 'music',
      fromPages: ['home', 'foto'],
      idleSeconds: 30,
    });
  });

  it('runs the morning, the night and the music through the engine', () => {
    const engine = new HubPolicyEngine(
      parse([
        {
          id: 'godmorgon',
          priority: 10,
          when: {
            all: [
              { home: 'home' },
              { time: { from: '06:00', to: '11:00' } },
              { not: { lightsOnFor: { atLeastMinutes: 15 } } },
            ],
          },
          then: { scene: 'godmorgon' },
        },
        {
          id: 'musik',
          when: { music: 'playing' },
          holdMinutes: 2,
          then: { focus: { page: 'music', fromPages: ['home'] } },
        },
      ]),
    );
    const dark = roomState({ lamps: { l: lamp(false) } });
    const lit = roomState({ lamps: { l: lamp(true) } });
    // 06:05, lamps off: the morning is on (it ends 15 minutes after the lamps).
    expect(engine.evaluate(bed, dark, at('06:05')).scene?.kind).toBe(
      'godmorgon',
    );
    expect(engine.evaluate(bed, lit, at('06:30')).scene?.kind).toBe(
      'godmorgon',
    );
    expect(engine.evaluate(bed, lit, at('06:44')).scene?.kind).toBe(
      'godmorgon',
    );
    expect(engine.evaluate(bed, lit, at('06:46')).scene).toBeNull();
    // A new day starts the reading over (06:00): lamps seen on at 06:20.
    const next = '2026-11-25';
    expect(engine.evaluate(bed, dark, at('05:00', next)).scene).toBeNull();
    expect(engine.evaluate(bed, dark, at('06:01', next)).scene?.kind).toBe(
      'godmorgon',
    );

    const playing = roomState({ music: { p: player('playing') } });
    const first = engine.evaluate(bed, playing, at('12:00')).focus;
    expect(first?.page).toBe('music');
    // Paused for a minute: still the same activation, so no new focus token.
    const paused = roomState({ music: { p: player('paused') } });
    expect(engine.evaluate(bed, paused, at('12:01')).focus?.token).toBe(
      first?.token,
    );
    // Silent for longer, then it starts again: a new token.
    expect(engine.evaluate(bed, paused, at('12:10')).focus).toBeNull();
    expect(engine.evaluate(bed, playing, at('12:11')).focus?.token).not.toBe(
      first?.token,
    );
  });
});

describe('the first lamp turned on in the morning', () => {
  const bed = { id: 'bed', role: 'bed' as const };
  const lamps = (a: boolean, b = false) =>
    roomState({
      lamps: {
        a: { availability: 'available', observed: { power: a } },
        b: { availability: 'available', observed: { power: b } },
      },
    });
  const morning = () =>
    new HubPolicyEngine(
      parse([
        {
          id: 'godmorgon',
          when: {
            all: [
              { time: { from: '06:00', to: '11:00' } },
              { not: { lightsOnFor: { atLeastMinutes: 15 } } },
            ],
          },
          then: { scene: 'godmorgon' },
        },
      ]),
    );

  it('does not count a lamp left on overnight', () => {
    const engine = morning();
    engine.evaluate(bed, lamps(true), at('05:50'));
    engine.evaluate(bed, lamps(true), at('06:00'));
    expect(engine.evaluate(bed, lamps(true), at('09:00')).scene?.kind).toBe(
      'godmorgon',
    );
  });

  it('counts a second lamp turned on beside one left on', () => {
    const engine = morning();
    engine.evaluate(bed, lamps(true), at('06:00'));
    engine.evaluate(bed, lamps(true, true), at('07:00'));
    expect(
      engine.evaluate(bed, lamps(true, true), at('07:14')).scene?.kind,
    ).toBe('godmorgon');
    expect(
      engine.evaluate(bed, lamps(true, true), at('07:16')).scene,
    ).toBeNull();
  });

  it('does not count a lamp turned on before six', () => {
    const engine = morning();
    engine.evaluate(bed, lamps(false), at('05:00'));
    engine.evaluate(bed, lamps(true), at('05:30'));
    expect(engine.evaluate(bed, lamps(true), at('08:00')).scene?.kind).toBe(
      'godmorgon',
    );
  });
});

describe('film, air and the switches', () => {
  const bed = { id: 'bed', role: 'bed' as const };
  const computer = (observed: Record<string, unknown>, freshness = 'fresh') =>
    ({
      ...roomState({}),
      computer: {
        devices: {
          pc: { availability: 'online', freshness, observed },
        },
      },
    }) as unknown as RoomState;
  const film = {
    locked: false,
    fullscreen: true,
    audio: { playing: true },
    media: [],
  };

  it('knows a film from a silent full screen, a window and a stale report', () => {
    expect(watchingFact(computer(film))).toBe(true);
    expect(
      watchingFact(
        computer({
          ...film,
          audio: { playing: false },
          media: [{ playback: 'playing' }],
        }),
      ),
    ).toBe(true);
    expect(watchingFact(computer({ ...film, audio: { playing: false } }))).toBe(
      false,
    );
    expect(watchingFact(computer({ ...film, fullscreen: false }))).toBe(false);
    expect(watchingFact(computer({ ...film, locked: true }))).toBe(false);
    expect(watchingFact(computer(film, 'stale'))).toBeNull();
    expect(watchingFact(roomState({}))).toBeNull();
  });

  const airRules = parse([
    { id: 'vadra', when: { air: 'stuffy' }, then: { tags: ['vadra'] } },
  ]);

  it('asks for air after ten minutes over the level, until well under it', () => {
    const engine = new HubPolicyEngine(airRules);
    const tags = (time: string, value: number) =>
      engine.evaluate(bed, roomState({}), at(time), {
        value,
        observedAt: at(time),
      }).tags;
    expect(tags('12:00', 1100)).toEqual([]);
    expect(tags('12:09', 1100)).toEqual([]);
    expect(tags('12:10', 1100)).toEqual(['vadra']);
    expect(tags('12:11', 850)).toEqual(['vadra']);
    expect(tags('12:12', 790)).toEqual([]);
    // A dip starts the ten minutes over.
    expect(tags('13:00', 1100)).toEqual([]);
    expect(tags('13:05', 990)).toEqual([]);
    expect(tags('13:12', 1100)).toEqual([]);
  });

  it('says nothing about old air or when the reminder is off', () => {
    let airPpm = 1000;
    const engine = new HubPolicyEngine(airRules, undefined, () => ({
      airPpm,
      film: true,
      away: true,
    }));
    const tags = (time: string, observedAt: string) =>
      engine.evaluate(bed, roomState({}), at(time), {
        value: 1500,
        observedAt: at(observedAt),
      }).tags;
    tags('12:00', '12:00');
    expect(tags('12:10', '12:10')).toEqual(['vadra']);
    expect(tags('13:00', '12:10')).toEqual([]);
    tags('14:00', '14:00');
    airPpm = 0;
    expect(tags('14:15', '14:15')).toEqual([]);
  });

  it('drops a switched-off rule at once, whatever it holds', () => {
    let on = true;
    const engine = new HubPolicyEngine(
      parse([
        {
          id: 'film',
          switch: 'film',
          holdMinutes: 5,
          when: { watching: true },
          then: { dim: 0.55 },
        },
      ]),
      undefined,
      () => ({ airPpm: 1000, film: on, away: true }),
    );
    expect(engine.evaluate(bed, computer(film), at('20:00')).dim).toBe(0.55);
    on = false;
    expect(engine.evaluate(bed, computer(film), at('20:01')).dim).toBe(1);
  });
});

describe('greeting days', () => {
  const day = (iso: string) => Date.parse(`${iso}T12:00:00+01:00`);
  const none = { birthdays: [], days: [] };

  it('knows the calendar, Easter and Midsummer included', () => {
    expect(greetingSkin(day('2026-12-24'), none)?.id).toBe('jul');
    expect(greetingSkin(day('2026-12-31'), none)?.id).toBe('nyar');
    expect(greetingSkin(day('2027-01-01'), none)?.id).toBe('nyar');
    expect(greetingSkin(day('2026-12-30'), none)).toBeNull();
    expect(greetingSkin(day('2026-12-13'), none)?.id).toBe('lucia');
    expect(greetingSkin(day('2026-11-24'), none)).toBeNull();
    // Easter Sunday 2026 is 5 April; the Eve is the day before.
    expect(greetingSkin(day('2026-04-05'), none)?.id).toBe('pask');
    expect(greetingSkin(day('2026-04-04'), none)?.id).toBe('pask');
    expect(greetingSkin(day('2026-04-06'), none)).toBeNull();
    // Midsummer Eve 2026 is Friday 19 June, the Day Saturday 20 June.
    const midsummer = (iso: string) => Date.parse(`${iso}T12:00:00+02:00`);
    expect(greetingSkin(midsummer('2026-06-19'), none)?.id).toBe('midsommar');
    expect(greetingSkin(midsummer('2026-06-20'), none)?.id).toBe('midsommar');
    expect(greetingSkin(midsummer('2026-06-26'), none)).toBeNull();
    // All Saints' Day 2026 is Saturday 7 November? No: 31 Oct-6 Nov, so 31 Oct.
    expect(greetingSkin(day('2026-10-31'), none)?.id).toBe('allahelgon');
  });

  it('puts a birthday first and counts the age', () => {
    const config = {
      birthdays: [
        { name: 'Alva', date: '2000-12-24' },
        { name: 'Alma', date: '03-14' },
      ],
      days: [{ title: 'Flyttdagen', date: '05-02' }],
    };
    expect(greetingSkin(day('2026-12-24'), config)).toEqual({
      id: 'fodelsedag',
      name: 'Alva',
      age: 26,
    });
    expect(greetingSkin(day('2026-03-14'), config)).toEqual({
      id: 'fodelsedag',
      name: 'Alma',
    });
    expect(greetingSkin(day('2026-05-02'), config)).toEqual({
      id: 'egen',
      title: 'Flyttdagen',
    });
  });
});
