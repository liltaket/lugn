import { describe, expect, it } from 'vitest';
import {
  synchronizeSceneColorTemperature,
  resolveRoomDefaultSceneId,
  withRoomPresets,
} from '../src/application/dashboard-scenes.js';

describe('room dashboard presets', () => {
  it('maps the legacy Everyday default to Vardagsljus with the ceiling off', () => {
    const scenes = withRoomPresets(
      [
        {
          id: 'scene.everyday',
          name: 'Everyday',
          lighting: { 'lighting.govee_ceiling': { power: true } },
        },
      ],
      ['lighting.govee_ceiling', 'lighting.desk'],
    );

    expect(resolveRoomDefaultSceneId('scene.everyday', scenes)).toBe(
      'scene.everyday_light',
    );
    expect(
      scenes.find((scene) => scene.id === 'scene.everyday_light')?.lighting[
        'lighting.govee_ceiling'
      ]?.power,
    ).toBe(false);
  });
});

it('keeps explicit Party RGB separate from white intent while completing off-lamp Kelvin', () => {
  const result = synchronizeSceneColorTemperature(
    {
      id: 'scene.party',
      name: 'Party',
      lighting: {
        'lighting.color': { power: true, brightness: 55, rgb: [180, 35, 255] },
        'lighting.white': {
          power: true,
          brightness: 20,
          colorTemperature: 2700,
        },
        'lighting.off': { power: false, brightness: 0 },
      },
    },
    4000,
  );
  expect(result.lighting['lighting.color']).toEqual({
    power: true,
    brightness: 55,
    rgb: [180, 35, 255],
  });
  expect(result.lighting['lighting.off']).toEqual({
    power: false,
    brightness: 0,
    colorTemperature: 2700,
  });
});
it('does not turn an RGB-only preset into white on save/load normalization', () => {
  const scene = {
    id: 'scene.party',
    name: 'Party',
    lighting: {
      'lighting.color': {
        power: true,
        rgb: [1, 2, 3] as [number, number, number],
      },
    },
  };
  expect(synchronizeSceneColorTemperature(scene, 2700)).toEqual(scene);
});
