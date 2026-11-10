import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SensorRejectedError,
  Stl27lPresenceControlAdapter,
} from '../src/adapters/stl27l-presence-control.js';
import {
  Stl27lSensorStream,
  type SensorSocketFactory,
} from '../src/adapters/stl27l-sensor-stream.js';
import {
  CapabilityInputError,
  CapabilityRegistry,
} from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { LugnHttpServer } from '../src/runtime/http-server.js';

const configDocument = {
  version: 1,
  fields: [
    {
      key: 'passage_deadtime_ms',
      section: 'counter',
      type: 'integer',
      recalibrates: false,
      min: 0,
      max: 5000,
      step: 10,
      unit: 'ms',
    },
    {
      key: 'prelight_mode',
      section: 'prelight',
      type: 'enum',
      recalibrates: false,
      options: ['legacy', 'smart'],
    },
  ],
  values: { passage_deadtime_ms: 200, prelight_mode: 'legacy' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const frame = {
  timestamp: '2026-11-10T12:00:00+00:00',
  scan_id: 7,
  metrics: {
    lidar_hz: 10,
    points_per_second: 21600,
    total_scans: 100,
    crc_errors: 0,
  },
  state: {
    count: 1,
    quality: 'CERTAIN',
    confidence: 1,
    last_direction: 'enter',
  },
  preview_active: false,
  preview_info: { approaching_tracks: [] },
  door: {
    enabled: true,
    connected: true,
    entity_id: 'binary_sensor.secret_door',
    state: 'open',
    blocking: false,
  },
  serial_port: '/dev/serial/by-id/usb-secret',
  points: [[0.1, 0.2, true]],
  clusters: [{ x: 0.1, y: 0.2, diameter: 0.4, points: 12 }],
  tracks: [],
  config: { threshold_y: 0, invert_direction: false },
};

describe('sensor control adapter and capabilities', () => {
  it('reads the sensor schema and sends only the changes', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(configDocument))
      .mockResolvedValueOnce(
        json({
          ...configDocument,
          values: { ...configDocument.values, passage_deadtime_ms: 350 },
          ok: true,
          background_reset: true,
        }),
      );
    const adapter = new Stl27lPresenceControlAdapter(
      'http://sensor.local:8080/',
      transport,
    );
    expect((await adapter.getConfig()).values['passage_deadtime_ms']).toBe(200);
    const result = await adapter.updateConfig({ passage_deadtime_ms: 350 });
    expect(result.backgroundReset).toBe(true);
    expect(result.values['passage_deadtime_ms']).toBe(350);
    const [url, init] = transport.mock.calls[1]!;
    expect(url).toBe('http://sensor.local:8080/api/v1/config');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({
      changes: { passage_deadtime_ms: 350 },
    });
    expect(adapter.streamUrl).toBe(
      'ws://sensor.local:8080/ws/stream?max_fps=5&point_step=8',
    );
  });

  it('maps a sensor rejection to an input error and other failures to errors', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ detail: 'nope' }, 400))
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ ok: true, count: 2 }));
    const adapter = new Stl27lPresenceControlAdapter(
      'http://sensor.local:8080',
      transport,
    );
    await expect(
      adapter.updateConfig({ rotation_deg: 999 }),
    ).rejects.toBeInstanceOf(SensorRejectedError);
    await expect(adapter.recalibrate()).rejects.toThrow('request failed');
    await expect(adapter.setCount(3)).rejects.toThrow('not acknowledged');

    const engine = new LugnEngine(new FakeClock(0));
    const registry = new CapabilityRegistry(engine, {
      presenceCountAdapter: new Stl27lPresenceControlAdapter(
        'http://sensor.local:8080',
        async () => json({}, 400),
      ),
    });
    await expect(
      registry.invoke(
        'presence.updateSensorConfig',
        { changes: { rotation_deg: 999 } },
        { actor: { type: 'user', id: 'ui' } },
      ),
    ).rejects.toMatchObject({ code: 'sensor_rejected_change' });
    engine.dispose();
  });

  it('requires a configured sensor and strict inputs', async () => {
    const engine = new LugnEngine(new FakeClock(0));
    const registry = new CapabilityRegistry(engine);
    const invocation = { actor: { type: 'user' as const, id: 'ui' } };
    for (const name of [
      'presence.recalibrate',
      'presence.getSensorConfig',
    ] as const)
      await expect(registry.invoke(name, {}, invocation)).rejects.toThrow(
        CapabilityInputError,
      );
    await expect(
      registry.invoke('presence.setCount', { count: 11 }, invocation),
    ).rejects.toThrow();
    await expect(
      registry.invoke(
        'presence.updateSensorConfig',
        { changes: {} },
        invocation,
      ),
    ).rejects.toThrow();
    engine.dispose();
  });
});

