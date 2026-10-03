import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../src/runtime/config.js';
import { runOnboardingCli, type OnboardingIO } from '../src/runtime/onboard.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'lugn-onboard-test-'));
  directories.push(directory);
  return directory;
}

function fakeIO(answers: string[]): {
  io: OnboardingIO;
  output: string[];
  prompts: Array<{ question: string; secret: boolean }>;
} {
  const output: string[] = [];
  const prompts: Array<{ question: string; secret: boolean }> = [];
  return {
    output,
    prompts,
    io: {
      async prompt(question, options = {}) {
        prompts.push({ question, secret: options.secret ?? false });
        const answer = answers.shift();
        if (answer === undefined)
          throw new Error('test prompt answers exhausted');
        return answer;
      },
      writeLine(value) {
        output.push(value);
      },
    },
  };
}

const discoveredStates = [
  {
    entity_id: 'light.ceiling',
    state: 'off',
    attributes: { friendly_name: 'Ceiling\u001b[2J\u202e' },
  },
  {
    entity_id: 'light.desk',
    state: 'off',
    attributes: { friendly_name: 'Desk' },
  },
  { entity_id: 'sensor.temperature', state: '18', attributes: {} },
];

describe('interactive commissioning wizard', () => {
  it('discovers lights read-only, writes mappings and protected secrets, and leaves devices untouched', async () => {
    const directory = createDirectory();
    const configPath = join(directory, 'config.json');
    const environmentPath = join(directory, 'lugn.env');
    const token = 'private-ha-token-value';
    const brokerPassword = ["pass'word", 'with"quotes', ' # and \\slash'].join(
      '`',
    );
    const { io, output, prompts } = fakeIO([
      'http://ha.test:8123',
      token,
      '1,2',
      'ceiling',
      'desk',
      'mqtt://broker.test:1883',
      '',
      'y',
      'operator',
      brokerPassword,
      '',
      '1,2',
      '35',
      'skip',
    ]);
    const requests: Array<{
      url: string;
      method: string | undefined;
      authorization: string | null;
    }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Response.json(discoveredStates);
    };

    const exitCode = await runOnboardingCli([configPath, environmentPath], {
      io,
      fetcher,
      createToken: () => 'generated-local-api-token',
    });

    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      {
        url: 'http://ha.test:8123/api/states',
        method: 'GET',
        authorization: `Bearer ${token}`,
      },
    ]);
    expect(
      prompts
        .filter((prompt) => prompt.secret)
        .map((prompt) => prompt.question),
    ).toEqual([
      'Home Assistant long-lived access token',
      'MQTT username',
      'MQTT password',
    ]);

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      homeAssistant: { entities: Record<string, string> };
      mqtt: { baseTopic: string; usernameEnv?: string; passwordEnv?: string };
      defaultSceneId?: string;
      prelight: {
        targets: Record<
          string,
          { brightness: number; colorTemperature?: number }
        >;
      };
      scenes?: Array<{ lighting: Record<string, unknown> }>;
    };
    expect(config.homeAssistant.entities).toEqual({
      'lighting.ceiling': 'light.ceiling',
      'lighting.desk': 'light.desk',
    });
    expect(config.defaultSceneId).toBeUndefined();
    expect(config.mqtt).toMatchObject({
      baseTopic: 'bruno/doorway',
      usernameEnv: 'MQTT_USERNAME_B64',
      passwordEnv: 'MQTT_PASSWORD_B64',
    });
    expect(config.prelight.targets).toEqual({
      'lighting.ceiling': { power: true, brightness: 35 },
      'lighting.desk': { power: true, brightness: 35 },
    });
    expect(config.scenes).toEqual([]);
    expect(lstatSync(configPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(environmentPath).mode & 0o777).toBe(0o600);

    const secretEnvironment = readFileSync(environmentPath, 'utf8');
    expect(secretEnvironment).not.toContain(token);
    expect(secretEnvironment).not.toContain(brokerPassword);
    expect(secretEnvironment).toContain(
      `LUGN_API_TOKEN_B64=${Buffer.from('generated-local-api-token').toString('base64url')}`,
    );
    const environment = Object.fromEntries(
      secretEnvironment
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    const runtimeConfig = loadRuntimeConfig(configPath, environment);
    expect(runtimeConfig.homeAssistant.token).toBe(token);
    expect(runtimeConfig.mqtt?.username).toBe('operator');
    expect(runtimeConfig.mqtt?.password).toBe(brokerPassword);
    expect(runtimeConfig.http.bearerToken).toBe('generated-local-api-token');
    expect(output.join('\n')).not.toContain(token);
    expect(output.join('\n')).not.toContain(brokerPassword);
    expect(output.join('\n')).not.toContain('generated-local-api-token');
    expect(output.join('\n')).toContain('will not control devices');
    expect(output.join('\n')).toContain('Ceiling');
    expect(output.join('\n')).not.toContain('\u001b');
    expect(output.join('\n')).not.toContain('\u202e');
  });

  it('requires confirmation before replacing either existing file', async () => {
    const directory = createDirectory();
    const configPath = join(directory, 'config.json');
    const environmentPath = join(directory, 'lugn.env');
    writeFileSync(configPath, 'keep config');
    writeFileSync(environmentPath, 'keep secrets');
    const { io } = fakeIO(['n']);
    let requestCount = 0;

    const exitCode = await runOnboardingCli([configPath, environmentPath], {
      io,
      fetcher: async () => {
        requestCount += 1;
        return Response.json(discoveredStates);
      },
    });

    expect(exitCode).toBe(1);
    expect(requestCount).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe('keep config');
    expect(readFileSync(environmentPath, 'utf8')).toBe('keep secrets');
  });

  it('does not echo a token when Home Assistant transport errors mention it', async () => {
    const directory = createDirectory();
    const configPath = join(directory, 'config.json');
    const environmentPath = join(directory, 'lugn.env');
    const token = 'must-not-leak-this-token';
    const { io, output } = fakeIO(['http://ha.test', token]);

    const exitCode = await runOnboardingCli([configPath, environmentPath], {
      io,
      fetcher: async () => {
        throw new Error(`transport error for bearer ${token}`);
      },
    });

    expect(exitCode).toBe(1);
    expect(output.join('\n')).not.toContain(token);
    expect(output.join('\n')).toContain(
      'could not be reached or the request timed out',
    );
  });
});
