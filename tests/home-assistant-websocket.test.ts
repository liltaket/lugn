import { describe, expect, it } from 'vitest';
import {
  HomeAssistantWebSocketTransport,
  type HomeAssistantSocket,
  type HomeAssistantSocketMessageEvent,
} from '../src/adapters/home-assistant-websocket.js';
import { FakeClock } from '../src/core/clock.js';

class FakeSocket implements HomeAssistantSocket {
  readonly sent: string[] = [];
  private readonly messages: Array<
    (event: HomeAssistantSocketMessageEvent) => void
  > = [];
  private readonly closes: Array<() => void> = [];
  private readonly errors: Array<() => void> = [];

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
    else this.errors.push(listener as () => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    for (const listener of this.closes) listener();
  }

  receive(message: unknown): void {
    for (const listener of this.messages)
      listener({ data: JSON.stringify(message) });
  }

  receiveRaw(data: string): void {
    for (const listener of this.messages) listener({ data });
  }

  fail(): void {
    for (const listener of this.errors) listener();
  }
}

function setup(
  options: { reconnectDelayMs?: number; maxReconnectDelayMs?: number } = {},
) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const events: unknown[] = [];
  const transport = new HomeAssistantWebSocketTransport(
    { baseUrl: 'https://ha.example.test/ha', token: 'test-secret' },
    (event) => events.push(event),
    {
      clock,
      createSocket: (url) => {
        urls.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      ...options,
    },
  );
  return { clock, events, sockets, transport, urls };
}

function authenticate(socket: FakeSocket): number {
  socket.receive({ type: 'auth_required', ha_version: 'test' });
  expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
    type: 'auth',
    access_token: 'test-secret',
  });
  socket.receive({ type: 'auth_ok', ha_version: 'test' });
  const subscribe = JSON.parse(socket.sent[1] ?? '{}') as {
    id: number;
    type: string;
    event_type: string;
  };
  expect(subscribe).toMatchObject({
    type: 'subscribe_events',
    event_type: 'state_changed',
  });
  return subscribe.id;
}

describe('Home Assistant WebSocket transport', () => {
  it('authenticates, waits for state_changed subscription, then forwards matching events', () => {
    const { events, sockets, transport, urls } = setup();
    transport.start();

    expect(urls).toEqual(['wss://ha.example.test/ha/api/websocket']);
    expect(transport.status).toBe('connecting');
    const socket = sockets[0]!;
    const subscriptionId = authenticate(socket);
    expect(transport.status).toBe('subscribing');

    socket.receive({ id: subscriptionId, type: 'result', success: true });
    expect(transport.status).toBe('connected');
    const event = {
      id: subscriptionId,
      type: 'event',
      event: { event_type: 'state_changed', data: {} },
    };
    socket.receive({ ...event, id: subscriptionId + 1 });
    socket.receive({
      id: subscriptionId,
      type: 'event',
      event: { event_type: 'other_event', data: {} },
    });
    socket.receive({
      id: subscriptionId,
      type: 'event',
      event: { event_type: 'state_changed' },
    });
    expect(events).toEqual([]);
    socket.receive(event);
    expect(events).toEqual([event]);
    transport.stop();
  });

  it('fails closed on invalid authentication without retrying with the rejected token', () => {
    const { clock, sockets, transport } = setup({ reconnectDelayMs: 50 });
    transport.start();
    const socket = sockets[0]!;
    socket.receive({ type: 'auth_required' });
    socket.receive({ type: 'auth_invalid', message: 'private server detail' });

    expect(transport.status).toBe('failed');
    expect(socket.sent).toHaveLength(1);
    clock.advanceBy(10_000);
    expect(sockets).toHaveLength(1);
  });

  it('reconnects after a failed subscription and repeats auth and subscription', () => {
    const { clock, sockets, transport } = setup({ reconnectDelayMs: 100 });
    transport.start();
    const firstId = authenticate(sockets[0]!);
    sockets[0]!.receive({ id: firstId, type: 'result', success: false });

    expect(transport.status).toBe('disconnected');
    clock.advanceBy(99);
    expect(sockets).toHaveLength(1);
    clock.advanceBy(1);
    expect(sockets).toHaveLength(2);
    const secondId = authenticate(sockets[1]!);
    sockets[1]!.receive({ id: secondId, type: 'result', success: true });
    expect(transport.status).toBe('connected');
    transport.stop();
  });

  it('uses bounded exponential reconnect delay and resets it after readiness', () => {
    const { clock, sockets, transport } = setup({
      reconnectDelayMs: 100,
      maxReconnectDelayMs: 250,
    });
    transport.start();
    sockets[0]!.fail();
    clock.advanceBy(100);
    expect(sockets).toHaveLength(2);
    sockets[1]!.fail();
    clock.advanceBy(199);
    expect(sockets).toHaveLength(2);
    clock.advanceBy(1);
    expect(sockets).toHaveLength(3);
    const id = authenticate(sockets[2]!);
    sockets[2]!.receive({ id, type: 'result', success: true });
    sockets[2]!.fail();
    clock.advanceBy(99);
    expect(sockets).toHaveLength(3);
    clock.advanceBy(1);
    expect(sockets).toHaveLength(4);
    transport.stop();
  });

  it('ignores malformed frames and stop cancels retries and stale socket events', () => {
    const { clock, events, sockets, transport } = setup({
      reconnectDelayMs: 100,
    });
    transport.start();
    const staleSocket = sockets[0]!;
    staleSocket.receiveRaw('{');
    staleSocket.receive({ type: 'unexpected' });
    staleSocket.fail();
    expect(transport.status).toBe('disconnected');
    transport.stop();
    staleSocket.receive({ type: 'event', id: 1, event: {} });
    clock.advanceBy(1_000);

    expect(transport.status).toBe('stopped');
    expect(events).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  it('reports callback failures without disconnecting or leaking frame data', () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const errors: string[] = [];
    const transport = new HomeAssistantWebSocketTransport(
      { baseUrl: 'http://ha.example.test', token: 'test-secret' },
      () => {
        throw new Error('sensitive handler detail');
      },
      {
        clock,
        createSocket: () => socket,
        onError: (kind) => errors.push(kind),
      },
    );
    transport.start();
    const id = authenticate(socket);
    socket.receive({ id, type: 'result', success: true });
    socket.receive({
      id,
      type: 'event',
      event: { event_type: 'state_changed', data: {} },
    });

    expect(transport.status).toBe('connected');
    expect(errors).toEqual(['event_handler']);
    transport.stop();
  });
});