type FakeSocket = {
  url: string;
  closed: boolean;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
};

function fakeSockets(): {
  sockets: FakeSocket[];
  factory: SensorSocketFactory;
} {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (url) => {
      const socket: FakeSocket = {
        url,
        closed: false,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        close() {
          socket.closed = true;
        },
      };
      sockets.push(socket);
      return socket;
    },
  };
}

describe('sensor radar stream', () => {
  it('accepts a frame captured from the real sensor pipeline', () => {
    // Generated by the sensor's own DoorwayService from its simulator ("entry"
    // scenario) so a change to the sensor's frame breaks this test, not the page.
    const real = readFileSync(
      new URL('./fixtures/presence/sensor-frame.json', import.meta.url),
      'utf8',
    );
    const { sockets, factory } = fakeSockets();
    const stream = new Stl27lSensorStream('ws://sensor/ws/stream', factory);
    const messages: string[] = [];
    stream.subscribe((message) => messages.push(message.type));
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: real });
    expect(messages).toEqual(['status', 'status', 'frame']);
    stream.close();
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects on demand, strips private fields and closes when idle', () => {
    const { sockets, factory } = fakeSockets();
    const stream = new Stl27lSensorStream('ws://sensor/ws/stream', factory);
    expect(sockets).toHaveLength(0);
    const received: string[] = [];
    const unsubscribe = stream.subscribe((message) =>
      received.push(`${message.type}:${message.data}`),
    );
    const second = stream.subscribe(() => undefined);
    expect(sockets).toHaveLength(1);
    expect(received).toEqual(['status:{"connected":false}']);

    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: JSON.stringify(frame) });
    const relayed = received.at(-1)!;
    expect(relayed.startsWith('frame:')).toBe(true);
    expect(relayed).not.toContain('secret');
    expect(relayed).not.toContain('entity_id');
    expect(JSON.parse(relayed.slice(6)).door).toEqual({
      enabled: true,
      connected: true,
      state: 'open',
      blocking: false,
    });

    const before = received.length;
    for (const bad of [
      'not json',
      JSON.stringify({ ...frame, state: { ...frame.state, count: 'x' } }),
      JSON.stringify({ ...frame, points: [[1, 2]] }),
      new ArrayBuffer(4),
    ])
      sockets[0]!.onmessage?.({ data: bad });
    expect(received).toHaveLength(before);

    unsubscribe();
    expect(sockets[0]!.closed).toBe(false);
    second();
    expect(sockets[0]!.closed).toBe(true);
  });

  it('reports a frozen sensor as not live even while the socket stays open', () => {
    const { sockets, factory } = fakeSockets();
    const stream = new Stl27lSensorStream('ws://sensor/ws/stream', factory);
    const messages: string[] = [];
    stream.subscribe((message) =>
      messages.push(
        message.type === 'status' ? `status:${message.data}` : message.type,
      ),
    );
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: JSON.stringify(frame) });
    vi.advanceTimersByTime(4_999);
    expect(messages.at(-1)).toBe('frame');
    vi.advanceTimersByTime(1);
    expect(messages.at(-1)).toBe('status:{"connected":false}');
    expect(sockets[0]!.closed).toBe(false);

    const late: string[] = [];
    stream.subscribe((message) => late.push(message.type));
    expect(late).toEqual(['status']);

    sockets[0]!.onmessage?.({ data: JSON.stringify(frame) });
    expect(messages.slice(-2)).toEqual(['status:{"connected":true}', 'frame']);
    stream.close();
  });

  it('replays the latest frame to a late viewer and reconnects with backoff', () => {
    const { sockets, factory } = fakeSockets();
    const stream = new Stl27lSensorStream('ws://sensor/ws/stream', factory);
    const first = vi.fn();
    stream.subscribe(first);
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: JSON.stringify(frame) });

    const late: string[] = [];
    stream.subscribe((message) => late.push(message.type));
    expect(late).toEqual(['status', 'frame']);

    sockets[0]!.onclose?.();
    expect(first).toHaveBeenLastCalledWith({
      type: 'status',
      data: '{"connected":false}',
    });
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.onerror?.();
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    stream.close();
    expect(sockets[2]!.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(3);
  });
});

