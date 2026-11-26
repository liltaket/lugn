import { parseAlbumToken } from './icloud-shared-album.js';
import {
  CameraDashboardConfigSchema,
  type CameraDashboardConfig,
} from '../core/cameras.js';
import { HomeAssistantMusicMappingsSchema } from '../adapters/home-assistant-music.js';
import {
  WiimMusicMappingSchema,
  WiimMusicMappingsSchema,
} from '../adapters/wiim-music.js';
import { HomeAssistantEnvironmentMappingsSchema } from '../adapters/home-assistant-environment.js';
import { HomeAssistantPrinterConfigSchema } from '../adapters/home-assistant-printer.js';
import { HomeAssistantHomePresenceConfigSchema } from '../adapters/home-assistant-home-presence.js';
import { HomeAssistantButtonMappingsSchema } from '../adapters/home-assistant-button.js';
import { HomeAssistantBilresaConfigSchema } from '../adapters/home-assistant-bilresa.js';
import {
  AssistantEntitiesConfigSchema,
  type ResolvedAssistantEntitiesConfig,
} from '../adapters/assistant-entities-mqtt.js';
import { WledCctMappingsSchema } from '../adapters/wled-cct.js';
import { DynamicLightingConfigSchema } from '../core/dynamic-lighting.js';
import { HomeAssistantWeatherConfigSchema } from '../adapters/home-assistant-weather.js';
import {
  GreetingsConfigSchema,
  type GreetingsConfig,
} from '../core/greetings.js';
import { HubRulesSchema, type HubRule } from '../core/hub-rules.js';
import { PresenceControlConfigSchema } from '../adapters/stl27l-presence-control.js';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import { defaultScenes } from '../application/lugn-engine.js';
import { clerkFrontendApiOrigin } from './clerk-auth.js';
import {
  SceneSchema,
  SemanticLightingIdSchema,
  SemanticMusicIdSchema,
  SemanticSwitchIdSchema,
  LightingValuesSchema,
  LightingControlModesSchema,
  type LightingControlModes,
  type LightingScene,
  type LightingValues,
} from '../core/schemas.js';
import { ComputerDeviceIdSchema } from '../core/computer.js';
import { PowerSensorThresholdsSchema } from '../core/display-power.js';
import {
  OpticalSwitchSettingsSchema,
  defaultOpticalSwitchSettings,
  type OpticalSwitchSettings,
} from '../core/optical-switch-settings.js';
import {
  WindowLightingSchema,
  type WindowLighting,
} from '../core/window-lighting.js';

const EnvironmentNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const ClerkConfigSchema = z
  .object({
    publishableKeyEnv: EnvironmentNameSchema,
    secretKeyEnv: EnvironmentNameSchema,
    allowedUserIdsEnv: EnvironmentNameSchema,
  })
  .strict();
const TrustedOriginSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    let origin: URL;
    try {
      origin = new URL(value);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'trustedOrigins entries must be valid HTTP or HTTPS origins',
      });
      return;
    }
    if (
      (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
      origin.origin !== value ||
      origin.username ||
      origin.password
    )
      context.addIssue({
        code: 'custom',
        message: 'trustedOrigins entries must be bare HTTP or HTTPS origins',
      });
  });

const DisplayPowerConfigSchema = z
  .object({
    /** Confirmed-empty time before Lugn asks the computer to sleep its display. */
    offAfterEmptyMs: z
      .number()
      .int()
      .min(10_000)
      .max(86_400_000)
      .default(120_000),
    /** Open-loop fallback only (no display state from the agent): repeat interval. */
    reassertOffMs: z
      .number()
      .int()
      .min(60_000)
      .max(86_400_000)
      .default(900_000),
    /** While nobody is home, keep ensuring the display is off. */
    ensureOffWhenAway: z.boolean().default(true),
    wakeOnEntry: z.boolean().default(true),
    wakeInQuietHours: z.boolean().default(false),
    /** In quiet hours, still wake after an absence of at most this long. */
    quietWakeMaxAbsenceMs: z
      .number()
      .int()
      .min(0)
      .max(86_400_000)
      .default(1_200_000),
    inhibitOnActivity: z.boolean().default(true),
    /**
     * Put the display to sleep after this long without keyboard or pointer
     * input, whatever the room reads, unless video, a game or an unknown idle
     * blocker is active. `null` turns it off.
     */
    idleSleepAfterMs: z
      .number()
      .int()
      .min(300_000)
      .max(86_400_000)
      .nullable()
      .default(1_800_000),
    /** Idle blockers (by application name) that never keep the display on. */
    ignoreIdleBlockers: z.array(z.string().min(1).max(64)).max(16).default([]),
    activeInhibitMaxMs: z
      .number()
      .int()
      .min(0)
      .max(86_400_000)
      .default(1_800_000),
    /**
     * Optional Home Assistant power sensor (a measuring smart plug on the
     * monitor). Evidence only: Lugn never switches the plug.
     */
    powerSensor: z
      .object({
        entityId: z.string().regex(/^sensor\.[a-z0-9_]+$/),
        onAboveWatts: z.number().finite().positive(),
        standbyBelowWatts: z.number().finite().nonnegative(),
        settleMs: z.number().int().min(0).max(600_000).default(20_000),
      })
      .strict()
      .superRefine((sensor, context) => {
        const parsed = PowerSensorThresholdsSchema.safeParse(sensor);
        if (!parsed.success)
          for (const issue of parsed.error.issues)
            context.addIssue({
              code: 'custom',
              path: issue.path,
              message: issue.message,
            });
      })
      .optional(),
  })
  .strict()
  .refine((display) => display.reassertOffMs >= display.offAfterEmptyMs / 2, {
    path: ['reassertOffMs'],
    message: 'reassertOffMs must not be much shorter than offAfterEmptyMs',
  });

