import { isDeepStrictEqual } from 'node:util';
import { connect, type MqttClient } from 'mqtt';
import { z } from 'zod';
import {
  GoveePlatformClient,
  PlatformIdentitySchema,
  platformCapability,
  platformControl,
  platformOnline,
  platformScenes,
  platformStateValue,
  platformToggle,
  type PlatformControl,
  type PlatformDevice,
  type PlatformScene,
  type PlatformState,
} from '../adapters/govee-platform.js';
import type { RuntimeConfig } from './config.js';

export const PLATFORM_RESUME_LUGN = 'Lugn';
export const PLATFORM_EXTERNAL_UNKNOWN = 'Extern (okänd effekt)';
const Id = z.string().regex(/^[a-z0-9_]{1,48}$/);
const ZoneSchema = z
  .object({
    id: Id,
    name: z.string().min(1).max(100),
    powerInstance: z.enum(['mainLightToggle', 'backgroundLightToggle']),
    segments: z
      .array(z.number().int().min(0).max(1023))
      .min(1)
      .max(1024)
      .optional(),
  })
  .strict()
  .refine(
    (zone) =>
      !zone.segments || new Set(zone.segments).size === zone.segments.length,
  );
const DeviceSchema = PlatformIdentitySchema.extend({
  id: Id,
  name: z.string().min(1).max(100),
  target: z.string().regex(/^lighting\.[a-z0-9_]+$/),
  zones: z.array(ZoneSchema).max(2).optional(),
  exposeEffects: z.boolean().default(true),
})
  .strict()
  .superRefine((device, context) => {
    for (const field of ['id', 'powerInstance'] as const)
      if (
        new Set(device.zones?.map((zone) => zone[field])).size !==
        (device.zones?.length ?? 0)
      )
        context.addIssue({
          code: 'custom',
          message: `Duplicate zone ${field}`,
        });
    const segments = device.zones?.flatMap((zone) => zone.segments ?? []) ?? [];
    if (new Set(segments).size !== segments.length)
      context.addIssue({
        code: 'custom',
        message: 'Overlapping zone segments',
      });
  });
export const GoveePlatformConfigSchema = z
  .object({
    apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    devices: z.array(DeviceSchema).min(1).max(16),
  })
  .strict()
  .superRefine((config, context) => {
    for (const field of ['id', 'target', 'device'] as const)
      if (
        new Set(config.devices.map((device) => device[field])).size !==
        config.devices.length
      )
        context.addIssue({
          code: 'custom',
          message: `Duplicate platform ${field}`,
        });
  });
export type GoveePlatformConfig = z.infer<typeof GoveePlatformConfigSchema>;
type BridgeDevice = GoveePlatformConfig['devices'][number];
export type PlatformZone = NonNullable<BridgeDevice['zones']>[number];
const Byte = z.number().int().min(0).max(255);
const ZoneCommandSchema = z
  .object({
    state: z.enum(['ON', 'OFF']).optional(),
    brightness: Byte.optional(),
    color: z.object({ r: Byte, g: Byte, b: Byte }).strict().optional(),
  })
  .strict()
  .refine((command) => Object.keys(command).length > 0)
  .refine(
    (command) => command.state !== 'OFF' || Object.keys(command).length === 1,
  );
const SEGMENT_TYPE = 'devices.capabilities.segment_color_setting';
const TOGGLE_TYPE = 'devices.capabilities.toggle';
const SCENE_TYPE = 'devices.capabilities.dynamic_scene';

