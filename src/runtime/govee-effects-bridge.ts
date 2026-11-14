import { createSocket, type Socket } from 'node:dgram';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect, type MqttClient } from 'mqtt';
import { z } from 'zod';
import {
  encodeGoveeEffectCommand,
  fetchGoveeEffectLibrary,
  type GoveeEffect,
} from '../adapters/govee-lan-effects.js';
import { loadRuntimeConfig, type RuntimeConfig } from './config.js';
import {
  GoveePlatformConfigSchema,
  startGoveePlatformBridge,
} from './govee-platform-bridge.js';

export const RESUME_LUGN = 'Lugn';
export const EXTERNAL_UNKNOWN = 'Extern (okänd effekt)';
const DeviceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{1,48}$/),
    name: z.string().min(1).max(100),
    target: z.string().regex(/^lighting\.[a-z0-9_]+$/),
    sku: z.enum(['H612A', 'H612F', 'H6022', 'H600D', 'H60A6']),
    device: z
      .string()
      .regex(/^(?:[A-Fa-f0-9]{2}:){7}[A-Fa-f0-9]{2}$/)
      .transform((v) => v.toUpperCase()),
  })
  .strict();
export const GoveeBridgeConfigSchema = z
  .object({
    cacheDirectory: z.string().min(1),
    interfaceAddress: z.ipv4(),
    broadcastAddress: z.ipv4().optional(),
    devices: z.array(DeviceSchema).min(1).max(16),
    platform: GoveePlatformConfigSchema.optional(),
  })
  .strict()
  .superRefine((c, context) => {
    for (const field of ['id', 'target', 'device'] as const) {
      if (
        new Set(c.devices.map((d) => d[field].toUpperCase())).size !==
        c.devices.length
      )
        context.addIssue({ code: 'custom', message: `Duplicate LAN ${field}` });
    }
    for (const platform of c.platform?.devices ?? []) {
      for (const lan of c.devices) {
        if (
          platform.id !== lan.id &&
          platform.target !== lan.target &&
          platform.device !== lan.device
        )
          continue;
        const complementaryZones =
          platform.id === lan.id &&
          platform.target === lan.target &&
          platform.device === lan.device &&
          platform.sku === lan.sku &&
          !platform.exposeEffects &&
          (platform.zones?.length ?? 0) > 0;
        if (!complementaryZones)
          context.addIssue({
            code: 'custom',
            message:
              'Overlapping LAN/platform controls require matching zone-only fixture configuration',
          });
      }
    }
  });
export type GoveeBridgeDevice = z.infer<typeof DeviceSchema>;
type BridgeConfig = z.infer<typeof GoveeBridgeConfigSchema>;

/** Unknown packet formats stay out of the selectable list. */
export function playableEffects(effects: GoveeEffect[]): GoveeEffect[] {
  return effects.filter((effect) => {
    try {
      encodeGoveeEffectCommand(effect);
      return true;
    } catch {
      return false;
    }
  });
}

/** Label duplicates without losing independently selectable app variants. */
export function effectOptions(
  effects: GoveeEffect[],
): Map<string, GoveeEffect> {
  const counts = new Map<string, number>();
  for (const e of effects) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const result = new Map<string, GoveeEffect>();
  for (const e of effects) {
    let label =
      counts.get(e.name) === 1
        ? e.name
        : `${e.name} · ${e.category} · ${e.variant}`;
    if (result.has(label) || label === RESUME_LUGN) label += ` · ${e.id}`;
    if (label.length > 255) throw new Error('Effect label too long');
    result.set(label, e);
  }
  return result;
}

