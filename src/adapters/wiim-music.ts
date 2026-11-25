import { createSocket } from 'node:dgram';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { Clock, TimerHandle } from '../core/clock.js';
import { ComputerDeviceIdSchema } from '../core/computer.js';
import { isLanHost } from '../core/optical-switch-settings.js';
import {
  MusicRequestSchema,
  SemanticMusicIdSchema,
  type MusicObservationValues,
} from '../core/schemas.js';
import type {
  MusicAdapter,
  MusicCommand,
  MusicObservation,
} from './simulated-music.js';

const MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_500;
const UPNP_SUBSCRIBE_TIMEOUT_SECS = 120;
const UPNP_RENEW_INTERVAL_MS = 90_000;
const UPNP_RETRY_BACKOFF_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;

const DEFAULT_SOURCES = [
  'Spotify',
  'Optical In',
  'WiFi',
  'Bluetooth',
  'Line In',
  'HDMI',
];

const PHYSICAL_INPUT_MODES = new Set(['40', '43', '47', '49']);

const DEFAULT_MODE_LABELS: Readonly<Record<string, string | null>> = {
  '0': null,
  '1': 'AirPlay',
  '2': 'DLNA',
  '10': 'WiFi',
  '20': 'WiFi',
  '31': 'Spotify',
  '32': 'Tidal',
  '40': 'Line In',
  '41': 'Bluetooth',
  '43': 'Optical In',
  '47': 'HDMI',
  '49': 'Coaxial',
  '50': 'AirPlay',
  '51': 'Chromecast',
  '99': null,
};

const SOURCE_TO_SWITCH_MODE: Readonly<Record<string, string>> = {
  optical: 'optical',
  'optical in': 'optical',
  wifi: 'wifi',
  'wi-fi': 'wifi',
  spotify: 'wifi',
  'line in': 'line-in',
  'line-in': 'line-in',
  aux: 'line-in',
  bluetooth: 'bluetooth',
  hdmi: 'hdmi',
  'hdmi arc': 'hdmi',
  coaxial: 'coaxial',
  coax: 'coaxial',
  usb: 'usb',
};

export const WiimMusicMappingSchema = z
  .object({
    /** LAN address of the WiiM: private/link-local IPv4 or `.local`, optionally `:port`. */
    host: z
      .string()
      .trim()
      .refine(
        isLanHost,
        'host must be a private IPv4 address or a .local name',
      ),
    computerAudio: z
      .object({
        deviceId: ComputerDeviceIdSchema,
        playbackControl: z.boolean().optional(),
        /** Opt in to the selected computer player's artwork (Spotify CDN or local thumbnail). */
        artwork: z.boolean().optional(),
        source: z.string().trim().min(1),
      })
      .strict()
      .optional(),
    sources: z.array(z.string().min(1)).default([...DEFAULT_SOURCES]),
    presets: z
      .object({
        spotify_dj: z.number().int().min(1).max(20).default(1),
        optical: z.number().int().min(1).max(20).default(4),
      })
      .strict()
      .default({ spotify_dj: 1, optical: 4 }),
    /** Override default LinkPlay mode-code to source-label mappings (e.g. `{ "43": "Optical" }`). */
    modeLabels: z
      .record(
        z.string().regex(/^[0-9]{1,3}$/),
        z.string().trim().min(1).max(64),
      )
      .optional(),
    pollIntervalMs: z.number().int().min(1_000).max(60_000).default(5_000),
    upnpPort: z.number().int().min(1).max(65_535).default(49_152),
    upnpPush: z.boolean().default(true),
  })
  .strict()
  .superRefine((mapping, context) => {
    if (new Set(mapping.sources).size !== mapping.sources.length)
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'Sources must be distinct',
      });
  });

export const WiimMusicMappingsSchema = z
  .record(SemanticMusicIdSchema, WiimMusicMappingSchema)
  .superRefine((mappings, context) => {
    const hosts = Object.values(mappings).map((mapping) =>
      mapping.host.toLowerCase(),
    );
    if (new Set(hosts).size !== hosts.length)
      context.addIssue({
        code: 'custom',
        message: 'Each WiiM music target must map to a distinct host',
      });
  });

export type WiimMusicConfig = {
  targets: z.input<typeof WiimMusicMappingsSchema>;
};

