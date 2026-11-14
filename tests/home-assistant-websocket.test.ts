import { describe, expect, it } from 'vitest';
import {
  HomeAssistantWebSocketTransport,
  type HomeAssistantConnection,
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
  options: {
    reconnectDelayMs?: number;
    maxReconnectDelayMs?: number;
    onConnected?: (connection: HomeAssistantConnection) => void;
    onDisconnected?: () => void;
  } = {},
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

  it('invalidates reconciliation context immediately on loss, auth failure and stop', () => {
    const clock = new FakeClock();
    const sockets: FakeSocket[] = [];
    const connections: HomeAssistantConnection[] = [];
    const transport = new HomeAssistantWebSocketTransport(
      { baseUrl: 'http://ha.invalid', token: 'test-secret' },
      () => {},
      {
        clock,
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        onConnected: (connection) => {
          connections.push(connection);
        },
      },
    );
    transport.start();
    const id = authenticate(sockets[0]!);
    sockets[0]!.receive({ type: 'result', id, success: true });
    expect(connections[0]!.isCurrent()).toBe(true);
    sockets[0]!.fail();
    expect(connections[0]!.isCurrent()).toBe(false);
    clock.advanceBy(1000);
    const second = authenticate(sockets[1]!);
    sockets[1]!.receive({ type: 'result', id: second, success: true });
    expect(connections[0]!.isCurrent()).toBe(false);
    expect(connections[1]!.isCurrent()).toBe(true);
    sockets[1]!.receive({ type: 'auth_invalid' });
    expect(connections[1]!.isCurrent()).toBe(false);
    transport.start();
    const third = authenticate(sockets[2]!);
    sockets[2]!.receive({ type: 'result', id: third, success: true });
    expect(connections[2]!.isCurrent()).toBe(true);
    transport.stop();
    expect(connections[2]!.isCurrent()).toBe(false);
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

it('optionally observes passive automation/service events while filtering other HA events and preserving freshness metadata', () => {
  const socket = new FakeSocket();
  const events: unknown[] = [];
  const transport = new HomeAssistantWebSocketTransport(
    { baseUrl: 'http://ha.test', token: 'test-secret' },
    (event) => events.push(event),
    {
      createSocket: () => socket,
      additionalEventTypes: ['automation_triggered', 'call_service'],
    },
  );
  transport.start();
  socket.receive({ type: 'auth_required' });
  socket.receive({ type: 'auth_ok' });
  const subscription = JSON.parse(socket.sent[1]!) as {
    id: number;
    event_type?: string;
  };
  expect(subscription).toMatchObject({ type: 'subscribe_events' });
  expect(subscription.event_type).toBeUndefined();
  socket.receive({ type: 'result', id: subscription.id, success: true });
  for (const event_type of [
    'automation_triggered',
    'call_service',
    'state_changed',
    'unrelated',
  ]) {
    socket.receive({
      type: 'event',
      id: subscription.id,
      event: {
        event_type,
        data: {},
        time_fired: '2026-10-21T12:00:00Z',
        context: { id: 'opaque' },
      },
    });
  }
  expect(events).toHaveLength(3);
  expect(events[0]).toMatchObject({
    event: { time_fired: '2026-10-21T12:00:00Z', context: { id: 'opaque' } },
  });
  transport.stop();
});
it('notifies trust loss on socket failure, authentication rejection and stop', () => {
  const sockets: FakeSocket[] = [];
  let lost = 0;
  const transport = new HomeAssistantWebSocketTransport(
    { baseUrl: 'http://ha.test', token: 'test-secret' },
    () => {},
    {
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onDisconnected: () => {
        lost++;
      },
    },
  );
  transport.start();
  const socket = sockets[0]!;
  const id = authenticate(socket);
  socket.receive({ id, type: 'result', success: true });
  socket.fail();
  expect(lost).toBe(1);
  transport.stop();
  expect(lost).toBe(2);
  transport.start();
  sockets[1]!.receive({ type: 'auth_invalid' });
  expect(lost).toBe(3);
  transport.stop();
});

describe('Home Assistant WebSocket service calls', () => {
  function connected() {
    const context = setup();
    context.transport.start();
    const socket = context.sockets[0]!;
    const subscriptionId = authenticate(socket);
    socket.receive({ type: 'result', id: subscriptionId, success: true });
    expect(context.transport.status).toBe('connected');
    return { ...context, socket };
  }
  const call = {
    domain: 'light',
    service: 'turn_on',
    serviceData: { brightness_pct: 40 },
    target: { entity_id: 'light.desk' },
  };

  it('returns undefined without sending until the subscription is connected', () => {
    const { sockets, transport } = setup();
    expect(transport.callService(call)).toBeUndefined();
    transport.start();
    authenticate(sockets[0]!);
    expect(transport.callService(call)).toBeUndefined();
    expect(sockets[0]!.sent).toHaveLength(2);
  });

  it('sends call_service synchronously and settles on its own result id', async () => {
    const { socket, transport } = connected();
    const first = transport.callService(call)!;
    const second = transport.callService({ ...call, service: 'turn_off' })!;
    const frames = socket.sent
      .slice(2)
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
    expect(frames[0]).toEqual({
      id: frames[0]!['id'],
      type: 'call_service',
      domain: 'light',
      service: 'turn_on',
      service_data: { brightness_pct: 40 },
      target: { entity_id: 'light.desk' },
    });
    expect(frames[0]!['id']).not.toBe(frames[1]!['id']);
    socket.receive({
      type: 'result',
      id: frames[1]!['id'],
      success: false,
      error: { code: 'service_validation_error', message: 'Invalid' },
    });
    await expect(second).rejects.toMatchObject({
      outcome: 'rejected',
      code: 'service_validation_error',
    });
    socket.receive({ type: 'result', id: frames[0]!['id'], success: true });
    await expect(first).resolves.toBeUndefined();
  });

  it('reports sent calls without a result as no_response on timeout, loss and stop', async () => {
    const { clock, socket, sockets, transport } = connected();
    const timedOut = transport.callService(call)!;
    clock.advanceBy(10_000);
    await expect(timedOut).rejects.toMatchObject({ outcome: 'no_response' });

    const lost = transport.callService(call)!;
    socket.fail();
    await expect(lost).rejects.toMatchObject({ outcome: 'no_response' });
    expect(transport.callService(call)).toBeUndefined();

    clock.advanceBy(1_000);
    const next = sockets[1]!;
    next.receive({ type: 'auth_required' });
    next.receive({ type: 'auth_ok' });
    const subscription = JSON.parse(next.sent.at(-1)!) as { id: number };
    next.receive({ type: 'result', id: subscription.id, success: true });
    const stopped = transport.callService(call)!;
    transport.stop();
    await expect(stopped).rejects.toMatchObject({ outcome: 'no_response' });
  });

  it('abandons all pending calls on auth failure and isolates an explicit restart', async () => {
    const connections: HomeAssistantConnection[] = [];
    const timersAtDisconnect: number[] = [];
    const { clock, sockets, transport } = setup({
      onConnected: (connection) => {
        connections.push(connection);
      },
      onDisconnected: () => {
        timersAtDisconnect.push(clock.pendingTimers());
      },
    });
    transport.start();
    const first = sockets[0]!;
    const subscription = authenticate(first);
    first.receive({ type: 'result', id: subscription, success: true });
    expect(connections[0]!.isCurrent()).toBe(true);

    const outcomes: unknown[] = [];
    const pending = [10_000, 20_000].map((timeout) =>
      transport.callService(call, timeout)!.then(
        () => outcomes.push('resolved'),
        (error: unknown) => outcomes.push(error),
      ),
    );
    const oldCallId = (JSON.parse(first.sent.at(-1)!) as { id: number }).id;
    expect(clock.pendingTimers()).toBe(2);
    first.receive({ type: 'auth_invalid' });
    // This must settle without advancing the timeout or awaiting a stuck call.
    await Promise.resolve();
    expect(outcomes).toEqual([
      expect.objectContaining({ outcome: 'no_response' }),
      expect.objectContaining({ outcome: 'no_response' }),
    ]);
    expect(clock.pendingTimers()).toBe(0);
    expect(timersAtDisconnect).toEqual([0]);
    expect(transport.status).toBe('failed');
    expect(connections[0]!.isCurrent()).toBe(false);
    expect(transport.callService(call)).toBeUndefined();
    await Promise.all(pending);
    clock.advanceBy(30_000);
    expect(sockets).toHaveLength(1);

    transport.start();
    const second = sockets[1]!;
    const nextSubscription = authenticate(second);
    second.receive({ type: 'result', id: nextSubscription, success: true });
    expect(connections[1]!.isCurrent()).toBe(true);
    let settled = false;
    const next = transport.callService(call)!.then(() => {
      settled = true;
    });
    const nextId = (JSON.parse(second.sent.at(-1)!) as { id: number }).id;
    first.receive({ type: 'result', id: oldCallId, success: true });
    first.receive({ type: 'result', id: nextId, success: true });
    first.receive({ type: 'auth_invalid' });
    first.fail();
    first.close();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(transport.status).toBe('connected');
    expect(connections[1]!.isCurrent()).toBe(true);
    expect(clock.pendingTimers()).toBe(1);
    second.receive({ type: 'result', id: nextId, success: true });
    await next;
    expect(settled).toBe(true);
    transport.stop();
    expect(clock.pendingTimers()).toBe(0);
  });
});
