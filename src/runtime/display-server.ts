import type { CameraDashboardService } from '../application/camera-dashboard.js';
import { CameraError } from '../core/cameras.js';
import type { CameraMediaProvider } from './camera-media.js';
import type { PhotoLibrary } from './photo-library.js';
import {
  ComputerNowPlayingSelector,
  type ComputerNowPlaying,
  type ComputerAudioRoute,
} from '../application/computer-now-playing.js';
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
import type { WeatherSnapshot } from '../adapters/home-assistant-weather.js';
import type { ComputerStats } from '../adapters/computer-stats-mqtt.js';
import type { GreetingsConfig } from '../core/greetings.js';
import type { HubRule } from '../core/hub-rules.js';
import { HubPolicyEngine } from '../application/hub-policy.js';
import {
  HubSettingError,
  type HubSettingsService,
} from '../application/hub-settings.js';
import { lightingFeedbackBrowserScript } from './lighting-feedback-script.js';
import {
  displayPayloadKey,
  displayState,
  musicTrackControl,
} from './display-state.js';
import {
  MusicRequestSchema,
  SemanticMusicIdSchema,
  type MusicRequest,
} from '../core/schemas.js';
import type { EnvironmentSnapshot } from '../adapters/home-assistant-environment.js';
import { VolumeAuthorityRequestSchema } from '../application/music-automation.js';
import type {
  MusicVolumePolicySnapshot,
  MusicPlaybackPolicySnapshot,
} from '../application/music-automation.js';
import type { StateEventStream } from '../core/event-stream.js';
import type { ArtworkProvider } from '../core/artwork.js';
import type { LyricsProvider, LyricsTrack } from '../core/lyrics.js';
import type { PlayheadProvider } from './wiim-playhead.js';
import type { CoverProvider } from './spotify-covers.js';
import {
  PrinterLightUnavailableError,
  type PrinterActivityProvider,
} from './printer-activity-service.js';
import {
  ExperienceRequestError,
  type ExperienceApi,
} from '../application/experience-api.js';

const CameraActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('show'),
      cameraId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
    })
    .strict(),
  z.object({ action: z.literal('hide') }).strict(),
  // The camera grid page: open or renew its lease, or end it.
  z.object({ action: z.literal('grid') }).strict(),
  z.object({ action: z.literal('grid-close') }).strict(),
]);
const MAX_REQUEST_BYTES = 8 * 1024;
/** One phase of the on-device profile (src/ui/hub-probe.js), logged as is. */
const PROBE_PHASES = [
  'info',
  'lyrics',
  'cpu',
  'idle',
  'bare',
  'dot',
  'dot-nofilter',
  'dot-noshadow',
  'dot-noanim',
  'dot-nolayers',
  'press',
  'done',
  'error',
] as const;
/** Small, shallow JSON: a phase is a few dozen numbers and short strings. */
function isSmallJson(value: unknown, depth = 0): boolean {
  if (value === null) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 300;
  if (depth >= 3) return false;
  if (Array.isArray(value))
    return (
      value.length <= 12 && value.every((item) => isSmallJson(item, depth + 1))
    );
  if (typeof value === 'object')
    return (
      Object.keys(value).length <= 40 &&
      Object.entries(value).every(
        ([key, item]) => key.length <= 40 && isSmallJson(item, depth + 1),
      )
    );
  return false;
}
const DisplayProbeSchema = z
  .object({
    run: z.string().regex(/^[a-z0-9]{1,12}$/),
    phase: z.enum(PROBE_PHASES),
    data: z
      .record(z.string().max(40), z.unknown())
      .refine(
        (data) => isSmallJson(data) && JSON.stringify(data).length <= 3000,
        'probe data too large',
      ),
  })
  .strict();
const PROBE_REPORTS_PER_MINUTE = 30;
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
  /**
   * Desktop pointer agent this Hub's page may connect to directly. The page
   * connects to `${url}?token=${encodeURIComponent(token)}`; only this Hub's
   * CSP allows the agent's origin.
   */
  pointerBridge?: { url: string; token: string };
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
  presenceCountCorrectionAvailable?: boolean;
  /** What each Hub shows, decided from the situation (docs/HUB-RULES.md). */
  hubRules?: readonly HubRule[];
  hubGreetings?: GreetingsConfig;
  /** Home Assistant's weather and sun; omitted when none is configured. */
  weatherProvider?: () => WeatherSnapshot;
  /** Resource statistics from each desktop that is reporting them. */
  computerStatsProvider?: () => Record<string, ComputerStats>;
  scenes: readonly LightingScene[];
  scenesProvider?: () => readonly LightingScene[];
  stateProvider: () => RoomState;
  /** Whether the upstream subscription can currently supply live player observations. */
  musicObservationConnectedProvider?: () => boolean;
  /** Per-player reconciliation trust, independent of subscription health. */
  musicObservationTrustProvider?: () => Record<string, boolean>;
  stateStream?: StateEventStream;
  computerAudioMappings?: Readonly<Record<string, ComputerAudioRoute>>;
  computerNowPlayingSelector?: ComputerNowPlayingSelector;
  musicVolumePoliciesProvider?: () => Record<string, MusicVolumePolicySnapshot>;
  musicPlaybackPoliciesProvider?: () => Record<
    string,
    MusicPlaybackPolicySnapshot
  >;
  artworkProvider?: ArtworkProvider;
  /** Timed lyrics for the Hubs' music page, asked for only when shown. */
  lyrics?: LyricsProvider;
  /** The players' own position, where it can be read directly. */
  playhead?: PlayheadProvider;
  /** Covers ready to serve as soon as a track is seen. */
  covers?: CoverProvider;
  /** Players whose computer input may use the computer's Spotify cover. */
  computerCoverTargets?: ReadonlySet<string>;
  experience?: ExperienceApi;
  cameraService?: CameraDashboardService;
  cameraMedia?: CameraMediaProvider;
  /** Cached copy of the public shared album shown on the Hubs' photo page. */
  photoLibrary?: PhotoLibrary;
  environmentProvider?: () => EnvironmentSnapshot;
  /** Optional 3D printer shown as a live activity while it prints. */
  printer?: PrinterActivityProvider;
  castStatus?: (hubId: string) => LugnDisplayCastStatus;
  /** The few settings a Hub may change, shown on its settings page. */
  hubSettings?: HubSettingsService;
};