describe('control panel presence routes', () => {
  let server: LugnHttpServer | undefined;
  let engine: LugnEngine | undefined;
  afterEach(async () => {
    await server?.stop();
    engine?.dispose();
    server = undefined;
    engine = undefined;
  });

  async function start(options: {
    stream?: Stl27lSensorStream;
    transport?: typeof fetch;
  }) {
    const finder = createServer();
    await new Promise<void>((resolve) =>
      finder.listen(0, '127.0.0.1', resolve),
    );
    const address = finder.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    await new Promise<void>((resolve) => finder.close(() => resolve()));
    engine = new LugnEngine(new FakeClock(0));
    server = new LugnHttpServer({
      host: '127.0.0.1',
      port: address.port,
      bearerToken: 'local-test-token',
      engine,
      capabilities: new CapabilityRegistry(
        engine,
        options.transport
          ? {
              presenceCountAdapter: new Stl27lPresenceControlAdapter(
                'http://sensor.local:8080',
                options.transport,
              ),
            }
          : {},
      ),
      ...(options.stream ? { presenceSensorStream: options.stream } : {}),
      integrations: () => ({}),
    });
    await server.start();
    const origin = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${origin}/ui/api/session`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'local-test-token' }),
    });
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const cookie = `lugn_ui_session=${
      login.headers.get('set-cookie')?.match(/lugn_ui_session=([^;]+)/)?.[1]
    }`;
    return { origin, csrfToken, cookie };
  }

  it('hides the page when no sensor is configured', async () => {
    const { origin, cookie } = await start({});
    const overview = await fetch(`${origin}/ui/api/overview`, {
      headers: { Cookie: cookie },
    });
    expect(
      ((await overview.json()) as { presenceSensorEnabled: boolean })
        .presenceSensorEnabled,
    ).toBe(false);
    const stream = await fetch(`${origin}/ui/api/presence-sensor/stream`, {
      headers: { Cookie: cookie },
    });
    expect(stream.status).toBe(404);
  });

  it('streams frames only to a signed-in session', async () => {
    const { sockets, factory } = fakeSockets();
    const stream = new Stl27lSensorStream('ws://sensor/ws/stream', factory);
    const { origin, cookie } = await start({ stream });
    const overview = await fetch(`${origin}/ui/api/overview`, {
      headers: { Cookie: cookie },
    });
    expect(
      ((await overview.json()) as { presenceSensorEnabled: boolean })
        .presenceSensorEnabled,
    ).toBe(true);

    const anonymous = await fetch(`${origin}/ui/api/presence-sensor/stream`);
    expect(anonymous.status).toBe(401);
    expect(sockets).toHaveLength(0);

    const abort = new AbortController();
    const response = await fetch(`${origin}/ui/api/presence-sensor/stream`, {
      headers: { Cookie: cookie },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(sockets).toHaveLength(1);
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: JSON.stringify(frame) });

    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('event: frame')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain('event: status');
    expect(text).toContain('event: frame');
    expect(text).not.toContain('secret');
    abort.abort();
    await vi.waitFor(() => expect(stream.viewerCount).toBe(0));
    expect(sockets[0]!.closed).toBe(true);
  });

  it('reaches the sensor through the signed-in capability route', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(configDocument))
      .mockResolvedValueOnce(json({ ok: true, count: 2 }));
    const { origin, csrfToken, cookie } = await start({ transport });
    const call = (name: string, input: unknown) =>
      fetch(`${origin}/ui/api/capabilities/${name}`, {
        method: 'POST',
        headers: {
          Origin: origin,
          Cookie: cookie,
          'X-Lugn-CSRF': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input }),
      });
    const read = await call('presence.getSensorConfig', {});
    expect(read.status).toBe(200);
    expect(((await read.json()) as { version: number }).version).toBe(1);
    const set = await call('presence.setCount', { count: 2 });
    expect(await set.json()).toEqual({ accepted: true, count: 2 });
    const invalid = await call('presence.setCount', { count: 99 });
    expect(invalid.status).toBe(400);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
