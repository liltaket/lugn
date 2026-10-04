import { expect, it, vi } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { MusicController } from '../src/application/music-controller.js';
import { FakeClock } from '../src/core/clock.js';

const user = { actor: { type: 'user' as const }, source: 'dashboard' };
const playing = {
  playback: 'playing' as const,
  volume: 0.2,
  source: 'Spotify',
  title: 'Track',
};

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

it.each([0, 2_000])(
  'preserves the overall fade bound with feedbackDelayMs=%s',
  async (feedbackDelayMs) => {
    const clock = new FakeClock(0);
    const adapter = new SimulatedMusicAdapter(clock);
    const controller = new MusicController(
      clock,
      {
        targets: { 'music.room': [] },
        adapter,
        feedbackTimeoutMs: 10_000,
      },
      () => {},
    );
    const dispatchTimes: number[] = [];
    const originalDispatch = adapter.dispatch.bind(adapter);
    const feedbackTimers: ReturnType<FakeClock['setTimeout']>[] = [];
    vi.spyOn(adapter, 'dispatch').mockImplementation(async (command) => {
      dispatchTimes.push(clock.now());
      await originalDispatch(command);
      if (command.requested.property !== 'volume') return;
      const volume = command.requested.value;
      feedbackTimers.push(
        clock.setTimeout(() => {
          adapter.observe('music.room', { ...playing, volume });
        }, feedbackDelayMs),
      );
    });
    try {
      adapter.observe('music.room', playing);
      controller.startFade(
        {
          target: 'music.room',
          volume: 0.6,
          durationMs: 5_000,
        },
        user,
      );

      for (let elapsed = 0; elapsed < 40_000; elapsed += 250) {
        clock.advanceBy(250);
        await flush();
        if (feedbackDelayMs === 2_000 && elapsed + 250 === 35_000) {
          expect(controller.state.fades['music.room']?.status).toBe(
            'unconfirmed',
          );
          expect(controller.state.fades['music.room']?.diagnosticReason).toBe(
            'Fade exceeded its bounded completion window',
          );
        }
      }

      expect(dispatchTimes.length).toBeGreaterThan(1);
      expect(
        controller.state.commands.every(
          (command) =>
            command.status === 'confirmed' || command.status === 'pending',
        ),
      ).toBe(true);
      expect
        .soft(controller.state.fades['music.room']?.status)
        .toBe(feedbackDelayMs === 0 ? 'completed' : 'unconfirmed');
      expect.soft(dispatchTimes.filter((at) => at > 35_000)).toEqual([]);
    } finally {
      for (const timer of feedbackTimers) clock.clearTimeout(timer);
      controller.dispose();
    }
  },
);

it('retains the overall deadline through the final settling window', async () => {
  const clock = new FakeClock(0);
  const adapter = new SimulatedMusicAdapter(clock);
  const controller = new MusicController(
    clock,
    { targets: { 'music.room': [] }, adapter, feedbackTimeoutMs: 60_000 },
    () => {},
  );
  try {
    adapter.observe('music.room', playing);
    controller.startFade(
      { target: 'music.room', volume: 0.219, durationMs: 1_000 },
      user,
    );
    clock.advanceBy(1_000);
    await flush();
    clock.advanceBy(29_000);
    adapter.observe('music.room', { ...playing, volume: 0.219 });
    expect(controller.state.fades['music.room']?.status).toBe('settling');
    clock.advanceBy(1_000);
    expect(controller.state.fades['music.room']?.status).toBe('unconfirmed');
    clock.advanceBy(2_000);
    expect(controller.state.fades['music.room']?.status).toBe('unconfirmed');
    expect(clock.pendingTimers()).toBe(0);
  } finally {
    controller.dispose();
  }
});

it.each(['cancel', 'dispose'] as const)(
  'clears step and deadline timers on %s',
  async (operation) => {
    const clock = new FakeClock(0);
    const adapter = new SimulatedMusicAdapter(clock);
    const controller = new MusicController(
      clock,
      { targets: { 'music.room': [] }, adapter },
      () => {},
    );
    try {
      adapter.observe('music.room', playing);
      controller.startFade(
        { target: 'music.room', volume: 0.6, durationMs: 5_000 },
        user,
      );
      expect(clock.pendingTimers()).toBe(2);
      if (operation === 'cancel') controller.cancelFade('music.room');
      else controller.dispose();
      expect(clock.pendingTimers()).toBe(0);
      clock.advanceBy(40_000);
      await flush();
      expect(adapter.dispatched).toEqual([]);
    } finally {
      controller.dispose();
    }
  },
);
