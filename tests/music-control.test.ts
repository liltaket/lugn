import { describe, expect, it, vi } from 'vitest';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { MusicAutomation } from '../src/application/music-automation.js';
import { MusicController } from '../src/application/music-controller.js';
import { FakeClock } from '../src/core/clock.js';
import { applyStateUpdate } from '../src/core/event-stream.js';

const actor = {
  actor: { type: 'user' as const },
  source: 'operator',
  requestId: 'req-1',
};
const values = {
  playback: 'paused' as const,
  volume: 0.3,
  source: 'Optical',
  title: 'Track',
};
function setup() {
  const clock = new FakeClock();
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: {
      targets: { 'music.room': ['Optical', 'Bluetooth'], 'music.desk': [] },
      adapter,
      feedbackTimeoutMs: 100,
    },
  });
  return { clock, adapter, engine, registry: new CapabilityRegistry(engine) };
}

function controllerInternals(controller: MusicController) {
  return controller as unknown as {
    issuedSequence: Map<string, number>;
    timers: Map<string, unknown>;
  };
}

function automationSetup(startAt = 0, feedbackTimeoutMs = 100) {
  const clock = new FakeClock(startAt);
  const adapter = new SimulatedMusicAdapter(clock);
  const controller = new MusicController(
    clock,
    { targets: { 'music.room': ['Optical'] }, adapter, feedbackTimeoutMs },
    () => {},
  );
  const automation = new MusicAutomation({
    targets: ['music.room'],
    clock,
    getState: (target) => controller.getState(target),
    request: (target, request, provenance) =>
      controller.request(target, request, provenance),
  });
  controller.setFadeLifecycleHandler((event) =>
    automation.handleFadeLifecycle(event),
  );
  controller.setExternalPlaybackChangeHandler((target, playback) =>
    automation.noteExternalPlaybackChange(target, playback),
  );
  controller.setExternalVolumeChangeHandler((target, volume) =>
    automation.noteExternalVolumeChange(target, volume),
  );
  return { clock, adapter, controller, automation };
}

