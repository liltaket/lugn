import { expect, it, vi } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import type { Actor, Presence } from '../src/core/schemas.js';

const playing = {
  playback: 'playing' as const,
  volume: 0.3,
  source: 'Spotify',
  title: 'Track',
};
const auto = { actor: { type: 'automation' as const }, source: 'test' };
const user = { actor: { type: 'user' as const }, source: 'dashboard' };
const continuityMs = 20 * 60_000;

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function setup(start = '2026-10-04T21:59:00+02:00') {
  const clock = new FakeClock(Date.parse(start));
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { 'music.room': [] }, adapter },
  });
  adapter.observe('music.room', playing);
  const presence = (presence: Presence, personCount: number | null = 1) =>
    engine.handlePresence({ type: 'presence.changed', presence, personCount });
  const policy = () => engine.getMusicVolumePolicySnapshots()['music.room']!;
  const manual = async (type: Actor['type'] = 'user', volume = 0.4) => {
    const command = await engine.requestMusic(
      'music.room',
      { property: 'volume', value: volume },
      { actor: { type }, source: 'test' },
    );
    adapter.observe('music.room', { ...playing, volume }, true, command.id);
    return command;
  };
  const volumeCommands = () =>
    adapter.dispatched.filter((c) => c.requested.property === 'volume');
  return { clock, adapter, engine, presence, policy, manual, volumeCommands };
}

it.each(['user', 'physical_remote', 'home_assistant'] as const)(
  'holds volume for %s through repeated occupancy, person changes and night offsets',
  async (type) => {
    const s = setup();
    try {
      await s.presence('occupied');
      await s.manual(type);
      const count = s.volumeCommands().length;
      await s.presence('occupied', 2);
      s.clock.advanceBy(3 * 60 * 60_000);
      await flush();
      expect(s.volumeCommands()).toHaveLength(count);
      expect(s.policy()).toMatchObject({
        activeOwner: 'manual',
        lastIntentActor: 'manual',
        policyEnabled: true,
        policyActive: false,
        activityReason: 'manual_hold',
        baselineSource: 'user',
        manualHold: { expiresAt: null },
      });
      expect(s.engine.getMusicState('music.room').observed.volume).toBe(0.4);
    } finally {
      s.engine.dispose();
    }
  },
);

it.each([0, 0.01, 0.95, 1])(
  'preserves exact manual volume %s outside the automatic caps',
  async (volume) => {
    const s = setup('2026-10-04T23:30:00+02:00');
    try {
      await s.presence('occupied');
      await s.manual('user', volume);
      const count = s.volumeCommands().length;
      await s.presence('occupied', 2);
      s.clock.advanceBy(7 * 60 * 60_000);
      await flush();
      expect(s.volumeCommands()).toHaveLength(count);
      expect(s.policy()).toMatchObject({
        manualHold: { volume },
        effectiveTarget: volume,
        policyActive: false,
      });
      expect(s.engine.getMusicState('music.room').observed.volume).toBe(volume);
    } finally {
      s.engine.dispose();
    }
  },
);

it('keeps ownership across a short confirmed absence and home/unknown transitions', async () => {
  const s = setup();
  try {
    await s.presence('occupied');
    await s.manual();
    await s.presence('confirmed_empty', 0);
    const expiry = s.clock.now() + continuityMs;
    expect(s.policy().manualHold?.expiresAt).toBe(expiry);
    s.clock.advanceBy(5 * 60_000);
    await s.presence('unknown', null);
    await s.engine.handleHomePresence('away');
    await s.engine.handleHomePresence('home');
    await s.presence('confirmed_empty', 0);
    expect(s.policy().manualHold?.expiresAt).toBe(expiry);
    const count = s.volumeCommands().length;
    s.clock.advanceBy(continuityMs - 5 * 60_000 - 1);
    await s.presence('occupied', 2);
    expect(s.policy().manualHold?.expiresAt).toBeNull();
    s.clock.advanceBy(60_000);
    await flush();
    expect(s.volumeCommands()).toHaveLength(count);
    expect(s.policy().activeOwner).toBe('manual');
  } finally {
    s.engine.dispose();
  }
});