export type DisplayPowerConfig = z.output<typeof DisplayPowerConfigSchema>;

/**
 * Fast WiiM Optical switching in the computer's agent. On by default: with no
 * address the agent finds the WiiM itself. These are the defaults; the control
 * panel's saved values win.
 */
const OpticalSwitchConfigSchema = z
  .object({
    enabled: OpticalSwitchSettingsSchema.shape.enabled.default(
      defaultOpticalSwitchSettings().enabled,
    ),
    wiimHost: OpticalSwitchSettingsSchema.shape.wiimHost.default(
      defaultOpticalSwitchSettings().wiimHost,
    ),
    audioSink: OpticalSwitchSettingsSchema.shape.audioSink.default(
      defaultOpticalSwitchSettings().audioSink,
    ),
    minAudibleMs: OpticalSwitchSettingsSchema.shape.minAudibleMs.default(
      defaultOpticalSwitchSettings().minAudibleMs,
    ),
    releaseMs: OpticalSwitchSettingsSchema.shape.releaseMs.default(
      defaultOpticalSwitchSettings().releaseMs,
    ),
    levelDb: OpticalSwitchSettingsSchema.shape.levelDb.default(
      defaultOpticalSwitchSettings().levelDb,
    ),
  })
  .strict();

const ComputerMqttConfigSchema = z
  .object({
    deviceId: ComputerDeviceIdSchema,
    baseTopic: z
      .string()
      .min(1)
      .superRefine((value, context) => {
        if (value.includes('+') || value.includes('#') || value.includes('\0'))
          context.addIssue({
            code: 'custom',
            message: 'baseTopic must be a concrete MQTT topic prefix',
          });
        if (value.replace(/\/+$/, '').length === 0)
          context.addIssue({
            code: 'custom',
            message:
              'baseTopic must not be empty after removing trailing slashes',
          });
      })
      .transform((value) => value.replace(/\/+$/, ''))
      .default('lugn/computers'),
    maxAgeMs: z.number().int().min(1_000).max(300_000).default(90_000),
    /** Opt-in display sleep/wake over DISPLAY v1; requires MQTT credentials. */
    display: DisplayPowerConfigSchema.optional(),
    /** Publishes optical switch settings to the agent; on unless `enabled: false`. */
    opticalSwitch: OpticalSwitchConfigSchema.prefault({}),
  })
  .strict();

const HomeAssistantConfigSchema = z
  .object({
    baseUrl: z.string().superRefine((value, context) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'baseUrl must be a valid URL',
        });
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          message: 'baseUrl must use HTTP or HTTPS',
        });
      }
      if (url.username || url.password || url.search || url.hash) {
        context.addIssue({
          code: 'custom',
          message: 'baseUrl cannot contain credentials, a query, or a fragment',
        });
      }
    }),
    tokenEnv: EnvironmentNameSchema,
    homePresence: HomeAssistantHomePresenceConfigSchema.default({
      entity: 'device_tracker.lustigkurre',
    }),
    entities: z.record(
      SemanticLightingIdSchema,
      z.string().regex(/^light\.[a-z0-9_]+$/),
    ),
    wledCct: WledCctMappingsSchema.default({}),
    buttons: HomeAssistantButtonMappingsSchema.default({}),
    bilresa: HomeAssistantBilresaConfigSchema.default(
      HomeAssistantBilresaConfigSchema.parse({}),
    ),
    music: HomeAssistantMusicMappingsSchema.default({}),
    environment: HomeAssistantEnvironmentMappingsSchema.default({
      temperature: 'sensor.alpstuga_air_quality_monitor_temperatur',
      humidity: 'sensor.alpstuga_air_quality_monitor_luftfuktighet',
      co2: 'sensor.alpstuga_air_quality_monitor_koldioxid',
      pm25: 'sensor.alpstuga_air_quality_monitor_pm25',
    }),
    printer: HomeAssistantPrinterConfigSchema.optional(),
    weather: HomeAssistantWeatherConfigSchema.optional(),
    switches: z
      .record(SemanticSwitchIdSchema, z.string().regex(/^switch\.[a-z0-9_]+$/))
      .default({}),
  })
  .strict();

