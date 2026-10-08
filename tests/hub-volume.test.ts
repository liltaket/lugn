import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { FakeClock } from '../src/core/clock.js';

type Listener = (...args: unknown[]) => void;

/** Minimal DOM surface: real, unmodified display.js owns all UI/control logic. */
class Element {
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  textContent = '';
  className = '';
  hidden = true;
  disabled = false;
  value = '';
  children: Element[] = [];
  parentElement: Element | null = null;
  listeners = new Map<string, Listener>();
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
  };
  get firstElementChild(): Element | undefined {
    return this.children[0];
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }
  append(...children: Element[]): void {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: Element[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }
  remove(): void {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (child) => child !== this,
      );
    this.parentElement = null;
  }
  contains(element: Element): boolean {
    return (
      this === element || this.children.some((child) => child.contains(element))
    );
  }
  closest(selector: string): Element | undefined {
    return selector === 'button[data-scene]' && this.dataset['scene']
      ? this
      : this.parentElement?.closest(selector);
  }
  querySelector(selector: string): Element | undefined {
    return (
      this.children.find(
        (child) => child.className === selector.replace(/^\./, ''),
      ) ??
      this.children.map((child) => child.querySelector(selector)).find(Boolean)
    );
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }
  click(): void {
    if (this.disabled) return;
    this.dispatchClick({ target: this });
  }
  private dispatchClick(event: { target: Element }): void {
    this.listeners.get('click')?.(event);
    this.parentElement?.dispatchClick(event);
  }
}

