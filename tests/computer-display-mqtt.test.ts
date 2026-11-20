import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComputerDisplayAckSchema,
  ComputerDisplayCommandSchema,
  ComputerDisplayMqttAdapter,
  ComputerDisplayStateSchema,
  type ComputerDisplayAck,
  type ComputerDisplayState,
} from '../src/adapters/computer-display-mqtt.js';
import type { ComputerPlaybackMqttPort } from '../src/adapters/computer-playback-mqtt.js';
import { FakeClock } from '../src/core/clock.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const COMMAND = '77777777-7777-4777-8777-777777777777';
const NOW = 100_000;
const ROOT = 'lugn/computers/kuffe/display';
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/computer-display/${name}`, import.meta.url),
      'utf8',
    ),
  );

function state(
  overrides: Partial<ComputerDisplayState> = {},
): ComputerDisplayState {
  return {
    schema_version: 1,
    device_id: 'kuffe',
    session_id: SESSION,
    connection_id: CONNECTION,
    sequence: 1,
    timestamp_ms: NOW,
    heartbeat_interval_ms: 30_000,
    backend: 'kscreen',
    power: 'on',
    outputs: [{ connector: 'DP-1', power: 'on' }],
    power_changed_at_ms: null,
    input_idle: true,
    input_idle_since_ms: NOW - 50_000,
    idle_blockers: [],
    last_command: null,
    ...overrides,
  };
}
function ackFor(
  command: { command_id: string; action: 'on' | 'off' },
  overrides: Partial<ComputerDisplayAck> = {},
): ComputerDisplayAck {
  return {
    schema_version: 1,
    device_id: 'kuffe',
    session_id: SESSION,
    connection_id: CONNECTION,
    command_id: command.command_id,
    action: command.action,
    timestamp_ms: NOW,
    outcome: 'applied',
    reason: command.action === 'off' ? 'display_off' : 'display_on',
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
  ): () => void {
    this.handlers.set(topic, handler);
    return () => this.handlers.delete(topic);
  }
  emit(suffix: 'state' | 'ack', payload: unknown, retain = false): void {
    const topic = `${ROOT}/${suffix}`;
    this.handlers.get(topic)?.(topic, JSON.stringify(payload), { retain });
  }
  lastCommand() {
    const call = this.publish.mock.calls.at(-1)!;
    return {
      topic: call[0],
      options: call[2],
      command: JSON.parse(call[1]) as {
        command_id: string;
        action: 'on' | 'off';
      },
    };
  }
}

describe('ComputerDisplayMqttAdapter', () => {
  let clock: FakeClock;
  let port: Port;
  let adapter: ComputerDisplayMqttAdapter;
  let changes: number;
  beforeEach(() => {
    clock = new FakeClock(NOW);
    port = new Port();
    changes = 0;
    adapter = new ComputerDisplayMqttAdapter({
      deviceId: 'kuffe',
      baseTopic: 'lugn/computers',
      mqtt: port,
      clock,
      uuid: () => COMMAND,
      onChange: () => (changes += 1),
    });
    adapter.start();
    adapter.setBrokerConnected(true);
  });

  it('accepts the canonical agent examples', () => {
    for (const name of [
      'display-command-off.example.json',
      'display-command-on.example.json',
    ])
      expect(ComputerDisplayCommandSchema.parse(fixture(name))).toBeTruthy();
    expect(
      ComputerDisplayAckSchema.parse(fixture('display-ack-off.example.json')),
    ).toBeTruthy();
    expect(
      ComputerDisplayStateSchema.parse(fixture('display-state.example.json')),
    ).toBeTruthy();
  });

  it('is unusable until a live state arrives; retained state only seeds', () => {
    port.emit('state', state(), true);
    expect(adapter.getSnapshot()?.fresh).toBe(false);
    expect(adapter.sendCommand('off')).rejects.toThrow('no fresh usable');
    port.emit('state', state({ sequence: 2 }));
    expect(adapter.getSnapshot()?.fresh).toBe(true);
  });

  it('publishes a non-retained, identity-bound command and resolves on its ack', async () => {
    port.emit('state', state());
    const pending = adapter.sendCommand('off');
    const { topic, options, command } = port.lastCommand();
    expect(topic).toBe(`${ROOT}/command`);
    expect(options).toMatchObject({ qos: 1, retain: false });
    const parsed = ComputerDisplayCommandSchema.parse(command);
    expect(parsed).toMatchObject({
      session_id: SESSION,
      connection_id: CONNECTION,
      action: 'off',
      issued_at_ms: NOW,
      expires_at_ms: NOW + 10_000,
    });
    port.emit('ack', ackFor(command));
    await expect(pending).resolves.toMatchObject({
      outcome: 'applied',
      reason: 'display_off',
    });
  });

  it('ignores acknowledgements for another connection, action or retained delivery', async () => {
    port.emit('state', state());
    const pending = adapter.sendCommand('on');
    const { command } = port.lastCommand();
    port.emit(
      'ack',
      ackFor(command, {
        connection_id: '99999999-9999-4999-8999-999999999999',
      }),
    );
    port.emit('ack', ackFor({ ...command, action: 'off' }));
    port.emit('ack', ackFor(command), true);
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    port.emit('ack', ackFor(command));
    await expect(pending).resolves.toMatchObject({ reason: 'display_on' });
  });

  it('times out without an acknowledgement and never retries', async () => {
    port.emit('state', state());
    const pending = adapter.sendCommand('off');
    const assertion = expect(pending).rejects.toThrow('timed out');
    clock.advanceBy(10_000);
    await assertion;
    expect(port.publish).toHaveBeenCalledTimes(1);
  });

  it('refuses when the agent reports no usable backend', async () => {
    port.emit('state', state({ backend: null }));
    await expect(adapter.sendCommand('off')).rejects.toThrow('no fresh usable');
    expect(port.publish).not.toHaveBeenCalled();
  });

  it('expires stale state and invalidates on broker loss or a new connection', async () => {
    port.emit('state', state());
    clock.advanceBy(90_001);
    expect(adapter.getSnapshot()?.fresh).toBe(false);
    port.emit('state', state({ sequence: 2, timestamp_ms: clock.now() }));
    expect(adapter.getSnapshot()?.fresh).toBe(true);
    const pending = adapter.sendCommand('off');
    const assertion = expect(pending).rejects.toThrow('Broker connection');
    adapter.setBrokerConnected(false);
    await assertion;
    expect(adapter.getSnapshot()?.fresh).toBe(false);
    adapter.setBrokerConnected(true);
    port.emit(
      'state',
      state({
        sequence: 1,
        timestamp_ms: clock.now(),
        connection_id: '99999999-9999-4999-8999-999999999999',
      }),
    );
    expect(adapter.getSnapshot()?.state.connection_id).toBe(
      '99999999-9999-4999-8999-999999999999',
    );
    expect(changes).toBeGreaterThan(0);
  });

  it('drops malformed or foreign state and fails closed', () => {
    port.emit('state', state());
    port.emit('state', { ...state({ sequence: 2 }), extra: true });
    expect(adapter.getSnapshot()?.fresh).toBe(false);
    port.emit('state', state({ sequence: 3, device_id: 'other' }));
    expect(adapter.getSnapshot()?.fresh).toBe(false);
  });
});