const MqttConfigSchema = z
  .object({
    url: z.string().superRefine((value, context) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        context.addIssue({ code: 'custom', message: 'url must be a URL' });
        return;
      }
      if (url.protocol !== 'mqtt:' && url.protocol !== 'mqtts:') {
        context.addIssue({
          code: 'custom',
          message: 'url must use mqtt: or mqtts:',
        });
      }
      if (url.username || url.password || url.search || url.hash) {
        context.addIssue({
          code: 'custom',
          message: 'url cannot contain credentials, a query, or a fragment',
        });
      }
    }),
    usernameEnv: EnvironmentNameSchema.optional(),
    passwordEnv: EnvironmentNameSchema.optional(),
    clientId: z.string().min(1).max(128).optional(),
    baseTopic: z.string().min(1).default('bruno/doorway'),
    maxAgeMs: z.number().int().positive().max(60_000).default(7_000),
    /** Home Assistant entities for voice assistants; see docs/INTEGRATIONS.md. */
    assistantEntities: AssistantEntitiesConfigSchema.optional(),
    computers: z
      .array(ComputerMqttConfigSchema)
      .default([])
      .superRefine((computers, context) => {
        const ids = new Set<string>();
        for (const [index, computer] of computers.entries()) {
          if (ids.has(computer.deviceId))
            context.addIssue({
              code: 'custom',
              path: [index, 'deviceId'],
              message: 'Computer device IDs must be unique',
            });
          ids.add(computer.deviceId);
        }
      }),
  })
  .strict()
  .superRefine((config, context) => {
    if (Boolean(config.usernameEnv) !== Boolean(config.passwordEnv)) {
      context.addIssue({
        code: 'custom',
        path: ['usernameEnv'],
        message: 'usernameEnv and passwordEnv must be configured together',
      });
    }
  });

/**
 * Desktop pointer agent (agents/linux/hub-pointer) for one Hub. The page
 * connects to `${url}?token=…`, so `url` names the full endpoint including
 * its path (normally `/hub-pointer`) and carries no query of its own.
 */
const DisplayPointerBridgeConfigSchema = z
  .object({
    url: z.string().superRefine((value, context) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'pointerBridge.url must be a valid URL',
        });
        return;
      }
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        context.addIssue({
          code: 'custom',
          message: 'pointerBridge.url must use ws:// or wss://',
        });
      }
      if (
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        value.includes('?') ||
        value.includes('#')
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'pointerBridge.url must name a host and path without credentials, query or fragment',
        });
      }
    }),
    tokenEnv: EnvironmentNameSchema,
  })
  .strict();

const DisplayConfigSchema = z
  .object({
    host: z.string().min(1).default('0.0.0.0'),
    port: z.number().int().min(1).max(65_535).default(8788),
    publicUrl: z.string().superRefine((value, context) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'publicUrl must be a valid URL',
        });
        return;
      }
      if (url.protocol !== 'http:') {
        context.addIssue({
          code: 'custom',
          message: 'publicUrl must use HTTP on the trusted local network',
        });
      }
      if (
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        context.addIssue({
          code: 'custom',
          message: 'publicUrl must contain only the local origin',
        });
      }
    }),
    hubs: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
            role: z.enum(['bed', 'desk']),
            castHost: z
              .string()
              .refine(
                (value) => isIP(value) !== 0,
                'castHost must be an IP address',
              ),
            tokenEnv: EnvironmentNameSchema,
            pointerBridge: DisplayPointerBridgeConfigSchema.optional(),
          })
          .strict(),
      )
      .min(1),
    /** What each Hub shows, decided from the situation (docs/HUB-RULES.md). */
    rules: HubRulesSchema.default([]),
    greetings: GreetingsConfigSchema,
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const [index, hub] of config.hubs.entries()) {
      if (ids.has(hub.id)) {
        context.addIssue({
          code: 'custom',
          path: ['hubs', index, 'id'],
          message: 'Display IDs must be unique',
        });
      }
      ids.add(hub.id);
    }
    let publicPort = '';
    try {
      publicPort = new URL(config.publicUrl).port;
    } catch {
      return;
    }
    if (!publicPort || Number(publicPort) !== config.port) {
      context.addIssue({
        code: 'custom',
        path: ['port'],
        message: 'port must match the port in publicUrl',
      });
    }
    if (isLoopbackBindHost(config.host)) {
      context.addIssue({
        code: 'custom',
        path: ['host'],
        message: 'display host must be reachable from the Nest Hubs',
      });
    }
  });

