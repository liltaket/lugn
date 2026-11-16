import { join } from 'node:path';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { ZodError } from 'zod';
import { DEVICE_API_VERSION } from '../../src/core/device-api.js';
import {
  DeviceRegistryError,
  type AuthenticatedDevice,
} from '../../src/runtime/device-registry.js';
import {
  deviceResponseHeaders,
  DeviceRequestError,
  readJsonBody,
  sendJson,
} from '../../src/runtime/device-http.js';
import type { Recording } from './recording.js';
import { SimDeviceRegistry } from './sim-room.js';

type View = Record<string, unknown> & {
  instanceId: string;
  revision: number;
  generatedAt: number;
};

type TimedEvent = {
  t: number;
  event: string;
  id: string | null;
  data: unknown;
};

export type ReplayOptions = {
  recording: Recording;
  host: string;
  port: number;
  allowedHosts: readonly string[];
  stateDir: string;
  /** Playback speed relative to the recording's wall time. */
  speed?: number;
  /** Restart from the beginning at the end instead of holding the last state. */
  loop?: boolean;
  /** Seconds into the recording to start from. */
  startAt?: number;
  /** Seconds into the recording at which playback freezes (deterministic UI tests). */
  pauseAt?: number;
  fixedPairingCode?: string;
  log?: (line: string) => void;
};

/**
 * Serves a recorded device-sim session: pairing, `/me`, `/state` and
 * `/events` behave like the live listener, but the state follows the
 * recording. Commands and phone observations are refused with
 * `503 replay_read_only`. Every new stream starts with a snapshot of the
 * current replay position; Last-Event-ID is ignored.
 */
export class ReplayServer {
  readonly registry: SimDeviceRegistry;
  private server: Server | undefined;
  private readonly events: TimedEvent[];
  private readonly initial: View;
  private view: View;
  private cursor = 0;
  /** Recording time (ms) reached so far. */
  private position = 0;
  private readonly streams = new Set<ServerResponse>();
  private playTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private playStartedAt = 0;
  private playStartedPosition = 0;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly log: (line: string) => void;
  pairingCode: string | undefined;

  constructor(private readonly options: ReplayOptions) {
    this.log = options.log ?? (() => undefined);
    this.allowedHosts = new Set(
      options.allowedHosts.map((h) => h.toLowerCase()),
    );
    this.registry = new SimDeviceRegistry(
      join(options.stateDir, 'replay-devices.json'),
      options.fixedPairingCode,
      this.log,
    );
    this.events = [];
    let initial: View | undefined;
    for (const line of options.recording.lines) {
      if (line.type === 'state') {
        initial ??= line.data as View;
        // Full states re-anchor the view, as a client polling /state would.
        this.events.push({
          t: line.t,
          event: 'state',
          id: null,
          data: line.data,
        });
      } else if (line.type === 'sse' && line.event !== 'heartbeat') {
        if (line.event === 'snapshot') initial ??= line.data as View;
        this.events.push(line);
      }
    }
    if (!initial) throw new Error('recording has no snapshot or state');
    this.initial = structuredClone(initial);
    this.view = structuredClone(initial);
  }

  get duration(): number {
    return this.events.at(-1)?.t ?? 0;
  }

  get currentPosition(): number {
    return this.position;
  }

  get currentView(): View {
    return structuredClone(this.view);
  }

