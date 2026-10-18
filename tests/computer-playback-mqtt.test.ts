import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComputerPlaybackMqttAdapter,
  ComputerPlaybackStateSchema,
  ComputerPlaybackCommandSchema,
  ComputerPlaybackAckSchema,
  type ComputerPlaybackState,
  type ComputerPlaybackCommand,
  type ComputerPlaybackAck,
  type ComputerPlaybackMqttPort,
} from '../src/adapters/computer-playback-mqtt.js';
import { FakeClock } from '../src/core/clock.js';

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('mqtt', () => ({ connect }));
import { MqttJsSubscriber } from '../src/runtime/mqttjs-subscriber.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const INSTANCE = '33333333-3333-4333-8333-333333333333';
const CONTENT = '44444444-4444-4444-8444-444444444444';
const COMMAND = '55555555-5555-4555-8555-555555555555';
const TOKEN = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';
const NOW = 100_000;
const ROOT = 'lugn/computers/kuffe/control';
function state(
  overrides: Partial<ComputerPlaybackState> = {},
): ComputerPlaybackState {
  return {
    schema_version: 1,
    device_id: 'kuffe',
    session_id: SESSION,
    connection_id: CONNECTION,
    sequence: 1,
    timestamp_ms: NOW,
    heartbeat_interval_ms: 5_000,
    players: [
      {
        player: 'org.mpris.MediaPlayer2.spotify',
        player_instance_id: INSTANCE,
        content_id: CONTENT,
        playback_status: 'Playing',
        can_pause: true,
        can_play: true,
        pause_lease: null,
      },
    ],
    ...overrides,
  };
}
function command(
  overrides: Partial<ComputerPlaybackCommand> = {},
): ComputerPlaybackCommand {
  return {
    schema_version: 1,
    device_id: 'kuffe',
    session_id: SESSION,
    connection_id: CONNECTION,
    command_id: COMMAND,
    action: 'pause',
    player: 'org.mpris.MediaPlayer2.spotify',
    player_instance_id: INSTANCE,
    content_id: CONTENT,
    issued_at_ms: NOW,
    expires_at_ms: NOW + 15_000,
    pause_command_id: null,
    resume_token: null,
    lease_ttl_ms: 60_000,
    ...overrides,
  };
}
function ack(
  overrides: Partial<ComputerPlaybackAck> = {},
): ComputerPlaybackAck {
  const {
    issued_at_ms: _issued,
    expires_at_ms: _expires,
    pause_command_id: _pause,
    lease_ttl_ms: _ttl,
    ...identity
  } = command();
  void _issued;
  void _expires;
  void _pause;
  void _ttl;
  return {
    ...identity,
    timestamp_ms: NOW,
    outcome: 'applied',
    reason: 'paused',
    resume_token: TOKEN,
    lease_expires_at_ms: NOW + 60_000,
    ...overrides,
  };
}
class Port implements ComputerPlaybackMqttPort {
  handlers = new Map<
    string,
    (topic: string, payload: unknown, metadata: { retain: boolean }) => void
  >();
  publish = vi
    .fn<ComputerPlaybackMqttPort['publish']>()
    .mockResolvedValue(undefined);
  subscribe(
    topic: string,
    _options: { qos: 0 | 1 },
    handler: (
      topic: string,
      payload: unknown,
      metadata: { retain: boolean },
    ) => void,
  ) {
    this.handlers.set(topic, handler);
    return () => {
      this.handlers.delete(topic);
    };
  }
  receive(suffix: 'state' | 'ack', payload: unknown, retain = false) {
    const topic = `${ROOT}/${suffix}`;
    this.handlers.get(topic)?.(
      topic,
      typeof payload === 'string' || payload instanceof Uint8Array
        ? payload
        : JSON.stringify(payload),
      { retain },
    );
  }
}
function setup() {
  const clock = new FakeClock(NOW);
  const mqtt = new Port();
  const onChange = vi.fn();
  const adapter = new ComputerPlaybackMqttAdapter({
    deviceId: 'kuffe',
    mqtt,
    clock,
    onChange,
  });
  adapter.start();
  adapter.setBrokerConnected(true);
  return { adapter, mqtt, clock, onChange };
}