export function selectDiscovery(device: GoveeBridgeDevice, options: string[]) {
  const base = `lugn/govee/${device.id}`;
  return {
    name: 'Appanimation',
    has_entity_name: true,
    unique_id: `lugn_govee_${device.id}_effect`,
    default_entity_id: `select.lugn_govee_${device.id}_effect`,
    command_topic: `${base}/set`,
    state_topic: `${base}/state`,
    availability_topic: 'lugn/govee/availability',
    options: [RESUME_LUGN, EXTERNAL_UNKNOWN, ...options],
    icon: 'mdi:creation',
    retain: false,
    qos: 0,
    device: {
      identifiers: [
        `lugn_govee_${device.device.replaceAll(':', '').toLowerCase()}`,
      ],
      name: device.name,
      manufacturer: 'Govee',
      model: device.sku,
    },
  };
}

type LanDevice = { ip: string; seenAt: number };
/** Binds only the Govee reply port, separate from HA's host. Never sends power/color. */
export class GoveeLanTransport {
  private readonly socket: Socket = createSocket('udp4');
  private readonly devices = new Map<string, LanDevice>();
  private readonly listeners = new Set<(ip: string, data: unknown) => void>();
  constructor(private readonly config: BridgeConfig) {}
  async start(): Promise<void> {
    this.socket.on('message', (bytes, peer) => {
      if (bytes.length > 16384) return;
      try {
        const message = JSON.parse(bytes.toString()) as {
          msg?: { cmd?: string; data?: Record<string, unknown> };
        };
        const data = message.msg?.data;
        if (!data) return;
        if (message.msg?.cmd === 'scan') {
          const match = this.config.devices.find(
            (d) =>
              d.device === String(data['device']).toUpperCase() &&
              d.sku === data['sku'],
          );
          if (match && data['ip'] === peer.address)
            this.devices.set(match.id, {
              ip: peer.address,
              seenAt: Date.now(),
            });
        }
        if (message.msg?.cmd === 'devStatus')
          for (const listener of this.listeners) listener(peer.address, data);
      } catch {
        /* Ignore unrelated/malformed local UDP traffic. */
      }
    });
    await new Promise<void>((ok, fail) => {
      this.socket.once('error', fail);
      this.socket.bind(4002, this.config.interfaceAddress, () => {
        this.socket.off('error', fail);
        ok();
      });
    });
    this.socket.on('error', () => console.error('Govee UDP transport error'));
    this.socket.setMulticastInterface(this.config.interfaceAddress);
    this.socket.setMulticastTTL(1);
    if (this.config.broadcastAddress) this.socket.setBroadcast(true);
    await this.discover();
  }
  async discover(): Promise<void> {
    await this.send(
      '239.255.255.250',
      { msg: { cmd: 'scan', data: { account_topic: 'reserve' } } },
      4001,
    );
    if (this.config.broadcastAddress)
      await this.send(
        this.config.broadcastAddress,
        { msg: { cmd: 'scan', data: { account_topic: 'reserve' } } },
        4001,
      );
    await new Promise((ok) => setTimeout(ok, 1200));
  }
  async address(id: string): Promise<string> {
    let found = this.devices.get(id);
    if (!found || Date.now() - found.seenAt > 60000) {
      await this.discover();
      found = this.devices.get(id);
    }
    if (!found || Date.now() - found.seenAt > 60000)
      throw new Error('Device not discovered');
    return found.ip;
  }
  async status(ip: string): Promise<unknown> {
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        fail(new Error('No device status'));
      }, 2000);
      const listener = (peer: string, data: unknown) => {
        if (peer !== ip) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        ok(data);
      };
      this.listeners.add(listener);
      void this.send(ip, { msg: { cmd: 'devStatus', data: {} } }).catch(() => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        fail(new Error('Status send failed'));
      });
    });
  }
  async send(ip: string, command: unknown, port = 4003): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(command));
    if (bytes.length > 60000) throw new Error('Command too large');
    await new Promise<void>((ok, fail) =>
      this.socket.send(bytes, port, ip, (error) =>
        error ? fail(error) : ok(),
      ),
    );
  }
  stop(): void {
    this.socket.close();
  }
}

