import { expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { FakeClock } from '../src/core/clock.js';

const noon = Date.parse('2026-10-04T12:00:00+02:00');
const user = { actor: { type: 'user' as const }, source: 'dashboard' };
const automatic = { actor: { type: 'automation' as const }, source: 'test' };
const values = {
  playback: 'paused' as const,
  volume: 0.3,
  title: null,
  source: 'Optical',
};
function setup(now = noon) {
  const clock = new FakeClock(now);
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [{ id: 'scene.test', name: 'Test', lighting: {} }],
    music: { targets: { 'music.room': [] }, adapter },
  });
  const observe = (volume: number, commandId?: string) => {
    clock.advanceBy(1);
    adapter.observe('music.room', { ...values, volume }, true, commandId);
  };
  const presence = (presence: 'occupied' | 'unknown' | 'confirmed_empty') =>
    engine.handlePresence({
      type: 'presence.changed',
      presence,
      personCount: 1,
    });
  const playback = () =>
    engine.getMusicPlaybackPolicySnapshots()['music.room']!;
  return { clock, adapter, engine, observe, presence, playback };
}

it('separates acceptance, reported changes and current manual ownership', async () => {
  const s = setup();
  try {
    s.observe(0.3);
    expect(s.engine.state.music.volumeChanges?.['music.room']).toBeUndefined();
    const request = await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.4 },
      user,
    );
    expect(s.engine.state.music.volumeChanges?.['music.room']).toBeUndefined();
    s.observe(0.4, request.id);
    expect(s.engine.state.music.volumeChanges?.['music.room']).toEqual({
      volume: 0.4,
      observedAt: s.clock.now(),
      provenance: request.provenance,
      attribution: 'correlated',
    });
    const change = structuredClone(s.engine.state.music.volumeChanges);
    s.observe(0.4);
    expect(s.engine.state.music.volumeChanges).toEqual(change);
    s.observe(0.402);
    expect(s.engine.state.music.volumeChanges?.['music.room']).toMatchObject({
      volume: 0.402,
      attribution: 'external',
    });
    expect(
      s.engine.getMusicVolumePolicySnapshots()['music.room']!.effectiveTarget,
    ).toBe(0.4);
    s.observe(0.5);
    expect(s.engine.state.music.volumeChanges?.['music.room']).toMatchObject({
      volume: 0.5,
      attribution: 'external',
      provenance: { actor: { type: 'home_assistant' } },
    });
    expect(
      s.engine.getMusicVolumePolicySnapshots()['music.room']!.activeOwner,
    ).toBe('manual');
  } finally {
    s.engine.dispose();
  }
});

it.each([true, false])(
  'reports old automatic feedback correlated=%s without surrendering newer manual intent',
  async (correlated) => {
    const s = setup();
    try {
      s.observe(0.3);
      await s.presence('occupied');
      const older = await s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.35 },
        automatic,
      );
      await s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.6 },
        user,
      );
      s.observe(0.35, correlated ? older.id : undefined);
      expect(s.engine.state.music.volumeChanges?.['music.room']).toMatchObject({
        volume: 0.35,
        provenance: automatic,
        attribution: correlated ? 'correlated' : 'matched',
      });
      expect(
        s.engine.getMusicVolumePolicySnapshots()['music.room'],
      ).toMatchObject({
        activeOwner: 'manual',
        baseline: 0.6,
        effectiveTarget: 0.6,
        lastIntentActor: 'manual',
      });
      s.observe(0.35);
      expect(
        s.engine.state.music.volumeChanges?.['music.room']?.provenance,
      ).toEqual(older.provenance);
    } finally {
      s.engine.dispose();
    }
  },
);