describe('CONTROL v1 strict wire schemas', () => {
  it('parses the canonical Rust producer examples without translating fields', () => {
    for (const [file, schema] of [
      ['control-state.example.json', ComputerPlaybackStateSchema],
      ['control-pause.example.json', ComputerPlaybackCommandSchema],
      ['control-resume.example.json', ComputerPlaybackCommandSchema],
      ['control-ack-paused.example.json', ComputerPlaybackAckSchema],
      ['control-ack-resumed.example.json', ComputerPlaybackAckSchema],
    ] as const) {
      const payload = JSON.parse(
        readFileSync(
          new URL(`fixtures/computer-control/${file}`, import.meta.url),
          'utf8',
        ),
      );
      expect(schema.parse(payload)).toEqual(payload);
    }
  });
  it('requires every field and rejects unknown fields recursively, invalid UUIDs, duplicate players, limits and invalid numbers', () => {
    expect(ComputerPlaybackStateSchema.safeParse(state()).success).toBe(true);
    for (const key of Object.keys(state())) {
      const input = { ...state() } as Record<string, unknown>;
      delete input[key];
      expect(ComputerPlaybackStateSchema.safeParse(input).success, key).toBe(
        false,
      );
    }
    for (const input of [
      { ...state(), extra: true },
      state({ connection_id: 'bad' }),
      state({ sequence: 0 }),
      state({ timestamp_ms: 1.5 }),
      state({ heartbeat_interval_ms: 4_999 }),
      state({ heartbeat_interval_ms: 300_001 }),
      state({ players: Array(65).fill(state().players[0]) }),
      state({ players: [state().players[0]!, state().players[0]!] }),
      state({ players: [{ ...state().players[0]!, player: 'spotify' }] }),
      state({
        players: [
          {
            ...state().players[0]!,
            extra: true,
          } as ComputerPlaybackState['players'][number],
        ],
      }),
    ])
      expect(ComputerPlaybackStateSchema.safeParse(input).success).toBe(false);
  });
  it('requires all command and ack fields, rejects extras and impossible action/lifetime/lease combinations', () => {
    for (const [schema, input] of [
      [ComputerPlaybackCommandSchema, command()],
      [ComputerPlaybackAckSchema, ack()],
    ] as const) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, extra: 1 }).success).toBe(false);
      for (const key of Object.keys(input)) {
        const copy = { ...input } as Record<string, unknown>;
        delete copy[key];
        expect(schema.safeParse(copy).success, key).toBe(false);
      }
    }
    for (const input of [
      command({ expires_at_ms: NOW }),
      command({ expires_at_ms: NOW + 15_001 }),
      command({ lease_ttl_ms: 999 }),
      command({ lease_ttl_ms: 3_600_001 }),
      command({ resume_token: TOKEN }),
      command({ action: 'resume' }),
      command({
        action: 'resume',
        pause_command_id: COMMAND,
        resume_token: TOKEN,
        lease_ttl_ms: 1_000,
      }),
    ])
      expect(ComputerPlaybackCommandSchema.safeParse(input).success).toBe(
        false,
      );
    expect(
      ComputerPlaybackAckSchema.safeParse(ack({ resume_token: null })).success,
    ).toBe(false);
    expect(
      ComputerPlaybackAckSchema.safeParse(ack({ reason: 'resumed' })).success,
    ).toBe(false);
  });
});

