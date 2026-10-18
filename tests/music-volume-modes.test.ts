import { afterEach, expect, it } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import {
  defaultMusicVolumeSettings,
  type MusicVolumeSettings,
} from '../src/core/music-volume-settings.js';
import type { MusicIntentSnapshot, Presence } from '../src/core/schemas.js';

const human = { actor: { type: 'user' as const }, source: 'dashboard' };
const values = {
  playback: 'paused' as const,
  volume: 0.3,
  source: 'Optical',
  title: null,
};
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function setup(
  settings: MusicVolumeSettings = structuredClone(defaultMusicVolumeSettings),
  restoredMusicIntent?: MusicIntentSnapshot,
  seedVolumes: Record<string, number> = {},
) {
  const clock = new FakeClock(Date.parse('2026-10-18T12:00:00+02:00'));
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    musicVolumeSettings: settings,
    music: { targets: { 'music.room': [], 'music.other': [] }, adapter },
    ...(restoredMusicIntent ? { restoredMusicIntent } : {}),
  });
  engines.push(engine);
  const policy = (target = 'music.room') =>
    engine.getMusicVolumePolicySnapshots()[target]!;
  const commands = (target = 'music.room') =>
    adapter.dispatched.filter(
      (command) =>
        command.target === target && command.requested.property === 'volume',
    );
  const settle = async () => {
    await flush();
    for (const command of adapter.dispatched) {
      if (command.requested.property !== 'volume') continue;
      const record = engine.state.music.commands.find(
        (item) => item.id === command.id,
      );
      if (record?.status !== 'pending') continue;
      adapter.observe(
        command.target,
        { ...values, volume: command.requested.value },
        true,
        command.id,
      );
    }
    await flush();
  };
  const presence = async (
    count: number | null,
    presence: Presence = 'occupied',
  ) => {
    await engine.handlePresence({
      type: 'presence.changed',
      presence,
      personCount: count,
    });
    await flush();
  };
  const manual = async (volume: number, target = 'music.room') => {
    await engine.requestMusic(
      target,
      { property: 'volume', value: volume },
      human,
    );
    await settle();
  };
  for (const target of ['music.room', 'music.other'])
    adapter.observe(target, { ...values, volume: seedVolumes[target] ?? 0.3 });
  return { clock, adapter, engine, policy, commands, settle, presence, manual };
}
const passive = () => ({
  ...structuredClone(defaultMusicVolumeSettings),
  passiveMultiPersonReductionEnabled: true,
});

it('keeps independently configured automatic bases separate from human adjustments, fades and restart', async () => {
  const settings = {
    ...structuredClone(defaultMusicVolumeSettings),
    autoBaseVolumes: { 'music.room': 0.42, 'music.other': 0.63 },
  };
  const s = setup(settings);
  await s.presence(1);
  await s.settle();
  expect(s.commands().at(-1)?.requested).toEqual({
    property: 'volume',
    value: 0.42,
  });
  expect(s.commands('music.other').at(-1)?.requested).toEqual({
    property: 'volume',
    value: 0.63,
  });
  await s.manual(0.77);
  s.adapter.observe('music.other', { ...values, volume: 0.82 });
  expect(s.policy()).toMatchObject({
    mode: 'manual',
    configuredBaseline: 0.42,
    baseline: 0.42,
    manualReference: 0.77,
    target: 0.42,
    effectiveTarget: 0.77,
  });
  expect(s.policy('music.other')).toMatchObject({
    mode: 'manual',
    configuredBaseline: 0.63,
    manualReference: 0.82,
  });
  const edited = {
    ...settings,
    autoBaseVolumes: { 'music.room': 0.52, 'music.other': 0.64 },
  };
  s.engine.applyMusicVolumeSettings(edited);
  expect(s.policy()).toMatchObject({
    configuredBaseline: 0.52,
    manualReference: 0.77,
    effectiveTarget: 0.77,
  });
  const r = setup(edited, s.engine.getMusicIntentSnapshot());
  await r.presence(2);
  expect(r.commands()).toHaveLength(0);
  expect(r.policy()).toMatchObject({
    mode: 'manual',
    configuredBaseline: 0.52,
    manualReference: 0.77,
  });
  s.engine.setMusicVolumeAuthority(
    { target: 'music.room', mode: 'auto' },
    human,
  );
  await s.settle();
  expect(s.commands().at(-1)?.requested).toEqual({
    property: 'volume',
    value: 0.52,
  });
  expect(s.policy('music.other').mode).toBe('manual');
});

