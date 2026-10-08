import { expect, it, vi } from 'vitest';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import {
  HomeAssistantWebSocketTransport,
  type HomeAssistantSocket,
  type HomeAssistantSocketMessageEvent,
} from '../src/adapters/home-assistant-websocket.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import type { Presence } from '../src/core/schemas.js';

const start = Date.parse('2026-10-04T12:00:00+02:00');
const continuity = 20 * 60_000;
const human = { actor: { type: 'user' as const }, source: 'test.dashboard' };
type PlayerState = 'playing' | 'paused' | 'unavailable';

/** Retired sockets deliberately retain listeners so transport generation gating is exercised. */
class Socket implements HomeAssistantSocket {
  readonly sent: string[] = [];
  private readonly messages: Array<
    (event: HomeAssistantSocketMessageEvent) => void
  > = [];
  private readonly closes: Array<() => void> = [];
  addEventListener(
    type: 'message',
    listener: (event: HomeAssistantSocketMessageEvent) => void,
  ): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: ((event: HomeAssistantSocketMessageEvent) => void) | (() => void),
  ): void {
    if (type === 'message')
      this.messages.push(
        listener as (event: HomeAssistantSocketMessageEvent) => void,
      );
    else if (type === 'close') this.closes.push(listener as () => void);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    for (const listener of this.closes) listener();
  }
  receive(frame: unknown): void {
    for (const listener of this.messages)
      listener({ data: JSON.stringify(frame) });
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function player(
  state: PlayerState,
  volume: number,
  updatedAt: number,
  changedAt = updatedAt,
) {
  return {
    entity_id: 'media_player.room',
    state,
    attributes: {
      volume_level: volume,
      source: 'Optical',
      media_title: 'Test track',
    },
    last_updated: new Date(updatedAt).toISOString(),
    last_changed: new Date(changedAt).toISOString(),
  };
}

function setup() {
  const clock = new FakeClock(start);
  const sockets: Socket[] = [];
  const urls: string[] = [];
  const services: Array<{ url: string; body: unknown }> = [];
  let snapshot = player('playing', 0.3, start, start - 60_000);
  let seeds = 0;
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/states')) {
      seeds++;
      return Response.json([snapshot]);
    }
    services.push({ url, body: JSON.parse(String(init?.body)) as unknown });
    return Response.json([]);
  });
  const adapter = new HomeAssistantMusicAdapter(
    {
      baseUrl: 'http://home-assistant.test',
      token: 'test-token',
      entities: {
        'music.room': { entityId: 'media_player.room', sources: ['Optical'] },
      },
    },
    fetcher,
    clock,
  );
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { 'music.room': ['Optical'] }, adapter },
  });
  const forwarded: unknown[] = [];
  const transport = new HomeAssistantWebSocketTransport(
    { baseUrl: 'http://home-assistant.test', token: 'test-token' },
    (frame) => {
      forwarded.push(frame);
      expect(adapter.acceptStateChangedEvent(frame)).toBe(true);
    },
    {
      clock,
      reconnectDelayMs: 100,
      maxReconnectDelayMs: 100,
      createSocket: (url) => {
        urls.push(url);
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
      // Exercise the runtime's single-player reconnect reseed path. Full-runtime
      // generation checks and event buffering remain in runtime-integration tests.
      onConnected: async () => {
        const response = await fetcher('http://home-assistant.test/api/states');
        const states = (await response.json()) as unknown[];
        for (const state of states)
          expect(adapter.acceptState(state)).toBe(true);
      },
    },
  );
  const authenticate = async (socket: Socket) => {
    socket.receive({ type: 'auth_required' });
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'auth',
      access_token: 'test-token',
    });
    socket.receive({ type: 'auth_ok' });
    const subscription = JSON.parse(socket.sent[1]!) as {
      id: number;
      type: string;
      event_type: string;
    };
    expect(subscription).toMatchObject({
      type: 'subscribe_events',
      event_type: 'state_changed',
    });
    const before = engine.getMusicState('music.room').observedAt;
    socket.receive({
      type: 'event',
      id: subscription.id,
      event: {
        event_type: 'state_changed',
        data: {
          entity_id: 'media_player.room',
          new_state: player('playing', 0.99, clock.now()),
        },
      },
    });
    expect(engine.getMusicState('music.room').observedAt).toBe(before);
    socket.receive({ type: 'result', id: subscription.id, success: true });
    await settle();
    expect(transport.status).toBe('connected');
    return subscription.id;
  };
  const emit = (
    socket: Socket,
    id: number,
    state: PlayerState,
    volume: number,
    changedAt = clock.now(),
    updatedAt = clock.now(),
  ) => {
    socket.receive({
      type: 'event',
      id,
      event: {
        event_type: 'state_changed',
        data: {
          entity_id: 'media_player.room',
          new_state: player(state, volume, updatedAt, changedAt),
        },
      },
    });
  };
  const presence = (presence: Presence, personCount: number | null = 1) =>
    engine.handlePresence({ type: 'presence.changed', presence, personCount });
  const manual = async (pause = true) => {
    const volume = await engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.4 },
      human,
    );
    const paused = pause
      ? await engine.requestMusic(
          'music.room',
          { property: 'playback', value: 'paused' },
          human,
        )
      : undefined;
    // REST acceptance alone cannot change the reported player or confirm commands.
    expect(engine.getMusicState('music.room').observed.volume).toBe(0.3);
    expect(volume.status).toBe('pending');
    if (paused) expect(paused.status).toBe('pending');
    return { volume, paused };
  };
  const setSnapshot = (
    state: PlayerState,
    volume: number,
    changedAt = clock.now(),
  ) => {
    snapshot = player(state, volume, clock.now(), changedAt);
  };
  const policy = () => engine.getMusicVolumePolicySnapshots()['music.room']!;
  const pauseHold = () =>
    engine.state.intent.holds.find((hold) => hold.scope === 'music.playback');
  const positivePlayback = () =>
    services.filter(
      (call) =>
        call.url.endsWith('/media_play') || call.url.endsWith('/play_preset'),
    );
  const stop = () => {
    transport.stop();
    engine.dispose();
  };
  return {
    clock,
    sockets,
    urls,
    services,
    forwarded,
    transport,
    authenticate,
    emit,
    presence,
    manual,
    setSnapshot,
    policy,
    pauseHold,
    positivePlayback,
    engine,
    seeds: () => seeds,
    stop,
  };
}