export type WiimPresetInfo = {
  number: number;
  name: string;
  source: string | null;
};

export type WiimDeviceInfo = {
  deviceName: string | null;
  firmware: string | null;
  project: string | null;
  rssi: number | null;
  maxVolume: number | null;
  remoteBatteryPercent: number | null;
  eqName: string | null;
  presets: WiimPresetInfo[];
};

export type WiimUpnpEvent = {
  service: 'avtransport' | 'rendering_control';
  transportState?: 'playing' | 'paused' | 'idle' | 'unknown';
  volume?: number;
  mute?: boolean;
  trackUri?: string | null;
};

export interface WiimTransport {
  sendCommand(
    host: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<string>;
  dispose?(): void;
}

export type WiimUpnpSubscriber = (
  host: string,
  upnpPort: number,
  onEvent: (event: WiimUpnpEvent) => void,
) => () => void;

export type WiimMusicAdapterOptions = {
  subscribeUpnp?: WiimUpnpSubscriber;
};

type ParsedPlayerStatus = {
  mode: string;
  playback: MusicObservationValues['playback'];
  volume: number | null;
  source: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  positionSeconds?: number;
  durationSeconds?: number;
};

type TargetRuntime = {
  target: string;
  mapping: z.output<typeof WiimMusicMappingSchema>;
  lastObservedAt: number | null;
  lastObservedMonotonicAt: number | null;
  lastValues: MusicObservationValues | null;
  lastPlayback: MusicObservationValues['playback'] | null;
  playbackChangedAt: number | null;
  consecutiveFailures: number;
  available: boolean;
  polling: boolean;
  refreshQueued: boolean;
  deviceInfo: WiimDeviceInfo | null;
  diagnosticsLoaded: boolean;
  pollTimer: TimerHandle | undefined;
  unsubscribeUpnp: (() => void) | undefined;
};

const UNKNOWN_SENTINELS = new Set(['unknown', 'unknow', 'un_known', 'none']);

/** Decodes hex-encoded UTF-8 metadata from LinkPlay `getPlayerStatus`. */
export function decodeWiimHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let text = trimmed;
  if (trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, 'hex').toString('utf8').trim();
    if (decoded) text = decoded;
  }
  if (!text || UNKNOWN_SENTINELS.has(text.toLowerCase())) return null;
  return text.length <= 1024 ? text : text.slice(0, 1024);
}

export function sourceNameToWiimSwitchMode(source: string): string | null {
  return SOURCE_TO_SWITCH_MODE[source.trim().toLowerCase()] ?? null;
}

export function parseWiimPlayerStatus(
  body: string,
  modeLabels?: Readonly<Record<string, string>>,
): ParsedPlayerStatus {
  const raw: unknown = JSON.parse(body);
  if (typeof raw !== 'object' || raw === null)
    throw new Error('WiiM player status must be a JSON object');
  const record = raw as Record<string, unknown>;
  const mode = typeof record['mode'] === 'string' ? record['mode'].trim() : '';
  const status =
    typeof record['status'] === 'string'
      ? record['status'].trim().toLowerCase()
      : '';
  if (!mode || !status)
    throw new Error('WiiM player status is missing mode or status');

  const playback: MusicObservationValues['playback'] =
    status === 'play'
      ? 'playing'
      : status === 'pause'
        ? 'paused'
        : status === 'stop' || status === 'none'
          ? 'idle'
          : 'unknown';

  const volNumber =
    typeof record['vol'] === 'string' || typeof record['vol'] === 'number'
      ? Number(record['vol'])
      : Number.NaN;
  const volume =
    Number.isFinite(volNumber) && volNumber >= 0 && volNumber <= 100
      ? Math.round(volNumber) / 100
      : null;

  const customSource = modeLabels?.[mode];
  const source =
    customSource !== undefined
      ? customSource
      : mode in DEFAULT_MODE_LABELS
        ? (DEFAULT_MODE_LABELS[mode] ?? null)
        : `mode:${mode}`;

  const title = decodeWiimHex(record['Title']);
  const artist = decodeWiimHex(record['Artist']);
  const album = decodeWiimHex(record['Album']);

  const curpos = Number(record['curpos']);
  const totlen = Number(record['totlen']);
  // LinkPlay retains stale curpos/totlen from prior network streams while on
  // physical inputs (Line In, Optical, HDMI, Coaxial); suppress them there.
  const hasPosition =
    !PHYSICAL_INPUT_MODES.has(mode) &&
    Number.isFinite(curpos) &&
    Number.isFinite(totlen) &&
    curpos >= 0 &&
    totlen > 0 &&
    totlen <= 86_400_000;

  return {
    mode,
    playback,
    volume,
    source,
    title,
    artist,
    album,
    ...(hasPosition
      ? {
          positionSeconds: Math.min(curpos, totlen) / 1000,
          durationSeconds: totlen / 1000,
        }
      : {}),
  };
}

