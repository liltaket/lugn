import { afterEach, describe, expect, it } from 'vitest';
import { HomeAssistantLightingAdapter } from '../src/adapters/home-assistant-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const targets = ['lighting.desk', 'lighting.strip'];
const scene = {
  id: 'scene.entry',
  name: 'Entry',
  lighting: Object.fromEntries(
    targets.map((target) => [
      target,
      { power: true, brightness: 60, colorTemperature: 2700 },
    ]),
  ),
};
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));

function setup() {
  const clock = new FakeClock(Date.parse('2026-09-28T12:00:00+02:00'));
  const requests: Array<{ entity_id: string; brightness_pct?: number }> = [];
  const adapter = new HomeAssistantLightingAdapter(
    {
      baseUrl: 'http://ha.test',
      token: 'test-token',
      entities: {
        'lighting.desk': 'light.desk',
        'lighting.strip': 'light.strip',
      },
    },
    async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    },
    clock,
  );
  const engine = new LugnEngine(clock, {
    adapter,
    deviceIds: targets,
    scenes: [scene],
    defaultSceneId: scene.id,
    retryDelayMs: 250,
    convergenceTimeoutMs: 2000,
  });
  engines.push(engine);
  function feedback(
    entity: string,
    state: string,
    brightness = 153,
    userId = 'api-token-owner',
  ) {
    adapter.acceptStateChangedEvent({
      entity_id: entity,
      new_state: {
        entity_id: entity,
        state,
        attributes: { brightness, color_temp_kelvin: 2700 },
        ...(userId ? { context: { user_id: userId } } : {}),
      },
    });
  }
  return { clock, engine, requests, feedback };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('room entry lighting reliability', () => {
  it('resends the remembered brightness and temperature when returning to an off room', async () => {
    const { engine, requests, feedback } = setup();
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    feedback('light.desk', 'on');
    feedback('light.strip', 'on');
    await flush();
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    feedback('light.desk', 'off');
    feedback('light.strip', 'off');
    await flush();
    const before = requests.length;
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(requests.slice(before)).toEqual(
      targets.map((target) => ({
        entity_id: target.replace('lighting.', 'light.'),
        brightness_pct: 60,
        color_temp_kelvin: 2700,
      })),
    );
  });

  it('retries partial HA feedback without saving an intermediate brightness as a manual override', async () => {
    const { clock, engine, requests, feedback } = setup();
    feedback('light.desk', 'on');
    feedback('light.strip', 'on');
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    feedback('light.desk', 'off');
    feedback('light.strip', 'off');
    await flush();
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    feedback('light.desk', 'on');
    feedback('light.strip', 'on', 3);
    await flush();
    expect(
      engine.state.lighting.devices['lighting.strip']?.effectiveDesired
        .brightness,
    ).toBe(60);
    expect(
      engine.state.lighting.devices['lighting.strip']?.ownership.brightness
        ?.kind,
    ).toBe('scene');
    const before = requests.length;
    clock.advanceBy(250);
    await flush();
    expect(requests.slice(before)).toEqual([
      { entity_id: 'light.strip', brightness_pct: 60 },
    ]);
    feedback('light.strip', 'on');
    await flush();
    expect(engine.state.commands.at(-1)?.status).toBe('confirmed');
    feedback('light.strip', 'on', 51);
    await flush();
    expect(
      engine.state.lighting.devices['lighting.strip']?.effectiveDesired
        .brightness,
    ).toBe(20);
    expect(
      engine.state.lighting.devices['lighting.strip']?.ownership.brightness
        ?.kind,
    ).toBe('override');
  });

  it('respects an explicit Lugn user adjustment even while entry is converging', async () => {
    const { engine, feedback } = setup();
    feedback('light.strip', 'on');
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    await engine.setLighting(
      'lighting.strip',
      { brightness: 20 },
      { actor: { type: 'user', id: 'dashboard-user' }, source: 'dashboard' },
    );
    feedback('light.strip', 'on', 51);
    await flush();
    expect(
      engine.state.lighting.devices['lighting.strip']?.effectiveDesired
        .brightness,
    ).toBe(20);
    expect(
      engine.state.lighting.devices['lighting.strip']?.ownership.brightness
        ?.kind,
    ).toBe('override');
  });

  it('keeps delayed exit feedback from switching off the remembered entry intent', async () => {
    const { engine, feedback } = setup();
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    feedback('light.strip', 'on');
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    feedback('light.strip', 'off');
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    feedback('light.strip', 'on', 3);
    feedback('light.strip', 'off');
    await flush();
    expect(
      engine.state.lighting.devices['lighting.strip']?.effectiveDesired,
    ).toEqual(scene.lighting['lighting.strip']);
    expect(
      engine.state.lighting.devices['lighting.strip']?.ownership.power?.kind,
    ).toBe('scene');
  });

  it('does not reset the retry budget on partial feedback from the last delivery attempt', async () => {
    const { clock, engine, requests, feedback } = setup();
    feedback('light.strip', 'on');
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    feedback('light.strip', 'off');
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    feedback('light.desk', 'on');
    for (let i = 0; i < 6; i++) {
      feedback('light.strip', 'on', 3);
      clock.advanceBy(250);
      await flush();
    }
    expect(
      requests.filter(
        (request) =>
          request.entity_id === 'light.strip' &&
          request.brightness_pct !== undefined,
      ),
    ).toHaveLength(3);
    expect(engine.state.lighting.devices['lighting.strip']?.availability).toBe(
      'degraded',
    );
    expect(
      engine.state.lighting.devices['lighting.strip']?.effectiveDesired
        .brightness,
    ).toBe(60);
    // A late successful final response still confirms the scene.
    feedback('light.strip', 'on');
    await flush();
    expect(engine.state.lighting.devices['lighting.strip']?.availability).toBe(
      'available',
    );
    expect(engine.state.commands.at(-1)?.status).toBe('confirmed');
  });

  it('keeps a real manual light-off override across a short absence', async () => {
    const { engine, feedback, requests } = setup();
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    feedback('light.desk', 'on');
    feedback('light.strip', 'on');
    await flush();
    feedback('light.strip', 'off');
    await flush();
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    feedback('light.desk', 'off');
    const before = requests.length;
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(requests.slice(before).map((request) => request.entity_id)).toEqual([
      'light.desk',
    ]);
    expect(
      engine.state.lighting.devices['lighting.strip']?.effectiveDesired.power,
    ).toBe(false);
  });

  it.each(['home', 'unknown'] as const)(
    'activates a blocked entry when home status changes from away through unknown to %s',
    async (state) => {
      const { engine, requests } = setup();
      await engine.handleHomePresence('away');
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
      });
      expect(requests).toHaveLength(0);
      await engine.handleHomePresence('unknown');
      await engine.handleHomePresence(state);
      expect(requests).toHaveLength(2);
      expect(
        engine.state.lighting.devices['lighting.strip']?.effectiveDesired.power,
      ).toBe(true);
    },
  );

  it('keeps entry blocked while away and activates at night when the away gate clears', async () => {
    const { clock, engine, requests, feedback } = setup();
    clock.advanceBy(13 * 60 * 60 * 1000);
    await engine.handleHomePresence('away');
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    await engine.handleHomePresence('unknown');
    await engine.handleHomePresence('home');
    expect(requests).toHaveLength(2);
    feedback('light.desk', 'on');
    feedback('light.strip', 'on');
    await flush();
    clock.advanceBy(6 * 60 * 60 * 1000);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(requests).toHaveLength(2);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    feedback('light.desk', 'off');
    feedback('light.strip', 'off');
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(
      requests.filter((request) => request.brightness_pct !== undefined),
    ).toHaveLength(4);
  });
});
