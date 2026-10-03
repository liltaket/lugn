import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import {
  discoverHomeAssistantLightChoices,
  HaDiscoverError,
  isDirectExecution,
  type HomeAssistantLightChoice,
} from './ha-discover.js';
import { validateRuntimeFileConfig } from './config.js';

const HOME_ASSISTANT_TOKEN_ENV = 'HOME_ASSISTANT_TOKEN_B64';
const MQTT_USERNAME_ENV = 'MQTT_USERNAME_B64';
const MQTT_PASSWORD_ENV = 'MQTT_PASSWORD_B64';
const LUGN_API_TOKEN_ENV = 'LUGN_API_TOKEN_B64';
const DEFAULT_MQTT_TOPIC = 'bruno/doorway';

export type OnboardingPromptOptions = { secret?: boolean };

export type OnboardingIO = {
  prompt(question: string, options?: OnboardingPromptOptions): Promise<string>;
  writeLine(value: string): void;
};

export type OnboardingDependencies = {
  io: OnboardingIO;
  fetcher?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDirectory?: string;
  createToken?: () => string;
};

type ParsedArguments =
  | { help: true }
  | { help: false; configPath?: string; environmentPath?: string };

type CommissioningConfig = {
  http: {
    host: '127.0.0.1';
    port: 8787;
    bearerTokenEnv: typeof LUGN_API_TOKEN_ENV;
  };
  homeAssistant: {
    baseUrl: string;
    tokenEnv: typeof HOME_ASSISTANT_TOKEN_ENV;
    entities: Record<string, string>;
    buttons: Record<string, string>;
    music: Record<string, never>;
    switches: Record<string, string>;
  };
  mqtt: {
    url: string;
    baseTopic: string;
    maxAgeMs: 7000;
    clientId: string;
    usernameEnv?: typeof MQTT_USERNAME_ENV;
    passwordEnv?: typeof MQTT_PASSWORD_ENV;
  };
  prelight: {
    targets: Record<
      string,
      { power: true; brightness: number; colorTemperature?: number }
    >;
    maxDurationMs: 5000;
  };
  scenes: Array<{
    id: string;
    name: string;
    lighting: Record<string, { power: true }>;
  }>;
};

const HELP_TEXT = [
  'Usage: npm run onboard -- [config-path] [secret-env-path]',
  '',
  'Guides first-time Home Assistant and STL27L MQTT setup.',
  'Home Assistant discovery is a read-only GET /api/states request.',
  'The wizard never calls device services, publishes MQTT, or starts Lugn.',
  'Secrets are entered without terminal echo and saved base64url-encoded in a mode-0600 env file.',
  'Existing files require explicit confirmation before replacement.',
].join('\n');

