import { expect, it } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { FakeClock } from '../src/core/clock.js';

const start = Date.parse('2026-10-04T12:00:00+02:00');
const values = {
  playback: 'playing' as const,
  volume: 0.3,
  source: 'Spotify',
  title: null,
};
function setup() {
  const clock = new FakeClock(start);
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { 'music.room': [] }, adapter },
  });
  const presence = (presence: 'occupied' | 'confirmed_empty') =>
    engine.handlePresence({
      type: 'presence.changed',
      presence,
      personCount: 1,
    });
  return { clock, adapter, engine, presence };
}
async function pause(s: ReturnType<typeof setup>) {
  s.adapter.observe('music.room', values);
  await s.presence('occupied');
  await s.presence('confirmed_empty');
  const command = s.adapter.dispatched.find(
    (c) =>
      c.requested.property === 'playback' && c.requested.value === 'paused',
  );
  expect(command).toBeDefined();
  return command!;
}
function starts(s: ReturnType<typeof setup>) {
  return s.adapter.dispatched.filter(
    (c) =>
      c.requested.property === 'preset' ||
      (c.requested.property === 'playback' && c.requested.value === 'playing'),
  );
}
it('resumes the confirmed pause on the same source', async () => {
  const s = setup();
  try {
    const command = await pause(s);
    s.clock.advanceBy(1);
    s.adapter.observe(
      'music.room',
      { ...values, playback: 'paused' },
      true,
      command.id,
    );
    await s.presence('occupied');
    expect(starts(s).map((c) => c.requested)).toEqual([
      { property: 'playback', value: 'playing' },
    ]);
  } finally {
    s.engine.dispose();
  }
});
it('waits for a pending pause after a rapid return and resumes after its confirmation', async () => {
  const s = setup();
  try {
    const command = await pause(s);
    await s.presence('occupied');
    expect(starts(s)).toHaveLength(0);
    s.clock.advanceBy(1);
    s.adapter.observe(
      'music.room',
      { ...values, playback: 'paused' },
      true,
      command.id,
    );
    expect(starts(s).map((c) => c.requested)).toEqual([
      { property: 'playback', value: 'playing' },
    ]);
  } finally {
    s.engine.dispose();
  }
});
it('does not resume after the source changes away and back during the absence', async () => {
  const s = setup();
  try {
    const command = await pause(s);
    s.clock.advanceBy(1);
    s.adapter.observe(
      'music.room',
      { ...values, playback: 'paused' },
      true,
      command.id,
    );
    s.clock.advanceBy(1);
    s.adapter.observe('music.room', {
      ...values,
      playback: 'paused',
      source: 'Bluetooth',
    });
    s.clock.advanceBy(1);
    s.adapter.observe('music.room', { ...values, playback: 'paused' });
    await s.presence('occupied');
    expect(starts(s)).toHaveLength(0);
  } finally {
    s.engine.dispose();
  }
});

it('does not resume a late pause after a newer manual pause', async () => {
  const s = setup();
  try {
    const command = await pause(s);
    await s.presence('occupied');
    await s.engine.requestMusic(
      'music.room',
      { property: 'playback', value: 'paused' },
      { actor: { type: 'user' }, source: 'test' },
    );
    s.clock.advanceBy(1);
    s.adapter.observe(
      'music.room',
      { ...values, playback: 'paused' },
      true,
      command.id,
    );
    expect(starts(s)).toHaveLength(0);
  } finally {
    s.engine.dispose();
  }
});

it('does not resume a late pause after the user returns while away', async () => {
  const s = setup();
  try {
    const command = await pause(s);
    await s.engine.handleHomePresence('away');
    await s.presence('occupied');
    s.clock.advanceBy(1);
    s.adapter.observe(
      'music.room',
      { ...values, playback: 'paused' },
      true,
      command.id,
    );
    await s.engine.handleHomePresence('home');
    expect(starts(s)).toHaveLength(0);
  } finally {
    s.engine.dispose();
  }
});

it('cancels a pending return when home presence changes before confirmation', async () => {
  const s = setup();
  try {
    const command = await pause(s);
    await s.presence('occupied');
    await s.engine.handleHomePresence('away');
    await s.engine.handleHomePresence('home');
    s.clock.advanceBy(1);
    s.adapter.observe(
      'music.room',
      { ...values, playback: 'paused' },
      true,
      command.id,
    );
    expect(starts(s)).toHaveLength(0);
  } finally {
    s.engine.dispose();
  }
});
