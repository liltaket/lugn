import { describe, expect, it, vi } from 'vitest';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
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
    expect(engine.state.music).toEqual({ devices: {}, commands: [] });
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
