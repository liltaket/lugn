import { describe, expect, it } from 'vitest';
import {
  applyStateUpdate,
  StateEventStream,
} from '../src/core/event-stream.js';
import type { RoomState, StateUpdate } from '../src/core/schemas.js';

describe('applyStateUpdate', () => {
  it('deep-clones changed domains, shares unchanged domains, and replays without modifying the original', () => {
    const original: RoomState = {
      revision: 0,
      updatedAt: 0,
      session: null,
      presence: {
        state: 'unknown',
        personCount: null,
        continuityExpiresAt: null,
        home: { state: 'unknown', observedAt: null },
      },
      lighting: { currentScene: null, sceneRevision: 0, devices: {} },
      switches: { devices: {}, commands: [] },
      music: { devices: {}, commands: [], fades: {} },
      intent: { holds: [] },
      commands: [],
      diagnostics: [],
      timings: [],
    };
    const before = structuredClone(original);
    const presence: RoomState['presence'] = {
      ...original.presence,
      state: 'occupied',
      personCount: 1,
      home: { state: 'home', observedAt: 10 },
    };
    const updates: StateUpdate[] = [
      { revision: 1, at: 10, domains: ['presence'], patch: { presence } },
      {
        revision: 2,
        at: 20,
        domains: ['session', 'intent', 'diagnostics'],
        patch: {
          session: {
            id: '00000000-0000-4000-8000-000000000001',
            state: 'active',
            startedAt: 20,
            lastActiveAt: 20,
            suspendedAt: null,
            expiresAt: null,
            endedAt: null,
          },
          intent: {
            holds: [
              {
                scope: 'music.playback',
                target: 'music.room',
                intent: 'paused',
                provenance: { actor: { type: 'user', id: 'test-user' } },
                createdAt: 20,
                resetPolicy: 'explicit_playback',
              },
            ],
          },
          diagnostics: [
            { id: 1, at: 20, kind: 'test', message: 'Updated', details: {} },
          ],
        },
      },
    ];

    const next = applyStateUpdate(original, updates[0]!);
    expect(next).not.toBe(original);
    expect(next.presence).toEqual(presence);
    expect(next.presence).not.toBe(original.presence);
    expect(next.presence).not.toBe(presence);
    expect(next.presence.home).not.toBe(presence.home);
    for (const domain of [
      'session',
      'lighting',
      'switches',
      'music',
      'intent',
      'commands',
      'diagnostics',
      'timings',
    ] as const) {
      expect(next[domain]).toBe(original[domain]);
    }
    expect(original).toEqual(before);

    const current = applyStateUpdate(next, updates[1]!);
    expect(current.session).toEqual(updates[1]!.patch.session);
    expect(current.session).not.toBe(updates[1]!.patch.session);
    expect(current.intent).toEqual(updates[1]!.patch.intent);
    expect(current.intent).not.toBe(updates[1]!.patch.intent);
    expect(current.intent.holds[0]!.provenance.actor).not.toBe(
      updates[1]!.patch.intent!.holds[0]!.provenance.actor,
    );
    const stream = new StateEventStream();
    for (const update of updates) stream.publish(update);
    const delivery = stream.resume(original.revision, current);
    expect(delivery.kind).toBe('updates');
    if (delivery.kind !== 'updates') throw new Error('Expected replay updates');
    const replay = delivery.updates.reduce(applyStateUpdate, original);
    expect(replay).toEqual(current);
    expect(replay).toEqual({
      ...before,
      revision: 2,
      updatedAt: 20,
      presence,
      session: updates[1]!.patch.session,
      intent: updates[1]!.patch.intent,
      diagnostics: updates[1]!.patch.diagnostics,
    });

    next.presence.home.state = 'away';
    expect(presence.home.state).toBe('home');
    expect(replay.presence.home.state).toBe('home');
    expect(original).toEqual(before);

    const ended = applyStateUpdate(replay, {
      revision: 3,
      at: 30,
      domains: ['session'],
      patch: { session: null },
    });
    expect(ended.session).toBeNull();
    expect(replay.session).toEqual(updates[1]!.patch.session);
  });

  it('correctly handles unrestricted complex values in diagnostics through structuredClone', () => {
    const original: RoomState = {
      revision: 0,
      updatedAt: 0,
      session: null,
      presence: {
        state: 'unknown',
        personCount: null,
        continuityExpiresAt: null,
        home: { state: 'unknown', observedAt: null },
      },
      lighting: { currentScene: null, sceneRevision: 0, devices: {} },
      switches: { devices: {}, commands: [] },
      music: { devices: {}, commands: [], fades: {} },
      intent: { holds: [] },
      commands: [],
      diagnostics: [],
      timings: [],
    };
    const protoTest = JSON.parse(
      '{"__proto__":{"flag":"inherited"},"ordinary":1}',
    );
    const next = applyStateUpdate(original, {
      revision: 1,
      at: 10,
      domains: ['diagnostics'],
      patch: {
        diagnostics: [
          {
            id: 1,
            at: 10,
            kind: 'test',
            message: 'Complex',
            details: {
              map: new Map([['a', 1]]),
              set: new Set([1, 2, 3]),
              bytes: new Uint8Array([1, 2, 3]),
              protoObj: protoTest,
            },
          },
        ],
      },
    });

    const details = next.diagnostics[0]!.details;
    expect(details['map']).toBeInstanceOf(Map);
    expect((details['map'] as Map<string, number>).get('a')).toBe(1);
    expect(details['set']).toBeInstanceOf(Set);
    expect((details['set'] as Set<number>).has(2)).toBe(true);
    expect(details['bytes']).toBeInstanceOf(Uint8Array);
    expect((details['bytes'] as Uint8Array)[1]).toBe(2);
    expect(details['protoObj']).toHaveProperty('ordinary', 1);

    // Check if the original object prototype wasn't modified globally
    // The cloned object should preserve the correct proto
    expect(details['protoObj']).toHaveProperty('__proto__', { flag: 'inherited' });
    expect(Object.getPrototypeOf(details['protoObj'])).toEqual(Object.prototype);
  });
});
