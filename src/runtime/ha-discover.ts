import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REQUEST_TIMEOUT_MS = 10_000;
const ENTITY_ID_SHAPE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const CANDIDATE_ENTITY_ID = /^(button|light|switch|media_player)\.[a-z0-9_]+$/;

export type HomeAssistantCandidates = {
  button: string[];
  light: string[];
  switch: string[];
  media_player: Array<{ entity_id: string; source_list: string[] }>;
};

type DiscoveryOptions = {
  url?: string;
  help?: boolean;
};

export class HaDiscoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HaDiscoverError';
  }
}

/** Fetches Home Assistant states and returns only candidate IDs and media sources. */
export async function discoverHomeAssistant(
  baseUrl: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<HomeAssistantCandidates> {
  const endpoint = buildStatesUrl(baseUrl);
  if (!token.trim() || /[\r\n]/.test(token)) {
    throw new HaDiscoverError('A valid Home Assistant token is required.');
  }

  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new HaDiscoverError(
      'Home Assistant could not be reached or the request timed out.',
    );
  }

  if (!response.ok) {
    throw new HaDiscoverError(
      `Home Assistant returned HTTP ${response.status}. Check the URL and token.`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HaDiscoverError('Home Assistant returned an invalid state list.');
  }

  return parseCandidates(payload);
}

export function parseCandidates(payload: unknown): HomeAssistantCandidates {
  if (!Array.isArray(payload)) {
    throw new HaDiscoverError('Home Assistant returned an invalid state list.');
  }

  const candidates: HomeAssistantCandidates = {
    button: [],
    light: [],
    switch: [],
    media_player: [],
  };

  for (const item of payload) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new HaDiscoverError(
        'Home Assistant returned an invalid state list.',
      );
    }

    const stateRecord = item as Record<string, unknown>;
    const entityId = stateRecord['entity_id'];
    const attributes = stateRecord['attributes'];
    if (
      typeof entityId !== 'string' ||
      !ENTITY_ID_SHAPE.test(entityId) ||
      typeof stateRecord['state'] !== 'string' ||
      typeof attributes !== 'object' ||
      attributes === null ||
      Array.isArray(attributes)
    ) {
      throw new HaDiscoverError(
        'Home Assistant returned an invalid state list.',
      );
    }

    const domain = entityId.slice(0, entityId.indexOf('.'));
    if (
      domain !== 'button' &&
      domain !== 'light' &&
      domain !== 'switch' &&
      domain !== 'media_player'
    ) {
      continue;
    }
    if (!CANDIDATE_ENTITY_ID.test(entityId)) {
      throw new HaDiscoverError(
        'Home Assistant returned an invalid state list.',
      );
    }

    if (domain === 'media_player') {
      const sourceList = (attributes as Record<string, unknown>)['source_list'];
      if (
        sourceList !== undefined &&
        (!Array.isArray(sourceList) ||
          sourceList.some((source) => typeof source !== 'string'))
      ) {
        throw new HaDiscoverError(
          'Home Assistant returned an invalid state list.',
        );
      }
      candidates.media_player.push({
        entity_id: entityId,
        source_list: sourceList === undefined ? [] : [...sourceList],
      });
      continue;
    }

    if (domain === 'button') {
      candidates.button.push(entityId);
      continue;
    }

    candidates[domain].push(entityId);
  }

  candidates.button.sort();
  candidates.light.sort();
  candidates.switch.sort();
  candidates.media_player.sort((left, right) =>
    left.entity_id.localeCompare(right.entity_id),
  );
  return candidates;
}

function buildStatesUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HaDiscoverError('A valid Home Assistant URL is required.');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    baseUrl.includes('?') ||
    baseUrl.includes('#')
  ) {
    throw new HaDiscoverError(
      'Home Assistant URL must use HTTP or HTTPS and contain no credentials, query, or fragment.',
    );
  }

  const pathPrefix = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathPrefix}/api/states`;
}

function parseOptions(
  args: string[],
  environment: NodeJS.ProcessEnv,
): { help: true } | { help: false; url?: string } {
  if (args.length === 1 && args[0] === '--help') return { help: true };

  let url: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== '--url') {
      throw new HaDiscoverError('Use --help to see supported options.');
    }
    const value = args[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new HaDiscoverError(`A value is required after ${flag}.`);
    }
    if (url !== undefined)
      throw new HaDiscoverError('Specify --url only once.');
    url = value;
    index += 1;
  }

  const selectedUrl = url ?? environment['HOME_ASSISTANT_URL'];
  return {
    help: false,
    ...(selectedUrl === undefined ? {} : { url: selectedUrl }),
  };
}

const HELP_TEXT = [
  'Usage: npm run ha:discover -- [--url <home-assistant-url>]',
  '',
  'Reads Home Assistant entity IDs using GET /api/states.',
  'HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN provide the URL and token.',
  'The URL may be overridden with --url. Keep the token in the environment.',
  'Output includes candidate button, light, switch, and media_player IDs; media players include source_list.',
].join('\n');

export function isDirectExecution(
  executablePath: string | undefined,
  moduleUrl: string,
): boolean {
  if (!executablePath) return false;
  try {
    return (
      realpathSync(executablePath) === realpathSync(fileURLToPath(moduleUrl))
    );
  } catch {
    return false;
  }
}

export async function runHaDiscoverCli(
  args: string[],
  environment: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
  writeOutput: (value: string) => void,
  writeError: (value: string) => void,
): Promise<number> {
  let options: DiscoveryOptions;
  try {
    options = parseOptions(args, environment);
  } catch (error) {
    writeError(
      error instanceof HaDiscoverError
        ? error.message
        : 'Home Assistant discovery arguments are invalid.',
    );
    return 2;
  }

  if (options.help) {
    writeOutput(HELP_TEXT);
    return 0;
  }
  if (!options.url) {
    writeError('Set HOME_ASSISTANT_URL or pass --url.');
    return 2;
  }
  const token = environment['HOME_ASSISTANT_TOKEN'];
  if (!token) {
    writeError('Set HOME_ASSISTANT_TOKEN in the environment.');
    return 2;
  }

  try {
    const result = await discoverHomeAssistant(options.url, token, fetcher);
    writeOutput(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    writeError(
      error instanceof HaDiscoverError
        ? error.message
        : 'Home Assistant discovery failed. Check the URL, token, and connection.',
    );
    return 1;
  }
}

async function main(): Promise<void> {
  const exitCode = await runHaDiscoverCli(
    process.argv.slice(2),
    process.env,
    fetch,
    (value) => console.log(value),
    (value) => console.error(`[lugn] ${value}`),
  );
  process.exitCode = exitCode;
}

if (isDirectExecution(process.argv[1], import.meta.url)) {
  void main();
}
