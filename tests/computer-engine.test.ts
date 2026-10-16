import { describe, expect, it } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { applyStateUpdate } from '../src/core/event-stream.js';
import type { ComputerObservation } from '../src/core/computer.js';
import {
  RoomStateSchema,
  StateUpdateSchema,
  type StateUpdate,
} from '../src/core/schemas.js';

const observation: ComputerObservation = {
  deviceId: 'workstation',
  availability: 'online',
  freshness: 'fresh',
  reason: 'live',
  observedAt: 1_000,
  receivedAt: 1_100,
  sessionId: 'desktop-session-1',
  sequence: 4,
  observed: {
    networkOnline: true,
    locked: false,
    idle: false,
    activeApplication: { id: 'game.exe', resourceClass: 'game' },
    fullscreen: true,
    audio: { playing: true, applications: ['game.exe'], roles: ['game'] },
    media: [],
  },
  activity: {
    classification: 'gaming',
    source: 'desktop-agent',
    basis: 'fullscreen-game',
  },
  lastEvent: {
    type: 'state_changed',
    sessionId: 'desktop-session-1',
    sequence: 4,
    occurredAt: 1_000,
    receivedAt: 1_100,
  },
};

describe('computer state integration', () => {
  it('publishes only computer observations and replays them as an isolated domain', () => {
    const engine = new LugnEngine(new FakeClock(1_100), { scenes: [] });
    const initialState = structuredClone(engine.state);
    const initialRevision = engine.state.revision;
    const received: StateUpdate[] = [];
    engine.stream.subscribe((update) => received.push(update));

    engine.acceptComputerObservation(observation);

    expect(engine.state.computer).toEqual({
      devices: { workstation: observation },
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.domains).toEqual(['computer']);
    expect(received[0]?.patch).toEqual({
      computer: { devices: { workstation: observation } },
    });
    for (const domain of ['presence', 'lighting', 'music', 'intent'] as const)
      expect(engine.state[domain]).toEqual(initialState[domain]);

    const delivery = engine.stream.resume(initialRevision, engine.state);
    expect(delivery.kind).toBe('updates');
    if (delivery.kind !== 'updates') throw new Error('Expected replay updates');
    const replayed = delivery.updates.reduce(applyStateUpdate, initialState);
    expect(replayed).toEqual(engine.state);
    expect(replayed.computer).toEqual(engine.state.computer);

    const unrelatedUpdate = StateUpdateSchema.parse({
      revision: engine.state.revision + 1,
      at: 1_200,
      domains: ['presence'],
      patch: { presence: structuredClone(engine.state.presence) },
    });
    expect(Object.hasOwn(unrelatedUpdate.patch, 'computer')).toBe(false);
    expect(applyStateUpdate(engine.state, unrelatedUpdate).computer).toEqual(
      engine.state.computer,
    );
    engine.dispose();
  });

  it('validates observations and stores a clone independent of the caller', () => {
    const engine = new LugnEngine(new FakeClock(1_100), { scenes: [] });
    const input = structuredClone(observation);
    engine.acceptComputerObservation(input);

    input.observed.activeApplication!.id = 'mutated.exe';
    input.observed.audio!.applications.push('mutated.exe');
    expect(engine.state.computer.devices['workstation']?.observed).toEqual(
      observation.observed,
    );

    const revision = engine.state.revision;
    const before = structuredClone(engine.state);
    const invalid = {
      ...observation,
      availability: 'connected',
    } as unknown as ComputerObservation;
    expect(() => engine.acceptComputerObservation(invalid)).toThrow();
    expect(engine.state.revision).toBe(revision);
    expect(engine.state).toEqual(before);
    engine.dispose();
  });

  it('defaults legacy room snapshots to an empty computer device map', () => {
    const engine = new LugnEngine(new FakeClock(1_100), { scenes: [] });
    const legacyState = { ...engine.state } as Record<string, unknown>;
    delete legacyState['computer'];

    expect(RoomStateSchema.parse(legacyState).computer).toEqual({
      devices: {},
    });
    engine.dispose();
  });
});