export function resolvePlatformKey(
  name: string,
  environment: NodeJS.ProcessEnv,
): string {
  const value = environment[name];
  if (!value) throw new Error('Govee API key environment variable missing');
  const key = name.endsWith('_B64')
    ? Buffer.from(value, 'base64url').toString('utf8')
    : value;
  if (
    !key.trim() ||
    /[\0\r\n]/.test(key) ||
    (name.endsWith('_B64') && Buffer.from(key).toString('base64url') !== value)
  )
    throw new Error('Invalid Govee API key environment value');
  return key;
}
function numericRange(parameters?: Record<string, unknown>) {
  const range = z
    .object({
      min: z.number().int(),
      max: z.number().int(),
      precision: z.number().int().positive().default(1),
    })
    .refine((value) => value.min >= 0 && value.min < value.max)
    .safeParse(parameters?.['range']);
  return range.success ? range.data : undefined;
}
function segmentField(
  device: PlatformDevice,
  instance: string,
  fieldName: string,
) {
  const capability = platformCapability(device, SEGMENT_TYPE, instance);
  if (capability?.parameters['dataType'] !== 'STRUCT') return undefined;
  const fields = z
    .array(z.record(z.string(), z.unknown()))
    .safeParse(capability.parameters['fields']);
  return fields.success
    ? fields.data.find((field) => field['fieldName'] === fieldName)
    : undefined;
}
function brightnessValue(device: PlatformDevice, brightness: number): number {
  const range = numericRange(
    segmentField(device, 'segmentedBrightness', 'brightness'),
  );
  if (!range) throw new Error('Segment brightness unsupported');
  return Math.min(
    range.max,
    range.min +
      Math.round(
        ((brightness / 255) * (range.max - range.min)) / range.precision,
      ) *
        range.precision,
  );
}
export function platformZoneFeatures(
  device: PlatformDevice,
  zone: PlatformZone,
) {
  let power = false,
    brightness = false,
    rgb = false;
  try {
    platformToggle(device, zone.powerInstance, true);
    platformToggle(device, zone.powerInstance, false);
    power = true;
  } catch {
    /* Unsupported. */
  }
  if (zone.segments) {
    try {
      platformControl(device, SEGMENT_TYPE, 'segmentedBrightness', {
        segment: zone.segments,
        brightness: brightnessValue(device, 255),
      });
      brightness = true;
    } catch {
      /* Never substitute global brightness. */
    }
    try {
      platformControl(device, SEGMENT_TYPE, 'segmentedColorRgb', {
        segment: zone.segments,
        rgb: 0,
      });
      platformControl(device, SEGMENT_TYPE, 'segmentedColorRgb', {
        segment: zone.segments,
        rgb: 16777215,
      });
      rgb = true;
    } catch {
      /* Never substitute global RGB. */
    }
  }
  return { power, brightness, rgb };
}
/** Validates the whole command before lease acquisition or any physical write. */
export function platformZoneControls(
  device: PlatformDevice,
  zone: PlatformZone,
  input: unknown,
): PlatformControl[] {
  const command = ZoneCommandSchema.parse(input);
  const features = platformZoneFeatures(device, zone);
  if (
    !features.power ||
    (command.brightness !== undefined && !features.brightness) ||
    (command.color && !features.rgb)
  )
    throw new Error('Unsupported zone command');
  if (command.state === 'OFF' || command.brightness === 0)
    return [platformToggle(device, zone.powerInstance, false)];
  const controls: PlatformControl[] = [];
  if (command.state === 'ON')
    controls.push(platformToggle(device, zone.powerInstance, true));
  if (command.brightness !== undefined)
    controls.push(
      platformControl(device, SEGMENT_TYPE, 'segmentedBrightness', {
        segment: zone.segments,
        brightness: brightnessValue(device, command.brightness),
      }),
    );
  if (command.color)
    controls.push(
      platformControl(device, SEGMENT_TYPE, 'segmentedColorRgb', {
        segment: zone.segments,
        rgb: command.color.r * 65536 + command.color.g * 256 + command.color.b,
      }),
    );
  return controls;
}
export function platformEffectControls(
  device: PlatformDevice,
  scene: PlatformScene,
): PlatformControl[] {
  // A local Matter OFF can be newer than the cloud's historical power state.
  // Explicit fixture effects always request ON; zone commands never use this path.
  return [platformToggle(device, 'powerSwitch', true), scene.control];
}