it('preserves independent human volume and Pause through auth/subscription reconnect, unknown sensor presence and recovery Playing', async () => {
  const s = setup();
  try {
    s.transport.start();
    const first = s.sockets[0]!;
    const firstId = await s.authenticate(first);
    await s.presence('occupied');
    const intent = await s.manual();
    const pauseAt = s.pauseHold()!.createdAt;
    s.clock.advanceBy(1);
    s.emit(first, firstId, 'paused', 0.4);
    expect(
      s.engine.state.music.commands.find(
        (command) => command.id === intent.volume.id,
      )?.status,
    ).toBe('confirmed');
    expect(
      s.engine.state.music.commands.find(
        (command) => command.id === intent.paused!.id,
      )?.status,
    ).toBe('confirmed');
    expect(s.engine.getMusicState('music.room').observedProvenance).toEqual({
      actor: { type: 'home_assistant' },
      source: 'home_assistant.state_changed',
    });
    s.clock.advanceBy(1);
    s.emit(first, firstId, 'unavailable', 0.4);
    first.close();
    expect(s.transport.status).toBe('disconnected');
    await s.presence('unknown', null);
    const volumeRequests = s.services.filter((call) =>
      call.url.endsWith('/volume_set'),
    ).length;
    s.clock.advanceBy(60_000);
    await settle();
    expect(s.policy()).toMatchObject({
      activeOwner: 'manual',
      baseline: 0.4,
      manualHold: { expiresAt: null },
    });
    expect(s.pauseHold()!.createdAt).toBe(pauseAt);
    expect(
      s.services.filter((call) => call.url.endsWith('/volume_set')),
    ).toHaveLength(volumeRequests);
    s.clock.advanceBy(100);
    const recoveryChangedAt = s.clock.now();
    s.setSnapshot('playing', 0.4);
    const second = s.sockets[1]!;
    const secondId = await s.authenticate(second);
    expect(s.urls).toEqual([
      'ws://home-assistant.test/api/websocket',
      'ws://home-assistant.test/api/websocket',
    ]);
    expect(s.seeds()).toBe(2);
    expect(s.pauseHold()).toMatchObject({
      createdAt: pauseAt,
      provenance: human,
    });
    for (let i = 0; i < 3; i++) {
      s.clock.advanceBy(1);
      s.emit(second, secondId, 'playing', 0.4, recoveryChangedAt);
      await s.presence('occupied', 2);
    }
    s.clock.advanceBy(5 * 60_000);
    await settle();
    expect(s.policy()).toMatchObject({
      activeOwner: 'manual',
      effectiveTarget: 0.4,
      manualHold: { expiresAt: null },
    });
    expect(s.pauseHold()).toMatchObject({
      createdAt: pauseAt,
      provenance: human,
    });
    expect(
      s.services.filter((call) => call.url.endsWith('/volume_set')),
    ).toHaveLength(volumeRequests);
    expect(s.positivePlayback()).toEqual([]);
  } finally {
    s.stop();
  }
});