async function microtasks(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function dashboard(initialVolume = 0.3, streaming = false) {
  const clock = new FakeClock(Date.parse('2026-10-03T12:00:00Z'));
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { 'music.room': ['Optical'] }, adapter },
  });
  const registry = new CapabilityRegistry(engine);
  adapter.observe('music.room', {
    playback: 'paused',
    volume: initialVolume,
    source: 'Optical',
    title: null,
  });
  const elements = new Map<string, Element>();
  const get = (selector: string): Element => {
    const existing = elements.get(selector);
    if (existing) return existing;
    const created = new Element();
    elements.set(selector, created);
    return created;
  };
  get('#music-presets').append(
    get('#music-preset-dj'),
    get('#music-preset-optical'),
    get('#music-details-button'),
  );
  const documentListeners = new Map<string, Listener>();
  const windowListeners = new Map<string, Listener>();
  const streams: TestEventSource[] = [];
  class TestEventSource {
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
      streams.push(this);
    }
    close() {
      this.closed = true;
    }
    emit(payload: unknown) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
    fail() {
      this.onerror?.();
    }
  }
  const document = {
    visibilityState: 'visible',
    querySelector: get,
    createElement: () => new Element(),
    createTextNode: (text: string) => {
      const node = new Element();
      node.textContent = text;
      return node;
    },
    addEventListener: (type: string, listener: Listener) =>
      documentListeners.set(type, listener),
  };
  const apiCalls: Array<{
    target: string;
    request: { property: string; value: number | string };
  }> = [];
  let nextStateGate: Promise<void> | undefined;
  let nextStateStatus = 200;
  let stateReads = 0;
  const holdNextState = (status = 200) => {
    nextStateStatus = status;
    let release = () => {};
    nextStateGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  };
  const fetch = async (
    url: string,
    options: { method: string; body?: string },
  ) => {
    if (options.method === 'GET') {
      // HTTP serializes the real engine state. A successful control response does
      // not fabricate a media-player observation; the adapter controls feedback.
      const snapshot = JSON.parse(
        JSON.stringify({
          state: engine.state,
          scenes: [],
          role: 'desk',
          instanceId: 'runtime-a',
          deliveryRevision: stateReads + 1,
          generatedAt: clock.now(),
          musicVolumePolicies: engine.getMusicVolumePolicySnapshots(),
          musicPlaybackPolicies: engine.getMusicPlaybackPolicySnapshots(),
        }),
      ) as unknown;
      stateReads += 1;
      const gate = nextStateGate;
      const status = nextStateStatus;
      nextStateGate = undefined;
      nextStateStatus = 200;
      if (gate) await gate;
      return { ok: status === 200, status, json: async () => snapshot };
    }
    const body = JSON.parse(options.body ?? '{}') as {
      target: string;
      request:
        | { property: 'volume'; value: number }
        | { property: 'playback'; value: 'playing' | 'paused' };
    };
    apiCalls.push(body);
    if (!url.endsWith('/display-api/music'))
      throw new Error('Unexpected music command');
    try {
      const result = await registry.invoke(
        body.request.property === 'volume'
          ? 'music.setVolume'
          : body.request.value === 'playing'
            ? 'music.play'
            : 'music.pause',
        body.request.property === 'volume'
          ? { target: body.target, volume: body.request.value }
          : { target: body.target },
        {
          actor: { type: 'user', id: 'nest-dashboard' },
          source: 'lugn.cast_dashboard',
        },
      );
      return { ok: true, json: async () => result };
    } catch {
      // Match the display server's response when the adapter rejects a request.
      return {
        ok: false,
        status: 502,
        json: async () => ({ error: 'capability_failed' }),
      };
    }
  };
  const context = createContext({
    location: { pathname: `/k/${'a'.repeat(32)}/` },
    document,
    fetch,
    Date,
    Intl,
    console,
    window: {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      addEventListener: (type: string, listener: Listener) =>
        windowListeners.set(type, listener),
      ...(streaming ? { EventSource: TestEventSource } : {}),
    },
  });
  runInContext(
    readFileSync(new URL('../src/ui/display.js', import.meta.url), 'utf8'),
    context,
  );
  return {
    clock,
    adapter,
    engine,
    get,
    apiCalls,
    context,
    holdNextState,
    stateReads: () => stateReads,
    streams,
    document,
    documentListeners,
    windowListeners,
    payload: () => ({
      state: structuredClone(engine.state),
      scenes: [],
      role: 'desk',
      generatedAt: clock.now(),
      musicVolumePolicies: engine.getMusicVolumePolicySnapshots(),
      musicPlaybackPolicies: engine.getMusicPlaybackPolicySnapshots(),
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Hub role action hierarchy', () => {
  const sceneIds = [
    'scene.movie_light',
    'scene.soft_light',
    'scene.focus_light',
    'scene.all_off',
    'scene.everyday_light',
    'scene.sleep',
  ];
  it.each(['bed', 'desk'])(
    'keeps larger configured scene sets paired for %s without hiding actions',
    async (role) => {
      vi.useFakeTimers();
      const ui = dashboard();
      try {
        await microtasks();
        const ids = [...sceneIds, 'scene.custom_a', 'scene.custom_b'];
        runInContext(
          `render(${JSON.stringify({ ...ui.payload(), role, scenes: ids.map((id) => ({ id, name: id, lighting: {} })) })})`,
          ui.context,
        );
        const buttons = ui.get('#scene-grid').children;
        expect(buttons).toHaveLength(8);
        expect(
          buttons.every((button) => button.dataset['featured'] === 'false'),
        ).toBe(true);
        expect(
          buttons.slice(0, 2).map((button) => button.dataset['scene']),
        ).toEqual(
          role === 'bed'
            ? ['scene.all_off', 'scene.soft_light']
            : ['scene.focus_light', 'scene.everyday_light'],
        );
      } finally {
        ui.engine.dispose();
      }
    },
  );
  it.each([
    [
      'bed',
      [
        'scene.all_off',
        'scene.soft_light',
        'scene.sleep',
        'scene.everyday_light',
        'scene.movie_light',
        'scene.focus_light',
      ],
      true,
    ],
    [
      'desk',
      [
        'scene.focus_light',
        'scene.everyday_light',
        'scene.all_off',
        'scene.soft_light',
        'scene.movie_light',
        'scene.sleep',
      ],
      false,
    ],
    [
      'unrecognized',
      [
        'scene.all_off',
        'scene.soft_light',
        'scene.everyday_light',
        'scene.movie_light',
        'scene.focus_light',
        'scene.sleep',
      ],
      true,
    ],
  ] as const)(
    'orders configured actions for %s with one-touch controls',
    async (role, expected, djFirst) => {
      vi.useFakeTimers();
      const ui = dashboard();
      try {
        await microtasks();
        const payload = {
          ...ui.payload(),
          role,
          scenes: sceneIds.map((id) => ({ id, name: id, lighting: {} })),
        };
        runInContext(`render(${JSON.stringify(payload)})`, ui.context);
        expect(
          ui
            .get('#scene-grid')
            .children.map((button) => button.dataset['scene']),
        ).toEqual(expected);
        expect(
          ui
            .get('#scene-grid')
            .children.filter((button) => button.dataset['featured'] === 'true')
            .map((button) => button.dataset['scene']),
        ).toEqual(role === 'unrecognized' ? [] : expected.slice(0, 2));
        expect(ui.get('#music-presets').children.slice(0, 2)).toEqual(
          djFirst
            ? [ui.get('#music-preset-dj'), ui.get('#music-preset-optical')]
            : [ui.get('#music-preset-optical'), ui.get('#music-preset-dj')],
        );
        const before = structuredClone(ui.engine.state.presence);
        ui.get('#music-playback').click();
        await microtasks();
        expect(ui.apiCalls).toHaveLength(1);
        expect(ui.engine.state.presence).toEqual(before);
      } finally {
        ui.engine.dispose();
      }
    },
  );
  it('keeps missing preferred scenes and music honest while adapting roles', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = {
        ...ui.payload(),
        role: 'desk',
        scenes: [
          { id: 'scene.custom', name: 'Custom', lighting: {} },
          { id: 'scene.soft_light', name: 'Mysljus', lighting: {} },
        ],
      };
      payload.state.music.devices = {};
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(
        ui.get('#scene-grid').children.map((button) => button.dataset['scene']),
      ).toEqual(['scene.soft_light', 'scene.custom']);
      expect(ui.get('#music-playback').disabled).toBe(true);
      expect(ui.get('#music-preset-optical').disabled).toBe(true);
      expect(ui.get('#music-preset-dj').disabled).toBe(true);
      expect(ui.get('#app-root').dataset['role']).toBe('desk');
      expect(
        ui
          .get('#scene-grid')
          .children.some((button) => button.dataset['scene'] === 'scene.sleep'),
      ).toBe(false);
      const before = ui.get('#music-presets').children;
      runInContext(
        `render(${JSON.stringify({ ...payload, role: 'bed' })})`,
        ui.context,
      );
      expect(ui.get('#music-presets').children[0]).toBe(
        ui.get('#music-preset-dj'),
      );
      expect(ui.get('#music-presets').children).not.toBe(before);
      expect(
        ui.get('#scene-grid').children.map((button) => button.dataset['scene']),
      ).toEqual(['scene.soft_light', 'scene.custom']);
    } finally {
      ui.engine.dispose();
    }
  });
});