function zonePower(
  device: PlatformDevice,
  zone: PlatformZone,
  state?: PlatformState,
): boolean | undefined {
  const value = platformStateValue(
    device,
    state,
    TOGGLE_TYPE,
    zone.powerInstance,
  );
  if (value === undefined) return undefined;
  try {
    if (
      isDeepStrictEqual(
        value,
        platformToggle(device, zone.powerInstance, true).value,
      )
    )
      return true;
    if (
      isDeepStrictEqual(
        value,
        platformToggle(device, zone.powerInstance, false).value,
      )
    )
      return false;
  } catch {
    /* Unsupported. */
  }
  return undefined;
}
/** No global state is used to fill missing zone feedback. */
export function platformZoneState(
  device: PlatformDevice,
  zone: PlatformZone,
  state?: PlatformState,
): Record<string, unknown> | undefined {
  const power = zonePower(device, zone, state);
  if (power === undefined) return undefined;
  const result: Record<string, unknown> = { state: power ? 'ON' : 'OFF' };
  for (const [instance, field] of [
    ['segmentedBrightness', 'brightness'],
    ['segmentedColorRgb', 'rgb'],
  ] as const) {
    const value = platformStateValue(device, state, SEGMENT_TYPE, instance);
    const parsed = z
      .object({ segment: z.array(z.number().int()) })
      .passthrough()
      .safeParse(value);
    if (
      !parsed.success ||
      !zone.segments ||
      parsed.data.segment.length !== zone.segments.length ||
      !zone.segments.every((segment) => parsed.data.segment.includes(segment))
    )
      continue;
    const raw = parsed.data[field];
    if (typeof raw !== 'number') continue;
    if (field === 'brightness') {
      const range = numericRange(segmentField(device, instance, field));
      if (range)
        result['brightness'] = Math.round(
          ((raw - range.min) / (range.max - range.min)) * 255,
        );
    } else {
      result['color_mode'] = 'rgb';
      result['color'] = {
        r: (raw >> 16) & 255,
        g: (raw >> 8) & 255,
        b: raw & 255,
      };
    }
  }
  return result;
}
export function platformEffectSelection(
  device: PlatformDevice,
  state: PlatformState | undefined,
  scenes: Map<string, PlatformScene>,
  controlId: string | undefined,
  knownControlId: string | undefined,
): string {
  if (!controlId) return PLATFORM_RESUME_LUGN;
  if (controlId !== knownControlId || !platformOnline(state))
    return PLATFORM_EXTERNAL_UNKNOWN;
  const values = state?.capabilities.filter(
    (capability) =>
      capability.type === SCENE_TYPE && capability.instance === 'lightScene',
  );
  const value = values?.length === 1 ? values[0]?.state.value : undefined;
  // The scene list supplies its exact value schema; unknown/empty feedback stays unknown.
  const matches = [...scenes].filter(([, scene]) =>
    isDeepStrictEqual(scene.control.value, value),
  );
  const power = platformStateValue(
    device,
    state,
    'devices.capabilities.on_off',
    'powerSwitch',
  );
  if (
    matches.length !== 1 ||
    !isDeepStrictEqual(power, platformToggle(device, 'powerSwitch', true).value)
  )
    return PLATFORM_EXTERNAL_UNKNOWN;
  return matches[0]![0];
}
const base = (device: BridgeDevice) => `lugn/govee/platform/${device.id}`;
const availability = (topic: string) => ({
  availability: [{ topic: 'lugn/govee/platform/availability' }, { topic }],
  availability_mode: 'all',
});
const deviceInfo = (device: BridgeDevice) => ({
  identifiers: [
    `lugn_govee_${device.device.replaceAll(':', '').toLowerCase()}`,
  ],
  name: device.name,
  manufacturer: 'Govee',
  model: device.sku,
});
export function platformSelectDiscovery(
  device: BridgeDevice,
  scenes: Map<string, PlatformScene>,
) {
  return {
    name: 'Appanimation',
    unique_id: `lugn_govee_platform_${device.id}_effect`,
    default_entity_id: `select.lugn_govee_${device.id}_effect`,
    command_topic: `${base(device)}/set`,
    state_topic: `${base(device)}/state`,
    json_attributes_topic: `${base(device)}/attributes`,
    ...availability(`${base(device)}/availability`),
    options: [
      PLATFORM_RESUME_LUGN,
      PLATFORM_EXTERNAL_UNKNOWN,
      ...scenes.keys(),
    ],
    device: deviceInfo(device),
    retain: false,
    qos: 0,
    icon: 'mdi:creation',
  };
}
export function platformZoneDiscovery(
  device: BridgeDevice,
  zone: PlatformZone,
  metadata: PlatformDevice,
) {
  const features = platformZoneFeatures(metadata, zone);
  return {
    name: zone.name,
    unique_id: `lugn_govee_platform_${device.id}_${zone.id}`,
    default_entity_id: `light.lugn_govee_${device.id}_${zone.id}`,
    schema: 'json',
    optimistic: false,
    retain: false,
    qos: 0,
    transition: false,
    command_topic: `${base(device)}/${zone.id}/set`,
    state_topic: `${base(device)}/${zone.id}/state`,
    json_attributes_topic: `${base(device)}/attributes`,
    ...availability(`${base(device)}/${zone.id}/availability`),
    brightness: features.brightness,
    supported_color_modes: [
      features.rgb ? 'rgb' : features.brightness ? 'brightness' : 'onoff',
    ],
    device: deviceInfo(device),
  };
}
export function platformZoneButtonDiscovery(
  device: BridgeDevice,
  zone: PlatformZone,
  on: boolean,
) {
  const action = on ? 'on' : 'off';
  return {
    name: `${zone.name} · ${on ? 'Slå på' : 'Släck'}`,
    unique_id: `lugn_govee_platform_${device.id}_${zone.id}_${action}`,
    default_entity_id: `button.lugn_govee_${device.id}_${zone.id}_${action}`,
    command_topic: `${base(device)}/${zone.id}/power/set`,
    payload_press: on ? 'ON' : 'OFF',
    ...availability(`${base(device)}/${zone.id}/command_availability`),
    retain: false,
    qos: 0,
    icon: on ? 'mdi:lightbulb-on' : 'mdi:lightbulb-off',
    device: deviceInfo(device),
  };
}
export type PlatformControlPort = {
  assertSession(): void;
  begin(target: string): Promise<string>;
  owns(target: string, id: string): Promise<boolean>;
  end(target: string, id: string): Promise<void>;
  send(control: PlatformControl, assertSession: () => void): Promise<void>;
};
export async function applyPlatformControls(
  target: string,
  controls: PlatformControl[],
  port: PlatformControlPort,
): Promise<string> {
  if (!controls.length) throw new Error('Empty Govee command');
  port.assertSession();
  const id = await port.begin(target);
  try {
    for (const control of controls) {
      port.assertSession();
      if (!(await port.owns(target, id)))
        throw new Error('External control superseded');
      port.assertSession();
      await port.send(control, port.assertSession);
    }
    return id;
  } catch (error) {
    try {
      port.assertSession();
      await port.end(target, id);
    } catch {
      /* Only a live session can clean up its own generation. */
    }
    throw error;
  }
}