it('gates retired socket events before they can poison HA timestamps or replace music intent', async () => {
  const s = setup();
  try {
    s.transport.start();
    const retired = s.sockets[0]!;
    const originalId = await s.authenticate(retired);
    await s.manual();
    s.clock.advanceBy(1);
    s.emit(retired, originalId, 'paused', 0.4);
    const pauseAt = s.pauseHold()!.createdAt;
    retired.close();
    s.clock.advanceBy(100);
    s.setSnapshot('paused', 0.4, start + 1);
    const active = s.sockets[1]!;
    const activeId = await s.authenticate(active);
    const before = structuredClone(s.engine.state);
    const forwarded = s.forwarded.length;
    // Use the new subscription ID so frame-ID validation alone cannot protect us.
    s.emit(
      retired,
      activeId,
      'playing',
      0.95,
      s.clock.now() + 60_000,
      s.clock.now() + 60_000,
    );
    retired.receive({ type: 'auth_invalid' });
    retired.close();
    expect(s.transport.status).toBe('connected');
    expect(s.forwarded).toHaveLength(forwarded);
    expect(s.engine.state).toEqual(before);
    s.clock.advanceBy(1);
    s.emit(active, activeId, 'paused', 0.45, start + 1);
    expect(s.policy()).toMatchObject({
      activeOwner: 'manual',
      baseline: 0.45,
      effectiveTarget: 0.45,
    });
    expect(s.engine.state.music.volumeChanges?.['music.room']).toMatchObject({
      volume: 0.45,
      attribution: 'external',
      provenance: {
        actor: { type: 'home_assistant' },
        source: 'home_assistant.state_changed',
      },
    });
    expect(s.pauseHold()!.createdAt).toBe(pauseAt);
    expect(s.positivePlayback()).toEqual([]);
  } finally {
    s.stop();
  }
});

it.each([false, true])(
  'keeps original absence expiry across repeated reconnects with Pause=%s',
  async (pause) => {
    const s = setup();
    try {
      s.transport.start();
      let socket = s.sockets[0]!;
      let id = await s.authenticate(socket);
      await s.presence('occupied');
      await s.manual(pause);
      s.clock.advanceBy(1);
      s.emit(socket, id, pause ? 'paused' : 'playing', 0.4);
      await s.presence('confirmed_empty');
      await settle();
      s.clock.advanceBy(1);
      s.emit(socket, id, 'paused', 0.4);
      const deadline = start + 1 + continuity;
      const pauseAt = s.pauseHold()?.createdAt;
      for (let i = 0; i < 2; i++) {
        s.clock.advanceBy(4 * 60_000);
        socket.close();
        await s.presence('unknown', null);
        s.clock.advanceBy(100);
        s.setSnapshot('paused', 0.4, start + 2);
        socket = s.sockets.at(-1)!;
        id = await s.authenticate(socket);
        s.emit(socket, id, 'paused', 0.4, start + 2);
        await s.presence('confirmed_empty');
        await s.presence('confirmed_empty');
        expect(s.policy().manualHold?.expiresAt).toBe(deadline);
        if (pause) expect(s.pauseHold()!.createdAt).toBe(pauseAt);
      }
      const commands = s.services.length;
      s.clock.advanceBy(deadline - s.clock.now() - 1);
      expect(s.policy().activeOwner).toBe('manual');
      s.clock.advanceBy(1);
      expect(s.policy()).toMatchObject({
        activeOwner: 'none',
        manualHold: null,
        activityReason: 'confirmed_empty',
      });
      expect(s.services).toHaveLength(commands);
      expect(s.positivePlayback()).toEqual([]);
      await s.presence('occupied', 2);
      await settle();
      expect(s.services.slice(commands)).toContainEqual({
        url: 'http://home-assistant.test/api/services/media_player/volume_set',
        body: {
          entity_id: 'media_player.room',
          volume_level: expect.closeTo(0.3),
        },
      });
      expect(s.policy()).toMatchObject({
        activeOwner: 'lugn',
        policyActive: true,
        baseline: 0.4,
      });
      // Service acceptance is not a new player observation.
      expect(s.engine.getMusicState('music.room').observed.volume).toBe(0.4);
      if (pause) {
        expect(s.pauseHold()!.createdAt).toBe(pauseAt);
        expect(s.positivePlayback()).toEqual([]);
      } else expect(s.positivePlayback()).toHaveLength(1);
    } finally {
      s.stop();
    }
  },
);