function automationInternals(automation: MusicAutomation) {
  return automation as unknown as {
    resumeUntil: Map<string, number>;
    manuallyPaused: Set<string>;
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('semantic music control', () => {
  it('keeps HA acceptance separate from observation and does not confirm from cached state', async () => {
    const { registry, adapter, engine } = setup();
    adapter.observe('music.room', values);
    const result = await registry.invoke(
      'music.pause',
      { target: 'music.room' },
      actor,
    );
    expect(result.status).toBe('pending');
    adapter.observe('music.room', values);
    expect(engine.state.music.commands[0]).toMatchObject({
      status: 'confirmed',
      provenance: actor,
    });
    expect(
      engine.getMusicState('music.room').observedProvenance?.actor.type,
    ).toBe('home_assistant');
    expect(engine.getMusicState('music.room')).not.toHaveProperty('ownership');
    engine.dispose();
  });
  it('tracks independent properties and supersedes only the same property on the same target', async () => {
    const { registry, engine, adapter } = setup();
    await registry.invoke('music.pause', { target: 'music.room' }, actor);
    const oldVolume = await registry.invoke(
      'music.setVolume',
      { target: 'music.room', volume: 0.3 },
      actor,
    );
    await registry.invoke(
      'music.setVolume',
      { target: 'music.room', volume: 0.5 },
      actor,
    );
    await registry.invoke('music.play', { target: 'music.desk' }, actor);
    expect(
      engine.state.music.commands.map((command) => command.status),
    ).toEqual(['pending', 'superseded', 'pending', 'pending']);
    adapter.observe(
      'music.room',
      { ...values, volume: 0.5 },
      true,
      oldVolume.commandId,
    );
    expect(engine.state.music.commands[2]?.status).toBe('pending');
    adapter.observe('music.room', { ...values, volume: 0.504 });
    expect(
      engine.state.music.commands.map((command) => command.status),
    ).toEqual(['confirmed', 'superseded', 'confirmed', 'pending']);
    engine.dispose();
  });
  it('rejects invalid target, source, out-of-range volume and arbitrary fields before dispatch', async () => {
    const { registry, adapter, engine } = setup();
    await expect(
      registry.invoke('music.play', { target: 'music.other' }, actor),
    ).rejects.toThrow('target_not_configured');
    await expect(
      registry.invoke(
        'music.selectSource',
        { target: 'music.room', source: 'Spotify' },
        actor,
      ),
    ).rejects.toThrow('source_not_allowed');
    await expect(
      registry.invoke(
        'music.setVolume',
        { target: 'music.room', volume: 20 },
        actor,
      ),
    ).rejects.toThrow();
    await expect(
      registry.invoke(
        'music.play',
        { target: 'music.room', service: 'play_media' },
        actor,
      ),
    ).rejects.toThrow();
    expect(adapter.dispatched).toHaveLength(0);
    engine.dispose();
  });
  it('keeps unavailable and wrong-value feedback unconfirmed and never retries', async () => {
    const { registry, adapter, clock, engine } = setup();
    await registry.invoke(
      'music.setVolume',
      { target: 'music.room', volume: 0.5 },
      actor,
    );
    adapter.observe('music.room', { ...values, volume: 0.506 });
    expect(engine.state.music.commands[0]?.status).toBe('pending');
    adapter.observe('music.room', { ...values, volume: 0.5 }, false);
    clock.advanceBy(100);
    adapter.observe('music.room', { ...values, volume: 0.5 });
    expect(engine.state.music.commands[0]?.status).toBe('unconfirmed');
    expect(engine.getMusicState('music.room').requested.volume).toBeUndefined();
    expect(adapter.dispatched).toHaveLength(1);
    engine.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });
  it('records failure without leaking adapter errors or claiming matched feedback is success', async () => {
    const { registry, engine, adapter } = setup();
    vi.spyOn(adapter, 'dispatch').mockImplementation(async () => {
      adapter.observe('music.room', values);
      throw new Error('private-token');
    });
    await expect(
      registry.invoke('music.pause', { target: 'music.room' }, actor),
    ).rejects.toThrow('Music command failed');
    expect(engine.state.music.commands[0]?.status).toBe('failed');
    expect(
      engine.getMusicState('music.room').requested.playback,
    ).toBeUndefined();
    expect(JSON.stringify(engine.state)).not.toContain('private-token');
    engine.dispose();
  });
  it('accepts feedback during HTTP request only after successful dispatch and replays state', async () => {
    const { registry, engine, adapter } = setup();
    let replay = structuredClone(engine.state);
    engine.stream.subscribe((update) => {
      replay = applyStateUpdate(replay, update);
    });
    vi.spyOn(adapter, 'dispatch').mockImplementation(async () => {
      adapter.observe('music.room', values);
      expect(engine.state.music.commands[0]?.status).toBe('pending');
    });
    expect(
      (await registry.invoke('music.pause', { target: 'music.room' }, actor))
        .status,
    ).toBe('confirmed');
    expect(replay).toEqual(engine.state);
    engine.dispose();
  });
  it('leaves absent music config empty and rejects calls cleanly', async () => {
    const engine = new LugnEngine(new FakeClock(), {
      deviceIds: [],
      scenes: [],
    });
    expect(engine.state.music).toEqual({
      devices: {},
      commands: [],
      fades: {},
    });
    await expect(
      new CapabilityRegistry(engine).invoke(
        'music.play',
        { target: 'music.room' },
        actor,
      ),
    ).rejects.toThrow('target_not_configured');
    engine.dispose();
  });

  it('retains only the newest 128 terminal commands', async () => {
    const clock = new FakeClock();
    const adapter = new SimulatedMusicAdapter(clock);
    const controller = new MusicController(
      clock,
      { targets: { 'music.room': [] }, adapter },
      () => {},
    );

    for (let index = 1; index <= 130; index += 1) {
      const volume = index % 2 === 0 ? 0.4 : 0.3;
      await controller.request(
        'music.room',
        { property: 'volume', value: volume },
        actor,
      );
      adapter.observe('music.room', { ...values, volume });
    }

    expect(controller.state.commands).toHaveLength(128);
    expect(controller.state.commands[0]?.id).toBe('music-command-3');
    expect(controller.state.commands.at(-1)?.id).toBe('music-command-130');
    expect(
      controller.state.commands.every(({ status }) => status === 'confirmed'),
    ).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
    expect(controllerInternals(controller).issuedSequence.size).toBe(0);
    controller.dispose();
  });

  it('keeps a pending command attributable while pruning terminal history', async () => {
    const clock = new FakeClock();
    const adapter = new SimulatedMusicAdapter(clock);
    const controller = new MusicController(
      clock,
      { targets: { 'music.room': [], 'music.desk': [] }, adapter },
      () => {},
    );

    const pending = await controller.request(
      'music.room',
      { property: 'volume', value: 0.7 },
      actor,
    );
    for (let index = 1; index <= 130; index += 1) {
      const playback = index % 2 === 0 ? 'paused' : 'playing';
      await controller.request(
        'music.desk',
        { property: 'playback', value: playback },
        actor,
      );
      adapter.observe('music.desk', { ...values, playback });
    }

    const pendingRecord = controller.state.commands.find(
      ({ id }) => id === pending.id,
    );
    expect(pendingRecord?.status).toBe('pending');
    expect(controllerInternals(controller).issuedSequence.has(pending.id)).toBe(
      true,
    );
    expect(controllerInternals(controller).timers.has(pending.id)).toBe(true);
    expect(
      controller.state.commands.filter(({ status }) => status !== 'pending'),
    ).toHaveLength(128);

    adapter.observe('music.room', { ...values, volume: 0.7 });

    expect(pendingRecord?.status).toBe('confirmed');
    expect(controller.state.commands).toContain(pendingRecord);
    expect(controller.state.commands).toHaveLength(128);
    expect(controllerInternals(controller).issuedSequence.has(pending.id)).toBe(
      false,
    );
    expect(controllerInternals(controller).timers.has(pending.id)).toBe(false);
    expect(clock.pendingTimers()).toBe(0);
    controller.dispose();
  });

  it('cleans command tracking after timeout, failure, supersession and disposal', async () => {
    const clock = new FakeClock();
    const adapter = new SimulatedMusicAdapter(clock);
    const controller = new MusicController(
      clock,
      {
        targets: { 'music.room': ['Optical', 'Bluetooth'] },
        adapter,
        feedbackTimeoutMs: 100,
      },
      () => {},
    );
    const internals = controllerInternals(controller);

    await controller.request(
      'music.room',
      { property: 'volume', value: 0.3 },
      actor,
    );
    clock.advanceBy(100);
    expect(controller.state.commands[0]?.status).toBe('unconfirmed');
    expect(internals.issuedSequence.size).toBe(0);
    expect(internals.timers.size).toBe(0);

    vi.spyOn(adapter, 'dispatch').mockRejectedValueOnce(
      new Error('private-token'),
    );
    await expect(
      controller.request(
        'music.room',
        { property: 'playback', value: 'playing' },
        actor,
      ),
    ).rejects.toThrow('Music command failed');
    expect(controller.state.commands.at(-1)?.status).toBe('failed');
    expect(internals.issuedSequence.size).toBe(0);
    expect(internals.timers.size).toBe(0);

    const superseded = await controller.request(
      'music.room',
      { property: 'source', value: 'Optical' },
      actor,
    );
    const current = await controller.request(
      'music.room',
      { property: 'source', value: 'Bluetooth' },
      actor,
    );
    expect(
      controller.state.commands.find(({ id }) => id === superseded.id)?.status,
    ).toBe('superseded');
    expect(internals.issuedSequence.size).toBe(1);
    expect(internals.issuedSequence.has(current.id)).toBe(true);
    expect(internals.timers.size).toBe(1);
    controller.dispose();
    expect(internals.issuedSequence.size).toBe(0);
    expect(internals.timers.size).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('clears a failed volume intent so automation can retry against observed state', async () => {
    const { clock, adapter, controller, automation } = automationSetup();
    adapter.observe('music.room', {
      ...values,
      playback: 'playing',
      volume: 0.25,
    });
    automation.setVolumeAutomationEnabled(false);
    automation.handlePresence('unknown', 'occupied', 1);

    const dispatch = adapter.dispatch.bind(adapter);
    vi.spyOn(adapter, 'dispatch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation((command) => dispatch(command));
    automation.noteExplicitRequest(
      'music.room',
      { property: 'volume', value: 0.4 },
      actor,
    );
    await expect(
      controller.request(
        'music.room',
        { property: 'volume', value: 0.4 },
        actor,
      ),
    ).rejects.toThrow('Music command failed');
    expect(controller.getState('music.room').requested.volume).toBeUndefined();

    automation.setVolumeAutomationEnabled(true);
    await flushMicrotasks();
    expect(adapter.dispatched).toHaveLength(1);
    expect(adapter.dispatched[0]?.requested).toEqual({
      property: 'volume',
      value: 0.4,
    });
    expect(controller.state.commands.map(({ status }) => status)).toEqual([
      'failed',
      'pending',
    ]);
    automation.dispose();
    controller.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('clears confirmed playback intent before a physical pause and does not resume it on re-entry', async () => {
    const { clock, adapter, controller, automation } = automationSetup();
    automation.setVolumeAutomationEnabled(false);
    adapter.observe('music.room', { ...values, playback: 'playing' });
    automation.handlePresence('unknown', 'occupied', 1);

    const play = await controller.request(
      'music.room',
      { property: 'playback', value: 'playing' },
      actor,
    );
    adapter.observe(
      'music.room',
      { ...values, playback: 'playing' },
      true,
      play.id,
    );
    expect(
      controller.getState('music.room').requested.playback,
    ).toBeUndefined();

    adapter.observe('music.room', { ...values, playback: 'paused' });
    expect(
      controller.getState('music.room').requested.playback,
    ).toBeUndefined();
    automation.handlePresence('occupied', 'confirmed_empty', 0);
    await flushMicrotasks();
    const leavePause = controller.state.commands.at(-1);
    expect(leavePause?.requested).toEqual({
      property: 'playback',
      value: 'paused',
    });
    adapter.observe(
      'music.room',
      { ...values, playback: 'paused' },
      true,
      leavePause?.id,
    );

    automation.handlePresence('confirmed_empty', 'occupied', 1);
    await flushMicrotasks();
    expect(adapter.dispatched.map(({ requested }) => requested)).toEqual([
      { property: 'playback', value: 'playing' },
      { property: 'playback', value: 'paused' },
    ]);
    automation.dispose();
    controller.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('does not mistake a late confirmed Lugn pause for a manual pause', async () => {
    const { clock, adapter, controller, automation } = automationSetup(0, 100);
    adapter.observe('music.room', { ...values, playback: 'playing' });
    automation.handlePresence('unknown', 'occupied', 1);
    await flushMicrotasks();

    automation.handlePresence('occupied', 'confirmed_empty', 0);
    await flushMicrotasks();
    expect(adapter.dispatched).toHaveLength(1);
    clock.advanceBy(101);
    expect(controller.state.commands.at(-1)?.status).toBe('unconfirmed');

    // HA feedback arrives late, after Lugn has already cleared requested state.
    adapter.observe('music.room', { ...values, playback: 'paused' });
    automation.handlePresence('confirmed_empty', 'occupied', 1);
    await flushMicrotasks();

    expect(adapter.dispatched.map(({ requested }) => requested)).toEqual([
      { property: 'playback', value: 'paused' },
      { property: 'playback', value: 'playing' },
    ]);

    adapter.observe(
      'music.room',
      { ...values, playback: 'playing' },
      true,
      adapter.dispatched.at(-1)?.id,
    );
    adapter.observe('music.room', { ...values, playback: 'paused' });
    automation.handlePresence('occupied', 'confirmed_empty', 0);
    await flushMicrotasks();
    automation.handlePresence('confirmed_empty', 'occupied', 1);
    await flushMicrotasks();

    // The old late-pause attribution was consumed; this distinct manual pause
    // must still block automatic playback on the next entry.
    expect(adapter.dispatched.map(({ requested }) => requested)).toEqual([
      { property: 'playback', value: 'paused' },
      { property: 'playback', value: 'playing' },
      { property: 'playback', value: 'paused' },
    ]);
    automation.dispose();
    controller.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('attributes a pause by last_changed when a later attribute update follows a newer resume', async () => {
    const startAt = Date.parse('2026-09-30T10:00:00.000Z');
    const { clock, adapter, controller, automation } = automationSetup(
      startAt,
      100,
    );
    adapter.observe('music.room', { ...values, playback: 'playing' });
    automation.handlePresence('unknown', 'occupied', 1);
    await flushMicrotasks();

    automation.handlePresence('occupied', 'confirmed_empty', 0);
    await flushMicrotasks();
    const oldPause = controller.state.commands.at(-1);
    expect(oldPause?.requested).toEqual({
      property: 'playback',
      value: 'paused',
    });
    const pauseIssuedAt = oldPause?.issuedAt ?? clock.now();
    clock.advanceBy(101);
    expect(oldPause?.status).toBe('unconfirmed');

    automation.handlePresence('confirmed_empty', 'occupied', 1);
    await flushMicrotasks();
    const resume = controller.state.commands.at(-1);
    expect(resume?.requested).toEqual({
      property: 'playback',
      value: 'playing',
    });

    // The old PAUSE transition happened before PLAY, but a later attribute
    // update advanced last_updated after PLAY. last_changed retains the actual
    // playback transition time and must control the attribution.
    const lastChanged = pauseIssuedAt + 50;
    const lastUpdated = (resume?.issuedAt ?? clock.now()) + 50;
    expect(lastChanged).toBeLessThan(resume?.issuedAt ?? clock.now());
    expect(lastUpdated).toBeGreaterThan(resume?.issuedAt ?? clock.now());
    clock.advanceBy(50);
    adapter.observe(
      'music.room',
      { ...values, playback: 'paused' },
      true,
      undefined,
      lastUpdated,
      lastChanged,
    );

    expect(
      controller.state.commands.find((command) => command.id === resume?.id)
        ?.status,
    ).toBe('pending');
    expect(controller.getState('music.room').requested.playback).toBe(
      'playing',
    );
    expect(
      automationInternals(automation).manuallyPaused.has('music.room'),
    ).toBe(false);

    adapter.observe(
      'music.room',
      { ...values, playback: 'playing' },
      true,
      resume?.id,
      clock.now(),
      clock.now(),
    );
    expect(
      controller.state.commands.find((command) => command.id === resume?.id)
        ?.status,
    ).toBe('confirmed');

    clock.advanceBy(1);
    adapter.observe(
      'music.room',
      { ...values, playback: 'paused' },
      true,
      undefined,
      clock.now(),
      clock.now(),
    );
    expect(
      automationInternals(automation).manuallyPaused.has('music.room'),
    ).toBe(true);
    automation.dispose();
    controller.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('does not renew the music resume window across confirmed-empty, unknown, confirmed-empty', async () => {
    const startAt = Date.parse('2026-09-30T12:00:00+02:00');
    const { clock, adapter, controller, automation } = automationSetup(startAt);
    automation.setVolumeAutomationEnabled(false);
    adapter.observe('music.room', { ...values, playback: 'playing' });
    automation.handlePresence('unknown', 'occupied', 1);
    await flushMicrotasks();

    automation.handlePresence('occupied', 'confirmed_empty', 0);
    await flushMicrotasks();
    const originalResumeDeadline =
      automationInternals(automation).resumeUntil.get('music.room');
    expect(originalResumeDeadline).toBe(startAt + 20 * 60_000);
    expect(adapter.dispatched.map(({ requested }) => requested)).toEqual([
      { property: 'playback', value: 'paused' },
    ]);

    clock.advanceBy(19 * 60_000);
    automation.handlePresence('confirmed_empty', 'unknown', null);
    automation.handlePresence('unknown', 'confirmed_empty', 0);
    await flushMicrotasks();

    expect(automationInternals(automation).resumeUntil.get('music.room')).toBe(
      originalResumeDeadline,
    );
    expect(adapter.dispatched.map(({ requested }) => requested)).toEqual([
      { property: 'playback', value: 'paused' },
    ]);

    // HA confirms the pause only after the original continuity window expires.
    controller.state.devices['music.room']!.observed.playback = 'paused';
    clock.advanceBy(2 * 60_000);
    automation.handlePresence('confirmed_empty', 'occupied', 1);
    await flushMicrotasks();
    expect(adapter.dispatched.map(({ requested }) => requested)).toEqual([
      { property: 'playback', value: 'paused' },
      { property: 'preset', value: 'spotify_dj' },
    ]);

    automation.dispose();
    controller.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('music automation fade lifecycle', () => {
  function prepare(startAt = 0, feedbackTimeoutMs = 10_000) {
    const setup = automationSetup(startAt, feedbackTimeoutMs);
    setup.adapter.observe('music.room', {
      ...values,
      playback: 'playing',
      volume: 0.5,
    });
    setup.automation.handlePresence('unknown', 'occupied', 1);
    return setup;
  }

  it('blocks minute policy ticks until the actual fade ends, not its requested duration', async () => {
    const { clock, adapter, controller, automation } = prepare(57_000);
    const before = automation.getVolumePolicySnapshot('music.room');
    const fade = { target: 'music.room', volume: 0.6, durationMs: 2_500 };
    controller.startFade(fade, actor);
    automation.noteExplicitFade(fade, actor);

    expect(automation.getVolumePolicySnapshot('music.room').automatic).toBe(
      false,
    );
    expect(automation.getVolumePolicySnapshot('music.room').baseline).toBe(
      before.baseline,
    );

    // The first command receives no feedback. At the next minute tick the
    // requested duration has elapsed, but the controller still owns the fade.
    clock.advanceBy(3_000);
    await flushMicrotasks();
    clock.advanceBy(25);
    expect(controller.state.fades['music.room']?.status).toBe('active');
    expect(adapter.dispatched).toHaveLength(1);
    expect(automation.getVolumePolicySnapshot('music.room').automatic).toBe(
      false,
    );

    automation.dispose();
    controller.dispose();
  });

  it('wires the engine fade lifecycle back into the volume policy', async () => {
    const { clock, adapter, engine } = setup();
    adapter.observe('music.room', {
      ...values,
      playback: 'playing',
      volume: 0.5,
    });

    engine.startMusicFade(
      { target: 'music.room', volume: 0.519, durationMs: 1_000 },
      actor,
    );
    clock.advanceBy(1_000);
    await flushMicrotasks();
    expect(adapter.dispatched.at(-1)?.requested).toEqual({
      property: 'volume',
      value: 0.519,
    });
    adapter.observe('music.room', {
      ...values,
      playback: 'playing',
      volume: 0.519,
    });
    clock.advanceBy(2_000);

    expect(
      engine.getMusicVolumePolicySnapshots()['music.room']?.target,
    ).toBeCloseTo(0.519);
    engine.dispose();
  });

  it('commits the destination only after successful settling', async () => {
    const { clock, adapter, controller, automation } = prepare();
    const before = automation.getVolumePolicySnapshot('music.room');
    const fade = { target: 'music.room', volume: 0.519, durationMs: 1_000 };
    controller.startFade(fade, actor);
    automation.noteExplicitFade(fade, actor);

    clock.advanceBy(1_000);
    await flushMicrotasks();
    const command = controller.state.commands.at(-1);
    expect(command?.requested).toEqual({ property: 'volume', value: 0.519 });
    adapter.observe('music.room', {
      ...values,
      playback: 'playing',
      volume: 0.519,
    });
    expect(controller.state.fades['music.room']?.status).toBe('settling');
    expect(automation.getVolumePolicySnapshot('music.room').baseline).toBe(
      before.baseline,
    );

    automation.handlePresence('occupied', 'occupied', 1);
    expect(adapter.dispatched).toHaveLength(1);
    clock.advanceBy(1_999);
    expect(controller.state.fades['music.room']?.status).toBe('settling');
    clock.advanceBy(1);
    const after = automation.getVolumePolicySnapshot('music.room');
    expect(controller.state.fades['music.room']?.status).toBe('completed');
    expect(after.baselineSource).toBe('user');
    expect(after.target).toBeCloseTo(0.519);
    expect(after.controller).toBe('you');

    automation.dispose();
    controller.dispose();
  });

  it('uses actual terminal volume for cancelled and unconfirmed fades without later playing the old target', async () => {
    const cancelled = prepare();
    const cancelledFade = {
      target: 'music.room',
      volume: 0.8,
      durationMs: 7_500,
    };
    cancelled.controller.startFade(cancelledFade, actor);
    cancelled.automation.noteExplicitFade(cancelledFade, actor);
    cancelled.controller.cancelFade('music.room');
    expect(
      cancelled.automation.getVolumePolicySnapshot('music.room').target,
    ).toBeCloseTo(0.5);
    cancelled.automation.handlePresence('occupied', 'occupied', 1);
    await flushMicrotasks();
    expect(cancelled.adapter.dispatched).toHaveLength(0);
    cancelled.automation.dispose();
    cancelled.controller.dispose();

    const unconfirmed = prepare(0, 100);
    const unconfirmedFade = {
      target: 'music.room',
      volume: 0.7,
      durationMs: 2_500,
    };
    unconfirmed.controller.startFade(unconfirmedFade, actor);
    unconfirmed.automation.noteExplicitFade(unconfirmedFade, actor);
    unconfirmed.clock.advanceBy(250);
    await flushMicrotasks();
    expect(unconfirmed.controller.getState('music.room').requested.volume).toBe(
      0.52,
    );
    unconfirmed.clock.advanceBy(100);
    expect(unconfirmed.controller.state.fades['music.room']?.status).toBe(
      'unconfirmed',
    );
    expect(
      unconfirmed.controller.getState('music.room').requested.volume,
    ).toBeUndefined();
    expect(
      unconfirmed.automation.getVolumePolicySnapshot('music.room').target,
    ).toBeCloseTo(0.5);
    unconfirmed.automation.handlePresence('occupied', 'occupied', 1);
    await flushMicrotasks();
    expect(unconfirmed.adapter.dispatched).toHaveLength(1);
    unconfirmed.automation.dispose();
    unconfirmed.controller.dispose();
  });

  it('commits actual volume after interrupted or failed fades', async () => {
    const interrupted = prepare(0, 1_000);
    const interruptedFade = {
      target: 'music.room',
      volume: 0.8,
      durationMs: 4_000,
    };
    interrupted.controller.startFade(interruptedFade, actor);
    interrupted.automation.noteExplicitFade(interruptedFade, actor);
    interrupted.clock.advanceBy(267);
    await flushMicrotasks();
    interrupted.adapter.observe('music.room', {
      ...values,
      playback: 'playing',
      volume: 0.6,
    });
    expect(interrupted.controller.state.fades['music.room']?.status).toBe(
      'interrupted',
    );
    expect(
      interrupted.automation.getVolumePolicySnapshot('music.room').target,
    ).toBeCloseTo(0.6);
    interrupted.automation.dispose();
    interrupted.controller.dispose();

    const failed = prepare(0, 1_000);
    const dispatch = failed.adapter.dispatch.bind(failed.adapter);
    vi.spyOn(failed.adapter, 'dispatch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation((command) => dispatch(command));
    const failedFade = {
      target: 'music.room',
      volume: 0.519,
      durationMs: 1_000,
    };
    failed.controller.startFade(failedFade, actor);
    failed.automation.noteExplicitFade(failedFade, actor);
    failed.clock.advanceBy(1_000);
    await flushMicrotasks();
    expect(failed.controller.state.fades['music.room']?.status).toBe('failed');
    expect(
      failed.controller.getState('music.room').requested.volume,
    ).toBeUndefined();
    expect(
      failed.automation.getVolumePolicySnapshot('music.room').target,
    ).toBeCloseTo(0.5);
    failed.automation.dispose();
    failed.controller.dispose();
  });
});

describe('Home Assistant music adapter', () => {
  const config = {
    baseUrl: 'http://ha.local',
    token: 'private-token',
    entities: {
      'music.room': { entityId: 'media_player.room', sources: ['Optical'] },
      'music.desk': { entityId: 'media_player.desk', sources: [] },
    },
  };
  it('dispatches only fixed services and configured entities and sources', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const adapter = new HomeAssistantMusicAdapter(
      config,
      transport,
      new FakeClock(),
    );
    await adapter.dispatch({
      id: '1',
      target: 'music.room',
      requested: { property: 'playback', value: 'playing' },
    });
    await adapter.dispatch({
      id: '2',
      target: 'music.room',
      requested: { property: 'playback', value: 'paused' },
    });
    await adapter.dispatch({
      id: '3',
      target: 'music.desk',
      requested: { property: 'volume', value: 0.4 },
    });
    await adapter.dispatch({
      id: '4',
      target: 'music.room',
      requested: { property: 'source', value: 'Optical' },
    });
    expect(transport.mock.calls.map(([url]) => url)).toEqual(
      ['media_play', 'media_pause', 'volume_set', 'select_source'].map(
        (service) => `http://ha.local/api/services/media_player/${service}`,
      ),
    );
    expect(
      transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
    ).toEqual([
      { entity_id: 'media_player.room' },
      { entity_id: 'media_player.room' },
      { entity_id: 'media_player.desk', volume_level: 0.4 },
      { entity_id: 'media_player.room', source: 'Optical' },
    ]);
    await expect(
      adapter.dispatch({
        id: '5',
        target: 'music.room',
        requested: { property: 'source', value: 'Spotify' },
      }),
    ).rejects.toThrow('Source is not allowed');
    await expect(
      adapter.dispatch({
        id: '6',
        target: 'music.other',
        requested: { property: 'playback', value: 'playing' },
      }),
    ).rejects.toThrow('No Home Assistant music');
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it('normalizes startup and event observations, unavailable entities and malformed attributes', () => {
    const adapter = new HomeAssistantMusicAdapter(
      config,
      fetch,
      new FakeClock(),
    );
    const listener = vi.fn();
    adapter.subscribe(listener);
    expect(
      adapter.acceptState({
        entity_id: 'media_player.room',
        state: 'playing',
        attributes: {
          volume_level: 0.4,
          source: 'Optical',
          media_title: 'Song',
        },
      }),
    ).toBe(true);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        available: true,
        values: {
          playback: 'playing',
          volume: 0.4,
          source: 'Optical',
          title: 'Song',
        },
      }),
    );
    adapter.acceptStateChangedEvent({
      type: 'event',
      event: {
        event_type: 'state_changed',
        data: { entity_id: 'media_player.room', new_state: null },
      },
    });
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        available: false,
        values: {
          playback: 'unknown',
          volume: null,
          source: null,
          title: null,
        },
      }),
    );
    adapter.acceptState({
      entity_id: 'media_player.room',
      state: 'paused',
      attributes: { volume_level: 10, source: 42, media_title: {} },
    });
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        values: { playback: 'paused', volume: null, source: null, title: null },
      }),
    );
    expect(
      adapter.acceptState({
        entity_id: 'media_player.other',
        state: 'playing',
      }),
    ).toBe(false);
    expect(
      adapter.acceptStateChangedEvent({
        entity_id: 'media_player.room',
        new_state: { entity_id: 'media_player.desk', state: 'playing' },
      }),
    ).toBe(false);
  });
  it('rejects duplicate mappings, invalid sources/entities and credential URLs', () => {
    expect(
      () =>
        new HomeAssistantMusicAdapter(
          {
            ...config,
            entities: {
              'music.one': { entityId: 'media_player.room', sources: [] },
              'music.two': { entityId: 'media_player.room', sources: [] },
            },
          },
          fetch,
          new FakeClock(),
        ),
    ).toThrow();
    expect(
      () =>
        new HomeAssistantMusicAdapter(
          {
            ...config,
            entities: { 'music.one': { entityId: 'switch.desk', sources: [] } },
          },
          fetch,
          new FakeClock(),
        ),
    ).toThrow();
    expect(
      () =>
        new HomeAssistantMusicAdapter(
          { ...config, baseUrl: 'http://user:secret@ha.local' },
          fetch,
          new FakeClock(),
        ),
    ).toThrow();
  });
});