function explainedMusic(ui: ReturnType<typeof dashboard>) {
  const now = Date.now();
  const payload = ui.payload();
  return {
    ...payload,
    generatedAt: now,
    state: {
      ...payload.state,
      music: {
        ...payload.state.music,
        volumeChanges: {
          'music.room': {
            volume: 0.6,
            observedAt: now,
            provenance: { actor: { type: 'automation' }, source: 'lugn.music' },
            attribution: 'matched',
          },
        },
        decisions: payload.state.music.decisions ?? [],
      },
    },
    musicVolumePolicies: {
      'music.room': {
        activeOwner: 'manual',
        lastIntentActor: 'manual',
        controller: 'you',
        automatic: false,
        policyEnabled: true,
        policyActive: false,
        activityReason: 'manual_hold',
        manualHold: {
          volume: 0.4,
          createdAt: now,
          expiresAt: now + 10 * 60_000,
          provenance: { actor: { type: 'user' }, source: 'dashboard' },
        },
        baseline: 0.4,
        baselineSource: 'user',
        dailyOffset: -0.05,
        personOffset: -0.1,
        target: 0.25,
        effectiveTarget: 0.4,
      },
    },
    musicPlaybackPolicies: {
      'music.room': {
        activityReason: 'manual_pause',
        entryEligible: false,
        quietHours: true,
        manualPause: { createdAt: now },
        resumeExpiresAt: null,
      },
    },
  };
}