export async function runOnboardingCli(
  args: string[],
  dependencies: OnboardingDependencies,
): Promise<number> {
  const { io } = dependencies;
  let parsedArgs: ParsedArguments;
  try {
    parsedArgs = parseArguments(args);
  } catch {
    io.writeLine('Usage: npm run onboard -- [config-path] [secret-env-path]');
    return 2;
  }

  if (parsedArgs.help) {
    io.writeLine(HELP_TEXT);
    return 0;
  }

  const environment = dependencies.environment ?? process.env;
  const paths = resolveCommissioningPaths(
    parsedArgs,
    environment,
    dependencies,
  );
  if (paths.configPath === paths.environmentPath) {
    io.writeLine(
      'Config and secret environment paths must be different files.',
    );
    return 2;
  }

  let existingFiles: string[];
  try {
    existingFiles = inspectOutputTargets(
      paths.configPath,
      paths.environmentPath,
    );
  } catch {
    io.writeLine('A target path is not a regular file or is a symbolic link.');
    return 2;
  }

  if (existingFiles.length > 0) {
    io.writeLine(`Existing file${existingFiles.length > 1 ? 's' : ''}:`);
    for (const path of existingFiles) io.writeLine(`  ${path}`);
    io.writeLine('Replacing these files discards their current contents.');
    if (!(await confirm(dependencies.io, 'Replace existing files?', false))) {
      io.writeLine('No files changed. Run onboarding again when ready.');
      return 1;
    }
  }

  io.writeLine('Lugn first-run setup');
  io.writeLine(
    'This wizard only reads Home Assistant state and writes local config. It will not control devices, publish MQTT, or start the service.',
  );
  io.writeLine('');

  const homeAssistantUrl = await promptUrl(
    io,
    'Home Assistant URL (example: http://homeassistant.local:8123)',
    environment['HOME_ASSISTANT_URL'],
    isHttpUrl,
  );
  if (!homeAssistantUrl) return 2;

  const homeAssistantToken = await promptSecret(
    io,
    'Home Assistant long-lived access token',
  );
  if (homeAssistantToken === undefined) return 2;

  io.writeLine(
    'Checking Home Assistant and finding current lights (read-only)…',
  );
  let discoveredLights: HomeAssistantLightChoice[];
  try {
    discoveredLights = await discoverHomeAssistantLightChoices(
      homeAssistantUrl,
      homeAssistantToken,
      dependencies.fetcher ?? fetch,
    );
  } catch (error) {
    io.writeLine(
      `Home Assistant discovery failed: ${formatDiscoveryFailure(error)}`,
    );
    return 1;
  }

  if (discoveredLights.length === 0) {
    io.writeLine(
      'Home Assistant returned no light entities. No files were changed.',
    );
    return 1;
  }

  io.writeLine(
    `Found ${discoveredLights.length} light${discoveredLights.length === 1 ? '' : 's'}:`,
  );
  discoveredLights.forEach(({ entity_id: entityId, friendly_name }, index) =>
    io.writeLine(
      `  ${index + 1}. ${friendly_name ? `${friendly_name} — ` : ''}${entityId}`,
    ),
  );

  const selectedIndices = await promptIndices(
    io,
    'Choose the lights Lugn may control (comma-separated numbers)',
    discoveredLights.length,
  );
  if (!selectedIndices) return 2;

  const entities: Record<string, string> = {};
  const selectedEntities = selectedIndices.map(
    (index) => discoveredLights[index - 1]!,
  );
  for (let index = 0; index < selectedEntities.length; index += 1) {
    const entityId = selectedEntities[index]!.entity_id;
    const suggested = entityId
      .slice('light.'.length)
      .replace(/[^a-z0-9._-]+/g, '_');
    const slug = await promptSemanticSlug(
      io,
      `${entityId} semantic name (for example ceiling, desk, or entry)`,
      selectedEntities.length === 1 ? 'main' : suggested,
      entities,
    );
    if (!slug) return 2;
    entities[`lighting.${slug}`] = entityId;
  }

  const mappings = Object.entries(entities);
  io.writeLine('');
  io.writeLine('Lugn light mappings:');
  mappings.forEach(([semanticId, entityId], index) =>
    io.writeLine(`  ${index + 1}. ${semanticId} → ${entityId}`),
  );

  const mqttUrl = await promptUrl(
    io,
    'MQTT broker URL (example: mqtt://192.168.1.20:1883)',
    environment['MQTT_URL'],
    isMqttUrl,
  );
  if (!mqttUrl) return 2;

  const topicDefault = environment['STL27L_MQTT_TOPIC'] ?? DEFAULT_MQTT_TOPIC;
  const baseTopic = await promptTopic(io, topicDefault);
  if (!baseTopic) return 2;

  const brokerCredentialsRequired = await confirm(
    io,
    'Does the MQTT broker require a username and password?',
    false,
  );
  let mqttUsername: string | undefined;
  let mqttPassword: string | undefined;
  if (brokerCredentialsRequired) {
    mqttUsername = await promptSecret(io, 'MQTT username');
    if (mqttUsername === undefined) return 2;
    mqttPassword = await promptSecret(io, 'MQTT password');
    if (mqttPassword === undefined) return 2;
  }

  const prelightEnabled = await confirm(
    io,
    'Configure the STL27L fast entry-light path?',
    true,
  );
  const prelightTargets: CommissioningConfig['prelight']['targets'] = {};
  if (prelightEnabled) {
    const prelightIndices = await promptIndices(
      io,
      'Choose one or more mapped lights for brief entry lighting',
      mappings.length,
    );
    if (!prelightIndices) return 2;
    const brightness = await promptInteger(
      io,
      'Entry brightness percent',
      35,
      1,
      100,
    );
    if (brightness === undefined) return 2;
    const temperature = await promptOptionalInteger(
      io,
      'Warm color temperature in Kelvin (type skip to leave unchanged; only for supported bulbs)',
      '2700',
      1000,
      10000,
    );
    if (temperature === undefined) return 2;

    for (const index of prelightIndices) {
      const target = mappings[index - 1]?.[0];
      if (!target) return 2;
      prelightTargets[target] = {
        power: true,
        brightness,
        ...(temperature === null ? {} : { colorTemperature: temperature }),
      };
    }
  }

  const apiToken = (dependencies.createToken ?? generateToken)();
  const config: CommissioningConfig = {
    http: {
      host: '127.0.0.1',
      port: 8787,
      bearerTokenEnv: LUGN_API_TOKEN_ENV,
    },
    homeAssistant: {
      baseUrl: homeAssistantUrl,
      tokenEnv: HOME_ASSISTANT_TOKEN_ENV,
      entities,
      buttons: {},
      music: {},
      switches: {},
    },
    mqtt: {
      url: mqttUrl,
      baseTopic,
      maxAgeMs: 7000,
      clientId: `lugn-${randomBytes(8).toString('hex')}`,
      ...(brokerCredentialsRequired
        ? {
            usernameEnv: MQTT_USERNAME_ENV,
            passwordEnv: MQTT_PASSWORD_ENV,
          }
        : {}),
    },
    prelight: { targets: prelightTargets, maxDurationMs: 5000 },
    scenes: [],
  };

  try {
    validateRuntimeFileConfig(config);
    const envValues: Array<[string, string]> = [
      [HOME_ASSISTANT_TOKEN_ENV, homeAssistantToken],
      [LUGN_API_TOKEN_ENV, apiToken],
    ];
    if (mqttUsername !== undefined && mqttPassword !== undefined) {
      envValues.push([MQTT_USERNAME_ENV, mqttUsername]);
      envValues.push([MQTT_PASSWORD_ENV, mqttPassword]);
    }
    const secretEnvironment = `${envValues
      .map(([name, value]) => formatEnvironmentAssignment(name, value))
      .join('\n')}\n`;
    writeSecureCommissioningFiles(
      paths.configPath,
      paths.environmentPath,
      `${JSON.stringify(config, null, 2)}\n`,
      secretEnvironment,
      existingFiles.length > 0,
    );
  } catch {
    io.writeLine(
      'Could not securely save the configuration. Check file permissions and paths; no credentials were printed.',
    );
    return 1;
  }

  io.writeLine('');
  io.writeLine(`Config saved: ${paths.configPath}`);
  io.writeLine(
    `Secret environment saved with mode 0600: ${paths.environmentPath}`,
  );
  io.writeLine(
    'Home Assistant entity discovery was read-only; no device command was sent.',
  );
  io.writeLine('The MQTT client ID is unique to this Lugn installation.');
  io.writeLine(
    'Next, run the read-only preflight with the same config and secret file.',
  );
  io.writeLine(
    `  node --env-file=${shellQuote(paths.environmentPath)} dist/runtime/preflight.js ${shellQuote(paths.configPath)}`,
  );
  io.writeLine(
    'The Lugn service was not started. Review the config before enabling it.',
  );
  io.writeLine(
    'Lugn adds its room presets at runtime; fast entry lighting uses the selected temporary brightness.',
  );
  return 0;
}

