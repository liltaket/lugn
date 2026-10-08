import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import {
  CapabilityInputError,
  type CapabilityRegistry,
} from '../application/capabilities.js';
import type { LightingScene, RoomState } from '../core/schemas.js';
import {
  MusicRequestSchema,
  SemanticMusicIdSchema,
  type MusicRequest,
} from '../core/schemas.js';
import type { EnvironmentSnapshot } from '../adapters/home-assistant-environment.js';
import type {
  MusicVolumePolicySnapshot,
  MusicPlaybackPolicySnapshot,
} from '../application/music-automation.js';
import type { StateEventStream } from '../core/event-stream.js';

const MAX_REQUEST_BYTES = 8 * 1024;
const DisplaySceneRequestSchema = z
  .object({ sceneId: z.string().min(1).max(128) })
  .strict();
const LightingValuesRequestSchema = z
  .object({
    power: z.boolean().optional(),
    brightness: z.number().int().min(0).max(100).optional(),
    colorTemperature: z.number().int().min(1000).max(10000).optional(),
  })
  .strict();
const DisplayLightRequestSchema = z
  .object({
    target: z.string().min(1).max(160),
    values: LightingValuesRequestSchema,
  })
  .strict();
const DisplayMusicRequestSchema = z
  .object({
    target: SemanticMusicIdSchema,
    request: MusicRequestSchema,
  })
  .strict();
const DisplayMusicPresetRequestSchema = z
  .object({
    target: SemanticMusicIdSchema,
    presetId: z.union([z.literal(1), z.literal(4)]),
  })
  .strict();

export type LugnDisplayHub = {
  id: string;
  role: 'bed' | 'desk';
  castHost: string;
  token: string;
};

export type LugnDisplayCastStatus = {
  state: string;
  message?: string;
};

export type LugnDisplayServerOptions = {
  /** Bind this separate display server only to the intended LAN interface. */
  host: string;
  port: number;
  hubs: readonly LugnDisplayHub[];
  /** Hostnames/IPs accepted in Host and Origin; entries may omit the port. */
  allowedHosts?: readonly string[];
  capabilities: CapabilityRegistry;
  scenes: readonly LightingScene[];
  stateProvider: () => RoomState;
  stateStream?: StateEventStream;
  musicVolumePoliciesProvider?: () => Record<string, MusicVolumePolicySnapshot>;
  musicPlaybackPoliciesProvider?: () => Record<
    string,
    MusicPlaybackPolicySnapshot
  >;
  environmentProvider?: () => EnvironmentSnapshot;
  castStatus?: (hubId: string) => LugnDisplayCastStatus;
};

/** Only the hub resolved from the authenticated secret path supplies provenance. */
function hubProvenance(hub: LugnDisplayHub) {
  return {
    actor: { type: 'user' as const, id: `nest-dashboard:${hub.role}` },
    source: `lugn.cast_dashboard.${hub.role}`,
  };
}

type HubRequest = {
  hub: LugnDisplayHub;
  route: string;
};

type DisplayResourceCategory = 'html' | 'css' | 'js' | 'state';

function displayResourceCategory(
  route: string,
): DisplayResourceCategory | undefined {
  switch (route) {
    case '/':
      return 'html';
    case '/display.css':
      return 'css';
    case '/display.js':
      return 'js';
    case '/display-api/state':
      return 'state';
    default:
      return undefined;
  }
}

/**
 * LAN-only, custom Lugn kiosk surface for DashCast. Each Hub gets a distinct
 * unguessable path credential; this server does not expose Home Assistant UI.
 */
export class LugnDisplayServer {
  private server: Server | undefined;
  private readonly acceptedHosts: ReadonlySet<string>;
  private readonly lastHubPollAt = new Map<string, number>();
  private readonly observedDisplayRequests = new Set<string>();
  private readonly eventStreams = new Map<ServerResponse, string>();
  private nextDeliveryRevision = 0;
  private readonly instanceId = randomUUID();

