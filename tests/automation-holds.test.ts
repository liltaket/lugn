import { describe, expect, it } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { FakeClock } from '../src/core/clock.js';
import { applyStateUpdate } from '../src/core/event-stream.js';
import type { Actor, Presence, StateUpdate } from '../src/core/schemas.js';

const user = { type: 'user' as const, id: 'bruno' };
const auto = { type: 'automation' as const };
const playing = {
  playback: 'playing' as const,
  volume: 0.3,
  source: 'Spotify',
  title: 'Song',
};
function setup() {
  const clock = new FakeClock(Date.parse('2026-10-04T12:00:00+02:00'));
  const lights = new SimulatedLightingAdapter(clock);
  const music = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    adapter: lights,
    deviceIds: ['lighting.desk', 'lighting.ceiling'],
    scenes: [
      {
        id: 'scene.lit',
        name: 'Lit',
        lighting: {
          'lighting.desk': { power: true, brightness: 40 },
          'lighting.ceiling': { power: true, brightness: 60 },
        },
      },
      {
        id: 'scene.all_off',
        name: 'Off',
        lighting: {
          'lighting.desk': { power: false },
          'lighting.ceiling': { power: false },
        },
      },
    ],
    music: { targets: { 'music.room': ['Spotify'] }, adapter: music },
    prelight: { targets: { 'lighting.desk': { power: true, brightness: 10 } } },
  });
  return {
    clock,
    lights,
    music,
    engine,
    presence: (presence: Presence) =>
      engine.handlePresence({
        type: 'presence.changed',
        presence,
        personCount: 1,
      }),
  };
}
async function flush() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

