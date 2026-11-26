import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const policyScript = readFileSync(
  new URL('../src/ui/hub-policy.js', import.meta.url),
  'utf8',
);
const chipScript = readFileSync(
  new URL('../src/ui/presence-chip.js', import.meta.url),
  'utf8',
);

type Timer = { at: number; fn: () => void; id: number };
function clock() {
  let now = 0;
  let id = 0;
  const timers: Timer[] = [];
  const frames: Array<() => void> = [];
  return {
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ at: now + ms, fn, id: ++id });
      return id;
    },
    clearTimeout: (value: number) => {
      const i = timers.findIndex((t) => t.id === value);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval: (fn: () => void, ms: number) => {
      const tick = () => {
        fn();
        timers.push({ at: now + ms, fn: tick, id });
      };
      timers.push({ at: now + ms, fn: tick, id: ++id });
      return id;
    },
    clearInterval: (value: number) => {
      for (let i = timers.length - 1; i >= 0; i -= 1)
        if (timers[i]!.id === value) timers.splice(i, 1);
    },
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    now: () => now,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => t.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
      now = end;
      for (const fn of frames.splice(0)) fn();
    },
  };
}

class El {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  hidden = false;
  disabled = false;
  textContent = '';
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<() => void>>();
  children = new Map<string, El>();
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click() {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  querySelector(selector: string) {
    const found = this.children.get(selector);
    if (found) return found;
    const created = new El();
    this.children.set(selector, created);
    return created;
  }
}

describe('hub-policy.js', () => {
  function setup(
    options: { go?: (page: string) => boolean; search?: string } = {},
  ) {
    const time = clock();
    const sheet = new El();
    const root = new El();
    const calls: string[] = [];
    let current = 'home';
    let busy = false;
    const greetings: unknown[] = [];
    const lugnPages = {
      all: () => [
        'home',
        'halsning',
        'music',
        'foto',
        'kameror',
        'clock',
        'dator',
        'info',
      ],
      current: () => current,
      go: (page: string) => {
        calls.push(`go:${page}`);
        if (busy || (options.go && !options.go(page))) return false;
        current = page;
        return true;
      },
      setAvailable: (list: string[] | null) => {
        calls.push(`pages:${list === null ? 'all' : list.join(',')}`);
        return !busy;
      },
    };
    const window = {
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout,
      requestAnimationFrame: time.requestAnimationFrame,
      performance: { now: time.now },
    };
    const context = createContext({
      window,
      URLSearchParams,
      location: { hash: options.search ?? '' },
      document: {
        documentElement: root,
        getElementById: (id: string) => (id === 'hub-dim' ? sheet : null),
      },
      lugnPages,
      lugnGreeting: {
        // Like the real one, it ignores a scene it already has.
        setScene: (scene: unknown) => {
          if (
            JSON.stringify(greetings.at(-1)) !== JSON.stringify(scene) ||
            greetings.length === 0
          )
            greetings.push(scene);
        },
      },
    });
    (context as Record<string, unknown>)['globalThis'] = context;
    runInContext(policyScript, context);
    const policy = (context as Record<string, unknown>)['lugnHubPolicy'] as {
      apply(policy: unknown): void;
      touch(): void;
    };
    return {
      apply: policy.apply,
      touch: policy.touch,
      greetings,
      advance: time.advance,
      calls,
      sheet,
      root,
      setBusy: (value: boolean) => (busy = value),
      move: (page: string) => (current = page),
      current: () => current,
    };
  }

  it('applies pages, tags and dimming, and clears them again', () => {
    const t = setup();
    t.apply({
      pages: ['home', 'clock'],
      dim: 0.4,
      tags: ['night', 'quiet'],
      focus: null,
    });
    t.advance(20);
    expect(t.calls).toContain('pages:home,clock');
    expect(t.root.dataset['hubTags']).toBe('night quiet');
    expect(t.sheet.hidden).toBe(false);
    expect(t.sheet.style['opacity']).toBe('0.6');
    t.apply(undefined);
    t.advance(2000);
    expect(t.calls.at(-1)).toBe('pages:all');
    expect(t.root.dataset['hubTags']).toBeUndefined();
    expect(t.sheet.style['opacity']).toBe('0');
    expect(t.sheet.hidden).toBe(true);
  });

  it('lights a slightly dimmed screen for half a minute after a touch', () => {
    const t = setup();
    t.apply({ pages: null, dim: 0.55, focus: null });
    t.advance(20);
    expect(t.sheet.style['pointerEvents']).toBe('none');
    t.touch();
    t.advance(2000);
    expect(t.sheet.style['opacity']).toBe('0');
    t.advance(30_000);
    expect(t.sheet.style['opacity']).toBe('0.45');
  });

  it('takes the first tap on a nearly black screen only to wake it', () => {
    const t = setup();
    t.apply({ pages: null, dim: 0.05, focus: null });
    t.advance(20);
    expect(t.sheet.style['pointerEvents']).toBe('auto');
    // A touch elsewhere does not wake it; one on the sheet does, a moment later.
    t.touch();
    t.advance(100);
    expect(t.sheet.style['opacity']).toBe('0.95');
    for (const fn of t.sheet.listeners.get('pointerup') ?? []) fn();
    t.advance(2000);
    expect(t.sheet.style['opacity']).toBe('0');
    expect(t.sheet.style['pointerEvents']).toBe('none');
    t.advance(31_000);
    expect(t.sheet.style['opacity']).toBe('0.95');
  });

  it('does not redo what has not changed', () => {
    const t = setup();
    const policy = { pages: ['home'], dim: 1, tags: [], focus: null };
    t.apply(policy);
    t.apply({ ...policy });
    expect(t.calls.filter((call) => call.startsWith('pages:'))).toHaveLength(1);
  });

  it('asks the pager again while a finger is moving the pages', () => {
    const t = setup();
    t.setBusy(true);
    t.apply({ pages: ['home'], dim: 1, tags: [], focus: null });
    t.advance(1000);
    const attempts = t.calls.filter((call) => call.startsWith('pages:'));
    expect(attempts.length).toBeGreaterThan(1);
    t.setBusy(false);
    t.advance(600);
    const last = t.calls.filter((call) => call.startsWith('pages:')).length;
    t.advance(5000);
    expect(t.calls.filter((call) => call.startsWith('pages:'))).toHaveLength(
      last,
    );
  });

  it('goes to a focus page once per activation and leaves a swipe alone', () => {
    const t = setup();
    const focus = { page: 'foto', returnTo: null, rule: 'r', token: 'r@1' };
    t.apply({ pages: null, dim: 1, tags: [], focus });
    expect(t.current()).toBe('foto');
    // The person swipes back to Hem; the same activation does not pull them.
    t.move('home');
    t.apply({ pages: null, dim: 1, tags: [], focus });
    t.apply({ pages: null, dim: 1, tags: [], focus });
    expect(t.current()).toBe('home');
    // The rule starts again: a new token.
    t.apply({
      pages: null,
      dim: 1,
      tags: [],
      focus: { ...focus, token: 'r@2' },
    });
    expect(t.current()).toBe('foto');
  });

  it('returns when the rule ends, only if the page is still the one shown', () => {
    const t = setup();
    const focus = { page: 'foto', returnTo: 'home', rule: 'r', token: 'r@1' };
    t.apply({ pages: null, dim: 1, tags: [], focus });
    expect(t.current()).toBe('foto');
    t.advance(31_000);
    t.apply({ pages: null, dim: 1, tags: [], focus: null });
    expect(t.current()).toBe('home');

    t.apply({
      pages: null,
      dim: 1,
      tags: [],
      focus: { ...focus, token: 'r@2' },
    });
    expect(t.current()).toBe('foto');
    t.move('clock');
    t.apply({ pages: null, dim: 1, tags: [], focus: null });
    expect(t.current()).toBe('clock');
  });

  it('keeps trying while the pager is busy, then gives up on a stale focus', () => {
    const t = setup();
    t.setBusy(true);
    t.apply({
      pages: null,
      dim: 1,
      tags: [],
      focus: { page: 'foto', returnTo: null, rule: 'r', token: 'r@1' },
    });
    expect(t.current()).toBe('home');
    t.setBusy(false);
    t.advance(600);
    expect(t.current()).toBe('foto');

    // A newer activation replaces an older one that was still waiting.
    const u = setup();
    u.setBusy(true);
    u.apply({
      pages: null,
      dim: 1,
      tags: [],
      focus: { page: 'foto', returnTo: null, rule: 'r', token: 'r@1' },
    });
    u.apply({
      pages: null,
      dim: 1,
      tags: [],
      focus: { page: 'clock', returnTo: null, rule: 'q', token: 'q@2' },
    });
    u.setBusy(false);
    u.advance(600);
    expect(u.current()).toBe('clock');
  });

  it('hands the scene to the greeting page, once per change', () => {
    const t = setup();
    const scene = { kind: 'godnatt', skin: null, rule: 'night' };
    t.apply({
      pages: ['home', 'halsning'],
      dim: 1,
      tags: [],
      scene,
      focus: null,
    });
    t.apply({
      pages: ['home', 'halsning'],
      dim: 1,
      tags: [],
      scene,
      focus: null,
    });
    t.apply({ pages: null, dim: 1, tags: [], scene: null, focus: null });
    expect(t.greetings).toEqual([scene, null]);
  });

  it('drops a focus that comes from a page it may not take over from', () => {
    const t = setup();
    t.move('kameror');
    const offer = {
      page: 'music',
      returnTo: null,
      fromPages: ['home', 'foto'],
      idleSeconds: null,
      rule: 'm',
      token: 'm@1',
    };
    t.apply({ pages: null, dim: 1, tags: [], focus: offer });
    expect(t.current()).toBe('kameror');
    // Not kept for later either.
    t.move('home');
    t.advance(5000);
    t.apply({ pages: null, dim: 1, tags: [], focus: offer });
    expect(t.current()).toBe('home');
  });

  it('leaves a Hub alone that was touched a moment ago', () => {
    const t = setup();
    t.advance(60_000);
    t.touch();
    t.advance(10_000);
    const offer = {
      page: 'music',
      returnTo: 'home',
      fromPages: null,
      idleSeconds: 30,
      rule: 'm',
      token: 'm@1',
    };
    t.apply({ pages: null, dim: 1, tags: [], focus: offer });
    expect(t.current()).toBe('home');
    // A later activation, after the quiet has passed, is taken.
    t.advance(30_000);
    t.apply({
      pages: null,
      dim: 1,
      tags: [],
      focus: { ...offer, token: 'm@2' },
    });
    expect(t.current()).toBe('music');
  });

  it('does not take someone back from a page they chose themselves', () => {
    const t = setup();
    t.advance(60_000);
    const offer = {
      page: 'music',
      returnTo: 'home',
      fromPages: null,
      idleSeconds: null,
      rule: 'm',
      token: 'm@1',
    };
    // They are on Musik already when the music starts: it is theirs.
    t.move('music');
    t.apply({ pages: null, dim: 1, tags: [], focus: offer });
    t.advance(60_000);
    t.apply({ pages: null, dim: 1, tags: [], focus: null });
    expect(t.current()).toBe('music');
  });

  it('can be looked at with #scene= in the address', () => {
    const t = setup({
      search: '#scene=godnatt&skin=fodelsedag&name=Alva&age=32',
    });
    t.apply(undefined);
    expect(t.current()).toBe('halsning');
    expect(t.greetings[0]).toEqual({
      kind: 'godnatt',
      skin: { id: 'fodelsedag', name: 'Alva', age: 32 },
      rule: 'preview',
    });
    const pc = setup({ search: '#show=dator' });
    pc.apply(undefined);
    expect(pc.current()).toBe('dator');
  });
});

describe('hub-history.js and pages taken out by rules', () => {
  const script = readFileSync(
    new URL('../src/ui/hub-history.js', import.meta.url),
    'utf8',
  );

  function setup() {
    let current = 'home';
    let ids = ['home', 'halsning', 'music', 'clock'];
    const listeners = new Map<string, () => void>();
    const context = createContext({
      window: {
        addEventListener: (type: string, fn: () => void) =>
          listeners.set(type, fn),
      },
      lugnPages: {
        current: () => current,
        ids: () => ids,
        go: (page: string) => {
          if (!ids.includes(page)) return false;
          current = page;
          listeners.get('lugn:page')?.();
          return true;
        },
      },
    });
    (context as Record<string, unknown>)['globalThis'] = context;
    runInContext(script, context);
    const history = (context as Record<string, unknown>)['lugnHistory'] as {
      back(): boolean;
      forward(): boolean;
    };
    return {
      history,
      current: () => current,
      visit: (page: string) => {
        current = page;
        listeners.get('lugn:page')?.();
      },
      take: (page: string) => (ids = ids.filter((id) => id !== page)),
    };
  }

  it('goes back past a page that is gone instead of getting stuck on it', () => {
    const t = setup();
    t.visit('music');
    t.visit('halsning');
    t.visit('clock');
    t.take('halsning');
    expect(t.history.back()).toBe(true);
    expect(t.current()).toBe('music');
    expect(t.history.back()).toBe(true);
    expect(t.current()).toBe('home');
  });

  it('does not stop on the page already shown once the one between is gone', () => {
    const t = setup();
    t.visit('music');
    t.visit('clock');
    t.visit('halsning');
    t.visit('clock');
    t.take('halsning');
    expect(t.history.back()).toBe(true);
    expect(t.current()).toBe('music');
  });
});

describe('presence-chip.js', () => {
  function setup(page = 'music') {
    const time = clock();
    const chip = new El();
    chip.hidden = true;
    const button = new El();
    const parts = {
      '.pc-button': button,
      '.pc-count': new El(),
      '.pc-label': new El(),
      '.pc-time': new El(),
      '.pc-bar': new El(),
    };
    chip.children = new Map(Object.entries(parts));
    const commands: Array<[string, unknown]> = [];
    const pending = new Set<string>();
    const listeners = new Map<string, Array<() => void>>();
    let current = page;
    let serverNow = 1_000_000;
    const window = {
      setInterval: time.setInterval,
      clearInterval: time.clearInterval,
      addEventListener: (type: string, fn: () => void) =>
        listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    };
    const context = createContext({
      window,
      document: {
        getElementById: (id: string) => (id === 'presence-chip' ? chip : null),
      },
      lugnPages: { current: () => current },
      estimatedServerNow: () => serverNow,
      runCommand: (key: string, body: unknown) => {
        commands.push([key, body]);
        return Promise.resolve();
      },
      pending,
      presenceAcknowledgedKey: null,
    });
    (context as Record<string, unknown>)['globalThis'] = context;
    runInContext(chipScript, context);
    const api = (context as Record<string, unknown>)['lugnPresenceChip'] as {
      render(payload: unknown): void;
    };
    const payload = (presence: Record<string, unknown>, available = true) => ({
      presenceCountCorrectionAvailable: available,
      state: { presence },
    });
    return {
      chip,
      button,
      parts,
      commands,
      pending,
      render: (value: unknown) => api.render(value),
      payload,
      advance: time.advance,
      setServerNow: (value: number) => (serverNow = value),
      goTo: (value: string, latest: unknown) => {
        current = value;
        for (const fn of listeners.get('lugn:page') ?? []) fn();
        api.render(latest);
      },
    };
  }

  it('shows the count, quietly, and a tap corrects it', () => {
    const t = setup();
    t.render(t.payload({ state: 'occupied', personCount: 3 }));
    expect(t.chip.hidden).toBe(false);
    expect(t.chip.dataset['mode']).toBe('steady');
    expect(t.parts['.pc-count']!.textContent).toBe('3');
    expect(t.chip.dataset['tap']).toBe('true');
    expect(t.button.disabled).toBe(false);
    t.button.click();
    expect(t.commands).toEqual([['presence:one', {}]]);
  });

  it('is only a reading when the count is already one', () => {
    const t = setup();
    t.render(t.payload({ state: 'occupied', personCount: 1 }));
    expect(t.chip.dataset['tap']).toBe('false');
    expect(t.button.disabled).toBe(true);
    t.button.click();
    expect(t.commands).toEqual([]);
  });

  it('says “Jag är här” when the sensor sees nobody, with one tap', () => {
    const t = setup();
    t.render(t.payload({ state: 'confirmed_empty', personCount: 0 }));
    expect(t.chip.dataset['mode']).toBe('empty');
    expect(t.parts['.pc-label']!.textContent).toBe('Jag är här');
    expect(t.parts['.pc-time']!.textContent).toBe('');
    t.button.click();
    expect(t.commands).toEqual([['presence:one', {}]]);
  });

  it('counts down to the lights going out, a second at a time', () => {
    const t = setup();
    const presence = {
      state: 'occupied',
      personCount: 1,
      exitPending: { startedAt: 1_000_000 - 2_000, until: 1_000_000 + 38_000 },
    };
    t.render(t.payload(presence));
    expect(t.chip.dataset['mode']).toBe('leaving');
    expect(t.parts['.pc-label']!.textContent).toBe('Jag är kvar');
    expect(t.parts['.pc-time']!.textContent).toBe('0:38');
    expect(t.parts['.pc-bar']!.style['transform']).toBe('scaleX(0.95)');
    t.setServerNow(1_000_000 + 8_000);
    t.advance(1000);
    expect(t.parts['.pc-time']!.textContent).toBe('0:30');
    t.setServerNow(1_000_000 + 20_000);
    t.advance(1000);
    expect(t.parts['.pc-time']!.textContent).toBe('0:18');
    // The sensor sees someone again: back to the count, and the clock stops.
    t.render(t.payload({ state: 'occupied', personCount: 1 }));
    expect(t.chip.dataset['mode']).toBe('steady');
    t.setServerNow(1_000_000 + 30_000);
    t.advance(5000);
    expect(t.parts['.pc-time']!.textContent).toBe('');
  });

  it('formats minutes in the countdown', () => {
    const t = setup();
    t.render(
      t.payload({
        state: 'occupied',
        personCount: 1,
        exitPending: { startedAt: 1_000_000, until: 1_000_000 + 125_000 },
      }),
    );
    expect(t.parts['.pc-time']!.textContent).toBe('2:05');
  });

  it('waits for the sensor after a tap instead of letting a second one through', () => {
    const t = setup();
    t.render(t.payload({ state: 'confirmed_empty', personCount: 0 }));
    t.pending.add('presence:one');
    t.render(t.payload({ state: 'confirmed_empty', personCount: 0 }));
    expect(t.button.disabled).toBe(true);
    expect(t.button.attributes.get('aria-busy')).toBe('true');
    t.pending.delete('presence:one');
    t.render(t.payload({ state: 'confirmed_empty', personCount: 0 }));
    expect(t.button.disabled).toBe(false);
  });

  it('is not there without a sensor to correct, nor on Hem or Info', () => {
    const t = setup();
    t.render(t.payload({ state: 'occupied', personCount: 2 }, false));
    expect(t.chip.hidden).toBe(true);
    const latest = t.payload({ state: 'occupied', personCount: 2 });
    t.render(latest);
    expect(t.chip.hidden).toBe(false);
    t.goTo('home', latest);
    expect(t.chip.hidden).toBe(true);
    t.goTo('foto', latest);
    expect(t.chip.hidden).toBe(false);
    t.goTo('info', latest);
    expect(t.chip.hidden).toBe(true);
  });

  it('shows a question mark when the sensor cannot tell', () => {
    const t = setup();
    t.render(t.payload({ state: 'unknown', personCount: null }));
    expect(t.parts['.pc-count']!.textContent).toBe('?');
    expect(t.chip.dataset['mode']).toBe('steady');
    expect(t.chip.dataset['tap']).toBe('true');
  });
});