/** Writes both files through protected sibling temporaries and rolls back partial replacements. */
export function writeSecureCommissioningFiles(
  configPath: string,
  environmentPath: string,
  configText: string,
  environmentText: string,
  overwrite: boolean,
): void {
  const configTarget = resolve(configPath);
  const environmentTarget = resolve(environmentPath);
  if (configTarget === environmentTarget)
    throw new Error('target paths must differ');

  const existing = inspectOutputTargets(configTarget, environmentTarget);
  if (existing.length > 0 && !overwrite) throw new Error('overwrite required');

  for (const parent of new Set([
    dirname(configTarget),
    dirname(environmentTarget),
  ])) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }

  const suffix = randomBytes(8).toString('hex');
  const temporaryConfig = join(
    dirname(configTarget),
    `.${basename(configTarget)}.${suffix}.tmp`,
  );
  const temporaryEnvironment = join(
    dirname(environmentTarget),
    `.${basename(environmentTarget)}.${suffix}.tmp`,
  );
  const backups: Array<{ target: string; backup: string }> = [];
  const installed: string[] = [];
  let committed = false;

  try {
    writeTemporaryFile(temporaryConfig, configText);
    writeTemporaryFile(temporaryEnvironment, environmentText);

    for (const target of [configTarget, environmentTarget]) {
      if (!existsSync(target)) continue;
      const backup = `${target}.${suffix}.backup`;
      renameSync(target, backup);
      backups.push({ target, backup });
    }

    renameSync(temporaryConfig, configTarget);
    installed.push(configTarget);
    renameSync(temporaryEnvironment, environmentTarget);
    installed.push(environmentTarget);
    committed = true;
  } catch (error) {
    for (const target of installed) {
      try {
        rmSync(target, { force: true });
      } catch {
        // Retain the backup below if rollback cannot remove the partial output.
      }
    }
    for (const { target, backup } of backups.reverse()) {
      try {
        if (existsSync(backup)) renameSync(backup, target);
      } catch {
        // Preserve the named backup to allow manual recovery.
      }
    }
    throw error;
  } finally {
    rmSync(temporaryConfig, { force: true });
    rmSync(temporaryEnvironment, { force: true });
  }
  if (committed) {
    for (const { backup } of backups) {
      try {
        rmSync(backup, { force: true });
      } catch {
        // A protected backup is safer than undoing an already committed pair.
      }
    }
  }
}