const PresenceFeedbackConfigSchema = z
  .object({
    /** ALSA device for the presence chime, as listed by `aplay -L`. */
    audioDevice: z
      .string()
      .regex(/^[A-Za-z0-9_:.,=-]{1,64}$/)
      .optional(),
  })
  .strict();

const WiimConfigSchema = z
  .object({
    music: WiimMusicMappingsSchema.default({}),
  })
  .strict();

const LyricsConfigSchema = z
  .object({
    /**
     * WiiM players whose position the lyrics are followed by, read directly
     * whichever adapter controls the player.
     */
    players: z
      .record(
        SemanticMusicIdSchema,
        z.object({ wiimHost: WiimMusicMappingSchema.shape.host }).strict(),
      )
      .default({}),
  })
  .strict();

const FileConfigSchema = z
  .object({
    http: z
      .object({
        host: z.string().min(1).default('127.0.0.1'),
        port: z.number().int().min(1).max(65_535).default(8787),
        bearerTokenEnv: EnvironmentNameSchema.optional(),
        trustedOrigins: z.array(TrustedOriginSchema).max(8).default([]),
        clerk: ClerkConfigSchema.optional(),
      })
      .strict()
      .default({ host: '127.0.0.1', port: 8787, trustedOrigins: [] }),
    govee: z
      .object({
        socketPath: z
          .string()
          .min(1)
          .refine(isAbsolute, 'socketPath must be absolute'),
      })
      .strict()
      .optional(),
    wiim: WiimConfigSchema.optional(),
    lyrics: LyricsConfigSchema.optional(),
    homeAssistant: HomeAssistantConfigSchema,
    lightingControlModes: LightingControlModesSchema.default({}),
    windowLighting: WindowLightingSchema.optional(),
    dynamicLighting: DynamicLightingConfigSchema.optional(),
    mqtt: MqttConfigSchema.optional(),
    presenceControl: PresenceControlConfigSchema.optional(),
    presenceFeedback: PresenceFeedbackConfigSchema.optional(),
    display: DisplayConfigSchema.optional(),
    cameraDashboard: CameraDashboardConfigSchema.optional(),
    /** A public iCloud shared album shown on the Hubs' photo page. */
    photoFrame: z
      .object({
        albumUrl: z.string().refine(
          (link) => {
            try {
              parseAlbumToken(link);
              return true;
            } catch {
              return false;
            }
          },
          { message: 'must be a photos.icloud.com/shared/album/… link' },
        ),
        refreshMinutes: z.number().int().min(5).max(1440).default(30),
        maxPhotos: z.number().int().min(1).max(20_000).default(5000),
        cacheDir: z.string().min(1).optional(),
        /**
         * The photo brain's results (docs/PHOTO-BRAIN.md): groups pictures by
         * what they show and who is in them, and names the groups. Models run
         * on Kuffe; without its results the frame groups by time and place.
         */
        intelligence: z
          .object({
            enabled: z.boolean().default(true),
            /** Read by the old on-device analysis; accepted and ignored. */
            modelsDir: z.string().min(1).optional(),
            /** Where home is, so trips away can be told from days at home. */
            home: z
              .object({
                latitude: z.number().min(-90).max(90),
                longitude: z.number().min(-180).max(180),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    prelight: z
      .object({
        targets: z
          .record(SemanticLightingIdSchema, LightingValuesSchema)
          .default({}),
        maxDurationMs: z.number().int().min(1_000).max(30_000).default(5_000),
        maxHoldMs: z.number().int().min(1_000).max(60_000).optional(),
      })
      .strict()
      .refine(
        (prelight) =>
          prelight.maxHoldMs === undefined ||
          prelight.maxHoldMs >= prelight.maxDurationMs,
        {
          path: ['maxHoldMs'],
          message: 'prelight.maxHoldMs must not be shorter than maxDurationMs',
        },
      )
      .default({ targets: {}, maxDurationMs: 5_000 }),
    scenes: z.array(SceneSchema).optional(),
    defaultSceneId: z.string().min(1).optional(),
    statePath: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const configuredComputers = new Set(
      (config.mqtt?.computers ?? []).map((computer) => computer.deviceId),
    );
    for (const [target, mapping] of Object.entries(
      config.homeAssistant.music,
    )) {
      if (
        mapping.computerAudio?.playbackControl &&
        (!config.mqtt?.usernameEnv || !config.mqtt.passwordEnv)
      )
        context.addIssue({
          code: 'custom',
          path: [
            'homeAssistant',
            'music',
            target,
            'computerAudio',
            'playbackControl',
          ],
          message: 'Computer playback requires authenticated MQTT credentials',
        });
      if (
        mapping.computerAudio &&
        !configuredComputers.has(mapping.computerAudio.deviceId)
      )
        context.addIssue({
          code: 'custom',
          path: ['homeAssistant', 'music', target, 'computerAudio', 'deviceId'],
          message: 'Computer audio device must be configured in mqtt.computers',
        });
    }
    for (const [target, mapping] of Object.entries(config.wiim?.music ?? {})) {
      if (target in config.homeAssistant.music)
        context.addIssue({
          code: 'custom',
          path: ['wiim', 'music', target],
          message: `Music target ${target} cannot be configured in both homeAssistant.music and wiim.music`,
        });
      if (
        mapping.computerAudio?.playbackControl &&
        (!config.mqtt?.usernameEnv || !config.mqtt.passwordEnv)
      )
        context.addIssue({
          code: 'custom',
          path: ['wiim', 'music', target, 'computerAudio', 'playbackControl'],
          message: 'Computer playback requires authenticated MQTT credentials',
        });
      if (
        mapping.computerAudio &&
        !configuredComputers.has(mapping.computerAudio.deviceId)
      )
        context.addIssue({
          code: 'custom',
          path: ['wiim', 'music', target, 'computerAudio', 'deviceId'],
          message: 'Computer audio device must be configured in mqtt.computers',
        });
    }
    for (const [index, computer] of (config.mqtt?.computers ?? []).entries()) {
      if (
        computer.display &&
        (!config.mqtt?.usernameEnv || !config.mqtt.passwordEnv)
      )
        context.addIssue({
          code: 'custom',
          path: ['mqtt', 'computers', index, 'display'],
          message:
            'Computer display control requires authenticated MQTT credentials',
        });
    }
    const configuredLights = new Set(
      Object.keys(config.homeAssistant.entities),
    );
    for (const target of Object.keys(config.homeAssistant.wledCct)) {
      if (!configuredLights.has(target))
        context.addIssue({
          code: 'custom',
          path: ['homeAssistant', 'wledCct', target],
          message: `WLED CCT target ${target} is not mapped in homeAssistant.entities`,
        });
    }
    if (configuredLights.size === 0) {
      context.addIssue({
        code: 'custom',
        path: ['homeAssistant', 'entities'],
        message: 'At least one Home Assistant light mapping is required',
      });
    }

    const scenes = config.scenes ?? defaultScenes;
    if (
      config.defaultSceneId !== undefined &&
      !scenes.some((scene) => scene.id === config.defaultSceneId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['defaultSceneId'],
        message: `Default scene ${config.defaultSceneId} is not configured in scenes`,
      });
    }
    scenes.forEach((scene, sceneIndex) => {
      for (const target of Object.keys(scene.lighting)) {
        if (
          scene.lighting[target]?.rgb !== undefined &&
          target in config.homeAssistant.wledCct
        )
          context.addIssue({
            code: 'custom',
            path: ['scenes', sceneIndex, 'lighting', target, 'rgb'],
            message: 'Dedicated WLED CCT targets cannot use RGB',
          });
        if (configuredLights.has(target)) continue;
        context.addIssue({
          code: 'custom',
          path: ['scenes', sceneIndex, 'lighting', target],
          message: `Scene target ${target} is not mapped in homeAssistant.entities`,
        });
      }
    });

    for (const target of Object.keys(config.prelight.targets)) {
      if (configuredLights.has(target)) continue;
      context.addIssue({
        code: 'custom',
        path: ['prelight', 'targets', target],
        message: `Prelight target ${target} is not mapped in homeAssistant.entities`,
      });
    }
    for (const target of Object.keys(config.lightingControlModes)) {
      if (configuredLights.has(target)) continue;
      context.addIssue({
        code: 'custom',
        path: ['lightingControlModes', target],
        message: `Lighting control target ${target} is not mapped in homeAssistant.entities`,
      });
    }
    for (const target of Object.keys(config.dynamicLighting?.targets ?? {})) {
      if (configuredLights.has(target)) continue;
      context.addIssue({
        code: 'custom',
        path: ['dynamicLighting', 'targets', target],
        message: `Dynamic lighting target ${target} is not mapped in homeAssistant.entities`,
      });
    }
    const dynamicComputer = config.dynamicLighting?.computerDeviceId;
    if (
      dynamicComputer !== undefined &&
      !(config.mqtt?.computers ?? []).some(
        (computer) => computer.deviceId === dynamicComputer,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['dynamicLighting', 'computerDeviceId'],
        message:
          'Dynamic lighting computer must be configured in mqtt.computers',
      });
    }
    if (
      config.windowLighting &&
      !configuredLights.has(config.windowLighting.target)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['windowLighting', 'target'],
        message: 'Window light must be mapped in homeAssistant.entities',
      });
    }
    if (
      config.windowLighting &&
      config.windowLighting.target in config.homeAssistant.wledCct
    ) {
      context.addIssue({
        code: 'custom',
        path: ['windowLighting', 'target'],
        message: 'Dedicated WLED CCT strips cannot be used as window lights',
      });
    }
  });

/** Validates an in-memory configuration with the same strict schema as the runtime. */
export function validateRuntimeFileConfig(value: unknown): void {
  const parsed = FileConfigSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new RuntimeConfigError(`Invalid configuration: ${problems}`);
  }
}

export type RuntimeConfig = {
  govee?: { socketPath: string };
  wiim?: {
    music: z.output<typeof WiimMusicMappingsSchema>;
  };
  lyrics?: z.output<typeof LyricsConfigSchema>;
  windowLighting?: WindowLighting;
  dynamicLighting?: z.output<typeof DynamicLightingConfigSchema>;
  presenceControl?: z.output<typeof PresenceControlConfigSchema>;
  presenceFeedback?: z.output<typeof PresenceFeedbackConfigSchema>;
  lightingControlModes?: LightingControlModes;
  http: {
    host: string;
    port: number;
    bearerToken?: string;
    trustedOrigins: string[];
    clerk?: {
      publishableKey: string;
      secretKey: string;
      allowedUserIds: string[];
      allowAnyUser: boolean;
    };
  };
  homeAssistant: {
    baseUrl: string;
    token: string;
    homePresence?: z.output<typeof HomeAssistantHomePresenceConfigSchema>;
    entities: Record<string, string>;
    wledCct?: z.output<typeof WledCctMappingsSchema>;
    buttons: Record<string, string>;
    bilresa?: z.output<typeof HomeAssistantBilresaConfigSchema>;
    switches: Record<string, string>;
    music: z.output<typeof HomeAssistantMusicMappingsSchema>;
    environment: {
      temperature: string;
      humidity: string;
      co2: string;
      pm25: string;
    };
    printer?: z.output<typeof HomeAssistantPrinterConfigSchema>;
    weather?: z.output<typeof HomeAssistantWeatherConfigSchema>;
  };
  mqtt?: {
    url: string;
    username?: string;
    password?: string;
    clientId?: string;
    baseTopic: string;
    maxAgeMs: number;
    assistantEntities?: ResolvedAssistantEntitiesConfig;
    computers?: Array<{
      deviceId: string;
      baseTopic: string;
      maxAgeMs: number;
      display?: DisplayPowerConfig | undefined;
      opticalSwitch: OpticalSwitchSettings;
    }>;
  };
  display?: {
    host: string;
    port: number;
    publicUrl: string;
    hubs: Array<{
      id: string;
      role: 'bed' | 'desk';
      castHost: string;
      token: string;
      pointerBridge?: { url: string; token: string };
    }>;
    rules: HubRule[];
    greetings: GreetingsConfig;
  };
  cameraDashboard?: CameraDashboardConfig;
  photoFrame?: {
    albumUrl: string;
    refreshMinutes: number;
    maxPhotos: number;
    cacheDir?: string | undefined;
    intelligence?:
      | {
          enabled: boolean;
          home?: { latitude: number; longitude: number } | undefined;
        }
      | undefined;
  };
  prelight: {
    targets: Record<string, LightingValues>;
    maxDurationMs: number;
    maxHoldMs?: number | undefined;
  };
  scenes?: LightingScene[];
  defaultSceneId?: string;
  statePath: string;
};

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

/** Reads non-secret configuration from JSON and resolves secret env references. */
export function loadRuntimeConfig(
  filePath = process.env['LUGN_CONFIG_PATH'] ?? 'config.json',
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    throw new RuntimeConfigError(
      `Could not read valid JSON configuration from ${filePath}`,
    );
  }

  const parsed = FileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new RuntimeConfigError(`Invalid configuration: ${problems}`);
  }

  const fileConfig = parsed.data;
  const homeAssistantToken = requireEnvironmentValue(
    fileConfig.homeAssistant.tokenEnv,
    environment,
  );
  const apiToken = fileConfig.http.bearerTokenEnv
    ? requireEnvironmentValue(fileConfig.http.bearerTokenEnv, environment)
    : undefined;
  if (fileConfig.http.clerk && apiToken === undefined) {
    throw new RuntimeConfigError(
      'http.clerk requires http.bearerTokenEnv to protect machine API routes',
    );
  }
  const clerk = fileConfig.http.clerk
    ? loadClerkConfig(fileConfig.http.clerk, environment)
    : undefined;
  if (fileConfig.http.trustedOrigins.length > 0 && apiToken === undefined) {
    throw new RuntimeConfigError(
      'trustedOrigins requires an HTTP bearer token to protect the API',
    );
  }
  const display = fileConfig.display
    ? {
        host: fileConfig.display.host,
        port: fileConfig.display.port,
        publicUrl: fileConfig.display.publicUrl.replace(/\/+$/, ''),
        hubs: fileConfig.display.hubs.map((hub) => ({
          id: hub.id,
          role: hub.role,
          castHost: hub.castHost,
          token: requireEnvironmentValue(hub.tokenEnv, environment),
          ...(hub.pointerBridge
            ? {
                pointerBridge: {
                  url: hub.pointerBridge.url,
                  token: requireEnvironmentValue(
                    hub.pointerBridge.tokenEnv,
                    environment,
                  ),
                },
              }
            : {}),
        })),
        rules: fileConfig.display.rules,
        greetings: fileConfig.display.greetings,
      }
    : undefined;

  if (!isLoopbackBindHost(fileConfig.http.host)) {
    throw new RuntimeConfigError(
      'Lugn binds only to loopback. Use a TLS-terminating reverse proxy for remote access.',
    );
  }

  const stateDirectory = resolve(homedir(), '.local', 'state', 'lugn');
  const requestedStatePath =
    fileConfig.statePath ?? environment['LUGN_STATE_PATH'];
  if (requestedStatePath !== undefined && !isAbsolute(requestedStatePath)) {
    throw new RuntimeConfigError('statePath must be an absolute path');
  }
  const statePath = resolve(
    requestedStatePath ?? join(stateDirectory, 'lighting-intent.json'),
  );
  const statePathRelative = relative(stateDirectory, statePath);
  if (
    statePathRelative === '' ||
    statePathRelative === '..' ||
    statePathRelative.startsWith(`..${sep}`) ||
    dirname(statePath) !== stateDirectory
  ) {
    throw new RuntimeConfigError(
      `statePath must be a direct child of the writable Lugn state directory ${stateDirectory}`,
    );
  }
  validateStateDirectoryAncestors(homedir());

  let mqtt: RuntimeConfig['mqtt'];
  if (fileConfig.mqtt) {
    const username = fileConfig.mqtt.usernameEnv
      ? requireEnvironmentValue(fileConfig.mqtt.usernameEnv, environment)
      : undefined;
    const password = fileConfig.mqtt.passwordEnv
      ? requireEnvironmentValue(fileConfig.mqtt.passwordEnv, environment)
      : undefined;
    mqtt = {
      url: fileConfig.mqtt.url,
      baseTopic: fileConfig.mqtt.baseTopic,
      maxAgeMs: fileConfig.mqtt.maxAgeMs,
      computers: fileConfig.mqtt.computers,
      ...(fileConfig.mqtt.assistantEntities === undefined
        ? {}
        : { assistantEntities: fileConfig.mqtt.assistantEntities }),
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      ...(fileConfig.mqtt.clientId === undefined
        ? {}
        : { clientId: fileConfig.mqtt.clientId }),
    };
  }

  return {
    http: {
      host: fileConfig.http.host,
      port: fileConfig.http.port,
      trustedOrigins: fileConfig.http.trustedOrigins,
      ...(apiToken === undefined ? {} : { bearerToken: apiToken }),
      ...(clerk === undefined ? {} : { clerk }),
    },
    ...(fileConfig.govee ? { govee: fileConfig.govee } : {}),
    ...(fileConfig.wiim ? { wiim: fileConfig.wiim } : {}),
    homeAssistant: {
      baseUrl: fileConfig.homeAssistant.baseUrl.replace(/\/+$/, ''),
      token: homeAssistantToken,
      homePresence: fileConfig.homeAssistant.homePresence,
      entities: fileConfig.homeAssistant.entities,
      wledCct: fileConfig.homeAssistant.wledCct,
      buttons: fileConfig.homeAssistant.buttons,
      bilresa: fileConfig.homeAssistant.bilresa,
      switches: fileConfig.homeAssistant.switches,
      music: fileConfig.homeAssistant.music,
      environment: fileConfig.homeAssistant.environment,
      ...(fileConfig.homeAssistant.printer === undefined
        ? {}
        : { printer: fileConfig.homeAssistant.printer }),
      ...(fileConfig.homeAssistant.weather === undefined
        ? {}
        : { weather: fileConfig.homeAssistant.weather }),
    },
    ...(mqtt === undefined ? {} : { mqtt }),
    ...(fileConfig.lyrics === undefined ? {} : { lyrics: fileConfig.lyrics }),
    ...(fileConfig.presenceControl === undefined
      ? {}
      : { presenceControl: fileConfig.presenceControl }),
    ...(fileConfig.presenceFeedback === undefined
      ? {}
      : { presenceFeedback: fileConfig.presenceFeedback }),
    ...(display === undefined ? {} : { display }),
    ...(fileConfig.cameraDashboard === undefined
      ? {}
      : { cameraDashboard: fileConfig.cameraDashboard }),
    ...(fileConfig.photoFrame === undefined
      ? {}
      : { photoFrame: fileConfig.photoFrame }),
    prelight: fileConfig.prelight,
    lightingControlModes: fileConfig.lightingControlModes,
    ...(fileConfig.windowLighting === undefined
      ? {}
      : { windowLighting: fileConfig.windowLighting }),
    ...(fileConfig.dynamicLighting === undefined
      ? {}
      : { dynamicLighting: fileConfig.dynamicLighting }),
    ...(fileConfig.scenes === undefined ? {} : { scenes: fileConfig.scenes }),
    ...(fileConfig.defaultSceneId === undefined
      ? {}
      : { defaultSceneId: fileConfig.defaultSceneId }),
    statePath,
  };
}

