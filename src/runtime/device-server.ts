import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { ZodError } from 'zod';
import { systemClock, type Clock } from '../core/clock.js';
import {
  DEVICE_API_VERSION,
  type ApiError,
  type DeviceScope,
  type MeResponse,
} from '../core/device-api.js';
import {
  DeviceRegistryError,
  type AuthenticatedDevice,
  type DeviceRegistry,
} from './device-registry.js';
import { TokenBucketLimiter } from './rate-limiter.js';

const PAIR_MAX_BYTES = 2 * 1024;

export type LugnDeviceServerOptions = {
  host: string;
  port: number;
  /** Exact Host header values (host:port) this listener answers. */
  allowedHosts: readonly string[];
  registry: DeviceRegistry;
  clock?: Clock;
};

type Route = {
  method: 'GET' | 'POST';
  path: string;
  /** Undefined for the unauthenticated pairing exchange. */
  scope: DeviceScope | 'any' | undefined;
  /** Per-device budget class. */
  limit: 'read' | 'write' | 'ingest' | 'stream' | 'pair';
  handle: (context: RequestContext) => Promise<void> | void;
};

export type RequestContext = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  device: AuthenticatedDevice | undefined;
};

/**
 * The `/api/v1` listener for paired native clients. It is separate from the
 * loopback machine API and the Hub display server, accepts only bearer tokens
 * issued by the device registry, and is designed for non-browser clients:
 * there are no cookies, no CORS headers, and any request carrying an Origin
 * header is refused.
 */
export class LugnDeviceServer {
  private server: Server | undefined;
  private readonly clock: Clock;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly routes: Route[] = [];
  private readonly anonymousLimiter: TokenBucketLimiter;
  private readonly limiters: Record<Route['limit'], TokenBucketLimiter>;

  constructor(private readonly options: LugnDeviceServerOptions) {
    this.clock = options.clock ?? systemClock;
    this.allowedHosts = new Set(
      options.allowedHosts.map((host) => host.toLowerCase()),
    );
    if (this.allowedHosts.size === 0)
      throw new Error('Device API requires at least one allowed Host value');
    // Failed authentication and pairing attempts per remote address.
    this.anonymousLimiter = new TokenBucketLimiter(this.clock, {
      capacity: 10,
      refillPerMinute: 10,
    });
    this.limiters = {
      read: new TokenBucketLimiter(this.clock, {
        capacity: 60,
        refillPerMinute: 120,
      }),
      write: new TokenBucketLimiter(this.clock, {
        capacity: 20,
        refillPerMinute: 60,
      }),
      ingest: new TokenBucketLimiter(this.clock, {
        capacity: 30,
        refillPerMinute: 60,
      }),
      stream: new TokenBucketLimiter(this.clock, {
        capacity: 6,
        refillPerMinute: 6,
      }),
      pair: new TokenBucketLimiter(this.clock, {
        capacity: 5,
        refillPerMinute: 5,
      }),
    };
    this.route({
      method: 'POST',
      path: '/api/v1/pair',
      scope: undefined,
      limit: 'pair',
      handle: (context) => this.pair(context),
    });
    this.route({
      method: 'GET',
      path: '/api/v1/me',
      scope: 'any',
      limit: 'read',
      handle: ({ response, device }) => {
        const body: MeResponse = {
          apiVersion: DEVICE_API_VERSION,
          device: {
            id: device!.id,
            name: device!.name,
            platform: device!.platform,
            scopes: [...device!.scopes],
          },
          serverTime: this.clock.now(),
        };
        sendJson(response, 200, body);
      },
    });
  }

  /** Additional milestones register their routes here before start(). */
  route(route: Route): void {
    this.routes.push(route);
  }

