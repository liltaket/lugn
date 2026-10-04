import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadRuntimeConfig,
  validateStateDirectoryAncestors,
} from '../src/runtime/config.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('runtime configuration cross references', () => {
  const minimal = {
    homeAssistant: {
      baseUrl: 'http://ha.local',
      tokenEnv: 'HA_TOKEN',
      entities: { 'lighting.ceiling': 'light.ceiling' },
    },
    scenes: [],
  };
  it('validates per-light control modes and requires mapped targets', () => {
    expect(loadConfig(minimal).lightingControlModes).toEqual({});
    expect(
      loadConfig({
        ...minimal,
        lightingControlModes: { 'lighting.ceiling': 'enforce' },
      }).lightingControlModes,
    ).toEqual({ 'lighting.ceiling': 'enforce' });
    for (const lightingControlModes of [
      { 'lighting.missing': 'enforce' },
      { 'lighting.ceiling': 'unsupported' },
      { 'switch.ceiling': 'enforce' },
    ])
      expect(() => loadConfig({ ...minimal, lightingControlModes })).toThrow(
        'Invalid configuration',
      );
  });
  it('defaults absent music mappings to empty and resolves configured music sources', () => {
    expect(loadConfig(minimal).homeAssistant.buttons).toEqual({});
    expect(loadConfig(minimal).homeAssistant.music).toEqual({});
    expect(
      loadConfig({
        ...minimal,
        homeAssistant: {
          ...minimal.homeAssistant,
          music: {
            'music.room': {
              entityId: 'media_player.room',
              sources: ['Optical'],
            },
          },
        },
      }).homeAssistant.music,
    ).toEqual({
      'music.room': {
        entityId: 'media_player.room',
        sources: ['Optical'],
        presets: { spotify_dj: 1, optical: 4 },
      },
    });
  });
  it('resolves distinct configured semantic buttons', () => {
    expect(
      loadConfig({
        ...minimal,
        homeAssistant: {
          ...minimal.homeAssistant,
          buttons: { 'button.pc_lock': 'button.pc_lock' },
        },
      }).homeAssistant.buttons,
    ).toEqual({ 'button.pc_lock': 'button.pc_lock' });

    for (const buttons of [
      { 'button.a': 'button.same', 'button.b': 'button.same' },
      { 'button.a': 'switch.same' },
      { 'switch.a': 'button.same' },
    ]) {
      expect(() =>
        loadConfig({
          ...minimal,
          homeAssistant: { ...minimal.homeAssistant, buttons },
        }),
      ).toThrow('Invalid configuration');
    }
  });
  it('rejects duplicate media mappings and duplicate or empty sources', () => {
    for (const music of [
      {
        'music.one': { entityId: 'media_player.room', sources: [] },
        'music.two': { entityId: 'media_player.room', sources: [] },
      },
      {
        'music.one': {
          entityId: 'media_player.room',
          sources: ['Optical', 'Optical'],
        },
      },
      { 'music.one': { entityId: 'media_player.room', sources: [''] } },
    ])
      expect(() =>
        loadConfig({
          ...minimal,
          homeAssistant: { ...minimal.homeAssistant, music },
        }),
      ).toThrow('Invalid configuration');
  });
  it('requires the default scene light IDs when scenes are omitted', () => {
    expect(() =>
      loadConfig({
        homeAssistant: {
          baseUrl: 'http://homeassistant.local:8123',
          tokenEnv: 'HA_TOKEN',
          entities: { 'lighting.ceiling': 'light.ceiling' },
        },
      }),
    ).toThrow(
      'Scene target lighting.desk is not mapped in homeAssistant.entities',
    );
  });

  it('requires configured lights for explicit scene and prelight targets', () => {
    expect(() =>
      loadConfig({
        homeAssistant: {
          baseUrl: 'http://homeassistant.local:8123',
          tokenEnv: 'HA_TOKEN',
          entities: { 'lighting.ceiling': 'light.ceiling' },
        },
        scenes: [
          {
            id: 'scene.custom',
            name: 'Custom',
            lighting: { 'lighting.desk': { power: true } },
          },
        ],
        prelight: {
          targets: { 'lighting.desk': { power: true } },
        },
      }),
    ).toThrow(/Scene target lighting\.desk.*Prelight target lighting\.desk/);
  });

  it('accepts only a configured default scene', () => {
    const configuredScenes = [
      {
        id: 'scene.everyday',
        name: 'Everyday',
        lighting: { 'lighting.ceiling': { power: true } },
      },
    ];
    expect(
      loadConfig({
        ...minimal,
        scenes: configuredScenes,
        defaultSceneId: 'scene.everyday',
      }).defaultSceneId,
    ).toBe('scene.everyday');
    expect(() =>
      loadConfig({
        ...minimal,
        scenes: configuredScenes,
        defaultSceneId: 'scene.missing',
      }),
    ).toThrow('defaultSceneId: Default scene scene.missing is not configured');
    expect(loadConfig(minimal).defaultSceneId).toBeUndefined();
  });

  it('requires a bearer token for trusted proxy origins and accepts bare origins only', () => {
    expect(loadConfig(minimal).http.trustedOrigins).toEqual([]);
    expect(() =>
      loadConfig({
        ...minimal,
        http: { trustedOrigins: ['https://lugn.example.test'] },
      }),
    ).toThrow('trustedOrigins requires an HTTP bearer token');

    expect(
      loadConfig(
        {
          ...minimal,
          http: {
            bearerTokenEnv: 'API_TOKEN_B64',
            trustedOrigins: [
              'https://lugn.example.test',
              'http://lugn.example.test',
            ],
          },
        },
        {
          HA_TOKEN: 'ha-token',
          API_TOKEN_B64: Buffer.from('api-token').toString('base64url'),
        },
      ).http.trustedOrigins,
    ).toEqual(['https://lugn.example.test', 'http://lugn.example.test']);

    expect(() =>
      loadConfig({
        ...minimal,
        http: {
          bearerTokenEnv: 'API_TOKEN',
          trustedOrigins: ['https://lugn.example.test/panel'],
        },
      }),
    ).toThrow('Invalid configuration');
  });

  it('keeps persisted state inside the service writable state directory', () => {
    const stateDirectory = join(homedir(), '.local', 'state', 'lugn');
    expect(loadConfig(minimal).statePath).toBe(
      join(stateDirectory, 'lighting-intent.json'),
    );
    const customPath = join(stateDirectory, 'custom.json');
    expect(loadConfig({ ...minimal, statePath: customPath }).statePath).toBe(
      customPath,
    );
    expect(
      loadConfig(minimal, {
        HA_TOKEN: 'deterministic-test-token',
        LUGN_STATE_PATH: customPath,
      }).statePath,
    ).toBe(customPath);

    for (const statePath of [
      join(tmpdir(), 'outside.json'),
      join(stateDirectory, 'nested', 'lighting-intent.json'),
      'relative.json',
    ])
      expect(() => loadConfig({ ...minimal, statePath })).toThrow(
        'statePath must be',
      );
  });

  it('rejects symlinked state directory ancestors', () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), 'lugn-state-home-'));
    temporaryDirectories.push(homeDirectory);
    const outside = join(homeDirectory, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(homeDirectory, '.local'), 'dir');

    expect(() => validateStateDirectoryAncestors(homeDirectory)).toThrow(
      'must be a regular directory',
    );
  });

  it('decodes canonical base64url secret references and rejects malformed values without echoing them', () => {
    const secret = `a token with 'quotes" and backtick\n?`;
    const base64Config = {
      ...minimal,
      homeAssistant: { ...minimal.homeAssistant, tokenEnv: 'HA_TOKEN_B64' },
    };
    const validEnvironment = {
      HA_TOKEN_B64: Buffer.from(secret, 'utf8').toString('base64url'),
    };
    expect(loadConfig(base64Config, validEnvironment).homeAssistant.token).toBe(
      secret,
    );

    const missingError = captureConfigError(() => loadConfig(base64Config, {}));
    expect(missingError.message).toContain('HA_TOKEN_B64');
    expect(missingError.message).not.toContain(secret);

    for (const malformed of ['%%%invalid', 'abc=', 'not-base64!']) {
      const error = captureConfigError(() =>
        loadConfig(base64Config, { HA_TOKEN_B64: malformed }),
      );
      expect(error.message).toContain('invalid base64url encoding');
      expect(error.message).not.toContain(malformed);
    }
  });
});

function loadConfig(
  config: unknown,
  environment: NodeJS.ProcessEnv = { HA_TOKEN: 'deterministic-test-token' },
): ReturnType<typeof loadRuntimeConfig> {
  const directory = mkdtempSync(join(tmpdir(), 'lugn-runtime-config-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify(config), 'utf8');
  return loadRuntimeConfig(path, environment);
}

function captureConfigError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected config load to fail');
}