it('releases at the exact confirmed absence boundary without sending until eligible entry', async () => {
  const s = setup();
  try {
    await s.presence('occupied');
    await s.manual();
    await s.presence('confirmed_empty', 0);
    await s.presence('unknown', null);
    const count = s.volumeCommands().length;
    s.clock.advanceBy(continuityMs - 1);
    expect(s.policy().activeOwner).toBe('manual');
    s.clock.advanceBy(1);
    expect(s.policy().manualHold).toBeNull();
    expect(s.policy().policyActive).toBe(false);
    expect(s.volumeCommands()).toHaveLength(count);
    await s.engine.handleHomePresence('away');
    await s.presence('occupied');
    expect(s.volumeCommands()).toHaveLength(count);
    await s.engine.handleHomePresence('unknown');
    await flush();
    expect(s.volumeCommands()).toHaveLength(count + 1);
    expect(s.policy().activeOwner).toBe('lugn');
  } finally {
    s.engine.dispose();
  }
});

it('does not start an absence clock from unknown presence alone', async () => {
  const s = setup();
  try {
    await s.presence('occupied');
    await s.manual();
    await s.presence('unknown', null);
    s.clock.advanceBy(2 * continuityMs);
    await s.presence('occupied');
    expect(s.policy().activeOwner).toBe('manual');
  } finally {
    s.engine.dispose();
  }
});

it.each(['confirmed_empty', 'unknown'] as const)(
  'new human intent after expired absence gets a bounded hold while %s, without renewing playback',
  async (presence) => {
    const s = setup('2026-10-04T12:00:00+02:00');
    try {
      await s.presence('occupied');
      await s.manual();
      await s.presence('confirmed_empty', 0);
      s.clock.advanceBy(continuityMs);
      s.adapter.observe('music.room', {
        ...playing,
        volume: 0.4,
        playback: 'paused',
      });
      await s.presence(presence, null);
      await s.manual('user', 0.5);
      const deadline = s.clock.now() + continuityMs;
      expect(s.policy().manualHold?.expiresAt).toBe(deadline);
      s.clock.advanceBy(60_000);
      await s.presence('confirmed_empty', 0);
      expect(s.policy().manualHold?.expiresAt).toBe(deadline);
      s.clock.advanceBy(continuityMs - 60_000);
      expect(s.policy().manualHold).toBeNull();
      const before = s.adapter.dispatched.length;
      // Manual helper reported playing; reset playback before the long return.
      s.adapter.observe('music.room', {
        ...playing,
        volume: 0.5,
        playback: 'idle',
      });
      await s.presence('occupied');
      expect(
        s.adapter.dispatched
          .slice(before)
          .some(
            (c) =>
              c.requested.property === 'preset' &&
              c.requested.value === 'spotify_dj',
          ),
      ).toBe(true);
      expect(
        s.adapter.dispatched
          .slice(before)
          .some(
            (c) =>
              c.requested.property === 'playback' &&
              c.requested.value === 'playing',
          ),
      ).toBe(false);
    } finally {
      s.engine.dispose();
    }
  },
);

it('human fade crossing an absence expiry finishes intentionally without recreating the expired hold', async () => {
  const s = setup('2026-10-04T12:00:00+02:00');
  try {
    await s.presence('occupied');
    await s.manual();
    await s.presence('confirmed_empty', 0);
    s.clock.advanceBy(continuityMs - 1_000);
    s.adapter.observe('music.room', { ...playing, volume: 0.4 });
    s.engine.startMusicFade(
      { target: 'music.room', volume: 0.419, durationMs: 2_000 },
      user,
    );
    s.clock.advanceBy(1_000);
    expect(s.policy()).toMatchObject({
      activeOwner: 'manual',
      manualHold: null,
      policyActive: false,
    });
    s.clock.advanceBy(1_000);
    await flush();
    s.adapter.observe(
      'music.room',
      { ...playing, volume: 0.419 },
      true,
      s.volumeCommands().at(-1)?.id,
    );
    s.clock.advanceBy(2_000);
    expect(s.policy()).toMatchObject({
      activeOwner: 'none',
      manualHold: null,
      baseline: 0.419,
    });
  } finally {
    s.engine.dispose();
  }
});

