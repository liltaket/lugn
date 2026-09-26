import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { z, ZodError } from 'zod';
import {
  CapabilityInputError,
  CapabilitySchemas,
} from '../application/capabilities.js';
import type {
  CapabilityName,
  CapabilityRegistry,
} from '../application/capabilities.js';
import type { LugnEngine } from '../application/lugn-engine.js';

const MAX_REQUEST_BYTES = 64 * 1024;
const CapabilityRequestSchema = z
  .object({
    input: z.unknown().optional(),
    requestId: z.string().min(1).max(128).optional(),
    reason: z.string().min(1).max(256).optional(),
  })
  .strict();

export type LugnHttpServerOptions = {
  host: string;
  port: number;
  bearerToken?: string;
  engine: LugnEngine;
  capabilities: CapabilityRegistry;
  integrations: () => Record<string, string>;
};

/** Local HTTP surface for health, state inspection, and typed capabilities. */
export class LugnHttpServer {
  private server: Server | undefined;

  constructor(private readonly options: LugnHttpServerOptions) {
    if (!isLoopbackBindHost(options.host))
      throw new Error('Lugn HTTP server only listens on loopback');
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
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
      if (!this.authorized(request)) {
        response.setHeader('www-authenticate', 'Bearer realm="Lugn"');
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }

      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        const integrations = this.options.integrations();
        const connected = Object.values(integrations).every(
          (status) => status === 'connected' || status === 'not_configured',
        );
        sendJson(response, 200, {
          status: connected ? 'ok' : 'degraded',
          integrations,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/state') {
        sendJson(response, 200, this.options.engine.state);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/capabilities') {
        sendJson(response, 200, {
          capabilities: Object.keys(CapabilitySchemas),
        });
        return;
      }

      const capabilityMatch = /^\/capabilities\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'POST' && capabilityMatch) {
        await this.invokeCapability(
          decodeURIComponent(capabilityMatch[1] ?? ''),
          request,
          response,
        );
        return;
      }

      if (request.method !== 'GET' && request.method !== 'POST') {
        response.setHeader('allow', 'GET, POST');
        sendJson(response, 405, { error: 'method_not_allowed' });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof HttpRequestError) {
        sendJson(response, error.status, { error: error.code });
        return;
      }
      if (error instanceof URIError) {
        sendJson(response, 400, { error: 'invalid_path' });
        return;
      }
      sendJson(response, 500, { error: 'internal_error' });
    }
  }

  private async invokeCapability(
    name: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!Object.hasOwn(CapabilitySchemas, name)) {
      sendJson(response, 404, { error: 'unknown_capability' });
      return;
    }
    if (!isJsonRequest(request)) {
      sendJson(response, 415, {
        error: 'content_type_must_be_application_json',
      });
      return;
    }

    const rawBody = await readJsonBody(request);
    const parsed = CapabilityRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      sendJson(response, 400, {
        error: 'invalid_request',
        issues: safeIssues(parsed.error),
      });
      return;
    }

    try {
      const capabilityName = name as CapabilityName;
      const input = Object.hasOwn(parsed.data, 'input')
        ? parsed.data.input
        : {};
      const result = await this.options.capabilities.invoke(
        capabilityName,
        input,
        {
          actor: { type: 'user', id: 'http' },
          source: 'lugn.http',
          ...(parsed.data.requestId === undefined
            ? {}
            : { requestId: parsed.data.requestId }),
          ...(parsed.data.reason === undefined
            ? {}
            : { reason: parsed.data.reason }),
        },
      );
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof ZodError) {
        sendJson(response, 400, {
          error: 'invalid_capability_input',
          issues: safeIssues(error),
        });
        return;
      }
      if (error instanceof CapabilityInputError) {
        sendJson(response, 400, { error: error.code });
        return;
      }
      sendJson(response, 502, { error: 'capability_failed' });
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const configuredToken = this.options.bearerToken;
    if (!configuredToken) return true;
    const authorization = request.headers['authorization'];
    if (typeof authorization !== 'string') return false;
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match?.[1]) return false;
    const provided = Buffer.from(match[1]);
    const expected = Buffer.from(configuredToken);
    return (
      provided.length === expected.length && timingSafeEqual(provided, expected)
    );
  }
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function isJsonRequest(request: IncomingMessage): boolean {
  const contentType = request.headers['content-type'];
  return (
    typeof contentType === 'string' &&
    contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_REQUEST_BYTES)
      throw new HttpRequestError(413, 'request_too_large');
    chunks.push(buffer);
  }
  if (byteLength === 0) throw new HttpRequestError(400, 'empty_request_body');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpRequestError(400, 'invalid_json');
  }
}

function safeIssues(error: ZodError): Array<{
  path: string;
  message: string;
}> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  if (response.destroyed || response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}