it('defaults passive reduction off and retains explicit Manual through counts, home, long absence and restart', async () => {
  const s = setup();
  await s.presence(1);
  s.engine.setMusicVolumeAuthority(
    { target: 'music.room', mode: 'manual' },
    human,
  );
  await s.presence(2);
  await s.engine.handleHomePresence('away');
  await s.presence(0, 'confirmed_empty');
  s.clock.advanceBy(24 * 60 * 60_000);
  await s.presence(null, 'unknown');
  const intent = s.engine.getMusicIntentSnapshot();
  expect(intent.targets['music.room']).toMatchObject({
    volumeMode: 'manual',
    selectorIntent: { volume: 0.3, expiresAt: null },
  });
  const r = setup(s.engine.getMusicVolumeSettings(), intent);
  await r.presence(2);
  expect(r.policy()).toMatchObject({
    mode: 'manual',
    manualReference: 0.3,
    configuredBaseline: 0.3,
    passiveReductionActive: false,
  });
  expect(r.commands()).toHaveLength(0);
});

it('reduces manual reference once and restores it without applying the daily curve or changing mode', async () => {
  const s = setup(passive());
  await s.presence(1);
  await s.manual(0.5);
  await s.presence(2);
  await s.settle();
  expect(s.commands().at(-1)?.requested).toEqual({
    property: 'volume',
    value: 0.4,
  });
  expect(s.policy()).toMatchObject({
    mode: 'manual',
    manualReference: 0.5,
    effectiveTarget: 0.4,
    configuredBaseline: 0.3,
    passiveReductionActive: true,
  });
  const count = s.commands().length;
  await s.presence(3);
  s.clock.advanceBy(11 * 60 * 60_000);
  await s.settle();
  expect(s.commands()).toHaveLength(count);
  expect(s.policy().manualReference).toBe(0.5);
  expect(s.engine.state.music.volumeChanges?.['music.room']).toMatchObject({
    provenance: { actor: { type: 'automation', id: 'lugn.music' } },
    volume: 0.4,
  });
  await s.presence(1);
  await s.settle();
  expect(s.commands().at(-1)?.requested).toEqual({
    property: 'volume',
    value: 0.5,
  });
  expect(s.policy()).toMatchObject({
    mode: 'manual',
    effectiveTarget: 0.5,
    passiveReductionActive: false,
  });
});

it('uses a new human adjustment while reduced as the reversible reference, including clamped restoration', async () => {
  const s = setup(passive());
  await s.presence(1);
  await s.manual(0.5);
  await s.presence(2);
  await s.settle();
  await s.manual(0.45);
  expect(s.policy().manualReference).toBeCloseTo(0.55);
  await s.presence(1);
  await s.settle();
  expect(s.commands().at(-1)?.requested).toEqual({
    property: 'volume',
    value: 0.55,
  });
  await s.presence(2);
  await s.settle();
  await s.manual(0.97);
  expect(s.policy().manualReference).toBeCloseTo(1.07);
  await s.presence(1);
  await s.settle();
  expect(s.commands().at(-1)?.requested).toEqual({
    property: 'volume',
    value: 1,
  });
  await s.presence(2);
  await s.settle();
  expect(
    (s.commands().at(-1)?.requested as { value: number }).value,
  ).toBeCloseTo(0.97);
  expect(s.policy().configuredBaseline).toBe(0.3);
});