it('rejects competing nonhuman direct and fade commands without disturbing a manual fade', async () => {
  const s = setup();
  try {
    await s.presence('occupied');
    s.engine.startMusicFade(
      { target: 'music.room', volume: 0.4, durationMs: 2_000 },
      user,
    );
    expect(() =>
      s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.7 },
        auto,
      ),
    ).toThrow('held');
    expect(() =>
      s.engine.startMusicFade(
        { target: 'music.room', volume: 0.7, durationMs: 10_000 },
        auto,
      ),
    ).toThrow('held');
    expect(s.engine.state.music.fades['music.room']?.status).toBe('active');
    s.clock.advanceBy(400);
    await flush();
    expect(s.volumeCommands()).toHaveLength(1);
    expect(s.policy().activeOwner).toBe('manual');
  } finally {
    s.engine.dispose();
  }
});

it('reschedules actual policy work after occupied away → unknown', async () => {
  const s = setup();
  try {
    await s.presence('occupied');
    await s.engine.handleHomePresence('away');
    await s.engine.handleHomePresence('unknown');
    expect(s.policy().policyActive).toBe(true);
    s.clock.advanceBy(10 * 60_000);
    await flush();
    expect(s.volumeCommands().length).toBeGreaterThan(0);
  } finally {
    s.engine.dispose();
  }
});

it.each(['automation', 'routine', 'agent'] as const)(
  'blocks every nonhuman %s command while preserving playback ownership',
  async (type) => {
    const s = setup();
    try {
      await s.presence('occupied');
      await s.manual();
      const before = s.volumeCommands().length;
      expect(() =>
        s.engine.requestMusic(
          'music.room',
          { property: 'volume', value: 0.7 },
          { actor: { type } },
        ),
      ).toThrow('held');
      expect(s.volumeCommands()).toHaveLength(before);
      await s.engine.requestMusic(
        'music.room',
        { property: 'playback', value: 'paused' },
        user,
      );
      await s.engine.requestMusic(
        'music.room',
        { property: 'playback', value: 'playing' },
        user,
      );
      expect(s.policy().activeOwner).toBe('manual');
    } finally {
      s.engine.dispose();
    }
  },
);

it.each(['unknown', 'away', 'disabled', 'empty'] as const)(
  'stops future automatic fade steps when %s, but allows human fades',
  async (suppression) => {
    const s = setup('2026-10-04T12:00:00+02:00');
    try {
      await s.presence('occupied');
      s.engine.startMusicFade(
        { target: 'music.room', volume: 0.4, durationMs: 2_000 },
        auto,
      );
      s.clock.advanceBy(400);
      await flush();
      const first = s.volumeCommands().at(-1)!;
      expect(first.requested.property).toBe('volume');
      if (suppression === 'unknown') await s.presence('unknown', null);
      else if (suppression === 'empty') await s.presence('confirmed_empty', 0);
      else if (suppression === 'away')
        await s.engine.handleHomePresence('away');
      else await s.engine.handleBilresaPress('2', 'multi_press_1');
      expect(s.engine.state.music.fades['music.room']?.status).toBe(
        'cancelled',
      );
      const count = s.volumeCommands().length;
      s.adapter.observe(
        'music.room',
        { ...playing, volume: 0.32 },
        true,
        first.id,
      );
      s.clock.advanceBy(5_000);
      await flush();
      expect(s.volumeCommands()).toHaveLength(count);
      s.adapter.observe('music.room', { ...playing, volume: 0.32 });
      s.engine.startMusicFade(
        { target: 'music.room', volume: 0.34, durationMs: 1_000 },
        user,
      );
      s.clock.advanceBy(1_000);
      await flush();
      expect(s.volumeCommands()).toHaveLength(count + 1);
      expect(s.policy().activeOwner).toBe('manual');
    } finally {
      s.engine.dispose();
    }
  },
);