export function parseWiimStatusEx(
  body: string,
): Omit<WiimDeviceInfo, 'eqName' | 'presets'> {
  const raw: unknown = JSON.parse(body);
  if (typeof raw !== 'object' || raw === null)
    throw new Error('WiiM getStatusEx must be a JSON object');
  const record = raw as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim().slice(0, 128)
      : null;
  };
  const intField = (key: string, min: number, max: number): number | null => {
    const rawValue = record[key];
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number')
      return null;
    const n = Number(rawValue);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  return {
    deviceName: text('DeviceName'),
    firmware: text('firmware'),
    project: text('project'),
    rssi: intField('RSSI', -120, 0),
    maxVolume: intField('max_volume', 0, 100),
    remoteBatteryPercent: intField('BleRemoteBatterylevel', 0, 100),
  };
}

export function parseWiimPresetInfo(body: string): WiimPresetInfo[] {
  const raw: unknown = JSON.parse(body);
  if (typeof raw !== 'object' || raw === null) return [];
  const list = (raw as Record<string, unknown>)['preset_list'];
  if (!Array.isArray(list)) return [];
  const presets: WiimPresetInfo[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const num = Number(entry['number']);
    const name = typeof entry['name'] === 'string' ? entry['name'].trim() : '';
    const source =
      typeof entry['source'] === 'string' && entry['source'].trim().length > 0
        ? entry['source'].trim().slice(0, 64)
        : null;
    if (Number.isInteger(num) && num >= 1 && num <= 20 && name.length > 0) {
      presets.push({ number: num, name: name.slice(0, 128), source });
    }
  }
  return presets;
}

export function parseWiimEqBand(body: string): string | null {
  const raw: unknown = JSON.parse(body);
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record['EQStat'] === 'Off') return 'Off';
  const name = typeof record['Name'] === 'string' ? record['Name'].trim() : '';
  return name.length > 0 ? name.slice(0, 64) : null;
}

/** Extracts state fields from an UPnP GENA `LastChange` XML notification body. */
export function parseWiimUpnpLastChange(
  service: WiimUpnpEvent['service'],
  xml: string,
): WiimUpnpEvent | null {
  const unescaped = decodeXmlEntities(xml);
  const event: WiimUpnpEvent = { service };
  let matched = false;
  if (service === 'avtransport') {
    const stateMatch = /<TransportState\b[^>]*\bval="([^"]+)"/i.exec(unescaped);
    if (stateMatch?.[1]) {
      const value = stateMatch[1].toUpperCase();
      event.transportState =
        value === 'PLAYING'
          ? 'playing'
          : value === 'PAUSED_PLAYBACK'
            ? 'paused'
            : value === 'STOPPED' || value === 'NO_MEDIA_PRESENT'
              ? 'idle'
              : 'unknown';
      matched = true;
    }
    const uriMatch =
      /<(?:CurrentTrackURI|AVTransportURI)\b[^>]*\bval="([^"]*)"/i.exec(
        unescaped,
      );
    if (uriMatch) {
      event.trackUri = uriMatch[1] || null;
      matched = true;
    }
  } else {
    const volumeMatch =
      /<Volume\b[^>]*\bchannel="Master"[^>]*\bval="([0-9]{1,3})"/i.exec(
        unescaped,
      ) ?? /<Volume\b[^>]*\bval="([0-9]{1,3})"/i.exec(unescaped);
    if (volumeMatch?.[1]) {
      const v = Number(volumeMatch[1]);
      if (Number.isInteger(v) && v >= 0 && v <= 100) {
        event.volume = v / 100;
        matched = true;
      }
    }
    const muteMatch = /<Mute\b[^>]*\bval="([01])"/i.exec(unescaped);
    if (muteMatch?.[1]) {
      event.mute = muteMatch[1] === '1';
      matched = true;
    }
  }
  return matched ? event : null;
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function splitHostPort(
  host: string,
  defaultPort: number,
): {
  hostname: string;
  port: number;
} {
  const index = host.lastIndexOf(':');
  if (index === -1) return { hostname: host, port: defaultPort };
  return {
    hostname: host.slice(0, index),
    port: Number(host.slice(index + 1)),
  };
}