/** TTY prompt implementation that manually echoes only non-secret input. */
export function createTerminalOnboardingIO(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): OnboardingIO {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('interactive terminal required');
  }
  emitKeypressEvents(input);

  return {
    prompt(question, options = {}) {
      output.write(`${question}: `);
      input.setRawMode(true);
      input.resume();
      return new Promise((resolvePrompt, rejectPrompt) => {
        let characters: string[] = [];
        const finish = (error?: Error): void => {
          input.off('keypress', onKeypress);
          input.setRawMode(false);
          input.pause();
          output.write('\n');
          if (error) rejectPrompt(error);
          else resolvePrompt(characters.join(''));
        };
        const onKeypress = (
          character: string,
          key?: { name?: string; ctrl?: boolean; meta?: boolean },
        ): void => {
          if (key?.ctrl && key.name === 'c') {
            finish(new Error('cancelled'));
            return;
          }
          if (
            key?.name === 'return' ||
            key?.name === 'enter' ||
            character === '\r' ||
            character === '\n'
          ) {
            finish();
            return;
          }
          if (key?.name === 'backspace' || key?.name === 'delete') {
            if (characters.length > 0) {
              characters = characters.slice(0, -1);
              if (!options.secret) output.write('\b \b');
            }
            return;
          }
          if (key?.ctrl || key?.meta || !character || /[\r\n]/.test(character))
            return;
          characters.push(character);
          if (!options.secret) output.write(character);
        };
        input.on('keypress', onKeypress);
      });
    },
    writeLine(value) {
      output.write(`${value}\n`);
    },
  };
}