export async function loadGoveeEffects(
  sku: string,
  directory: string,
): Promise<GoveeEffect[]> {
  const cache = join(directory, `${sku}.json`);
  try {
    // Store parsed, validated records. No account/device information is in this cache.
    const effects = await fetchGoveeEffectLibrary(sku);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(`${cache}.tmp`, JSON.stringify(effects), { mode: 0o600 });
    await rename(`${cache}.tmp`, cache);
    return effects;
  } catch {
    // Revalidate the cached records via the same packet encoder below.
    const effects: unknown = JSON.parse(await readFile(cache, 'utf8'));
    if (!Array.isArray(effects) || effects.length > 4096)
      throw new Error('Invalid effect cache');
    const parsed = z
      .array(
        z
          .object({
            sku: z.literal(sku),
            id: z.string(),
            name: z.string().max(515),
            category: z.string().max(256),
            sceneCode: z.number().int(),
            sceneType: z.number().int(),
            sceneParam: z.string().max(50000),
            variant: z.number().int(),
            paramId: z.number().int().nonnegative().optional(),
            cmdVersion: z.number().int().min(0).max(255).optional(),
          })
          .strict(),
      )
      .parse(effects);
    return parsed.map(({ paramId, cmdVersion, ...effect }) => ({
      ...effect,
      ...(paramId === undefined ? {} : { paramId }),
      ...(cmdVersion === undefined ? {} : { cmdVersion }),
    }));
  }
}

export type EffectBridgePort = {
  begin(target: string): Promise<string>;
  owns(target: string, controlId: string): Promise<boolean>;
  end(target: string, controlId?: string): Promise<void>;
  send(effect: GoveeEffect): Promise<void>;
};
/** Serial callers encode before changing intent, and check ownership before sending. */
export async function applyEffect(
  target: string,
  effect: GoveeEffect,
  port: EffectBridgePort,
): Promise<string> {
  encodeGoveeEffectCommand(effect);
  const id = await port.begin(target);
  try {
    if (!(await port.owns(target, id)))
      throw new Error('External control superseded');
    await port.send(effect);
  } catch (error) {
    await port.end(target, id).catch(() => undefined);
    throw error;
  }
  return id;
}

