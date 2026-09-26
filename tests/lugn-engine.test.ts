import { describe, expect, it } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
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

  it('expires remembered state only after confirmed absence exceeds continuity', async () => {
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