  get address(): { host: string; port: number } | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object'
      ? { host: address.address, port: address.port }
      : undefined;
  }

  async start(): Promise<void> {
    await this.registry.load();
    this.issuePairingCode();
    this.registry.onAutoCodeUsed = () => this.issuePairingCode();
    this.seek((this.options.startAt ?? 0) * 1_000);
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.heartbeat = setInterval(() => this.writeHeartbeats(), 15_000);
    this.heartbeat.unref();
    this.play();
  }

  async stop(): Promise<void> {
    if (this.playTimer) clearTimeout(this.playTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return;
    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    server.closeAllConnections();
    await closed;
  }

  issuePairingCode(): string | undefined {
    try {
      this.pairingCode = this.registry.createPairingCode({
        ttlSeconds: 900,
      }).code;
      this.registry.autoCode = this.pairingCode.replace('-', '');
      return this.pairingCode;
    } catch {
      return undefined;
    }
  }

  /** Applies recorded changes up to `position` without sending them. */
  private seek(position: number): void {
    while (
      this.cursor < this.events.length &&
      this.events[this.cursor]!.t <= position
    )
      this.apply(this.events[this.cursor++]!);
    this.position = position;
  }

  private apply(event: TimedEvent): void {
    if (event.event === 'snapshot' || event.event === 'state') {
      this.view = structuredClone(event.data as View);
      return;
    }
    if (event.event === 'patch') {
      const patch = event.data as {
        instanceId: string;
        revision: number;
        generatedAt: number;
        sections: Record<string, unknown>;
      };
      this.view = {
        ...this.view,
        ...structuredClone(patch.sections),
        instanceId: patch.instanceId,
        revision: patch.revision,
        generatedAt: patch.generatedAt,
      };
    }
  }

  private play(): void {
    this.playStartedAt = Date.now();
    this.playStartedPosition = this.position;
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.playTimer) clearTimeout(this.playTimer);
    const speed = this.options.speed ?? 1;
    const pauseAt =
      this.options.pauseAt === undefined
        ? Infinity
        : this.options.pauseAt * 1_000;
    const next = this.events[this.cursor];
    if (!next || next.t > pauseAt) {
      if (!next && this.options.loop && this.events.length > 0) {
        this.playTimer = setTimeout(() => this.restartLoop(), 2_000 / speed);
        this.playTimer.unref();
      } else if (Number.isFinite(pauseAt)) {
        this.position = Math.min(pauseAt, this.duration);
        this.log(`replay paused at ${(this.position / 1000).toFixed(1)} s`);
      } else {
        this.log('replay reached the end; holding the last state');
      }
      return;
    }
    const due =
      this.playStartedAt + (next.t - this.playStartedPosition) / speed;
    this.playTimer = setTimeout(
      () => {
        this.cursor += 1;
        this.position = next.t;
        this.apply(next);
        this.forward(next);
        this.scheduleNext();
      },
      Math.max(0, due - Date.now()),
    );
    this.playTimer.unref();
  }

  private restartLoop(): void {
    this.cursor = 0;
    this.view = structuredClone(this.initial);
    this.seek(0);
    this.log('replay looping from the start');
    for (const stream of this.streams) this.writeSnapshot(stream);
    this.play();
  }

  private forward(event: TimedEvent): void {
    // `state` lines are polls, not stream events.
    if (event.event === 'state') return;
    for (const stream of this.streams)
      writeEvent(stream, event.event, event.id, event.data);
  }

  private writeSnapshot(stream: ServerResponse): void {
    writeEvent(
      stream,
      'snapshot',
      `${this.view.instanceId}-${this.view.revision}`,
      this.view,
    );
  }

  private writeHeartbeats(): void {
    for (const stream of this.streams)
      if (!stream.writableNeedDrain)
        stream.write(
          `event: heartbeat\ndata: ${JSON.stringify({
            instanceId: this.view.instanceId,
            revision: this.view.revision,
            serverTime: this.view.generatedAt,
          })}\n\n`,
        );
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const host = request.headers.host;
      if (
        typeof host !== 'string' ||
        !this.allowedHosts.has(host.toLowerCase())
      )
        return sendJson(response, 421, { error: 'host_not_allowed' });
      if (request.headers.origin !== undefined)
        return sendJson(response, 403, { error: 'browser_origin_not_allowed' });
      const url = new URL(request.url ?? '/', 'http://replay.invalid');
      const route = `${request.method} ${url.pathname}`;
      if (route === 'POST /api/v1/pair') {
        const body = await readJsonBody(request, 2 * 1024);
        return sendJson(response, 201, await this.registry.pair(body));
      }
      const known = [
        'GET /api/v1/me',
        'GET /api/v1/state',
        'GET /api/v1/events',
        'GET /api/v1/phone/config',
        'POST /api/v1/commands',
        'POST /api/v1/phone/observations',
      ];
      if (!known.includes(route))
        return sendJson(response, 404, { error: 'not_found' });
      const device = this.authenticate(request);
      if (!device) {
        response.setHeader('www-authenticate', 'Bearer realm="Lugn"');
        return sendJson(response, 401, { error: 'unauthorized' });
      }
      switch (route) {
        case 'GET /api/v1/me':
          return sendJson(response, 200, {
            apiVersion: DEVICE_API_VERSION,
            device: {
              id: device.id,
              name: device.name,
              platform: device.platform,
              scopes: [...device.scopes],
            },
            serverTime: this.view.generatedAt,
          });
        case 'GET /api/v1/state':
          return sendJson(response, 200, this.view);
        case 'GET /api/v1/phone/config':
          return this.options.recording.header.phoneConfig
            ? sendJson(response, 200, this.options.recording.header.phoneConfig)
            : sendJson(response, 404, { error: 'not_found' });
        case 'GET /api/v1/events':
          return this.openStream(request, response);
        default:
          return sendJson(response, 503, { error: 'replay_read_only' });
      }
    } catch (error) {
      if (
        error instanceof DeviceRegistryError ||
        error instanceof DeviceRequestError
      )
        return sendJson(response, error.status, { error: error.code });
      if (error instanceof ZodError)
        return sendJson(response, 400, { error: 'invalid_request' });
      sendJson(response, 500, { error: 'internal_error' });
    }
  }

  private openStream(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      ...deviceResponseHeaders,
      'cache-control': 'no-cache, no-store, no-transform',
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
    });
    request.socket.setNoDelay(true);
    this.streams.add(response);
    response.once('close', () => this.streams.delete(response));
    response.write('retry: 5000\n\n');
    this.writeSnapshot(response);
  }

  private authenticate(
    request: IncomingMessage,
  ): AuthenticatedDevice | undefined {
    const match = /^Bearer ([^\s]{1,256})$/.exec(
      request.headers.authorization ?? '',
    );
    return match?.[1] ? this.registry.authenticate(match[1]) : undefined;
  }
}

function writeEvent(
  stream: ServerResponse,
  event: string,
  id: string | null,
  data: unknown,
): void {
  if (stream.destroyed) return;
  stream.write(
    `event: ${event}\n${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`,
  );
}
