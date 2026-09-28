import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  discoverHomeAssistant,
  discoverHomeAssistantLightChoices,
  isDirectExecution,
  parseCandidates,
  runHaDiscoverCli,
} from '../src/runtime/ha-discover.js';

const token = 'test-secret-token';

describe('Home Assistant discovery', () => {
  it('recognizes absolute and symlinked executable paths by their real path', () => {
    const directory = mkdtempSync(join('/tmp', 'lugn-ha-discover-path-'));
    const scriptPath = join(directory, 'ha-discover.js');
    const symlinkPath = join(directory, 'ha-discover-link.js');
    try {
      writeFileSync(scriptPath, '');
      symlinkSync(scriptPath, symlinkPath);
      const moduleUrl = pathToFileURL(realpathSync(scriptPath)).href;

      expect(isDirectExecution(scriptPath, moduleUrl)).toBe(true);
      expect(isDirectExecution(symlinkPath, moduleUrl)).toBe(true);
      expect(isDirectExecution(undefined, moduleUrl)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns sorted candidate IDs and only media source lists', () => {
    const candidates = parseCandidates([
      { entity_id: 'button.pc_lock', state: 'unknown', attributes: {} },
      {
        entity_id: 'light.zed',
        state: 'on',
        attributes: { brightness: 255, private_marker: 'do-not-print' },
      },
      {
        entity_id: 'media_player.kitchen',
        state: 'playing',
        attributes: {
          source_list: ['Spotify', 'Line In'],
          media_title: 'private title',
        },
      },
      { entity_id: 'sensor.temperature', state: '18', attributes: {} },
      { entity_id: 'switch.desk', state: 'off', attributes: {} },
      { entity_id: 'light.arbeitszimmer', state: 'off', attributes: {} },
      { entity_id: 'media_player.no_sources', state: 'idle', attributes: {} },
    ]);

    expect(candidates).toEqual({
      button: ['button.pc_lock'],
      light: ['light.arbeitszimmer', 'light.zed'],
      switch: ['switch.desk'],
      media_player: [
        {
          entity_id: 'media_player.kitchen',
          source_list: ['Spotify', 'Line In'],
        },
        { entity_id: 'media_player.no_sources', source_list: [] },
      ],
    });
    expect(JSON.stringify(candidates)).not.toContain('private');
  });

  it('makes one authenticated GET to the states endpoint and passes a timeout signal', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return Response.json([
        { entity_id: 'light.desk', state: 'on', attributes: {} },
      ]);
    };

    await expect(
      discoverHomeAssistant('http://ha.test:8123/ha/', token, fetcher),
    ).resolves.toEqual({
      button: [],
      light: ['light.desk'],
      switch: [],
      media_player: [],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://ha.test:8123/ha/api/states');
    expect(requests[0]?.init?.method).toBe('GET');
    expect(requests[0]?.init?.body).toBeUndefined();
    expect(requests[0]?.init?.headers).toEqual({
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    });
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('provides terminal-safe friendly names for the interactive light picker only', async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requests.push(String(input));
      return Response.json([
        {
          entity_id: 'light.desk',
          state: 'on',
          attributes: { friendly_name: 'Desk\u001b[2J\u202eLamp' },
        },
        {
          entity_id: 'light.long_name',
          state: 'off',
          attributes: { friendly_name: 'A'.repeat(100) },
        },
      ]);
    };

    await expect(
      discoverHomeAssistantLightChoices('http://ha.test:8123', token, fetcher),
    ).resolves.toEqual([
      { entity_id: 'light.desk', friendly_name: 'Desk[2JLamp' },
      { entity_id: 'light.long_name', friendly_name: 'A'.repeat(80) },
    ]);
    expect(requests).toEqual(['http://ha.test:8123/api/states']);
  });

  it.each([
    'mqtt://ha.test',
    'file:///tmp/ha',
    'http://user:password@ha.test',
    'http://ha.test?token=secret',
    'http://ha.test#fragment',
  ])(
    'rejects unsafe Home Assistant URL %s before making a request',
    async (url) => {
      let called = false;
      const fetcher: typeof fetch = async () => {
        called = true;
        return Response.json([]);
      };

      await expect(discoverHomeAssistant(url, token, fetcher)).rejects.toThrow(
        'Home Assistant URL must use HTTP or HTTPS',
      );
      expect(called).toBe(false);
    },
  );

  it('validates the response shape and media source list', () => {
    for (const payload of [
      {},
      [null],
      [{ state: 'on' }],
      [{ entity_id: 'light.missing_state', attributes: {} }],
      [{ entity_id: 'light/broken', state: 'on', attributes: {} }],
      [
        {
          entity_id: 'media_player.broken',
          state: 'idle',
          attributes: { source_list: 'Spotify' },
        },
      ],
    ]) {
      expect(() => parseCandidates(payload)).toThrow(
        'Home Assistant returned an invalid state list.',
      );
    }
  });

  it('does not expose response bodies, transport errors, or tokens in failures', async () => {
    const unauthorized: typeof fetch = async () =>
      new Response(`contains ${token}`, { status: 401 });
    await expect(
      discoverHomeAssistant('http://ha.test', token, unauthorized),
    ).rejects.toThrow('HTTP 401');

    const failingTransport: typeof fetch = async () => {
      throw new Error(`request failed for Bearer ${token}`);
    };
    await expect(
      discoverHomeAssistant('http://ha.test', token, failingTransport),
    ).rejects.toThrow('could not be reached or the request timed out');
  });

  it('supports help, environment defaults, and flag overrides without printing the token', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    let requestUrl = '';
    let requestAuthorization = '';
    const fetcher: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestAuthorization =
        new Headers(init?.headers).get('authorization') ?? '';
      return Response.json([
        {
          entity_id: 'media_player.living_room',
          state: 'playing',
          attributes: {
            source_list: ['Spotify'],
            media_title: 'private title',
          },
        },
      ]);
    };

    await expect(
      runHaDiscoverCli(
        ['--help'],
        {},
        fetcher,
        (value) => output.push(value),
        (value) => errors.push(value),
      ),
    ).resolves.toBe(0);
    expect(output[0]).toContain('GET /api/states');
    expect(errors).toEqual([]);

    output.length = 0;
    await expect(
      runHaDiscoverCli(
        ['--url', 'http://override.test'],
        {
          HOME_ASSISTANT_URL: 'http://environment.test',
          HOME_ASSISTANT_TOKEN: token,
        },
        fetcher,
        (value) => output.push(value),
        (value) => errors.push(value),
      ),
    ).resolves.toBe(0);
    expect(requestUrl).toBe('http://override.test/api/states');
    expect(requestAuthorization).toBe(`Bearer ${token}`);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain('media_player.living_room');
    expect(output[0]).toContain('Spotify');
    expect(output.join()).not.toContain(token);
    expect(output.join()).not.toContain('private title');
    expect(errors).toEqual([]);
  });

  it('reports missing configuration without calling Home Assistant', async () => {
    let called = false;
    const errors: string[] = [];
    const exitCode = await runHaDiscoverCli(
      [],
      {},
      async () => {
        called = true;
        return Response.json([]);
      },
      () => undefined,
      (value) => errors.push(value),
    );

    expect(exitCode).toBe(2);
    expect(errors).toEqual(['Set HOME_ASSISTANT_URL or pass --url.']);
    expect(called).toBe(false);

    errors.length = 0;
    const cliToken = 'must-not-be-accepted-on-command-line';
    const tokenFlagExitCode = await runHaDiscoverCli(
      ['--url', 'http://ha.test', '--token', cliToken],
      {
        HOME_ASSISTANT_URL: 'http://ha.test',
        HOME_ASSISTANT_TOKEN: token,
      },
      async () => {
        called = true;
        return Response.json([]);
      },
      () => undefined,
      (value) => errors.push(value),
    );

    expect(tokenFlagExitCode).toBe(2);
    expect(errors).toEqual(['Use --help to see supported options.']);
    expect(errors.join()).not.toContain(cliToken);
    expect(called).toBe(false);
  });
});