type PlatformPort = Pick<
  GoveePlatformClient,
  'devices' | 'scenes' | 'state' | 'control'
>;
type BridgeDependencies = {
  connect?: typeof connect;
  fetch?: typeof fetch;
  platform?: PlatformPort;
  environment?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  followupDelayMs?: number;
};
const LugnStateSchema = z.object({
  lighting: z.object({
    devices: z.record(
      z.string(),
      z.object({
        externalControl: z.object({ id: z.string().min(1) }).optional(),
      }),
    ),
  }),
});

/** Independent cloud companion: transient API failures leave the local LAN bridge running. */
export async function startGoveePlatformBridge(
  runtime: RuntimeConfig,
  input: GoveePlatformConfig,
  dependencies: BridgeDependencies = {},
): Promise<() => Promise<void>> {
  const config = GoveePlatformConfigSchema.parse(input);
  if (!runtime.mqtt) throw new Error('MQTT required');
  for (const device of config.devices)
    if (!(device.target in runtime.homeAssistant.entities))
      throw new Error('Unmapped Govee platform target');
  const apiKey = resolvePlatformKey(
    config.apiKeyEnv,
    dependencies.environment ?? process.env,
  );
  const platform =
    dependencies.platform ??
    new GoveePlatformClient({
      apiKey,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
  const requestFetch = dependencies.fetch ?? fetch;
  const lugn = async (path: string, input?: unknown): Promise<unknown> => {
    const response = await requestFetch(
      `http://127.0.0.1:${runtime.http.port}${path}`,
      {
        headers: {
          'Content-Type': 'application/json',
          ...(runtime.http.bearerToken
            ? { Authorization: `Bearer ${runtime.http.bearerToken}` }
            : {}),
        },
        signal: AbortSignal.timeout(
          path.endsWith('/lighting.beginExternalControl') ? 35000 : 10000,
        ),
        ...(input === undefined
          ? {}
          : {
              method: 'POST',
              body: JSON.stringify({
                input,
                reason: 'Home Assistant Govee cloud controls',
              }),
            }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Lugn request failed');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing Lugn response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 262144) throw new Error('Lugn response too large');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  };
  const readLugn = async () => LugnStateSchema.parse(await lugn('/state'));
  const client: MqttClient = (dependencies.connect ?? connect)(
    runtime.mqtt.url,
    {
      ...(runtime.mqtt.username === undefined
        ? {}
        : { username: runtime.mqtt.username }),
      ...(runtime.mqtt.password === undefined
        ? {}
        : { password: runtime.mqtt.password }),
      clientId: 'lugn-govee-platform',
      clean: true,
      queueQoSZero: false,
      reconnectPeriod: 2000,
      connectTimeout: 10000,
      resubscribe: false,
      will: {
        topic: 'lugn/govee/platform/availability',
        payload: Buffer.from('offline'),
        retain: true,
        qos: 1,
      },
    },
  );
  let stopped = false,
    generation = 0,
    revision = 0,
    queued = 0,
    polling = false;
  let queue = Promise.resolve();
  const pollInterval = dependencies.pollIntervalMs ?? 60000;
  const metadata = new Map<string, PlatformDevice>();
  const catalogs = new Map<string, Map<string, PlatformScene>>();
  const states = new Map<string, PlatformState>();
  const knownControls = new Map<string, string>();
  const discoveryCache = new Map<string, string>();
  const followups = new Set<ReturnType<typeof setTimeout>>();
  let nextCatalogAttempt = 0;
  const connected = () => !stopped && client.connected;
  const publish = async (
    topic: string,
    value: unknown,
    valid: () => boolean,
  ) => {
    if (!valid()) return;
    await client.publishAsync(
      topic,
      typeof value === 'string' ? value : JSON.stringify(value),
      { qos: 0, retain: true },
    );
  };
  const discover = async (
    topic: string,
    value: unknown,
    valid: () => boolean,
  ) => {
    const json = JSON.stringify(value);
    if (!valid() || discoveryCache.get(topic) === json) return;
    await publish(topic, json, valid);
    if (valid()) discoveryCache.set(topic, json);
  };
  const loadCatalogs = async () => {
    if (
      Date.now() < nextCatalogAttempt ||
      config.devices.every(
        (device) =>
          metadata.has(device.id) &&
          (!device.exposeEffects || catalogs.has(device.id)),
      )
    )
      return;
    nextCatalogAttempt = Date.now() + pollInterval;
    const available = await platform.devices();
    for (const device of config.devices) {
      const matches = available.filter(
        (candidate) =>
          candidate.device === device.device && candidate.sku === device.sku,
      );
      if (matches.length !== 1) continue;
      const info = matches[0]!;
      metadata.set(device.id, info);
      if (!device.exposeEffects || catalogs.has(device.id)) continue;
      try {
        const dynamic = platformScenes(await platform.scenes(device));
        const scenes = new Map([
          ...platformScenes(info.capabilities),
          ...dynamic,
        ]);
        for (const name of scenes.keys())
          if (
            [PLATFORM_RESUME_LUGN, PLATFORM_EXTERNAL_UNKNOWN].includes(name) ||
            ['off', 'none'].includes(name.trim().toLowerCase())
          )
            scenes.delete(name);
        catalogs.set(device.id, scenes);
      } catch {
        /* Retry missing scene catalog on the next bounded interval. */
      }
    }
  };
  const refresh = async (onlyId?: string) => {
    if (!connected() || polling || queued > 0) return;
    polling = true;
    const currentGeneration = generation,
      currentRevision = revision;
    const valid = () =>
      connected() &&
      generation === currentGeneration &&
      revision === currentRevision &&
      queued === 0;
    try {
      await loadCatalogs().catch(() => undefined);
      const state = await readLugn().catch(() => undefined);
      for (const device of config.devices) {
        if (onlyId && device.id !== onlyId) continue;
        const info = metadata.get(device.id);
        const scenes =
          catalogs.get(device.id) ?? new Map<string, PlatformScene>();
        const feedback = info
          ? await platform.state(device).catch(() => undefined)
          : undefined;
        if (!valid()) return;
        if (feedback) states.set(device.id, feedback);
        else states.delete(device.id);
        const lugnDevice = state?.lighting.devices[device.target];
        if (device.exposeEffects) {
          await discover(
            `homeassistant/select/lugn_govee_platform_${device.id}_effect/config`,
            platformSelectDiscovery(device, scenes),
            valid,
          );
          await publish(
            `${base(device)}/availability`,
            lugnDevice && platformOnline(feedback) && scenes.size
              ? 'online'
              : 'offline',
            valid,
          );
          if (info && lugnDevice) {
            let selection = PLATFORM_EXTERNAL_UNKNOWN;
            try {
              selection = platformEffectSelection(
                info,
                feedback,
                scenes,
                lugnDevice.externalControl?.id,
                knownControls.get(device.id),
              );
            } catch {
              /* Unknown power schema. */
            }
            await publish(`${base(device)}/state`, selection, valid);
          }
        }
        await discover(
          `homeassistant/sensor/lugn_govee_platform_${device.id}_delivery/config`,
          {
            name: 'Leveransstatus',
            unique_id: `lugn_govee_platform_${device.id}_delivery`,
            state_topic: `${base(device)}/result`,
            value_template: '{{ value_json.last_result }}',
            json_attributes_topic: `${base(device)}/result`,
            entity_category: 'diagnostic',
            availability_topic: 'lugn/govee/platform/availability',
            device: deviceInfo(device),
          },
          valid,
        );
        for (const zone of device.zones ?? []) {
          // Missing metadata advertises only a disabled power proxy until the API recovers.
          const discoveryInfo = info ?? {
            sku: device.sku,
            device: device.device,
            capabilities: [],
          };
          await discover(
            `homeassistant/light/lugn_govee_platform_${device.id}_${zone.id}/config`,
            platformZoneDiscovery(device, zone, discoveryInfo),
            valid,
          );
          for (const on of [true, false]) {
            await discover(
              `homeassistant/button/lugn_govee_platform_${device.id}_${zone.id}_${on ? 'on' : 'off'}/config`,
              platformZoneButtonDiscovery(device, zone, on),
              valid,
            );
          }
          await publish(
            `${base(device)}/${zone.id}/command_availability`,
            lugnDevice &&
              platformOnline(feedback) &&
              info &&
              platformZoneFeatures(info, zone).power
              ? 'online'
              : 'offline',
            valid,
          );
          const zoneState = info
            ? platformZoneState(info, zone, feedback)
            : undefined;
          await publish(
            `${base(device)}/${zone.id}/availability`,
            lugnDevice && zoneState ? 'online' : 'offline',
            valid,
          );
          if (zoneState)
            await publish(`${base(device)}/${zone.id}/state`, zoneState, valid);
        }
        await publish(
          `${base(device)}/attributes`,
          {
            state_feedback:
              feedback && platformOnline(feedback)
                ? 'platform_state'
                : 'unavailable',
            polled_at: new Date().toISOString(),
            effects: scenes.size,
          },
          valid,
        );
      }
      await publish(
        'lugn/govee/platform/availability',
        state ? 'online' : 'offline',
        valid,
      );
    } catch {
      await publish('lugn/govee/platform/availability', 'offline', valid).catch(
        () => undefined,
      );
    } finally {
      polling = false;
    }
  };
  client.on('close', () => {
    generation++;
  });
  client.on('offline', () => {
    generation++;
  });
  client.on('error', () =>
    console.error('Govee platform MQTT connection error'),
  );
  client.on('connect', () => {
    generation++;
    discoveryCache.clear();
    const currentGeneration = generation;
    void (async () => {
      await publish('lugn/govee/platform/availability', 'offline', connected);
      await client.subscribeAsync(
        config.devices.flatMap((device) => [
          ...(device.exposeEffects ? [`${base(device)}/set`] : []),
          ...(device.zones ?? []).flatMap((zone) => [
            `${base(device)}/${zone.id}/set`,
            `${base(device)}/${zone.id}/power/set`,
          ]),
        ]),
        { qos: 0, rh: 2 },
      );
      if (currentGeneration === generation) await refresh();
    })().catch(() => console.error('Govee platform discovery failed'));
  });
  client.on('message', (topic, bytes, packet) => {
    if (!connected() || packet.retain || bytes.length > 2048 || queued >= 8)
      return;
    const device = config.devices.find(
      (device) =>
        (device.exposeEffects && topic === `${base(device)}/set`) ||
        device.zones?.some(
          (zone) =>
            topic === `${base(device)}/${zone.id}/set` ||
            topic === `${base(device)}/${zone.id}/power/set`,
        ),
    );
    if (!device) return;
    const zone = device.zones?.find(
      (zone) =>
        topic === `${base(device)}/${zone.id}/set` ||
        topic === `${base(device)}/${zone.id}/power/set`,
    );
    const info = metadata.get(device.id),
      scenes = catalogs.get(device.id);
    const name = bytes.toString();
    let controls: PlatformControl[] = [];
    try {
      if (zone) {
        if (!info) return;
        const powerButton = topic === `${base(device)}/${zone.id}/power/set`;
        controls = platformZoneControls(
          info,
          zone,
          powerButton ? { state: name } : JSON.parse(name),
        );
      } else if (name !== PLATFORM_RESUME_LUGN) {
        const scene = scenes?.get(name);
        if (!info || !scene) return;
        controls = platformEffectControls(info, scene);
      }
    } catch {
      return;
    }
    const commandGeneration = generation;
    const assertSession = () => {
      if (!connected() || generation !== commandGeneration)
        throw new Error('MQTT command session expired');
    };
    revision++;
    queued++;
    queue = queue
      .then(async () => {
        assertSession();
        if (!zone && name === PLATFORM_RESUME_LUGN) {
          const state = await readLugn();
          assertSession();
          const id = state.lighting.devices[device.target]?.externalControl?.id;
          if (id) {
            await lugn('/capabilities/lighting.endExternalControl', {
              target: device.target,
              expectedControlId: id,
            });
            knownControls.delete(device.id);
          }
        } else {
          const id = await applyPlatformControls(device.target, controls, {
            assertSession,
            begin: async (target) => {
              assertSession();
              return z
                .object({
                  accepted: z.literal(true),
                  controlId: z.string().min(1),
                })
                .parse(
                  await lugn('/capabilities/lighting.beginExternalControl', {
                    target,
                    activate: false,
                  }),
                ).controlId;
            },
            owns: async (target, id) =>
              (await readLugn()).lighting.devices[target]?.externalControl
                ?.id === id,
            end: async (target, id) => {
              assertSession();
              await lugn('/capabilities/lighting.endExternalControl', {
                target,
                expectedControlId: id,
              });
            },
            send: async (control, guard) => {
              assertSession();
              await platform.control(device, control, guard);
            },
          });
          knownControls.set(device.id, id);
        }
        assertSession();
        await publish(
          `${base(device)}/result`,
          {
            last_result:
              name === PLATFORM_RESUME_LUGN ? 'lugn' : 'cloud_accepted',
            at: new Date().toISOString(),
            feedback: 'separate_platform_state',
          },
          () => connected() && generation === commandGeneration,
        );
      })
      .catch(async () => {
        console.error(`Govee platform command failed: ${device.id}`);
        await publish(
          `${base(device)}/result`,
          { last_result: 'error', at: new Date().toISOString() },
          () => connected() && generation === commandGeneration,
        ).catch(() => undefined);
      })
      .finally(() => {
        queued--;
        if (!queued && !stopped) {
          void refresh(device.id);
          const followupRevision = revision;
          const followup = setTimeout(() => {
            followups.delete(followup);
            if (
              revision === followupRevision &&
              generation === commandGeneration
            )
              void refresh(device.id);
          }, dependencies.followupDelayMs ?? 2500);
          followups.add(followup);
        }
      });
  });
  const timer = setInterval(() => {
    void refresh();
  }, pollInterval);
  return async () => {
    stopped = true;
    generation++;
    clearInterval(timer);
    for (const followup of followups) clearTimeout(followup);
    await queue;
    try {
      if (client.connected)
        await client.publishAsync(
          'lugn/govee/platform/availability',
          'offline',
          { qos: 0, retain: true },
        );
    } finally {
      await client.endAsync(true);
    }
  };
}
