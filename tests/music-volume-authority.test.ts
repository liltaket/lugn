import { expect, it, vi } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import type { MusicOptions } from '../src/application/music-controller.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import type { Presence, Provenance } from '../src/core/schemas.js';

const human = {
  actor: { type: 'user', id: 'nest-dashboard:bed' },
  source: 'lugn.cast_dashboard.bed',
  requestId: 'authority-tap',
  reason: 'Volume authority selector',
} satisfies Provenance;
const automatic = { actor: { type: 'automation' as const } };
const values = {
  playback: 'paused' as const,
  volume: 0.3,
  source: 'Optical',
  title: null,
};
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function setup(observationTrusted?: MusicOptions['observationTrusted']) {
  const clock = new FakeClock(Date.parse('2026-10-04T12:00:00+02:00'));
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: {
      targets: { 'music.room': [], 'music.other': [] },
      adapter,
      ...(observationTrusted ? { observationTrusted } : {}),
    },
  });
  const registry = new CapabilityRegistry(engine);
  for (const target of ['music.room', 'music.other'])
    adapter.observe(target, values);
  const select = (
    mode: 'auto' | 'manual',
    target = 'music.room',
    provenance = human,
  ) =>
    registry.invoke('music.setVolumeAuthority', { target, mode }, provenance);
  const policy = (target = 'music.room') =>
    engine.getMusicVolumePolicySnapshots()[target]!;
  const presence = (
    presence: Presence = 'occupied',
    personCount: number | null = 1,
  ) =>
    engine.handlePresence({ type: 'presence.changed', presence, personCount });
  return { clock, adapter, engine, registry, select, policy, presence };
}

it('claims trusted current volume without a command, baseline rewrite or persistent hold; records provenance for both modes', async () => {
  const s = setup();
  try {
    await s.presence();
    const baseline = s.policy().baseline;
    const change = structuredClone(s.engine.state.music.volumeChanges);
    const result = await s.select('manual');
    expect(result.policy).toMatchObject({
      activeOwner: 'manual',
      baseline,
      selectorIntent: { volume: 0.3, provenance: human },
      lastAuthorityIntent: { mode: 'manual', provenance: human },
    });
    expect(s.adapter.dispatched).toHaveLength(0);
    expect(
      s.engine.getMusicIntentSnapshot().targets['music.room']?.manualVolume,
    ).toBeNull();
    expect(s.engine.state.music.volumeChanges).toEqual(change);
    expect(s.engine.state.music.decisions?.at(-1)).toMatchObject({
      reason: { kind: 'volume', value: 'manual_hold' },
    });
    await s.select('auto');
    expect(s.policy()).toMatchObject({
      policyEnabled: true,
      activeOwner: 'lugn',
      manualHold: null,
      selectorIntent: null,
      lastAuthorityIntent: { mode: 'auto', provenance: human },
    });
    expect(s.adapter.dispatched).toHaveLength(0);
  } finally {
    s.engine.dispose();
  }
});

it('keeps duplicate room/count/home samples and minute ticks from stealing selector intent', async () => {
  const s = setup();
  try {
    await s.engine.handleHomePresence('home');
    await s.presence();
    await s.select('manual');
    const intent = s.policy().selectorIntent;
    for (let i = 0; i < 3; i++) {
      await s.presence();
      await s.engine.handleHomePresence('home');
      s.clock.advanceBy(60_000);
    }
    expect(s.policy().selectorIntent).toEqual(intent);
    expect(s.adapter.dispatched).toHaveLength(0);
    expect(() =>
      s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.5 },
        automatic,
      ),
    ).toThrow('held');
  } finally {
    s.engine.dispose();
  }
});

it.each(['count', 'unknown', 'empty', 'home', 'new visit'] as const)(
  'releases selector-only intent on meaningful %s transition',
  async (transition) => {
    const s = setup();
    try {
      await s.presence();
      if (transition === 'new visit') await s.presence('confirmed_empty', 0);
      await s.select('manual');
      if (transition === 'count') await s.presence('occupied', 2);
      else if (transition === 'unknown') await s.presence('unknown', null);
      else if (transition === 'empty') await s.presence('confirmed_empty', 0);
      else if (transition === 'home') await s.engine.handleHomePresence('away');
      else await s.presence();
      expect(s.policy().selectorIntent).toBeNull();
      expect(s.policy().manualHold).toBeNull();
      if (transition === 'count')
        expect(
          s.adapter.dispatched.some(
            (c) =>
              c.requested.property === 'volume' &&
              Math.abs(c.requested.value - 0.2) < 0.001,
          ),
        ).toBe(true);
    } finally {
      s.engine.dispose();
    }
  },
);

