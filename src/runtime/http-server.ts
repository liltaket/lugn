import type { CameraDashboardService } from '../application/camera-dashboard.js';
import { CameraError, type CameraDashboardSnapshot } from '../core/cameras.js';
import type { CameraMediaProvider } from './camera-media.js';
import {
  MusicVolumeSettingsSchema,
  defaultMusicVolumeSettings,
  calculateMusicVolume,
  type MusicVolumeSettings,
} from '../core/music-volume-settings.js';
import {
  type MusicVolumeSettingsStore,
  MusicVolumeSettingsError,
} from './music-volume-settings-store.js';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';
import { z, ZodError } from 'zod';
import type { LightingScene } from '../core/schemas.js';
import {
  ScenePresetError,
  ScenePresetInputSchema,
  ScenePresetUpdateSchema,
  ScenePresetDeleteSchema,
} from './scene-preset-store.js';
import type { ScenePresetStore } from './scene-preset-store.js';
import { lightingFeedbackBrowserScript } from './lighting-feedback-script.js';
import {
  CapabilityInputError,
  CapabilitySchemas,
} from '../application/capabilities.js';
import type {
  CapabilityName,
  CapabilityRegistry,
} from '../application/capabilities.js';
import type { LugnEngine } from '../application/lugn-engine.js';
import type { ArtworkMap, ArtworkProvider } from '../core/artwork.js';
import {
  ExperienceRequestError,
  experienceRoutes,
  type ExperienceApi,
} from '../application/experience-api.js';
import {
  clerkFrontendApiOrigin,
  verifyClerkSessionToken,
} from './clerk-auth.js';

const MAX_REQUEST_BYTES = 64 * 1024;
const UI_SESSION_COOKIE = 'lugn_ui_session';
const UI_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const MAX_UI_SESSIONS = 64;
const MAX_UI_EVENT_STREAMS = 16;
const UiTokenSessionSchema = z.object({ token: z.string().max(4096) }).strict();
const UiClerkSessionSchema = z
  .object({ sessionToken: z.string().min(1).max(8192) })
  .strict();
const UiCapabilityRequestSchema = z
  .object({ input: z.unknown().optional() })
  .strict();
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
  experience?: ExperienceApi;
  cameraService?: CameraDashboardService;
  cameraMedia?: CameraMediaProvider;
  artworkProvider?: ArtworkProvider;
  integrations: () => Record<string, string>;
  /** Trust in each player's observations, independent of subscription health. */
  musicObservationTrustProvider?: () => Record<string, boolean>;
  scenePresetStore?: ScenePresetStore;
  volumeSettingsStore?: MusicVolumeSettingsStore;
  webAssetsDirectory?: string;
  trustedOrigins?: string[];
  clerk?: {
    publishableKey: string;
    secretKey: string;
    allowedUserIds: string[];
    allowAnyUser: boolean;
  };
};

/** Local HTTP surface for health, state inspection, and typed capabilities. */
export class LugnHttpServer {
  private server: Server | undefined;
  private readonly instanceId = randomUUID();
  private nextDeliveryRevision = 0;
  private readonly uiSessions = new Map<
    string,
    { csrfToken: string; expiresAt: number; clerkSessionId?: string }
  >();
  private readonly uiEventStreams = new Map<ServerResponse, string>();