it('defines next-entry eligibility separately from volume enable, room state and explicit Pause', async () => {
  const s = setup();
  try {
    s.observe(0.3);
    expect(s.playback()).toMatchObject({
      activityReason: 'presence_unknown',
      entryEligible: false,
      quietHours: false,
      manualPause: null,
    });
    await s.presence('confirmed_empty');
    expect(s.playback()).toMatchObject({
      activityReason: 'confirmed_empty',
      entryEligible: true,
    });
    await s.engine.handleBilresaPress('2', 'multi_press_1');
    expect(
      s.engine.getMusicVolumePolicySnapshots()['music.room']!.policyEnabled,
    ).toBe(false);
    expect(s.playback().entryEligible).toBe(true);
    await s.engine.requestMusic(
      'music.room',
      { property: 'playback', value: 'paused' },
      user,
    );
    expect(s.playback()).toMatchObject({
      activityReason: 'manual_pause',
      entryEligible: false,
      manualPause: { provenance: user },
    });
    await s.engine.requestMusic(
      'music.room',
      { property: 'playback', value: 'playing' },
      user,
    );
    await s.presence('occupied');
    expect(s.playback()).toMatchObject({
      activityReason: 'awaiting_new_entry',
      entryEligible: false,
    });
    await s.engine.handleHomePresence('away');
    expect(s.playback()).toMatchObject({
      activityReason: 'home_away',
      entryEligible: false,
    });
  } finally {
    s.engine.dispose();
  }
});

it.each([
  '2026-10-04T23:00:00+02:00',
  '2026-10-05T00:00:00+02:00',
  '2026-10-05T05:59:00+02:00',
])(
  'reports quiet hours at %s without depending on dashboard time',
  async (time) => {
    const s = setup(Date.parse(time));
    try {
      await s.presence('confirmed_empty');
      expect(s.playback()).toMatchObject({
        activityReason: 'quiet_hours',
        quietHours: true,
        entryEligible: false,
      });
    } finally {
      s.engine.dispose();
    }
  },
);

it('matches restored and ordinary availability guards without inventing a general playback disable', async () => {
  const s = setup();
  let restored: LugnEngine | undefined;
  try {
    await s.presence('confirmed_empty');
    expect(s.playback()).toMatchObject({
      activityReason: 'confirmed_empty',
      entryEligible: true,
    });
    restored = new LugnEngine(s.clock, {
      deviceIds: [],
      scenes: [],
      music: { targets: { 'music.room': [] } },
      restoredMusicIntent: s.engine.getMusicIntentSnapshot(),
    });
    await restored.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 1,
    });
    expect(
      restored.getMusicPlaybackPolicySnapshots()['music.room'],
    ).toMatchObject({
      activityReason: 'player_unavailable',
      entryEligible: false,
    });
    const before = s.adapter.dispatched.length;
    await s.presence('occupied');
    expect(
      s.adapter.dispatched.slice(before).map((c) => c.requested),
    ).toContainEqual({ property: 'preset', value: 'spotify_dj' });
    await restored.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    expect(
      restored.state.music.commands.some(
        (c) => c.requested.property === 'preset',
      ),
    ).toBe(false);
  } finally {
    s.engine.dispose();
    restored?.dispose();
  }
});

it('reports06:00 entry permission and exactly expires resume eligibility without read side effects', async () => {
  const s = setup(Date.parse('2026-10-05T05:40:00+02:00'));
  try {
    s.adapter.observe('music.room', { ...values, playback: 'playing' });
    await s.presence('occupied');
    await s.presence('confirmed_empty');
    const deadline = s.clock.now() + 20 * 60_000;
    expect(s.playback()).toMatchObject({
      quietHours: true,
      resumeExpiresAt: deadline,
      entryEligible: false,
    });
    s.adapter.observe('music.room', values);
    s.clock.advanceBy(20 * 60_000);
    const before = structuredClone(s.engine.state);
    expect(s.playback()).toMatchObject({
      quietHours: false,
      resumeExpiresAt: null,
      entryEligible: true,
    });
    expect(s.engine.state).toEqual(before);
  } finally {
    s.engine.dispose();
  }
});

it('records clock reason changes on the existing policy tick without volume commands or offset-only history', async () => {
  const s = setup(Date.parse('2026-10-04T22:59:00+02:00'));
  try {
    s.observe(0.3);
    await s.presence('occupied');
    const manual = await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.6 },
      user,
    );
    s.observe(0.6, manual.id);
    const before = s.engine.state.music.decisions!.length;
    const requests = s.adapter.dispatched.length;
    s.clock.advanceBy(60_025);
    expect(s.engine.state.music.decisions!.slice(before)).toEqual([
      expect.objectContaining({
        reason: { kind: 'playback', value: 'quiet_hours' },
      }),
    ]);
    expect(s.adapter.dispatched.length).toBe(requests);
    s.clock.advanceBy(60_000);
    expect(s.engine.state.music.decisions!.length).toBe(before + 1);
  } finally {
    s.engine.dispose();
  }
});