/**
 * Direct HTTPS keep-alive transport for LinkPlay/WiiM devices on the LAN.
 * Devices serve a self-signed certificate on port 443; `isLanHost` restricts
 * destinations to private/link-local IPv4 or `.local` names.
 */
export function createWiimHttpsTransport(
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): WiimTransport {
  const agent = new HttpsAgent({
    keepAlive: true,
    keepAliveMsecs: 4_000,
    maxSockets: 2,
    rejectUnauthorized: false,
  });

  return {
    sendCommand(
      host: string,
      command: string,
      signal?: AbortSignal,
    ): Promise<string> {
      if (!isLanHost(host))
        return Promise.reject(
          new Error('WiiM host must be a private IPv4 address or .local name'),
        );
      if (/[\r\n]/.test(command))
        return Promise.reject(new Error('Invalid WiiM command'));
      const { hostname, port } = splitHostPort(host, 443);
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('WiiM request aborted'));
          return;
        }
        let settled = false;
        const finish = (error: Error | null, body?: string): void => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve(body ?? '');
        };
        const req = httpsRequest(
          {
            hostname,
            port,
            path: `/httpapi.asp?command=${encodeURIComponent(command)}`,
            method: 'GET',
            agent,
            timeout: requestTimeoutMs,
            headers: {
              Connection: 'keep-alive',
            },
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              finish(new Error(`WiiM HTTP ${res.statusCode ?? 'error'}`));
              return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            res.on('data', (chunk: Buffer) => {
              total += chunk.byteLength;
              if (total > MAX_RESPONSE_BYTES) {
                req.destroy();
                finish(new Error('WiiM response exceeded size limit'));
                return;
              }
              chunks.push(chunk);
            });
            res.on('end', () => {
              finish(null, Buffer.concat(chunks, total).toString('utf8'));
            });
            res.on('error', () => finish(new Error('WiiM response failed')));
          },
        );
        const onAbort = (): void => {
          req.destroy();
          finish(new Error('WiiM request aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        req.on('timeout', () => {
          req.destroy();
          finish(new Error('WiiM request timed out'));
        });
        req.on('error', () => finish(new Error('WiiM transport error')));
        req.end();
      });
    },
    dispose(): void {
      agent.destroy();
    },
  };
}

/** Discovers the local LAN IPv4 address used to reach `targetHost`. */
function localIpv4ForHost(targetHost: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', (error) => {
      socket.close();
      reject(error);
    });
    socket.connect(port, targetHost, () => {
      try {
        const address = socket.address().address;
        socket.close();
        resolve(address);
      } catch (error) {
        socket.close();
        reject(
          error instanceof Error ? error : new Error('route lookup failed'),
        );
      }
    });
  });
}

/**
 * Subscribes to WiiM UPnP GENA push events on port 49152 (`AVTransport` and
 * `RenderingControl`). Falls back cleanly if subscriptions fail or expire.
 */