  constructor(private readonly options: LugnHttpServerOptions) {
    if (!isLoopbackBindHost(options.host))
      throw new Error('Lugn HTTP server only listens on loopback');
    if (options.clerk && !options.bearerToken?.trim())
      throw new Error(
        'Clerk UI authentication requires a bearer token for machine API routes',
      );
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
    this.uiSessions.clear();
    for (const response of this.uiEventStreams.keys()) response.destroy();
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
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!this.isTrustedRequest(request)) {
        sendJson(response, 403, { error: 'untrusted_host_or_origin' });
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/ui/')) {
        if (this.serveUiAsset(url.pathname, response)) return;
      }
      if (url.pathname.startsWith('/ui/api/')) {
        if (await this.handleUiApi(request, response, url.pathname)) return;
      }
      if (!this.authorized(request)) {
        response.setHeader('www-authenticate', 'Bearer realm="Lugn"');
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }

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
      if (error instanceof CameraError) {
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

  private serveUiAsset(pathname: string, response: ServerResponse): boolean {
    const assets: Record<string, { name: string; contentType: string }> = {
      '/ui/': { name: 'index.html', contentType: 'text/html; charset=utf-8' },
      '/ui/index.html': {
        name: 'index.html',
        contentType: 'text/html; charset=utf-8',
      },
      '/ui/app.js': {
        name: 'app.js',
        contentType: 'text/javascript; charset=utf-8',
      },
      '/ui/styles.css': {
        name: 'styles.css',
        contentType: 'text/css; charset=utf-8',
      },
    };
    const asset = assets[pathname];
    if (!asset) return false;
    try {
      let content = readFileSync(
        join(
          this.options.webAssetsDirectory ?? join(process.cwd(), 'web'),
          asset.name,
        ),
      );
      if (asset.name === 'app.js')
        content = Buffer.concat([
          Buffer.from(lightingFeedbackBrowserScript),
          content,
        ]);
      response.writeHead(200, {
        'content-type': asset.contentType,
        'cache-control': 'no-cache',
        'content-security-policy': this.uiContentSecurityPolicy(),
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      response.end(content);
    } catch {
      sendJson(response, 503, { error: 'ui_unavailable' });
    }
    return true;
  }

  private async handleUiApi(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (request.method === 'GET' && pathname === '/ui/api/auth-config') {
      if (this.options.clerk) {
        sendJson(response, 200, {
          provider: 'clerk',
          publishableKey: this.options.clerk.publishableKey,
        });
      } else {
        sendJson(response, 200, { provider: 'token' });
      }
      return true;
    }
    if (request.method === 'GET' && pathname === '/ui/api/session') {
      const session = this.getUiSession(request);
      sendJson(response, 200, {
        provider: this.options.clerk ? 'clerk' : 'token',
        tokenRequired:
          this.options.clerk === undefined &&
          this.options.bearerToken !== undefined,
        authenticated: session !== undefined,
        ...(session === undefined
          ? {}
          : {
              csrfToken: session.csrfToken,
              expiresAt: session.expiresAt,
            }),
      });
      return true;
    }
    if (request.method === 'POST' && pathname === '/ui/api/session') {
      if (!this.isSameOrigin(request)) {
        sendJson(response, 403, { error: 'same_origin_required' });
        return true;
      }
      if (!isJsonRequest(request)) {
        sendJson(response, 415, {
          error: 'content_type_must_be_application_json',
        });
        return true;
      }
      const rawBody = await readJsonBody(request);
      let clerkSession: { sid: string; exp: number } | undefined;
      if (this.options.clerk) {
        const parsed = UiClerkSessionSchema.safeParse(rawBody);
        const originHeader = request.headers.origin;
        if (!parsed.success || typeof originHeader !== 'string') {
          sendJson(response, 400, { error: 'invalid_request' });
          return true;
        }
        let authorizedParty: string;
        try {
          authorizedParty = new URL(originHeader).origin;
        } catch {
          sendJson(response, 403, { error: 'same_origin_required' });
          return true;
        }
        const result = await verifyClerkSessionToken(parsed.data.sessionToken, {
          secretKey: this.options.clerk.secretKey,
          allowedUserIds: this.options.clerk.allowedUserIds,
          allowAnyUser: this.options.clerk.allowAnyUser,
          authorizedParty,
        });
        if (result.status === 'invalid') {
          sendJson(response, 401, { error: 'unauthorized' });
          return true;
        }
        if (result.status === 'forbidden') {
          sendJson(response, 403, { error: 'forbidden' });
          return true;
        }
        clerkSession = { sid: result.sid, exp: result.exp };
      } else {
        const parsed = UiTokenSessionSchema.safeParse(rawBody);
        if (!parsed.success) {
          sendJson(response, 400, { error: 'invalid_request' });
          return true;
        }
        if (
          this.options.bearerToken !== undefined &&
          !this.constantTimeEqual(parsed.data.token, this.options.bearerToken)
        ) {
          sendJson(response, 401, { error: 'unauthorized' });
          return true;
        }
      }
      this.pruneUiSessions();
      const now = Date.now();
      const expiresAt = Math.min(
        now + UI_SESSION_MAX_AGE_MS,
        clerkSession === undefined
          ? Number.POSITIVE_INFINITY
          : clerkSession.exp * 1000,
      );
      const cookieMaxAgeSeconds = Math.floor((expiresAt - now) / 1000);
      if (expiresAt <= now || cookieMaxAgeSeconds < 1) {
        sendJson(response, 401, { error: 'unauthorized' });
        return true;
      }
      const previousSessionId = this.getUiSessionId(request);
      if (previousSessionId) {
        const previousSession = this.uiSessions.get(previousSessionId);
        if (
          clerkSession !== undefined &&
          previousSession?.clerkSessionId === clerkSession.sid
        ) {
          previousSession.expiresAt = expiresAt;
          const secure = this.requestIsHttps(request) ? '; Secure' : '';
          response.setHeader(
            'set-cookie',
            `${UI_SESSION_COOKIE}=${previousSessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cookieMaxAgeSeconds}${secure}`,
          );
          sendJson(response, 200, {
            csrfToken: previousSession.csrfToken,
            expiresAt,
          });
          return true;
        }
        this.uiSessions.delete(previousSessionId);
        this.closeUiEventStreams(previousSessionId);
      }
      if (this.uiSessions.size >= MAX_UI_SESSIONS) {
        sendJson(response, 503, { error: 'too_many_sessions' });
        return true;
      }
      const sessionId = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      this.uiSessions.set(sessionId, {
        csrfToken,
        expiresAt,
        ...(clerkSession === undefined
          ? {}
          : { clerkSessionId: clerkSession.sid }),
      });
      const secure = this.requestIsHttps(request) ? '; Secure' : '';
      response.setHeader(
        'set-cookie',
        `${UI_SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cookieMaxAgeSeconds}${secure}`,
      );
      sendJson(response, 200, { csrfToken, expiresAt });
      return true;
    }
    if (request.method === 'DELETE' && pathname === '/ui/api/session') {
      if (!this.isSameOrigin(request)) {
        sendJson(response, 403, { error: 'same_origin_required' });
        return true;
      }
      const sessionId = this.getUiSessionId(request);
      if (sessionId) {
        this.uiSessions.delete(sessionId);
        this.closeUiEventStreams(sessionId);
      }
      response.setHeader(
        'set-cookie',
        `${UI_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.requestIsHttps(request) ? '; Secure' : ''}`,
      );
      response.writeHead(204);
      response.end();
      return true;
    }

    const session = this.getUiSession(request);
    if (!session) {
      sendJson(response, 401, { error: 'unauthorized' });
      return true;
    }
    const cameraImage =
      /^\/ui\/api\/cameras\/([A-Za-z0-9_-]{16,80})\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})\/image$/.exec(
        pathname,
      );
    if (request.method === 'GET' && cameraImage) {
      if (
        (request.headers.origin && !this.isSameOrigin(request)) ||
        request.headers['sec-fetch-site'] === 'cross-site'
      ) {
        sendJson(response, 403, { error: 'same_origin_required' });
        return true;
      }
      if (!this.options.cameraMedia)
        throw new CameraError(404, 'camera_view_unavailable');
      const image = await this.options.cameraMedia.read(
        'web',
        cameraImage[1]!,
        cameraImage[2]!,
      );
      if (this.getUiSession(request)?.csrfToken !== session.csrfToken)
        throw new CameraError(401, 'unauthorized');
      response.writeHead(200, {
        'content-type': image.contentType,
        'content-length': image.body.byteLength,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      response.end(image.body);
      return true;
    }
    if (
      (request.method === 'POST' && pathname === '/ui/api/cameras/action') ||
      (request.method === 'PUT' && pathname === '/ui/api/cameras/settings')
    ) {
      if (!this.isSameOrigin(request)) {
        sendJson(response, 403, { error: 'same_origin_required' });
        return true;
      }
      const csrf = request.headers['x-lugn-csrf'];
      if (
        typeof csrf !== 'string' ||
        !this.constantTimeEqual(csrf, session.csrfToken)
      ) {
        sendJson(response, 403, { error: 'csrf_failed' });
        return true;
      }
      if (!isJsonRequest(request)) {
        sendJson(response, 415, {
          error: 'content_type_must_be_application_json',
        });
        return true;
      }
      const service = this.options.cameraService;
      if (!service || !this.options.cameraMedia)
        throw new CameraError(503, 'cameras_unavailable');
      const input = await readJsonBody(request);
      if (this.getUiSession(request)?.csrfToken !== session.csrfToken)
        throw new CameraError(401, 'unauthorized');
      if (request.method === 'PUT') {
        const body = z
          .object({ generation: z.uuid(), settings: z.unknown() })
          .strict()
          .parse(input);
        await service.updateSettings(body.settings, body.generation);
      } else {
        const body = z
          .discriminatedUnion('action', [
            z
              .object({
                action: z.literal('show'),
                cameraId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
              })
              .strict(),
            z.object({ action: z.literal('hide') }).strict(),
          ])
          .parse(input);
        if (body.action === 'show') service.show('web', body.cameraId);
        else service.dismiss('web');
      }
      sendJson(response, 200, {
        cameraDashboard: this.options.cameraMedia.snapshot(
          'web',
          '/ui/api/cameras/',
        ),
      });
      return true;
    }
    if (request.method === 'GET' && pathname === '/ui/api/overview') {
      sendJson(response, 200, this.uiOverview());
      return true;
    }
    const artworkMatch = /^\/ui\/api\/artwork\/([A-Za-z0-9_-]{32})$/.exec(
      pathname,
    );
    if (request.method === 'GET' && artworkMatch) {
      const asset = await this.options.artworkProvider?.read(
        artworkMatch[1]!,
        this.options.engine.state,
      );
      if (!asset) {
        sendJson(response, 404, { error: 'artwork_unavailable' });
        return true;
      }
      response.writeHead(200, {
        'content-type': asset.contentType,
        'content-length': asset.body.byteLength,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      response.end(asset.body);
      return true;
    }
    if (request.method === 'GET' && pathname === '/ui/api/routines') {
      const routines = this.options.experience?.snapshot().routines;
      sendJson(
        response,
        routines === undefined ? 503 : 200,
        routines ?? { error: 'routines_unavailable' },
      );
      return true;
    }
    const experienceRoute = experienceRoutes.find(
      (route) => pathname === `/ui/api/${route}`,
    );
    if (request.method === 'POST' && experienceRoute) {
      if (!this.isSameOrigin(request)) {
        sendJson(response, 403, { error: 'same_origin_required' });
        return true;
      }
      const csrf = request.headers['x-lugn-csrf'];
      if (
        typeof csrf !== 'string' ||
        !this.constantTimeEqual(csrf, session.csrfToken)
      ) {
        sendJson(response, 403, { error: 'csrf_failed' });
        return true;
      }
      if (!isJsonRequest(request)) {
        sendJson(response, 415, {
          error: 'content_type_must_be_application_json',
        });
        return true;
      }
      if (!this.options.experience) {
        sendJson(response, 503, { error: 'experience_unavailable' });
        return true;
      }
      const body = await readJsonBody(request);
      if (this.getUiSession(request)?.csrfToken !== session.csrfToken) {
        sendJson(response, 401, { error: 'unauthorized' });
        return true;
      }
      try {
        const result = await this.options.experience.request(
          experienceRoute,
          body,
          {
            actor: { type: 'user', id: 'ui' },
            source: 'lugn.ui',
          },
        );
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof ExperienceRequestError)
          sendJson(response, error.status, { error: error.code });
        else if (error instanceof ZodError)
          sendJson(response, 400, {
            error: 'invalid_request',
            issues: safeIssues(error),
          });
        else sendJson(response, 502, { error: 'experience_request_failed' });
      }
      return true;
    }
    if (request.method === 'GET' && pathname === '/ui/api/events') {
      const sessionId = this.getUiSessionId(request);
      if (!sessionId) {
        sendJson(response, 401, { error: 'unauthorized' });
        return true;
      }
      this.startUiEventStream(response, sessionId, session.expiresAt);
      return true;
    }
    if (
      request.method === 'POST' &&
      (pathname === '/ui/api/music-settings' ||
        pathname === '/ui/api/music-settings/preview')
    ) {
      if (!this.isSameOrigin(request)) {
        sendJson(response, 403, { error: 'same_origin_required' });
        return true;
      }
      const csrf = request.headers['x-lugn-csrf'];
      if (
        typeof csrf !== 'string' ||
        !this.constantTimeEqual(csrf, session.csrfToken)
      ) {
        sendJson(response, 403, { error: 'csrf_failed' });
        return true;
      }
      if (!isJsonRequest(request)) {
        sendJson(response, 415, {
          error: 'content_type_must_be_application_json',
        });
        return true;
      }
      const preview = pathname.endsWith('/preview');
      const schema = preview
        ? z
            .object({
              settings: MusicVolumeSettingsSchema,
              target: z.string(),
              minute: z.number().int().min(0).max(1440),
              personCount: z.number().int().min(0).max(100),
            })
            .strict()
        : z
            .object({
              settings: MusicVolumeSettingsSchema,
              expectedSettings: MusicVolumeSettingsSchema,
            })
            .strict();
      const parsed = schema.safeParse(await readJsonBody(request));
      if (!parsed.success) {
        sendJson(response, 400, {
          error: 'invalid_request',
          issues: safeIssues(parsed.error),
        });
        return true;
      }
      if (this.getUiSession(request)?.csrfToken !== session.csrfToken) {
        sendJson(response, 401, { error: 'unauthorized' });
        return true;
      }
      if ('target' in parsed.data) {
        const { target, settings, minute, personCount } = parsed.data;
        if (!Object.hasOwn(this.options.engine.state.music.devices, target)) {
          sendJson(response, 400, { error: 'target_not_configured' });
          return true;
        }
        const policy =
          this.options.engine.getMusicPolicySnapshot(target).volume;
        sendJson(response, 200, {
          ...calculateMusicVolume(
            settings,
            settings.autoBaseVolumes[target] ?? 0.3,
            minute,
            personCount,
          ),
          activeOwner: policy.activeOwner,
          baselineSource: policy.baselineSource,
          observedVolume:
            this.options.engine.getMusicState(target).observed.volume,
          enabled: settings.enabled,
        });
      } else {
        if (!this.options.volumeSettingsStore) {
          sendJson(response, 503, { error: 'volume_settings_unavailable' });
          return true;
        }
        try {
          const settings = await this.options.volumeSettingsStore.save(
            this.options.engine,
            parsed.data.settings,
            parsed.data.expectedSettings,
          );
          sendJson(response, 200, { settings });
        } catch (error) {
          if (error instanceof MusicVolumeSettingsError)
            sendJson(response, error.status, { error: error.code });
          else throw error;
        }
      }
      return true;
    }
    const sceneMatch = /^\/ui\/api\/scenes(?:\/([^/]+))?$/.exec(pathname);
    if (
      sceneMatch &&
      (request.method === 'POST' || request.method === 'DELETE')
    ) {
      if (!this.isSameOrigin(request)) {
        sendJson(response, 403, { error: 'same_origin_required' });
        return true;
      }
      const csrfHeader = request.headers['x-lugn-csrf'];
      if (
        typeof csrfHeader !== 'string' ||
        !this.constantTimeEqual(csrfHeader, session.csrfToken)
      ) {
        sendJson(response, 403, { error: 'csrf_failed' });
        return true;
      }
      if (!isJsonRequest(request)) {
        sendJson(response, 415, {
          error: 'content_type_must_be_application_json',
        });
        return true;
      }
      const store = this.options.scenePresetStore;
      if (!store) {
        sendJson(response, 503, { error: 'scene_presets_unavailable' });
        return true;
      }
      const id =
        sceneMatch[1] === undefined
          ? undefined
          : decodeURIComponent(sceneMatch[1]);
      const schema =
        request.method === 'DELETE'
          ? ScenePresetDeleteSchema
          : id === undefined
            ? ScenePresetInputSchema
            : ScenePresetUpdateSchema;
      const parsed = schema.safeParse(await readJsonBody(request));
      if (!parsed.success) {
        sendJson(response, 400, {
          error: 'invalid_request',
          issues: safeIssues(parsed.error),
        });
        return true;
      }
      const currentSession = this.getUiSession(request);
      if (!currentSession || currentSession.csrfToken !== session.csrfToken) {
        sendJson(response, 401, { error: 'unauthorized' });
        return true;
      }
      try {
        if (request.method === 'DELETE') {
          if (id === undefined) {
            sendJson(response, 404, { error: 'not_found' });
            return true;
          }
          const input = ScenePresetDeleteSchema.parse(parsed.data);
          await store.delete(this.options.engine, id, input.expectedScene);
          sendJson(response, 200, { deleted: id });
        } else if (id === undefined) {
          const scene = await store.create(
            this.options.engine,
            ScenePresetInputSchema.parse(parsed.data),
          );
          sendJson(response, 201, { scene: this.uiScene(scene) });
        } else {
          const scene = await store.update(
            this.options.engine,
            id,
            ScenePresetUpdateSchema.parse(parsed.data),
          );
          sendJson(response, 200, { scene: this.uiScene(scene) });
        }
      } catch (error) {
        if (error instanceof ScenePresetError)
          sendJson(response, error.status, { error: error.code });
        else throw error;
      }
      return true;
    }
    const capabilityMatch = /^\/ui\/api\/capabilities\/([^/]+)$/.exec(pathname);
    if (request.method === 'POST' && capabilityMatch) {
      if (!this.isSameOrigin(request)) {
        sendJson(response, 403, { error: 'same_origin_required' });
        return true;
      }
      const csrfHeader = request.headers['x-lugn-csrf'];
      if (
        typeof csrfHeader !== 'string' ||
        !this.constantTimeEqual(csrfHeader, session.csrfToken)
      ) {
        sendJson(response, 403, { error: 'csrf_failed' });
        return true;
      }
      if (!isJsonRequest(request)) {
        sendJson(response, 415, {
          error: 'content_type_must_be_application_json',
        });
        return true;
      }
      const parsed = UiCapabilityRequestSchema.safeParse(
        await readJsonBody(request),
      );
      if (!parsed.success) {
        sendJson(response, 400, { error: 'invalid_request' });
        return true;
      }
      const currentSession = this.getUiSession(request);
      if (!currentSession || currentSession.csrfToken !== session.csrfToken) {
        sendJson(response, 401, { error: 'unauthorized' });
        return true;
      }
      const name = decodeURIComponent(capabilityMatch[1] ?? '');
      if (!Object.hasOwn(CapabilitySchemas, name)) {
        sendJson(response, 404, { error: 'unknown_capability' });
        return true;
      }
      try {
        const result = await this.options.capabilities.invoke(
          name as CapabilityName,
          Object.hasOwn(parsed.data, 'input') ? parsed.data.input : {},
          { actor: { type: 'user', id: 'ui' }, source: 'lugn.ui' },
        );
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof ZodError) {
          sendJson(response, 400, {
            error: 'invalid_capability_input',
            issues: safeIssues(error),
          });
        } else if (error instanceof CapabilityInputError) {
          sendJson(response, 400, { error: error.code });
        } else {
          sendJson(response, 502, { error: 'capability_failed' });
        }
      }
      return true;
    }
    if (
      request.method !== 'GET' &&
      request.method !== 'POST' &&
      request.method !== 'DELETE'
    ) {
      response.setHeader('allow', 'GET, POST, DELETE');
      sendJson(response, 405, { error: 'method_not_allowed' });
      return true;
    }
    sendJson(response, 404, { error: 'not_found' });
    return true;
  }

  private startUiEventStream(
    response: ServerResponse,
    sessionId: string,
    expiresAt: number,
  ): void {
    if (this.uiEventStreams.size >= MAX_UI_EVENT_STREAMS) {
      sendJson(response, 503, { error: 'too_many_event_streams' });
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    this.uiEventStreams.set(response, sessionId);
    const send = (): void => {
      if (
        Date.now() >= expiresAt ||
        !this.uiSessions.has(sessionId) ||
        response.destroyed
      ) {
        response.destroy();
        return;
      }
      if (response.writableNeedDrain) return;
      response.write(`data: ${JSON.stringify(this.uiOverview())}\n\n`);
    };
    send();
    let pendingUpdate: NodeJS.Immediate | undefined;
    const scheduleSend = (): void => {
      if (pendingUpdate) return;
      pendingUpdate = setImmediate(() => {
        pendingUpdate = undefined;
        send();
      });
    };
    const unsubscribe = this.options.engine.stream.subscribe(scheduleSend);
    const unsubscribeExperience =
      this.options.experience?.subscribe(scheduleSend);
    const unsubscribeArtwork =
      this.options.artworkProvider?.subscribe?.(scheduleSend);
    const unsubscribeCamera = this.options.cameraMedia?.subscribe(scheduleSend);
    const heartbeat = setInterval(send, 15_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      if (pendingUpdate) clearImmediate(pendingUpdate);
      unsubscribe();
      unsubscribeExperience?.();
      unsubscribeArtwork?.();
      unsubscribeCamera?.();
      this.uiEventStreams.delete(response);
    };
    response.once('close', cleanup);
  }

  private closeUiEventStreams(sessionId: string): void {
    for (const [response, streamSessionId] of this.uiEventStreams) {
      if (streamSessionId === sessionId) response.destroy();
    }
  }

  private uiOverview(): {
    artwork: ArtworkMap;
    cameraDashboard?: CameraDashboardSnapshot;
    health: { status: 'ok' | 'degraded'; integrations: Record<string, string> };
    instanceId: string;
    deliveryRevision: number;
    generatedAt: number;
    musicObservationTrust: Record<string, boolean>;
    state: LugnEngine['state'];
    scenes: Array<
      LightingScene & {
        canEdit: boolean;
        canDelete: boolean;
        protectionReason?: string;
      }
    >;
    presetsEnabled: boolean;
    musicSettings: MusicVolumeSettings;
    musicSettingsDefaults: MusicVolumeSettings;
    musicSettingsEnabled: boolean;
    musicVolumePolicies: ReturnType<
      LugnEngine['getMusicVolumePolicySnapshots']
    >;
  } & ReturnType<ExperienceApi['snapshot']> {
    const integrations = this.options.integrations();
    const connected = Object.values(integrations).every(
      (status) => status === 'connected' || status === 'not_configured',
    );
    return {
      health: { status: connected ? 'ok' : 'degraded', integrations },
      ...(this.options.cameraMedia
        ? {
            cameraDashboard: this.options.cameraMedia.snapshot(
              'web',
              '/ui/api/cameras/',
            ),
          }
        : {}),
      ...this.options.experience?.snapshot(),
      artwork:
        this.options.artworkProvider?.snapshot(
          this.options.engine.state,
          '/ui/api/artwork/',
        ) ?? {},
      instanceId: this.instanceId,
      deliveryRevision: ++this.nextDeliveryRevision,
      generatedAt: Date.now(),
      musicObservationTrust:
        this.options.musicObservationTrustProvider?.() ?? {},
      state: structuredClone(this.options.engine.state),
      presetsEnabled: this.options.scenePresetStore !== undefined,
      musicSettings: this.options.engine.getMusicVolumeSettings(),
      musicSettingsDefaults: structuredClone(defaultMusicVolumeSettings),
      musicSettingsEnabled: this.options.volumeSettingsStore !== undefined,
      musicVolumePolicies: this.options.engine.getMusicVolumePolicySnapshots(),
      scenes: [...this.options.engine.scenes.values()].map((scene) =>
        this.uiScene(scene),
      ),
    };
  }

  private uiScene(scene: LightingScene): LightingScene & {
    canEdit: boolean;
    canDelete: boolean;
    protectionReason?: string;
  } {
    const protectionReason = this.options.engine.sceneProtection(scene.id);
    return {
      ...structuredClone(scene),
      canEdit:
        this.options.scenePresetStore !== undefined &&
        protectionReason !== 'all_off',
      canDelete:
        this.options.scenePresetStore !== undefined &&
        protectionReason === undefined,
      ...(protectionReason === undefined ? {} : { protectionReason }),
    };
  }

  private getUiSession(
    request: IncomingMessage,
  ):
    | { csrfToken: string; expiresAt: number; clerkSessionId?: string }
    | undefined {
    const sessionId = this.getUiSessionId(request);
    if (!sessionId) return undefined;
    const session = this.uiSessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      this.uiSessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  private getUiSessionId(request: IncomingMessage): string | undefined {
    const cookie = request.headers.cookie;
    if (!cookie) return undefined;
    for (const part of cookie.split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name === UI_SESSION_COOKIE) return value.join('=') || undefined;
    }
    return undefined;
  }

  private pruneUiSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.uiSessions) {
      if (session.expiresAt <= now) this.uiSessions.delete(sessionId);
    }
  }

  private isSameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (typeof origin !== 'string' || typeof host !== 'string') return false;
    try {
      const parsedOrigin = new URL(origin);
      const matchesTrustedOrigin = this.options.trustedOrigins?.some(
        (value) => {
          try {
            return (
              new URL(value).host.toLowerCase() === host.toLowerCase() &&
              parsedOrigin.origin === value
            );
          } catch {
            return false;
          }
        },
      );
      if (matchesTrustedOrigin) return true;
      return (
        isLoopbackHostname(parsedOrigin.hostname) &&
        parsedOrigin.protocol === 'http:' &&
        parsedOrigin.host.toLowerCase() === host.toLowerCase()
      );
    } catch {
      return false;
    }
  }

  /** Prevent browser DNS-rebinding access to the loopback service. */
  private isTrustedRequest(request: IncomingMessage): boolean {
    const hostHeader = request.headers.host;
    if (typeof hostHeader !== 'string') return false;
    let hostUrl: URL;
    try {
      hostUrl = new URL(`http://${hostHeader}`);
    } catch {
      return false;
    }
    if (
      hostUrl.username ||
      hostUrl.password ||
      hostUrl.pathname !== '/' ||
      hostUrl.search ||
      hostUrl.hash ||
      hostUrl.host.toLowerCase() !== hostHeader.toLowerCase()
    )
      return false;

    const trustedHost = this.options.trustedOrigins?.some((value) => {
      try {
        return new URL(value).host.toLowerCase() === hostHeader.toLowerCase();
      } catch {
        return false;
      }
    });
    const isLocalHost = isLoopbackHostname(hostUrl.hostname);
    if (!isLocalHost && !trustedHost) return false;

    const origin = request.headers.origin;
    if (typeof origin !== 'string') return true;
    try {
      const parsedOrigin = new URL(origin);
      const matchesTrustedOrigin = this.options.trustedOrigins?.some(
        (value) => {
          try {
            return (
              new URL(value).host.toLowerCase() === hostHeader.toLowerCase() &&
              parsedOrigin.origin === value
            );
          } catch {
            return false;
          }
        },
      );
      if (matchesTrustedOrigin) return true;
      return (
        isLocalHost &&
        parsedOrigin.protocol === 'http:' &&
        parsedOrigin.host.toLowerCase() === hostHeader.toLowerCase()
      );
    } catch {
      return false;
    }
  }

  private requestIsHttps(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (typeof origin !== 'string') return false;
    try {
      return new URL(origin).protocol === 'https:';
    } catch {
      return false;
    }
  }

  private uiContentSecurityPolicy(): string {
    const clerk = this.options.clerk;
    const frontendApi = clerk
      ? ` ${clerkFrontendApiOrigin(clerk.publishableKey)}`
      : '';
    const clerkScripts = clerk
      ? ' https://challenges.cloudflare.com https://*.protect.clerk.com'
      : '';
    const clerkConnect = clerk ? ' https://*.protect.clerk.com:*' : '';
    const clerkFrames = clerk
      ? ' https://challenges.cloudflare.com https://*.protect.clerk.com'
      : '';
    const clerkImages = clerk ? ' https://img.clerk.com' : '';
    const clerkStyles = clerk ? " 'unsafe-inline'" : '';

    return [
      "default-src 'self'",
      `script-src 'self'${frontendApi}${clerkScripts}`,
      `style-src 'self'${clerkStyles}`,
      `connect-src 'self'${frontendApi}${clerkConnect}`,
      `img-src 'self' data: blob:${clerkImages}`,
      `font-src 'self' data:${frontendApi}`,
      `frame-src 'self'${frontendApi}${clerkFrames}`,
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
  }

  private constantTimeEqual(left: string, right: string): boolean {
    const leftHash = createHash('sha256').update(left).digest();
    const rightHash = createHash('sha256').update(right).digest();
    return timingSafeEqual(leftHash, rightHash);
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
    const providedHash = createHash('sha256').update(match[1]).digest();
    const expectedHash = createHash('sha256').update(configuredToken).digest();
    return timingSafeEqual(providedHash, expectedHash);
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
  return isLoopbackHostname(host);
}

function isLoopbackHostname(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}
