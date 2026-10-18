import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { FakeClock } from '../src/core/clock.js';
import {
  MusicCommandRecoverySchema,
  type ComputerPlaybackRouteSnapshot,
  type MusicCommandRecord,
} from '../src/core/schemas.js';
import { lightingFeedbackBrowserScript } from '../src/runtime/lighting-feedback-script.js';

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

function dashboard(
  initialVolume = 0.3,
  streaming = false,
  presenceCorrection = false,
) {
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
  const authorityCalls: Array<{ target: string; mode: 'auto' | 'manual' }> = [];
  let nextStateGate: Promise<void> | undefined;
  let nextStateStatus = 200;
  let stateReads = 0;
  let presenceCorrections = 0;
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
          presenceCountCorrectionAvailable: presenceCorrection,
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
    if (url.endsWith('/display-api/presence-count-one')) {
      expect(JSON.parse(options.body ?? '{}')).toEqual({});
      presenceCorrections += 1;
      return { ok: true, json: async () => ({ accepted: true, count: 1 }) };
    }
    if (url.endsWith('/display-api/volume-authority')) {
      const input = JSON.parse(options.body ?? '{}') as {
        target: string;
        mode: 'auto' | 'manual';
      };
      authorityCalls.push(input);
      try {
        const result = await registry.invoke(
          'music.setVolumeAuthority',
          input,
          {
            actor: { type: 'user', id: 'nest-dashboard:desk' },
            source: 'lugn.cast_dashboard.desk',
          },
        );
        return { ok: true, json: async () => result };
      } catch (error) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: (error as { code: string }).code }),
        };
      }
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
    AbortController,
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
    lightingFeedbackBrowserScript +
      readFileSync(new URL('../src/ui/display.js', import.meta.url), 'utf8'),
    context,
  );
  return {
    clock,
    adapter,
    engine,
    get,
    apiCalls,
    authorityCalls,
    context,
    holdNextState,
    stateReads: () => stateReads,
    presenceCorrections: () => presenceCorrections,
    streams,
    document,
    documentListeners,
    windowListeners,
    payload: () => ({
      state: structuredClone(engine.state),
      scenes: [],
      role: 'desk',
      generatedAt: clock.now(),
      presenceCountCorrectionAvailable: presenceCorrection,
      musicVolumePolicies: engine.getMusicVolumePolicySnapshots(),
      musicPlaybackPolicies: engine.getMusicPlaybackPolicySnapshots(),
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it.each(['bed', 'desk'] as const)(
  'keeps %s correction acknowledgement distinct from reported occupancy and music Details',
  async (role) => {
    vi.useFakeTimers();
    const ui = dashboard(0.3, false, true);
    try {
      await microtasks();
      await ui.engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 2,
      });
      runInContext(
        `render(${JSON.stringify({ ...ui.payload(), role })})`,
        ui.context,
      );
      const before = structuredClone(ui.engine.state.presence);
      const button = ui.get('#presence-count-one');
      expect(button.hidden).toBe(false);
      ui.get('#music-details-button').click();
      expect(ui.get('#music-details').hidden).toBe(false);
      button.click();
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');
      await microtasks();
      expect(ui.presenceCorrections()).toBe(1);
      expect(button.disabled).toBe(false);
      expect(ui.engine.state.presence).toEqual(before);
      expect(ui.get('#room-presence').textContent).toContain('2 personer');
      expect(ui.get('#toast').textContent).toBe(
        'Räknaren har bekräftat 1 person. Väntar på sensorstatus.',
      );
      expect(ui.get('#music-details').hidden).toBe(false);
    } finally {
      ui.engine.dispose();
    }
  },
);

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

type ComputerNowPlayingProjection = {
  status: 'playing' | 'idle' | 'unavailable' | 'ambiguous';
  title: string | null;
  artist: string | null;
  application: string | null;
  deviceId: string;
  reason: string;
};

type ComputerSnapshot = ReturnType<ReturnType<typeof dashboard>['payload']> & {
  computerNowPlaying?: Record<string, ComputerNowPlayingProjection>;
};

function mappedComputerPayload(
  ui: ReturnType<typeof dashboard>,
  projection: ComputerNowPlayingProjection,
): ComputerSnapshot {
  const payload = ui.payload() as ComputerSnapshot;
  Object.assign(payload.state.music.devices['music.room']!.observed, {
    playback: 'playing',
    source: 'Optical In',
    title: '4',
  });
  payload.computerNowPlaying = { 'music.room': projection };
  return payload;
}

function withComputerPlayback(
  payload: ReturnType<ReturnType<typeof dashboard>['payload']>,
  route: ComputerPlaybackRouteSnapshot,
) {
  payload.state.music.computerPlayback = { 'music.room': route };
  return payload;
}

function desktopMusicCommand(
  id: string,
  issuedAt: number,
  status: MusicCommandRecord['status'],
  requested: MusicCommandRecord['requested'] = {
    property: 'playback',
    value: 'paused',
  },
): MusicCommandRecord {
  return {
    id,
    target: 'music.room',
    requested,
    issuedAt,
    status,
    ...(status === 'pending' ? { acceptedAt: issuedAt } : {}),
    provenance: { actor: { type: 'user' }, source: 'test.desktop' },
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

  it.each([
    ['verifying', null, 'läser HA-status'],
    ['waiting_retry', null, 'ny kontroll om 2 s'],
    ['retrying', null, 'Återförsök 2/3'],
    ['awaiting_feedback', null, 'Försök 2/3'],
    ['matched', null, 'HA-kontroll: 40% · matchar begäran, orsak okänd'],
    ['stopped', 'attempt_limit', 'efter 3 försök'],
    ['stopped', 'read_unavailable', 'statuskontroll stöds inte'],
    ['stopped', 'policy_changed', 'ändrade villkor'],
    ['stopped', 'newer_report', 'avstår återförsök'],
    ['stopped', 'read_timeout', 'svarade inte i tid'],
    ['stopped', 'deadline', 'Tidsgräns 60 s'],
  ])(
    'explains recovery %s/%s without replacing reported state',
    async (stage, stopReason, message) => {
      vi.useFakeTimers();
      const ui = dashboard();
      try {
        await microtasks();
        const payload = explainedMusic(ui);
        payload.state.music.commands.push({
          id: 'recovery',
          target: 'music.room',
          requested: { property: 'volume', value: 0.4 },
          issuedAt: ui.clock.now(),
          acceptedAt: ui.clock.now(),
          status: 'unconfirmed',
          provenance: { actor: { type: 'user' }, source: 'test' },
          recovery: MusicCommandRecoverySchema.parse({
            stage,
            stopReason,
            attemptCount:
              stage === 'stopped' && stopReason === 'attempt_limit' ? 3 : 2,
            lastAttemptAt: payload.generatedAt,
            deadlineAt: payload.generatedAt + 60_000,
            nextAttemptAt: payload.generatedAt + 2_000,
            verifiedAt: payload.generatedAt,
            reported: {
              volume: 0.4,
              playback: 'playing',
              source: 'Optical',
              title: null,
            },
          }),
        });
        runInContext(`render(${JSON.stringify(payload)})`, ui.context);
        expect(ui.get('#music-command-state').textContent).toContain(message);
        expect(ui.get('#music-volume-value').textContent).toBe('30%');
        expect(ui.get('#music-volume-observed-label').textContent).toBe(
          'Senast',
        );
        expect(ui.get('#music-player-status').textContent).toBe(
          'Senast rapporterat: Pausad',
        );
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
        'Manuell volym',
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

  it.each([
    [2699, 'Bekräftat'],
    [2727, 'Bekräftat'],
    [2728, 'Valt'],
  ])(
    'confirms Hub scenes using Kelvin tolerance at %i K',
    async (reported, label) => {
      vi.useFakeTimers();
      const ui = dashboard(0.3, true);
      try {
        await microtasks();
        const payload = {
          ...ui.payload(),
          scenes: [{ id: 'scene.kelvin', name: 'Kelvin', lighting: {} }],
        };
        payload.state.lighting.currentScene = 'scene.kelvin';
        payload.state.lighting.devices['lighting.desk'] = {
          effectiveDesired: {
            power: true,
            brightness: 3,
            colorTemperature: 2700,
          },
          baselineDesired: {
            power: true,
            brightness: 3,
            colorTemperature: 2700,
          },
          observed: { power: true, brightness: 3, colorTemperature: reported },
          ownership: {},
          availability: 'available',
        };
        runInContext(`render(${JSON.stringify(payload)})`, ui.context);
        const button = ui.get('#scene-grid').children[0]!;
        expect(button.querySelector('.scene-status')?.textContent).toBe(label);
      } finally {
        ui.windowListeners.get('pagehide')?.();
        ui.engine.dispose();
      }
    },
  );

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

describe('truthful Hub music and presence labels', () => {
  it.each([
    ['playing', 'Spelar'],
    ['paused', 'Pausad'],
    ['idle', 'Inaktiv'],
    ['off', 'Av'],
    ['unknown', 'Okänt'],
  ])(
    'renders reported %s separately from requests',
    async (playback, label) => {
      vi.useFakeTimers();
      const ui = dashboard();
      try {
        await microtasks();
        const payload = ui.payload();
        Object.assign(payload.state.music.devices['music.room']!.observed, {
          playback,
          title: 'Previous track',
        });
        runInContext(`render(${JSON.stringify(payload)})`, ui.context);
        expect(ui.get('#music-player-status').textContent).toBe(label);
        expect(ui.get('#music-title').textContent).toBe(
          playback === 'playing'
            ? 'Previous track'
            : 'Senaste titel: Previous track',
        );
      } finally {
        ui.windowListeners.get('pagehide')?.();
        ui.engine.dispose();
      }
    },
  );

  it.each([
    ['manual_hold', 'Manuell volym'],
    ['automation_disabled', 'Automatik av'],
    ['presence_unknown', 'Väntar på närvaro'],
    ['confirmed_empty', 'Rummet tomt'],
    ['home_away', 'Borta'],
    ['fade_active', 'Toning pågår'],
    ['volume_unavailable', 'Spelaren saknar volymrapport'],
  ])('explains inactive volume policy: %s', async (activityReason, label) => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = explainedMusic(ui);
      Object.assign(payload.musicVolumePolicies['music.room'], {
        activityReason,
        policyActive: false,
      });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-volume-policy-activity').textContent).toBe(label);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('keeps playback Pause and quiet hours independent from active volume automation', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = explainedMusic(ui);
      Object.assign(payload.musicVolumePolicies['music.room'], {
        activityReason: 'active',
        policyActive: true,
        activeOwner: 'lugn',
        manualHold: null,
      });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-volume-policy-activity').textContent).toBe('Aktiv');
      expect(ui.get('#music-playback-policy').textContent).toContain(
        'Manuell paus',
      );
      expect(ui.get('#music-playback-quiet').textContent).toContain('23–06');
      expect(ui.get('#music-player-status').textContent).toBe('Pausad');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('qualifies cached presence and playback on stream + polling loss and restores them on recovery', async () => {
    vi.useFakeTimers();
    const ui = dashboard(0.3, true);
    try {
      await microtasks();
      const payload = ui.payload();
      payload.state.presence.state = 'occupied';
      payload.state.presence.personCount = 2;
      payload.state.music.devices['music.room']!.observed.playback = 'playing';
      ui.streams[0]!.emit(payload);
      const release = ui.holdNextState(503);
      ui.streams[0]!.fail();
      release();
      await microtasks();
      expect(ui.get('#room-presence').textContent).toBe(
        'Senast rapporterat: I rummet · 2 personer',
      );
      expect(ui.get('#music-player-status').textContent).toBe(
        'Senast rapporterat: Spelar',
      );
      expect(ui.get('#music-playback').disabled).toBe(true);
      runInContext(`acceptPayload(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#room-presence').textContent).toBe(
        'I rummet · 2 personer',
      );
      expect(ui.get('#music-player-status').textContent).toBe('Spelar');
      expect(ui.get('#music-playback').disabled).toBe(false);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('marks observations as last reported when the player becomes unavailable', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = ui.payload();
      payload.state.music.devices['music.room']!.availability = 'unavailable';
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-player-status').textContent).toBe(
        'Senast rapporterat: Pausad',
      );
      expect(ui.get('#music-volume-controller').textContent).toBe(
        'Styrning okänd',
      );
      expect(ui.get('#music-volume-up').disabled).toBe(true);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });
  it('qualifies cached playback when the HA subscription is disconnected', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = { ...ui.payload(), musicObservationConnected: false };
      payload.state.music.devices['music.room']!.observed.playback = 'playing';
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-player-status').textContent).toBe(
        'Senast rapporterat: Spelar',
      );
      expect(ui.get('#music-volume-controller').textContent).toBe(
        'Styrning okänd',
      );
      expect(ui.get('#music-playback').disabled).toBe(false);
      expect(ui.get('#music-volume-observed-label').textContent).toBe('Senast');
      expect(ui.get('#music-volume-value').getAttribute('aria-label')).toBe(
        'Senast rapporterade spelarvolym',
      );
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });
  it('preserves uncertainty when playback is unknown and no title is reported', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = ui.payload();
      payload.state.music.devices['music.room']!.observed.playback = 'unknown';
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-player-status').textContent).toBe('Okänt');
      expect(ui.get('#music-title').textContent).toBe('Uppspelning okänd');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('qualifies only the music target awaiting reconciliation', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = {
        ...ui.payload(),
        musicObservationTrust: { 'music.room': false },
      };
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-player-status').textContent).toBe(
        'Senast rapporterat: Pausad',
      );
      expect(ui.get('#music-volume-observed-label').textContent).toBe('Senast');
      expect(ui.get('#music-volume-value').getAttribute('aria-label')).toBe(
        'Senast rapporterade spelarvolym',
      );
      expect(ui.get('#music-volume-controller').textContent).toBe(
        'Styrning okänd',
      );
      expect(ui.get('#music-playback').disabled).toBe(false);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('explains the backend session-scoped Pause release condition', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = explainedMusic(ui);
      const hold = payload.musicPlaybackPolicies['music.room']!.manualPause!;
      Object.assign(hold, { resetPolicy: 'room_session_or_explicit_playback' });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-playback-hold').textContent).toContain(
        'rumsbesöket avslutas',
      );
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });
});

it.each(['bed', 'desk'] as const)(
  'renders %s volume authority from backend and blocks rapid taps without optimistic selection',
  async (role) => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      await ui.engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 1,
      });
      runInContext(
        `render(${JSON.stringify({ ...ui.payload(), role })})`,
        ui.context,
      );
      const manual = ui.get('#music-volume-manual');
      const auto = ui.get('#music-volume-auto');
      expect(auto.getAttribute('aria-pressed')).toBe('true');
      expect(manual.disabled).toBe(false);
      const release = ui.holdNextState();
      manual.click();
      manual.click();
      auto.click();
      await microtasks();
      expect(ui.authorityCalls).toEqual([
        { target: 'music.room', mode: 'manual' },
      ]);
      expect(manual.disabled).toBe(true);
      expect(manual.getAttribute('aria-busy')).toBe('true');
      expect(ui.get('#music-playback').disabled).toBe(false);
      expect(ui.get('#music-volume-up').disabled).toBe(true);
      expect(manual.getAttribute('aria-pressed')).toBe('false');
      expect(ui.adapter.dispatched).toHaveLength(0);
      release();
      await microtasks();
      expect(manual.getAttribute('aria-pressed')).toBe('true');
      expect(ui.get('#music-authority-state').textContent).toContain(
        'behålls tills du väljer Auto',
      );
      await ui.engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 1,
      });
      runInContext(
        `render(${JSON.stringify({ ...ui.payload(), role })})`,
        ui.context,
      );
      expect(manual.getAttribute('aria-pressed')).toBe('true');
      await ui.engine.handlePresence({
        type: 'presence.changed',
        presence: 'unknown',
        personCount: null,
      });
      runInContext(
        `render(${JSON.stringify({ ...ui.payload(), role })})`,
        ui.context,
      );
      expect(manual.getAttribute('aria-pressed')).toBe('true');
      expect(auto.getAttribute('aria-pressed')).toBe('false');
      expect(ui.get('#music-volume-target-state').textContent).toContain(
        'närvaro okänd',
      );
    } finally {
      ui.engine.dispose();
    }
  },
);

it('explains unknown/offline/pending volume and handles a backend race without claiming success', async () => {
  vi.useFakeTimers();
  const ui = dashboard();
  try {
    await microtasks();
    ui.adapter.observe(
      'music.room',
      { playback: 'paused', volume: null, source: 'Optical', title: null },
      false,
    );
    runInContext(`render(${JSON.stringify(ui.payload())})`, ui.context);
    expect(ui.get('#music-volume-manual').disabled).toBe(true);
    expect(ui.get('#music-authority-state').textContent).toContain(
      'tillförlitlig volym',
    );
    ui.adapter.observe('music.room', {
      playback: 'paused',
      volume: 0.3,
      source: 'Optical',
      title: null,
    });
    runInContext(`render(${JSON.stringify(ui.payload())})`, ui.context);
    expect(ui.get('#music-volume-manual').disabled).toBe(false);
    // State changes after the last snapshot, before the tap reaches the backend.
    await ui.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.4 },
      { actor: { type: 'user' } },
    );
    ui.get('#music-volume-manual').click();
    await microtasks();
    expect(ui.get('#toast').textContent).toContain('Volymen ändras redan');
    expect(
      ui.engine.getMusicVolumePolicySnapshots()['music.room']?.selectorIntent,
    ).toBeNull();
    expect(ui.get('#music-volume-auto').disabled).toBe(true);
    expect(ui.get('#music-authority-state').textContent).toContain(
      'volymkvittens',
    );
    runInContext(
      `setConnection('offline', 'Offline', true); renderMusic(latestPayload);`,
      ui.context,
    );
    expect(ui.get('#music-volume-manual').disabled).toBe(true);
    expect(ui.get('#music-volume-manual').getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(ui.get('#music-authority-state').textContent).toContain(
      'Lugn svarar inte',
    );
  } finally {
    ui.engine.dispose();
  }
});

it.each(['bed', 'desk'] as const)(
  '%s disables and qualifies authority when upstream observations disconnect while Lugn stays fresh',
  async (role) => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      await ui.engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 1,
      });
      const payload = { ...ui.payload(), role };
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-volume-auto').getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(ui.get('#music-volume-manual').disabled).toBe(false);
      runInContext(
        `render(${JSON.stringify({ ...payload, musicObservationConnected: false })})`,
        ui.context,
      );
      for (const id of ['#music-volume-auto', '#music-volume-manual']) {
        expect(ui.get(id).disabled).toBe(true);
        expect(ui.get(id).getAttribute('aria-pressed')).toBe('false');
        ui.get(id).click();
      }
      expect(ui.authorityCalls).toHaveLength(0);
      expect(ui.get('#music-authority-state').textContent).toContain(
        'Spelarstatus saknar kontakt',
      );
      expect(ui.get('#music-authority-state').hidden).toBe(false);
      for (const restored of [
        { ...payload, musicObservationConnected: true },
        payload,
      ]) {
        runInContext(`render(${JSON.stringify(restored)})`, ui.context);
        expect(ui.get('#music-volume-manual').disabled).toBe(false);
        expect(ui.get('#music-volume-auto').getAttribute('aria-pressed')).toBe(
          'true',
        );
      }
    } finally {
      ui.engine.dispose();
    }
  },
);

describe('Hub Optical computer media projection', () => {
  it.each(['bed', 'desk'] as const)(
    'shows fresh computer media for the %s role without changing transport controls',
    async (role) => {
      vi.useFakeTimers();
      const ui = dashboard();
      try {
        await microtasks();
        const payload = {
          ...mappedComputerPayload(ui, {
            status: 'playing',
            title: 'Catch Me',
            artist: 'WizTheMc',
            application: 'Spotify',
            deviceId: 'kuffe',
            reason: 'active_audio',
          }),
          role,
        };
        runInContext(`render(${JSON.stringify(payload)})`, ui.context);

        expect(ui.get('#music-title').textContent).toBe('Catch Me');
        expect(ui.get('#music-source').textContent).toBe('WizTheMc');
        expect(ui.get('#music-player-status').textContent).toBe('Spelar');
        expect(ui.get('#music-playback').getAttribute('aria-pressed')).toBe(
          'true',
        );
        expect(ui.get('#music-playback-label').textContent).toBe('Pausa');
        expect(ui.get('#music-playback').disabled).toBe(false);
        expect(ui.get('#music-preset-optical').disabled).toBe(false);
      } finally {
        ui.windowListeners.get('pagehide')?.();
        ui.engine.dispose();
      }
    },
  );

  it('keeps the last title for eight seconds without heartbeats extending the pause', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      // Isolate presentation timing from the harness's background state polling.
      runInContext('window.clearTimeout(timer)', ui.context);
      const playing = mappedComputerPayload(ui, {
        status: 'playing',
        title: 'Last track',
        artist: 'Artist',
        application: 'Spotify',
        deviceId: 'kuffe',
        reason: 'active_audio',
      });
      runInContext(`render(${JSON.stringify(playing)})`, ui.context);
      const paused = structuredClone(playing);
      paused.computerNowPlaying!['music.room'] = {
        ...paused.computerNowPlaying!['music.room']!,
        status: 'idle',
        title: null,
        artist: null,
      };
      runInContext(`render(${JSON.stringify(paused)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('Last track');
      expect(ui.get('#music-player-status').textContent).toBe('Senast spelat');
      await vi.advanceTimersByTimeAsync(7_000);
      runInContext(`render(${JSON.stringify(paused)})`, ui.context);
      await vi.advanceTimersByTimeAsync(999);
      expect(ui.get('#music-title').textContent).toBe('Last track');
      await vi.advanceTimersByTimeAsync(1);
      expect(ui.get('#music-title').textContent).toBe(
        'Inget media spelas på datorn',
      );
      runInContext(`render(${JSON.stringify(paused)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe(
        'Inget media spelas på datorn',
      );
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('bridges the agent media-null refresh into pause without extending the deadline', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      runInContext('window.clearTimeout(timer)', ui.context);
      const payload = mappedComputerPayload(ui, {
        status: 'playing',
        title: 'Last track',
        artist: 'Artist',
        application: 'Spotify',
        deviceId: 'kuffe',
        reason: 'single_playing',
      });
      Object.assign(payload.state.computer.devices, {
        kuffe: {
          sessionId: 'same-session',
          availability: 'online',
          freshness: 'fresh',
          observed: { media: null },
        },
      });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      payload.computerNowPlaying!['music.room']!.status = 'unavailable';
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('Last track');
      expect(ui.get('#music-player-status').textContent).toBe('Senast spelat');
      await vi.advanceTimersByTimeAsync(2_000);
      payload.computerNowPlaying!['music.room']!.status = 'idle';
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(ui.get('#music-title').textContent).toBe(
        'Inget media spelas på datorn',
      );
      payload.computerNowPlaying!['music.room']!.status = 'playing';
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      payload.computerNowPlaying!['music.room']!.status = 'unavailable';
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('Last track');
      Object.assign(payload.state.computer.devices['kuffe']!, {
        availability: 'offline',
        freshness: 'unknown',
      });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('Datorns media är okänt');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it.each(['paused', 'idle'] as const)(
    'shows resumed or new media immediately after receiver %s and cancels the old pause deadline',
    async (playback) => {
      vi.useFakeTimers();
      const ui = dashboard();
      try {
        await microtasks();
        runInContext('window.clearTimeout(timer)', ui.context);
        const payload = mappedComputerPayload(ui, {
          status: 'playing',
          title: 'First track',
          artist: 'Artist',
          application: 'Spotify',
          deviceId: 'kuffe',
          reason: 'active_audio',
        });
        runInContext(`render(${JSON.stringify(payload)})`, ui.context);
        payload.state.music.devices['music.room']!.observed.playback = playback;
        runInContext(`render(${JSON.stringify(payload)})`, ui.context);
        expect(ui.get('#music-title').textContent).toBe('First track');
        expect(ui.get('#music-player-status').textContent).toBe(
          playback === 'paused' ? 'Pausad' : 'Senast spelat',
        );
        await vi.advanceTimersByTimeAsync(4_000);
        payload.state.music.devices['music.room']!.observed.playback =
          'playing';
        payload.computerNowPlaying!['music.room']!.title = 'New video';
        runInContext(`render(${JSON.stringify(payload)})`, ui.context);
        expect(ui.get('#music-title').textContent).toBe('New video');
        expect(ui.get('#music-player-status').textContent).toBe('Spelar');
        await vi.advanceTimersByTimeAsync(4_000);
        expect(ui.get('#music-title').textContent).toBe('New video');
      } finally {
        ui.windowListeners.get('pagehide')?.();
        ui.engine.dispose();
      }
    },
  );

  it.each([
    'unavailable',
    'ambiguous',
    'untrusted',
    'session',
    'instance',
    'source',
  ])('clears the paused title immediately on %s changes', async (change) => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = mappedComputerPayload(ui, {
        status: 'playing',
        title: 'Last track',
        artist: 'Artist',
        application: 'Spotify',
        deviceId: 'kuffe',
        reason: 'active_audio',
      });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      payload.computerNowPlaying!['music.room']!.status = 'idle';
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('Last track');
      if (change === 'unavailable' || change === 'ambiguous') {
        payload.computerNowPlaying!['music.room']!.status = change;
      } else if (change === 'untrusted') {
        Object.assign(payload, {
          musicObservationTrust: { 'music.room': false },
        });
      } else if (change === 'instance') {
        Object.assign(payload, { instanceId: 'new-server' });
      } else if (change === 'session') {
        Object.assign(payload.state.computer, {
          devices: { kuffe: { sessionId: 'new-session' } },
        });
      } else {
        delete payload.computerNowPlaying;
        payload.state.music.devices['music.room']!.observed.source =
          'Spotify DJ';
      }
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-title').textContent).not.toBe('Last track');
      payload.computerNowPlaying = {
        'music.room': {
          status: 'idle',
          title: null,
          artist: null,
          application: null,
          deviceId: 'kuffe',
          reason: 'idle',
        },
      };
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-title').textContent).not.toBe('Last track');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('uses the selected video title when that is the active computer media', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = mappedComputerPayload(ui, {
        status: 'playing',
        title: 'Gränsbevakarna Sverige',
        artist: null,
        application: 'Firefox',
        deviceId: 'kuffe',
        reason: 'active_video',
      });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('Gränsbevakarna Sverige');
      expect(ui.get('#music-source').textContent).toBe('Optical');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it.each([
    ['idle', 'Inget media spelas på datorn'],
    ['unavailable', 'Datorns media är okänt'],
    ['ambiguous', 'Flera medier spelas på datorn'],
  ] as const)(
    'shows the %s state without leaking the receiver preset number',
    async (status, title) => {
      vi.useFakeTimers();
      const ui = dashboard();
      try {
        await microtasks();
        const payload = mappedComputerPayload(ui, {
          status,
          title: null,
          artist: null,
          application: null,
          deviceId: 'kuffe',
          reason: status,
        });
        runInContext(`render(${JSON.stringify(payload)})`, ui.context);
        expect(ui.get('#music-title').textContent).toBe(title);
        expect(ui.get('#music-title').textContent).not.toBe('4');
        expect(ui.get('#music-source').textContent).toBe('Optical');
        expect(ui.get('#music-player-status').textContent).not.toBe('Spelar');
      } finally {
        ui.windowListeners.get('pagehide')?.();
        ui.engine.dispose();
      }
    },
  );

  it('qualifies stale observations, restores on recovery, and drops the projection after a source switch', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const fresh = mappedComputerPayload(ui, {
        status: 'playing',
        title: 'First track',
        artist: 'Artist',
        application: 'Spotify',
        deviceId: 'kuffe',
        reason: 'active_audio',
      });
      runInContext(`render(${JSON.stringify(fresh)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('First track');

      const stale = { ...fresh, musicObservationConnected: false };
      runInContext(`render(${JSON.stringify(stale)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('Datorns media är okänt');
      expect(ui.get('#music-player-status').textContent).toBe(
        'Senast rapporterat',
      );
      expect(ui.get('#music-source').textContent).toBe('Optical');

      const recovered = mappedComputerPayload(ui, {
        status: 'playing',
        title: 'Second track',
        artist: 'Another Artist',
        application: 'Spotify',
        deviceId: 'kuffe',
        reason: 'active_audio',
      });
      runInContext(`render(${JSON.stringify(recovered)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('Second track');

      const switchedSource = ui.payload() as ComputerSnapshot;
      Object.assign(
        switchedSource.state.music.devices['music.room']!.observed,
        {
          playback: 'playing',
          source: 'Spotify DJ',
          title: 'Regular player track',
        },
      );
      runInContext(`render(${JSON.stringify(switchedSource)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('Regular player track');
      expect(ui.get('#music-source').textContent).toBe('Spotify DJ');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('keeps the computer label cautious while the dashboard is disconnected', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = mappedComputerPayload(ui, {
        status: 'playing',
        title: 'Current track',
        artist: 'Artist',
        application: 'Spotify',
        deviceId: 'kuffe',
        reason: 'active_audio',
      });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      runInContext(
        `setConnection('offline', 'Lugn svarar inte', true);`,
        ui.context,
      );
      expect(ui.get('#music-title').textContent).toBe('Datorns media är okänt');
      expect(ui.get('#music-player-status').textContent).toBe(
        'Senast rapporterat',
      );
      expect(ui.get('#music-source').textContent).toBe('Optical');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('does not replace a known paused player or change its controls', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = mappedComputerPayload(ui, {
        status: 'playing',
        title: 'Do not show while paused',
        artist: null,
        application: 'Firefox',
        deviceId: 'kuffe',
        reason: 'active_video',
      });
      payload.state.music.devices['music.room']!.observed.playback = 'paused';
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('Ingen musik spelar');
      expect(ui.get('#music-source').textContent).toBe('Optical');
      expect(ui.get('#music-player-status').textContent).toBe('Pausad');
      expect(ui.get('#music-playback').getAttribute('aria-pressed')).toBe(
        'false',
      );
      expect(ui.get('#music-playback').disabled).toBe(false);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('leaves normal source display unchanged without a computer projection', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = ui.payload();
      Object.assign(payload.state.music.devices['music.room']!.observed, {
        playback: 'playing',
        source: 'Spotify DJ',
        title: 'Regular player track',
      });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('Regular player track');
      expect(ui.get('#music-source').textContent).toBe('Spotify DJ');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('writes long and markup-like media metadata as plain text', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const title = `<img src=x onerror=alert(1)> ${'very long title '.repeat(40).trim()}`;
      const application = '<script>bad()</script>';
      const payload = mappedComputerPayload(ui, {
        status: 'playing',
        title,
        artist: 'Artist',
        application,
        deviceId: 'kuffe',
        reason: 'active_audio',
      });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(
        Array.from(ui.get('#music-title').textContent).length,
      ).toBeLessThanOrEqual(56);
      expect(ui.get('#music-title').textContent).toMatch(/^<img.*…$/);
      expect(ui.get('#music-title').children).toHaveLength(0);
      expect(ui.get('#music-source').textContent).toBe('Artist');
      expect(ui.get('#music-source').children).toHaveLength(0);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('masks numeric HA metadata when the mapped player is unavailable', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = mappedComputerPayload(ui, {
        status: 'playing',
        title: 'Current track',
        artist: 'Artist',
        application: 'Spotify',
        deviceId: 'kuffe',
        reason: 'active_audio',
      });
      payload.state.music.devices['music.room']!.availability = 'unavailable';
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-title').textContent).toBe('Datorns media är okänt');
      expect(ui.get('#music-player-status').textContent).toBe(
        'Senast rapporterat',
      );
      expect(ui.get('#music-source').textContent).toBe('Optical');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });
});

describe('Hub desktop playback controls', () => {
  const route = (
    values: Partial<ComputerPlaybackRouteSnapshot>,
  ): ComputerPlaybackRouteSnapshot => ({
    active: true,
    deviceId: 'kuffe',
    playback: 'unknown',
    canPause: false,
    canResume: false,
    pending: false,
    lastCommand: null,
    ...values,
  });

  it('offers Play for a paused owned desktop lease while HA still reports playing', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = mappedComputerPayload(ui, {
        status: 'idle',
        title: null,
        artist: null,
        application: null,
        deviceId: 'kuffe',
        reason: 'no_playing_media',
      });
      withComputerPlayback(
        payload,
        route({ playback: 'paused', canResume: true }),
      );
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);

      expect(payload.state.music.devices['music.room']!.observed.playback).toBe(
        'playing',
      );
      expect(ui.get('#music-playback').getAttribute('aria-pressed')).toBe(
        'false',
      );
      expect(ui.get('#music-playback').getAttribute('aria-label')).toBe(
        'Starta musik',
      );
      expect(ui.get('#music-playback-label').textContent).toBe('Spela');
      expect(ui.get('#music-playback').disabled).toBe(false);

      const volume = ui.get('#music-volume-value').value;
      ui.get('#music-playback').click();
      await microtasks();
      expect(ui.apiCalls).toEqual([
        {
          target: 'music.room',
          request: { property: 'playback', value: 'playing' },
        },
      ]);
      expect(ui.get('#music-volume-value').value).toBe(volume);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('disables Play for a paused desktop without an owned resumable lease', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = mappedComputerPayload(ui, {
        status: 'idle',
        title: null,
        artist: null,
        application: null,
        deviceId: 'kuffe',
        reason: 'no_playing_media',
      });
      withComputerPlayback(
        payload,
        route({ playback: 'paused', canResume: false }),
      );
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);

      expect(ui.get('#music-playback').getAttribute('aria-pressed')).toBe(
        'false',
      );
      expect(ui.get('#music-playback-label').textContent).toBe('Spela');
      expect(ui.get('#music-playback').disabled).toBe(true);
      ui.get('#music-playback').click();
      await microtasks();
      expect(ui.apiCalls).toEqual([]);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('offers Pause for desktop playback even during a manual music hold', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = mappedComputerPayload(ui, {
        status: 'playing',
        title: 'Desktop track',
        artist: 'Artist',
        application: 'Spotify',
        deviceId: 'kuffe',
        reason: 'active_audio',
      });
      withComputerPlayback(
        payload,
        route({ playback: 'playing', canPause: true }),
      );
      Object.assign(payload.musicPlaybackPolicies['music.room']!, {
        manualPause: { createdAt: Date.now() },
      });
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);

      expect(ui.get('#music-playback').getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(ui.get('#music-playback').getAttribute('aria-label')).toBe(
        'Pausa musik',
      );
      expect(ui.get('#music-playback-label').textContent).toBe('Pausa');
      expect(ui.get('#music-playback').disabled).toBe(false);
      ui.get('#music-playback').click();
      await microtasks();
      expect(ui.apiCalls).toEqual([
        {
          target: 'music.room',
          request: { property: 'playback', value: 'paused' },
        },
      ]);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('disables a pending desktop command and exposes its busy state', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = mappedComputerPayload(ui, {
        status: 'idle',
        title: null,
        artist: null,
        application: null,
        deviceId: 'kuffe',
        reason: 'no_playing_media',
      });
      withComputerPlayback(
        payload,
        route({ playback: 'paused', canResume: true, pending: true }),
      );
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-playback').disabled).toBe(true);
      expect(ui.get('#music-playback').getAttribute('aria-busy')).toBe('true');
      expect(ui.get('#music-playback-label').textContent).toBe('Spela');
      ui.get('#music-playback').click();
      await microtasks();
      expect(ui.apiCalls).toEqual([]);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('disables unknown desktop playback even if a resume capability is present', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = mappedComputerPayload(ui, {
        status: 'unavailable',
        title: null,
        artist: null,
        application: null,
        deviceId: 'kuffe',
        reason: 'computer_unavailable',
      });
      withComputerPlayback(
        payload,
        route({ playback: 'unknown', canResume: true }),
      );
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      expect(ui.get('#music-playback').disabled).toBe(true);
      expect(ui.get('#music-playback').getAttribute('aria-pressed')).toBe(
        'false',
      );
      ui.get('#music-playback').click();
      await microtasks();
      expect(ui.apiCalls).toEqual([]);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('uses receiver playback and leaves volume controls unchanged when the desktop route is inactive', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = ui.payload();
      Object.assign(payload.state.music.devices['music.room']!.observed, {
        playback: 'paused',
        source: 'Spotify DJ',
        title: 'Receiver track',
      });
      withComputerPlayback(
        payload,
        route({ active: false, playback: 'playing', canPause: true }),
      );
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);

      expect(ui.get('#music-title').textContent).toBe(
        'Senaste titel: Receiver track',
      );
      expect(ui.get('#music-source').textContent).toBe('Spotify DJ');
      expect(ui.get('#music-playback').getAttribute('aria-pressed')).toBe(
        'false',
      );
      expect(ui.get('#music-playback-label').textContent).toBe('Spela');
      expect(ui.get('#music-playback').disabled).toBe(false);
      expect(ui.get('#music-volume-value').value).toBe('30%');
      expect(ui.get('#music-volume-down').disabled).toBe(false);
      expect(ui.get('#music-volume-up').disabled).toBe(false);

      ui.get('#music-playback').click();
      await microtasks();
      expect(ui.apiCalls).toEqual([
        {
          target: 'music.room',
          request: { property: 'playback', value: 'playing' },
        },
      ]);
      expect(ui.get('#music-volume-value').value).toBe('30%');
      expect(ui.get('#music-volume-down').disabled).toBe(false);
      expect(ui.get('#music-volume-up').disabled).toBe(false);
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });
});

describe('Hub desktop playback command status', () => {
  const route = (
    lastCommand: MusicCommandRecord | null,
    active = true,
    pending = false,
  ): ComputerPlaybackRouteSnapshot => ({
    active,
    deviceId: 'kuffe',
    playback: 'unknown',
    canPause: false,
    canResume: false,
    pending,
    lastCommand,
  });

  it('shows an active desktop command without confirmation in Details', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const now = ui.clock.now();
      const payload = ui.payload();
      withComputerPlayback(
        payload,
        route(desktopMusicCommand('desktop-uncertain', now, 'unconfirmed')),
      );
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      ui.get('#music-details-button').click();

      expect(ui.get('#music-details').hidden).toBe(false);
      expect(ui.get('#music-command-state').hidden).toBe(false);
      expect(ui.get('#music-command-state').textContent).toContain(
        'Kvittens saknas',
      );
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('shows a pending active desktop command in the existing Details row', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const now = ui.clock.now();
      const payload = ui.payload();
      withComputerPlayback(
        payload,
        route(
          desktopMusicCommand('desktop-pending', now, 'pending'),
          true,
          true,
        ),
      );
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      ui.get('#music-details-button').click();

      expect(ui.get('#music-command-state').hidden).toBe(false);
      expect(ui.get('#music-command-state').textContent).toContain(
        'Musik begärd · inväntar spelaren',
      );
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('orders active desktop and HA commands by issue time so a newer HA volume command wins', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const now = ui.clock.now();
      const payload = ui.payload();
      payload.state.music.commands.push(
        desktopMusicCommand('ha-volume', now + 1, 'confirmed', {
          property: 'volume',
          value: 0.4,
        }),
      );
      withComputerPlayback(
        payload,
        route(desktopMusicCommand('older-desktop-pause', now, 'unconfirmed')),
      );
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      ui.get('#music-details-button').click();

      expect(ui.get('#music-command-state').textContent).toBe(
        'Begäran rapporterad av spelaren',
      );
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });

  it('omits an old desktop command after the desktop route becomes inactive', async () => {
    vi.useFakeTimers();
    const ui = dashboard();
    try {
      await microtasks();
      const payload = ui.payload();
      withComputerPlayback(
        payload,
        route(
          desktopMusicCommand(
            'inactive-desktop-pause',
            ui.clock.now(),
            'unconfirmed',
          ),
          false,
        ),
      );
      runInContext(`render(${JSON.stringify(payload)})`, ui.context);
      ui.get('#music-details-button').click();

      expect(ui.get('#music-command-state').hidden).toBe(true);
      expect(ui.get('#music-command-state').textContent).toBe('');
    } finally {
      ui.windowListeners.get('pagehide')?.();
      ui.engine.dispose();
    }
  });
});
