import { HomeAssistantMusicMappingsSchema } from '../adapters/home-assistant-music.js';
import { HomeAssistantButtonMappingsSchema } from '../adapters/home-assistant-button.js';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { defaultScenes } from '../application/lugn-engine.js';
import { clerkFrontendApiOrigin } from './clerk-auth.js';
import {
  SceneSchema,
  SemanticLightingIdSchema,
  SemanticSwitchIdSchema,
  LightingValuesSchema,
  type LightingScene,
  type LightingValues,
} from '../core/schemas.js';

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
    buttons: HomeAssistantButtonMappingsSchema.default({}),
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
        trustedOrigins: z.array(TrustedOriginSchema).max(8).default([]),
        clerk: ClerkConfigSchema.optional(),
      })
      .strict()
      .default({ host: '127.0.0.1', port: 8787, trustedOrigins: [] }),
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
    defaultSceneId: z.string().min(1).optional(),
    statePath: z.string().min(1).optional(),
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
  http: {
    host: string;
    port: number;
    bearerToken?: string;
    trustedOrigins?: string[];
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
    entities: Record<string, string>;
    buttons: Record<string, string>;
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
    homeAssistant: {
      baseUrl: fileConfig.homeAssistant.baseUrl.replace(/\/+$/, ''),
      token: homeAssistantToken,
      entities: fileConfig.homeAssistant.entities,
      buttons: fileConfig.homeAssistant.buttons,
      switches: fileConfig.homeAssistant.switches,
      music: fileConfig.homeAssistant.music,
    },
    ...(mqtt === undefined ? {} : { mqtt }),
    prelight: fileConfig.prelight,
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
    (!allowAnyUser &&
      (allowedUserIds.length === 0 ||
        allowedUserIds.some((id) => !/^user_[A-Za-z0-9]{1,120}$/.test(id)) ||
        new Set(allowedUserIds).size !== allowedUserIds.length))
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