it('human direct volume supersedes an automatic fade and delayed terminal callback', async () => {
  const s = setup('2026-10-04T12:00:00+02:00');
  let rejectDispatch: ((error: Error) => void) | undefined;
  try {
    await s.presence('occupied');
    const original = s.adapter.dispatch.bind(s.adapter);
    vi.spyOn(s.adapter, 'dispatch').mockImplementationOnce(async (command) => {
      await original(command);
      return new Promise<void>((_resolve, reject) => {
        rejectDispatch = reject;
      });
    });
    s.engine.startMusicFade(
      { target: 'music.room', volume: 0.4, durationMs: 2_000 },
      auto,
    );
    s.clock.advanceBy(400);
    await flush();
    await s.manual('user', 0.5);
    expect(s.engine.state.music.fades['music.room']?.status).toBe('cancelled');
    rejectDispatch?.(new Error('late automatic failure'));
    await flush();
    s.clock.advanceBy(20_000);
    await flush();
    expect(s.policy()).toMatchObject({ activeOwner: 'manual', baseline: 0.5 });
    expect(s.volumeCommands()).toHaveLength(2);
  } finally {
    rejectDispatch?.(new Error('test cleanup'));
    s.engine.dispose();
  }
});

it('feedback arriving before an older automatic service response cannot replace newer manual intent', async () => {
  const s = setup('2026-10-04T12:00:00+02:00');
  let resolveDispatch: (() => void) | undefined;
  try {
    await s.presence('occupied');
    const original = s.adapter.dispatch.bind(s.adapter);
    vi.spyOn(s.adapter, 'dispatch').mockImplementationOnce(async (command) => {
      await original(command);
      return new Promise<void>((resolve) => {
        resolveDispatch = resolve;
      });
    });
    const older = s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.6 },
      auto,
    );
    await flush();
    await s.manual('user', 0.5);
    s.adapter.observe('music.room', { ...playing, volume: 0.6 });
    expect(s.policy()).toMatchObject({
      activeOwner: 'manual',
      baseline: 0.5,
      effectiveTarget: 0.5,
    });
    resolveDispatch?.();
    await older;
    expect(s.policy().baseline).toBe(0.5);
  } finally {
    resolveDispatch?.();
    s.engine.dispose();
  }
});

it('an external WiiM change interrupts a fade even within its segment tolerance', async () => {
  const s = setup('2026-10-04T12:00:00+02:00');
  try {
    await s.presence('occupied');
    s.engine.startMusicFade(
      { target: 'music.room', volume: 0.4, durationMs: 2_000 },
      auto,
    );
    s.clock.advanceBy(400);
    await flush();
    // 0.31 falls inside the 0.30 → 0.32 segment, but does not match its command.
    s.adapter.observe('music.room', { ...playing, volume: 0.31 });
    expect(s.engine.state.music.fades['music.room']?.status).toBe(
      'interrupted',
    );
    expect(s.policy()).toMatchObject({ activeOwner: 'manual', baseline: 0.31 });
    const count = s.volumeCommands().length;
    s.clock.advanceBy(10_000);
    await flush();
    expect(s.volumeCommands()).toHaveLength(count);
  } finally {
    s.engine.dispose();
  }
});

it('older automatic feedback cannot interrupt a replacement human fade or commit its stale baseline', async () => {
  const s = setup('2026-10-04T12:00:00+02:00');
  try {
    await s.presence('occupied');
    const older = await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.6 },
      auto,
    );
    s.engine.startMusicFade(
      { target: 'music.room', volume: 0.319, durationMs: 1_000 },
      user,
    );
    s.adapter.observe('music.room', { ...playing, volume: 0.6 });
    expect(s.engine.state.music.fades['music.room']?.status).toBe('active');
    expect(s.policy().baseline).toBe(0.3);
    s.clock.advanceBy(1_000);
    await flush();
    const latest = s.volumeCommands().at(-1)!;
    expect(latest.id).not.toBe(older.id);
    s.adapter.observe(
      'music.room',
      { ...playing, volume: 0.319 },
      true,
      latest.id,
    );
    s.clock.advanceBy(2_000);
    expect(s.engine.state.music.fades['music.room']?.status).toBe('completed');
    expect(s.policy()).toMatchObject({
      activeOwner: 'manual',
      baseline: 0.319,
    });
  } finally {
    s.engine.dispose();
  }
});