describe('computer playback MQTT transport', () => {
  it('authorizes only fresh live state; retained state and reconnect invalidate context', async () => {
    const { adapter, mqtt, clock } = setup();
    mqtt.receive('state', state(), true);
    expect(adapter.getSnapshot()?.fresh).toBe(false);
    await expect(adapter.sendCommand(command())).rejects.toThrow('fresh');
    mqtt.receive('state', state());
    expect(adapter.getSnapshot()).toMatchObject({
      fresh: true,
      receivedAtMs: NOW,
    });
    const copy = adapter.getSnapshot()!;
    copy.state.players.length = 0;
    expect(adapter.getSnapshot()?.state.players).toHaveLength(1);
    adapter.setBrokerConnected(false);
    adapter.setBrokerConnected(true);
    expect(adapter.getSnapshot()?.fresh).toBe(false);
    mqtt.receive('state', state({ sequence: 2 }));
    expect(adapter.getSnapshot()?.fresh).toBe(true);
    clock.advanceBy(90_000);
    expect(adapter.getSnapshot()?.fresh).toBe(false);
    expect(clock.pendingTimers()).toBe(0);
  });
  it('rejects malformed, stale, future or wrong-device state without authorizing commands', () => {
    for (const input of [
      'invalid json',
      new Uint8Array([0xff]),
      'x'.repeat(262_145),
      state({ device_id: 'other' }),
      state({ timestamp_ms: NOW - 90_000 }),
      state({ timestamp_ms: NOW + 2_001 }),
    ]) {
      const { adapter, mqtt } = setup();
      mqtt.receive('state', input);
      expect(adapter.getSnapshot()?.fresh ?? false).toBe(false);
      adapter.stop();
    }
  });
  it('ignores reordered sequences and retired session/connection identities', () => {
    const { adapter, mqtt } = setup();
    mqtt.receive('state', state({ sequence: 2 }));
    mqtt.receive('state', state({ sequence: 1 }));
    expect(adapter.getSnapshot()?.state.sequence).toBe(2);
    mqtt.receive('state', state({ sequence: 1, connection_id: OTHER }));
    mqtt.receive('state', state({ sequence: 100 }));
    expect(adapter.getSnapshot()?.state.connection_id).toBe(OTHER);
    mqtt.receive(
      'state',
      state({ session_id: TOKEN, sequence: 1, connection_id: TOKEN }),
    );
    mqtt.receive('state', state({ sequence: 101, connection_id: OTHER }));
    expect(adapter.getSnapshot()?.state.session_id).toBe(TOKEN);
    adapter.stop();
  });
  it('registers pending before publish; correlates every identity and ignores retained/malformed acknowledgements', async () => {
    const { adapter, mqtt } = setup();
    mqtt.receive('state', state());
    const pending = adapter.sendCommand(command());
    const success = vi.fn();
    void pending.then(success);
    expect(mqtt.publish).toHaveBeenCalledWith(
      `${ROOT}/command`,
      JSON.stringify(command()),
      { qos: 1, retain: false },
      expect.any(AbortSignal),
    );
    mqtt.receive('ack', ack(), true);
    for (const key of [
      'device_id',
      'session_id',
      'connection_id',
      'command_id',
      'player_instance_id',
      'content_id',
    ] as const)
      mqtt.receive(
        'ack',
        ack({ [key]: key === 'device_id' ? 'other' : OTHER }),
      );
    mqtt.receive(
      'ack',
      ack({
        action: 'resume',
        reason: 'resumed',
        resume_token: null,
        lease_expires_at_ms: null,
      }),
    );
    mqtt.receive('ack', ack({ player: 'org.mpris.MediaPlayer2.other' }));
    mqtt.receive('ack', ack({ timestamp_ms: NOW - 2_001 }));
    mqtt.receive('ack', ack({ timestamp_ms: NOW + 2_001 }));
    await Promise.resolve();
    expect(success).not.toHaveBeenCalled();
    mqtt.receive('ack', ack());
    await expect(pending).resolves.toEqual(ack());
    adapter.stop();
  });
  it('handles acknowledgement arriving synchronously within publish', async () => {
    const { adapter, mqtt } = setup();
    mqtt.receive('state', state());
    mqtt.publish.mockImplementation(async () => {
      mqtt.receive('ack', ack());
    });
    await expect(adapter.sendCommand(command())).resolves.toEqual(ack());
    adapter.stop();
  });
  it.each([
    'disconnect',
    'connection',
    'session',
    'stop',
    'malformed',
    'abort',
    'timeout',
    'publish',
  ] as const)('fails pending on %s and cancels publication', async (reason) => {
    const { adapter, mqtt, clock } = setup();
    mqtt.receive('state', state());
    const abort = new AbortController();
    if (reason === 'publish')
      mqtt.publish.mockRejectedValue(new Error('publish failed'));
    const promise = adapter.sendCommand(command(), abort.signal);
    const rejected = expect(promise).rejects.toThrow();
    if (reason === 'disconnect') adapter.setBrokerConnected(false);
    if (reason === 'connection')
      mqtt.receive('state', state({ sequence: 2, connection_id: OTHER }));
    if (reason === 'session')
      mqtt.receive('state', state({ session_id: OTHER, connection_id: TOKEN }));
    if (reason === 'stop') adapter.stop();
    if (reason === 'malformed') mqtt.receive('state', '{}');
    if (reason === 'abort') abort.abort();
    if (reason === 'timeout') clock.advanceBy(15_000);
    await rejected;
    expect(mqtt.publish.mock.calls[0]?.[3]?.aborted).toBe(true);
    adapter.stop();
    expect(clock.pendingTimers()).toBe(0);
    expect(mqtt.handlers.size).toBe(0);
  });
  it('requires exact current player/content/lease and refuses expired commands before publishing', async () => {
    const { adapter, mqtt } = setup();
    mqtt.receive('state', state());
    for (const cmd of [
      command({ content_id: OTHER }),
      command({ player_instance_id: OTHER }),
      command({ issued_at_ms: NOW + 2_001 }),
      command({ issued_at_ms: NOW - 15_000, expires_at_ms: NOW }),
      command({
        action: 'resume',
        pause_command_id: COMMAND,
        resume_token: TOKEN,
        lease_ttl_ms: null,
      }),
    ])
      await expect(adapter.sendCommand(cmd)).rejects.toThrow();
    const paused = {
      ...state().players[0]!,
      playback_status: 'Paused' as const,
      pause_lease: {
        pause_command_id: COMMAND,
        resume_token: TOKEN,
        expires_at_ms: NOW + 60_000,
      },
    };
    mqtt.receive('state', state({ sequence: 2, players: [paused] }));
    await expect(
      adapter.sendCommand(
        command({
          action: 'resume',
          pause_command_id: COMMAND,
          resume_token: OTHER,
          lease_ttl_ms: null,
        }),
      ),
    ).rejects.toThrow();
    expect(mqtt.publish).not.toHaveBeenCalled();
    const resume = command({
      action: 'resume',
      pause_command_id: COMMAND,
      resume_token: TOKEN,
      lease_ttl_ms: null,
    });
    const pending = adapter.sendCommand(resume);
    mqtt.receive(
      'ack',
      ack({
        action: 'resume',
        reason: 'resumed',
        resume_token: null,
        lease_expires_at_ms: null,
      }),
    );
    await expect(pending).resolves.toMatchObject({ reason: 'resumed' });
    adapter.stop();
  });
});