function loadClerkConfig(
  config: z.infer<typeof ClerkConfigSchema>,
  environment: NodeJS.ProcessEnv,
): NonNullable<RuntimeConfig['http']['clerk']> {
  const publishableKey = requireEnvironmentValue(
    config.publishableKeyEnv,
    environment,
  );
  const secretKey = requireEnvironmentValue(config.secretKeyEnv, environment);
  const allowedUserIdsValue = requireEnvironmentValue(
    config.allowedUserIdsEnv,
    environment,
  );
  const allowedUserIds = allowedUserIdsValue.split(',').map((id) => id.trim());
  const allowAnyUser = allowedUserIds.length === 1 && allowedUserIds[0] === '*';
  if (
    !allowAnyUser &&
    (allowedUserIds.length === 0 ||
      allowedUserIds.some((id) => !/^user_[A-Za-z0-9]{1,120}$/.test(id)) ||
      new Set(allowedUserIds).size !== allowedUserIds.length)
  ) {
    throw new RuntimeConfigError(
      `Required environment variable must be '*' or a comma-separated list of unique Clerk user IDs: ${config.allowedUserIdsEnv}`,
    );
  }

  try {
    clerkFrontendApiOrigin(publishableKey);
  } catch {
    throw new RuntimeConfigError(
      `Required environment variable is not a valid Clerk publishable key: ${config.publishableKeyEnv}`,
    );
  }

  const publishableKeyIsTest = publishableKey.startsWith('pk_test_');
  const secretKeyIsTest = secretKey.startsWith('sk_test_');
  if (
    (!secretKeyIsTest && !secretKey.startsWith('sk_live_')) ||
    publishableKeyIsTest !== secretKeyIsTest
  ) {
    throw new RuntimeConfigError(
      `Required environment variable is not a valid Clerk secret key: ${config.secretKeyEnv}`,
    );
  }

  return { publishableKey, secretKey, allowedUserIds, allowAnyUser };
}