function playerTrack(player: {
  title: string | null;
  artist: string | null;
  album: string | null;
  durationSeconds: number;
}): LyricsTrack {
  return {
    title: player.title ?? '',
    artist: player.artist ?? '',
    ...(player.album ? { album: player.album } : {}),
    durationSeconds: player.durationSeconds,
  };
}

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

type DisplayResourceCategory =
  'html' | 'css' | 'js' | 'state' | 'pointer-js' | 'pointer-config' | 'pages';

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
    case '/pointer-bridge.js':
      return 'pointer-js';
    case '/display-api/pointer-bridge':
      return 'pointer-config';
    case '/pages.css':
    case '/pages.js':
    case '/page-views.js':
    case '/lyrics-view.css':
    case '/lyrics-view.js':
    case '/hub-history.js':
    case '/hub-policy.js':
    case '/presence-chip.css':
    case '/presence-chip.js':
    case '/greeting-page.css':
    case '/greeting-page.js':
    case '/computer-page.css':
    case '/computer-page.js':
    case '/settings-page.css':
    case '/settings-page.js':
    case '/cameras-page.css':
    case '/cameras-page.js':
    case '/hub-probe.js':
      return 'pages';
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
  /** Agent WebSocket origin per Hub, added to that Hub's CSP connect-src. */
  private readonly pointerBridgeOrigins = new Map<string, string>();

  private readonly computerNowPlaying: ComputerNowPlayingSelector;
  private readonly hubPolicy: HubPolicyEngine;
  private unsubscribeComputerObservations: (() => void) | undefined;
  private readonly computerTracks = new Map<string, LyricsTrack>();
  private readonly prefetched = new Map<string, string>();

  constructor(private readonly options: LugnDisplayServerOptions) {
    this.computerNowPlaying =
      options.computerNowPlayingSelector ??
      new ComputerNowPlayingSelector(options.computerAudioMappings ?? {});
    const { hubSettings } = options;
    this.hubPolicy = new HubPolicyEngine(
      options.hubRules ?? [],
      options.hubGreetings,
      hubSettings ? () => hubSettings.own() : undefined,
    );
    validateOptions(options);
    for (const hub of options.hubs) {
      if (hub.pointerBridge)
        this.pointerBridgeOrigins.set(
          hub.id,
          new URL(hub.pointerBridge.url).origin,
        );
    }
    this.acceptedHosts = buildAcceptedHosts(options);
    if (this.acceptedHosts.size === 0)
      throw new Error(
        'Display server needs an explicit allowed host when binding a wildcard address',
      );
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.computerNowPlaying.observe(
      this.options.stateProvider().computer.devices,
    );
    this.unsubscribeComputerObservations = this.options.stateStream?.subscribe(
      (update) => {
        if (update.patch.computer)
          this.computerNowPlaying.observe(update.patch.computer.devices);
      },
    );
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
      this.unsubscribeComputerObservations?.();
      this.unsubscribeComputerObservations = undefined;
      throw error;
    });
  }

  async stop(): Promise<void> {
    this.unsubscribeComputerObservations?.();
    this.unsubscribeComputerObservations = undefined;
    if (!this.options.computerNowPlayingSelector)
      this.computerNowPlaying.reset();
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
      const pointerBridgeOrigin = this.pointerBridgeOrigins.get(
        hubRequest.hub.id,
      );
      if (pointerBridgeOrigin)
        setSecurityHeaders(response, pointerBridgeOrigin);

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
      if (
        request.method === 'POST' &&
        (hubRequest.route === '/display-api/routine' ||
          hubRequest.route === '/display-api/bedtime' ||
          hubRequest.route === '/display-api/suggestion')
      ) {
        if (!isJsonRequest(request)) {
          sendJson(response, 415, {
            error: 'content_type_must_be_application_json',
          });
          return;
        }
        if (!this.options.experience) {
          sendJson(response, 503, { error: 'experience_unavailable' });
          return;
        }
        const body = await readJsonBody(request);
        try {
          const result = await this.options.experience.request(
            hubRequest.route === '/display-api/routine'
              ? 'routines/action'
              : hubRequest.route === '/display-api/bedtime'
                ? 'routines/bedtime'
                : 'intelligence/suggestion',
            body,
            hubProvenance(hubRequest.hub),
          );
          sendJson(response, 200, result);
        } catch (error) {
          if (error instanceof ZodError) throw error;
          if (error instanceof ExperienceRequestError)
            sendJson(response, error.status, { error: error.code });
          else sendJson(response, 502, { error: 'experience_request_failed' });
        }
        return;
      }

      if (
        request.method === 'POST' &&
        hubRequest.route === '/display-api/camera'
      ) {
        if (!isJsonRequest(request)) {
          sendJson(response, 415, {
            error: 'content_type_must_be_application_json',
          });
          return;
        }
        const service = this.options.cameraService;
        if (!service || !this.options.cameraMedia)
          throw new CameraError(503, 'cameras_unavailable');
        const body = CameraActionSchema.parse(await readJsonBody(request));
        if (body.action === 'grid') {
          const cameraGrid = this.options.cameraMedia.openGrid(
            hubRequest.hub.role,
            `${this.pathForHub(hubRequest.hub.id)}display-api/camera-grid/`,
          );
          sendJson(response, 200, { cameraGrid });
          return;
        }
        if (body.action === 'grid-close') {
          this.options.cameraMedia.closeGrid(hubRequest.hub.role);
          sendJson(response, 200, { ok: true });
          return;
        }
        if (body.action === 'show')
          service.show(hubRequest.hub.role, body.cameraId);
        else service.dismiss(hubRequest.hub.role);
        sendJson(response, 200, {
          cameraDashboard: this.cameraSnapshot(hubRequest.hub),
        });
        return;
      }
      const gridImage =
        /^\/display-api\/camera-grid\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})\/image$/.exec(
          hubRequest.route,
        );
      if (request.method === 'GET' && gridImage) {
        if (
          (request.headers.origin && !this.validatedOrigin(request, host)) ||
          request.headers['sec-fetch-site'] === 'cross-site'
        ) {
          sendJson(response, 403, { error: 'invalid_origin' });
          return;
        }
        if (!this.options.cameraMedia)
          throw new CameraError(404, 'camera_view_unavailable');
        const image = await this.options.cameraMedia.readGrid(
          hubRequest.hub.role,
          gridImage[1]!,
        );
        response.writeHead(200, {
          'content-type': image.contentType,
          'content-length': image.body.byteLength,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-origin',
          'content-security-policy': "default-src 'none'; sandbox",
        });
        response.end(image.body);
        return;
      }
      const cameraImage =
        /^\/display-api\/cameras\/([A-Za-z0-9_-]{16,80})\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})\/image$/.exec(
          hubRequest.route,
        );
      if (request.method === 'GET' && cameraImage) {
        if (
          (request.headers.origin && !this.validatedOrigin(request, host)) ||
          request.headers['sec-fetch-site'] === 'cross-site'
        ) {
          sendJson(response, 403, { error: 'invalid_origin' });
          return;
        }
        if (!this.options.cameraMedia)
          throw new CameraError(404, 'camera_view_unavailable');
        const image = await this.options.cameraMedia.read(
          hubRequest.hub.role,
          cameraImage[1]!,
          cameraImage[2]!,
        );
        response.writeHead(200, {
          'content-type': image.contentType,
          'content-length': image.body.byteLength,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-origin',
          'content-security-policy': "default-src 'none'; sandbox",
        });
        response.end(image.body);
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
        hubRequest.route === '/pointer-bridge.js'
      ) {
        await this.serveAsset(
          response,
          'pointer-bridge.js',
          'text/javascript; charset=utf-8',
        );
        return;
      }
      const pageAsset = PAGE_ASSETS.get(hubRequest.route);
      if (request.method === 'GET' && pageAsset) {
        await this.serveAsset(response, pageAsset.file, pageAsset.type);
        return;
      }
      if (
        request.method === 'GET' &&
        hubRequest.route === '/display-api/pointer-bridge'
      ) {
        if (
          (request.headers.origin && !this.validatedOrigin(request, host)) ||
          request.headers['sec-fetch-site'] === 'cross-site'
        ) {
          sendJson(response, 403, { error: 'invalid_origin' });
          return;
        }
        const bridge = hubRequest.hub.pointerBridge;
        if (!bridge) {
          sendJson(response, 404, { error: 'pointer_bridge_not_configured' });
          return;
        }
        sendJson(response, 200, { url: bridge.url, token: bridge.token });
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
        hubRequest.route.startsWith('/display-api/printer/cover/')
      ) {
        if (
          (request.headers.origin && !this.validatedOrigin(request, host)) ||
          request.headers['sec-fetch-site'] === 'cross-site'
        ) {
          sendJson(response, 403, { error: 'invalid_origin' });
          return;
        }
        const token =
          /^\/display-api\/printer\/cover\/([A-Za-z0-9_-]{32})$/.exec(
            hubRequest.route,
          )?.[1];
        const asset = token
          ? await this.options.printer?.readCover(token)
          : null;
        if (!asset) {
          sendJson(response, 404, { error: 'printer_cover_unavailable' });
          return;
        }
        response.writeHead(200, {
          // The token changes with every new cover, so one fetch per print.
          'cache-control': 'private, max-age=86400, immutable',
          'content-type': asset.contentType,
          'content-length': asset.body.byteLength,
          'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-origin',
        });
        response.end(asset.body);
        return;
      }
      if (
        request.method === 'GET' &&
        (hubRequest.route === '/display-api/photos' ||
          hubRequest.route.startsWith('/display-api/photos/'))
      ) {
        if (
          (request.headers.origin && !this.validatedOrigin(request, host)) ||
          request.headers['sec-fetch-site'] === 'cross-site'
        ) {
          sendJson(response, 403, { error: 'invalid_origin' });
          return;
        }
        const library = this.options.photoLibrary;
        if (!library) {
          sendJson(response, 404, { error: 'photos_unavailable' });
          return;
        }
        if (hubRequest.route === '/display-api/photos') {
          sendJson(response, 200, library.snapshot());
          return;
        }
        const image =
          /^\/display-api\/photos\/([A-Za-z0-9_-]{24})(\/backdrop)?$/.exec(
            hubRequest.route,
          );
        const body = image
          ? await library.read(image[1]!, image[2] ? 'backdrop' : 'main')
          : null;
        if (!body) {
          sendJson(response, 404, { error: 'photo_unavailable' });
          return;
        }
        // The id is content-addressed, so a Hub may keep the bytes for good.
        response.writeHead(200, {
          'cache-control': 'private, max-age=604800, immutable',
          'content-type': 'image/jpeg',
          'content-length': body.byteLength,
          'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-origin',
        });
        response.end(body);
        return;
      }
      if (
        request.method === 'GET' &&
        hubRequest.route.startsWith('/display-api/artwork/')
      ) {
        if (
          (request.headers.origin && !this.validatedOrigin(request, host)) ||
          request.headers['sec-fetch-site'] === 'cross-site'
        ) {
          sendJson(response, 403, { error: 'invalid_origin' });
          return;
        }
        const token = /^\/display-api\/artwork\/([A-Za-z0-9_-]{32})$/.exec(
          hubRequest.route,
        )?.[1];
        const asset = token
          ? await this.options.artworkProvider?.read(
              token,
              this.options.stateProvider(),
            )
          : null;
        if (!asset) {
          sendJson(response, 404, { error: 'artwork_unavailable' });
          return;
        }
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': asset.contentType,
          'content-length': asset.body.byteLength,
          'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-origin',
        });
        response.end(asset.body);
        return;
      }
      if (
        request.method === 'GET' &&
        hubRequest.route.startsWith('/display-api/playhead/')
      ) {
        if (
          (request.headers.origin && !this.validatedOrigin(request, host)) ||
          request.headers['sec-fetch-site'] === 'cross-site'
        ) {
          sendJson(response, 403, { error: 'invalid_origin' });
          return;
        }
        // `/lyrics` says the page shows lyrics: only then is a new track
        // sent to the lyrics source ahead of the page asking.
        const rest = hubRequest.route.slice('/display-api/playhead/'.length);
        const wantsLyrics = rest.endsWith('/lyrics');
        const target = wantsLyrics ? rest.slice(0, -'/lyrics'.length) : rest;
        const state = this.options.stateProvider();
        if (!Object.hasOwn(state.music.devices, target)) {
          sendJson(response, 404, { error: 'playhead_unavailable' });
          return;
        }
        const asked = performance.now();
        // Someone is looking: the way to the covers is kept open.
        this.options.covers?.keepWarm();
        const playhead = await this.playhead(
          state,
          target,
          wantsLyrics,
          `${this.pathForHub(hubRequest.hub.id)}display-api/player-art/`,
        );
        sendJson(response, 200, {
          ...playhead,
          // Time spent here (asking the player), for the page's own timing.
          held: Math.round(performance.now() - asked),
        });
        return;
      }
      if (
        request.method === 'GET' &&
        hubRequest.route.startsWith('/display-api/player-art/')
      ) {
        if (
          (request.headers.origin && !this.validatedOrigin(request, host)) ||
          request.headers['sec-fetch-site'] === 'cross-site'
        ) {
          sendJson(response, 403, { error: 'invalid_origin' });
          return;
        }
        const asset = this.options.covers?.get(
          hubRequest.route.slice('/display-api/player-art/'.length),
        );
        if (!asset) {
          sendJson(response, 404, { error: 'artwork_unavailable' });
          return;
        }
        // The id names one image for good.
        response.writeHead(200, {
          'cache-control': 'private, max-age=86400, immutable',
          'content-type': asset.contentType,
          'content-length': asset.body.byteLength,
          'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-origin',
        });
        response.end(asset.body);
        return;
      }
      if (
        request.method === 'GET' &&
        hubRequest.route.startsWith('/display-api/lyrics/')
      ) {
        if (
          (request.headers.origin && !this.validatedOrigin(request, host)) ||
          request.headers['sec-fetch-site'] === 'cross-site'
        ) {
          sendJson(response, 403, { error: 'invalid_origin' });
          return;
        }
        const target = hubRequest.route.slice('/display-api/lyrics/'.length);
        const state = this.options.stateProvider();
        if (
          !this.options.lyrics ||
          !Object.hasOwn(state.music.devices, target)
        ) {
          sendJson(response, 404, { error: 'lyrics_unavailable' });
          return;
        }
        const track = await this.lyricsTrack(state, target);
        sendJson(
          response,
          200,
          track
            ? {
                ...(await this.options.lyrics.lookup(track)),
                track: { title: track.title, artist: track.artist },
              }
            : { status: 'none' },
        );
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
        hubRequest.route === '/display-api/printer/light'
      ) {
        if (!isJsonRequest(request)) {
          sendJson(response, 415, {
            error: 'content_type_must_be_application_json',
          });
          return;
        }
        const input = z
          .object({ on: z.boolean() })
          .strict()
          .parse(await readJsonBody(request));
        if (!this.options.printer) {
          sendJson(response, 404, { error: 'printer_not_configured' });
          return;
        }
        try {
          await this.options.printer.setLight(input.on);
          sendJson(response, 200, { accepted: true });
        } catch (error) {
          sendJson(
            response,
            error instanceof PrinterLightUnavailableError ? 409 : 502,
            {
              error:
                error instanceof PrinterLightUnavailableError
                  ? 'printer_light_unavailable'
                  : 'printer_light_failed',
            },
          );
        }
        return;
      }
      if (
        request.method === 'POST' &&
        hubRequest.route === '/display-api/probe'
      ) {
        if (!isJsonRequest(request)) {
          sendJson(response, 415, {
            error: 'content_type_must_be_application_json',
          });
          return;
        }
        // The quota is spent before the body is read or parsed.
        if (!this.allowProbe(hubRequest.hub.id)) {
          sendJson(response, 429, { error: 'probe_rate_limited' });
          return;
        }
        const report = DisplayProbeSchema.parse(await readJsonBody(request));
        // Read from the journal: the Hub has no other way to report.
        console.info(
          `[lugn] hub probe hub=${hubRequest.hub.id} ${JSON.stringify(report)}`,
        );
        sendJson(response, 202, { accepted: true });
        return;
      }
      if (
        request.method === 'POST' &&
        hubRequest.route === '/display-api/presence-count-one'
      ) {
        if (!isJsonRequest(request)) {
          sendJson(response, 415, {
            error: 'content_type_must_be_application_json',
          });
          return;
        }
        const input = z
          .object({})
          .strict()
          .parse(await readJsonBody(request));
        try {
          const result = await this.options.capabilities.invoke(
            'presence.setCountOne',
            input,
            hubProvenance(hubRequest.hub),
          );
          sendJson(response, 200, result);
        } catch (error) {
          sendJson(
            response,
            error instanceof CapabilityInputError ? 400 : 502,
            {
              error:
                error instanceof CapabilityInputError
                  ? error.code
                  : 'presence_sensor_unavailable',
            },
          );
        }
        return;
      }
      if (
        request.method === 'POST' &&
        hubRequest.route === '/display-api/setting'
      ) {
        if (!isJsonRequest(request)) {
          sendJson(response, 415, {
            error: 'content_type_must_be_application_json',
          });
          return;
        }
        const settings = this.options.hubSettings;
        if (!settings) {
          sendJson(response, 503, { error: 'settings_unavailable' });
          return;
        }
        const input = z
          .object({
            id: z.string().min(1).max(32),
            value: z.union([z.boolean(), z.number().finite()]),
          })
          .strict()
          .parse(await readJsonBody(request));
        try {
          const list = await settings.set(input.id, input.value);
          console.info(
            `[lugn] ${hubRequest.hub.role} Hub set ${input.id} to ${String(input.value)}`,
          );
          sendJson(response, 200, { settings: list });
        } catch (error) {
          if (error instanceof HubSettingError)
            sendJson(response, 400, { error: error.code });
          else sendJson(response, 502, { error: 'setting_save_failed' });
        }
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
        (hubRequest.route === '/display-api/music' ||
          hubRequest.route === '/display-api/volume-authority')
      ) {
        await this.invokeMusic(
          request,
          response,
          hubRequest.hub,
          hubRequest.route === '/display-api/volume-authority',
        );
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
      if (error instanceof CameraError) {
        sendJson(response, error.status, { error: error.code });
        return;
      }
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

  private cameraSnapshot(hub: LugnDisplayHub) {
    return this.options.cameraMedia?.snapshot(
      hub.role,
      `${this.pathForHub(hub.id)}display-api/cameras/`,
    );
  }

  private readonly probeWindows = new Map<
    string,
    { startedAt: number; count: number }
  >();

  private allowProbe(hubId: string): boolean {
    const now = Date.now();
    const current = this.probeWindows.get(hubId);
    if (!current || now - current.startedAt >= 60_000) {
      this.probeWindows.set(hubId, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= PROBE_REPORTS_PER_MINUTE;
  }

  /**
   * The track the page shows for a player: behind a computer input the
   * computer's media, otherwise the player's own. The page never names it, so
   * a Hub cannot have anything else looked up.
   */
  private async lyricsTrack(
    state: RoomState,
    target: string,
  ): Promise<LyricsTrack | undefined> {
    const computer = this.computerNowPlaying.snapshot(state)[target];
    if (computer) {
      // A paused computer reports no media; the page keeps showing the last.
      if (computer.status === 'playing' && computer.title && computer.artist) {
        const track = {
          title: computer.title,
          artist: computer.artist,
          ...(computer.durationSeconds === undefined
            ? {}
            : { durationSeconds: computer.durationSeconds }),
        };
        this.computerTracks.set(target, track);
        return track;
      }
      return computer.status === 'idle'
        ? this.computerTracks.get(target)
        : undefined;
    }
    const player = await this.options.playhead?.read(target);
    if (player?.title && player.artist) return playerTrack(player);
    const observed = state.music.devices[target]?.observed;
    const title = observed?.title?.trim();
    const artist = observed?.artist?.trim();
    if (!title || !artist) return undefined;
    return {
      title,
      artist,
      ...(observed?.album?.trim() ? { album: observed.album.trim() } : {}),
      ...(observed?.durationSeconds === undefined
        ? {}
        : { durationSeconds: observed.durationSeconds }),
    };
  }

  /**
   * Where the shown track is, as of this answer: the computer's media behind a
   * computer input, the player's own report where it can be read, and else the
   * last report extrapolated (`coarse`: whole seconds through Home Assistant).
   */
  private async playhead(
    state: RoomState,
    target: string,
    wantsLyrics: boolean,
    artPrefix: string,
  ) {
    const since = (at: number) => Math.max(0, (Date.now() - at) / 1000);
    const computer = this.computerNowPlaying.snapshot(state)[target];
    if (computer) {
      const { positionSeconds, positionUpdatedAt } = computer;
      if (
        computer.status !== 'playing' ||
        positionSeconds === undefined ||
        positionUpdatedAt === undefined
      )
        return { source: 'none' as const };
      const art = this.computerCover(state, target);
      return {
        source: 'computer' as const,
        playing: true,
        position: positionSeconds + since(positionUpdatedAt),
        duration: computer.durationSeconds,
        ...(computer.title && computer.artist
          ? { track: { title: computer.title, artist: computer.artist } }
          : {}),
        ...(art ? { art: `${artPrefix}${art}` } : {}),
      };
    }
    const player = await this.options.playhead?.read(target);
    if (player) {
      const age = (this.options.playhead!.now() - player.measuredAt) / 1000;
      const track = playerTrack(player);
      if (wantsLyrics) this.prefetchLyrics(target, track);
      return {
        source: 'player' as const,
        playing: player.playing,
        position: player.positionSeconds + (player.playing ? age : 0),
        duration: player.durationSeconds,
        ...(player.title && player.artist
          ? { track: { title: player.title, artist: player.artist } }
          : {}),
        ...(player.art ? { art: `${artPrefix}${player.art}` } : {}),
      };
    }
    const observed = state.music.devices[target]?.observed;
    if (
      observed?.positionSeconds === undefined ||
      observed.positionUpdatedAt === undefined
    )
      return { source: 'none' as const };
    const playing = observed.playback === 'playing';
    return {
      source: 'coarse' as const,
      playing,
      position:
        observed.positionSeconds +
        (playing ? since(observed.positionUpdatedAt) : 0),
      duration: observed.durationSeconds,
    };
  }

  /**
   * The cover of the computer's playing Spotify media, where the player's input
   * allows it: its id once it is here, and asked for the moment it is seen.
   */
  private computerCover(state: RoomState, target: string): string | undefined {
    const { covers, computerCoverTargets } = this.options;
    if (!covers || !computerCoverTargets?.has(target)) return undefined;
    const art = this.computerNowPlaying.selectedMedia(state, target)?.artwork;
    if (art?.provider !== 'spotify') return undefined;
    covers.want(art.id);
    return covers.get(art.id) ? art.id : undefined;
  }

  /**
   * What each player plays, as the page may show it before Home Assistant
   * says so. A change is pushed to the Hubs, which then ask for the position.
   */
  private nowPlaying(
    state: RoomState,
    computers: Record<string, ComputerNowPlaying>,
    artPrefix: string,
  ) {
    const result: Record<
      string,
      { title: string; artist: string | null; art?: string }
    > = {};
    for (const target of Object.keys(state.music.devices)) {
      const computer = computers[target];
      const player = computer
        ? undefined
        : this.options.playhead?.peek?.(target);
      const title = computer
        ? computer.status === 'playing'
          ? computer.title
          : null
        : player?.title;
      if (!title) continue;
      const art = computer ? this.computerCover(state, target) : player?.art;
      result[target] = {
        title,
        artist: (computer ? computer.artist : player?.artist) ?? null,
        ...(art ? { art: `${artPrefix}${art}` } : {}),
      };
    }
    return result;
  }

  /** A new track's lines are asked for before any page asks. */
  private prefetchLyrics(target: string, track: LyricsTrack): void {
    if (!this.options.lyrics || !track.title || !track.artist) return;
    const key = JSON.stringify([track.title, track.artist]);
    if (this.prefetched.get(target) === key) return;
    this.prefetched.set(target, key);
    void this.options.lyrics.lookup(track).catch(() => undefined);
  }

  private snapshot(hub: LugnDisplayHub) {
    const state = this.options.stateProvider();
    const computers = this.computerNowPlaying.snapshot(state);
    return {
      state: displayState(state),
      ...(this.options.cameraMedia
        ? { cameraDashboard: this.cameraSnapshot(hub) }
        : {}),
      ...this.options.experience?.snapshot(),
      computerNowPlaying: computers,
      nowPlaying: this.nowPlaying(
        state,
        computers,
        `${this.pathForHub(hub.id)}display-api/player-art/`,
      ),
      musicTrackControl: musicTrackControl(
        state,
        this.options.computerAudioMappings ?? {},
      ),
      artwork:
        this.options.artworkProvider?.snapshot(
          state,
          `${this.pathForHub(hub.id)}display-api/artwork/`,
        ) ?? {},
      deliveryRevision: ++this.nextDeliveryRevision,
      instanceId: this.instanceId,
      generatedAt: Date.now(),
      musicObservationTrust:
        this.options.musicObservationTrustProvider?.() ?? {},
      musicObservationConnected:
        this.options.musicObservationConnectedProvider?.() ?? true,
      musicVolumePolicies: this.options.musicVolumePoliciesProvider?.() ?? {},
      musicPlaybackPolicies:
        this.options.musicPlaybackPoliciesProvider?.() ?? {},
      scenes: this.options.scenesProvider?.() ?? this.options.scenes,
      role: hub.role,
      presenceCountCorrectionAvailable:
        this.options.presenceCountCorrectionAvailable ?? false,
      // Only with rules configured, so a Hub without any sees today's payload.
      ...(this.hubPolicy.hasRules
        ? {
            hubPolicy: this.hubPolicy.evaluate(
              hub,
              state,
              Date.now(),
              this.options.environmentProvider?.().co2,
            ),
          }
        : {}),
      castStatus: this.options.castStatus?.(hub.id) ?? { state: 'unknown' },
      ...(this.options.weatherProvider
        ? { weather: this.options.weatherProvider() }
        : {}),
      ...(this.options.computerStatsProvider
        ? { computerStats: this.options.computerStatsProvider() }
        : {}),
      ...(this.options.hubSettings
        ? { settings: this.options.hubSettings.list() }
        : {}),
      environment:
        this.options.environmentProvider?.() ?? emptyEnvironmentSnapshot(),
      printer:
        this.options.printer?.snapshot(
          `${this.pathForHub(hub.id)}display-api/printer/cover/`,
        ) ?? null,
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
    // A publish that changes nothing the page shows (only counters and
    // evaluation clocks) is not sent; the heartbeat always is.
    let lastKey: string | undefined;
    const send = (heartbeat = false): void => {
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
        const json = JSON.stringify(payload);
        const key = displayPayloadKey(json);
        if (!heartbeat && key === lastKey) return;
        lastKey = key;
        response.write(`id: ${payload.state.revision}\ndata: ${json}\n\n`);
      } catch {
        response.destroy();
      }
    };
    let pendingUpdate: NodeJS.Immediate | undefined;
    const scheduleSend = (): void => {
      if (pendingUpdate) return;
      pendingUpdate = setImmediate(() => {
        pendingUpdate = undefined;
        send();
      });
    };
    const unsubscribe = stream.subscribe(scheduleSend);
    const unsubscribeArtwork =
      this.options.artworkProvider?.subscribe?.(scheduleSend);
    const unsubscribeCovers = this.options.covers?.subscribe(scheduleSend);
    const unsubscribePlayhead =
      this.options.playhead?.subscribe?.(scheduleSend);
    const unsubscribeExperience =
      this.options.experience?.subscribe(scheduleSend);
    const unsubscribeCamera = this.options.cameraMedia?.subscribe(scheduleSend);
    const unsubscribePrinter = this.options.printer?.subscribe(scheduleSend);
    const heartbeat = setInterval(() => send(true), 5_000);
    response.once('close', () => {
      unsubscribe();
      unsubscribeArtwork?.();
      unsubscribeCovers?.();
      unsubscribePlayhead?.();
      unsubscribeExperience?.();
      unsubscribeCamera?.();
      unsubscribePrinter?.();
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
    filename: UiAssetName,
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
      if (filename === 'display.js')
        body = Buffer.concat([
          Buffer.from(lightingFeedbackBrowserScript),
          body,
        ]);
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
    authority = false,
  ): Promise<void> {
    if (!isJsonRequest(request)) {
      sendJson(response, 415, {
        error: 'content_type_must_be_application_json',
      });
      return;
    }
    const body = await readJsonBody(request);
    const capability = authority
      ? {
          name: 'music.setVolumeAuthority' as const,
          input: VolumeAuthorityRequestSchema.parse(body),
        }
      : (() => {
          const input = DisplayMusicRequestSchema.parse(body);
          return musicCapability(input.target, input.request);
        })();
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
    | 'music.playPreset'
    | 'music.skipTrack'
    | 'music.seek';
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
    case 'seek':
      return {
        name: 'music.seek',
        input: { target, positionSeconds: request.value },
      };
    case 'track':
      return {
        name: 'music.skipTrack',
        input: { target, step: request.value },
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
    if (hub.pointerBridge) {
      if (!isPointerBridgeUrl(hub.pointerBridge.url))
        throw new Error(
          'Display Hub pointer bridge URL must be ws:// or wss:// with a host and no credentials, query or fragment',
        );
      if (!isPointerBridgeToken(hub.pointerBridge.token))
        throw new Error(
          'Display Hub pointer bridge token must be 16-512 printable characters without spaces',
        );
    }
  }
}

/** The page appends `?token=…`, so the URL must not carry its own query. */
function isPointerBridgeUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'ws:' || url.protocol === 'wss:') &&
    url.hostname.length > 0 &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !value.includes('?') &&
    !value.includes('#')
  );
}

function isPointerBridgeToken(value: string): boolean {
  return /^[\x21-\x7e]{16,512}$/.test(value);
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

type UiAssetName =
  | 'display.html'
  | 'display.css'
  | 'display.js'
  | 'pointer-bridge.js'
  | 'pages.css'
  | 'pages.js'
  | 'quick-menu.css'
  | 'quick-menu.js'
  | 'photos-page.css'
  | 'photos-page.js'
  | 'page-views.js'
  | 'lyrics-view.css'
  | 'lyrics-view.js'
  | 'hub-history.js'
  | 'hub-policy.js'
  | 'presence-chip.css'
  | 'presence-chip.js'
  | 'greeting-page.css'
  | 'greeting-page.js'
  | 'computer-page.css'
  | 'computer-page.js'
  | 'settings-page.css'
  | 'settings-page.js'
  | 'cameras-page.css'
  | 'cameras-page.js'
  | 'hub-probe.js';

/** The Hub pager and its pages (src/ui/pages*.{css,js}, page-views.js). */
const PAGE_ASSETS: ReadonlyMap<
  string,
  { readonly file: UiAssetName; readonly type: string }
> = new Map([
  ['/pages.css', { file: 'pages.css', type: 'text/css; charset=utf-8' }],
  ['/pages.js', { file: 'pages.js', type: 'text/javascript; charset=utf-8' }],
  [
    '/hub-history.js',
    { file: 'hub-history.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/page-views.js',
    { file: 'page-views.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/hub-policy.js',
    { file: 'hub-policy.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/presence-chip.css',
    { file: 'presence-chip.css', type: 'text/css; charset=utf-8' },
  ],
  [
    '/presence-chip.js',
    { file: 'presence-chip.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/greeting-page.css',
    { file: 'greeting-page.css', type: 'text/css; charset=utf-8' },
  ],
  [
    '/greeting-page.js',
    { file: 'greeting-page.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/computer-page.css',
    { file: 'computer-page.css', type: 'text/css; charset=utf-8' },
  ],
  [
    '/computer-page.js',
    { file: 'computer-page.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/settings-page.css',
    { file: 'settings-page.css', type: 'text/css; charset=utf-8' },
  ],
  [
    '/settings-page.js',
    { file: 'settings-page.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/cameras-page.css',
    { file: 'cameras-page.css', type: 'text/css; charset=utf-8' },
  ],
  [
    '/cameras-page.js',
    { file: 'cameras-page.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/lyrics-view.css',
    { file: 'lyrics-view.css', type: 'text/css; charset=utf-8' },
  ],
  [
    '/lyrics-view.js',
    { file: 'lyrics-view.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/quick-menu.css',
    { file: 'quick-menu.css', type: 'text/css; charset=utf-8' },
  ],
  [
    '/quick-menu.js',
    { file: 'quick-menu.js', type: 'text/javascript; charset=utf-8' },
  ],
  [
    '/photos-page.css',
    { file: 'photos-page.css', type: 'text/css; charset=utf-8' },
  ],
  [
    '/photos-page.js',
    { file: 'photos-page.js', type: 'text/javascript; charset=utf-8' },
  ],
  // The on-device profile, loaded only by a Hub opened with #probe.
  [
    '/hub-probe.js',
    { file: 'hub-probe.js', type: 'text/javascript; charset=utf-8' },
  ],
]);

/**
 * The UI directory is the first candidate holding the three core files; any
 * other asset is served only from that same directory, so it never mixes
 * versions with the page that loads it.
 */
function findUiAsset(filename: UiAssetName): string | undefined {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidateDirectories = [
    resolve(moduleDirectory, '../ui'),
    resolve(moduleDirectory, '../../src/ui'),
    resolve(process.cwd(), 'src/ui'),
  ];
  for (const directory of candidateDirectories) {
    if (
      existsSync(resolve(directory, 'display.html')) &&
      existsSync(resolve(directory, 'display.css')) &&
      existsSync(resolve(directory, 'display.js'))
    ) {
      const candidate = resolve(directory, filename);
      return existsSync(candidate) ? candidate : undefined;
    }
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

function setSecurityHeaders(
  response: ServerResponse,
  pointerBridgeOrigin?: string,
): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader(
    'content-security-policy',
    [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      'frame-ancestors https://www.gstatic.com',
      "img-src 'self' data: blob:",
      pointerBridgeOrigin
        ? `connect-src 'self' ${pointerBridgeOrigin}`
        : "connect-src 'self'",
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
