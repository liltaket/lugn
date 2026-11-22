import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import {
  DynamicLightingController,
  type PaletteSource,
} from '../src/application/dynamic-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import type { Rgb } from '../src/core/artwork-palette.js';
import { FakeClock } from '../src/core/clock.js';
import {
  unknownComputerReadings,
  type ComputerObservation,
} from '../src/core/computer.js';
import {
  DynamicLightingConfigSchema,
  type ComputerActivityClass,
} from '../src/core/dynamic-lighting.js';
import type { LightingScene } from '../src/core/schemas.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

const targets = [
  'lighting.ceiling',
  'lighting.desk',
  'lighting.strip',
  'lighting.monitor',
];
const scene = (id: string, dynamic?: 'music' | 'adaptive'): LightingScene => ({
  id,
  name: id,
  lighting: Object.fromEntries(
    targets.map((target) => [
      target,
      { power: true, brightness: 40, colorTemperature: 2700 },
    ]),
  ),
  ...(dynamic ? { dynamic } : {}),
});

class FakePalette implements PaletteSource {
  playing = false;
  palette: readonly Rgb[] = [];
  private readonly listeners = new Set<() => void>();
  current() {
    return { playing: this.playing, palette: this.palette };
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(playing: boolean, palette: readonly Rgb[] = []) {
    this.playing = playing;
    this.palette = palette;
    for (const listener of this.listeners) listener();
  }
}

async function fixture(over: { settleMs?: number } = {}) {
  const clock = new FakeClock(Date.parse('2026-11-22T19:00:00Z'));
  const adapter = new SimulatedLightingAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: targets,
    adapter,
    scenes: [
      scene('scene.plain'),
      scene('scene.music', 'music'),
      scene('scene.adaptive', 'adaptive'),
    ],
  });
  cleanups.push(() => engine.dispose());
  await engine.handleHomePresence('home');
  await engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
    personCount: 1,
  });
  const palette = new FakePalette();
  const decisions: string[] = [];
  const listed: { blockers: Array<{ app: string; reason: string }> | null } = {
    blockers: null,
  };
  const controller = new DynamicLightingController({
    clock,
    engine,
    palette,
    config: DynamicLightingConfigSchema.parse({
      targets: {
        'lighting.ceiling': 'main',
        'lighting.desk': 'desk',
        'lighting.strip': 'accent',
        'lighting.monitor': 'backlight',
      },
      settleMs: over.settleMs ?? 4000,
      minChangeIntervalMs: 1000,
    }),
    idleBlockers: () => ({ blockers: listed.blockers, ignored: [] }),
    onDecision: (message) => decisions.push(message),
  });
  cleanups.push(() => controller.dispose());
  let sequence = 0;
  const computer = (
    activity: ComputerActivityClass,
    readings: Partial<ReturnType<typeof unknownComputerReadings>> = {},
  ) => {
    const observation: ComputerObservation = {
      deviceId: 'desktop',
      availability: 'online',
      freshness: 'fresh',
      reason: 'live',
      observedAt: clock.now(),
      receivedAt: clock.now(),
      sessionId: 's',
      sequence: sequence++,
      lastEvent: null,
      observed: {
        ...unknownComputerReadings(),
        networkOnline: true,
        locked: false,
        idle: false,
        fullscreen: false,
        ...readings,
      },
      activity: {
        classification: activity,
        source: 'desktop-agent',
        basis: null,
      },
    };
    engine.acceptComputerObservation(observation);
  };
  const desired = (target: string) =>
    engine.state.lighting.devices[target]!.effectiveDesired;
  const advance = async (ms: number) => {
    clock.advanceBy(ms);
    await flush();
  };
  return {
    clock,
    engine,
    palette,
    controller,
    decisions,
    computer,
    desired,
    advance,
    adapter,
    listed,
  };
}

const user = { type: 'user' as const, id: 'bruno' };

