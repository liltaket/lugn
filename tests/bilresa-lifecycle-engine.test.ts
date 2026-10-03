import { describe, expect, it } from 'vitest';
import { HomeAssistantBilresaAdapter } from '../src/adapters/home-assistant-bilresa.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const entityId = 'event.bilresa_dual_button_knapp_1';
const eventAt = '2026-10-03T18:00:00.000+00:00';
const beforeEventAt = '2026-10-03T17:50:00.000+00:00';
const recoveryAt = '2026-10-03T18:01:00.000+00:00';
const state = (timestamp: string, friendlyName = 'BILRESA') => ({
  entity_id: entityId,
  state: timestamp,
  attributes: { event_type: 'multi_press_1', friendly_name: friendlyName },
  last_changed: timestamp === 'unavailable' ? eventAt : timestamp,
  last_updated: timestamp === 'unavailable' ? eventAt : timestamp,
});

const frame = (oldState: unknown, newState: unknown, firedAt = eventAt) => ({
  type: 'event',
  id: 1,
  event: {
    event_type: 'state_changed',
    time_fired: firedAt,
    data: { entity_id: entityId, old_state: oldState, new_state: newState },
  },
});

async function setup() {
  const clock = new FakeClock(Date.parse(eventAt));
  const lighting = new SimulatedLightingAdapter(clock);
  const engine = new LugnEngine(clock, {
    adapter: lighting,
    deviceIds: ['lighting.ceiling'],
    scenes: [
      {
        id: 'scene.everyday_light',
        name: 'Everyday',
        lighting: { 'lighting.ceiling': { power: true, brightness: 42 } },
      },
      {
        id: 'scene.all_off',
        name: 'Off',
        lighting: { 'lighting.ceiling': { power: false } },
      },
    ],
  });
  const actions: Promise<void>[] = [];
  const remote = new HomeAssistantBilresaAdapter(
    {},
    clock,
    ({ button, gesture }) => {
      actions.push(engine.handleBilresaPress(button, gesture));
    },
  );
  await engine.activateScene('scene.everyday_light', {
    type: 'user',
    id: 'test',
  });
  return {
    clock,
    engine,
    lighting,
    remote,
    flush: () => Promise.all(actions.splice(0)),
  };
}

describe('HA event entity lifecycle must not invent BILRESA button presses', () => {
  it('a new physical event timestamp toggles the lights exactly once', async () => {
    const { engine, remote, lighting, flush } = await setup();
    try {
      const callsBefore = lighting.dispatched.length;
      expect(
        remote.acceptStateChangedFrame(
          frame(state(beforeEventAt), state(eventAt)),
        ),
      ).toBe(true);
      await flush();
      expect(engine.state.lighting.currentScene).toBe('scene.all_off');
      expect(lighting.dispatched.length).toBe(callsBefore + 1);
    } finally {
      engine.dispose();
    }
  });

  it.each([
    'availability recovery',
    'attribute update',
    'entity restored',
  ] as const)(
    'does not toggle a second time on %s with the previous event_type',
    async (transition) => {
      const { clock, engine, remote, lighting, flush } = await setup();
      try {
        expect(
          remote.acceptStateChangedFrame(
            frame(state(beforeEventAt), state(eventAt)),
          ),
        ).toBe(true);
        await flush();
        expect(engine.state.lighting.currentScene).toBe('scene.all_off');
        const callsBeforeLifecycleChange = lighting.dispatched.length;
        clock.advanceBy(60_000);

        // These frames carry no new physical event timestamp. HA omits dynamic
        // attributes while unavailable, then re-exposes the old event_type and
        // old event timestamp on recovery, without a new physical button press.
        if (transition === 'availability recovery') {
          const unavailable = {
            ...state('unavailable'),
            attributes: { friendly_name: 'BILRESA' },
            last_changed: recoveryAt,
            last_updated: recoveryAt,
          };
          expect(
            remote.acceptStateChangedFrame(
              frame(state(eventAt), unavailable, recoveryAt),
            ),
          ).toBe(false);
          await flush();
          expect(engine.state.lighting.currentScene).toBe('scene.all_off');
          remote.acceptStateChangedFrame(
            frame(
              unavailable,
              {
                ...state(eventAt),
                last_changed: recoveryAt,
                last_updated: recoveryAt,
              },
              recoveryAt,
            ),
          );
        } else if (transition === 'attribute update') {
          remote.acceptStateChangedFrame(
            frame(
              state(eventAt),
              { ...state(eventAt, 'Desk remote'), last_updated: recoveryAt },
              recoveryAt,
            ),
          );
        } else {
          remote.acceptStateChangedFrame(
            frame(
              null,
              {
                ...state(eventAt),
                last_changed: recoveryAt,
                last_updated: recoveryAt,
              },
              recoveryAt,
            ),
          );
        }
        await flush();

        expect.soft(engine.state.lighting.currentScene).toBe('scene.all_off');
        expect
          .soft(lighting.dispatched)
          .toHaveLength(callsBeforeLifecycleChange);
        expect
          .soft(lighting.observed.get('lighting.ceiling')?.power)
          .toBe(false);
      } finally {
        engine.dispose();
      }
    },
  );
});
