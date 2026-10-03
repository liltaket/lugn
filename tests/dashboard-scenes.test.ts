import { describe, expect, it } from 'vitest';
import {
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
