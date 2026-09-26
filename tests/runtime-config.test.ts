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
});

function loadConfig(config: unknown): ReturnType<typeof loadRuntimeConfig> {
  const directory = mkdtempSync(join(tmpdir(), 'lugn-runtime-config-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify(config), 'utf8');
  return loadRuntimeConfig(path, { HA_TOKEN: 'deterministic-test-token' });
}
