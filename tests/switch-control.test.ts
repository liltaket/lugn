import { describe, expect, it, vi } from 'vitest';
import { HomeAssistantSwitchAdapter } from '../src/adapters/home-assistant-switch.js';
import { SimulatedSwitchAdapter } from '../src/adapters/simulated-switch.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { applyStateUpdate } from '../src/core/event-stream.js';
import { RoomStateSchema } from '../src/core/schemas.js';

const provenance = {
  actor: { type: 'user' as const, id: 'operator' },
  source: 'dashboard',
  reason: 'Desk equipment',
  requestId: 'req-1',
};

function setup() {
  const clock = new FakeClock();
  const adapter = new SimulatedSwitchAdapter(clock);
  adapter.feedbackEnabled = false;
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    switchDeviceIds: ['switch.desk'],
    switchAdapter: adapter,
    switchFeedbackTimeoutMs: 100,
  });
  return { clock, adapter, engine, registry: new CapabilityRegistry(engine) };
}

describe('semantic switch control', () => {
  it('keeps adapter acceptance separate from feedback and preserves command provenance', async () => {
    const { registry, engine, adapter } = setup();
    const result = await registry.invoke(
      'switch.set',
      { target: 'switch.desk', state: true },
      provenance,
    );
    expect(result).toEqual({
      accepted: true,
      commandId: 'switch-command-1',
      status: 'pending',
    });
    expect(engine.state.switches.devices['switch.desk']).toMatchObject({
      observed: null,
      requested: true,
      requestedProvenance: provenance,
    });
    adapter.observe('switch.desk', true, {
      actor: { type: 'home_assistant' },
      source: 'ha',
    });
    expect(engine.state.switches.commands[0]).toMatchObject({
      status: 'confirmed',
      provenance,
      confirmedAt: 0,
    });
    expect(
      engine.state.switches.devices['switch.desk']?.observedProvenance,
    ).toEqual(provenance);
    expect(RoomStateSchema.safeParse(engine.state).success).toBe(true);
  });

  it('records external feedback independently and preserves the requested value', async () => {
    const { engine, registry, adapter } = setup();
    await registry.invoke(
      'switch.set',
      { target: 'switch.desk', state: true },
      provenance,
    );
    adapter.observe('switch.desk', true);
    const external = {
      actor: { type: 'physical_remote' as const },
      source: 'wall_button',
      reason: 'Manual off',
    };
    adapter.observe('switch.desk', false, external);
    expect(
      (
        await registry.invoke(
          'switch.getState',
          { target: 'switch.desk' },
          provenance,
        )
      ).device,
    ).toMatchObject({
      observed: false,
      requested: true,
      observedProvenance: external,
    });
    expect(engine.state.switches.commands[0]?.status).toBe('confirmed');
  });

  it('marks unavailable feedback and expires pending confirmation without retries', async () => {
    const { clock, engine, registry, adapter } = setup();
    await registry.invoke(
      'switch.set',
      { target: 'switch.desk', state: false },
      provenance,
    );
    adapter.observe('switch.desk', null);
    expect(engine.getSwitchState('switch.desk')).toMatchObject({
      observed: null,
      requested: false,
      availability: 'unavailable',
    });
    clock.advanceBy(100);
    expect(engine.state.switches.commands[0]?.status).toBe('unconfirmed');
    adapter.observe('switch.desk', false);
    expect(engine.state.switches.commands[0]?.status).toBe('unconfirmed');
    expect(adapter.dispatched).toHaveLength(1);
    engine.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('rejects unconfigured targets and extra arbitrary data before dispatch', async () => {
    const { registry, adapter } = setup();
    await expect(
      registry.invoke(
        'switch.set',
        { target: 'switch.other', state: true },
        provenance,
      ),
    ).rejects.toThrow('target_not_configured');
    await expect(
      registry.invoke(
        'switch.getState',
        { target: 'switch.other' },
        provenance,
      ),
    ).rejects.toThrow('target_not_configured');
    await expect(
      registry.invoke(
        'switch.set',
        { target: 'switch.desk', state: true, service: 'toggle' },
        provenance,
      ),
    ).rejects.toThrow();
    expect(adapter.dispatched).toHaveLength(0);
  });

  it('supersedes prior commands and rejects feedback carrying an older command ID', async () => {
    const { engine, adapter } = setup();
    const first = await engine.setSwitch('switch.desk', true, provenance);
    const second = await engine.setSwitch('switch.desk', false, provenance);
    adapter.observe('switch.desk', false, undefined, first.id);
    expect(
      engine.state.switches.commands.map((command) => command.status),
    ).toEqual(['superseded', 'pending']);
    adapter.observe('switch.desk', false, undefined, second.id);
    expect(engine.state.switches.commands[1]?.status).toBe('confirmed');
  });

  it('propagates switch updates through state replay', async () => {
    const { engine } = setup();
    let replay = structuredClone(engine.state);
    engine.stream.subscribe((update) => {
      replay = applyStateUpdate(replay, update);
    });
    await engine.setSwitch('switch.desk', true, provenance);
    expect(replay).toEqual(engine.state);
  });

  it('records failed dispatch without claiming acceptance or leaking adapter errors', async () => {
    const { engine, adapter } = setup();
    vi.spyOn(adapter, 'dispatch').mockRejectedValue(new Error('secret-token'));
    await expect(
      engine.setSwitch('switch.desk', true, provenance),
    ).rejects.toThrow('Switch command failed');
    expect(engine.state.switches.commands[0]?.status).toBe('failed');
    expect(JSON.stringify(engine.state)).not.toContain('secret-token');
  });
});

describe('Home Assistant switch adapter', () => {
  const config = {
    baseUrl: 'http://ha.local',
    token: 'private-token',
    entities: { 'switch.desk': 'switch.desk_power' },
  };

  it('dispatches only fixed switch services and only configured entity IDs', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const adapter = new HomeAssistantSwitchAdapter(
      config,
      transport,
      new FakeClock(),
    );
    await adapter.dispatch({ id: '1', target: 'switch.desk', state: true });
    await adapter.dispatch({ id: '2', target: 'switch.desk', state: false });
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      'http://ha.local/api/services/switch/turn_on',
      'http://ha.local/api/services/switch/turn_off',
    ]);
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toEqual({
      entity_id: 'switch.desk_power',
    });
    await expect(
      adapter.dispatch({ id: '3', target: 'switch.other', state: true }),
    ).rejects.toThrow('No Home Assistant switch');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('accepts only configured state feedback and marks unknown states unavailable', () => {
    const adapter = new HomeAssistantSwitchAdapter(
      config,
      fetch,
      new FakeClock(),
    );
    const listener = vi.fn();
    adapter.subscribe(listener);
    expect(
      adapter.acceptState({ entity_id: 'switch.desk_power', state: 'on' }),
    ).toBe(true);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: 'switch.desk',
        state: true,
        available: true,
      }),
    );
    expect(
      adapter.acceptStateChangedEvent({
        event_type: 'state_changed',
        data: {
          entity_id: 'switch.desk_power',
          new_state: { entity_id: 'switch.desk_power', state: 'unknown' },
        },
      }),
    ).toBe(true);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: null, available: false }),
    );
    expect(
      adapter.acceptStateChangedEvent({
        entity_id: 'switch.desk_power',
        new_state: null,
      }),
    ).toBe(true);
    expect(
      adapter.acceptState({ entity_id: 'switch.unconfigured', state: 'on' }),
    ).toBe(false);
    expect(
      adapter.acceptStateChangedEvent({
        event_type: 'other',
        data: {
          entity_id: 'switch.desk_power',
          new_state: { entity_id: 'switch.desk_power', state: 'on' },
        },
      }),
    ).toBe(false);
  });

  it('rejects duplicate mappings, non-switch entities and credential-bearing URLs', () => {
    expect(
      () =>
        new HomeAssistantSwitchAdapter(
          {
            ...config,
            entities: {
              'switch.one': 'switch.same',
              'switch.two': 'switch.same',
            },
          },
          fetch,
          new FakeClock(),
        ),
    ).toThrow();
    expect(
      () =>
        new HomeAssistantSwitchAdapter(
          { ...config, entities: { 'switch.one': 'light.lamp' } },
          fetch,
          new FakeClock(),
        ),
    ).toThrow();
    expect(
      () =>
        new HomeAssistantSwitchAdapter(
          { ...config, baseUrl: 'http://user:secret@ha.local' },
          fetch,
          new FakeClock(),
        ),
    ).toThrow();
  });
});
