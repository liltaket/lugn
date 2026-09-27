import { describe, expect, it } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { SimulatedSwitchAdapter } from '../src/adapters/simulated-switch.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { applyStateUpdate } from '../src/core/event-stream.js';

const user = { type: 'user' as const, id: 'test-user' };

function setup(options: ConstructorParameters<typeof LugnEngine>[1] = {}) {
  const clock = new FakeClock(1_000);
  const adapter = new SimulatedLightingAdapter(clock);
  const engine = new LugnEngine(clock, { adapter, ...options });
  return { clock, adapter, engine };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe('Lugn deterministic lighting slice', () => {
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
    expect(after.observed).toEqual(before.effectiveDesired);
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
    expect(desk?.observed.brightness).toBe(0);
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
    clock.advanceBy(1_000);
    await flushMicrotasks();
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
    expect(expiration).toBe(2_000);
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
