import { describe, expect, it } from 'vitest';
import { HomeAssistantLightingAdapter } from '../src/adapters/home-assistant-lighting.js';
import type { LightingCommand } from '../src/adapters/simulated-lighting.js';
import { FakeClock } from '../src/core/clock.js';

const token = 'fake-home-assistant-token';
const config = {
  baseUrl: 'http://home-assistant.test:8123/',
  token,
  entities: {
    'lighting.desk': 'light.study_desk',
  },
};

function setup(response = new Response(null, { status: 200 })) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const transport: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      ...(init === undefined ? {} : { init }),
    });
    return response;
  };
  const clock = new FakeClock(1_234);
  const adapter = new HomeAssistantLightingAdapter(config, transport, clock);
  return { adapter, clock, requests };
}

function command(values: LightingCommand['values']): LightingCommand {
  return { id: 'command-1', target: 'lighting.desk', values };
}

describe('Home Assistant lighting adapter', () => {
  it('maps semantic light commands to authenticated Home Assistant services', async () => {
    const { adapter, requests } = setup();

    await adapter.dispatch(
      command({ power: true, brightness: 37, colorTemperature: 2_700 }),
    );
    await adapter.dispatch(
      command({ power: false, brightness: 0, colorTemperature: 2_700 }),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      'http://home-assistant.test:8123/api/services/light/turn_on',
    );
    expect(requests[0]?.init?.method).toBe('POST');
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(requestBody(requests[0]?.init?.body))).toEqual({
      entity_id: 'light.study_desk',
      brightness_pct: 37,
      color_temp_kelvin: 2_700,
    });
    expect(requests[1]?.url).toBe(
      'http://home-assistant.test:8123/api/services/light/turn_off',
    );
    expect(JSON.parse(requestBody(requests[1]?.init?.body))).toEqual({
      entity_id: 'light.study_desk',
    });
  });

  it('publishes a normalized observation from a WebSocket state_changed event', () => {
    const { adapter, clock } = setup();
    const observations: unknown[] = [];
    adapter.subscribe((observation) => observations.push(observation));

    const accepted = adapter.acceptStateChangedEvent({
      type: 'event',
      event: {
        event_type: 'state_changed',
        data: {
          entity_id: 'light.study_desk',
          old_state: null,
          new_state: {
            entity_id: 'light.study_desk',
            state: 'on',
            attributes: {
              brightness: 128,
              color_temp_kelvin: 3_200,
            },
          },
        },
      },
    });

    expect(accepted).toBe(true);
    expect(observations).toEqual([
      {
        target: 'lighting.desk',
        values: { power: true, brightness: 50, colorTemperature: 3_200 },
        observedAt: clock.now(),
        provenance: {
          actor: { type: 'home_assistant' },
          source: 'home_assistant.state_changed',
        },
      },
    ]);
  });

  it.each(['unknown', 'unavailable'])(
    'ignores %s states instead of reporting them as off',
    (state) => {
      const { adapter } = setup();
      const observations: unknown[] = [];
      adapter.subscribe((observation) => observations.push(observation));

      const accepted = adapter.acceptStateChangedEvent({
        event_type: 'state_changed',
        data: {
          entity_id: 'light.study_desk',
          new_state: {
            entity_id: 'light.study_desk',
            state,
            attributes: {},
          },
        },
      });

      expect(accepted).toBe(false);
      expect(observations).toEqual([]);
    },
  );

  it('reports only safe HTTP details and sanitizes transport errors', async () => {
    const failedAdapter = new HomeAssistantLightingAdapter(
      config,
      async () => new Response(null, { status: 503 }),
      new FakeClock(),
    );
    await expect(
      failedAdapter.dispatch(command({ power: true })),
    ).rejects.toThrow(
      'Home Assistant light.turn_on failed for lighting.desk (light.study_desk): HTTP 503',
    );

    const throwingAdapter = new HomeAssistantLightingAdapter(
      config,
      async () => {
        throw new Error(`request failed with Bearer ${token}`);
      },
      new FakeClock(),
    );
    const transportError = await throwingAdapter
      .dispatch(command({ power: true }))
      .then(
        () => new Error('Expected transport failure'),
        (error: unknown) => error,
      );
    expect(transportError).toBeInstanceOf(Error);
    if (transportError instanceof Error) {
      expect(transportError.message).toContain('transport error');
      expect(transportError.message).not.toContain(token);
    }
  });

  it('validates mapping configuration and reports unmapped targets', async () => {
    expect(
      () =>
        new HomeAssistantLightingAdapter(
          { ...config, entities: { 'lighting.desk': 'switch.study_desk' } },
          async () => new Response(null, { status: 200 }),
          new FakeClock(),
        ),
    ).toThrow();

    const { adapter } = setup();
    await expect(
      adapter.dispatch({
        id: 'command-2',
        target: 'lighting.unknown',
        values: { power: true },
      }),
    ).rejects.toThrow('No Home Assistant light entity is configured');
  });
});

function requestBody(body: unknown): string {
  if (typeof body !== 'string') throw new Error('Expected a JSON string body');
  return body;
}
