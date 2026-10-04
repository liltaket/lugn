import { expect, it } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { HomeAssistantLightingAdapter } from '../src/adapters/home-assistant-lighting.js';

const presence = (state: 'occupied' | 'confirmed_empty') => ({
  type: 'presence.changed' as const,
  presence: state,
});

function setup() {
  const clock = new FakeClock(Date.parse('2026-10-03T22:55:00+02:00'));
  const requests: Array<{ service: string; entity: string }> = [];
  const entities = {
    'lighting.desk': 'light.desk',
    'lighting.ceiling': 'light.ceiling',
  };
  const adapter = new HomeAssistantLightingAdapter(
    { baseUrl: 'http://home-assistant.test:8123', token: 'test', entities },
    async (input, init) => {
      requests.push({
        service: String(input).split('/').at(-1) ?? '',
        entity: (JSON.parse(String(init?.body)) as { entity_id: string })
          .entity_id,
      });
      return new Response(null, { status: 200 });
    },
    clock,
  );
  const engine = new LugnEngine(clock, {
    adapter,
    deviceIds: Object.keys(entities),
    scenes: [
      {
        id: 'scene.cozy',
        name: 'Cozy',
        lighting: {
          'lighting.desk': { power: true, brightness: 20 },
          'lighting.ceiling': { power: true, brightness: 20 },
        },
      },
    ],
    defaultSceneId: 'scene.cozy',
  });
  const report = (
    state: 'on' | 'off' | 'unavailable',
    entity = 'light.desk',
  ) => {
    clock.advanceBy(1);
    adapter.acceptStateChangedEvent({
      event_type: 'state_changed',
      data: {
        entity_id: entity,
        new_state: {
          entity_id: entity,
          state,
          attributes: state === 'on' ? { brightness: 51 } : {},
          last_updated: new Date(clock.now()).toISOString(),
        },
      },
    });
  };
  const enterNight = async () => {
    for (const entity of Object.values(entities)) report('off', entity);
    await engine.handlePresence(presence('occupied'));
    for (const entity of Object.values(entities)) report('on', entity);
    await settle();
    await engine.handlePresence(presence('confirmed_empty'));
    for (const entity of Object.values(entities)) report('off', entity);
    await settle();
    clock.advanceBy(6 * 60_000);
    await engine.handlePresence(presence('occupied'));
  };
  return { clock, engine, report, requests, enterNight };
}

it('reconciles night entry and device recovery without waiting for another entry', async () => {
  const { engine, report, requests, enterNight } = setup();
  try {
    await enterNight();
    expect(requests.slice(-2)).toEqual([
      { service: 'turn_on', entity: 'light.desk' },
      { service: 'turn_on', entity: 'light.ceiling' },
    ]);
    report('on');
    report('on', 'light.ceiling');
    await settle();
    const beforeRecovery = requests.length;
    report('unavailable');
    report('off');
    await settle();
    expect(requests.slice(beforeRecovery)).toEqual([
      { service: 'turn_on', entity: 'light.desk' },
    ]);
  } finally {
    engine.dispose();
  }
});

it('retries partial night-entry feedback while retaining scene ownership', async () => {
  const { clock, engine, report, requests, enterNight } = setup();
  try {
    await enterNight();
    report('on');
    await settle();
    const beforeRetry = requests.length;
    clock.advanceBy(2_000);
    await settle();
    expect(requests.slice(beforeRetry)).toEqual([
      { service: 'turn_on', entity: 'light.ceiling' },
    ]);
    expect(
      engine.state.lighting.devices['lighting.ceiling']?.ownership.power?.kind,
    ).toBe('scene');
    report('on', 'light.ceiling');
    await settle();
    const converged = requests.length;
    clock.advanceBy(10_000);
    await settle();
    expect(requests).toHaveLength(converged);
    await engine.handlePresence(presence('confirmed_empty'));
    expect(requests.slice(-2).every((r) => r.service === 'turn_off')).toBe(
      true,
    );
  } finally {
    engine.dispose();
  }
});

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}