it.each(['pending', 'unconfirmed', 'confirmed', 'correlated'] as const)(
  'protects newer manual baseline from older %s automatic volume feedback',
  async (status) => {
    const s = setup('2026-10-04T12:00:00+02:00');
    try {
      await s.presence('occupied');
      const older = await s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.35 },
        auto,
      );
      if (status === 'confirmed')
        s.adapter.observe(
          'music.room',
          { ...playing, volume: 0.35 },
          true,
          older.id,
        );
      if (status === 'unconfirmed') s.clock.advanceBy(10_000);
      await s.manual('user', 0.5);
      if (status === 'correlated') s.clock.advanceBy(60_000);
      s.adapter.observe(
        'music.room',
        { ...playing, volume: 0.35 },
        true,
        status === 'correlated' ? older.id : undefined,
      );
      expect(s.engine.getMusicState('music.room').observed.volume).toBe(0.35);
      expect(s.policy()).toMatchObject({
        activeOwner: 'manual',
        baseline: 0.5,
      });
      // A metadata-only repeat does not replace ownership or baseline either.
      s.adapter.observe('music.room', {
        ...playing,
        volume: 0.35,
        title: 'Next track',
      });
      expect(s.policy().baseline).toBe(0.5);
      s.adapter.observe('music.room', { ...playing, volume: 0.55 });
      expect(s.policy().baseline).toBe(0.55);
      // Consumed attribution must not swallow another genuine physical visit
      // to the older level, including when that old command was superseded.
      s.adapter.observe('music.room', { ...playing, volume: 0.35 });
      expect(s.policy().baseline).toBe(0.35);
    } finally {
      s.engine.dispose();
    }
  },
);

it('keeps an explicit Pause after volume continuity expires and explicit automation hand-back', async () => {
  const s = setup('2026-10-04T12:00:00+02:00');
  try {
    await s.presence('occupied');
    await s.manual();
    const pause = await s.engine.requestMusic(
      'music.room',
      { property: 'playback', value: 'paused' },
      user,
    );
    s.adapter.observe(
      'music.room',
      { ...playing, volume: 0.4, playback: 'paused' },
      true,
      pause.id,
    );
    await s.presence('confirmed_empty', 0);
    s.clock.advanceBy(continuityMs);
    await s.presence('occupied');
    await s.engine.handleBilresaPress('2', 'multi_press_1');
    await s.engine.handleBilresaPress('2', 'multi_press_1');
    expect(s.policy().manualHold).toBeNull();
    expect(() =>
      s.engine.requestMusic(
        'music.room',
        { property: 'playback', value: 'playing' },
        auto,
      ),
    ).toThrow('pause');
    expect(
      s.adapter.dispatched.some((c) => c.requested.property === 'preset'),
    ).toBe(false);
  } finally {
    s.engine.dispose();
  }
});

it('dedicated enable gives automation volume back while temporary BILRESA restore preserves ownership', async () => {
  const clock = new FakeClock(Date.parse('2026-10-04T12:00:00+02:00'));
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [
      { id: 'scene.everyday_light', name: 'Day', lighting: {} },
      { id: 'scene.all_off', name: 'Off', lighting: {} },
    ],
    music: { targets: { 'music.room': [] }, adapter },
  });
  try {
    adapter.observe('music.room', playing);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    await engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.4 },
      user,
    );
    const policy = () => engine.getMusicVolumePolicySnapshots()['music.room']!;
    await engine.handleBilresaPress('2', 'long_press');
    await engine.handleBilresaPress('2', 'long_press');
    expect(policy()).toMatchObject({
      activeOwner: 'manual',
      policyEnabled: true,
    });
    await engine.handleBilresaPress('2', 'multi_press_1');
    await engine.handleBilresaPress('2', 'multi_press_1');
    expect(policy()).toMatchObject({
      activeOwner: 'lugn',
      manualHold: null,
      policyEnabled: true,
    });
    await expect(
      engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.35 },
        auto,
      ),
    ).resolves.toHaveProperty('acceptedAt');
  } finally {
    engine.dispose();
  }
});

