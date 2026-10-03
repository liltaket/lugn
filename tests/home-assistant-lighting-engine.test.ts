import { describe, expect, it } from 'vitest';
import { HomeAssistantLightingAdapter } from '../src/adapters/home-assistant-lighting.js';
import { FakeClock } from '../src/core/clock.js';
import { LugnEngine } from '../src/application/lugn-engine.js';

const user = { type: 'user' as const, id: 'test-user' };

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Home Assistant lighting feedback in the engine', () => {
  it('keeps the newer scene authoritative when delayed old HA feedback has no command ID', async () => {
    const clock = new FakeClock(1_000);
    const requests: Array<{ url: string; body: unknown }> = [];
    const adapter = new HomeAssistantLightingAdapter(
      {
        baseUrl: 'http://home-assistant.test:8123',
        token: 'test-token',
        entities: { 'lighting.desk': 'light.study_desk' },
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
          id: 'scene.a',
          name: 'A',
          lighting: { 'lighting.desk': { power: true, brightness: 20 } },
        },
        {
          id: 'scene.b',
          name: 'B',
          lighting: { 'lighting.desk': { power: true, brightness: 60 } },
        },
      ],
    });
    const observations: unknown[] = [];
    adapter.subscribe((observation) => observations.push(observation));

    await engine.activateScene('scene.a', user);
    await engine.activateScene('scene.b', user);
    adapter.acceptStateChangedEvent({
      event_type: 'state_changed',
      data: {
        entity_id: 'light.study_desk',
        new_state: {
          entity_id: 'light.study_desk',
          state: 'on',
          last_updated: '2026-09-30T12:00:01.000Z',
          attributes: { brightness: 153 },
        },
      },
    });
    await flushMicrotasks();

    // The actual HA adapter emits no commandId. A delayed A state must still
    // be treated as stale while the current scene asks for B.
    adapter.acceptStateChangedEvent({
      event_type: 'state_changed',
      data: {
        entity_id: 'light.study_desk',
        new_state: {
          entity_id: 'light.study_desk',
          state: 'on',
          last_updated: '2026-09-30T12:00:02.000Z',
          attributes: { brightness: 51 },
        },
      },
    });
    await flushMicrotasks();

    expect(
      observations.every(
        (observation) =>
          typeof observation === 'object' &&
          observation !== null &&
          !('commandId' in observation),
      ),
    ).toBe(true);
    expect(engine.state.lighting.currentScene).toBe('scene.b');
    expect(
      engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
    ).toEqual({ power: true, brightness: 60 });
    expect(
      engine.state.lighting.devices['lighting.desk']?.ownership.brightness
        ?.kind,
    ).toBe('scene');
    expect(requests).toHaveLength(3);
    expect(requests.at(-1)?.body).toEqual({
      entity_id: 'light.study_desk',
      brightness_pct: 60,
    });

    adapter.acceptStateChangedEvent({
      event_type: 'state_changed',
      data: {
        entity_id: 'light.study_desk',
        new_state: {
          entity_id: 'light.study_desk',
          state: 'on',
          last_updated: '2026-09-30T12:00:03.000Z',
          attributes: { brightness: 153 },
        },
      },
    });
    await flushMicrotasks();
    clock.advanceBy(10_001);
    adapter.acceptStateChangedEvent({
      event_type: 'state_changed',
      data: {
        entity_id: 'light.study_desk',
        new_state: {
          entity_id: 'light.study_desk',
          state: 'on',
          last_updated: '2026-09-30T12:00:04.000Z',
          attributes: { brightness: 51 },
        },
      },
    });
    await flushMicrotasks();

    expect(
      engine.state.lighting.devices['lighting.desk']?.effectiveDesired
        .brightness,
    ).toBe(20);
    expect(
      engine.state.lighting.devices['lighting.desk']?.ownership.brightness
        ?.kind,
    ).toBe('override');
    engine.dispose();
  });

  it('retries an unavailable light on its retry interval after HA transport recovers', async () => {
    const clock = new FakeClock(1_000);
    let requestCount = 0;
    const adapter = new HomeAssistantLightingAdapter(
      {
        baseUrl: 'http://home-assistant.test:8123',
        token: 'test-token',
        entities: { 'lighting.desk': 'light.study_desk' },
      },
      async () => {
        requestCount += 1;
        return new Response(null, {
          status: requestCount === 1 ? 400 : 200,
        });
      },
      clock,
    );
    const engine = new LugnEngine(clock, {
      adapter,
      deviceIds: ['lighting.desk'],
      retryDelayMs: 250,
      convergenceTimeoutMs: 2_000,
      scenes: [
        {
          id: 'scene.focus',
          name: 'Focus',
          lighting: { 'lighting.desk': { power: true, brightness: 65 } },
        },
      ],
    });

    await engine.activateScene('scene.focus', user);
    expect(requestCount).toBe(1);
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'unavailable',
    );

    clock.advanceBy(250);
    await flushMicrotasks();

    expect(requestCount).toBe(2);
    // An accepted command is not proof of device recovery; a later HA state
    // observation owns that transition.
    expect(engine.state.lighting.devices['lighting.desk']?.availability).toBe(
      'unavailable',
    );
    engine.dispose();
  });
});
