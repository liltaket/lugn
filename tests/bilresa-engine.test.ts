import { describe, expect, it } from 'vitest';
import { HomeAssistantBilresaAdapter } from '../src/adapters/home-assistant-bilresa.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const scene = {
  id: 'scene.everyday_light',
  name: 'Everyday',
  lighting: { 'lighting.ceiling': { power: true, brightness: 42 } },
};
const allOff = {
  id: 'scene.all_off',
  name: 'Helt släckt',
  lighting: { 'lighting.ceiling': { power: false, brightness: 0 } },
};

function changed(entityId: string, eventType: string) {
  return {
    type: 'event',
    id: 7,
    event: {
      event_type: 'state_changed',
      data: {
        entity_id: entityId,
        new_state: {
          entity_id: entityId,
          attributes: { event_type: eventType },
        },
      },
    },
  };
}

describe('BILRESA remote to room actions', () => {
  it('routes button 1 short presses from either controller through the scene toggle', async () => {
    const clock = new FakeClock(Date.parse('2026-09-28T12:00:00+02:00'));
    const adapter = new SimulatedLightingAdapter(clock);
    const engine = new LugnEngine(clock, {
      adapter,
      deviceIds: ['lighting.ceiling'],
      scenes: [scene, allOff],
    });
    await engine.activateScene('scene.everyday_light', {
      type: 'user',
      id: 'test',
    });
    const actions: Array<Promise<void>> = [];
    const remote = new HomeAssistantBilresaAdapter(
      {},
      clock,
      ({ button, gesture }) => {
        actions.push(engine.handleBilresaPress(button, gesture));
      },
    );

    expect(
      remote.acceptStateChangedFrame(
        changed('event.bilresa_dual_button_knapp_1', 'multi_press_1'),
      ),
    ).toBe(true);
    await Promise.all(actions.splice(0));
    expect(engine.state.lighting.currentScene).toBe('scene.all_off');

    clock.advanceBy(101);
    expect(
      remote.acceptStateChangedFrame(
        changed('event.bilresa_dual_button_knapp_1_2', 'multi_press_1'),
      ),
    ).toBe(true);
    await Promise.all(actions.splice(0));
    expect(engine.state.lighting.currentScene).toBe('scene.everyday_light');
    engine.dispose();
  });
});
