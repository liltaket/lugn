import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../src/runtime/config.js';

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
      'music.room': { entityId: 'media_player.room', sources: ['Optical'] },
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
