import { afterEach, describe, expect, it } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { FakeClock } from '../src/core/clock.js';

const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));
const presence = (state: 'occupied' | 'confirmed_empty' | 'unknown') => ({
  type: 'presence.changed' as const,
  presence: state,
});

function setup(at: string) {
  const clock = new FakeClock(Date.parse(at));
  const lights = new SimulatedLightingAdapter(clock);
  const music = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    adapter: lights,
    deviceIds: ['lighting.desk'],
    scenes: [
      {
        id: 'scene.entry',
        name: 'Entry',
        lighting: { 'lighting.desk': { power: true, brightness: 60 } },
      },
      {
        id: 'scene.all_off',
        name: 'Off',
        lighting: { 'lighting.desk': { power: false } },
      },
    ],
    defaultSceneId: 'scene.entry',
    music: { targets: { 'music.room': [] }, adapter: music },
  });
  engines.push(engine);
  return { clock, lights, music, engine };
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('Stockholm night entry', () => {
  it.each([
    '2026-10-03T23:00:00+02:00',
    '2026-10-03T23:59:59+02:00',
    '2026-10-04T00:00:00+02:00',
    '2026-10-04T03:00:00+02:00',
    '2026-10-04T05:59:59+02:00',
    '2026-12-04T03:00:00+01:00',
    '2026-10-25T02:30:00+02:00',
    '2026-10-25T02:30:00+01:00',
  ])('turns lights on but does not start or resume music at %s', async (at) => {
    for (const wasPlaying of [false, true]) {
      const { engine, lights, music } = setup(at);
      if (wasPlaying) {
        music.observe('music.room', {
          playback: 'playing',
          volume: 0.3,
          source: 'Spotify',
          title: 'Track',
        });
        await engine.handlePresence(presence('occupied'));
      }
      await engine.handlePresence(presence('confirmed_empty'));
      await flush();
      const before = music.dispatched.length;
      await engine.handlePresence(presence('unknown'));
      await engine.handlePresence({ ...presence('occupied'), personCount: 1 });
      await flush();
      expect(lights.observed.get('lighting.desk')).toMatchObject({
        power: true,
        brightness: 60,
      });
      expect(
        music.dispatched
          .slice(before)
          .filter(
            ({ requested }) =>
              requested.property === 'preset' ||
              (requested.property === 'playback' &&
                requested.value === 'playing'),
          ),
      ).toEqual([]);
    }
  });

  it.each([
    '2026-10-04T06:00:00+02:00',
    '2026-10-04T22:59:59+02:00',
    '2026-12-04T06:00:00+01:00',
  ])('allows a new automatic start at %s', async (at) => {
    const { engine, music } = setup(at);
    await engine.handlePresence(presence('confirmed_empty'));
    await engine.handlePresence(presence('occupied'));
    await flush();
    expect(
      music.dispatched.some(
        ({ requested }) =>
          requested.property === 'preset' && requested.value === 'spotify_dj',
      ),
    ).toBe(true);
  });

  it('does not start music at dawn without a fresh entry and permits explicit night playback', async () => {
    const { engine, clock, music } = setup('2026-10-04T05:59:00+02:00');
    await engine.handlePresence(presence('confirmed_empty'));
    await engine.handlePresence(presence('occupied'));
    const before = music.dispatched.length;
    clock.advanceBy(2 * 60_000);
    await engine.handlePresence(presence('occupied'));
    await flush();
    expect(
      music.dispatched
        .slice(before)
        .filter(
          ({ requested }) =>
            requested.property === 'preset' ||
            requested.property === 'playback',
        ),
    ).toEqual([]);
    await engine.handlePresence(presence('confirmed_empty'));
    await engine.handlePresence(presence('occupied'));
    await flush();
    expect(music.dispatched.at(-1)?.requested).toEqual({
      property: 'preset',
      value: 'spotify_dj',
    });

    const night = setup('2026-10-04T03:00:00+02:00');
    await night.engine.requestMusic(
      'music.room',
      { property: 'playback', value: 'playing' },
      { actor: { type: 'user' } },
    );
    expect(night.music.dispatched.at(-1)?.requested).toEqual({
      property: 'playback',
      value: 'playing',
    });
  });

  it('keeps away and explicit all-off gates for lighting at night', async () => {
    const { engine, lights } = setup('2026-10-04T03:00:00+02:00');
    await engine.handleHomePresence('away');
    await engine.handlePresence(presence('occupied'));
    expect(lights.dispatched).toEqual([]);
    await engine.handleHomePresence('unknown');
    expect(lights.observed.get('lighting.desk')?.power).toBe(true);
    await engine.activateScene('scene.all_off', { type: 'user' });
    await engine.handlePresence(presence('confirmed_empty'));
    await engine.handlePresence(presence('occupied'));
    expect(lights.observed.get('lighting.desk')?.power).toBe(false);
  });
});