  constructor(private readonly options: LugnDisplayServerOptions) {
    validateOptions(options);
    this.acceptedHosts = buildAcceptedHosts(options);
    if (this.acceptedHosts.size === 0)
      throw new Error(
        'Display server needs an explicit allowed host when binding a wildcard address',
      );
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        rejectPromise(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolvePromise();
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
    for (const response of this.eventStreams.keys()) response.destroy();
    if (!server?.listening) return;
    const closed = new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) =>
        error ? rejectPromise(error) : resolvePromise(),
      );
    });
    server.closeAllConnections();
    await closed;
  }

  /** Return a path only so callers can construct local display URLs safely. */
  pathForHub(hubId: string): string {
    const hub = this.options.hubs.find((candidate) => candidate.id === hubId);
    if (!hub) throw new Error('Unknown display hub');
    return `/k/${hub.token}/`;
  }

  /** Timestamp of the last state poll from this Hub's configured network IP. */
  lastHubHeartbeatAt(hubId: string): number | undefined {
    return this.lastHubPollAt.get(hubId);
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    setSecurityHeaders(response);
    try {
      const host = this.validatedHost(request);
      if (!host) {
        sendJson(response, 400, { error: 'invalid_host' });
        return;
      }
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.search !== '') {
        sendJson(response, 400, { error: 'query_parameters_not_allowed' });
        return;
      }

      const hubRequest = this.authorizedPath(url.pathname);
      if (!hubRequest) {
        sendJson(response, 404, { error: 'not_found' });
        return;
      }

      if (request.method === 'GET') {
        const category = displayResourceCategory(hubRequest.route);
        if (category) {
          this.logFirstDisplayRequest(
            request,
            response,
            hubRequest.hub.role,
            category,
          );
        }
      }

      if (request.method === 'POST' && !this.validatedOrigin(request, host)) {
        sendJson(response, 403, { error: 'invalid_origin' });
        return;
      }

      if (request.method === 'GET' && hubRequest.route === '/') {
        await this.serveAsset(
          response,
          'display.html',
          'text/html; charset=utf-8',
        );
        return;
      }
      if (request.method === 'GET' && hubRequest.route === '/display.css') {
        await this.serveAsset(
          response,
          'display.css',
          'text/css; charset=utf-8',
        );
        return;
      }
      if (request.method === 'GET' && hubRequest.route === '/display.js') {
        await this.serveAsset(
          response,
          'display.js',
          'text/javascript; charset=utf-8',
        );
        return;
      }
      if (
        request.method === 'GET' &&
        hubRequest.route === '/display-api/events'
      ) {
        if (request.headers.origin && !this.validatedOrigin(request, host)) {
          sendJson(response, 403, { error: 'invalid_origin' });
          return;
        }
        this.startEventStream(request, response, hubRequest.hub);
        return;
      }
      if (
        request.method === 'GET' &&
        hubRequest.route === '/display-api/state'
      ) {
        const sourceAddress = request.socket.remoteAddress ?? 'unknown';
        const matchesHub = matchesConfiguredHubAddress(
          sourceAddress,
          hubRequest.hub.castHost,
        );
        if (matchesHub) {
          this.lastHubPollAt.set(hubRequest.hub.id, Date.now());
        }
        sendJson(response, 200, this.snapshot(hubRequest.hub));
        return;
      }
      if (
        request.method === 'POST' &&
        hubRequest.route === '/display-api/scene'
      ) {
        await this.invokeScene(request, response, hubRequest.hub);
        return;
      }
      if (
        request.method === 'POST' &&
        hubRequest.route === '/display-api/light'
      ) {
        await this.invokeLight(request, response, hubRequest.hub);
        return;
      }
      if (
        request.method === 'POST' &&
        hubRequest.route === '/display-api/music'
      ) {
        await this.invokeMusic(request, response, hubRequest.hub);
        return;
      }
      if (
        request.method === 'POST' &&
        hubRequest.route === '/display-api/music-preset'
      ) {
        await this.invokeMusicPreset(request, response, hubRequest.hub);
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
      if (error instanceof DisplayRequestError) {
        sendJson(response, error.status, { error: error.code });
        return;
      }
      if (error instanceof ZodError) {
        sendJson(response, 400, {
          error: 'invalid_request',
          issues: safeIssues(error),
        });
        return;
      }
      sendJson(response, 500, { error: 'internal_error' });
    }
  }

  private snapshot(hub: LugnDisplayHub) {
    return {
      state: this.options.stateProvider(),
      deliveryRevision: ++this.nextDeliveryRevision,
      instanceId: this.instanceId,
      generatedAt: Date.now(),
      musicVolumePolicies: this.options.musicVolumePoliciesProvider?.() ?? {},
      musicPlaybackPolicies:
        this.options.musicPlaybackPoliciesProvider?.() ?? {},
      scenes: this.options.scenes,
      role: hub.role,
      castStatus: this.options.castStatus?.(hub.id) ?? { state: 'unknown' },
      environment:
        this.options.environmentProvider?.() ?? emptyEnvironmentSnapshot(),
    };
  }

  private startEventStream(
    request: IncomingMessage,
    response: ServerResponse,
    hub: LugnDisplayHub,
  ): void {
    const stream = this.options.stateStream;
    if (
      !stream ||
      [...this.eventStreams.values()].filter((id) => id === hub.id).length >= 2
    ) {
      sendJson(response, 503, { error: 'stream_unavailable' });
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.eventStreams.set(response, hub.id);
    const send = (): void => {
      if (response.destroyed) return;
      // A slow kiosk reconnects to a fresh snapshot instead of buffering history.
      if (response.writableNeedDrain) {
        response.destroy();
        return;
      }
      if (
        matchesConfiguredHubAddress(
          request.socket.remoteAddress ?? '',
          hub.castHost,
        )
      )
        this.lastHubPollAt.set(hub.id, Date.now());
      try {
        const payload = this.snapshot(hub);
        response.write(
          `id: ${payload.state.revision}\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      } catch {
        response.destroy();
      }
    };
    let pendingUpdate: NodeJS.Immediate | undefined;
    const unsubscribe = stream.subscribe(() => {
      if (pendingUpdate) return;
      pendingUpdate = setImmediate(() => {
        pendingUpdate = undefined;
        send();
      });
    });
    const heartbeat = setInterval(send, 5_000);
    response.once('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
      if (pendingUpdate) clearImmediate(pendingUpdate);
      this.eventStreams.delete(response);
    });
    // Reconnect always sends current truth, including after a revision history gap.
    send();
  }

  private logFirstDisplayRequest(
    request: IncomingMessage,
    response: ServerResponse,
    role: LugnDisplayHub['role'],
    category: DisplayResourceCategory,
  ): void {
    const sourceAddress = request.socket.remoteAddress ?? 'unknown';
    const sourceKey = `${role}\u0000${sourceAddress}\u0000${category}`;
    if (this.observedDisplayRequests.has(sourceKey)) return;
    this.observedDisplayRequests.add(sourceKey);
    response.once('finish', () => {
      console.info(
        `[lugn] display GET role=${role} source=${sourceAddress} resource=${category} status=${response.statusCode}`,
      );
    });
  }

  private async serveAsset(
    response: ServerResponse,
    filename: 'display.html' | 'display.css' | 'display.js',
    contentType: string,
  ): Promise<void> {
    const file = findUiAsset(filename);
    if (!file) {
      sendJson(response, 503, { error: 'display_assets_unavailable' });
      return;
    }
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      sendJson(response, 503, { error: 'display_assets_unavailable' });
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': body.byteLength,
      'content-type': contentType,
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
  }

  private async invokeScene(
    request: IncomingMessage,
    response: ServerResponse,
    hub: LugnDisplayHub,
  ): Promise<void> {
    if (!isJsonRequest(request)) {
      sendJson(response, 415, {
        error: 'content_type_must_be_application_json',
      });
      return;
    }
    const input = DisplaySceneRequestSchema.parse(await readJsonBody(request));
    await this.invokeLightingCapability(
      'lighting.activateScene',
      input,
      response,
      hub,
    );
  }

  private async invokeLight(
    request: IncomingMessage,
    response: ServerResponse,
    hub: LugnDisplayHub,
  ): Promise<void> {
    if (!isJsonRequest(request)) {
      sendJson(response, 415, {
        error: 'content_type_must_be_application_json',
      });
      return;
    }
    const input = DisplayLightRequestSchema.parse(await readJsonBody(request));
    await this.invokeLightingCapability('lighting.set', input, response, hub);
  }

  private async invokeMusic(
    request: IncomingMessage,
    response: ServerResponse,
    hub: LugnDisplayHub,
  ): Promise<void> {
    if (!isJsonRequest(request)) {
      sendJson(response, 415, {
        error: 'content_type_must_be_application_json',
      });
      return;
    }
    const input = DisplayMusicRequestSchema.parse(await readJsonBody(request));
    const capability = musicCapability(input.target, input.request);
    try {
      const result = await this.options.capabilities.invoke(
        capability.name,
        capability.input,
        hubProvenance(hub),
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

  private async invokeMusicPreset(
    request: IncomingMessage,
    response: ServerResponse,
    hub: LugnDisplayHub,
  ): Promise<void> {
    if (!isJsonRequest(request)) {
      sendJson(response, 415, {
        error: 'content_type_must_be_application_json',
      });
      return;
    }
    const input = DisplayMusicPresetRequestSchema.parse(
      await readJsonBody(request),
    );
    try {
      const result = await this.options.capabilities.invoke(
        'music.playPreset',
        {
          target: input.target,
          preset: input.presetId === 1 ? 'spotify_dj' : 'optical',
        },
        hubProvenance(hub),
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

  private async invokeLightingCapability(
    name: 'lighting.activateScene' | 'lighting.set',
    input: unknown,
    response: ServerResponse,
    hub: LugnDisplayHub,
  ): Promise<void> {
    try {
      const result = await this.options.capabilities.invoke(
        name,
        input,
        hubProvenance(hub),
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

  private authorizedPath(pathname: string): HubRequest | undefined {
    const match = /^\/k\/([A-Za-z0-9_-]{32,128})(\/.*)?$/.exec(pathname);
    const supplied = match?.[1];
    if (!supplied) return undefined;

    let authorizedHub: LugnDisplayHub | undefined;
    for (const hub of this.options.hubs) {
      if (secretsEqual(supplied, hub.token)) authorizedHub = hub;
    }
    if (!authorizedHub) return undefined;
    return { hub: authorizedHub, route: match?.[2] ?? '/' };
  }

  private validatedHost(request: IncomingMessage): string | undefined {
    const rawHost = request.headers.host;
    if (typeof rawHost !== 'string') return undefined;
    const normalized = normalizeHostHeader(rawHost);
    return normalized && this.acceptedHosts.has(normalized)
      ? normalized
      : undefined;
  }

  private validatedOrigin(
    request: IncomingMessage,
    normalizedHost: string,
  ): boolean {
    const origin = request.headers.origin;
    if (typeof origin !== 'string') return false;
    try {
      const parsed = new URL(origin);
      return (
        parsed.protocol === 'http:' &&
        parsed.origin === `http://${normalizedHost}` &&
        parsed.pathname === '/' &&
        parsed.search === '' &&
        parsed.hash === ''
      );
    } catch {
      return false;
    }
  }
}

function musicCapability(
  target: string,
  request: MusicRequest,
): {
  name:
    | 'music.play'
    | 'music.pause'
    | 'music.setVolume'
    | 'music.selectSource'
    | 'music.playPreset';
  input: unknown;
} {
  switch (request.property) {
    case 'playback':
      return {
        name: request.value === 'playing' ? 'music.play' : 'music.pause',
        input: { target },
      };
    case 'volume':
      return {
        name: 'music.setVolume',
        input: { target, volume: request.value },
      };
    case 'source':
      return {
        name: 'music.selectSource',
        input: { target, source: request.value },
      };
    case 'preset':
      return {
        name: 'music.playPreset',
        input: { target, preset: request.value },
      };
  }
}

function emptyEnvironmentSnapshot(): EnvironmentSnapshot {
  return {
    temperature: { value: null, unit: '°C', observedAt: null },
    humidity: { value: null, unit: '%', observedAt: null },
    co2: { value: null, unit: 'ppm', observedAt: null },
    pm25: { value: null, unit: 'µg/m³', observedAt: null },
  };
}

function matchesConfiguredHubAddress(
  remoteAddress: string | undefined,
  configuredAddress: string,
): boolean {
  if (!remoteAddress) return false;
  return (
    normalizeClientAddress(remoteAddress) === configuredAddress.toLowerCase()
  );
}

function normalizeClientAddress(address: string): string {
  return address.replace(/^::ffff:/i, '').toLowerCase();
}

class DisplayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function validateOptions(options: LugnDisplayServerOptions): void {
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  )
    throw new Error('Display server port must be between 1 and 65535');
  if (options.host.length === 0)
    throw new Error('Display server bind host is required');
  if (options.hubs.length === 0)
    throw new Error('Display server requires at least one Hub');
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const hub of options.hubs) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(hub.id))
      throw new Error('Invalid display Hub id');
    if (ids.has(hub.id)) throw new Error('Duplicate display Hub id');
    ids.add(hub.id);
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(hub.token))
      throw new Error(
        'Display Hub token must be a URL-safe secret of at least 32 characters',
      );
    if (tokens.has(hub.token)) throw new Error('Duplicate display Hub token');
    tokens.add(hub.token);
  }
}