describe('Hub music authority explanations', () => {
  it('keeps an outstanding volume request visible after a newer playback request confirms', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const human = {
        actor: { type: 'user' as const },
        source: 'test.dashboard',
      };
      await ui.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.4 },
        human,
      );
      await ui.engine.requestMusic(
        'music.room',
        { property: 'playback', value: 'paused' },
        human,
      );
      ui.adapter.observe('music.room', {
        playback: 'paused',
        volume: 0.3,
        source: 'Optical',
        title: null,
      });
      await runInContext('refresh()', ui.context);
      expect(
        ui.engine.state.music.commands.map((command) => command.status),
      ).toEqual(['pending', 'confirmed']);
      expect(ui.get('#music-command-state').textContent).toContain('Volym');
      expect(ui.get('#music-command-state').textContent).toContain('inväntar');
      expect(ui.get('#music-volume-value').textContent).toBe('30%');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('marks cached controller authority and volume as stale after connection loss', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = explainedMusic(ui);
      Object.assign(payload.musicPlaybackPolicies['music.room'], {
        entryEligible: true,
        quietHours: false,
        manualPause: null,
      });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      runInContext(
        "setConnection('offline', 'Lugn svarar inte'); renderMusic(latestPayload)",
        ui.context,
      );
      expect(ui.get('#music-volume-controller').textContent).toBe(
        'Styrning okänd',
      );
      expect(ui.get('#music-volume-policy-activity').textContent).toBe('Okänt');
      expect(ui.get('#music-volume-observed-label').textContent).toBe('Senast');
      expect(ui.get('#music-volume-value').textContent).toBe('30%');
      expect(ui.get('#music-volume-up').disabled).toBe(true);
      expect(ui.get('#music-playback-eligibility').textContent).toContain(
        'okända',
      );
      expect(ui.get('#music-playback-quiet').textContent).toContain('okända');
      expect(ui.get('#music-playback-hold').textContent).toContain('okänd');
      expect(ui.get('#music-resume-window').textContent).toContain('okänt');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('offers Play to release a failed Pause hold while retaining manual volume ownership', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const human = {
        actor: { type: 'user' as const },
        source: 'test.dashboard',
      };
      ui.adapter.observe('music.room', {
        playback: 'playing',
        volume: 0.3,
        source: 'Optical',
        title: null,
      });
      await ui.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.4 },
        human,
      );
      vi.spyOn(ui.adapter, 'dispatch').mockRejectedValueOnce(
        new Error('pause failed'),
      );
      await expect(
        ui.engine.requestMusic(
          'music.room',
          { property: 'playback', value: 'paused' },
          human,
        ),
      ).rejects.toThrow('Music command failed');
      await runInContext('refresh()', ui.context);
      expect(ui.get('#music-playback-label').textContent).toBe('Spela');
      expect(ui.get('#music-playback').getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(ui.get('#music-command-state').textContent).toContain(
        'misslyckades',
      );
      ui.get('#music-playback').click();
      await microtasks();
      expect(ui.apiCalls.at(-1)?.request).toEqual({
        property: 'playback',
        value: 'playing',
      });
      expect(
        ui.engine.getMusicPlaybackPolicySnapshots()['music.room']?.manualPause,
      ).toBeNull();
      expect(
        ui.engine.getMusicVolumePolicySnapshots()['music.room']?.activeOwner,
      ).toBe('manual');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it.each(['pending', 'failed', 'unconfirmed'] as const)(
    'explains a %s request without inventing reported playback or volume',
    async (status) => {
      vi.useFakeTimers();
      const ui = dashboard();
      try {
        await microtasks();
        const payload = explainedMusic(ui);
        payload.state.music.commands.push({
          id: 'latest',
          target: 'music.room',
          requested: { property: 'playback', value: 'playing' },
          issuedAt: Date.now(),
          acceptedAt: Date.now(),
          status,
          provenance: { actor: { type: 'user' }, source: 'test' },
        });
        runInContext(`render(${JSON.stringify(payload)})`, ui.context);
        expect(ui.get('#music-command-state').textContent).toContain(
          {
            pending: 'inväntar',
            failed: 'misslyckades',
            unconfirmed: 'Kvittens saknas',
          }[status],
        );
        expect(ui.get('#music-player-status').textContent).toBe('Pausad');
        expect(ui.get('#music-volume-value').textContent).toBe('30%');
      } finally {
        ui.windowListeners.get('pagehide')?.();
        ui.engine.dispose();
      }
    },
  );

  it('shows only the selected player’s newest eight typed decisions', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = explainedMusic(ui);
      payload.state.music.decisions = Array.from(
        { length: 12 },
        (_, index) => ({
          target: index === 11 ? 'music.other' : 'music.room',
          at: Date.now() + index,
          reason: {
            kind: 'volume' as const,
            value:
              index === 10 ? ('manual_hold' as const) : ('active' as const),
          },
          owner: 'manual' as const,
          policyEnabled: true,
          manualExpiresAt: null,
          resumeExpiresAt: null,
        }),
      );
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      const rows = ui.get('#music-decision-history').children;
      expect(rows).toHaveLength(8);
      expect(rows[0]?.children[1]?.textContent).toContain('Manuellt val');
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-decision-history').children[0]).toBe(rows[0]);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('separates manual authority, last reported changer, enable state and every volume value', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = explainedMusic(ui);
      payload.state.music.devices['music.room']!.requested.volume = 0.55;
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-volume-controller').textContent).toBe(
        'Manuell volym',
      );
      expect(ui.get('#music-volume-last-change').textContent).toContain(
        'Matchar Lugn',
      );
      expect(ui.get('#music-volume-policy-enabled').textContent).toBe('På');
      expect(ui.get('#music-volume-policy-activity').textContent).toBe(
        'Pausad',
      );
      expect(ui.get('#music-volume-value').textContent).toBe('30%');
      expect(ui.get('#music-volume-requested').textContent).toBe('55%');
      expect(ui.get('#music-volume-baseline').textContent).toBe('40%');
      expect(ui.get('#music-volume-automatic-target').textContent).toBe('25%');
      expect(ui.get('#music-volume-target').textContent).toBe('40%');
      expect(ui.get('#music-volume-target-state').textContent).toContain(
        '10 min',
      );
      expect(ui.get('#music-playback-policy').textContent).toContain(
        'Manuell paus',
      );
      expect(ui.get('#music-playback-quiet').textContent).toContain('23–06');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('never assigns authority from last intent while the automatic policy is active', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = explainedMusic(ui);
      Object.assign(payload.musicVolumePolicies['music.room'], {
        activeOwner: 'lugn',
        policyActive: true,
        automatic: true,
        activityReason: 'active',
        manualHold: null,
        effectiveTarget: 0.25,
      });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-volume-controller').textContent).toBe(
        'Lugn styr volymen',
      );
      expect(ui.get('#music-volume-policy-activity').textContent).toBe('Aktiv');
      expect(ui.get('#music-volume-target').textContent).toBe('25%');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('uses server time for expiration and waits for backend authority at the boundary', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = explainedMusic(ui);
      payload.generatedAt -= 24 * 60 * 60_000;
      payload.musicVolumePolicies['music.room'].manualHold.expiresAt =
        payload.generatedAt + 1_000;
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-volume-target-state').textContent).toContain(
        '1 min',
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ui.get('#music-volume-controller').textContent).toBe(
        'Manuell volym',
      );
      expect(ui.get('#music-volume-target-state').textContent).toContain(
        'inväntar',
      );
      expect(ui.apiCalls).toEqual([]);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('reveals details in place while retaining the music controls', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      ui.get('#music-details-button').click();
      expect(ui.get('#music-details').hidden).toBe(false);
      expect(ui.get('#scene-section').hidden).toBe(true);
      expect(
        ui.get('#music-details-button').getAttribute('aria-expanded'),
      ).toBe('true');
      expect(ui.get('#music-volume-up').disabled).toBe(false);
      ui.get('#music-details-button').click();
      expect(ui.get('#scene-section').hidden).toBe(false);
      expect(ui.get('#music-details').hidden).toBe(true);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });
});

