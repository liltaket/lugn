import { afterEach, expect, it } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import {
  defaultMusicVolumeSettings,
  type MusicVolumeSettings,
} from '../src/core/music-volume-settings.js';
import type { Presence } from '../src/core/schemas.js';

const human = { actor: { type: 'user' as const }, source: 'dashboard' };
const policyActor = {
  actor: { type: 'automation' as const, id: 'lugn.music' },
  source: 'presence_music_automation',
};
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
// The WiiM stores whole percent and truncates; HA REST carries no command id.
const wiim = (requested: number) => Math.floor(requested * 100 + 1e-9) / 100;

function setup(
  playback: 'playing' | 'paused' = 'playing',
  settings: MusicVolumeSettings = structuredClone(defaultMusicVolumeSettings),
  startVolume = 0.3,
) {
  const clock = new FakeClock(Date.parse('2026-11-09T12:00:00+01:00'));
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [{ id: 'scene.all_off', name: 'Off', lighting: {} }],
    musicVolumeSettings: settings,
    music: { targets: { 'music.room': [] }, adapter },
  });
  engines.push(engine);
  const values = (volume: number) => ({
    playback,
    volume,
    source: 'PC',
    title: null,
  });
  adapter.observe('music.room', values(startVolume));
  const policy = () => engine.getMusicVolumePolicySnapshots()['music.room']!;
  const fade = () => engine.state.music.fades['music.room'];
  const sent = () =>
    adapter.dispatched
      .filter((command) => command.requested.property === 'volume')
      .map((command) => command.requested.value as number);
  const presence = async (
    count: number | null,
    state: Presence = 'occupied',
  ) => {
    await engine.handlePresence({
      type: 'presence.changed',
      presence: state,
      personCount: count,
    });
    await flush();
  };
  /** The receiver truncates and reports each step without any command id. */
  const report = async (volume: number) => {
    clock.advanceBy(50);
    adapter.observe('music.room', values(volume));
    await flush();
  };
  /** Let the fade issue its next step and report it back, as the receiver does. */
  const step = async () => {
    clock.advanceBy(600);
    await flush();
    await report(wiim(sent().at(-1)!));
  };
  /** Follow the fade the way Home Assistant would, one reported step at a time. */
  const follow = async (maxTicks = 400) => {
    for (let tick = 0; tick < maxTicks; tick++) {
      const status = fade()?.status;
      if (status !== 'active' && status !== 'settling') return;
      const latest = sent().at(-1);
      if (
        latest !== undefined &&
        engine.state.music.devices['music.room']?.requested.volume !== undefined
      )
        await report(wiim(latest));
      clock.advanceBy(250);
      await flush();
    }
  };
  return {
    clock,
    adapter,
    engine,
    policy,
    fade,
    sent,
    presence,
    report,
    step,
    follow,
    values,
  };
}

const withPersonOffset = (personOffset: number): MusicVolumeSettings => ({
  ...structuredClone(defaultMusicVolumeSettings),
  personOffset,
});

it('moves a playing player to the policy volume gradually without claiming manual', async () => {
  const s = setup();
  await s.presence(1);
  expect(s.sent()).toHaveLength(0);
  await s.presence(2);

  expect(s.fade()).toMatchObject({ status: 'active', targetVolume: 0.2 });
  await s.follow();

  const steps = s.sent();
  expect(steps).toEqual([0.28, 0.26, 0.24, 0.22, 0.2]);
  expect(s.fade()?.status).toBe('completed');
  expect(s.policy()).toMatchObject({ mode: 'auto', manualReference: null });
  expect(
    s.engine.state.music.volumeChanges?.['music.room']?.attribution,
  ).not.toBe('external');
});

it('fades on a whole-percent destination when the policy asks for an off-grid volume', async () => {
  const s = setup('playing', withPersonOffset(-0.0912));
  await s.presence(1);
  await s.presence(2);

  // The policy asks for 0.2088. The receiver truncates a fractional step, and
  // a fade step is not matched by truncation, so the fade lands on 0.21.
  expect(s.fade()).toMatchObject({ status: 'active', targetVolume: 0.21 });
  await s.follow();
  expect(s.sent().at(-1)).toBe(0.21);
  for (const value of s.sent())
    expect(value).toBe(Math.round(value * 100) / 100);
  expect(s.policy()).toMatchObject({ mode: 'auto', manualReference: null });

  // The reached volume is not corrected again by later policy ticks.
  const before = s.sent().length;
  s.clock.advanceBy(120_000);
  await flush();
  expect(s.sent()).toHaveLength(before);
  expect(s.policy()).toMatchObject({ mode: 'auto', manualReference: null });
});

it('still reads a real adjustment during a fade as manual and stops the fade', async () => {
  const s = setup();
  await s.presence(1);
  await s.presence(2);
  await s.step();
  expect(s.sent()).toEqual([0.28]);
  expect(s.fade()?.status).toBe('active');
  const issued = s.sent().length;

  // A hand on the dial, well away from every step Lugn has sent.
  await s.report(0.62);

  expect(s.policy()).toMatchObject({ mode: 'manual', manualReference: 0.62 });
  expect(s.fade()?.status).toBe('interrupted');
  s.clock.advanceBy(60_000);
  await flush();
  expect(s.sent()).toHaveLength(issued);
});

it('reads a dashboard adjustment during a fade as manual', async () => {
  const s = setup();
  await s.presence(1);
  await s.presence(2);
  await s.step();

  await s.engine.requestMusic(
    'music.room',
    { property: 'volume', value: 0.5 },
    human,
  );
  await flush();

  expect(s.policy()).toMatchObject({ mode: 'manual', manualReference: 0.5 });
  expect(s.fade()?.status).toBe('cancelled');
});