it('Auto re-evaluates a target while policy is already enabled without touching other holds or playback', async () => {
  const s = setup();
  try {
    s.clock.advanceBy(10 * 60 * 60_000); // 22:00
    await s.presence();
    await s.select('manual');
    await s.select('manual', 'music.other');
    s.clock.advanceBy(30 * 60_000);
    await flush();
    expect(s.adapter.dispatched).toHaveLength(0);
    await s.select('auto');
    await flush();
    expect(s.adapter.dispatched).toEqual([
      expect.objectContaining({
        target: 'music.room',
        requested: { property: 'volume', value: 0.2625 },
      }),
    ]);
    expect(s.policy('music.other').activeOwner).toBe('manual');
    expect(s.policy().manualHold).toBeNull();
  } finally {
    s.engine.dispose();
  }
});

it.each(['empty', 'away', 'unknown'] as const)(
  'Auto releases ownership but respects %s and never plays',
  async (gate) => {
    const s = setup();
    try {
      await s.presence();
      if (gate === 'empty') await s.presence('confirmed_empty', 0);
      else if (gate === 'away') await s.engine.handleHomePresence('away');
      else await s.presence('unknown', null);
      await s.select('manual');
      const before = s.adapter.dispatched.length;
      await s.select('auto');
      expect(s.policy()).toMatchObject({
        manualHold: null,
        activeOwner: 'none',
        policyActive: false,
      });
      expect(s.adapter.dispatched).toHaveLength(before);
    } finally {
      s.engine.dispose();
    }
  },
);

it('real volume adjustments replace soft intent and retain manual continuity until explicit Auto handback', async () => {
  const s = setup();
  try {
    await s.presence();
    await s.select('manual');
    const command = await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.4 },
      human,
    );
    s.adapter.observe(
      'music.room',
      { ...values, volume: 0.4 },
      true,
      command.id,
    );
    await s.select('manual');
    expect(s.policy()).toMatchObject({
      selectorIntent: null,
      manualHold: { volume: 0.4 },
    });
    await s.presence('occupied', 2);
    await s.presence('confirmed_empty', 0);
    s.clock.advanceBy(60_000);
    await s.presence();
    expect(s.policy().activeOwner).toBe('manual');
    await s.select('auto');
    expect(s.policy().manualHold).toBeNull();
  } finally {
    s.engine.dispose();
  }
});

it('physical volume adjustments replace selector intent and survive count changes', async () => {
  const s = setup();
  try {
    await s.presence();
    await s.select('manual');
    s.adapter.observe('music.room', { ...values, volume: 0.5 });
    await s.presence('occupied', 2);
    expect(s.policy()).toMatchObject({
      selectorIntent: null,
      manualHold: {
        volume: 0.5,
        provenance: { actor: { type: 'home_assistant' } },
      },
    });
  } finally {
    s.engine.dispose();
  }
});

it('keeps Pause independent through Manual and Auto', async () => {
  const s = setup();
  try {
    await s.presence();
    const pause = await s.engine.requestMusic(
      'music.room',
      { property: 'playback', value: 'paused' },
      human,
    );
    s.adapter.observe('music.room', values, true, pause.id);
    const hold =
      s.engine.getMusicPlaybackPolicySnapshots()['music.room']?.manualPause;
    await s.select('manual');
    await s.select('auto');
    expect(
      s.engine.getMusicPlaybackPolicySnapshots()['music.room']?.manualPause,
    ).toEqual(hold);
    expect(s.adapter.dispatched).toHaveLength(1);
  } finally {
    s.engine.dispose();
  }
});

it('serializes rapid taps by synchronous intent updates and keeps targets isolated', async () => {
  const s = setup();
  try {
    await s.presence();
    await Promise.all([
      s.select('manual'),
      s.select('auto'),
      s.select('manual'),
      s.select('manual', 'music.other'),
    ]);
    expect(s.policy().activeOwner).toBe('manual');
    await s.select('auto');
    expect(s.policy('music.other').activeOwner).toBe('manual');
    expect(s.adapter.dispatched).toHaveLength(0);
  } finally {
    s.engine.dispose();
  }
});