it('preserves a reduced manual reference through restart and settings changes and restores when disabled', async () => {
  const s = setup(passive());
  await s.presence(1);
  await s.manual(0.6);
  await s.presence(2);
  await s.settle();
  const r = setup(passive(), s.engine.getMusicIntentSnapshot(), {
    'music.room': 0.5,
  });
  await r.presence(2);
  expect(r.policy()).toMatchObject({
    manualReference: 0.6,
    effectiveTarget: 0.5,
    mode: 'manual',
  });
  const edited = { ...passive(), personOffset: -0.2 };
  r.engine.applyMusicVolumeSettings(edited);
  await r.settle();
  expect(
    (r.commands().at(-1)?.requested as { value: number }).value,
  ).toBeCloseTo(0.4);
  r.engine.applyMusicVolumeSettings({
    ...edited,
    passiveMultiPersonReductionEnabled: false,
  });
  await r.settle();
  expect(r.commands().at(-1)?.requested).toEqual({
    property: 'volume',
    value: 0.6,
  });
  expect(r.policy()).toMatchObject({
    manualReference: 0.6,
    mode: 'manual',
    passiveReductionActive: false,
  });
});

it('suppresses passive dispatch during unknown count, absence, away or unavailable volume and resumes on a known occupied count', async () => {
  const s = setup(passive());
  await s.presence(1);
  await s.manual(0.5);
  const before = s.commands().length;
  await s.presence(null);
  s.clock.advanceBy(60_000);
  expect(s.commands()).toHaveLength(before);
  await s.presence(0, 'confirmed_empty');
  await s.presence(2, 'unknown');
  await s.engine.handleHomePresence('away');
  await s.presence(2);
  expect(s.commands()).toHaveLength(before);
  s.adapter.observe('music.room', { ...values, volume: 0.5 }, false);
  await s.engine.handleHomePresence('home');
  await s.presence(2);
  expect(s.commands()).toHaveLength(before);
  s.adapter.observe('music.room', { ...values, volume: 0.5 });
  await s.presence(2);
  await s.settle();
  expect(s.commands().at(-1)?.requested).toEqual({
    property: 'volume',
    value: 0.4,
  });
  expect(s.policy()).toMatchObject({ mode: 'manual', manualReference: 0.5 });
});

it('keeps the manual fade reference tied to its original person offset if count changes during the fade', async () => {
  const s = setup(passive());
  await s.presence(1);
  await s.manual(0.5);
  await s.presence(2);
  await s.settle();
  const before = s.commands().length;
  s.engine.startMusicFade(
    { target: 'music.room', volume: 0.42, durationMs: 1_000 },
    human,
  );
  await s.presence(1);
  expect(s.commands()).toHaveLength(before);
  s.clock.advanceBy(1_000);
  await s.settle();
  s.clock.advanceBy(2_000);
  expect(s.engine.state.music.fades['music.room']?.status).toBe('completed');
  expect(s.policy().manualReference).toBeCloseTo(0.52);
  expect(s.policy()).toMatchObject({ mode: 'manual', baseline: 0.3 });
  s.clock.advanceBy(60_000);
  await s.settle();
  expect(
    (s.commands().at(-1)?.requested as { value: number }).value,
  ).toBeCloseTo(0.52);
});

it('authorizes only the exact passive direct target and cancels its recovery during unknown count', async () => {
  const s = setup(passive());
  Object.assign(s.adapter, {
    readStatus: async (target: string) => ({
      target,
      available: true,
      observedAt: s.clock.now(),
      values: { ...values, volume: 0.5 },
    }),
  });
  await s.presence(1);
  await s.manual(0.5);
  await s.presence(2);
  const provenance = {
    actor: { type: 'automation' as const, id: 'lugn.music' },
    source: 'presence_music_automation',
    reason: 'set passive room volume',
  };
  expect(() =>
    s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.9 },
      provenance,
    ),
  ).toThrow('held');
  expect(() =>
    s.engine.startMusicFade(
      { target: 'music.room', volume: 0.4, durationMs: 1_000 },
      provenance,
    ),
  ).toThrow('held');
  const before = s.commands().length;
  await s.presence(null);
  expect(s.policy().activityReason).toBe('person_count_unknown');
  s.clock.advanceBy(30_000);
  await flush();
  expect(s.commands()).toHaveLength(before);
  expect(s.policy()).toMatchObject({ mode: 'manual', manualReference: 0.5 });
});