function parseArguments(args: string[]): ParsedArguments {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.some((argument) => argument.startsWith('--')) || args.length > 2) {
    throw new Error('invalid arguments');
  }
  return {
    help: false,
    ...(args[0] === undefined ? {} : { configPath: args[0] }),
    ...(args[1] === undefined ? {} : { environmentPath: args[1] }),
  };
}

function resolveCommissioningPaths(
  args: Extract<ParsedArguments, { help: false }>,
  environment: NodeJS.ProcessEnv,
  dependencies: OnboardingDependencies,
): { configPath: string; environmentPath: string } {
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const home = resolve(
    dependencies.homeDirectory ?? environment['HOME'] ?? homedir(),
  );
  const installedConfig = join(home, '.config', 'lugn', 'config.json');
  const defaultConfig = existsSync(installedConfig)
    ? installedConfig
    : join(cwd, 'config.json');
  const configPath = resolve(
    args.configPath ?? environment['LUGN_CONFIG_PATH'] ?? defaultConfig,
  );
  const defaultEnvironmentPath = join(dirname(configPath), 'lugn.env');
  return {
    configPath,
    environmentPath: resolve(
      args.environmentPath ??
        environment['LUGN_ENV_FILE'] ??
        defaultEnvironmentPath,
    ),
  };
}

function inspectOutputTargets(...paths: string[]): string[] {
  const existing: string[] = [];
  for (const path of paths) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error('unsafe target');
      existing.push(path);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
  }
  return existing;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function writeTemporaryFile(path: string, content: string): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function confirm(
  io: OnboardingIO,
  question: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? '[Y/n]' : '[y/N]';
  const answer = (await io.prompt(`${question} ${suffix}`))
    .trim()
    .toLowerCase();
  if (!answer) return defaultValue;
  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;
  io.writeLine('Please answer yes or no.');
  return confirm(io, question, defaultValue);
}

async function promptUrl(
  io: OnboardingIO,
  question: string,
  defaultValue: string | undefined,
  validator: (value: string) => boolean,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await io.prompt(`${question}${suffix}`)).trim();
    const value = answer || defaultValue || '';
    if (validator(value)) return value.replace(/\/+$/, '');
    io.writeLine(
      'That URL is invalid. Use the expected protocol and omit credentials, query, and fragment.',
    );
  }
  io.writeLine('Too many invalid URL attempts. No files were changed.');
  return undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !value.includes('?') &&
      !value.includes('#')
    );
  } catch {
    return false;
  }
}

function isMqttUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'mqtt:' || url.protocol === 'mqtts:') &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !value.includes('?') &&
      !value.includes('#')
    );
  } catch {
    return false;
  }
}

async function promptSecret(
  io: OnboardingIO,
  question: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await io.prompt(question, { secret: true });
    if (value.trim().length > 0 && !/[\r\n]/.test(value)) return value;
    io.writeLine('A non-empty single-line value is required.');
  }
  io.writeLine('Too many invalid secret attempts. No files were changed.');
  return undefined;
}

async function promptIndices(
  io: OnboardingIO,
  question: string,
  maximum: number,
): Promise<number[] | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = (await io.prompt(`${question} (1-${maximum})`)).trim();
    const pieces = answer.split(',').map((piece) => piece.trim());
    const indices = pieces.map((piece) => Number(piece));
    if (
      answer.length > 0 &&
      indices.every(
        (index) => Number.isInteger(index) && index >= 1 && index <= maximum,
      ) &&
      new Set(indices).size === indices.length
    ) {
      return indices;
    }
    io.writeLine('Choose valid, non-repeated numbers from the displayed list.');
  }
  io.writeLine('Too many invalid selections. No files were changed.');
  return undefined;
}

