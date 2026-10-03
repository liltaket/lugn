import { describe, expect, it } from 'vitest';
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

it('keeps recovery, observations and retries suppressed after dawn until a fresh entry', async () => {
  const { clock, engine, report, requests, enterNight } = setup();
  try {
    await enterNight();
    const beforeRecovery = requests.length;
    report('unavailable');
    report('off');
    await settle();
    clock.advanceBy(10_000);
    await settle();
    clock.advanceBy(7 * 60 * 60_000 + 60_000);
    report('unavailable');
    report('off');
    await engine.handlePresence(presence('occupied'));
    await engine.reconcileScene();
    await settle();
    expect(requests.slice(beforeRecovery)).toEqual([]);

    await engine.handlePresence(presence('confirmed_empty'));
    await engine.handlePresence(presence('occupied'));
    await settle();
    expect(
      requests.slice(beforeRecovery).filter((r) => r.service === 'turn_on'),
    ).toHaveLength(2);
  } finally {
    engine.dispose();
  }
});

it('allows a manual light and its recovery/retries without activating other suppressed targets', async () => {
  const { clock, engine, report, requests, enterNight } = setup();
  try {
    await enterNight();
    const beforeManual = requests.length;
    await engine.setLighting(
      'lighting.desk',
      { power: true },
      { actor: { type: 'user' } },
    );
    clock.advanceBy(2_000);
    await settle();
    expect(
      requests.slice(beforeManual).filter((r) => r.service === 'turn_on'),
    ).toEqual([
      { service: 'turn_on', entity: 'light.desk' },
      { service: 'turn_on', entity: 'light.desk' },
    ]);
    report('on');
    report('unavailable');
    report('off');
    report('unavailable', 'light.ceiling');
    report('off', 'light.ceiling');
    await settle();
    expect(
      requests.slice(beforeManual).filter((r) => r.service === 'turn_on'),
    ).toHaveLength(3);
    expect(
      requests.slice(beforeManual).every((r) => r.entity === 'light.desk'),
    ).toBe(true);

    report('on');
    await engine.handlePresence(presence('confirmed_empty'));
    await settle();
    expect(requests.at(-1)).toEqual({
      service: 'turn_off',
      entity: 'light.desk',
    });
  } finally {
    engine.dispose();
  }
});

it('allows an explicit scene to clear visit suppression and converge normally', async () => {
  const { clock, engine, report, requests, enterNight } = setup();
  try {
    await enterNight();
    const beforeManual = requests.length;
    await engine.activateScene('scene.cozy', { type: 'user' });
    await engine.handlePresence(presence('occupied'));
    clock.advanceBy(2_000);
    await settle();
    expect(
      requests.slice(beforeManual).filter((r) => r.service === 'turn_on'),
    ).toHaveLength(4);
    report('on');
    report('on', 'light.ceiling');
    await settle();
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'available',
    );
    await engine.handlePresence(presence('occupied'));
    report('unavailable');
    report('off');
    await settle();
    expect(
      requests.slice(beforeManual).filter((r) => r.service === 'turn_on'),
    ).toHaveLength(5);
  } finally {
    engine.dispose();
  }
});

it('still starts bounded convergence when a light recovers during daytime', async () => {
  const { engine, report, requests } = setup();
  try {
    report('off');
    report('off', 'light.ceiling');
    await engine.handlePresence(presence('occupied'));
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

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe('Quiet-hours light recovery', () => {
  it('keeps a suppressed visit dark when HA reports lamp recovery', async () => {
    const clock = new FakeClock(Date.parse('2026-10-03T22:55:00+02:00'));
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const adapter = new HomeAssistantLightingAdapter(
      {
        baseUrl: 'http://home-assistant.test:8123',
        token: 'review-token',
        entities: { 'lighting.desk': 'light.review_desk' },
      },
      async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(null, { status: 200 });
      },
      clock,
    );
    const engine = new LugnEngine(clock, {
      adapter,
      deviceIds: ['lighting.desk'],
      scenes: [
        {
          id: 'scene.cozy',
          name: 'Cozy',
          lighting: {
            'lighting.desk': { power: true, brightness: 20 },
          },
        },
      ],
      defaultSceneId: 'scene.cozy',
    });
    const report = (state: 'on' | 'off' | 'unavailable') => {
      adapter.acceptStateChangedEvent({
        event_type: 'state_changed',
        data: {
          entity_id: 'light.review_desk',
          new_state: {
            entity_id: 'light.review_desk',
            state,
            attributes: state === 'on' ? { brightness: 51 } : {},
            last_updated: new Date(clock.now()).toISOString(),
          },
        },
      });
    };
    try {
      report('off');
      await engine.handlePresence(presence('occupied'));
      report('on');
      await settle();
      await engine.handlePresence(presence('confirmed_empty'));
      report('off');
      await settle();
      expect(requests.map((request) => request.url.split('/').at(-1))).toEqual([
        'turn_on',
        'turn_off',
      ]);

      clock.advanceBy(6 * 60_000);
      const beforeNightEntry = requests.length;
      await engine.handlePresence(presence('occupied'));
      expect(requests).toHaveLength(beforeNightEntry);
      expect(
        engine.state.diagnostics.some(
          (entry) => entry.kind === 'presence.lighting_suppressed_quiet_hours',
        ),
      ).toBe(true);

      // No user command or new occupancy transition occurs during recovery.
      report('unavailable');
      await settle();
      clock.advanceBy(1);
      report('off');
      await settle();

      expect(
        requests
          .slice(beforeNightEntry)
          .filter((request) => request.url.endsWith('/turn_on')),
      ).toEqual([]);
    } finally {
      engine.dispose();
    }
  });
});