/** Reject symlinked state-directory ancestors so lexical containment is real. */
export function validateStateDirectoryAncestors(homeDirectory: string): void {
  for (const directory of [
    join(homeDirectory, '.local'),
    join(homeDirectory, '.local', 'state'),
    join(homeDirectory, '.local', 'state', 'lugn'),
  ]) {
    try {
      const info = lstatSync(directory);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new RuntimeConfigError(
          `Lugn state directory ancestor must be a regular directory: ${directory}`,
        );
    } catch (error) {
      if (error instanceof RuntimeConfigError) throw error;
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        continue;
      throw new RuntimeConfigError(
        'Could not safely inspect the Lugn state directory',
      );
    }
  }
}
function requireEnvironmentValue(
  name: string,
  environment: NodeJS.ProcessEnv,
): string {
  const value = environment[name];
  if (!value || value.trim().length === 0) {
    throw new RuntimeConfigError(
      `Required environment variable is missing: ${name}`,
    );
  }
  if (!name.endsWith('_B64')) return value;

  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (
    decoded.includes('\u0000') ||
    Buffer.from(decoded, 'utf8').toString('base64url') !== value
  ) {
    throw new RuntimeConfigError(
      `Required environment variable has invalid base64url encoding: ${name}`,
    );
  }
  return decoded;
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