describe('scoped human automation holds', () => {
  it('does not create a hold for an invalid target or malformed request', () => {
    const { engine } = setup();
    try {
      expect(() =>
        engine.requestMusic(
          'music.missing',
          { property: 'playback', value: 'paused' },
          { actor: user },
        ),
      ).toThrow();
      expect(() =>
        engine.requestMusic(
          'music.room',
          { property: 'playback', value: 'invalid' } as never,
          { actor: user },
        ),
      ).toThrow();
      expect(engine.state.intent.holds).toEqual([]);
    } finally {
      engine.dispose();
    }
  });

  it('reconstructs retained off intent across restart without restoring playback or observations', async () => {
    const { engine, clock } = setup();
    await engine.activateScene('scene.all_off', user);
    const restarted = new LugnEngine(clock, {
      deviceIds: ['lighting.desk', 'lighting.ceiling'],
      scenes: [...engine.scenes.values()],
      restoredLightingIntent: engine.getLightingIntentSnapshot(),
    });
    try {
      expect(
        restarted.state.intent.holds.filter(
          (h) => h.scope === 'lighting.activation',
        ),
      ).toHaveLength(2);
      expect(restarted.state.presence.state).toBe('unknown');
      expect(
        restarted.state.lighting.devices['lighting.desk']?.observed,
      ).toEqual({});
      await expect(restarted.activateScene('scene.lit', auto)).rejects.toThrow(
        'held',
      );
    } finally {
      engine.dispose();
      restarted.dispose();
    }
  });
  it.each(['user', 'physical_remote', 'home_assistant'] as const)(
    '%s pause blocks only playback through timeouts and long absence until newer explicit play',
    async (type: Actor['type']) => {
      const { clock, engine, music, presence } = setup();
      try {
        music.observe('music.room', playing);
        await presence('occupied');
        await engine.requestMusic(
          'music.room',
          { property: 'playback', value: 'paused' },
          { actor: { type }, source: 'bed-hub' },
        );
        expect(engine.state.intent.holds).toContainEqual(
          expect.objectContaining({
            scope: 'music.playback',
            target: 'music.room',
            intent: 'paused',
            provenance: { actor: { type }, source: 'bed-hub' },
            resetPolicy: 'explicit_playback',
          }),
        );
        await presence('confirmed_empty');
        clock.advanceBy(25 * 60_000);
        music.observe(
          'music.room',
          { ...playing, title: 'Late metadata' },
          true,
          undefined,
          undefined,
          clock.now() - 30 * 60_000,
        );
        const before = music.dispatched.length;
        await presence('unknown');
        await presence('occupied');
        await flush();
        expect(
          music.dispatched
            .slice(before)
            .some(
              (c) =>
                c.requested.property === 'preset' ||
                c.requested.property === 'playback',
            ),
        ).toBe(false);
        expect(() =>
          engine.requestMusic(
            'music.room',
            { property: 'preset', value: 'spotify_dj' },
            { actor: auto },
          ),
        ).toThrow('held');
        await engine.requestMusic(
          'music.room',
          { property: 'volume', value: 0.4 },
          { actor: user },
        );
        expect(
          engine.state.intent.holds.some((h) => h.scope === 'music.playback'),
        ).toBe(true);
        await engine.requestMusic(
          'music.room',
          { property: 'playback', value: 'playing' },
          { actor: user },
        );
        expect(
          engine.state.intent.holds.some((h) => h.scope === 'music.playback'),
        ).toBe(false);
      } finally {
        engine.dispose();
      }
    },
  );

  it('keeps explicit room off across presence, prelight, retry, recovery and continuity expiry', async () => {
    const { clock, engine, lights, presence } = setup();
    try {
      await engine.activateScene('scene.all_off', user, 'bed-hub');
      const before = lights.dispatched.length;
      await presence('occupied');
      await presence('confirmed_empty');
      clock.advanceBy(25 * 60_000);
      await presence('occupied');
      await engine.handlePrelight({ type: 'presence.prelight', active: true });
      engine.state.lighting.devices['lighting.desk']!.availability =
        'unavailable';
      await engine.deviceBecameAvailable('lighting.desk');
      await engine.reconcileScene();
      clock.advanceBy(10_000);
      await flush();
      expect(
        lights.dispatched.slice(before).some((c) => c.values.power === true),
      ).toBe(false);
      expect(
        engine.state.intent.holds.filter(
          (h) => h.scope === 'lighting.activation',
        ),
      ).toHaveLength(2);
      await expect(engine.activateScene('scene.lit', auto)).rejects.toThrow(
        'held',
      );
      await expect(
        engine.setLighting('lighting.desk', { power: true }, { actor: auto }),
      ).rejects.toThrow('held');
      for (const values of [{ brightness: 50 }, { colorTemperature: 3000 }])
        await expect(
          engine.setLighting('lighting.desk', values, { actor: auto }),
        ).rejects.toThrow('held');
      await engine.setLighting(
        'lighting.desk',
        { power: true },
        { actor: user },
      );
      expect(
        engine.state.intent.holds
          .filter((h) => h.scope === 'lighting.activation')
          .map((h) => h.target),
      ).toEqual(['lighting.ceiling']);
      await engine.activateScene('scene.lit', user);
      expect(engine.state.intent.holds).toEqual([]);
    } finally {
      engine.dispose();
    }
  });

  it('projects property ownership and delivers the same holds through the state stream', async () => {
    const { engine } = setup();
    try {
      await engine.activateScene('scene.lit', user);
      let client = structuredClone(engine.state);
      const updates: StateUpdate[] = [];
      const unsubscribe = engine.stream.subscribe((update) =>
        updates.push(update),
      );
      await engine.setLighting(
        'lighting.desk',
        { brightness: 25 },
        { actor: user, source: 'desk-hub' },
      );
      for (const update of updates) client = applyStateUpdate(client, update);
      unsubscribe();
      expect(client.intent).toEqual(engine.state.intent);
      expect(client.intent.holds).toEqual([
        expect.objectContaining({
          scope: 'lighting.property',
          target: 'lighting.desk',
          property: 'brightness',
          intent: 25,
        }),
      ]);
      expect(
        engine.state.lighting.devices['lighting.desk']?.ownership.power?.kind,
      ).toBe('scene');
    } finally {
      engine.dispose();
    }
  });

  it('recognizes attributed physical pause and later physical play without promoting stale feedback', async () => {
    const { clock, engine, music } = setup();
    try {
      music.observe('music.room', playing);
      clock.advanceBy(1_000);
      music.observe('music.room', { ...playing, playback: 'paused' });
      expect(
        engine.state.intent.holds.some((h) => h.scope === 'music.playback'),
      ).toBe(true);
      clock.advanceBy(1_000);
      music.observe('music.room', playing);
      expect(
        engine.state.intent.holds.some((h) => h.scope === 'music.playback'),
      ).toBe(false);
    } finally {
      engine.dispose();
    }
  });
});