it.each(['away', 'disabled', 'unknown', 'unavailable'] as const)(
  'does not remove a person offset from a human adjustment while %s',
  async (gate) => {
    const s = setup(passive());
    await s.presence(2);
    await s.settle();
    if (gate === 'away') await s.engine.handleHomePresence('away');
    if (gate === 'disabled')
      s.engine.applyMusicVolumeSettings({ ...passive(), enabled: false });
    if (gate === 'unknown') await s.presence(2, 'unknown');
    if (gate === 'unavailable')
      s.adapter.observe('music.room', { ...values, volume: 0.2 }, false);
    await s.manual(0.45);
    expect(s.policy().manualReference).toBe(0.45);
    const before = s.commands().length;
    await s.presence(1);
    if (gate === 'away') await s.engine.handleHomePresence('home');
    if (gate === 'disabled') s.engine.applyMusicVolumeSettings(passive());
    await s.settle();
    s.clock.advanceBy(60_000);
    await s.settle();
    expect(s.policy()).toMatchObject({
      manualReference: 0.45,
      effectiveTarget: 0.45,
      mode: 'manual',
    });
    expect(s.commands()).toHaveLength(before);
  },
);

it('captures an unadjusted human fade reference while away and keeps it on return to one person', async () => {
  const s = setup(passive());
  await s.presence(2);
  await s.settle();
  await s.engine.handleHomePresence('away');
  s.engine.startMusicFade(
    { target: 'music.room', volume: 0.219, durationMs: 1_000 },
    human,
  );
  s.clock.advanceBy(1_000);
  await s.settle();
  s.clock.advanceBy(2_000);
  expect(s.policy().manualReference).toBe(0.219);
  const before = s.commands().length;
  await s.presence(1);
  await s.engine.handleHomePresence('home');
  await s.settle();
  expect(s.policy()).toMatchObject({
    manualReference: 0.219,
    effectiveTarget: 0.219,
    mode: 'manual',
  });
  expect(s.commands()).toHaveLength(before);
});

it('ends disabled passive restoration after matching feedback and cannot reassert it over later stale volume', async () => {
  const s = setup(passive());
  await s.presence(1);
  await s.manual(0.5);
  await s.presence(2);
  await s.settle();
  const reduction = s.commands().at(-1)!;
  s.engine.applyMusicVolumeSettings({
    ...passive(),
    passiveMultiPersonReductionEnabled: false,
  });
  await s.settle();
  expect(
    s.engine.getMusicIntentSnapshot().targets['music.room']?.passiveManaged,
  ).toBe(false);
  const before = s.commands().length;
  s.adapter.observe(
    'music.room',
    { ...values, volume: 0.4 },
    true,
    reduction.id,
  );
  s.clock.advanceBy(60_000);
  await s.settle();
  expect(s.policy()).toMatchObject({ manualReference: 0.5, mode: 'manual' });
  expect(s.commands()).toHaveLength(before);
});

it('relinquishes passive correction when disabled after the reference is already restored', async () => {
  const s = setup(passive());
  await s.presence(1);
  await s.manual(0.5);
  await s.presence(2);
  await s.settle();
  const reduction = s.commands().at(-1)!;
  await s.presence(1);
  await s.settle();
  const before = s.commands().length;
  s.engine.applyMusicVolumeSettings({
    ...passive(),
    passiveMultiPersonReductionEnabled: false,
  });
  expect(
    s.engine.getMusicIntentSnapshot().targets['music.room']?.passiveManaged,
  ).toBe(false);
  expect(s.commands()).toHaveLength(before);
  s.adapter.observe(
    'music.room',
    { ...values, volume: 0.4 },
    true,
    reduction.id,
  );
  s.clock.advanceBy(60_000);
  await s.settle();
  expect(s.policy()).toMatchObject({ manualReference: 0.5, mode: 'manual' });
  expect(s.commands()).toHaveLength(before);
});