describe('Hub live state with resilient polling fallback', () => {
  it('keeps a periodic verification poll despite continuing stream heartbeats', async () => {
    vi.useFakeTimers();
    const ui = dashboard(0.3, true);
    try {
      await microtasks();
      ui.streams[0]!.emit({
        ...ui.payload(),
        instanceId: 'runtime-a',
        deliveryRevision: 2,
      });
      const reads = ui.stateReads();
      for (const deliveryRevision of [3, 4]) {
        await vi.advanceTimersByTimeAsync(5000);
        ui.streams[0]!.emit({
          ...ui.payload(),
          instanceId: 'runtime-a',
          deliveryRevision,
        });
      }
      await vi.advanceTimersByTimeAsync(5000);
      expect(ui.stateReads()).toBe(reads + 1);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('does not claim a pending default scene is confirmed before device feedback', async () => {
    vi.useFakeTimers();
    const ui = dashboard(0.3, true);
    try {
      await microtasks();
      const payload = {
        ...ui.payload(),
        scenes: [{ id: 'scene.focus_light', name: 'Fokus', lighting: {} }],
      };
      payload.state.lighting.currentScene = 'scene.focus_light';
      payload.state.revision += 1;
      ui.streams[0]!.emit({
        ...payload,
        instanceId: 'runtime-a',
        deliveryRevision: 2,
      });
      const button = ui.get('#scene-grid').children[0]!;
      expect(button.querySelector('.scene-status')?.textContent).toBe('Valt');
      payload.state.lighting.devices['lighting.desk'] = {
        effectiveDesired: { power: true },
        baselineDesired: { power: true },
        observed: { power: true },
        ownership: {},
        availability: 'available',
      };
      payload.state.revision += 1;
      ui.streams[0]!.emit({
        ...payload,
        instanceId: 'runtime-a',
        deliveryRevision: 3,
      });
      expect(button.querySelector('.scene-status')?.textContent).toBe(
        'Bekräftat',
      );
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });
  it('renders pushed presence and volume intent immediately while keeping observed volume separate', async () => {
    vi.useFakeTimers();
    const ui = dashboard(0.3, true);
    try {
      await microtasks();
      const reads = ui.stateReads();
      const payload = ui.payload();
      payload.state.presence.state = 'occupied';
      payload.state.presence.personCount = 2;
      payload.state.music.devices['music.room']!.requested.volume = 0.35;
      payload.state.revision += 1;
      ui.streams[0]!.emit({
        ...payload,
        instanceId: 'runtime-a',
        deliveryRevision: 2,
      });
      expect(ui.get('#room-presence').textContent).toContain('2 personer');
      expect(ui.get('#music-volume-value').textContent).toBe('30%');
      expect(ui.get('#music-volume-requested').textContent).toBe('35%');
      expect(ui.get('#music-volume-target').textContent).toBe('—');
      expect(ui.get('#music-volume-target-label').textContent).toBe(
        'Aktivt mål',
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(ui.stateReads()).toBe(reads);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('falls back to polling on disconnect and reconnects with bounded delay', async () => {
    vi.useFakeTimers();
    const ui = dashboard(0.3, true);
    try {
      await microtasks();
      ui.streams[0]!.emit({
        ...ui.payload(),
        instanceId: 'runtime-a',
        deliveryRevision: 2,
      });
      const reads = ui.stateReads();
      ui.streams[0]!.fail();
      await microtasks();
      expect(ui.streams[0]!.closed).toBe(true);
      expect(ui.stateReads()).toBe(reads + 1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ui.streams).toHaveLength(2);
      expect(ui.streams[1]!.url).toContain('/display-api/events');
      ui.streams[1]!.emit({
        ...ui.payload(),
        instanceId: 'runtime-a',
        deliveryRevision: 4,
      });
      const afterReconnect = ui.stateReads();
      await vi.advanceTimersByTimeAsync(2000);
      expect(ui.stateReads()).toBe(afterReconnect);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('cannot replace newer stream state with an old in-flight poll or replay', async () => {
    vi.useFakeTimers();
    const ui = dashboard(0.3, true);
    let release = () => {};
    try {
      await microtasks();
      release = ui.holdNextState();
      const poll = runInContext('refresh()', ui.context);
      await microtasks();
      const current = ui.payload();
      current.state.revision += 10;
      current.state.music.devices['music.room']!.observed.volume = 0.6;
      ui.streams[0]!.emit({
        ...current,
        instanceId: 'runtime-a',
        deliveryRevision: 20,
      });
      release();
      await poll;
      ui.streams[0]!.emit({
        ...ui.payload(),
        instanceId: 'runtime-a',
        deliveryRevision: 1,
      });
      expect(ui.get('#music-volume-value').textContent).toBe('60%');
    } finally {
      release();
      await microtasks();
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('accepts a restarted runtime with lower revisions and ignores delayed retired-instance state', async () => {
    vi.useFakeTimers();
    const ui = dashboard(0.3, true);
    let release = () => {};
    try {
      await microtasks();
      const old = ui.payload();
      old.state.revision = 100;
      ui.streams[0]!.emit({
        ...old,
        instanceId: 'runtime-a',
        deliveryRevision: 100,
      });
      release = ui.holdNextState();
      const poll = runInContext('refresh()', ui.context);
      await microtasks();
      const fresh = ui.payload();
      fresh.state.revision = 1;
      fresh.state.music.devices['music.room']!.observed.volume = 0.45;
      ui.streams[0]!.emit({
        ...fresh,
        instanceId: 'runtime-b',
        deliveryRevision: 1,
      });
      release();
      await poll;
      old.state.revision = 200;
      ui.streams[0]!.emit({
        ...old,
        instanceId: 'runtime-a',
        deliveryRevision: 200,
      });
      expect(ui.get('#music-volume-value').textContent).toBe('45%');
      expect(runInContext('latestPayload.state.revision', ui.context)).toBe(1);
    } finally {
      release();
      await microtasks();
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('releases streams when hidden or closed and bounds sockets that never deliver state', async () => {
    vi.useFakeTimers();
    const ui = dashboard(0.3, true);
    try {
      await microtasks();
      await vi.advanceTimersByTimeAsync(15000);
      expect(ui.streams[0]!.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ui.streams).toHaveLength(2);
      ui.document.visibilityState = 'hidden';
      ui.documentListeners.get('visibilitychange')?.();
      expect(ui.streams[1]!.closed).toBe(true);
      ui.document.visibilityState = 'visible';
      ui.documentListeners.get('visibilitychange')?.();
      await microtasks();
      expect(ui.streams).toHaveLength(3);
      ui.windowListeners.get('pagehide')?.();
      expect(ui.streams[2]!.closed).toBe(true);
      const reads = ui.stateReads();
      await vi.advanceTimersByTimeAsync(60000);
      expect(ui.stateReads()).toBe(reads);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });
});

describe('Hub volume steps preserve accepted user intent', () => {
  it.each([200, 503])(
    'reads fresh state after acceptance while an older background poll returns %s',
    async (status) => {
      vi.useFakeTimers();
      const ui = dashboard();
      const releases: Array<() => void> = [];
      try {
        await microtasks();
        const releaseBackground = ui.holdNextState(status);
        releases.push(releaseBackground);
        const backgroundPoll = runInContext('refresh()', ui.context);
        await microtasks();
        expect(ui.stateReads()).toBe(2);
        ui.get('#music-volume-up').click();
        await microtasks();
        expect(ui.apiCalls.map((call) => call.request.value)).toEqual([0.35]);
        expect(ui.get('#music-volume-up').disabled).toBe(true);
        const releaseFreshState = ui.holdNextState();
        releases.push(releaseFreshState);
        releaseBackground();
        await backgroundPoll;
        await microtasks();
        expect(ui.stateReads()).toBe(3);
        expect(ui.get('#music-volume-up').disabled).toBe(true);
        releaseFreshState();
        await microtasks();
        expect(ui.get('#music-volume-up').disabled).toBe(false);
        ui.clock.advanceBy(500);
        ui.get('#music-volume-up').click();
        await microtasks();
        expect(ui.apiCalls.map((call) => call.request.value)).toEqual([
          0.35, 0.4,
        ]);
        const reads = ui.stateReads();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(ui.stateReads()).toBe(reads + 1);
      } finally {
        for (const release of releases) release();
        await microtasks();
        ui.engine.dispose();
      }
    },
  );

  it('steps to 45% after late feedback for an older accepted 35% request', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      ui.get('#music-volume-up').click();
      await microtasks();
      ui.clock.advanceBy(500);
      ui.get('#music-volume-up').click();
      await microtasks();
      ui.clock.advanceBy(500);
      ui.adapter.observe('music.room', {
        playback: 'paused',
        volume: 0.35,
        source: 'Optical',
        title: null,
      });
      await runInContext('refresh()', ui.context);
      expect(
        ui.engine.state.music.devices['music.room']?.requested.volume,
      ).toBe(0.4);
      expect(ui.get('#music-volume-value').textContent).toBe('35%');
      ui.get('#music-volume-up').click();
      await microtasks();
      expect(ui.apiCalls.map((call) => call.request.value)).toEqual([
        0.35, 0.4, 0.45,
      ]);
    } finally {
      ui.engine.dispose();
    }
  });

  it.each(['expiry', 'external change', 'rejection'] as const)(
    'returns to the freshest observation after %s',
    async (lifecycle) => {
      vi.useFakeTimers();
      const ui = dashboard();
      try {
        await microtasks();
        ui.get('#music-volume-up').click();
        await microtasks();
        expect(
          ui.engine.state.music.devices['music.room']?.requested.volume,
        ).toBe(0.35);
        if (lifecycle === 'expiry') {
          ui.clock.advanceBy(10_000);
        } else if (lifecycle === 'external change') {
          ui.clock.advanceBy(1);
          ui.adapter.observe('music.room', {
            playback: 'paused',
            volume: 0.5,
            source: 'Optical',
            title: null,
          });
        } else {
          vi.spyOn(ui.adapter, 'dispatch').mockRejectedValueOnce(
            new Error('rejected'),
          );
          ui.get('#music-volume-up').click();
          await microtasks();
          expect(ui.engine.state.music.commands.at(-1)?.status).toBe('failed');
        }
        expect(
          ui.engine.state.music.devices['music.room']?.requested.volume,
        ).toBeUndefined();
        await runInContext('refresh()', ui.context);
        ui.get('#music-volume-up').click();
        await microtasks();
        expect(ui.apiCalls.at(-1)?.request.value).toBe(
          lifecycle === 'external change' ? 0.55 : 0.35,
        );
      } finally {
        ui.engine.dispose();
      }
    },
  );

  it.each([
    { volume: 0, first: 'up', second: 'down', expected: [0.05, 0] },
    { volume: 1, first: 'down', second: 'up', expected: [0.95, 1] },
    { volume: 0.99, first: 'up', second: 'down', expected: [1, 0.95] },
    { volume: 0.01, first: 'down', second: 'up', expected: [0, 0.05] },
  ])(
    'preserves bounded reversal from $volume without changing the reported value',
    async ({ volume, first, second, expected }) => {
      vi.useFakeTimers();
      const ui = dashboard(volume);
      try {
        await microtasks();
        ui.get(`#music-volume-${first}`).click();
        await microtasks();
        expect(ui.get(`#music-volume-${second}`).disabled).toBe(false);
        ui.get(`#music-volume-${second}`).click();
        await microtasks();
        expect(ui.apiCalls.map((call) => call.request.value)).toEqual(expected);
        expect(
          ui.engine.state.music.devices['music.room']?.observed.volume,
        ).toBe(volume);
        expect(ui.get('#music-volume-value').textContent).toBe(
          `${Math.round(volume * 100)}%`,
        );
      } finally {
        ui.engine.dispose();
      }
    },
  );

  it('accumulates two completed + presses from 30% to 40% before feedback', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      expect(ui.get('#music-volume-up').disabled).toBe(false);
      ui.get('#music-volume-up').click();
      await microtasks();
      expect(
        ui.engine.state.music.devices['music.room']?.requested.volume,
      ).toBe(0.35);
      expect(ui.engine.state.music.devices['music.room']?.observed.volume).toBe(
        0.3,
      );
      expect(ui.get('#music-volume-up').disabled).toBe(false);
      ui.clock.advanceBy(500);
      await vi.advanceTimersByTimeAsync(500);
      ui.get('#music-volume-up').click();
      await microtasks();
      expect(ui.apiCalls.map((call) => call.request.value)).toEqual([
        0.35, 0.4,
      ]);
      expect(ui.adapter.dispatched.map((call) => call.requested.value)).toEqual(
        [0.35, 0.4],
      );
      expect(
        ui.engine.state.music.devices['music.room']?.requested.volume,
      ).toBe(0.4);
    } finally {
      ui.engine.dispose();
    }
  });

  it('returns the requested target to 30% after + then minus before feedback', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      ui.get('#music-volume-up').click();
      await microtasks();
      expect(ui.get('#music-volume-down').disabled).toBe(false);
      ui.clock.advanceBy(500);
      await vi.advanceTimersByTimeAsync(500);
      ui.get('#music-volume-down').click();
      await microtasks();
      expect(ui.apiCalls.map((call) => call.request.value)).toEqual([
        0.35, 0.3,
      ]);
    } finally {
      ui.engine.dispose();
    }
  });

  it('CONTROL: still reaches 40% with device feedback between the presses', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      ui.get('#music-volume-up').click();
      await microtasks();
      ui.clock.advanceBy(500);
      ui.adapter.observe('music.room', {
        playback: 'paused',
        volume: 0.35,
        source: 'Optical',
        title: null,
      });
      await runInContext('refresh()', ui.context);
      ui.get('#music-volume-up').click();
      await microtasks();
      expect(ui.apiCalls.map((call) => call.request.value)).toEqual([
        0.35, 0.4,
      ]);
    } finally {
      ui.engine.dispose();
    }
  });
});