it('deliberate enable preserves an active human fade authority until its terminal state', async () => {
  const s = setup('2026-10-04T12:00:00+02:00');
  try {
    await s.presence('occupied');
    s.engine.startMusicFade(
      { target: 'music.room', volume: 0.319, durationMs: 1_000 },
      user,
    );
    await s.engine.handleBilresaPress('2', 'multi_press_1');
    await s.engine.handleBilresaPress('2', 'multi_press_1');
    expect(s.policy()).toMatchObject({
      activeOwner: 'manual',
      manualHold: null,
      policyActive: false,
    });
    expect(() =>
      s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.7 },
        auto,
      ),
    ).toThrow('held');
    expect(() =>
      s.engine.startMusicFade(
        { target: 'music.room', volume: 0.7, durationMs: 10_000 },
        auto,
      ),
    ).toThrow('held');
    s.clock.advanceBy(1_000);
    await flush();
    s.adapter.observe(
      'music.room',
      { ...playing, volume: 0.319 },
      true,
      s.volumeCommands().at(-1)?.id,
    );
    s.clock.advanceBy(2_000);
    expect(s.policy()).toMatchObject({
      activeOwner: 'lugn',
      manualHold: null,
      policyActive: true,
    });
    await expect(
      s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.5 },
        auto,
      ),
    ).resolves.toHaveProperty('acceptedAt');
  } finally {
    s.engine.dispose();
  }
});

it('unavailable sensor/device feedback keeps human ownership and reports actual automatic inactivity', async () => {
  const s = setup();
  try {
    await s.presence('occupied');
    await s.manual();
    s.adapter.observe('music.room', { ...playing, volume: null }, false);
    await s.presence('unknown', null);
    s.clock.advanceBy(2 * continuityMs);
    s.adapter.observe('music.room', { ...playing, volume: 0.4 });
    await s.presence('occupied');
    expect(s.policy().activeOwner).toBe('manual');
    await s.engine.handleBilresaPress('2', 'multi_press_1');
    await s.engine.handleBilresaPress('2', 'multi_press_1');
    s.adapter.observe('music.room', { ...playing, volume: null }, false);
    expect(s.policy()).toMatchObject({
      policyActive: false,
      activityReason: 'volume_unavailable',
      activeOwner: 'none',
    });
  } finally {
    s.engine.dispose();
  }
});

it.each(['deferred response', 'metadata repeat'] as const)(
  'keeps stale classification through %s during a replacement human fade',
  async (scenario) => {
    const s = setup('2026-10-04T12:00:00+02:00');
    let release = () => {};
    try {
      await s.presence('occupied');
      const older = await s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.6 },
        auto,
      );
      if (scenario === 'deferred response') {
        const dispatch = s.adapter.dispatch.bind(s.adapter);
        const response = new Promise<void>((resolve) => {
          release = resolve;
        });
        vi.spyOn(s.adapter, 'dispatch').mockImplementationOnce(
          async (command) => {
            await dispatch(command);
            await response;
          },
        );
      }
      s.engine.startMusicFade(
        { target: 'music.room', volume: 0.319, durationMs: 1_000 },
        user,
      );
      s.clock.advanceBy(1_000);
      await flush();
      s.adapter.observe(
        'music.room',
        { ...playing, volume: 0.6 },
        true,
        older.id,
      );
      expect(s.engine.state.music.fades['music.room']?.status).toBe('active');
      if (scenario === 'deferred response') {
        release();
        await flush();
      } else {
        s.adapter.observe('music.room', {
          ...playing,
          volume: 0.6,
          title: 'Next track',
        });
      }
      expect(s.engine.state.music.fades['music.room']?.status).toBe('active');
      expect(s.policy()).toMatchObject({
        baseline: 0.3,
        effectiveTarget: 0.319,
      });
      s.adapter.observe(
        'music.room',
        { ...playing, volume: 0.319 },
        true,
        s.volumeCommands().at(-1)?.id,
      );
      s.clock.advanceBy(2_000);
      expect(s.engine.state.music.fades['music.room']?.status).toBe(
        'completed',
      );
      expect(s.policy()).toMatchObject({
        baseline: 0.319,
        effectiveTarget: 0.319,
      });
    } finally {
      release();
      s.engine.dispose();
    }
  },
);