export function createWiimUpnpSubscriber(): WiimUpnpSubscriber {
  return (host, upnpPort, onEvent) => {
    const { hostname } = splitHostPort(host, 443);
    let stopped = false;
    let server: Server | undefined;
    let renewTimer: ReturnType<typeof setTimeout> | undefined;
    const sids = new Map<string, string>();

    const sendGena = (
      method: 'SUBSCRIBE' | 'UNSUBSCRIBE',
      path: string,
      headers: Record<string, string>,
    ): Promise<{ status: number; sid?: string }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            hostname,
            port: upnpPort,
            path,
            method,
            timeout: DEFAULT_REQUEST_TIMEOUT_MS,
            headers,
          },
          (res) => {
            res.resume();
            const rawSid = res.headers['sid'];
            const sid = Array.isArray(rawSid) ? rawSid[0] : rawSid;
            resolve({
              status: res.statusCode ?? 0,
              ...(sid ? { sid } : {}),
            });
          },
        );
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('UPnP GENA request timed out'));
        });
        req.on('error', reject);
        req.end();
      });

    const subscribeAll = async (callbackBase: string): Promise<void> => {
      if (stopped) return;
      const services: Array<{ path: string; cb: string }> = [
        { path: '/upnp/event/rendertransport1', cb: '/avt' },
        { path: '/upnp/event/rendercontrol1', cb: '/rc' },
      ];
      let okCount = 0;
      for (const svc of services) {
        if (stopped) return;
        const existingSid = sids.get(svc.path);
        try {
          const result = existingSid
            ? await sendGena('SUBSCRIBE', svc.path, {
                SID: existingSid,
                TIMEOUT: `Second-${UPNP_SUBSCRIBE_TIMEOUT_SECS}`,
              })
            : await sendGena('SUBSCRIBE', svc.path, {
                CALLBACK: `<${callbackBase}${svc.cb}>`,
                NT: 'upnp:event',
                TIMEOUT: `Second-${UPNP_SUBSCRIBE_TIMEOUT_SECS}`,
              });
          if (result.status === 200) {
            if (result.sid) sids.set(svc.path, result.sid);
            okCount++;
          } else {
            sids.delete(svc.path);
          }
        } catch {
          sids.delete(svc.path);
        }
      }
      if (stopped) return;
      renewTimer = setTimeout(
        () => {
          void subscribeAll(callbackBase);
        },
        okCount === services.length
          ? UPNP_RENEW_INTERVAL_MS
          : UPNP_RETRY_BACKOFF_MS,
      );
      renewTimer.unref?.();
    };

    const handleNotify = (req: IncomingMessage, res: ServerResponse): void => {
      if (req.method !== 'NOTIFY') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total <= MAX_RESPONSE_BYTES) chunks.push(chunk);
      });
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('Content-Length', '0');
        res.end();
        if (stopped || total > MAX_RESPONSE_BYTES) return;
        const service: WiimUpnpEvent['service'] | null =
          req.url === '/avt'
            ? 'avtransport'
            : req.url === '/rc'
              ? 'rendering_control'
              : null;
        if (!service) return;
        // Anyone on the LAN can reach this listener; only the WiiM knows the
        // subscription id it was given, so other senders are ignored.
        const sid = req.headers['sid'];
        const expected = sids.get(
          service === 'avtransport'
            ? '/upnp/event/rendertransport1'
            : '/upnp/event/rendercontrol1',
        );
        if (expected === undefined || sid !== expected) return;
        const parsed = parseWiimUpnpLastChange(
          service,
          Buffer.concat(chunks, total).toString('utf8'),
        );
        if (parsed) onEvent(parsed);
      });
    };

    void (async () => {
      try {
        const localIp = await localIpv4ForHost(hostname, upnpPort);
        if (stopped) return;
        server = createServer(handleNotify);
        await new Promise<void>((resolve, reject) => {
          server!.once('error', reject);
          server!.listen(0, localIp, () => resolve());
        });
        if (stopped) {
          server.close();
          return;
        }
        const address = server.address() as AddressInfo;
        const callbackBase = `http://${localIp}:${address.port}`;
        await subscribeAll(callbackBase);
      } catch {
        // Polling remains active even when UPnP GENA cannot bind or subscribe.
      }
    })();

    return () => {
      if (stopped) return;
      stopped = true;
      if (renewTimer) clearTimeout(renewTimer);
      for (const [path, sid] of sids.entries()) {
        void sendGena('UNSUBSCRIBE', path, { SID: sid }).catch(() => {});
      }
      sids.clear();
      server?.close();
    };
  };
}

/** Direct LAN WiiM adapter using HTTPS keep-alive + UPnP GENA push. */
export class WiimMusicAdapter implements MusicAdapter {
  private readonly targets = new Map<string, TargetRuntime>();
  private readonly listeners = new Set<
    (observation: MusicObservation) => void
  >();
  private readonly subscribeUpnp: WiimUpnpSubscriber;
  private started = false;
  private stopped = false;