async function promptSemanticSlug(
  io: OnboardingIO,
  question: string,
  suggested: string,
  assigned: Record<string, string>,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = (await io.prompt(`${question} [${suggested}]`)).trim();
    const slug = (raw || suggested).toLowerCase().replace(/[\s-]+/g, '_');
    const semanticId = `lighting.${slug}`;
    if (/^[a-z0-9][a-z0-9._-]*$/.test(slug) && !assigned[semanticId]) {
      return slug;
    }
    io.writeLine(
      'Use a unique name with lowercase letters, numbers, dots, dashes, or underscores.',
    );
  }
  io.writeLine('Too many invalid names. No files were changed.');
  return undefined;
}

async function promptTopic(
  io: OnboardingIO,
  defaultValue: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = (
      await io.prompt(`STL27L MQTT base topic [${defaultValue}]`)
    ).trim();
    const value = answer || defaultValue;
    const normalized = value.replace(/\/+$/, '');
    if (normalized.length > 0 && !/[\s+#]/.test(value)) return normalized;
    io.writeLine('Enter a base topic without spaces or MQTT wildcards.');
  }
  io.writeLine('Too many invalid topics. No files were changed.');
  return undefined;
}

async function promptInteger(
  io: OnboardingIO,
  question: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): Promise<number | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = (await io.prompt(`${question} [${defaultValue}]`)).trim();
    const value = answer ? Number(answer) : defaultValue;
    if (Number.isInteger(value) && value >= minimum && value <= maximum)
      return value;
    io.writeLine(`Enter a whole number from ${minimum} to ${maximum}.`);
  }
  io.writeLine('Too many invalid values. No files were changed.');
  return undefined;
}

async function promptOptionalInteger(
  io: OnboardingIO,
  question: string,
  defaultValue: string,
  minimum: number,
  maximum: number,
): Promise<number | null | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = (await io.prompt(`${question} [${defaultValue}]`)).trim();
    if (!answer) {
      const value = Number(defaultValue);
      if (Number.isInteger(value) && value >= minimum && value <= maximum)
        return value;
      return null;
    }
    if (answer.toLowerCase() === 'skip' || answer.toLowerCase() === 'none')
      return null;
    const value = Number(answer);
    if (Number.isInteger(value) && value >= minimum && value <= maximum)
      return value;
    io.writeLine(
      `Enter a whole number from ${minimum} to ${maximum}, or type skip.`,
    );
  }
  io.writeLine('Too many invalid values. No files were changed.');
  return undefined;
}

function formatEnvironmentAssignment(name: string, value: string): string {
  if (/[\r\n\u0000]/.test(value))
    throw new Error('environment values must be one line');
  return `${name}=${Buffer.from(value, 'utf8').toString('base64url')}`;
}

function formatDiscoveryFailure(error: unknown): string {
  if (error instanceof HaDiscoverError) return error.message;
  return 'request failed. Check the address and credentials, then try again.';
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function isOnboardingDirectExecution(
  argvPath: string | undefined,
  moduleUrl: string,
): boolean {
  return isDirectExecution(argvPath, moduleUrl);
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes('--help')) {
    const io: OnboardingIO = {
      prompt: async () => '',
      writeLine: (value) => console.log(value),
    };
    process.exitCode = await runOnboardingCli(process.argv.slice(2), { io });
    return;
  }

  let io: OnboardingIO;
  try {
    io = createTerminalOnboardingIO();
  } catch {
    console.error(
      '[lugn] onboarding requires an interactive SSH/local terminal.',
    );
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = await runOnboardingCli(process.argv.slice(2), { io });
  } catch {
    io.writeLine('Onboarding stopped safely. No secret values were printed.');
    process.exitCode = 1;
  }
}

if (isOnboardingDirectExecution(process.argv[1], import.meta.url)) {
  void main();
}
