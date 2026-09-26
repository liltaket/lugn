import { HomeAssistantMusicMappingsSchema } from '../adapters/home-assistant-music.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { defaultScenes } from '../application/lugn-engine.js';
import {
  SceneSchema,
  SemanticLightingIdSchema,
  SemanticSwitchIdSchema,
  LightingValuesSchema,
  type LightingScene,
  type LightingValues,
} from '../core/schemas.js';

const EnvironmentNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

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
    entities: z.record(
      SemanticLightingIdSchema,
      z.string().regex(/^light\.[a-z0-9_]+$/),
    ),
    music: HomeAssistantMusicMappingsSchema.default({}),
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

const FileConfigSchema = z
  .object({
    http: z
      .object({
        host: z.string().min(1).default('127.0.0.1'),
        port: z.number().int().min(1).max(65_535).default(8787),
        bearerTokenEnv: EnvironmentNameSchema.optional(),
      })
      .strict()
      .default({ host: '127.0.0.1', port: 8787 }),
    homeAssistant: HomeAssistantConfigSchema,
    mqtt: MqttConfigSchema.optional(),
    prelight: z
      .object({
        targets: z
          .record(SemanticLightingIdSchema, LightingValuesSchema)
          .default({}),
        maxDurationMs: z.number().int().min(1_000).max(30_000).default(5_000),
      })
      .strict()
      .default({ targets: {}, maxDurationMs: 5_000 }),
    scenes: z.array(SceneSchema).optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const configuredLights = new Set(
      Object.keys(config.homeAssistant.entities),
    );
    if (configuredLights.size === 0) {
      context.addIssue({
        code: 'custom',
        path: ['homeAssistant', 'entities'],
        message: 'At least one Home Assistant light mapping is required',
      });
    }

    const scenes = config.scenes ?? defaultScenes;
    scenes.forEach((scene, sceneIndex) => {
      for (const target of Object.keys(scene.lighting)) {
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
  });

export type RuntimeConfig = {
  http: {
    host: string;
    port: number;
    bearerToken?: string;
  };
  homeAssistant: {
    baseUrl: string;
    token: string;
    entities: Record<string, string>;
    switches: Record<string, string>;
    music: Record<string, { entityId: string; sources: string[] }>;
  };
  mqtt?: {
    url: string;
    username?: string;
    password?: string;
    clientId?: string;
    baseTopic: string;
    maxAgeMs: number;
  };
  prelight: {
    targets: Record<string, LightingValues>;
    maxDurationMs: number;
  };
  scenes?: LightingScene[];
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

  if (!isLoopbackBindHost(fileConfig.http.host)) {
    throw new RuntimeConfigError(
      'Lugn binds only to loopback. Use a TLS-terminating reverse proxy for remote access.',
    );
  }

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
      ...(apiToken === undefined ? {} : { bearerToken: apiToken }),
    },
    homeAssistant: {
      baseUrl: fileConfig.homeAssistant.baseUrl.replace(/\/+$/, ''),
      token: homeAssistantToken,
      entities: fileConfig.homeAssistant.entities,
      switches: fileConfig.homeAssistant.switches,
      music: fileConfig.homeAssistant.music,
    },
    ...(mqtt === undefined ? {} : { mqtt }),
    prelight: fileConfig.prelight,
    ...(fileConfig.scenes === undefined ? {} : { scenes: fileConfig.scenes }),
  };
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
  return value;
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
