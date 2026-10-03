import { describe, expect, it } from 'vitest';
import {
  LightingDeliveryUnknownError,
  SimulatedLightingAdapter,
} from '../src/adapters/simulated-lighting.js';
import { SimulatedSwitchAdapter } from '../src/adapters/simulated-switch.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { applyStateUpdate } from '../src/core/event-stream.js';

const user = { type: 'user' as const, id: 'test-user' };

function setup(options: ConstructorParameters<typeof LugnEngine>[1] = {}) {
  const clock = new FakeClock(Date.parse('2026-09-28T12:00:00+02:00'));
  const adapter = new SimulatedLightingAdapter(clock);
  const engine = new LugnEngine(clock, { adapter, ...options });
  return { clock, adapter, engine };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe('Lugn deterministic lighting slice', () => {
  it('allows explicit user light-on while confirmed empty without treating it as occupancy', async () => {
    const { adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [
        {
          id: 'scene.cozy',
          name: 'Cozy',
          lighting: { 'lighting.desk': { power: true, brightness: 24 } },
        },
      ],
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    const before = adapter.dispatched.length;

    await engine.setLighting(
      'lighting.desk',
      { power: true },
      {
        actor: user,
        source: 'dashboard',
        reason: 'Manual dashboard on',
      },
    );

    expect(adapter.dispatched.slice(before)).toEqual([
      expect.objectContaining({
        target: 'lighting.desk',
        values: { power: true },
      }),
    ]);
    expect(engine.state.presence.state).toBe('confirmed_empty');
    engine.dispose();
  });

  it('does not carry a scene-off brightness zero into a manual power-on', async () => {
    const { adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [
        {
          id: 'scene.lit',
          name: 'Lit',
          lighting: {
            'lighting.desk': {
              power: true,
              brightness: 35,
              colorTemperature: 3000,
            },
          },
        },
        {
          id: 'scene.off',
          name: 'Off',
          lighting: {
            'lighting.desk': {
              power: false,
              brightness: 0,
              colorTemperature: 2200,
            },
          },
        },
      ],
    });
    await engine.activateScene('scene.lit', user);
    await engine.activateScene('scene.off', user);
    expect(
      engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
    ).toMatchObject({ power: false, brightness: 0, colorTemperature: 2200 });
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: false,
      brightness: 35,
    });

    const beforeManualOn = adapter.dispatched.length;
    await engine.setLighting(
      'lighting.desk',
      { power: true },
      { actor: user, source: 'dashboard' },
    );

    expect(adapter.dispatched.slice(beforeManualOn)).toEqual([
      expect.objectContaining({
        target: 'lighting.desk',
        values: { power: true },
      }),
    ]);
    expect(
      engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
    ).toEqual({ power: true });
    expect(adapter.observed.get('lighting.desk')?.power).toBe(true);

    await engine.setLighting(
      'lighting.desk',
      { brightness: 42 },
      { actor: user, source: 'dashboard' },
    );
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 42,
    });

    await engine.activateScene('scene.off', user);
    expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    expect(
      engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
    ).toMatchObject({ power: false, brightness: 0, colorTemperature: 2200 });
    engine.dispose();
  });

  it('blocks empty-room brightness and color changes except for manually enabled lights', async () => {
    const { adapter, engine } = setup({
      deviceIds: ['lighting.ceiling', 'lighting.desk'],
      scenes: [
        {
          id: 'scene.cozy',
          name: 'Cozy',
          lighting: {
            'lighting.ceiling': {
              power: true,
              brightness: 40,
              colorTemperature: 2700,
            },
            'lighting.desk': {
              power: true,
              brightness: 30,
              colorTemperature: 2700,
            },
          },
        },
      ],
    });
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
    });
    const beforeBlockedChanges = adapter.dispatched.length;

    await engine.setLighting(
      'lighting.desk',
      { brightness: 60 },
      { actor: user, source: 'dashboard' },
    );
    await engine.setLighting(
      'lighting.desk',
      { colorTemperature: 3500 },
      { actor: user, source: 'dashboard' },
    );
    expect(adapter.dispatched).toHaveLength(beforeBlockedChanges);

    await engine.setLighting(
      'lighting.desk',
      { power: true },
      { actor: user, source: 'dashboard' },
    );
    const afterManualOn = adapter.dispatched.length;
    await engine.setLighting(
      'lighting.desk',
      { brightness: 65 },
      { actor: user, source: 'dashboard' },
    );
    await engine.setLighting(
      'lighting.desk',
      { colorTemperature: 3500 },
      { actor: user, source: 'dashboard' },
    );

    expect(adapter.dispatched.slice(afterManualOn)).toEqual([
      expect.objectContaining({
        target: 'lighting.desk',
        values: { brightness: 65 },
      }),
      expect.objectContaining({
        target: 'lighting.desk',
        values: { colorTemperature: 3500 },
      }),
    ]);
    expect(
      adapter.dispatched
        .slice(afterManualOn)
        .some((command) => command.target === 'lighting.ceiling'),
    ).toBe(false);
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 65,
      colorTemperature: 3500,
    });
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(false);
    engine.dispose();
  });

  it('keeps scene and confirmed-empty-off retries scheduled together', async () => {
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.ceiling', 'lighting.desk'],
      retryDelayMs: 100,
      scenes: [
        {
          id: 'scene.off',
          name: 'Off',
          lighting: {
            'lighting.ceiling': { power: false },
            'lighting.desk': { power: false },
          },
        },
      ],
    });
    await engine.activateScene('scene.off', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });

    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.setLighting(
      'lighting.desk',
      { power: true },
      { actor: user, source: 'dashboard' },
    );
    adapter.ignoreNextForTargets.add('lighting.ceiling');
    adapter.externalChange('lighting.ceiling', { power: true });
    await flushMicrotasks();

    clock.advanceBy(100);
    await flushMicrotasks();

    expect(adapter.observed.get('lighting.desk')?.power).toBe(true);
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(false);
    engine.dispose();
  });

  it('keeps the earliest retry deadline and runs each retry mode at its own due time', async () => {
    for (const firstMode of ['scene', 'confirmed_empty_off'] as const) {
      const { clock, engine } = setup();
      const internals = engine as unknown as {
        scheduleRetry(
          revision: number,
          delayMs: number,
          eventId?: string,
          mode?: 'scene' | 'confirmed_empty_off',
        ): void;
        runScheduledLightingRetry(
          revision: number,
          mode: 'scene' | 'confirmed_empty_off',
          eventId?: string,
        ): Promise<void>;
      };
      const runs: Array<{ at: number; mode: string }> = [];
      internals.runScheduledLightingRetry = async (_revision, mode) => {
        runs.push({ at: clock.now(), mode });
      };
      const secondMode =
        firstMode === 'scene' ? 'confirmed_empty_off' : 'scene';
      internals.scheduleRetry(1, 100, undefined, firstMode);
      clock.advanceBy(50);
      internals.scheduleRetry(1, 2_000, undefined, secondMode);
      clock.advanceBy(49);
      await flushMicrotasks();
      expect(runs).toEqual([]);

      clock.advanceBy(1);
      await flushMicrotasks();
      expect(runs).toEqual([{ at: clock.now(), mode: firstMode }]);

      clock.advanceBy(1_949);
      await flushMicrotasks();
      expect(runs).toHaveLength(1);
      clock.advanceBy(1);
      await flushMicrotasks();
      expect(runs).toEqual([
        { at: clock.now() - 1_950, mode: firstMode },
        { at: clock.now(), mode: secondMode },
      ]);
      engine.dispose();
      expect(clock.pendingTimers()).toBe(0);
    }
  });

  it('does not move an existing same-mode retry deadline later', async () => {
    const { clock, engine } = setup();
    const internals = engine as unknown as {
      scheduleRetry(revision: number, delayMs: number): void;
      runScheduledLightingRetry(revision: number, mode: 'scene'): Promise<void>;
    };
    const runs: number[] = [];
    internals.runScheduledLightingRetry = async () => {
      runs.push(clock.now());
    };
    internals.scheduleRetry(1, 100);
    clock.advanceBy(50);
    internals.scheduleRetry(1, 2_000);
    clock.advanceBy(49);
    await flushMicrotasks();
    expect(runs).toEqual([]);
    clock.advanceBy(1);
    await flushMicrotasks();
    expect(runs).toEqual([clock.now()]);
    engine.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('rearms a same-mode retry when the new deadline is earlier', async () => {
    const { clock, engine } = setup();
    const internals = engine as unknown as {
      scheduleRetry(revision: number, delayMs: number): void;
      runScheduledLightingRetry(revision: number, mode: 'scene'): Promise<void>;
    };
    const runs: number[] = [];
    internals.runScheduledLightingRetry = async () => {
      runs.push(clock.now());
    };
    internals.scheduleRetry(1, 2_000);
    clock.advanceBy(50);
    internals.scheduleRetry(1, 100);
    clock.advanceBy(99);
    await flushMicrotasks();
    expect(runs).toEqual([]);
    clock.advanceBy(1);
    await flushMicrotasks();
    expect(runs).toEqual([clock.now()]);
    engine.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('keeps retry fast-path correlation scoped to each mode', async () => {
    const { clock, engine } = setup();
    const internals = engine as unknown as {
      fastPathMonotonicOrigins: Map<string, number>;
      scheduleRetry(
        revision: number,
        delayMs: number,
        eventId?: string,
        mode?: 'scene' | 'confirmed_empty_off',
      ): void;
      terminateFastPathEvent(eventId: string): void;
      runScheduledLightingRetry(
        revision: number,
        mode: 'scene' | 'confirmed_empty_off',
        eventId?: string,
      ): Promise<void>;
    };
    internals.fastPathMonotonicOrigins.set('scene-event', clock.monotonicNow());
    internals.fastPathMonotonicOrigins.set('empty-event', clock.monotonicNow());
    const runs: Array<{ mode: string; eventId?: string }> = [];
    internals.runScheduledLightingRetry = async (_revision, mode, eventId) => {
      runs.push({ mode, ...(eventId === undefined ? {} : { eventId }) });
    };
    internals.scheduleRetry(1, 100, 'scene-event', 'scene');
    internals.scheduleRetry(1, 100, 'empty-event', 'confirmed_empty_off');
    internals.terminateFastPathEvent('scene-event');
    clock.advanceBy(100);
    await flushMicrotasks();
    expect(runs).toEqual([
      { mode: 'scene' },
      { mode: 'confirmed_empty_off', eventId: 'empty-event' },
    ]);
    engine.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('retries an explicit empty-room light-on after the device recovers', async () => {
    const { adapter, engine } = setup({ deviceIds: ['lighting.desk'] });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    adapter.setAvailable(false);

    await engine.setLighting(
      'lighting.desk',
      { power: true },
      { actor: user, source: 'dashboard' },
    );
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'unavailable',
    );

    adapter.setAvailable(true);
    adapter.externalChange('lighting.desk', { power: false });
    await flushMicrotasks();

    expect(adapter.observed.get('lighting.desk')?.power).toBe(true);
    expect(engine.state.presence.state).toBe('confirmed_empty');
    engine.dispose();
  });

  it('clears the empty-room manual-on exception when a new scene replaces it', async () => {
    const { adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [
        {
          id: 'scene.all_off',
          name: 'All off',
          lighting: { 'lighting.desk': { power: false } },
        },
      ],
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    await engine.setLighting(
      'lighting.desk',
      { power: true },
      { actor: user, source: 'dashboard' },
    );
    expect(adapter.observed.get('lighting.desk')?.power).toBe(true);

    await engine.activateScene('scene.all_off', user);

    expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    engine.dispose();
  });

  it('uses the selected scene as the prelight target and leaves excluded lights off', async () => {
    const { adapter, engine } = setup({
      deviceIds: ['lighting.ceiling', 'lighting.desk'],
      scenes: [
        {
          id: 'scene.cozy',
          name: 'Cozy',
          lighting: {
            'lighting.ceiling': { power: false },
            'lighting.desk': {
              power: true,
              brightness: 24,
              colorTemperature: 2400,
            },
          },
        },
      ],
      prelight: {
        targets: { 'lighting.ceiling': { power: true, brightness: 35 } },
      },
    });

    await engine.activateScene('scene.cozy', user);
    // Seed the physical baseline as off without emitting a user override after
    // the scene has taken ownership.
    adapter.observed.set('lighting.ceiling', { power: false });
    adapter.observed.set('lighting.desk', { power: false });
    engine.state.lighting.devices['lighting.ceiling']!.observed.power = false;
    engine.state.lighting.devices['lighting.desk']!.observed.power = false;
    adapter.dispatched.length = 0;

    await engine.handlePrelight({ type: 'presence.prelight', active: true });

    expect(adapter.dispatched).toEqual([
      expect.objectContaining({
        target: 'lighting.desk',
        values: { power: true, brightness: 24, colorTemperature: 2400 },
      }),
    ]);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(false);
    expect(adapter.observed.get('lighting.desk')?.power).toBe(true);
    expect(
      adapter.dispatched.some(
        (command) =>
          command.target === 'lighting.ceiling' &&
          command.values.power === true,
      ),
    ).toBe(false);
    engine.dispose();
  });

  it('does not dispatch corrective off for stale feedback while restored intent awaits occupancy', () => {
    const scene = {
      id: 'scene.everyday',
      name: 'Everyday',
      lighting: { 'lighting.ceiling': { power: true as const } },
    };
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.ceiling'],
      scenes: [scene],
      restoredLightingIntent: {
        currentScene: scene.id,
        sceneRevision: 1,
        continuityExpiresAt: null,
        devices: {
          'lighting.ceiling': {
            baselineDesired: { power: true },
            effectiveDesired: { power: true },
            ownership: { power: { kind: 'scene', revision: 1 } },
          },
        },
      },
    });

    const internals = engine as unknown as {
      handleObservation(observation: {
        target: string;
        values: { power: boolean };
        commandId: string;
        observedAt: number;
      }): void;
    };
    internals.handleObservation({
      target: 'lighting.ceiling',
      values: { power: true },
      commandId: 'stale-command-from-before-restart',
      observedAt: clock.now(),
    });

    expect(engine.state.presence.state).toBe('unknown');
    expect(adapter.dispatched).toEqual([]);
    engine.dispose();
  });

  it('selects a configured default scene at startup but applies it only after confirmed occupancy', async () => {
    const scene = {
      id: 'scene.everyday',
      name: 'Everyday',
      lighting: { 'lighting.ceiling': { power: true as const } },
    };
    const { adapter, engine } = setup({
      deviceIds: ['lighting.ceiling'],
      scenes: [scene],
      defaultSceneId: scene.id,
    });

    expect(engine.state.lighting.currentScene).toBe(scene.id);
    expect(
      engine.state.lighting.devices['lighting.ceiling']?.effectiveDesired,
    ).toEqual({});
    expect(adapter.dispatched).toEqual([]);

    adapter.externalChange('lighting.ceiling', { power: false });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
    });
    expect(adapter.dispatched).toEqual([]);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(adapter.dispatched).toHaveLength(1);
    expect(adapter.dispatched[0]).toMatchObject({
      target: 'lighting.ceiling',
      values: { power: true },
    });
    expect(engine.state.lighting.currentScene).toBe(scene.id);
    engine.dispose();
  });

  it('uses Vardagsljus instead of the legacy static target when no scene is selected', async () => {
    const { adapter, engine } = setup({
      deviceIds: ['lighting.ceiling', 'lighting.desk'],
      scenes: [
        {
          id: 'scene.everyday_light',
          name: 'Vardagsljus',
          lighting: {
            'lighting.ceiling': { power: false },
            'lighting.desk': { power: true, brightness: 55 },
          },
        },
      ],
      prelight: {
        targets: { 'lighting.ceiling': { power: true, brightness: 35 } },
      },
    });

    await engine.handlePrelight({ type: 'presence.prelight', active: true });

    expect(adapter.dispatched).toEqual([
      expect.objectContaining({
        target: 'lighting.desk',
        values: { power: true, brightness: 55 },
      }),
    ]);
    engine.dispose();
  });

  it('restores a physically off light after an unconfirmed prelight timeout', async () => {
    const { clock, adapter, engine } = setup({
      scenes: [
        {
          id: 'scene.cozy',
          name: 'Cozy',
          lighting: { 'lighting.desk': { power: true, brightness: 24 } },
        },
      ],
      prelight: {
        targets: { 'lighting.desk': { power: true, brightness: 35 } },
        maxDurationMs: 1_000,
      },
    });

    await engine.activateScene('scene.cozy', user);
    adapter.externalChange('lighting.desk', { power: false });
    adapter.dispatched.length = 0;
    adapter.ignoreNextForTargets.add('lighting.desk');

    await engine.handlePrelight({ type: 'presence.prelight', active: true });
    clock.advanceBy(1_000);
    await flushMicrotasks();

    expect(adapter.dispatched.at(-1)).toMatchObject({
      target: 'lighting.desk',
      values: { power: false },
    });
    engine.dispose();
  });

  it('terminalizes unresolved prelight commands at their feedback deadline and clears timers on dispose', async () => {
    const { clock, adapter, engine } = setup({
      convergenceTimeoutMs: 3_000,
      prelight: {
        targets: { 'lighting.desk': { power: true } },
        maxDurationMs: 1_000,
      },
    });
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.handlePrelight({ type: 'presence.prelight', active: true });
    const command = engine.state.commands[0]!;
    expect(command.status).toBe('pending');
    clock.advanceBy(2_999);
    await flushMicrotasks();
    expect(command.status).toBe('pending');
    clock.advanceBy(1);
    await flushMicrotasks();
    expect(command.status).toBe('cancelled');
    expect(command.diagnosticReason).toBe(
      'No matching lighting feedback before command timeout',
    );
    expect(
      engine.state.diagnostics.some(
        (entry) =>
          entry.kind === 'command.unconfirmed' &&
          entry.details['commandId'] === command.id,
      ),
    ).toBe(true);
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.handlePrelight({ type: 'presence.prelight', active: true });
    expect(clock.pendingTimers()).toBeGreaterThan(0);
    engine.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('bounds terminal lighting history and keeps retired explicit feedback from changing current intent', async () => {
    const { adapter, engine } = setup({ stateHistoryLimit: 2 });
    await engine.activateScene('scene.cozy', user);
    const retired = adapter.dispatched.find(
      (command) => command.target === 'lighting.desk',
    )!;
    for (let index = 0; index < 140; index += 1)
      await engine.activateScene(
        index % 2 === 0 ? 'scene.cozy' : 'scene.movie',
        user,
      );
    expect(engine.state.commands).toHaveLength(256);
    expect(
      engine.state.commands.some((command) => command.id === retired.id),
    ).toBe(false);
    const before = structuredClone(
      engine.state.lighting.devices['lighting.desk']!,
    );
    await adapter.dispatch(retired);
    await flushMicrotasks();
    const after = engine.state.lighting.devices['lighting.desk']!;
    expect(after.effectiveDesired).toEqual(before.effectiveDesired);
    expect(after.ownership).toEqual(before.ownership);
    expect(after.observed.power).toBe(false);
    expect(
      engine.state.diagnostics.some(
        (entry) => entry.kind === 'command.stale_feedback',
      ),
    ).toBe(true);
    await adapter.dispatch({
      id: 'external-unknown',
      target: 'lighting.desk',
      values: { brightness: 7 },
    });
    await flushMicrotasks();
    expect(after.effectiveDesired.brightness).toBe(7);
    expect(after.ownership.brightness?.kind).toBe('override');
    engine.dispose();
  });

  it('keeps diagnostics and timings bounded and publishes replayable eviction updates', async () => {
    const { engine } = setup({ stateHistoryLimit: 2 });
    let rebuilt = structuredClone(engine.state);
    const unsubscribe = engine.stream.subscribe((update) => {
      rebuilt = applyStateUpdate(rebuilt, update);
    });
    for (let index = 0; index < 300; index += 1)
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
      });
    expect(engine.state.timings).toHaveLength(256);
    expect(engine.state.timings[0]?.eventId).toBe('presence-45');
    expect(engine.state.timings.at(-1)?.eventId).toBe('presence-300');
    expect(engine.state.diagnostics).toHaveLength(256);
    expect(engine.state.diagnostics[0]!.id).toBeGreaterThan(0);
    expect(rebuilt).toEqual(engine.state);
    unsubscribe();
    engine.dispose();
  });

  it('bounds switch terminal history and retains older pending feedback attribution', async () => {
    const clock = new FakeClock(1_000);
    const switchAdapter = new SimulatedSwitchAdapter(clock);
    const engine = new LugnEngine(clock, {
      switchAdapter,
      switchDeviceIds: ['switch.fan', 'switch.socket'],
      stateHistoryLimit: 2,
    });
    switchAdapter.feedbackEnabled = false;
    const pending = await engine.setSwitch('switch.fan', true, { actor: user });
    switchAdapter.feedbackEnabled = true;
    for (let index = 0; index < 300; index += 1)
      await engine.setSwitch('switch.socket', index % 2 === 0, { actor: user });
    expect(engine.state.switches.commands).toHaveLength(257);
    expect(
      engine.state.switches.commands.find(
        (command) => command.id === pending.id,
      )?.status,
    ).toBe('pending');
    switchAdapter.observe('switch.fan', true);
    expect(engine.state.switches.commands).toHaveLength(256);
    expect(
      engine.state.switches.devices['switch.fan']!.observedProvenance?.actor,
    ).toEqual(user);
    expect(engine.state.switches.devices['switch.fan']!.latestCommandId).toBe(
      pending.id,
    );
    engine.dispose();
  });

  it('converges Cozy and sends no duplicate commands at steady state', async () => {
    const { adapter, engine } = setup();
    await engine.activateScene('scene.cozy', user);
    expect(engine.state.lighting.devices['lighting.desk']?.observed).toEqual({
      power: true,
      brightness: 30,
      colorTemperature: 2400,
    });
    expect(
      engine.state.commands.every((command) => command.status === 'confirmed'),
    ).toBe(true);
    expect(engine.state.commands[0]?.actor).toEqual(user);
    expect(engine.state.commands[0]?.source).toBe('capability');
    const sent = adapter.dispatched.length;
    await engine.reconcileScene();
    await engine.reconcileScene();
    expect(adapter.dispatched).toHaveLength(sent);
    engine.dispose();
  });

  it('measures fast-path decision, dispatch, feedback, and convergence with the local receive origin', async () => {
    const { clock, adapter, engine } = setup({
      prelight: {
        targets: { 'lighting.desk': { power: true } },
      },
    });
    adapter.feedbackDelayMs = 125;
    clock.advanceBy(20);

    const work = engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
      localReceivedMonotonicAt: 0,
    });
    await flushMicrotasks();

    const timing = engine.state.timings.at(-1);
    expect(timing?.eventReceivedAt).toBe(clock.now());
    expect(timing).not.toHaveProperty('localReceivedMonotonicAt');
    expect(timing?.eventToDecisionMs).toBe(20);
    expect(timing?.commandDispatchedAt).toBeDefined();
    expect(timing?.eventToFirstDispatchMs).toBe(20);
    expect(timing?.feedbackObservedAt).toBeUndefined();

    clock.advanceBy(124);
    await flushMicrotasks();
    expect(engine.state.timings.at(-1)?.eventToFirstFeedbackMs).toBeUndefined();

    clock.advanceBy(1);
    await flushMicrotasks();
    await work;
    await flushMicrotasks();

    const completed = engine.state.timings.at(-1);
    expect(adapter.dispatched).toHaveLength(1);
    expect(completed?.eventToFirstFeedbackMs).toBe(145);
    expect(completed?.eventToFullConvergenceMs).toBe(145);
    expect(
      [
        completed?.eventToDecisionMs,
        completed?.eventToFirstDispatchMs,
        completed?.eventToFirstFeedbackMs,
        completed?.eventToFullConvergenceMs,
      ].every((elapsed) => elapsed !== undefined && elapsed >= 0),
    ).toBe(true);
    engine.dispose();
  });

  it('attributes command-less feedback to the matching fast-path command', async () => {
    const { clock, adapter, engine } = setup({
      prelight: {
        targets: { 'lighting.desk': { power: true } },
      },
    });
    adapter.feedbackDelayMs = 125;
    clock.advanceBy(20);
    const work = engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
      localReceivedMonotonicAt: 0,
    });
    await flushMicrotasks();

    clock.advanceBy(70);
    adapter.externalChange(
      'lighting.desk',
      { power: true },
      {
        actor: { type: 'home_assistant' },
        source: 'home_assistant.state_changed',
      },
    );
    await flushMicrotasks();

    expect(engine.state.timings.at(-1)?.eventToFirstFeedbackMs).toBe(90);
    expect(engine.state.timings.at(-1)?.eventToFullConvergenceMs).toBe(90);
    clock.advanceBy(55);
    await flushMicrotasks();
    await work;
    expect(engine.state.timings.at(-1)?.eventToFirstFeedbackMs).toBe(90);
    engine.dispose();
  });

  it('waits for every configured prelight target before reporting convergence', async () => {
    const { clock, adapter, engine } = setup({
      convergenceTimeoutMs: 3_000,
      prelight: {
        targets: {
          'lighting.ceiling': { power: true },
          'lighting.desk': { power: true },
        },
      },
    });
    adapter.feedbackDelayMs = 1_000;
    const work = engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
      localReceivedMonotonicAt: clock.monotonicNow(),
    });
    await flushMicrotasks();
    expect(adapter.dispatched).toHaveLength(2);

    clock.advanceBy(100);
    adapter.externalChange(
      'lighting.desk',
      { power: true },
      {
        actor: { type: 'home_assistant' },
        source: 'home_assistant.state_changed',
      },
    );
    await flushMicrotasks();
    const timing = engine.state.timings.at(-1);
    expect(timing?.feedbackObservedAt).toBeDefined();
    expect(timing?.fullConvergenceAt).toBeUndefined();
    expect(timing?.eventToFullConvergenceMs).toBeUndefined();

    clock.advanceBy(100);
    adapter.externalChange(
      'lighting.ceiling',
      { power: true },
      {
        actor: { type: 'home_assistant' },
        source: 'home_assistant.state_changed',
      },
    );
    await flushMicrotasks();
    expect(engine.state.timings.at(-1)?.eventToFullConvergenceMs).toBe(200);

    clock.advanceBy(800);
    await flushMicrotasks();
    await work;
    engine.dispose();
  });

  it('completes confirmed-empty timing from later asynchronous feedback for all lights', async () => {
    const { clock, adapter, engine } = setup({ convergenceTimeoutMs: 2_000 });
    adapter.ignoreNextForTargets.add('lighting.ceiling');
    adapter.ignoreNextForTargets.add('lighting.desk');

    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    let timing = engine.state.timings.at(-1);
    expect(timing?.commandDispatchedAt).toBeDefined();
    expect(timing?.feedbackObservedAt).toBeUndefined();
    expect(timing?.fullConvergenceAt).toBeUndefined();

    adapter.externalChange(
      'lighting.ceiling',
      { power: false },
      {
        actor: { type: 'home_assistant' },
        source: 'home_assistant.state_changed',
      },
    );
    await flushMicrotasks();
    expect(engine.state.timings.at(-1)?.fullConvergenceAt).toBeUndefined();

    clock.advanceBy(25);
    adapter.externalChange(
      'lighting.desk',
      { power: false },
      {
        actor: { type: 'home_assistant' },
        source: 'home_assistant.state_changed',
      },
    );
    await flushMicrotasks();
    timing = engine.state.timings.at(-1);
    expect(timing?.feedbackObservedAt).toBeDefined();
    expect(timing?.fullConvergenceAt).toBe(clock.now());
    expect(timing?.eventToFullConvergenceMs).toBe(25);
    engine.dispose();
  });

  it('carries an occupied event through its scheduled convergence retry', async () => {
    const { clock, adapter, engine } = setup({
      retryDelayMs: 100,
      convergenceTimeoutMs: 1_000,
    });
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      localReceivedMonotonicAt: clock.monotonicNow(),
    });
    const timing = engine.state.timings.at(-1);
    expect(timing?.commandDispatchedAt).toBeUndefined();

    clock.advanceBy(100);
    await flushMicrotasks();
    expect(
      adapter.dispatched.filter(
        (command) => command.target === 'lighting.desk',
      ),
    ).toHaveLength(2);
    expect(timing?.eventToFirstDispatchMs).toBe(100);
    expect(timing?.eventToFirstFeedbackMs).toBe(100);
    expect(timing?.eventToFullConvergenceMs).toBe(100);
    engine.dispose();
  });

  it('still degrades and cancels an occupied command at the convergence deadline after timing expires', async () => {
    const { clock, adapter, engine } = setup({
      retryDelayMs: 1_000,
      convergenceTimeoutMs: 1_000,
    });
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    const timing = engine.state.timings.at(-1);
    const command = engine.state.commands.find(
      (entry) => entry.target === 'lighting.desk' && entry.status === 'pending',
    );
    expect(command).toBeDefined();

    clock.advanceBy(1_000);
    await flushMicrotasks();

    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'degraded',
    );
    expect(
      engine.state.commands.find((entry) => entry.id === command?.id)?.status,
    ).toBe('cancelled');
    expect(timing?.fullConvergenceAt).toBeUndefined();
    expect(timing?.eventToFullConvergenceMs).toBeUndefined();
    engine.dispose();
  });

  it('drops fast-path feedback correlation after its convergence timeout', async () => {
    const { clock, adapter, engine } = setup({
      convergenceTimeoutMs: 100,
      prelight: { targets: { 'lighting.desk': { power: true } } },
    });
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
    });
    const timing = engine.state.timings.at(-1);
    expect(timing?.eventToFirstDispatchMs).toBe(0);

    clock.advanceBy(100);
    adapter.externalChange('lighting.desk', { power: true });
    await flushMicrotasks();
    expect(timing?.feedbackObservedAt).toBeUndefined();
    expect(timing?.fullConvergenceAt).toBeUndefined();
    engine.dispose();
  });

  it('drops fast-path feedback correlation after an adapter dispatch failure', async () => {
    const { adapter, engine } = setup({
      prelight: { targets: { 'lighting.desk': { power: true } } },
    });
    adapter.setAvailable(false);
    await engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
    });
    const timing = engine.state.timings.at(-1);
    expect(timing?.eventToFirstDispatchMs).toBe(0);
    expect(engine.state.commands.at(-1)?.status).toBe('failed');

    adapter.setAvailable(true);
    adapter.externalChange('lighting.desk', { power: true });
    expect(timing?.feedbackObservedAt).toBeUndefined();
    expect(timing?.fullConvergenceAt).toBeUndefined();
    engine.dispose();
  });

  it('drops prelight correlation when occupied presence cancels the prelight', async () => {
    const { clock, adapter, engine } = setup({
      prelight: { targets: { 'lighting.desk': { power: true } } },
    });
    adapter.feedbackDelayMs = 100;
    const prelightWork = engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
    });
    await flushMicrotasks();
    const prelightTiming = engine.state.timings.at(-1);

    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    clock.advanceBy(100);
    await flushMicrotasks();
    await prelightWork;

    expect(prelightTiming?.feedbackObservedAt).toBeUndefined();
    expect(prelightTiming?.fullConvergenceAt).toBeUndefined();
    engine.dispose();
  });

  it('keeps prelight ON through preview-off handoff and confirmed occupancy', async () => {
    const scene = {
      id: 'scene.entry',
      name: 'Entry',
      lighting: {
        'lighting.desk': {
          power: true as const,
          brightness: 42,
          colorTemperature: 3000,
        },
      },
    };
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [scene],
      defaultSceneId: scene.id,
      prelight: { targets: {}, maxDurationMs: 1_000 },
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    adapter.dispatched.length = 0;

    await engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
    });
    await engine.handleEvent({
      type: 'presence.prelight',
      active: false,
      source: 'stl27l',
    });
    clock.advanceBy(100);
    await flushMicrotasks();
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 42,
    });
    expect(adapter.dispatched.map(({ values }) => values)).toEqual([
      { power: true, brightness: 42, colorTemperature: 3000 },
    ]);

    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });

    expect(adapter.dispatched.map(({ values }) => values)).toEqual([
      { power: true, brightness: 42, colorTemperature: 3000 },
    ]);
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 42,
      colorTemperature: 3000,
    });
    expect(
      engine.state.diagnostics.some(
        ({ kind }) => kind === 'presence.prelight_feedback_honored',
      ),
    ).toBe(true);
    engine.dispose();
  });

  it('uses the pending default scene during first-entry prelight handoff', async () => {
    const scene = {
      id: 'scene.custom_default',
      name: 'Custom default',
      lighting: { 'lighting.desk': { power: true as const, brightness: 32 } },
    };
    const { adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [scene],
      defaultSceneId: scene.id,
      prelight: { targets: {}, maxDurationMs: 1_000 },
    });
    const internals = engine as unknown as {
      defaultSceneOnOccupancy: typeof scene;
    };
    internals.defaultSceneOnOccupancy = scene;
    engine.state.lighting.currentScene = null;
    adapter.externalChange('lighting.desk', { power: false, brightness: 0 });
    await engine.handleEvent({ type: 'presence.prelight', active: true });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });

    expect(adapter.dispatched.map(({ values }) => values)).toEqual([
      { power: true, brightness: 32 },
    ]);
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 32,
    });
    engine.dispose();
  });

  it('dispatches occupied intent before an in-flight timeout restore completes', async () => {
    const scene = {
      id: 'scene.entry',
      name: 'Entry',
      lighting: { 'lighting.desk': { power: true as const, brightness: 38 } },
    };
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [scene],
      defaultSceneId: scene.id,
      prelight: { targets: {}, maxDurationMs: 1_000 },
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    adapter.dispatched.length = 0;
    await engine.handleEvent({ type: 'presence.prelight', active: true });
    await engine.handleEvent({ type: 'presence.prelight', active: false });
    adapter.feedbackDelayMs = 500;
    clock.advanceBy(1_000);
    await flushMicrotasks();
    expect(adapter.dispatched.at(-1)?.values).toEqual({ power: false });

    const empty = engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    const occupied = engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    expect(engine.state.presence.state).toBe('occupied');
    await flushMicrotasks();
    expect(adapter.dispatched.map(({ values }) => values)).toEqual([
      { power: true, brightness: 38 },
      { power: false },
      { power: true, brightness: 38 },
    ]);

    clock.advanceBy(500);
    await flushMicrotasks();
    clock.advanceBy(500);
    await flushMicrotasks();
    await occupied;
    await empty;

    expect(adapter.dispatched.map(({ values }) => values)).toEqual([
      { power: true, brightness: 38 },
      { power: false },
      { power: true, brightness: 38 },
    ]);
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 38,
    });
    engine.dispose();
  });

  it('runs confirmed entry directly through prelight without an intervening OFF', async () => {
    const scene = {
      id: 'scene.entry',
      name: 'Entry',
      lighting: {
        'lighting.desk': {
          power: true as const,
          brightness: 42,
          colorTemperature: 3000,
        },
      },
    };
    const { adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [scene],
      defaultSceneId: scene.id,
      prelight: { targets: {}, maxDurationMs: 1_000 },
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    adapter.dispatched.length = 0;
    await engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });

    expect(adapter.dispatched.map(({ values }) => values)).toEqual([
      { power: true, brightness: 42, colorTemperature: 3000 },
    ]);
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 42,
      colorTemperature: 3000,
    });
    engine.dispose();
  });

  it('hands an accepted prelight command to occupancy without a duplicate ON', async () => {
    const scene = {
      id: 'scene.entry',
      name: 'Entry',
      lighting: {
        'lighting.desk': {
          power: true as const,
          brightness: 42,
          colorTemperature: 3000,
        },
      },
    };
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [scene],
      defaultSceneId: scene.id,
      retryDelayMs: 100,
      convergenceTimeoutMs: 1_000,
      prelight: { targets: {}, maxDurationMs: 1_000 },
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    adapter.dispatched.length = 0;
    adapter.ignoreNextForTargets.add('lighting.desk');

    await engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
    });
    expect(engine.state.commands.at(-1)?.status).toBe('pending');
    clock.advanceBy(200);
    await flushMicrotasks();

    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    expect(adapter.dispatched).toHaveLength(1);
    adapter.externalChange('lighting.desk', {
      power: true,
      brightness: 42,
      colorTemperature: 3000,
    });
    await flushMicrotasks();

    expect(adapter.dispatched).toHaveLength(1);
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 42,
      colorTemperature: 3000,
    });
    expect(
      engine.state.commands.some(
        ({ reason }) => reason === 'Confirmed empty: physical off',
      ),
    ).toBe(true);
    engine.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('hands an identical pending prelight command to an explicitly selected scene', async () => {
    const scene = {
      id: 'scene.entry',
      name: 'Entry',
      lighting: {
        'lighting.desk': {
          power: true as const,
          brightness: 42,
          colorTemperature: 3000,
        },
      },
    };
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [scene],
      defaultSceneId: scene.id,
      retryDelayMs: 100,
      convergenceTimeoutMs: 1_000,
      prelight: { targets: {}, maxDurationMs: 1_000 },
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    adapter.dispatched.length = 0;
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.handleEvent({ type: 'presence.prelight', active: true });
    clock.advanceBy(200);
    await flushMicrotasks();

    await engine.activateScene(scene.id, user, 'dashboard');
    expect(adapter.dispatched).toHaveLength(1);
    expect(adapter.dispatched[0]?.values).toEqual({
      power: true,
      brightness: 42,
      colorTemperature: 3000,
    });
    engine.dispose();
  });

  it('retries an accepted prelight after a short handoff grace without feedback', async () => {
    const scene = {
      id: 'scene.entry',
      name: 'Entry',
      lighting: { 'lighting.desk': { power: true as const, brightness: 42 } },
    };
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [scene],
      defaultSceneId: scene.id,
      retryDelayMs: 10_000,
      convergenceTimeoutMs: 60_000,
      prelight: { targets: {}, maxDurationMs: 1_000 },
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    adapter.dispatched.length = 0;
    adapter.ignoreNextForTargets.add('lighting.desk');

    await engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    expect(adapter.dispatched).toHaveLength(1);

    clock.advanceBy(999);
    await flushMicrotasks();
    expect(adapter.dispatched).toHaveLength(1);
    clock.advanceBy(1);
    await flushMicrotasks();
    expect(adapter.dispatched).toHaveLength(2);
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 42,
    });
    engine.dispose();
  });

  it('cleans accepted prelight tracking when commandless feedback confirms its ledger command', async () => {
    const scene = {
      id: 'scene.entry',
      name: 'Entry',
      lighting: { 'lighting.desk': { power: true as const, brightness: 42 } },
    };
    const { adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [scene],
      defaultSceneId: scene.id,
      prelight: { targets: {}, maxDurationMs: 1_000 },
    });
    const internals = engine as unknown as {
      acceptedLightingCommandIds: Set<string>;
      inFlightLightingCommandIds: Set<string>;
    };
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
    });
    const command = engine.state.commands.at(-1)!;
    expect(internals.acceptedLightingCommandIds.has(command.id)).toBe(true);

    adapter.externalChange('lighting.desk', {
      power: true,
      brightness: 42,
    });

    expect(
      engine.state.commands.find(({ id }) => id === command.id)?.status,
    ).toBe('confirmed');
    expect(internals.acceptedLightingCommandIds.has(command.id)).toBe(false);
    expect(internals.inFlightLightingCommandIds.has(command.id)).toBe(false);
    engine.dispose();
  });

  it('retries an unknown prelight delivery after occupancy instead of waiting for command timeout', async () => {
    const scene = {
      id: 'scene.entry',
      name: 'Entry',
      lighting: { 'lighting.desk': { power: true as const } },
    };
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [scene],
      defaultSceneId: scene.id,
      retryDelayMs: 100,
      convergenceTimeoutMs: 1_000,
      prelight: { targets: {}, maxDurationMs: 1_000 },
    });
    const dispatch = adapter.dispatch.bind(adapter);
    let failFirstDelivery = true;
    adapter.dispatch = async (command) => {
      if (failFirstDelivery) {
        failFirstDelivery = false;
        throw new LightingDeliveryUnknownError('simulated unknown delivery');
      }
      await dispatch(command);
    };
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    adapter.dispatched.length = 0;
    await engine.handleEvent({ type: 'presence.prelight', active: true });
    expect(
      engine.state.diagnostics.some(
        ({ kind }) => kind === 'command.delivery_unknown',
      ),
    ).toBe(true);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    clock.advanceBy(100);
    await flushMicrotasks();

    expect(adapter.dispatched).toHaveLength(1);
    expect(adapter.observed.get('lighting.desk')?.power).toBe(true);
    engine.dispose();
  });

  it('hands off while prelight feedback is still delayed in the adapter', async () => {
    const scene = {
      id: 'scene.entry',
      name: 'Entry',
      lighting: {
        'lighting.desk': {
          power: true as const,
          brightness: 42,
          colorTemperature: 3000,
        },
      },
    };
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [scene],
      defaultSceneId: scene.id,
      retryDelayMs: 100,
      convergenceTimeoutMs: 1_000,
      prelight: { targets: {}, maxDurationMs: 1_000 },
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    adapter.dispatched.length = 0;
    adapter.feedbackDelayMs = 500;

    const prelightWork = engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
    });
    await flushMicrotasks();
    expect(engine.state.commands.at(-1)?.status).toBe('pending');
    expect(adapter.dispatched).toHaveLength(1);

    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    expect(adapter.dispatched).toHaveLength(1);
    clock.advanceBy(500);
    await flushMicrotasks();
    await prelightWork;

    expect(adapter.dispatched).toHaveLength(1);
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 42,
      colorTemperature: 3000,
    });
    expect(
      engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
    ).toMatchObject({ power: true, brightness: 42, colorTemperature: 3000 });
    engine.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('restores a false-positive prelight after bounded flutter without command churn', async () => {
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [
        {
          id: 'scene.entry',
          name: 'Entry',
          lighting: { 'lighting.desk': { power: true, brightness: 40 } },
        },
      ],
      prelight: { targets: {}, maxDurationMs: 1_000 },
    });
    await engine.activateScene('scene.entry', user);
    adapter.observed.set('lighting.desk', { power: false, brightness: 0 });
    engine.state.lighting.devices['lighting.desk']!.observed = {
      power: false,
      brightness: 0,
    };
    adapter.dispatched.length = 0;
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    adapter.dispatched.length = 0;

    for (const active of [true, false, true, false] as const)
      await engine.handleEvent({
        type: 'presence.prelight',
        active,
        source: 'stl27l',
      });

    expect(
      adapter.dispatched.filter((command) => command.values.power === true),
    ).toHaveLength(1);
    expect(
      adapter.dispatched.filter((command) => command.values.power === false),
    ).toHaveLength(0);
    clock.advanceBy(1_000);
    await flushMicrotasks();

    expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    expect(
      adapter.dispatched.filter((command) => command.values.power === false),
    ).toHaveLength(1);
    engine.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('reasserts a differing final scene after stale prelight feedback without an OFF gap', async () => {
    const prelightScene = {
      id: 'scene.prelight',
      name: 'Prelight',
      lighting: {
        'lighting.desk': {
          power: true as const,
          brightness: 80,
          colorTemperature: 3000,
        },
      },
    };
    const finalScene = {
      id: 'scene.final',
      name: 'Final',
      lighting: {
        'lighting.desk': {
          power: true as const,
          brightness: 35,
          colorTemperature: 3000,
        },
      },
    };
    const { adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [prelightScene, finalScene],
      convergenceTimeoutMs: 5_000,
      prelight: { targets: {}, maxDurationMs: 1_000 },
    });
    await engine.activateScene(prelightScene.id, user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    adapter.dispatched.length = 0;
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.handleEvent({
      type: 'presence.prelight',
      active: true,
      source: 'stl27l',
    });

    await engine.activateScene(finalScene.id, user);
    expect(adapter.dispatched.map(({ values }) => values)).toEqual([
      { power: true, brightness: 80, colorTemperature: 3000 },
      { power: true, brightness: 35, colorTemperature: 3000 },
    ]);
    expect(
      adapter.dispatched.some((command) => command.values.power === false),
    ).toBe(false);

    adapter.externalChange('lighting.desk', {
      power: true,
      brightness: 80,
      colorTemperature: 3000,
    });
    await flushMicrotasks();

    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 35,
      colorTemperature: 3000,
    });
    expect(
      adapter.dispatched.some((command) => command.values.power === false),
    ).toBe(false);
    engine.dispose();
  });

  it('drops an unfinished presence correlation when a new scene supersedes it', async () => {
    const { clock, adapter, engine } = setup({
      retryDelayMs: 500,
      convergenceTimeoutMs: 2_000,
    });
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    const presenceTiming = engine.state.timings.at(-1);
    expect(presenceTiming?.eventToFirstDispatchMs).toBeUndefined();

    await engine.activateScene('scene.movie', user);
    clock.advanceBy(500);
    await flushMicrotasks();
    expect(presenceTiming?.eventToFirstDispatchMs).toBeUndefined();
    expect(presenceTiming?.feedbackObservedAt).toBeUndefined();
    expect(presenceTiming?.fullConvergenceAt).toBeUndefined();
    engine.dispose();
  });

  it('turns an external brightness change into a property override only', async () => {
    const { adapter, engine } = setup();
    await engine.activateScene('scene.cozy', user);
    adapter.externalChange(
      'lighting.desk',
      { brightness: 47 },
      {
        actor: { type: 'physical_remote', id: 'desk-remote' },
        source: 'remote',
      },
    );
    const desk = engine.state.lighting.devices['lighting.desk'];
    expect(desk?.effectiveDesired.brightness).toBe(47);
    expect(desk?.ownership.brightness?.kind).toBe('override');
    if (desk?.ownership.brightness?.kind === 'override') {
      expect(desk.ownership.brightness.actor.type).toBe('physical_remote');
      expect(desk.ownership.brightness.source).toBe('remote');
    }
    expect(desk?.ownership.power?.kind).toBe('scene');
    expect(desk?.ownership.colorTemperature?.kind).toBe('scene');
    expect(desk?.observed.brightness).toBe(47);
    expect(
      engine.state.diagnostics.some(
        (entry) => entry.kind === 'lighting.override',
      ),
    ).toBe(true);
    engine.dispose();
  });

  it('clears old property overrides when a new scene takes control', async () => {
    const { adapter, engine } = setup();
    await engine.activateScene('scene.cozy', user);
    adapter.externalChange('lighting.desk', { brightness: 47 });
    await engine.activateScene('scene.movie', user);
    const desk = engine.state.lighting.devices['lighting.desk'];
    expect(desk?.ownership.brightness?.kind).toBe('scene');
    expect(desk?.effectiveDesired.brightness).toBe(0);
    expect(desk?.observed.brightness).toBe(47);
    expect(desk?.observed.power).toBe(false);
    expect(engine.state.lighting.currentScene).toBe('scene.movie');
    engine.dispose();
  });

  it('reapply clears an external override and restores the current baseline', async () => {
    const { adapter, engine } = setup();
    await engine.activateScene('scene.cozy', user);
    adapter.externalChange('lighting.desk', { brightness: 47 });
    await engine.reapplyScene(user);
    expect(
      engine.state.lighting.devices['lighting.desk']?.effectiveDesired
        .brightness,
    ).toBe(30);
    expect(
      engine.state.lighting.devices['lighting.desk']?.ownership.brightness
        ?.kind,
    ).toBe('scene');
    expect(adapter.observed.get('lighting.desk')?.brightness).toBe(30);
    engine.dispose();
  });

  it('retries ignored commands with backoff and cancels old work on a newer scene', async () => {
    const { clock, adapter, engine } = setup({
      retryDelayMs: 500,
      convergenceTimeoutMs: 5_000,
    });
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.activateScene('scene.cozy', user);
    const oldRevision = engine.state.lighting.sceneRevision;
    expect(
      engine.state.lighting.devices['lighting.desk']?.observed.brightness,
    ).toBeUndefined();
    expect(
      adapter.dispatched.filter(
        (command) => command.target === 'lighting.desk',
      ),
    ).toHaveLength(1);
    clock.advanceBy(500);
    await flushMicrotasks();
    expect(
      adapter.dispatched.filter(
        (command) => command.target === 'lighting.desk',
      ),
    ).toHaveLength(2);
    expect(
      engine.state.lighting.devices['lighting.desk']?.observed.brightness,
    ).toBe(30);
    const deskCommands = engine.state.commands.filter(
      (command) => command.target === 'lighting.desk',
    );
    expect(deskCommands[0]?.status).toBe('superseded');
    expect(deskCommands[1]?.status).toBe('confirmed');
    const oldCommandCount = engine.state.commands.filter(
      (command) => command.revision === oldRevision,
    ).length;
    await engine.activateScene('scene.movie', user);
    clock.advanceBy(1_000);
    await flushMicrotasks();
    expect(engine.state.lighting.sceneRevision).toBe(oldRevision + 1);
    expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    expect(
      engine.state.commands.filter(
        (command) => command.revision === oldRevision,
      ),
    ).toHaveLength(oldCommandCount);
    engine.dispose();
  });

  it('cancels a scheduled retry when a newer scene is selected', async () => {
    const { clock, adapter, engine } = setup({ retryDelayMs: 2_000 });
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.activateScene('scene.cozy', user);
    const oldRevision = engine.state.lighting.sceneRevision;
    const oldCount = engine.state.commands.filter(
      (command) => command.revision === oldRevision,
    ).length;
    await engine.activateScene('scene.movie', user);
    clock.advanceBy(10_000);
    await flushMicrotasks();
    expect(
      engine.state.commands.filter(
        (command) => command.revision === oldRevision,
      ),
    ).toHaveLength(oldCount);
    expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    expect(
      engine.state.commands.some(
        (command) =>
          command.revision === oldRevision && command.status === 'pending',
      ),
    ).toBe(false);
    engine.dispose();
  });

  it('marks an unavailable device degraded after timeout and allows recovery reconciliation', async () => {
    const { clock, adapter, engine } = setup({
      retryDelayMs: 250,
      convergenceTimeoutMs: 1_000,
    });
    adapter.setAvailable(false);
    await engine.activateScene('scene.cozy', user);
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'unavailable',
    );
    expect(
      engine.state.lighting.devices['lighting.desk']?.ownership.brightness
        ?.kind,
    ).toBe('scene');
    expect(
      engine.state.diagnostics.some(
        (entry) => entry.kind === 'lighting.override',
      ),
    ).toBe(false);
    for (let elapsed = 0; elapsed < 1_000; elapsed += 250) {
      clock.advanceBy(250);
      await flushMicrotasks();
    }
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'degraded',
    );
    adapter.setAvailable(true);
    await engine.deviceBecameAvailable('lighting.desk');
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'available',
    );
    expect(adapter.observed.get('lighting.desk')?.brightness).toBe(30);
    engine.dispose();
  });

  it('starts a fresh bounded scene attempt when lighting feedback recovers a device', async () => {
    const { clock, adapter, engine } = setup({
      retryDelayMs: 250,
      convergenceTimeoutMs: 1_000,
    });
    adapter.setAvailable(false);
    await engine.activateScene('scene.cozy', user);
    for (let elapsed = 0; elapsed < 1_000; elapsed += 250) {
      clock.advanceBy(250);
      await flushMicrotasks();
    }
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'degraded',
    );

    const dispatchCount = adapter.dispatched.length;
    adapter.setAvailable(true);
    adapter.externalChange('lighting.desk', { power: false });
    await flushMicrotasks();

    expect(adapter.dispatched.length).toBeGreaterThan(dispatchCount);
    expect(adapter.dispatched.at(-1)).toMatchObject({
      target: 'lighting.desk',
      values: expect.objectContaining({ power: true }),
    });
    expect(adapter.observed.get('lighting.desk')?.power).toBe(true);
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'available',
    );
    engine.dispose();
  });

  it('keeps another light degraded when only one light recovers', async () => {
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.ceiling', 'lighting.desk'],
      scenes: [
        {
          id: 'scene.cozy',
          name: 'Cozy',
          lighting: {
            'lighting.ceiling': { power: true },
            'lighting.desk': { power: true },
          },
        },
      ],
      retryDelayMs: 250,
      convergenceTimeoutMs: 1_000,
    });
    adapter.setAvailable(false);
    await engine.activateScene('scene.cozy', user);
    for (let elapsed = 0; elapsed < 1_000; elapsed += 250) {
      clock.advanceBy(250);
      await flushMicrotasks();
    }
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'degraded',
    );

    adapter.setAvailable(true);
    adapter.externalChange('lighting.ceiling', { power: false });
    await flushMicrotasks();

    expect(
      engine.state.lighting.devices['lighting.ceiling']?.availability,
    ).toBe('available');
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'degraded',
    );
    engine.dispose();
  });

  it('retries a degraded light when a new scene revision is selected', async () => {
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [
        {
          id: 'scene.cozy',
          name: 'Cozy',
          lighting: { 'lighting.desk': { power: true, brightness: 30 } },
        },
        {
          id: 'scene.focus',
          name: 'Focus',
          lighting: { 'lighting.desk': { power: true, brightness: 80 } },
        },
      ],
      retryDelayMs: 250,
      convergenceTimeoutMs: 1_000,
    });
    adapter.setAvailable(false);
    await engine.activateScene('scene.cozy', user);
    for (let elapsed = 0; elapsed < 1_000; elapsed += 250) {
      clock.advanceBy(250);
      await flushMicrotasks();
    }
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'degraded',
    );

    adapter.setAvailable(true);
    const before = adapter.dispatched.length;
    await engine.activateScene('scene.focus', user);

    expect(adapter.dispatched.length).toBeGreaterThan(before);
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 80,
    });
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'available',
    );
    engine.dispose();
  });

  it('restarts only the explicitly adjusted degraded light', async () => {
    const { clock, adapter, engine } = setup({
      deviceIds: ['lighting.desk'],
      scenes: [
        {
          id: 'scene.cozy',
          name: 'Cozy',
          lighting: { 'lighting.desk': { power: true, brightness: 30 } },
        },
      ],
      retryDelayMs: 250,
      convergenceTimeoutMs: 1_000,
    });
    adapter.setAvailable(false);
    await engine.activateScene('scene.cozy', user);
    for (let elapsed = 0; elapsed < 1_000; elapsed += 250) {
      clock.advanceBy(250);
      await flushMicrotasks();
    }
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'degraded',
    );

    adapter.setAvailable(true);
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.setLighting(
      'lighting.desk',
      { brightness: 50 },
      { actor: user, source: 'dashboard' },
    );
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'available',
    );
    clock.advanceBy(250);
    await flushMicrotasks();

    expect(adapter.observed.get('lighting.desk')?.brightness).toBe(50);
    engine.dispose();
  });

  it('restores current intent when feedback from an older delayed scene arrives late', async () => {
    const { clock, adapter, engine } = setup();
    adapter.feedbackDelayMs = 1_000;
    const oldSceneWork = engine.activateScene(
      'scene.cozy',
      user,
      'web',
      'request-old',
    );
    const oldRevision = engine.state.lighting.sceneRevision;
    adapter.feedbackDelayMs = 100;
    const currentSceneWork = engine.activateScene(
      'scene.movie',
      user,
      'hub',
      'request-current',
    );
    await flushMicrotasks();
    clock.advanceBy(100);
    await flushMicrotasks();
    await currentSceneWork;
    expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    clock.advanceBy(900);
    await flushMicrotasks();
    await oldSceneWork;
    await flushMicrotasks();
    clock.advanceBy(100);
    await flushMicrotasks();
    expect(engine.state.lighting.sceneRevision).toBe(oldRevision + 1);
    expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    expect(
      engine.state.lighting.devices['lighting.desk']?.ownership.power?.kind,
    ).toBe('scene');
    expect(
      engine.state.diagnostics.some(
        (entry) => entry.kind === 'command.stale_feedback',
      ),
    ).toBe(true);
    const currentCommands = engine.state.commands.filter(
      (command) => command.revision === oldRevision + 1,
    );
    expect(
      currentCommands.every((command) => command.actor.type === 'user'),
    ).toBe(true);
    expect(
      currentCommands.every(
        (command) => command.requestId === 'request-current',
      ),
    ).toBe(true);
    engine.dispose();
  });

  it('turns lights off on confirmed empty while retaining scene and overrides for a quick return', async () => {
    const { clock, adapter, engine } = setup({ continuityMs: 10_000 });
    await engine.activateScene('scene.cozy', user);
    adapter.externalChange('lighting.desk', { brightness: 47 });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    const exitTiming = engine.state.timings.at(-1);
    expect(exitTiming?.commandDispatchedAt).toBeDefined();
    expect(exitTiming?.feedbackObservedAt).toBeDefined();
    expect(exitTiming?.fullConvergenceAt).toBeDefined();
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(false);
    expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    expect(engine.state.lighting.currentScene).toBe('scene.cozy');
    expect(
      engine.state.lighting.devices['lighting.desk']?.effectiveDesired
        .brightness,
    ).toBe(47);
    expect(
      engine.state.lighting.devices['lighting.desk']?.ownership.brightness
        ?.kind,
    ).toBe('override');
    clock.advanceBy(5_000);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(true);
    expect(adapter.observed.get('lighting.desk')?.power).toBe(true);
    expect(adapter.observed.get('lighting.desk')?.brightness).toBe(47);
    const occupiedTiming = engine.state.timings.at(-1);
    expect(occupiedTiming?.eventId).toMatch(/^presence-/);
    expect(occupiedTiming?.commandDispatchedAt).toBeDefined();
    expect(occupiedTiming?.feedbackObservedAt).toBeDefined();
    expect(occupiedTiming?.fullConvergenceAt).toBeDefined();
    engine.dispose();
  });

  it('continues a confirmed-empty off retry after presence becomes unknown', async () => {
    const { clock, adapter, engine } = setup({ retryDelayMs: 500 });
    await engine.activateScene('scene.cozy', user);
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
      personCount: null,
    });

    clock.advanceBy(500);
    await flushMicrotasks();

    expect(engine.state.presence.state).toBe('unknown');
    expect(
      adapter.dispatched.filter(
        (command) =>
          command.target === 'lighting.desk' && command.values.power === false,
      ),
    ).toHaveLength(2);
    expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    engine.dispose();
  });

  it('corrects a lighting power-on observation while still physically empty through unknown', async () => {
    const { adapter, engine } = setup();
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
      personCount: null,
    });

    adapter.externalChange('lighting.desk', { power: true });

    expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    expect(
      engine.state.lighting.devices['lighting.desk']?.ownership.power?.kind,
    ).toBe('scene');
    engine.dispose();
  });

  it('does not treat unknown as empty or clear continuity memory', async () => {
    const { adapter, engine } = setup({ continuityMs: 10_000 });
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    const expiration = engine.state.presence.continuityExpiresAt;
    const commandsBeforeUnknown = engine.state.commands.length;
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
    });
    expect(engine.state.presence.continuityExpiresAt).toBe(expiration);
    expect(engine.state.lighting.currentScene).toBe('scene.cozy');
    expect(engine.state.commands).toHaveLength(commandsBeforeUnknown);
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(false);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    expect(engine.state.lighting.currentScene).toBe('scene.cozy');
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(true);
    expect(
      engine.state.diagnostics.some(
        (entry) => entry.kind === 'presence.returned',
      ),
    ).toBe(true);
    engine.dispose();
  });

  it('does not start a new empty continuity window after an unknown gap', async () => {
    const { clock, adapter, engine } = setup({ continuityMs: 10_000 });
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });

    const originalExpiry = engine.state.presence.continuityExpiresAt;
    const timingCount = engine.state.timings.length;
    const commandCount = engine.state.commands.length;
    clock.advanceBy(4_000);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });

    expect(engine.state.presence.continuityExpiresAt).toBe(originalExpiry);
    expect(engine.state.timings).toHaveLength(timingCount);
    expect(engine.state.commands).toHaveLength(commandCount);
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(false);
    engine.dispose();
  });

  it('treats occupied through unknown to confirmed empty as a real exit', async () => {
    const { clock, engine } = setup({ continuityMs: 10_000 });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    clock.advanceBy(4_000);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });

    expect(engine.state.presence.continuityExpiresAt).toBe(
      clock.now() + 10_000,
    );
    expect(
      engine.state.diagnostics.some((entry) => entry.kind === 'presence.empty'),
    ).toBe(true);
    engine.dispose();
  });

  it('expires continuity on time while unknown and publishes the cleared state', async () => {
    const { clock, engine } = setup({ continuityMs: 1_000 });
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    const expiration = engine.state.presence.continuityExpiresAt;
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
    });
    const snapshot = engine.stream.resume(null, engine.state);
    expect(snapshot.kind).toBe('snapshot');
    if (snapshot.kind !== 'snapshot')
      throw new Error('Expected state snapshot');

    const updates: Parameters<typeof applyStateUpdate>[1][] = [];
    const unsubscribe = engine.stream.subscribe((update) =>
      updates.push(update),
    );
    clock.advanceBy(1_000);

    expect(engine.state.presence.state).toBe('unknown');
    expect(expiration).toBe(clock.now());
    expect(engine.state.presence.continuityExpiresAt).toBeNull();
    expect(engine.state.lighting.currentScene).toBeNull();
    expect(
      Object.values(engine.state.lighting.devices).every(
        (device) =>
          Object.keys(device.baselineDesired).length === 0 &&
          Object.keys(device.effectiveDesired).length === 0 &&
          Object.keys(device.ownership).length === 0,
      ),
    ).toBe(true);
    const expiryUpdate = updates.find((update) =>
      update.patch.diagnostics?.some(
        (diagnostic) => diagnostic.kind === 'continuity.expired',
      ),
    );
    expect(expiryUpdate?.domains).toEqual(
      expect.arrayContaining([
        'presence',
        'lighting',
        'commands',
        'diagnostics',
      ]),
    );
    expect(
      expiryUpdate && applyStateUpdate(snapshot.state, expiryUpdate),
    ).toEqual(engine.state);

    unsubscribe();
    engine.dispose();
  });

  it('drops visit overrides at continuity expiry and applies the configured default on the next entry', async () => {
    const { clock, adapter, engine } = setup({
      continuityMs: 1_000,
      deviceIds: ['lighting.desk'],
      scenes: [
        {
          id: 'scene.default',
          name: 'Default',
          lighting: { 'lighting.desk': { power: true, brightness: 55 } },
        },
        {
          id: 'scene.cozy',
          name: 'Cozy',
          lighting: { 'lighting.desk': { power: true, brightness: 20 } },
        },
      ],
      defaultSceneId: 'scene.default',
    });
    await engine.activateScene('scene.cozy', user);
    adapter.externalChange('lighting.desk', { brightness: 47 });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });

    clock.advanceBy(1_000);
    await flushMicrotasks();
    expect(engine.state.lighting.currentScene).toBeNull();
    expect(engine.defaultScenePending).toBe(true);
    expect(
      engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
    ).toEqual({});

    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });

    expect(engine.state.lighting.currentScene).toBe('scene.default');
    expect(engine.defaultScenePending).toBe(false);
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 55,
    });
    engine.dispose();
  });

  it.each([
    {
      id: 'scene.all_off',
      name: 'All off',
      lighting: {
        'lighting.ceiling': { power: false },
        'lighting.desk': { power: false },
      },
    },
    {
      id: 'scene.sleep',
      name: 'Sleep',
      lighting: {
        'lighting.ceiling': { power: false },
        'lighting.desk': { power: true, brightness: 2 },
      },
    },
  ])(
    'retains explicit $id semantics after continuity expiry',
    async (scene) => {
      const { clock, adapter, engine } = setup({
        continuityMs: 1_000,
        scenes: [
          {
            id: 'scene.default',
            name: 'Default',
            lighting: {
              'lighting.ceiling': { power: true, brightness: 60 },
              'lighting.desk': { power: true, brightness: 55 },
            },
          },
          scene,
        ],
        defaultSceneId: 'scene.default',
      });
      await engine.activateScene(scene.id, user);
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
        personCount: 0,
      });
      clock.advanceBy(1_000);
      await flushMicrotasks();

      expect(engine.state.lighting.currentScene).toBe(scene.id);
      expect(engine.defaultScenePending).toBe(false);
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 1,
      });
      expect(engine.state.lighting.currentScene).toBe(scene.id);
      if (scene.id === 'scene.all_off') {
        expect(adapter.observed.get('lighting.ceiling')?.power).toBe(false);
        expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
      } else {
        expect(adapter.observed.get('lighting.desk')).toMatchObject({
          power: true,
          brightness: 2,
        });
        expect(adapter.observed.get('lighting.ceiling')?.power).toBe(false);
      }
      engine.dispose();
    },
  );

  it('retains an explicit sleep scene from an expired persisted intent', async () => {
    const clock = new FakeClock(Date.parse('2026-09-28T12:00:00+02:00'));
    const adapter = new SimulatedLightingAdapter(clock);
    const engine = new LugnEngine(clock, {
      adapter,
      deviceIds: ['lighting.desk'],
      scenes: [
        {
          id: 'scene.default',
          name: 'Default',
          lighting: { 'lighting.desk': { power: true, brightness: 60 } },
        },
        {
          id: 'scene.sleep',
          name: 'Sleep',
          lighting: { 'lighting.desk': { power: true, brightness: 2 } },
        },
      ],
      defaultSceneId: 'scene.default',
      restoredLightingIntent: {
        currentScene: 'scene.sleep',
        sceneRevision: 4,
        continuityExpiresAt: clock.now() - 1,
        devices: {
          'lighting.desk': {
            baselineDesired: { power: true, brightness: 2 },
            effectiveDesired: { power: true, brightness: 17 },
            ownership: {
              power: { kind: 'scene', revision: 4 },
              brightness: {
                kind: 'override',
                actor: user,
                reason: 'temporary',
                createdAt: clock.now() - 100,
              },
            },
          },
        },
      },
    });

    expect(engine.state.lighting.currentScene).toBe('scene.sleep');
    expect(engine.defaultScenePending).toBe(false);
    expect(
      engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
    ).toEqual({ power: true, brightness: 2 });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 2,
    });
    engine.dispose();
  });

  it('reasserts an expired persisted all-off scene during unknown state seeding', async () => {
    const clock = new FakeClock(Date.parse('2026-09-28T12:00:00+02:00'));
    const adapter = new SimulatedLightingAdapter(clock);
    const engine = new LugnEngine(clock, {
      adapter,
      deviceIds: ['lighting.desk'],
      scenes: [
        {
          id: 'scene.all_off',
          name: 'All off',
          lighting: { 'lighting.desk': { power: false } },
        },
      ],
      restoredLightingIntent: {
        currentScene: 'scene.all_off',
        sceneRevision: 4,
        continuityExpiresAt: clock.now() - 1,
        devices: {
          'lighting.desk': {
            baselineDesired: { power: false },
            effectiveDesired: { power: false },
            ownership: { power: { kind: 'scene', revision: 4 } },
          },
        },
      },
    });

    adapter.externalChange('lighting.desk', { power: true });
    await flushMicrotasks();

    expect(engine.state.presence.state).toBe('unknown');
    expect(adapter.dispatched).toContainEqual(
      expect.objectContaining({
        target: 'lighting.desk',
        values: { power: false },
      }),
    );
    engine.dispose();
  });

  it('waits for a new confirmed entry after a quiet-hours-suppressed visit', async () => {
    const clock = new FakeClock(Date.parse('2026-09-30T05:55:00+02:00'));
    const adapter = new SimulatedLightingAdapter(clock);
    const engine = new LugnEngine(clock, {
      adapter,
      deviceIds: ['lighting.ceiling'],
      scenes: [
        {
          id: 'scene.default',
          name: 'Default',
          lighting: { 'lighting.ceiling': { power: true, brightness: 60 } },
        },
      ],
      defaultSceneId: 'scene.default',
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    clock.advanceBy(5 * 60_000);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    expect(engine.defaultScenePending).toBe(true);
    expect(adapter.dispatched).toEqual([]);

    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    expect(engine.state.lighting.currentScene).toBe('scene.default');
    expect(engine.defaultScenePending).toBe(false);
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(true);
    engine.dispose();
  });

  it('cancels the continuity expiry when occupied returns before the deadline', async () => {
    const { clock, adapter, engine } = setup({ continuityMs: 1_000 });
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    clock.advanceBy(999);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    clock.advanceBy(1);

    expect(engine.state.lighting.currentScene).toBe('scene.cozy');
    expect(engine.state.presence.continuityExpiresAt).toBeNull();
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(true);
    expect(
      engine.state.diagnostics.some(
        (entry) => entry.kind === 'continuity.expired',
      ),
    ).toBe(false);
    engine.dispose();
  });

  it('cancels the continuity expiry when the engine is disposed', async () => {
    const { clock, engine } = setup({ continuityMs: 1_000 });
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    const revision = engine.state.revision;
    engine.dispose();
    clock.advanceBy(1_000);

    expect(engine.state.revision).toBe(revision);
    expect(engine.state.lighting.currentScene).toBe('scene.cozy');
    expect(
      engine.state.diagnostics.some(
        (entry) => entry.kind === 'continuity.expired',
      ),
    ).toBe(false);
  });

  it('does not shut off the room or create a new visit for occupied-to-unknown recovery', async () => {
    const { adapter, engine } = setup();
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    const sceneRevision = engine.state.lighting.sceneRevision;
    const commandCount = engine.state.commands.length;
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
      personCount: null,
    });
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(true);
    expect(engine.state.presence.continuityExpiresAt).toBeNull();
    expect(engine.state.commands).toHaveLength(commandCount);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    expect(engine.state.lighting.sceneRevision).toBe(sceneRevision);
    expect(
      engine.state.diagnostics.some(
        (entry) => entry.kind === 'presence.returned',
      ),
    ).toBe(false);
    engine.dispose();
  });

  it('expires remembered state exactly at the continuity deadline', async () => {
    const { clock, adapter, engine } = setup({ continuityMs: 1_000 });
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    clock.advanceBy(1_000);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(engine.state.lighting.currentScene).toBeNull();
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(false);
    expect(
      engine.state.diagnostics.some(
        (entry) => entry.kind === 'continuity.expired',
      ),
    ).toBe(true);
    engine.dispose();
  });

  it('keeps event revisions monotonic and resyncs clients after history gaps', async () => {
    const { engine } = setup({ stateHistoryLimit: 2 });
    const deliveries: number[] = [];
    const snapshot = engine.stream.resume(null, engine.state);
    expect(snapshot.kind).toBe('snapshot');
    const updates: Parameters<typeof applyStateUpdate>[1][] = [];
    const unsubscribe = engine.stream.subscribe((update) => {
      deliveries.push(update.revision);
      updates.push(update);
    });
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(
      deliveries.every(
        (revision, index) => index === 0 || revision > deliveries[index - 1]!,
      ),
    ).toBe(true);
    expect(
      updates.every(
        (update) =>
          update.domains.length > 0 && Object.keys(update.patch).length < 5,
      ),
    ).toBe(true);
    if (snapshot.kind === 'snapshot') {
      const rebuilt = updates.reduce(applyStateUpdate, snapshot.state);
      expect(rebuilt).toEqual(engine.state);
    }
    const caughtUp = engine.stream.resume(engine.state.revision, engine.state);
    expect(caughtUp.kind).toBe('updates');
    if (caughtUp.kind === 'updates') expect(caughtUp.updates).toEqual([]);
    const gap = engine.stream.resume(0, engine.state);
    expect(gap.kind).toBe('snapshot');
    unsubscribe();
    engine.dispose();
  });

  it('validates capability inputs and returns typed operation results', async () => {
    const { engine } = setup();
    const capabilities = new CapabilityRegistry(engine);
    await expect(
      capabilities.invoke(
        'lighting.activateScene',
        { sceneId: 'missing' },
        { actor: user },
      ),
    ).rejects.toThrow('scene_not_found');
    await expect(
      capabilities.invoke(
        'lighting.set',
        { target: 'lighting.desk', values: { brightness: 101 } },
        { actor: user },
      ),
    ).rejects.toThrow();
    const response = await capabilities.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.cozy' },
      {
        actor: user,
        source: 'test',
        requestId: 'req-1',
        reason: 'direct user intent',
      },
    );
    expect(response).toEqual({ sceneRevision: 1 });
    expect(engine.state.commands[0]?.requestId).toBe('req-1');
    engine.dispose();
  });
});