  get address(): { host: string; port: number } | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object'
      ? { host: address.address, port: address.port }
      : undefined;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    // Slow clients cannot hold a socket open while sending a request.
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.maxHeadersCount = 64;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.port, this.options.host);
    }).catch((error: unknown) => {
      this.server = undefined;
      throw error;
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return;
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const host = request.headers.host;
      if (
        typeof host !== 'string' ||
        !this.allowedHosts.has(host.toLowerCase())
      ) {
        sendError(response, 421, 'host_not_allowed');
        return;
      }
      // Native clients never send Origin; any browser context is refused
      // before authentication so the listener never acts as a CORS endpoint.
      if (request.headers.origin !== undefined) {
        sendError(response, 403, 'browser_origin_not_allowed');
        return;
      }
      const url = new URL(request.url ?? '/', 'http://device.invalid');
      const candidates = this.routes.filter(
        (route) => route.path === url.pathname,
      );
      if (candidates.length === 0) {
        sendError(response, 404, 'not_found');
        return;
      }
      const route = candidates.find((entry) => entry.method === request.method);
      if (!route) {
        response.setHeader(
          'allow',
          [...new Set(candidates.map((entry) => entry.method))].join(', '),
        );
        sendError(response, 405, 'method_not_allowed');
        return;
      }
      const remote = request.socket.remoteAddress ?? 'unknown';
      let device: AuthenticatedDevice | undefined;
      if (route.scope === undefined) {
        const wait = this.limiters.pair.take(`ip:${remote}`);
        if (wait > 0) {
          sendRateLimited(response, wait);
          return;
        }
      } else {
        device = this.authenticate(request);
        if (!device) {
          const wait = this.anonymousLimiter.take(`ip:${remote}`);
          response.setHeader('www-authenticate', 'Bearer realm="Lugn"');
          if (wait > 0) sendRateLimited(response, wait);
          else sendError(response, 401, 'unauthorized');
          return;
        }
        if (route.scope !== 'any' && !device.scopes.includes(route.scope)) {
          sendError(response, 403, 'insufficient_scope');
          return;
        }
        const wait = this.limiters[route.limit].take(`device:${device.id}`);
        if (wait > 0) {
          sendRateLimited(response, wait);
          return;
        }
      }
      await route.handle({ request, response, url, device });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof DeviceRegistryError) {
        sendError(response, error.status, error.code);
        return;
      }
      if (error instanceof DeviceRequestError) {
        sendError(response, error.status, error.code);
        return;
      }
      if (error instanceof ZodError) {
        sendJson(response, 400, {
          error: 'invalid_request',
          issues: safeIssues(error),
        } satisfies ApiError);
        return;
      }
      sendError(response, 500, 'internal_error');
    }
  }

  private authenticate(
    request: IncomingMessage,
  ): AuthenticatedDevice | undefined {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string') return undefined;
    const match = /^Bearer ([^\s]{1,256})$/.exec(authorization);
    if (!match?.[1]) return undefined;
    return this.options.registry.authenticate(match[1]);
  }

  private async pair({ request, response }: RequestContext): Promise<void> {
    const body = await readJsonBody(request, PAIR_MAX_BYTES);
    const remote = request.socket.remoteAddress ?? 'unknown';
    try {
      sendJson(response, 201, await this.options.registry.pair(body));
    } catch (error) {
      // Wrong codes also spend the anonymous per-address budget.
      if (
        error instanceof DeviceRegistryError &&
        error.code === 'invalid_pairing_code'
      )
        this.anonymousLimiter.take(`ip:${remote}`, 2);
      throw error;
    }
  }
}

export class DeviceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function isJsonRequest(request: IncomingMessage): boolean {
  const contentType = request.headers['content-type'];
  return (
    typeof contentType === 'string' &&
    contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  );
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  if (!isJsonRequest(request))
    throw new DeviceRequestError(415, 'content_type_must_be_application_json');
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new DeviceRequestError(413, 'request_too_large');
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes)
      throw new DeviceRequestError(413, 'request_too_large');
    chunks.push(buffer);
  }
  if (byteLength === 0) throw new DeviceRequestError(400, 'empty_request_body');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new DeviceRequestError(400, 'invalid_json');
  }
}

export function safeIssues(
  error: ZodError,
): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 32).map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

export const deviceResponseHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-lugn-api-version': String(DEVICE_API_VERSION),
} as const;

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  if (response.destroyed || response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    ...deviceResponseHeaders,
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function sendError(
  response: ServerResponse,
  statusCode: number,
  error: string,
): void {
  sendJson(response, statusCode, { error } satisfies ApiError);
}

function sendRateLimited(response: ServerResponse, seconds: number): void {
  response.setHeader('retry-after', String(seconds));
  sendJson(response, 429, {
    error: 'rate_limited',
    retryAfterSeconds: seconds,
  } satisfies ApiError);
}
