import { afterEach, expect, it } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { defaultMusicVolumeSettings } from '../src/core/music-volume-settings.js';
import type { Presence } from '../src/core/schemas.js';

const values = {
  playback: 'playing' as const,
  volume: 0.3,
  source: 'PC',
  title: null,
};
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// The WiiM stores whole percent and truncates; HA REST carries no command id.
const wiim = (requested: number) => Math.floor(requested * 100 + 1e-9) / 100;

function setup() {
  const clock = new FakeClock(Date.parse('2026-11-09T23:07:00+01:00'));
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [{ id: 'scene.all_off', name: 'Off', lighting: {} }],
    musicVolumeSettings: structuredClone(defaultMusicVolumeSettings),
    music: { targets: { 'music.room': [] }, adapter },
  });
  engines.push(engine);
  adapter.observe('music.room', values);
  const policy = () => engine.getMusicVolumePolicySnapshots()['music.room']!;
  const presence = async (count: number, state: Presence = 'occupied') => {
    await engine.handlePresence({
      type: 'presence.changed',
      presence: state,
      personCount: count,
    });
    await flush();
  };
  const lastRequested = () =>
    adapter.dispatched.filter((c) => c.requested.property === 'volume').at(-1)!
      .requested.value as number;
  const feedback = async (volume: number) => {
    clock.advanceBy(50);
    adapter.observe('music.room', { ...values, volume });
    await flush();
  };
  return { clock, engine, policy, presence, lastRequested, feedback };
}

it('keeps Auto when the receiver truncates an automatic volume to whole percent', async () => {
  const s = setup();
  await s.presence(1);
  await s.feedback(wiim(s.lastRequested()));
  expect(s.policy().mode).toBe('auto');

  // A second person lowers the target to ~0.111, then leaving raises it to ~0.2088.
  s.clock.advanceBy(4 * 60_000);
  await s.presence(2);
  await s.feedback(wiim(s.lastRequested()));
  expect(s.policy().mode).toBe('auto');

  s.clock.advanceBy(158_000);
  await s.presence(1);
  const requested = s.lastRequested();
  expect(requested).toBeGreaterThan(0.2);
  expect(wiim(requested)).toBeLessThan(requested - 0.005);
  await s.feedback(wiim(requested));

  expect(s.policy()).toMatchObject({ mode: 'auto', manualReference: null });
});

it('still treats a real adjustment after an automatic volume as manual', async () => {
  const s = setup();
  await s.presence(1);
  await s.feedback(wiim(s.lastRequested()));
  expect(s.policy().mode).toBe('auto');

  await s.feedback(wiim(s.lastRequested()) - 0.03);
  expect(s.policy().mode).toBe('manual');
});
