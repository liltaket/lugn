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
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]): void {
    this.children = children;
  }
  querySelector(selector: string): Element | undefined {
    return this.children.find(
      (child) => child.className === selector.replace(/^\./, ''),
    );
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }
  click(): void {
    if (!this.disabled) this.listeners.get('click')?.();
  }
}

async function microtasks(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function dashboard(initialVolume = 0.3) {
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
  const document = {
    visibilityState: 'visible',
    querySelector: get,
    createElement: () => new Element(),
    createTextNode: (text: string) => {
      const node = new Element();
      node.textContent = text;
      return node;
    },
    addEventListener: () => {},
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
        JSON.stringify({ state: engine.state, scenes: [], role: 'desk' }),
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
      request: { property: 'volume'; value: number };
    };
    apiCalls.push(body);
    if (
      !url.endsWith('/display-api/music') ||
      body.request.property !== 'volume'
    )
      throw new Error('Unexpected command in volume-only regression');
    try {
      const result = await registry.invoke(
        'music.setVolume',
        { target: body.target, volume: body.request.value },
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
      addEventListener: () => {},
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
  };
}

afterEach(() => {
  vi.useRealTimers();
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
