import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HomeAssistantSocket,
  HomeAssistantSocketMessageEvent,
} from '../src/adapters/home-assistant-websocket.js';
import { DashCastAdapter } from '../src/adapters/dashcast.js';
import { startRuntime } from '../src/runtime/main.js';

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

  fail(): void {
    for (const listener of this.errors) listener();
  }
}

type OverviewSnapshot = {
  instanceId: string;
  deliveryRevision: number;
  state: { revision: number };
  health: { integrations: Record<string, string> };
  musicObservationTrust: Record<string, boolean>;
};

const token = 'a'.repeat(32);
const reported = (
  entity = 'room',
  playback = 'playing',
  updated = '2026-10-01T12:00:00Z',
) => ({
  entity_id: `media_player.${entity}`,
  state: playback,
  attributes: { volume_level: 0.3, media_title: 'Track' },
  last_updated: updated,
  last_changed: updated,
});
const report = () =>
  new Response(JSON.stringify([reported(), reported('other')]));
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}

async function setup() {
  // Only reconnect timers are virtual; HTTP sockets use real I/O.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const directory = await mkdtemp(join(tmpdir(), 'lugn-trust-'));
  const httpPort = await port();
  const displayPort = await port();
  vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-secret');
  vi.stubEnv('LUGN_TEST_DISPLAY_TOKEN', token);
  const config = join(directory, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      http: { host: '127.0.0.1', port: httpPort },
      homeAssistant: {
        baseUrl: 'http://ha.invalid',
        tokenEnv: 'LUGN_TEST_HA_TOKEN',
        entities: { 'lighting.entry': 'light.entry' },
        music: {
          'music.room': { entityId: 'media_player.room' },
          'music.other': { entityId: 'media_player.other' },
        },
      },
      scenes: [],
      display: {
        host: '0.0.0.0',
        port: displayPort,
        publicUrl: `http://127.0.0.1:${displayPort}`,
        hubs: [
          {
            id: 'bed',
            role: 'bed',
            castHost: '127.0.0.1',
            tokenEnv: 'LUGN_TEST_DISPLAY_TOKEN',
          },
        ],
      },
    }),
  );
  const sockets: FakeSocket[] = [];
  const requests: Array<{
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  let initial = true;
  const cast = new DashCastAdapter();
  vi.spyOn(cast, 'getReceiverStatus').mockResolvedValue({
    address: '127.0.0.1',
    state: 'other_app_active',
    applications: [],
  });
  const runtime = await startRuntime(config, {
    lightingIntentPath: join(directory, 'state.json'),
    createDashCastAdapter: () => cast,
    createHomeAssistantSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    homeAssistantFetch: async (input) => {
      if (!String(input).endsWith('/api/states')) return new Response(null);
      if (initial) {
        initial = false;
        return report();
      }
      return new Promise<Response>((resolve, reject) =>
        requests.push({ resolve, reject }),
      );
    },
  });
  const base = `http://127.0.0.1:${httpPort}`;
  const login = await fetch(`${base}/ui/api/session`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: '' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const overview = async () =>
    (
      await fetch(`${base}/ui/api/overview`, { headers: { Cookie: cookie } })
    ).json() as Promise<OverviewSnapshot>;
  const display = async () =>
    (
      await fetch(
        `http://127.0.0.1:${displayPort}/k/${token}/display-api/state`,
      )
    ).json();
  const connect = () => {
    const socket = sockets.at(-1)!;
    socket.receive({ type: 'auth_required' });
    socket.receive({ type: 'auth_ok' });
    const { id } = JSON.parse(socket.sent.at(-1)!);
    socket.receive({ type: 'result', id, success: true });
    return {
      socket,
      emit: (state: unknown) =>
        socket.receive({
          type: 'event',
          id,
          event: {
            event_type: 'state_changed',
            data: {
              entity_id: (state as { entity_id: string }).entity_id,
              new_state: state,
            },
          },
        }),
    };
  };
  const trust = async (expected: Record<string, boolean>) => {
    expect(await overview()).toMatchObject({ musicObservationTrust: expected });
    expect(await display()).toMatchObject({ musicObservationTrust: expected });
  };
  return {
    runtime,
    requests,
    connect,
    overview,
    display,
    trust,
    openOverviewStream: async () => {
      const abort = new AbortController();
      const response = await fetch(`${base}/ui/api/events`, {
        headers: { Cookie: cookie },
        signal: abort.signal,
      });
      const reader = response.body!.getReader();
      let frame = '';
      while (!frame.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Stream ended before snapshot');
        frame += new TextDecoder().decode(chunk.value);
      }
      return {
        payload: JSON.parse(
          frame
            .split('\n')
            .find((line) => line.startsWith('data: '))!
            .slice(6),
        ),
        close: () => abort.abort(),
      };
    },
    cleanup: async () => {
      await runtime.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('runtime music observation trust', () => {
  it('sequences HTTP and SSE health snapshots even when the engine revision does not change', async () => {
    const ui = await setup();
    let close = () => {};
    try {
      const first = await ui.overview();
      ui.connect();
      const stream = await ui.openOverviewStream();
      close = stream.close;
      const second = stream.payload;
      const third = await ui.overview();
      expect(first.instanceId).toEqual(expect.any(String));
      expect(second.instanceId).toBe(first.instanceId);
      expect(third.instanceId).toBe(first.instanceId);
      expect(second.deliveryRevision).toBeGreaterThan(first.deliveryRevision);
      expect(third.deliveryRevision).toBeGreaterThan(second.deliveryRevision);
      expect(second.state.revision).toBe(first.state.revision);
      expect(third.state.revision).toBe(first.state.revision);
      expect(first.health.integrations['home_assistant']).toBe('connecting');
      expect(second.health.integrations['home_assistant']).toBe('connected');
      expect(second.musicObservationTrust).toEqual({
        'music.room': false,
        'music.other': false,
      });
      ui.requests[0]!.resolve(report());
      await settle();
    } finally {
      close();
      await ui.cleanup();
    }
  });

  it.each(['503', 'throw', 'malformed'])(
    'keeps cached state untrusted during and after failed reconciliation: %s',
    async (failure) => {
      const ui = await setup();
      try {
        await ui.trust({ 'music.room': false, 'music.other': false });
        const first = ui.connect();
        await ui.trust({ 'music.room': false, 'music.other': false });
        // Public health remains subscription health, even during reconciliation.
        expect(await ui.overview()).toMatchObject({
          health: {
            status: 'ok',
            integrations: { home_assistant: 'connected' },
          },
        });
        ui.requests[0]!.resolve(report());
        await settle();
        await ui.trust({ 'music.room': true, 'music.other': true });
        first.socket.fail();
        await ui.trust({ 'music.room': false, 'music.other': false });
        await vi.advanceTimersByTimeAsync(1000);
        const second = ui.connect();
        await ui.trust({ 'music.room': false, 'music.other': false });
        // Live events buffer behind the query and must survive its failure.
        second.emit(reported('room', 'paused', '2026-10-02T12:00:00Z'));
        if (failure === 'throw') ui.requests[1]!.reject(new Error('offline'));
        else
          ui.requests[1]!.resolve(
            failure === '503'
              ? new Response(null, { status: 503 })
              : new Response('{}'),
          );
        await settle();
        await ui.trust({ 'music.room': true, 'music.other': false });
        expect(
          ui.runtime.engine.state.music.devices['music.room']!.observed
            .playback,
        ).toBe('paused');
        // A rejected old report and an unrelated HA entity cannot re-trust other.
        second.emit(reported('other', 'playing', '2026-09-01T12:00:00Z'));
        second.emit({ entity_id: 'light.unrelated', state: 'on' });
        await settle();
        await ui.trust({ 'music.room': true, 'music.other': false });
        second.emit(reported('other', 'paused', '2026-10-02T12:00:00Z'));
        await settle();
        await ui.trust({ 'music.room': true, 'music.other': true });
      } finally {
        await ui.cleanup();
      }
    },
  );

  it('does not apply a completed reconciliation from a lost connection, even while the next sync is pending or failed', async () => {
    const ui = await setup();
    try {
      const first = ui.connect();
      first.socket.fail();
      await vi.advanceTimersByTimeAsync(1000);
      const second = ui.connect();
      ui.requests[0]!.resolve(
        new Response(
          JSON.stringify([reported('room', 'off', '2026-10-03T12:00:00Z')]),
        ),
      );
      await settle();
      await ui.trust({ 'music.room': false, 'music.other': false });
      expect(
        ui.runtime.engine.state.music.devices['music.room']!.observed.playback,
      ).toBe('playing');
      ui.requests[1]!.resolve(new Response(null, { status: 503 }));
      await settle();
      await ui.trust({ 'music.room': false, 'music.other': false });
      // Old socket frames cannot restore trust either.
      first.emit(reported('room', 'off', '2026-10-04T12:00:00Z'));
      await settle();
      await ui.trust({ 'music.room': false, 'music.other': false });
      second.socket.fail();
      await vi.advanceTimersByTimeAsync(1000);
      ui.connect();
      ui.requests[2]!.resolve(report());
      await settle();
      await ui.trust({ 'music.room': true, 'music.other': true });
    } finally {
      await ui.cleanup();
    }
  });

  it('rejects a successful query completed after disconnect and before the next subscription', async () => {
    const ui = await setup();
    try {
      const first = ui.connect();
      first.socket.fail();
      expect(await ui.display()).toMatchObject({
        musicObservationConnected: false,
      });
      ui.requests[0]!.resolve(
        new Response(
          JSON.stringify([reported('room', 'off', '2026-10-03T12:00:00Z')]),
        ),
      );
      await settle();
      await ui.trust({ 'music.room': false, 'music.other': false });
      expect(
        ui.runtime.engine.state.music.devices['music.room']!.observed.playback,
      ).toBe('playing');
      await vi.advanceTimersByTimeAsync(1000);
      ui.connect();
      await ui.trust({ 'music.room': false, 'music.other': false });
      expect(await ui.display()).toMatchObject({
        musicObservationConnected: true,
      });
      ui.requests[1]!.resolve(report());
      await settle();
      await ui.trust({ 'music.room': true, 'music.other': true });
    } finally {
      await ui.cleanup();
    }
  });

  it('does not apply a reconciliation completing after stop', async () => {
    const ui = await setup();
    try {
      ui.connect();
      await ui.runtime.stop();
      ui.requests[0]!.resolve(
        new Response(
          JSON.stringify([reported('room', 'off', '2026-10-03T12:00:00Z')]),
        ),
      );
      await settle();
      expect(
        ui.runtime.engine.state.music.devices['music.room']!.observed.playback,
      ).toBe('playing');
    } finally {
      await ui.cleanup();
    }
  });
});