export async function startGoveeBridge(
  runtime: RuntimeConfig,
  config: BridgeConfig,
): Promise<() => Promise<void>> {
  if (!runtime.mqtt) throw new Error('MQTT required');
  for (const d of config.devices)
    if (!(d.target in runtime.homeAssistant.entities))
      throw new Error('Unmapped Govee target');
  const catalogs = new Map<string, Map<string, GoveeEffect>>();
  for (const d of config.devices)
    catalogs.set(
      d.id,
      effectOptions(
        playableEffects(await loadGoveeEffects(d.sku, config.cacheDirectory)),
      ),
    );
  const lan = new GoveeLanTransport(config);
  await lan.start();
  const headers = {
    'Content-Type': 'application/json',
    ...(runtime.http.bearerToken
      ? { Authorization: `Bearer ${runtime.http.bearerToken}` }
      : {}),
  };
  const baseUrl = `http://127.0.0.1:${runtime.http.port}`;
  const request = async (path: string, input?: unknown): Promise<unknown> => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(
        path.endsWith('/lighting.beginExternalControl') ? 35000 : 10000,
      ),
      ...(input === undefined
        ? {}
        : {
            method: 'POST',
            body: JSON.stringify({
              input,
              reason: 'Home Assistant Govee effect selector',
            }),
          }),
    });
    if (!response.ok) throw new Error('Lugn request failed');
    return response.json();
  };
  const readState = async () =>
    z
      .object({
        lighting: z.object({
          devices: z.record(
            z.string(),
            z
              .object({
                externalControl: z
                  .object({ id: z.string() })
                  .passthrough()
                  .optional(),
              })
              .passthrough(),
          ),
        }),
      })
      .parse(await request('/state'));
  const client: MqttClient = connect(runtime.mqtt.url, {
    ...(runtime.mqtt.username === undefined
      ? {}
      : { username: runtime.mqtt.username }),
    ...(runtime.mqtt.password === undefined
      ? {}
      : { password: runtime.mqtt.password }),
    clientId: 'lugn-govee-effects',
    clean: true,
    queueQoSZero: false,
    reconnectPeriod: 2000,
    connectTimeout: 10000,
    resubscribe: false,
    will: {
      topic: 'lugn/govee/availability',
      payload: Buffer.from('offline'),
      qos: 1,
      retain: true,
    },
  });
  let stopped = false;
  let connectionGeneration = 0;
  let selectionRevision = 0;
  client.on('close', () => {
    connectionGeneration++;
  });
  client.on('offline', () => {
    connectionGeneration++;
  });
  const publish = async (topic: string, payload: unknown) => {
    if (!client.connected || stopped) return;
    await client.publishAsync(
      topic,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      { qos: 0, retain: true },
    );
  };
  const active = new Map<string, { controlId: string; name: string }>();
  client.on('error', () => console.error('Govee MQTT connection error'));
  client.on('connect', () => {
    connectionGeneration++;
    void (async () => {
      const revision = selectionRevision;
      const generation = connectionGeneration;
      const state = await readState().catch(() => undefined);
      for (const d of config.devices) {
        if (
          revision !== selectionRevision ||
          generation !== connectionGeneration
        )
          return;
        await publish(
          `homeassistant/select/lugn_govee_${d.id}_effect/config`,
          selectDiscovery(d, [...catalogs.get(d.id)!.keys()]),
        );
        await publish(
          `homeassistant/sensor/lugn_govee_${d.id}_delivery/config`,
          {
            name: `${d.name} effektleverans`,
            unique_id: `lugn_govee_${d.id}_delivery`,
            state_topic: `lugn/govee/${d.id}/result`,
            value_template: '{{ value_json.status }}',
            json_attributes_topic: `lugn/govee/${d.id}/result`,
            entity_category: 'diagnostic',
            availability_topic: 'lugn/govee/availability',
            device: selectDiscovery(d, []).device,
          },
        );
        await publish(
          `lugn/govee/${d.id}/state`,
          state?.lighting.devices[d.target]?.externalControl
            ? active.get(d.id)?.controlId ===
              state.lighting.devices[d.target]?.externalControl?.id
              ? active.get(d.id)!.name
              : EXTERNAL_UNKNOWN
            : state
              ? RESUME_LUGN
              : EXTERNAL_UNKNOWN,
        );
      }
      // A clean subscription never replays old retained device commands.
      await client.subscribeAsync(
        config.devices.map((d) => `lugn/govee/${d.id}/set`),
        { qos: 0, rh: 2 },
      );
      await publish('lugn/govee/availability', state ? 'online' : 'offline');
    })().catch(() => console.error('Govee discovery publication failed'));
  });
  let queued = 0;
  let queue = Promise.resolve();
  client.on('message', (topic, bytes, packet) => {
    if (stopped || packet.retain || bytes.length > 1024 || queued >= 8) return;
    const d = config.devices.find((d) => topic === `lugn/govee/${d.id}/set`);
    if (!d) return;
    const name = bytes.toString();
    const effect = catalogs.get(d.id)?.get(name);
    if (name !== RESUME_LUGN && !effect) return;
    selectionRevision++;
    const commandGeneration = connectionGeneration;
    const assertSession = () => {
      if (
        stopped ||
        !client.connected ||
        commandGeneration !== connectionGeneration
      )
        throw new Error('MQTT command session expired');
    };
    queued++;
    queue = queue
      .then(async () => {
        assertSession();
        if (name === RESUME_LUGN) {
          await request('/capabilities/lighting.endExternalControl', {
            target: d.target,
          });
          active.delete(d.id);
        } else if (effect) {
          const ip = await lan.address(d.id);
          await lan.status(ip); // Require a live device before changing Lugn intent.
          const controlId = await applyEffect(d.target, effect, {
            begin: async (target) => {
              assertSession();
              return z.object({ controlId: z.string() }).parse(
                await request('/capabilities/lighting.beginExternalControl', {
                  target,
                }),
              ).controlId;
            },
            owns: async (target, id) => {
              const state = await readState();
              assertSession();
              return state.lighting.devices[target]?.externalControl?.id === id;
            },
            end: async (target, expectedControlId) => {
              await request('/capabilities/lighting.endExternalControl', {
                target,
                expectedControlId,
              });
            },
            send: async (e) => {
              assertSession();
              await lan.send(ip, encodeGoveeEffectCommand(e));
            },
          });
          active.set(d.id, { name, controlId });
        }
        await publish(`lugn/govee/${d.id}/state`, name);
        await publish(`lugn/govee/${d.id}/result`, {
          status: name === RESUME_LUGN ? 'lugn' : 'udp_sent',
          requested_effect: name,
          at: new Date().toISOString(),
          scene_feedback: 'not_available',
        });
      })
      .catch(async () => {
        console.error(`Govee effect command failed: ${d.id}`);
        await publish(`lugn/govee/${d.id}/result`, {
          status: 'error',
          requested_effect: name,
          at: new Date().toISOString(),
        });
      })
      .finally(() => {
        queued--;
      });
  });
  let polling = false;
  const timer = setInterval(() => {
    if (stopped || polling || !client.connected || queued > 0) return;
    polling = true;
    const revision = selectionRevision;
    const generation = connectionGeneration;
    void readState()
      .then(async (state) => {
        for (const d of config.devices) {
          if (
            queued > 0 ||
            revision !== selectionRevision ||
            generation !== connectionGeneration
          )
            return;
          const selection = active.get(d.id);
          const ownership = state.lighting.devices[d.target]?.externalControl;
          if (!ownership) active.delete(d.id);
          const name = ownership
            ? selection?.controlId === ownership.id
              ? selection.name
              : EXTERNAL_UNKNOWN
            : RESUME_LUGN;
          await publish(`lugn/govee/${d.id}/state`, name);
        }
        await publish('lugn/govee/availability', 'online');
      })
      .catch(() => publish('lugn/govee/availability', 'offline'))
      .finally(() => {
        polling = false;
      });
  }, 3000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    // Drop queued work; no resumption or light actuation during shutdown.
    await queue;
    lan.stop();
    if (client.connected)
      await client.publishAsync('lugn/govee/availability', 'offline', {
        qos: 0,
        retain: true,
      });
    await client.endAsync(true);
  };
}

