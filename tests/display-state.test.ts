import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/core/clock.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import {
  DISPLAY_DECISIONS_PER_TARGET,
  displayPayloadKey,
  displayState,
} from '../src/runtime/display-state.js';

function engineState() {
  const engine = new LugnEngine(new FakeClock(1_000_000), {
    music: { targets: { 'music.room': [], 'music.other': [] } },
  });
  return { engine, state: structuredClone(engine.state) };
}

describe('displayState', () => {
  it('drops the logs a Hub never reads and keeps only pending commands', () => {
    const { state } = engineState();
    state.diagnostics = [{ at: 1 } as never];
    state.timings = [{ at: 1 } as never];
    state.commands = [
      { id: 'a', status: 'confirmed' } as never,
      { id: 'b', status: 'pending' } as never,
      { id: 'c', status: 'superseded' } as never,
    ];
    const shown = displayState(state);
    expect('diagnostics' in shown).toBe(false);
    expect('timings' in shown).toBe(false);
    expect(shown.commands.map((command) => command.id)).toEqual(['b']);
    // Everything else is the same state.
    expect(shown.lighting).toBe(state.lighting);
    expect(shown.presence).toBe(state.presence);
    expect(shown.revision).toBe(state.revision);
    // The source is untouched.
    expect(state.commands).toHaveLength(3);
  });

  it('keeps the latest decisions of each music target, in order', () => {
    const { state } = engineState();
    const decision = (target: string, at: number) =>
      ({
        target,
        at,
        reason: { kind: 'volume', value: 'automatic' },
      }) as never;
    state.music.decisions = [
      ...Array.from({ length: 12 }, (_, index) =>
        decision('music.room', index),
      ),
      decision('music.other', 100),
      ...Array.from({ length: 12 }, (_, index) =>
        decision('music.room', 200 + index),
      ),
    ];
    const kept = displayState(state).music.decisions!;
    const room = kept.filter((item) => item.target === 'music.room');
    expect(room).toHaveLength(DISPLAY_DECISIONS_PER_TARGET);
    expect(room.map((item) => item.at)).toEqual([
      204, 205, 206, 207, 208, 209, 210, 211,
    ]);
    expect(kept.filter((item) => item.target === 'music.other')).toHaveLength(
      1,
    );
    const times = kept.map((item) => item.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(state.music.decisions).toHaveLength(25);
  });

  it('leaves a state without decisions alone', () => {
    const { state } = engineState();
    delete state.music.decisions;
    expect(displayState(state).music).toBe(state.music);
  });
});

describe('displayPayloadKey', () => {
  it('ignores counters and evaluation clocks only', () => {
    const payload = (revision: number, evaluatedAt: number, title: string) =>
      JSON.stringify({
        deliveryRevision: revision,
        generatedAt: revision * 1000,
        state: { revision, updatedAt: revision * 7, sceneRevision: 3 },
        intelligence: { optical: [{ evaluatedAt }] },
        title,
      });
    expect(displayPayloadKey(payload(1, 10, 'a'))).toBe(
      displayPayloadKey(payload(2, 20, 'a')),
    );
    expect(displayPayloadKey(payload(1, 10, 'a'))).not.toBe(
      displayPayloadKey(payload(1, 10, 'b')),
    );
    // sceneRevision is real state, not a counter of the stream.
    expect(displayPayloadKey('{"sceneRevision":3}')).toBe(
      '{"sceneRevision":3}',
    );
  });
});