it.each(['auto', 'manual'] as const)(
  'rejects %s for offline/unknown volume and active fades without mutating intent',
  async (mode) => {
    const s = setup();
    try {
      s.adapter.observe('music.room', { ...values, volume: null }, false);
      await expect(s.select(mode)).rejects.toMatchObject({
        code: 'volume_unavailable',
      });
      expect(s.policy().lastAuthorityIntent).toBeNull();
      s.adapter.observe('music.room', values);
      s.engine.startMusicFade(
        { target: 'music.room', volume: 0.4, durationMs: 10_000 },
        human,
      );
      await expect(s.select(mode)).rejects.toMatchObject({
        code: 'fade_active',
      });
      expect(s.policy().lastAuthorityIntent).toBeNull();
    } finally {
      s.engine.dispose();
    }
  },
);

it('rejects pending commands including feedback-before-service-response and permits settled selection', async () => {
  const s = setup();
  let release = () => {};
  try {
    await s.presence();
    const dispatch = s.adapter.dispatch.bind(s.adapter);
    vi.spyOn(s.adapter, 'dispatch').mockImplementationOnce(async (command) => {
      await dispatch(command);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const request = s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.4 },
      human,
    );
    await flush();
    await expect(s.select('manual')).rejects.toMatchObject({
      code: 'volume_pending',
    });
    s.adapter.observe(
      'music.room',
      { ...values, volume: 0.4 },
      true,
      s.adapter.dispatched[0]!.id,
    );
    await expect(s.select('auto')).rejects.toMatchObject({
      code: 'volume_pending',
    });
    release();
    await request;
    await s.select('auto');
    expect(s.policy().manualHold).toBeNull();
  } finally {
    release();
    s.engine.dispose();
  }
});

it('validates typed input, configured targets and human actor before changing authority', async () => {
  const s = setup();
  try {
    await expect(
      s.registry.invoke(
        'music.setVolumeAuthority',
        { target: 'music.room', mode: 'off' },
        human,
      ),
    ).rejects.toThrow();
    await expect(s.select('manual', 'music.missing')).rejects.toMatchObject({
      code: 'target_not_configured',
    });
    await expect(
      s.registry.invoke(
        'music.setVolumeAuthority',
        { target: 'music.room', mode: 'manual' },
        automatic,
      ),
    ).rejects.toMatchObject({ code: 'human_actor_required' });
    expect(s.policy().manualHold).toBeNull();
  } finally {
    s.engine.dispose();
  }
});

it('Auto releases a hold without enabling a disabled global policy', async () => {
  const s = setup();
  try {
    await s.presence();
    await s.select('manual');
    await s.engine.handleBilresaPress('2', 'multi_press_1');
    expect(s.policy().selectorIntent).toBeNull();
    await s.select('manual');
    await s.select('auto');
    expect(s.policy()).toMatchObject({
      manualHold: null,
      activeOwner: 'none',
      policyEnabled: false,
      activityReason: 'automation_disabled',
    });
    expect(s.adapter.dispatched).toHaveLength(0);
  } finally {
    s.engine.dispose();
  }
});

it.each(['user', 'automation'] as const)(
  'protects a mode selection from delayed older %s feedback',
  async (type) => {
    const s = setup();
    try {
      await s.presence();
      const old = await s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.4 },
        { actor: { type } },
      );
      s.adapter.observe('music.room', { ...values, volume: 0.4 }, true, old.id);
      s.adapter.observe('music.room', { ...values, volume: 0.5 });
      await s.select('auto');
      s.adapter.observe('music.room', { ...values, volume: 0.4 });
      expect(s.policy()).toMatchObject({
        activeOwner: 'lugn',
        baseline: 0.5,
        manualHold: null,
      });
      expect(s.policy().authorityControlBlocked).toBe('volume_unavailable');
      // Correlated repeats and metadata duplicates remain feedback, not new intent.
      s.adapter.observe('music.room', { ...values, volume: 0.4 }, true, old.id);
      s.adapter.observe('music.room', {
        ...values,
        volume: 0.4,
        title: 'Next',
      });
      expect(s.policy().manualHold).toBeNull();
      s.adapter.observe('music.room', { ...values, volume: 0.55 });
      expect(s.policy()).toMatchObject({
        activeOwner: 'manual',
        baseline: 0.55,
        selectorIntent: null,
      });
    } finally {
      s.engine.dispose();
    }
  },
);