async function main(): Promise<void> {
  const [runtimePath, bridgePath] = process.argv.slice(2);
  if (!runtimePath || !bridgePath)
    throw new Error('Pass Lugn config path and Govee bridge config path');
  const runtime = loadRuntimeConfig(runtimePath);
  const config = GoveeBridgeConfigSchema.parse(
    JSON.parse(await readFile(bridgePath, 'utf8')),
  );
  if (process.argv.includes('--probe')) {
    const lan = new GoveeLanTransport(config);
    await lan.start();
    try {
      for (const d of config.devices) {
        const all = await loadGoveeEffects(d.sku, config.cacheDirectory);
        const status = await lan.status(await lan.address(d.id));
        console.log(
          JSON.stringify({
            id: d.id,
            sku: d.sku,
            catalog: all.length,
            playable: playableEffects(all).length,
            status,
          }),
        );
      }
    } finally {
      lan.stop();
    }
    return;
  }
  const stop = await startGoveeBridge(runtime, config);
  let stopPlatform: (() => Promise<void>) | undefined;
  try {
    if (config.platform)
      stopPlatform = await startGoveePlatformBridge(runtime, config.platform);
  } catch (error) {
    await stop();
    throw error;
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void Promise.allSettled([stop(), stopPlatform?.()]).then(() =>
        process.exit(0),
      );
    });
  console.log(
    `Govee effect bridge ready: ${config.devices.length} LAN devices; ${config.platform?.devices.length ?? 0} platform devices`,
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  void main().catch(() => {
    console.error(
      'Govee bridge startup failed; check config, catalog cache, UDP port and MQTT',
    );
    process.exitCode = 1;
  });