it('records exact ownership expiry and enable context without disabling playback', async () => {
  const s = setup();
  try {
    s.observe(0.3);
    await s.presence('occupied');
    await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.6 },
      user,
    );
    await s.presence('confirmed_empty');
    const deadline = s.clock.now() + 20 * 60_000;
    await s.engine.handleBilresaPress('2', 'multi_press_1');
    expect(s.engine.state.music.decisions!.at(-1)).toMatchObject({
      reason: { kind: 'volume', value: 'manual_hold' },
      policyEnabled: false,
      manualExpiresAt: deadline,
    });
    s.clock.advanceBy(20 * 60_000 - 1);
    expect(
      s.engine.getMusicVolumePolicySnapshots()['music.room']!.activeOwner,
    ).toBe('manual');
    s.clock.advanceBy(1);
    expect(s.engine.state.music.decisions).toContainEqual(
      expect.objectContaining({
        at: deadline,
        reason: { kind: 'volume', value: 'automation_disabled' },
        owner: 'none',
        manualExpiresAt: null,
      }),
    );
    expect(s.playback().entryEligible).toBe(true);
    expect(
      s.engine.state.music
        .decisions!.filter((d) => d.reason.kind === 'playback')
        .every((d) => d.policyEnabled),
    ).toBe(true);
  } finally {
    s.engine.dispose();
  }
});

it('validates and filters the read capability by configured target', async () => {
  const clock = new FakeClock(noon);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { 'music.room': [], 'music.bed': [] } },
  });
  try {
    const api = new CapabilityRegistry(engine);
    const policy = await api.invoke(
      'music.getPolicy',
      { target: 'music.room' },
      user,
    );
    expect(policy.decisions.length).toBeGreaterThan(0);
    expect(policy.decisions.every((d) => d.target === 'music.room')).toBe(true);
    expect(
      engine.state.music.decisions!.some((d) => d.target === 'music.bed'),
    ).toBe(true);
    await expect(
      api.invoke('music.getPolicy', { target: 'music.other' }, user),
    ).rejects.toMatchObject({ code: 'target_not_configured' });
    await expect(
      api.invoke(
        'music.getPolicy',
        { target: 'music.room', entityId: 'media_player.other' },
        user,
      ),
    ).rejects.toThrow();
    expect(engine.getMusicIntentSnapshot()).not.toHaveProperty('decisions');
    expect(engine.getMusicIntentSnapshot()).not.toHaveProperty('volumeChanges');
  } finally {
    engine.dispose();
  }
});

it('keeps typed decision history bounded, deduplicated and independent from query or lighting publishes', async () => {
  const s = setup();
  try {
    s.observe(0.3);
    await s.presence('occupied');
    await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.6 },
      user,
    );
    await s.presence('confirmed_empty');
    const before = structuredClone(s.engine.state.music.decisions);
    await s.presence('confirmed_empty');
    expect(s.engine.state.music.decisions).toEqual(before);
    const spy = vi.spyOn(s.engine, 'getMusicVolumePolicySnapshots');
    await s.engine.activateScene('scene.test', user.actor);
    expect(spy).not.toHaveBeenCalled();
    const stable = structuredClone(s.engine.state);
    const capabilities = new CapabilityRegistry(s.engine);
    const result = await capabilities.invoke(
      'music.getPolicy',
      { target: 'music.room' },
      user,
    );
    expect(result.volume).toMatchObject({
      activeOwner: 'manual',
      manualHold: { expiresAt: noon + 20 * 60_000 + 1 },
    });
    expect(result.playback).toMatchObject({
      activityReason: 'confirmed_empty',
    });
    expect(result.decisions).toEqual(
      s.engine.state.music.decisions?.filter((d) => d.target === 'music.room'),
    );
    result.decisions.splice(0);
    s.playback();
    expect(s.engine.state).toEqual(stable);
    expect(s.engine.state.music.decisions).toContainEqual(
      expect.objectContaining({
        target: 'music.room',
        reason: { kind: 'volume', value: 'manual_hold' },
        owner: 'manual',
        manualExpiresAt: noon + 20 * 60_000 + 1,
      }),
    );
    for (let i = 0; i < 150; i++) {
      await s.presence(i % 2 === 0 ? 'unknown' : 'confirmed_empty');
    }
    expect(s.engine.state.music.decisions!.length).toBe(128);
  } finally {
    s.engine.dispose();
  }
});