function buildAcceptedHosts(options: LugnDisplayServerOptions): Set<string> {
  const accepted = new Set<string>();
  const configured = [
    ...(isWildcardHost(options.host) ? [] : [options.host]),
    ...(options.allowedHosts ?? []),
  ];
  for (const candidate of configured) {
    const normalized = normalizeAllowedHost(candidate, options.port);
    if (normalized) accepted.add(normalized);
  }
  return accepted;
}

function normalizeAllowedHost(value: string, port: number): string | undefined {
  try {
    if (
      value.length === 0 ||
      value.trim() !== value ||
      value.includes('/') ||
      value.includes('@')
    )
      return undefined;
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      isWildcardHost(parsed.hostname)
    )
      return undefined;
    if (parsed.port && Number(parsed.port) !== port) return undefined;
    return parsed.port
      ? parsed.host.toLowerCase()
      : `${parsed.host.toLowerCase()}:${port}`;
  } catch {
    return undefined;
  }
}

function normalizeHostHeader(value: string): string | undefined {
  try {
    if (
      value.length === 0 ||
      value.trim() !== value ||
      value.includes('/') ||
      value.includes('@')
    )
      return undefined;
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    )
      return undefined;
    return parsed.host.toLowerCase();
  } catch {
    return undefined;
  }
}

function isWildcardHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === '0.0.0.0' || normalized === '::' || normalized === '::0'
  );
}

function secretsEqual(supplied: string, configured: string): boolean {
  const providedBytes = Buffer.from(supplied, 'utf8');
  const configuredBytes = Buffer.from(configured, 'utf8');
  return (
    providedBytes.byteLength === configuredBytes.byteLength &&
    timingSafeEqual(providedBytes, configuredBytes)
  );
}

function findUiAsset(
  filename: 'display.html' | 'display.css' | 'display.js',
): string | undefined {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidateDirectories = [
    resolve(moduleDirectory, '../ui'),
    resolve(moduleDirectory, '../../src/ui'),
    resolve(process.cwd(), 'src/ui'),
  ];
  for (const directory of candidateDirectories) {
    const candidate = resolve(directory, filename);
    if (
      existsSync(candidate) &&
      existsSync(resolve(directory, 'display.html')) &&
      existsSync(resolve(directory, 'display.css')) &&
      existsSync(resolve(directory, 'display.js'))
    )
      return candidate;
  }
  return undefined;
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
      throw new DisplayRequestError(413, 'request_too_large');
    chunks.push(buffer);
  }
  if (byteLength === 0)
    throw new DisplayRequestError(400, 'empty_request_body');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new DisplayRequestError(400, 'invalid_json');
  }
}

function safeIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader(
    'content-security-policy',
    [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      'frame-ancestors https://www.gstatic.com',
      "img-src 'self' data:",
      "connect-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "object-src 'none'",
    ].join('; '),
  );
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
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
