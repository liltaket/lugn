import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import {
  LugnEngine,
  type EngineOptions,
} from '../src/application/lugn-engine.js';
import { RoomSessions } from '../src/application/room-sessions.js';
import { FakeClock, type Clock } from '../src/core/clock.js';
import { applyStateUpdate } from '../src/core/event-stream.js';
import type {
  Presence,
  RoomSession,
  StateUpdate,
} from '../src/core/schemas.js';

const startAt = Date.parse('2026-10-04T12:00:00+02:00');
const engines: LugnEngine[] = [];
const user = { type: 'user' as const, id: 'test-user' };

function setup(options: EngineOptions = {}) {
  const clock = new FakeClock(startAt);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    roomSessionContinuityMs: 10_000,
    ...options,
  });
  engines.push(engine);
  const presence = (state: Presence) =>
    engine.handlePresence({ type: 'presence.changed', presence: state });
  return { clock, engine, presence };
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe('room session lifecycle', () => {
  it('starts only from confirmed room occupancy, independent of home presence', async () => {
    const { engine, presence } = setup();
    expect(engine.state.session).toBeNull();
    await presence('unknown');
    await presence('confirmed_empty');
    await engine.handleHomePresence('home');
    expect(engine.state.session).toBeNull();
    await engine.handleHomePresence('away');
    await presence('occupied');
    expect(engine.state.session).toEqual({
      id: expect.any(String),
      state: 'active',
      startedAt: startAt,
      lastActiveAt: startAt,
      suspendedAt: null,
      expiresAt: null,
      endedAt: null,
    });
    const registry = new CapabilityRegistry(engine);
    const result = await registry.invoke('room.getState', {}, { actor: user });
    expect(result).toMatchObject({ state: { session: engine.state.session } });
  });

  it('keeps short returns and unknown gaps in the same session without extending absence', async () => {
    const { clock, engine, presence } = setup();
    await presence('occupied');
    const id = engine.state.session!.id;
    clock.advanceBy(1_000);
    await presence('occupied');
    expect(engine.state.session!.lastActiveAt).toBe(startAt + 1_000);
    clock.advanceBy(1_000);
    await presence('confirmed_empty');
    const suspended = structuredClone(engine.state.session);
    expect(suspended).toMatchObject({
      id,
      state: 'suspended',
      suspendedAt: startAt + 2_000,
      expiresAt: startAt + 12_000,
    });
    clock.advanceBy(4_000);
    await presence('unknown');
    await presence('confirmed_empty');
    expect(engine.state.session).toEqual(suspended);
    clock.advanceBy(5_999);
    await presence('occupied');
    expect(engine.state.session).toMatchObject({
      id,
      state: 'active',
      startedAt: startAt,
      lastActiveAt: startAt + 11_999,
      suspendedAt: null,
      expiresAt: null,
      endedAt: null,
    });
    clock.advanceBy(1);
    expect(engine.state.session!.state).toBe('active');
    expect(
      engine.state.diagnostics
        .filter((entry) => entry.kind.startsWith('session.'))
        .map((entry) => entry.kind),
    ).toEqual(['session.started', 'session.suspended', 'session.resumed']);
  });

  it('ends at the confirmed absence deadline and starts a new ID on later entry', async () => {
    const { clock, engine, presence } = setup();
    await presence('occupied');
    const id = engine.state.session!.id;
    clock.advanceBy(2_000);
    await presence('confirmed_empty');
    clock.advanceBy(9_999);
    expect(engine.state.session!.state).toBe('suspended');
    clock.advanceBy(1);
    expect(engine.state.session).toMatchObject({
      id,
      state: 'ended',
      suspendedAt: startAt + 2_000,
      expiresAt: startAt + 12_000,
      endedAt: startAt + 12_000,
    });
    await presence('confirmed_empty');
    clock.advanceBy(1_000);
    await presence('occupied');
    expect(engine.state.session!.id).not.toBe(id);
    expect(engine.state.session).toMatchObject({
      state: 'active',
      startedAt: startAt + 13_000,
    });
    const ended = engine.state.diagnostics.find(
      (entry) => entry.kind === 'session.ended',
    );
    expect(ended?.details).toMatchObject({ id, endedAt: startAt + 12_000 });
  });

  it('keeps active sessions through unknown and still expires a previously confirmed absence', async () => {
    const { clock, engine, presence } = setup();
    await presence('occupied');
    const active = structuredClone(engine.state.session);
    await presence('unknown');
    clock.advanceBy(20_000);
    expect(engine.state.session).toEqual(active);
    await presence('confirmed_empty');
    await presence('unknown');
    clock.advanceBy(10_000);
    expect(engine.state.presence.state).toBe('unknown');
    expect(engine.state.session).toMatchObject({
      id: active!.id,
      state: 'ended',
      endedAt: startAt + 30_000,
    });
  });

  it('publishes replayable lifecycle updates including expiry without a presence event', async () => {
    const { clock, engine, presence } = setup();
    const snapshot = engine.stream.resume(null, engine.state);
    expect(snapshot.kind).toBe('snapshot');
    const initial = structuredClone(engine.state);
    const updates: StateUpdate[] = [];
    const unsubscribe = engine.stream.subscribe((update) =>
      updates.push(update),
    );
    try {
      await presence('occupied');
      await presence('confirmed_empty');
      clock.advanceBy(10_000);
      await presence('occupied');
      expect(updates.reduce(applyStateUpdate, initial)).toEqual(engine.state);
      const sessionUpdates = updates.filter((update) =>
        update.domains.includes('session'),
      );
      expect(
        sessionUpdates.map((update) => update.patch.session?.state),
      ).toEqual(['active', 'suspended', 'ended', 'active']);
      expect(engine.stream.resume(initial.revision, engine.state)).toEqual({
        kind: 'updates',
        fromRevision: initial.revision,
        updates,
      });
    } finally {
      unsubscribe();
    }
  });

  it.each([
    {
      sessionMs: 5_000,
      lightingMs: 10_000,
      sameSession: false,
      retained: true,
    },
    {
      sessionMs: 10_000,
      lightingMs: 5_000,
      sameSession: true,
      retained: false,
    },
  ])(
    'retains independent lighting and music continuity with sessionMs=$sessionMs',
    async ({ sessionMs, lightingMs, sameSession, retained }) => {
      const clock = new FakeClock(startAt);
      const adapter = new SimulatedLightingAdapter(clock);
      const music = new SimulatedMusicAdapter(clock);
      const scene = {
        id: 'scene.cozy',
        name: 'Cozy',
        lighting: { 'lighting.desk': { power: true, brightness: 30 } },
      };
      const engine = new LugnEngine(clock, {
        adapter,
        deviceIds: ['lighting.desk'],
        scenes: [scene],
        continuityMs: lightingMs,
        roomSessionContinuityMs: sessionMs,
        music: { targets: { 'music.room': [] }, adapter: music },
      });
      engines.push(engine);
      await engine.handleBilresaPress('2', 'multi_press_1');
      await engine.activateScene(scene.id, user);
      adapter.externalChange('lighting.desk', { brightness: 47 });
      const playing = {
        playback: 'playing' as const,
        volume: 0.4,
        source: 'Spotify',
        title: 'Track',
      };
      music.observe('music.room', playing);
      await engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.4 },
        { actor: user },
      );
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
      });
      const id = engine.state.session!.id;
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
      });
      await flush();
      clock.advanceBy(1);
      music.observe('music.room', { ...playing, playback: 'paused' });
      clock.advanceBy(5_999);
      expect(engine.state.lighting.currentScene).toBe(
        retained ? scene.id : null,
      );
      expect(
        engine.state.lighting.devices['lighting.desk']!.effectiveDesired,
      ).toEqual(retained ? { power: true, brightness: 47 } : {});
      expect(
        engine.getMusicVolumePolicySnapshots()['music.room']!.baseline,
      ).toBe(0.4);
      const beforeReturn = music.dispatched.length;
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
      });
      await flush();
      expect(engine.state.session!.id === id).toBe(sameSession);
      expect(
        music.dispatched
          .slice(beforeReturn)
          .map((command) => command.requested),
      ).toEqual([{ property: 'playback', value: 'playing' }]);
    },
  );

  it.each(['active', 'suspended'] as const)(
    'starts a new process-local boundary after restart from %s while restoring lighting intent',
    async (state) => {
      const { clock, engine, presence } = setup();
      await presence('occupied');
      const previousId = engine.state.session!.id;
      if (state === 'suspended') await presence('confirmed_empty');
      const restoredLightingIntent = engine.getLightingIntentSnapshot();
      expect(restoredLightingIntent).not.toHaveProperty('session');
      engine.dispose();
      const restarted = new LugnEngine(clock, {
        deviceIds: [],
        scenes: [],
        restoredLightingIntent,
      });
      engines.push(restarted);
      expect(restarted.state.session).toBeNull();
      expect(restarted.state.presence.state).toBe('unknown');
      expect(restarted.state.commands).toEqual([]);
      await restarted.handlePresence({
        type: 'presence.changed',
        presence: 'unknown',
      });
      await restarted.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
      });
      expect(restarted.state.session).toBeNull();
      await restarted.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
      });
      expect(restarted.state.session!.state).toBe('active');
      expect(restarted.state.session!.id).not.toBe(previousId);
    },
  );

  it('does not clear an explicit music Pause when a session ends', async () => {
    const clock = new FakeClock(startAt);
    const adapter = new SimulatedMusicAdapter(clock);
    const engine = new LugnEngine(clock, {
      deviceIds: [],
      scenes: [],
      roomSessionContinuityMs: 5_000,
      music: { targets: { 'music.room': [] }, adapter },
    });
    engines.push(engine);
    const playing = {
      playback: 'playing' as const,
      volume: 0.3,
      source: 'Spotify',
      title: 'Track',
    };
    await engine.handleBilresaPress('2', 'multi_press_1');
    adapter.observe('music.room', playing);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    const id = engine.state.session!.id;
    await engine.requestMusic(
      'music.room',
      { property: 'playback', value: 'paused' },
      { actor: user },
    );
    clock.advanceBy(1);
    adapter.observe('music.room', { ...playing, playback: 'paused' });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    await flush();
    clock.advanceBy(5_000);
    const beforeReturn = adapter.dispatched.length;
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    await flush();
    expect(engine.state.session!.id).not.toBe(id);
    expect(adapter.dispatched).toHaveLength(beforeReturn);
  });

  it('clears the independent session timer on engine disposal', async () => {
    const { clock, engine, presence } = setup();
    await presence('occupied');
    await presence('confirmed_empty');
    const suspended = structuredClone(engine.state.session);
    engine.dispose();
    expect(clock.pendingTimers()).toBe(0);
    clock.advanceBy(20_000);
    expect(engine.state.session).toEqual(suspended);
  });

  it('uses the deadline even when the expiry timer is delayed past the next entry', () => {
    const underlying = new FakeClock(startAt);
    const clock: Clock = {
      now: () => underlying.now(),
      monotonicNow: () => underlying.monotonicNow(),
      setTimeout: (callback, delayMs) =>
        underlying.setTimeout(callback, delayMs + 1_000),
      clearTimeout: (timer) => underlying.clearTimeout(timer),
    };
    const states: RoomSession[] = [];
    const sessions = new RoomSessions(clock, 10_000, (session) =>
      states.push(session),
    );
    try {
      sessions.handlePresence('occupied');
      const id = states.at(-1)!.id;
      sessions.handlePresence('confirmed_empty');
      underlying.advanceBy(10_000);
      sessions.handlePresence('occupied');
      expect(states.map((session) => session.state)).toEqual([
        'active',
        'suspended',
        'ended',
        'active',
      ]);
      expect(states.at(-1)!.id).not.toBe(id);
      underlying.advanceBy(1_000);
      expect(states.at(-1)!.state).toBe('active');
    } finally {
      sessions.dispose();
    }
  });
});