class BrokerClient extends EventEmitter {
  connected = true;
  outgoingStore = {
    put: vi.fn((_packet: unknown, callback: (error?: Error) => void) => {
      callback();
      return this.outgoingStore;
    }),
  };
  deferPublication = false;
  deferred: Array<() => void> = [];
  nextId = 1;
  callbacks = new Map<number, (error?: Error) => void>();
  subscribe = vi.fn();
  endAsync = vi.fn().mockResolvedValue(undefined);
  removeOutgoingMessage = vi.fn((id: number) => {
    this.callbacks.get(id)?.(new Error('removed'));
    this.callbacks.delete(id);
  });
  publish = vi.fn(
    (
      topic: string,
      payload: string,
      options: { qos: number; retain: boolean },
      callback: (error?: Error) => void,
    ) => {
      const send = () => {
        const messageId = this.nextId++;
        this.callbacks.set(messageId, callback);
        const packet = {
          cmd: 'publish',
          topic,
          payload,
          ...options,
          messageId,
        };
        this.outgoingStore.put(packet, (error) => {
          if (error) callback(error);
          else this.emit('packetsend', packet);
        });
      };
      if (this.deferPublication) this.deferred.push(send);
      else send();
    },
  );
}
describe('MQTT.js command publisher', () => {
  beforeEach(() => {
    connect.mockReset();
  });
  it('refuses offline or aborted publication and clears QoS1 retransmission entries on disconnect', async () => {
    const client = new BrokerClient();
    connect.mockReturnValue(client);
    const subscriber = new MqttJsSubscriber({ url: 'mqtt://unused' });
    await expect(
      subscriber.publish('control', 'command', { qos: 1, retain: false }),
    ).rejects.toThrow('disconnected');
    subscriber.start();
    client.emit('connect');
    const abort = new AbortController();
    abort.abort();
    await expect(
      subscriber.publish(
        'control',
        'command',
        { qos: 1, retain: false },
        abort.signal,
      ),
    ).rejects.toThrow('aborted');
    const pending = subscriber.publish('control', 'command', {
      qos: 1,
      retain: false,
    });
    const rejected = expect(pending).rejects.toThrow('disconnected');
    client.connected = false;
    client.emit('close');
    await rejected;
    expect(client.removeOutgoingMessage).toHaveBeenCalledWith(1);
    expect(client.listenerCount('packetsend')).toBe(0);
    await subscriber.stop();
  });
  it('resolves on PUBACK and cancels in-flight publication on abort or stop', async () => {
    const client = new BrokerClient();
    connect.mockReturnValue(client);
    const subscriber = new MqttJsSubscriber({ url: 'mqtt://unused' });
    subscriber.start();
    client.emit('connect');
    const first = subscriber.publish('control', 'one', {
      qos: 1,
      retain: false,
    });
    client.callbacks.get(1)?.();
    await first;
    const abort = new AbortController();
    const second = subscriber.publish(
      'control',
      'two',
      { qos: 1, retain: false },
      abort.signal,
    );
    const aborted = expect(second).rejects.toThrow('aborted');
    abort.abort();
    await aborted;
    expect(client.removeOutgoingMessage).toHaveBeenCalledWith(2);
    const third = subscriber.publish('control', 'three', {
      qos: 1,
      retain: false,
    });
    const stopped = expect(third).rejects.toThrow('disconnected');
    await subscriber.stop();
    await stopped;
    expect(client.removeOutgoingMessage).toHaveBeenCalledWith(3);
  });
  it('refuses deferred MQTT.js publications after disconnect even when invoked on reconnect', async () => {
    const client = new BrokerClient();
    connect.mockReturnValue(client);
    const storePut = client.outgoingStore.put;
    const subscriber = new MqttJsSubscriber({ url: 'mqtt://unused' });
    subscriber.start();
    client.emit('connect');
    client.deferPublication = true;
    const pending = subscriber.publish('control', 'stale-command', {
      qos: 1,
      retain: false,
    });
    const rejected = expect(pending).rejects.toThrow('disconnected');
    client.connected = false;
    client.emit('close');
    await rejected;
    client.connected = true;
    client.emit('connect');
    client.deferred[0]?.();
    expect(storePut).not.toHaveBeenCalled();
    expect(client.removeOutgoingMessage).toHaveBeenCalledWith(1);
    await subscriber.stop();
  });
});