it.each(['cancelled', 'unconfirmed'] as const)(
  'does not commit old automatic feedback as the terminal volume of a %s human fade',
  async (status) => {
    const s = setup('2026-10-04T12:00:00+02:00');
    try {
      await s.presence('occupied');
      const older = await s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.6 },
        auto,
      );
      s.engine.startMusicFade(
        { target: 'music.room', volume: 0.319, durationMs: 1_000 },
        user,
      );
      s.clock.advanceBy(1_000);
      await flush();
      s.adapter.observe(
        'music.room',
        { ...playing, volume: 0.6 },
        true,
        older.id,
      );
      if (status === 'cancelled') s.engine.cancelMusicFade('music.room');
      else {
        s.clock.advanceBy(10_001);
        await flush();
      }
      expect(s.engine.state.music.fades['music.room']?.status).toBe(status);
      expect(s.engine.getMusicState('music.room').observed.volume).toBe(0.6);
      expect(s.policy()).toMatchObject({
        activeOwner: 'manual',
        baseline: 0.3,
        effectiveTarget: 0.3,
      });
    } finally {
      s.engine.dispose();
    }
  },
);

it('accepts current correlated fade feedback after older same-destination feedback', async () => {
  const s = setup('2026-10-04T12:00:00+02:00');
  try {
    await s.presence('occupied');
    await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.319 },
      auto,
    );
    s.engine.startMusicFade(
      { target: 'music.room', volume: 0.319, durationMs: 1_000 },
      user,
    );
    s.clock.advanceBy(1_000);
    await flush();
    const current = s.volumeCommands().at(-1)!;
    s.adapter.observe('music.room', { ...playing, volume: 0.319 });
    expect(
      s.engine.state.music.commands.find((command) => command.id === current.id)
        ?.status,
    ).toBe('confirmed');
    s.adapter.observe(
      'music.room',
      { ...playing, volume: 0.319 },
      true,
      current.id,
    );
    s.clock.advanceBy(2_000);
    expect(s.engine.state.music.fades['music.room']?.status).toBe('completed');
    expect(s.policy()).toMatchObject({
      baseline: 0.319,
      effectiveTarget: 0.319,
    });
  } finally {
    s.engine.dispose();
  }
});

it('keeps repeated current correlated feedback as feedback while a fade settles', async () => {
  const s = setup('2026-10-04T12:00:00+02:00');
  try {
    await s.presence('occupied');
    const older = await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.6 },
      auto,
    );
    s.engine.startMusicFade(
      { target: 'music.room', volume: 0.319, durationMs: 1_000 },
      user,
    );
    s.clock.advanceBy(1_000);
    await flush();
    const current = s.volumeCommands().at(-1)!;
    s.adapter.observe(
      'music.room',
      { ...playing, volume: 0.319 },
      true,
      current.id,
    );
    expect(s.engine.state.music.fades['music.room']?.status).toBe('settling');
    const hold = s.policy().manualHold;
    s.adapter.observe(
      'music.room',
      { ...playing, volume: 0.6 },
      true,
      older.id,
    );
    s.adapter.observe(
      'music.room',
      { ...playing, volume: 0.319 },
      true,
      current.id,
    );
    expect(s.engine.state.music.fades['music.room']?.status).toBe('settling');
    expect(s.policy().manualHold).toEqual(hold);
    s.clock.advanceBy(2_000);
    expect(s.engine.state.music.fades['music.room']?.status).toBe('completed');
    expect(s.policy()).toMatchObject({
      baseline: 0.319,
      effectiveTarget: 0.319,
    });
  } finally {
    s.engine.dispose();
  }
});
