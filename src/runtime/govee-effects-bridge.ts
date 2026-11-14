import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect, type MqttClient } from 'mqtt';
import { performance } from 'node:perf_hooks';
import { GoveeLanTransport } from './govee-lan-transport.js';
import { sendGoveeLanEffect } from './govee-lan-playback.js';
export { GoveeLanTransport } from './govee-lan-transport.js';
import {
  GoveeWriteCoordinator,
  startGoveeControlServer,
} from './govee-control-server.js';
import {
  combineGoveePresetControls,
  type GoveePresetControls,
} from './govee-preset-controls.js';
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
    json_attributes_topic: `${base}/feedback`,
    availability: [
      { topic: 'lugn/govee/availability' },
      { topic: `${base}/availability` },
    ],
    availability_mode: 'all',
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
  options: {
    coordinator?: GoveeWriteCoordinator;
    ready?: (
      controls: GoveePresetControls,
      owns: (target: string, id: string) => Promise<boolean>,
    ) => void;
  } = {},
): Promise<() => Promise<void>> {
  if (!runtime.mqtt) throw new Error('MQTT required');
  for (const d of config.devices)
    if (!(d.target in runtime.homeAssistant.entities))
      throw new Error('Unmapped Govee target');
  const coordinator = options.coordinator ?? new GoveeWriteCoordinator();
  const catalogs = new Map<string, Map<string, GoveeEffect>>();
  await Promise.all(
    config.devices.map(async (d) => {
      catalogs.set(
        d.id,
        effectOptions(
          playableEffects(await loadGoveeEffects(d.sku, config.cacheDirectory)),
        ),
      );
    }),
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
  const readState = async (target?: string) =>
    z
      .object({
        lighting: z.object({
          devices: z.record(
            z.string(),
            z
              .object({
                effectiveDesired: z
                  .object({ power: z.boolean().optional() })
                  .optional(),
                govee: z
                  .object({ controlId: z.string().optional() })
                  .optional(),
                externalControl: z
                  .object({
                    id: z.string(),
                    canActivate: z.boolean().optional(),
                  })
                  .passthrough()
                  .optional(),
              })
              .passthrough(),
          ),
        }),
      })
      .parse(
        await request(
          target
            ? `/state?lightingTarget=${encodeURIComponent(target)}`
            : '/state?lightingOnly=1',
        ),
      );
  options.ready?.(
    {
      capabilities: () =>
        Object.fromEntries(
          config.devices.map((d) => [
            d.target,
            {
              effects: [...catalogs.get(d.id)!.keys()],
              zones: false,
              ...(d.sku === 'H60A6'
                ? { colorTemperature: { min: 2700, max: 6500 } }
                : {}),
            },
          ]),
        ),
      apply: async (command, guard) => {
        const d = config.devices.find((d) => d.target === command.target);
        const effect =
          d && command.effect !== undefined
            ? catalogs.get(d.id)?.get(command.effect)
            : undefined;
        if (!d || !effect || command.zones)
          throw new Error('Unsupported LAN preset');
        const { ip } = await lan.ensureReachable(d.id);
        await guard();
        await lan.send(ip, encodeGoveeEffectCommand(effect));
        return { transport: 'lan', effect: 'udp_sent' };
      },
    },
    async (target, id) => {
      const d = (await readState(target)).lighting.devices[target];
      return Boolean(
        d &&
        !d.externalControl &&
        d.govee?.controlId === id &&
        d.effectiveDesired?.power === true,
      );
    },
  );
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
  const contactChecks = new Set<string>();
  const feedback = (status: {
    onOff: 0 | 1;
    brightness: number;
    color: { r: number; g: number; b: number };
    colorTemInKelvin: number;
  }) => ({
    observed_at: new Date().toISOString(),
    power: status.onOff === 1,
    brightness: status.brightness,
    rgb: [status.color.r, status.color.g, status.color.b],
    kelvin: status.colorTemInKelvin,
    scope: 'fixture_status_only',
    scene_feedback: 'not_available',
  });
  const checkContact = async (d: GoveeBridgeDevice) => {
    if (stopped || contactChecks.has(d.id)) return;
    contactChecks.add(d.id);
    try {
      const { status } = await lan.ensureReachable(d.id);
      await publish(`lugn/govee/${d.id}/availability`, 'online');
      await publish(`lugn/govee/${d.id}/feedback`, feedback(status));
    } catch {
      await publish(`lugn/govee/${d.id}/availability`, 'offline');
    } finally {
      contactChecks.delete(d.id);
    }
  };

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
      for (const d of config.devices) void checkContact(d);
      // A clean subscription never replays old retained device commands.
      await client.subscribeAsync(
        config.devices.map((d) => `lugn/govee/${d.id}/set`),
        { qos: 0, rh: 2 },
      );
      await publish('lugn/govee/availability', state ? 'online' : 'offline');
    })().catch(() => console.error('Govee discovery publication failed'));
  });
  let queued = 0;
  const queues = new Map<string, Promise<void>>();
  const commandRevisions = new Map<string, number>();
  client.on('message', (topic, bytes, packet) => {
    if (stopped || packet.retain || bytes.length > 1024 || queued >= 8) return;
    const d = config.devices.find((d) => topic === `lugn/govee/${d.id}/set`);
    if (!d) return;
    const name = bytes.toString();
    const effect = catalogs.get(d.id)?.get(name);
    if (name !== RESUME_LUGN && !effect) return;
    selectionRevision++;
    const receivedAt = performance.now();
    const commandRevision = (commandRevisions.get(d.id) ?? 0) + 1;
    commandRevisions.set(d.id, commandRevision);
    const commandGeneration = connectionGeneration;
    const assertSession = () => {
      if (
        stopped ||
        !client.connected ||
        commandGeneration !== connectionGeneration ||
        commandRevisions.get(d.id) !== commandRevision
      )
        throw new Error('MQTT command session expired');
    };
    queued++;
    const queue = (queues.get(d.id) ?? Promise.resolve())
      .then(async () => {
        assertSession();
        if (name === RESUME_LUGN) {
          await request('/capabilities/lighting.endExternalControl', {
            target: d.target,
          });
          active.delete(d.id);
        } else if (effect) {
          const { ip } = await lan.ensureReachable(d.id); // Live read before changing intent.
          let liveControlId: string | undefined;
          let nativeActivation = false;
          const controlId = await applyEffect(d.target, effect, {
            begin: async (target) => {
              assertSession();
              liveControlId = z.object({ controlId: z.string() }).parse(
                await request('/capabilities/lighting.beginExternalControl', {
                  target,
                  activate: false,
                }),
              ).controlId;
              try {
                const control = (await readState(target)).lighting.devices[
                  target
                ]?.externalControl;
                if (
                  control?.id !== liveControlId ||
                  control.canActivate === false
                )
                  throw new Error('External activation revoked');
                nativeActivation = control.canActivate === true;
                if (!nativeActivation) {
                  // Older Lugn versions lack the revocable native activation grant.
                  liveControlId = z
                    .object({ controlId: z.string() })
                    .parse(
                      await request(
                        '/capabilities/lighting.beginExternalControl',
                        { target },
                      ),
                    ).controlId;
                }
                return liveControlId;
              } catch (error) {
                await request('/capabilities/lighting.endExternalControl', {
                  target,
                  expectedControlId: liveControlId,
                }).catch(() => undefined);
                throw error;
              }
            },
            owns: async (target, id) => {
              const state = await readState(target);
              assertSession();
              const control = state.lighting.devices[target]?.externalControl;
              return control?.id === id && control.canActivate !== false;
            },
            end: async (target, expectedControlId) => {
              await request('/capabilities/lighting.endExternalControl', {
                target,
                expectedControlId,
              });
            },
            send: async (e) => {
              assertSession();
              await coordinator.run(
                d.target,
                liveControlId!,
                async () => {
                  assertSession();
                  const control = (await readState(d.target)).lighting.devices[
                    d.target
                  ]?.externalControl;
                  return (
                    control !== undefined &&
                    control.id === liveControlId &&
                    control.canActivate !== false
                  );
                },
                async (guard) => {
                  await sendGoveeLanEffect(
                    ip,
                    e,
                    {
                      guard,
                      status: (ip) => lan.status(ip),
                      send: (ip, command) => lan.send(ip, command),
                    },
                    nativeActivation,
                  );
                },
              );
            },
          });
          active.set(d.id, { name, controlId });
          void lan
            .status(ip)
            .then(async (feedback) => {
              if (
                stopped ||
                commandRevisions.get(d.id) !== commandRevision ||
                active.get(d.id)?.controlId !== controlId
              )
                return;
              await publish(`lugn/govee/${d.id}/feedback`, {
                observed_at: new Date().toISOString(),
                control_id: controlId,
                power: feedback.onOff === 1,
                brightness: feedback.brightness,
                rgb: [feedback.color.r, feedback.color.g, feedback.color.b],
                kelvin: feedback.colorTemInKelvin,
                scope: 'fixture_status_only',
                scene_feedback: 'not_available',
              });
            })
            .catch(() => undefined);
        }
        assertSession();
        await publish(`lugn/govee/${d.id}/state`, name);
        await publish(`lugn/govee/${d.id}/result`, {
          status: name === RESUME_LUGN ? 'lugn' : 'udp_sent',
          requested_effect: name,
          at: new Date().toISOString(),
          scene_feedback: 'not_available',
          duration_ms: Math.round((performance.now() - receivedAt) * 100) / 100,
        });
      })
      .catch(async () => {
        if (commandRevisions.get(d.id) !== commandRevision) return;
        console.error(`Govee effect command failed: ${d.id}`);
        await publish(`lugn/govee/${d.id}/result`, {
          status: 'error',
          requested_effect: name,
          at: new Date().toISOString(),
        });
      })
      .finally(() => {
        queued--;
        if (queues.get(d.id) === queue) queues.delete(d.id);
      });
    queues.set(d.id, queue);
  });
  let polling = false;
  let lastContactCheck = 0;
  const timer = setInterval(() => {
    if (stopped || polling || !client.connected || queued > 0) return;
    polling = true;
    if (Date.now() - lastContactCheck >= 15000) {
      lastContactCheck = Date.now();
      for (const d of config.devices) void checkContact(d);
    }
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
    await Promise.allSettled(queues.values());
    if (!options.coordinator) await coordinator.stop();
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
  const coordinator = new GoveeWriteCoordinator();
  let localControls: GoveePresetControls | undefined;
  let platformControls: GoveePresetControls | undefined;
  let ownsPreset:
    ((target: string, id: string) => Promise<boolean>) | undefined;
  const stop = await startGoveeBridge(runtime, config, {
    coordinator,
    ready: (controls, owns) => {
      localControls = controls;
      ownsPreset = owns;
    },
  });
  let stopPlatform: (() => Promise<void>) | undefined;
  let server: Awaited<ReturnType<typeof startGoveeControlServer>> | undefined;
  try {
    if (config.platform)
      stopPlatform = await startGoveePlatformBridge(runtime, config.platform, {
        coordinator,
        ready: (controls) => {
          platformControls = controls;
        },
      });
    if (!localControls || !ownsPreset)
      throw new Error('Govee preset controls unavailable');
    const controls = combineGoveePresetControls(
      localControls,
      platformControls,
    );
    server = await startGoveeControlServer({
      socketPath: join(config.cacheDirectory, 'control.sock'),
      coordinator,
      capabilities: () => controls.capabilities(),
      owns: ownsPreset,
      apply: (command, guard) => controls.apply(command, guard),
    });
  } catch (error) {
    await Promise.allSettled([stop(), stopPlatform?.(), coordinator.stop()]);
    throw error;
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void Promise.allSettled([server?.stop(), stop(), stopPlatform?.()]).then(
        () => process.exit(0),
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