describe('dynamic lighting controller', () => {
  it('leaves ordinary scenes completely alone', async () => {
    const f = await fixture();
    await f.engine.activateScene('scene.plain', user);
    f.computer('video', { fullscreen: true });
    f.palette.set(true, [[255, 0, 0]]);
    await f.advance(10_000);
    expect(f.desired('lighting.ceiling').power).toBe(true);
    expect(f.desired('lighting.strip').rgb).toBeUndefined();
    expect(f.decisions).toEqual([]);
  });

  describe('music scene', () => {
    it('puts artwork colours on the accent lamp only, and returns to the scene when the music stops', async () => {
      const f = await fixture();
      await f.engine.activateScene('scene.music', user);
      await f.advance(100);
      expect(f.desired('lighting.strip').rgb).toBeUndefined();

      f.palette.set(true, [[255, 40, 0]]);
      await f.advance(100);
      expect(f.desired('lighting.strip')).toMatchObject({
        power: true,
        rgb: [255, 40, 0],
      });
      expect(f.desired('lighting.ceiling').colorTemperature).toBe(2700);
      expect(f.desired('lighting.ceiling').rgb).toBeUndefined();

      // A new track recolours the lamp.
      await f.advance(2000);
      f.palette.set(true, [[0, 60, 255]]);
      await f.advance(100);
      expect(f.desired('lighting.strip').rgb).toEqual([0, 60, 255]);

      f.palette.set(false);
      await f.advance(8_100); // past the colour grace
      await f.advance(100);
      expect(f.desired('lighting.strip')).toMatchObject({
        colorTemperature: 2700,
      });
      expect(f.desired('lighting.strip').rgb).toBeUndefined();
      expect(f.engine.state.lighting.currentScene).toBe('scene.music');
    });

    it('keeps the colours through a short artwork gap and releases after the grace', async () => {
      const f = await fixture();
      await f.engine.activateScene('scene.music', user);
      f.palette.set(true, [[255, 40, 0]]);
      await f.advance(100);
      expect(f.desired('lighting.strip').rgb).toEqual([255, 40, 0]);
      f.palette.set(true, []);
      await f.advance(3000);
      expect(f.desired('lighting.strip').rgb).toEqual([255, 40, 0]);
      await f.advance(6000);
      expect(f.desired('lighting.strip').rgb).toBeUndefined();
    });

    it('does not repeat commands for an unchanged palette', async () => {
      const f = await fixture();
      await f.engine.activateScene('scene.music', user);
      f.palette.set(true, [[255, 40, 0]]);
      await f.advance(100);
      const before = f.adapter.dispatched.length;
      f.palette.set(true, [[254, 41, 0]]);
      await f.advance(5000);
      expect(f.adapter.dispatched.length).toBe(before);
    });

    it('respects a hand adjustment of the accent lamp', async () => {
      const f = await fixture();
      await f.engine.activateScene('scene.music', user);
      f.palette.set(true, [[255, 40, 0]]);
      await f.advance(100);
      await f.engine.setLighting(
        'lighting.strip',
        { power: true, brightness: 10, rgb: [0, 255, 0] },
        { actor: user },
      );
      await f.advance(2000);
      f.palette.set(true, [[0, 60, 255]]);
      await f.advance(2000);
      expect(f.desired('lighting.strip').rgb).toEqual([0, 255, 0]);
      expect(f.controller.snapshot().heldByUser).toContain('lighting.strip');
    });

    it('keeps a hand adjustment when the music stops and the scene is restored', async () => {
      const f = await fixture();
      await f.engine.activateScene('scene.music', user);
      f.palette.set(true, [[255, 40, 0]]);
      await f.advance(100);
      // A person adjusts a lamp the mode does not drive.
      await f.engine.setLighting(
        'lighting.desk',
        { power: true, brightness: 90 },
        { actor: user },
      );
      const before = f.adapter.dispatched.length;
      f.palette.set(false);
      await f.advance(8_100); // past the colour grace
      await f.advance(200);
      // The adjusted lamp is never touched, not even for a moment.
      expect(
        f.adapter.dispatched
          .slice(before)
          .some((command) => command.target === 'lighting.desk'),
      ).toBe(false);
      // The accent lamp is back on the scene; the adjusted lamp keeps its value.
      expect(f.desired('lighting.strip').rgb).toBeUndefined();
      expect(f.desired('lighting.desk').brightness).toBe(90);
      expect(
        f.engine.state.lighting.devices['lighting.desk']!.ownership.brightness,
      ).toMatchObject({ kind: 'override', actor: user });
    });

    it('leaves a lamp the person adjusted by hand when it was one the mode drove', async () => {
      const f = await fixture();
      await f.engine.activateScene('scene.music', user);
      f.palette.set(true, [[255, 40, 0]]);
      await f.advance(100);
      await f.engine.setLighting(
        'lighting.strip',
        { power: true, brightness: 10, rgb: [0, 255, 0] },
        { actor: user },
      );
      f.palette.set(false);
      await f.advance(8_100); // past the colour grace
      await f.advance(200);
      expect(f.desired('lighting.strip').rgb).toEqual([0, 255, 0]);
      expect(f.desired('lighting.strip').brightness).toBe(10);
    });

    it('returns lamps to the scene after a restart that lost the controller state', async () => {
      const f = await fixture();
      await f.engine.activateScene('scene.music', user);
      f.palette.set(true, [[255, 40, 0]]);
      await f.advance(100);
      f.controller.dispose();
      f.palette.set(false);
      await f.advance(8_100); // past the colour grace
      const restarted = new DynamicLightingController({
        clock: f.clock,
        engine: f.engine,
        palette: f.palette,
        config: DynamicLightingConfigSchema.parse({
          targets: {
            'lighting.ceiling': 'main',
            'lighting.desk': 'desk',
            'lighting.strip': 'accent',
            'lighting.monitor': 'backlight',
          },
          minChangeIntervalMs: 1000,
        }),
      });
      cleanups.push(() => restarted.dispose());
      await f.advance(200);
      expect(f.desired('lighting.strip').rgb).toBeUndefined();
    });

    it('retries the return to the scene when the engine refuses it first', async () => {
      const f = await fixture();
      await f.engine.activateScene('scene.music', user);
      f.palette.set(true, [[255, 40, 0]]);
      await f.advance(100);
      const reapply = vi
        .spyOn(f.engine, 'releaseAutomaticLighting')
        .mockRejectedValueOnce(new Error('Automatic lighting is held'));
      f.palette.set(false);
      await f.advance(8_100); // past the colour grace
      await f.advance(200);
      expect(reapply).toHaveBeenCalledTimes(1);
      expect(f.desired('lighting.strip').rgb).toEqual([255, 40, 0]);
      await f.advance(15_000);
      expect(reapply).toHaveBeenCalledTimes(2);
      expect(f.desired('lighting.strip').rgb).toBeUndefined();
    });

    it('still returns to the scene when the music stopped while the room was empty', async () => {
      const f = await fixture();
      await f.engine.activateScene('scene.music', user);
      f.palette.set(true, [[255, 40, 0]]);
      await f.advance(100);
      await f.engine.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
        personCount: 0,
      });
      await f.advance(2000);
      f.palette.set(false);
      await f.advance(8_100); // past the colour grace
      await f.engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 1,
      });
      await f.advance(2000);
      expect(f.desired('lighting.strip').rgb).toBeUndefined();
    });

    it('starts over when the scene is selected again', async () => {
      const f = await fixture();
      await f.engine.activateScene('scene.music', user);
      f.palette.set(true, [[255, 40, 0]]);
      await f.advance(100);
      await f.engine.activateScene('scene.music', user);
      await f.advance(100);
      expect(f.desired('lighting.strip').rgb).toEqual([255, 40, 0]);
    });

    it('stops following when another scene is chosen', async () => {
      const f = await fixture();
      await f.engine.activateScene('scene.music', user);
      f.palette.set(true, [[255, 40, 0]]);
      await f.advance(100);
      await f.engine.activateScene('scene.plain', user);
      await f.advance(100);
      f.palette.set(true, [[0, 60, 255]]);
      await f.advance(3000);
      expect(f.desired('lighting.strip').rgb).toBeUndefined();
      expect(f.controller.snapshot().mode).toBeNull();
    });
  });

  describe('adaptive scene', () => {
    it('dims for full-screen video only after the situation settles', async () => {
      const f = await fixture();
      f.computer('desktop');
      await f.engine.activateScene('scene.adaptive', user);
      await f.advance(100);
      expect(f.desired('lighting.desk')).toMatchObject({
        power: true,
        colorTemperature: 4000,
      });

      f.computer('video', { fullscreen: true });
      await f.advance(1000);
      expect(f.desired('lighting.desk').power).toBe(true); // not settled yet
      await f.advance(4000);
      expect(f.desired('lighting.desk').power).toBe(false);
      expect(f.desired('lighting.ceiling').power).toBe(false);
      expect(f.desired('lighting.strip').brightness).toBeLessThanOrEqual(6);
      expect(f.controller.snapshot()).toMatchObject({
        situation: 'cinema',
        reason: 'fullscreen_media',
      });

      f.computer('desktop');
      await f.advance(5000);
      expect(f.desired('lighting.desk').power).toBe(true);
    });

    it('treats a browser video blocker as cinema when the agent could not classify the activity', async () => {
      const f = await fixture();
      f.computer('desktop');
      await f.engine.activateScene('scene.adaptive', user);
      await f.advance(100);
      f.listed.blockers = [{ app: 'Zen', reason: 'Playing video' }];
      f.computer('desktop', { fullscreen: true });
      await f.advance(5000);
      expect(f.controller.snapshot()).toMatchObject({
        situation: 'cinema',
        reason: 'fullscreen_media',
      });
      expect(f.desired('lighting.desk').power).toBe(false);
    });

    it('does not mistake music in a full-screen window for a film', async () => {
      const f = await fixture();
      f.computer('music', {
        fullscreen: true,
        audio: { playing: true, applications: ['spotify'], roles: ['music'] },
        media: [
          {
            player: 'spotify',
            identity: null,
            desktopEntry: null,
            playback: 'playing',
            title: null,
            artists: null,
            album: null,
            contentType: 'audio/mpeg',
          },
        ],
      });
      await f.engine.activateScene('scene.adaptive', user);
      await f.advance(5000);
      expect(f.controller.snapshot().situation).not.toBe('cinema');
    });

    it('ignores an audio-only blocker', async () => {
      const f = await fixture();
      f.computer('desktop', { fullscreen: true });
      f.listed.blockers = [{ app: 'Firefox', reason: 'Playing audio' }];
      await f.engine.activateScene('scene.adaptive', user);
      await f.advance(5000);
      expect(f.controller.snapshot().situation).not.toBe('cinema');
    });

    it('settles on time even while an idle deadline is also pending', async () => {
      const f = await fixture();
      f.computer('idle', { idle: true });
      await f.engine.activateScene('scene.adaptive', user);
      await f.advance(100);
      expect(f.desired('lighting.desk').power).toBe(true);
      f.computer('video', { idle: true, fullscreen: true });
      await f.advance(5000);
      expect(f.desired('lighting.desk').power).toBe(false);
      expect(f.controller.snapshot().situation).toBe('cinema');
    });

    it('ignores a brief full-screen blip', async () => {
      const f = await fixture();
      f.computer('desktop');
      await f.engine.activateScene('scene.adaptive', user);
      await f.advance(100);
      f.computer('video', { fullscreen: true });
      await f.advance(2000);
      f.computer('desktop');
      await f.advance(10_000);
      expect(f.desired('lighting.desk').power).toBe(true);
    });

    it('moves to the lounge after the computer has been idle long enough', async () => {
      const f = await fixture();
      f.computer('desktop');
      await f.engine.activateScene('scene.adaptive', user);
      await f.advance(100);
      f.computer('idle', { idle: true });
      await f.advance(200_000);
      expect(f.desired('lighting.desk').power).toBe(true);
      await f.advance(120_000);
      expect(f.desired('lighting.desk').power).toBe(false);
      expect(f.controller.snapshot().situation).toBe('lounge');
    });

    it('falls back to the scene look while the computer is unavailable', async () => {
      const f = await fixture();
      f.computer('desktop');
      await f.engine.activateScene('scene.adaptive', user);
      await f.advance(100);
      expect(f.desired('lighting.desk').colorTemperature).toBe(4000);
      f.engine.acceptComputerObservation({
        deviceId: 'desktop',
        availability: 'offline',
        freshness: 'stale',
        reason: 'offline',
        observedAt: null,
        receivedAt: null,
        sessionId: null,
        sequence: null,
        lastEvent: null,
        observed: unknownComputerReadings(),
        activity: {
          classification: 'unknown',
          source: 'desktop-agent',
          basis: null,
        },
      });
      await f.advance(10_000);
      expect(f.desired('lighting.desk')).toMatchObject({
        power: true,
        brightness: 40,
        colorTemperature: 2700,
      });
    });

    it('does nothing while the room is empty', async () => {
      const f = await fixture();
      f.computer('desktop');
      await f.engine.activateScene('scene.adaptive', user);
      await f.advance(100);
      await f.engine.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
        personCount: 0,
      });
      const before = f.adapter.dispatched.length;
      f.computer('video', { fullscreen: true });
      await f.advance(20_000);
      expect(
        f.adapter.dispatched
          .slice(before)
          .some((command) => command.values.power === true),
      ).toBe(false);
    });

    it('sends the current look again when someone comes back', async () => {
      const f = await fixture();
      f.computer('desktop');
      await f.engine.activateScene('scene.music', user);
      f.palette.set(true, [[255, 40, 0]]);
      await f.advance(100);
      await f.engine.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
        personCount: 0,
      });
      await f.advance(2000);
      f.palette.set(true, [[0, 60, 255]]);
      await f.engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 1,
      });
      await f.advance(2000);
      expect(f.desired('lighting.strip').rgb).toEqual([0, 60, 255]);
    });
  });
});