it('a timed-out command cannot retry or rewrite a newer selector hold', async () => {
  const s = setup();
  try {
    await s.presence();
    const old = await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.4 },
      automatic,
    );
    s.clock.advanceBy(10_001);
    await flush();
    await s.select('manual');
    expect(s.policy().effectiveTarget).toBe(0.3);
    s.adapter.observe('music.room', { ...values, volume: 0.4 }, true, old.id);
    s.clock.advanceBy(60_000);
    await flush();
    expect(s.policy()).toMatchObject({
      activeOwner: 'manual',
      effectiveTarget: 0.3,
      selectorIntent: { volume: 0.3 },
    });
    expect(s.adapter.dispatched).toHaveLength(1);
  } finally {
    s.engine.dispose();
  }
});

it('selecting one target does not invalidate another target automatic recovery', async () => {
  const s = setup();
  try {
    Object.assign(s.adapter, {
      readStatus: async (target: string) => ({
        target,
        available: true,
        observedAt: s.clock.now(),
        values,
      }),
    });
    await s.presence();
    await s.presence('occupied', 2);
    await flush();
    const room = s.adapter.dispatched.find(
      (command) => command.target === 'music.room',
    )!;
    s.adapter.observe('music.room', { ...values, volume: 0.2 }, true, room.id);
    await s.select('manual');
    s.clock.advanceBy(10_001);
    await flush();
    s.clock.advanceBy(5_000);
    await flush();
    expect(
      s.adapter.dispatched.filter(
        (command) => command.target === 'music.other',
      ),
    ).toHaveLength(2);
    expect(s.policy().activeOwner).toBe('manual');
  } finally {
    s.engine.dispose();
  }
});

it('a repeated Manual tap refreshes trusted selector volume without creating adjustment semantics', async () => {
  const s = setup();
  try {
    await s.presence();
    await s.select('manual');
    s.adapter.observe('music.room', { ...values, volume: 0.304 });
    const provenance = { ...human, requestId: 'second-tap' };
    await s.select('manual', 'music.room', provenance);
    expect(s.policy()).toMatchObject({
      selectorIntent: { volume: 0.304, provenance },
      baseline: 0.3,
    });
    await s.presence('occupied', 2);
    expect(s.policy().manualHold).toBeNull();
  } finally {
    s.engine.dispose();
  }
});

it.each(['auto', 'manual'] as const)(
  'rechecks live upstream trust for %s even when cached available volume is old',
  async (mode) => {
    let trusted = true;
    const trust = vi.fn((target: string) => target !== 'music.room' || trusted);
    const s = setup(trust);
    try {
      await s.presence();
      await s.select('manual');
      const before = s.policy();
      const durableIntent = s.engine.getMusicIntentSnapshot();
      expect(before.authorityControlBlocked).toBeNull();
      s.clock.advanceBy(60 * 60_000);
      trusted = false; // No new adapter observation or engine publication.
      await expect(s.select(mode)).rejects.toMatchObject({
        code: 'volume_unavailable',
      });
      expect(s.engine.state.music.devices['music.room']).toMatchObject({
        availability: 'available',
        observed: { volume: 0.3 },
      });
      expect(s.policy()).toMatchObject({
        authorityControlBlocked: 'volume_unavailable',
        selectorIntent: before.selectorIntent,
        lastAuthorityIntent: before.lastAuthorityIntent,
        baseline: before.baseline,
        manualHold: before.manualHold,
      });
      expect(s.engine.getMusicIntentSnapshot()).toEqual(durableIntent);
      expect(s.adapter.dispatched).toHaveLength(0);
      expect(s.policy('music.other').authorityControlBlocked).toBeNull();
      expect(trust).toHaveBeenCalledWith('music.room');
      trusted = true;
      await s.select(mode);
      expect(s.policy().authorityControlBlocked).toBeNull();
    } finally {
      s.engine.dispose();
    }
  },
);
