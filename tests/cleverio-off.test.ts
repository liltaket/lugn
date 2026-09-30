import { describe, expect, it } from 'vitest';
import { HomeAssistantLightingAdapter } from '../src/adapters/home-assistant-lighting.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { withRoomPresets } from '../src/application/dashboard-scenes.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock, systemClock } from '../src/core/clock.js';

describe('Cleverio off delivery', () => {
  it('dispatches the generated all-off scene even when HA already reports Cleverio off', async () => {
    const clock = new FakeClock(Date.parse('2026-09-28T12:00:00+02:00'));
    const adapter = new SimulatedLightingAdapter(clock);
    const target = 'lighting.cleverio_bar';
    const engine = new LugnEngine(clock, {
      adapter,
      deviceIds: [target],
      scenes: withRoomPresets([], [target]),
    });

    adapter.externalChange(target, { power: false });
    adapter.dispatched.length = 0;

    try {
      await engine.activateScene('scene.all_off', { type: 'user' });

      expect(adapter.dispatched).toContainEqual(
        expect.objectContaining({
          target,
          values: { power: false },
        }),
      );
    } finally {
      engine.dispose();
    }
  });

  it('sends three Home Assistant turn_off calls to the Cleverio LB100', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new HomeAssistantLightingAdapter(
      {
        baseUrl: 'http://home-assistant.test:8123/',
        token: 'fake-home-assistant-token',
        entities: { 'lighting.cleverio_bar': 'light.cleverio_lb100' },
      },
      async (input, init) => {
        requests.push({
          url: String(input),
          ...(init === undefined ? {} : { init }),
        });
        return new Response(null, { status: 200 });
      },
      systemClock,
    );

    await adapter.dispatch({
      id: 'off-cleverio',
      target: 'lighting.cleverio_bar',
      values: { power: false },
    });

    expect(requests).toHaveLength(3);
    expect(requests.map(({ url }) => url)).toEqual([
      'http://home-assistant.test:8123/api/services/light/turn_off',
      'http://home-assistant.test:8123/api/services/light/turn_off',
      'http://home-assistant.test:8123/api/services/light/turn_off',
    ]);
    expect(requests.map(({ init }) => JSON.parse(String(init?.body)))).toEqual([
      { entity_id: 'light.cleverio_lb100' },
      { entity_id: 'light.cleverio_lb100' },
      { entity_id: 'light.cleverio_lb100' },
    ]);
  });

  it('finishes after three bounded fire-and-forget attempts when Cleverio transport throws', async () => {
    let attempts = 0;
    const adapter = new HomeAssistantLightingAdapter(
      {
        baseUrl: 'http://home-assistant.test:8123/',
        token: 'fake-home-assistant-token',
        entities: { 'lighting.cleverio_bar': 'light.cleverio_lb100' },
      },
      async () => {
        attempts += 1;
        throw new Error('simulated transport failure');
      },
      systemClock,
    );

    await expect(
      adapter.dispatch({
        id: 'off-cleverio-transport-error',
        target: 'lighting.cleverio_bar',
        values: { power: false },
      }),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });
});