  constructor(
    config: WiimMusicConfig,
    private readonly transport: WiimTransport,
    private readonly clock: Clock,
    options: WiimMusicAdapterOptions = {},
  ) {
    const parsed = WiimMusicMappingsSchema.parse(config.targets);
    this.subscribeUpnp = options.subscribeUpnp ?? createWiimUpnpSubscriber();
    for (const [target, mapping] of Object.entries(parsed)) {
      this.targets.set(target, {
        target,
        mapping,
        lastObservedAt: null,
        lastObservedMonotonicAt: null,
        lastValues: null,
        lastPlayback: null,
        playbackChangedAt: null,
        consecutiveFailures: 0,
        available: false,
        polling: false,
        refreshQueued: false,
        deviceInfo: null,
        diagnosticsLoaded: false,
        pollTimer: undefined,
        unsubscribeUpnp: undefined,
      });
    }
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const runtime of this.targets.values()) {
      if (runtime.mapping.upnpPush) {
        runtime.unsubscribeUpnp = this.subscribeUpnp(
          runtime.mapping.host,
          runtime.mapping.upnpPort,
          (event) => this.handleUpnpEvent(runtime, event),
        );
      }
      void this.pollTarget(runtime, 'wiim.direct_poll');
      this.schedulePoll(runtime);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const runtime of this.targets.values()) {
      if (runtime.pollTimer !== undefined) {
        this.clock.clearTimeout(runtime.pollTimer);
        runtime.pollTimer = undefined;
      }
      runtime.unsubscribeUpnp?.();
      runtime.unsubscribeUpnp = undefined;
    }
    this.transport.dispose?.();
  }

  subscribe(listener: (observation: MusicObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasTarget(target: string): boolean {
    return this.targets.has(target);
  }

  targetIds(): string[] {
    return [...this.targets.keys()];
  }

  /** True when the target has a recent live reading directly from the WiiM. */
  isTargetTrusted(target: string): boolean {
    const runtime = this.targets.get(target);
    if (
      !runtime ||
      !runtime.available ||
      runtime.lastObservedMonotonicAt === null
    )
      return false;
    const maxAgeMs = Math.max(runtime.mapping.pollIntervalMs * 3, 20_000);
    return (
      this.clock.monotonicNow() - runtime.lastObservedMonotonicAt <= maxAgeMs
    );
  }

  isConnected(): boolean {
    for (const target of this.targets.keys()) {
      if (this.isTargetTrusted(target)) return true;
    }
    return false;
  }

  getDeviceInfo(target: string): WiimDeviceInfo | null {
    const info = this.targets.get(target)?.deviceInfo;
    return info ? structuredClone(info) : null;
  }

  async refreshNow(target?: string): Promise<void> {
    if (target !== undefined) {
      const runtime = this.targets.get(target);
      if (runtime) await this.pollTarget(runtime, 'wiim.direct_poll');
      return;
    }
    await Promise.all(
      [...this.targets.values()].map((runtime) =>
        this.pollTarget(runtime, 'wiim.direct_poll'),
      ),
    );
  }

  async dispatch(command: MusicCommand, signal?: AbortSignal): Promise<void> {
    const target = SemanticMusicIdSchema.parse(command.target);
    const requested = MusicRequestSchema.parse(command.requested);
    const runtime = this.targets.get(target);
    if (!runtime)
      throw new Error(`No direct WiiM target is configured for ${target}`);

    let wireCommand: string;
    switch (requested.property) {
      case 'playback':
        wireCommand =
          requested.value === 'playing'
            ? 'setPlayerCmd:play'
            : 'setPlayerCmd:pause';
        break;
      case 'volume': {
        const percent = Math.max(
          0,
          Math.min(100, Math.round(requested.value * 100)),
        );
        wireCommand = `setPlayerCmd:vol:${percent}`;
        break;
      }
      case 'source': {
        if (!runtime.mapping.sources.includes(requested.value))
          throw new Error(`Source is not allowed for ${target}`);
        const switchMode = sourceNameToWiimSwitchMode(requested.value);
        if (!switchMode)
          throw new Error(
            `Source ${requested.value} has no WiiM switchmode mapping for ${target}`,
          );
        wireCommand = `setPlayerCmd:switchmode:${switchMode}`;
        break;
      }
      case 'preset': {
        const presetNumber = runtime.mapping.presets[requested.value];
        wireCommand = `MCUKeyShortClick:${presetNumber}`;
        break;
      }
      case 'seek':
        // The HTTP API takes whole seconds.
        wireCommand = `setPlayerCmd:seek:${Math.floor(requested.value)}`;
        break;
      case 'track':
        wireCommand =
          requested.value === 'next'
            ? 'setPlayerCmd:next'
            : 'setPlayerCmd:prev';
        break;
    }

    let reply: string;
    try {
      reply = await this.transport.sendCommand(
        runtime.mapping.host,
        wireCommand,
        signal,
      );
    } catch {
      throw new Error(
        `WiiM ${requested.property} command failed for ${target}: transport error`,
      );
    }
    const trimmed = reply.trim();
    if (
      trimmed.toLowerCase() === 'unknown command' ||
      trimmed.toLowerCase() === 'failed'
    ) {
      throw new Error(
        `WiiM ${requested.property} command rejected for ${target}`,
      );
    }
    if (!this.stopped) {
      void this.pollTarget(runtime, 'wiim.command_refresh');
    }
  }

  /**
   * Direct physical read from the WiiM. Pure read: never emits ordinary
   * subscription observations or mutates target watermarks.
   */
  async readStatus(
    rawTarget: string,
    signal?: AbortSignal,
  ): Promise<MusicObservation> {
    const target = SemanticMusicIdSchema.parse(rawTarget);
    const runtime = this.targets.get(target);
    if (!runtime)
      throw new Error('Music verification target is not configured');
    const body = await this.transport.sendCommand(
      runtime.mapping.host,
      'getPlayerStatus',
      signal,
    );
    const parsed = parseWiimPlayerStatus(body, runtime.mapping.modeLabels);
    const now = this.clock.now();
    const playbackChangedAt =
      runtime.lastPlayback !== null &&
      runtime.lastPlayback === parsed.playback &&
      runtime.playbackChangedAt !== null
        ? runtime.playbackChangedAt
        : now;
    return this.buildObservation(
      target,
      parsed,
      now,
      playbackChangedAt,
      'wiim.status_read',
    );
  }

  private schedulePoll(runtime: TargetRuntime): void {
    if (this.stopped) return;
    runtime.pollTimer = this.clock.setTimeout(() => {
      runtime.pollTimer = undefined;
      void this.pollTarget(runtime, 'wiim.direct_poll').finally(() => {
        this.schedulePoll(runtime);
      });
    }, runtime.mapping.pollIntervalMs);
  }

  private handleUpnpEvent(runtime: TargetRuntime, event: WiimUpnpEvent): void {
    if (this.stopped) return;
    // Volume from RenderingControl matches getPlayerStatus 1:1, so emit it
    // immediately. AVTransport playback state can differ from getPlayerStatus
    // on physical inputs (e.g. PAUSED_PLAYBACK vs stop on Optical), so let the
    // ~5 ms warm keep-alive getPlayerStatus refresh remain the single source of
    // truth for playback, mode and track metadata.
    if (
      runtime.lastValues &&
      runtime.available &&
      event.volume !== undefined &&
      event.volume !== runtime.lastValues.volume
    ) {
      const now = this.clock.now();
      const mono = this.clock.monotonicNow();
      const next: MusicObservationValues = {
        ...runtime.lastValues,
        volume: event.volume,
      };
      if (runtime.playbackChangedAt === null) runtime.playbackChangedAt = now;
      runtime.lastObservedAt = now;
      runtime.lastObservedMonotonicAt = mono;
      runtime.lastValues = next;
      this.emit({
        target: runtime.target,
        available: true,
        observedAt: now,
        sourceUpdatedAt: now,
        playbackChangedAt: runtime.playbackChangedAt,
        values: next,
        provenance: {
          actor: { type: 'physical_remote' },
          source: 'wiim.upnp_push',
        },
      });
    }
    void this.pollTarget(runtime, 'wiim.upnp_refresh');
  }

  private async pollTarget(
    runtime: TargetRuntime,
    source: string,
  ): Promise<void> {
    if (this.stopped) return;
    if (runtime.polling) {
      runtime.refreshQueued = true;
      return;
    }
    runtime.polling = true;
    try {
      const body = await this.transport.sendCommand(
        runtime.mapping.host,
        'getPlayerStatus',
      );
      if (this.stopped) return;
      const parsed = parseWiimPlayerStatus(body, runtime.mapping.modeLabels);
      const now = this.clock.now();
      const mono = this.clock.monotonicNow();
      const playbackChanged =
        runtime.lastPlayback === null ||
        runtime.lastPlayback !== parsed.playback;
      if (playbackChanged || runtime.playbackChangedAt === null) {
        runtime.playbackChangedAt = now;
      }
      runtime.lastPlayback = parsed.playback;
      runtime.lastObservedAt = now;
      runtime.lastObservedMonotonicAt = mono;
      runtime.consecutiveFailures = 0;
      const wasAvailable = runtime.available;
      runtime.available = true;
      const observation = this.buildObservation(
        runtime.target,
        parsed,
        now,
        runtime.playbackChangedAt,
        source,
      );
      const valuesChanged =
        !wasAvailable ||
        JSON.stringify(runtime.lastValues) !==
          JSON.stringify(observation.values);
      runtime.lastValues = observation.values;
      if (valuesChanged) {
        this.emit(observation);
      }
      if (!runtime.diagnosticsLoaded) {
        runtime.diagnosticsLoaded = true;
        void this.loadDiagnostics(runtime);
      }
    } catch {
      if (this.stopped) return;
      runtime.consecutiveFailures++;
      if (
        runtime.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
        runtime.available
      ) {
        runtime.available = false;
        runtime.lastValues = null;
        const now = this.clock.now();
        this.emit({
          target: runtime.target,
          available: false,
          observedAt: now,
          sourceUpdatedAt: now,
          values: {
            playback: 'unknown',
            volume: null,
            source: null,
            title: null,
          },
          provenance: {
            actor: { type: 'physical_remote' },
            source: 'wiim.unreachable',
          },
        });
      }
    } finally {
      runtime.polling = false;
      if (runtime.refreshQueued && !this.stopped) {
        runtime.refreshQueued = false;
        void this.pollTarget(runtime, 'wiim.queued_refresh');
      }
    }
  }

  private async loadDiagnostics(runtime: TargetRuntime): Promise<void> {
    try {
      const [statusExBody, presetBody, eqBody] = await Promise.all([
        this.transport
          .sendCommand(runtime.mapping.host, 'getStatusEx')
          .catch(() => null),
        this.transport
          .sendCommand(runtime.mapping.host, 'getPresetInfo')
          .catch(() => null),
        this.transport
          .sendCommand(runtime.mapping.host, 'EQGetBand')
          .catch(() => null),
      ]);
      if (this.stopped) return;
      const base = statusExBody
        ? parseWiimStatusEx(statusExBody)
        : {
            deviceName: null,
            firmware: null,
            project: null,
            rssi: null,
            maxVolume: null,
            remoteBatteryPercent: null,
          };
      runtime.deviceInfo = {
        ...base,
        eqName: eqBody ? parseWiimEqBand(eqBody) : null,
        presets: presetBody ? parseWiimPresetInfo(presetBody) : [],
      };
    } catch {
      // Optional diagnostics never degrade playback observations.
    }
  }

  private buildObservation(
    target: string,
    parsed: ParsedPlayerStatus,
    now: number,
    playbackChangedAt: number,
    source: string,
  ): MusicObservation {
    const values: MusicObservationValues = {
      playback: parsed.playback,
      volume: parsed.volume,
      source: parsed.source,
      title: parsed.title,
      ...(parsed.artist === null ? {} : { artist: parsed.artist }),
      ...(parsed.album === null ? {} : { album: parsed.album }),
      ...(parsed.positionSeconds !== undefined &&
      parsed.durationSeconds !== undefined
        ? {
            positionSeconds: parsed.positionSeconds,
            durationSeconds: parsed.durationSeconds,
            positionUpdatedAt: Math.round(now),
          }
        : {}),
    };
    return {
      target,
      available: true,
      observedAt: now,
      sourceUpdatedAt: now,
      playbackChangedAt,
      values,
      provenance: {
        actor: { type: 'physical_remote' },
        source,
      },
    };
  }

  private emit(observation: MusicObservation): void {
    for (const listener of this.listeners)
      listener(structuredClone(observation));
  }
}