it('sends one exact command when the player is not playing', async () => {
  const s = setup('paused');
  await s.presence(1);
  await s.presence(2);

  expect(s.fade()).toBeUndefined();
  expect(s.sent()).toHaveLength(1);
  expect(s.sent()[0]).toBeCloseTo(0.2, 10);
});

it('sends one exact command for a change too small to fade', async () => {
  const s = setup('playing', withPersonOffset(-0.02));
  await s.presence(1);
  await s.presence(2);

  expect(s.fade()).toBeUndefined();
  expect(s.sent()).toHaveLength(1);
  expect(s.sent()[0]).toBeCloseTo(0.28, 10);
});

it('does not fade when automatic fades are switched off', async () => {
  const clock = new FakeClock(Date.parse('2026-11-09T12:00:00+01:00'));
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [{ id: 'scene.all_off', name: 'Off', lighting: {} }],
    musicVolumeSettings: structuredClone(defaultMusicVolumeSettings),
    musicAutomaticFades: false,
    music: { targets: { 'music.room': [] }, adapter },
  });
  engines.push(engine);
  adapter.observe('music.room', {
    playback: 'playing',
    volume: 0.3,
    source: 'PC',
    title: null,
  });
  await engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
    personCount: 2,
  });
  await flush();

  expect(engine.state.music.fades['music.room']).toBeUndefined();
  expect(
    adapter.dispatched.filter((c) => c.requested.property === 'volume'),
  ).toHaveLength(1);
});

it('fades the passive person reduction and keeps the human reference', async () => {
  const s = setup('playing', {
    ...structuredClone(defaultMusicVolumeSettings),
    passiveMultiPersonReductionEnabled: true,
  });
  await s.presence(1);
  await s.engine.requestMusic(
    'music.room',
    { property: 'volume', value: 0.5 },
    human,
  );
  await flush();
  await s.report(0.5);
  expect(s.policy()).toMatchObject({ mode: 'manual', manualReference: 0.5 });

  await s.presence(2);
  expect(s.fade()).toMatchObject({ status: 'active', targetVolume: 0.4 });
  await s.follow();
  expect(s.sent().at(-1)).toBe(0.4);
  expect(s.policy()).toMatchObject({
    mode: 'manual',
    manualReference: 0.5,
    controller: 'you',
    lastIntentActor: 'manual',
  });

  await s.presence(1);
  expect(s.fade()).toMatchObject({ status: 'active', targetVolume: 0.5 });
  await s.follow();
  expect(s.sent().at(-1)).toBe(0.5);
  expect(s.policy()).toMatchObject({ mode: 'manual', manualReference: 0.5 });
});

it('reads a human move during the passive fade as the new reference', async () => {
  const s = setup('playing', {
    ...structuredClone(defaultMusicVolumeSettings),
    passiveMultiPersonReductionEnabled: true,
  });
  await s.presence(1);
  await s.engine.requestMusic(
    'music.room',
    { property: 'volume', value: 0.5 },
    human,
  );
  await flush();
  await s.report(0.5);
  await s.presence(2);
  await s.step();

  // The dial moves to 0.25 while two people are present: 0.25 is the reduced
  // level the human wants, so the reference de-offsets it back to 0.35.
  await s.report(0.25);

  expect(s.fade()?.status).toBe('interrupted');
  expect(s.policy()).toMatchObject({ mode: 'manual' });
  expect(s.policy().manualReference).toBeCloseTo(0.35, 10);
});

it('replaces the fade when the policy destination changes mid-fade', async () => {
  const s = setup();
  await s.presence(1);
  await s.presence(2);
  await s.step();
  await s.step();
  expect(s.sent()).toEqual([0.28, 0.26]);
  const first = s.fade()!;
  expect(first.targetVolume).toBe(0.2);

  await s.presence(1);

  expect(s.fade()?.id).not.toBe(first.id);
  expect(s.fade()).toMatchObject({ status: 'active', targetVolume: 0.3 });
  await s.follow();
  expect(s.sent().at(-1)).toBe(0.3);
  expect(s.policy()).toMatchObject({ mode: 'auto', manualReference: null });
});

it('stops its fade when the room empties', async () => {
  const s = setup();
  await s.presence(1);
  await s.presence(2);
  await s.step();
  const issued = s.sent().length;

  await s.presence(null, 'confirmed_empty');

  expect(s.fade()?.status).toBe('cancelled');
  s.clock.advanceBy(60_000);
  await flush();
  expect(s.sent()).toHaveLength(issued);
});

it('authorizes under a human hold only the passive fade the policy itself began', async () => {
  const s = setup('playing', {
    ...structuredClone(defaultMusicVolumeSettings),
    passiveMultiPersonReductionEnabled: true,
  });
  await s.presence(1);
  await s.engine.requestMusic(
    'music.room',
    { property: 'volume', value: 0.5 },
    human,
  );
  await flush();
  await s.report(0.5);
  const reason = 'set passive room volume';

  // Nothing runs yet, so a fade started on the policy's behalf is held.
  expect(() =>
    s.engine.startMusicFade(
      { target: 'music.room', volume: 0.4, durationMs: 5_000 },
      { ...policyActor, reason },
    ),
  ).toThrow('held');

  await s.presence(2);
  expect(s.fade()).toMatchObject({ status: 'active', targetVolume: 0.4 });
  // A step beyond its destination is not the fade's step.
  expect(() =>
    s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.2 },
      { ...policyActor, reason: 'Volume fade step 2/5' },
    ),
  ).toThrow('held');
  // Neither is any other automatic request while the human hold stands.
  expect(() =>
    s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.45 },
      { ...policyActor, reason: 'something else' },
    ),
  ).toThrow('held');
});
