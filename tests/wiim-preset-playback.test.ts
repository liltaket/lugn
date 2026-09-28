import { describe, expect, it, vi } from 'vitest';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import { FakeClock } from '../src/core/clock.js';

describe('WiiM preset playback', () => {
  it.each([
    ['spotify_dj', '1'],
    ['optical', '4'],
  ] as const)(
    'starts the configured %s preset with Home Assistant WiiM action',
    async (preset, presetId) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('[]', { status: 200 }));
      const adapter = new HomeAssistantMusicAdapter(
        {
          baseUrl: 'http://ha.local',
          token: 'test-token',
          entities: {
            'music.room': {
              entityId: 'media_player.wiim_room',
              sources: [],
            },
          },
        },
        transport,
        new FakeClock(),
      );

      await adapter.dispatch({
        id: `preset-${preset}`,
        target: 'music.room',
        requested: { property: 'preset', value: preset },
      });

      expect(transport).toHaveBeenCalledWith(
        'http://ha.local/api/services/wiim/play_preset',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            entity_id: 'media_player.wiim_room',
            preset: Number(presetId),
          }),
        }),
      );
    },
  );
});
