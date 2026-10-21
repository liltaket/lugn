import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import {
  unknownComputerReadings,
  type ComputerObservation,
} from '../src/core/computer.js';
import {
  defaultIntelligenceSettings,
  type IntelligenceSettings,
  type IntelligenceSettingsRepository,
} from '../src/core/intelligence.js';
import { createComputerIntelligenceRuntime } from '../src/runtime/computer-intelligence-runtime.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

async function fixture() {
  const clock = new FakeClock(Date.parse('2026-10-20T12:00:00Z'));
  const lighting = new SimulatedLightingAdapter(clock);
  const music = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: ['lighting.desk'],
    adapter: lighting,
    scenes: [
      {
        id: 'scene.focus',
        name: 'Fokus',
        lighting: { 'lighting.desk': { power: true, brightness: 60 } },
      },
      {
        id: 'scene.soft',
        name: 'Mysljus',
        lighting: { 'lighting.desk': { power: true, brightness: 20 } },
      },
    ],
    music: {
      adapter: music,
      targets: { 'music.room': ['Spotify', 'Optical In'] },
      observationTrusted: () => true,
    },
  });
  cleanups.push(() => engine.dispose());
  await engine.handleHomePresence('home');
  await engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
    personCount: 1,
  });
  music.observe('music.room', {
    playback: 'idle',
    volume: 0.3,
    source: 'Spotify',
    title: null,
  });
  await flush();
  music.dispatched.length = 0;
  let document = {
    settings: defaultIntelligenceSettings(),
    generation: randomUUID(),
  };
  const store: IntelligenceSettingsRepository = {
    snapshot: () => structuredClone(document),
    save: async (settings: IntelligenceSettings, expected: string) => {
      expect(expected).toBe(document.generation);
      document = {
        settings: structuredClone(settings),
        generation: randomUUID(),
      };
      return structuredClone(document);
    },
  };
  let receiverTrusted = true;
  const capabilities = new CapabilityRegistry(engine);
  const runtime = createComputerIntelligenceRuntime({
    clock,
    engine,
    capabilities,
    settingsStore: store,
    computerDeviceIds: ['desktop'],
    computerAudio: {
      'music.room': { deviceId: 'desktop', source: 'Optical In' },
    },
    observationTrusted: () => receiverTrusted,
  });
  cleanups.push(runtime.dispose);
  let sequence = 0;
  function computer(
    classification: 'desktop' | 'music' | 'gaming',
    playing = false,
  ) {
    const observation: ComputerObservation = {
      deviceId: 'desktop',
      availability: 'online',
      freshness: 'fresh',
      reason: 'live',
      observedAt: clock.now(),
      receivedAt: clock.now(),
      sessionId: 'test-session',
      sequence: sequence++,
      lastEvent: null,
      observed: {
        ...unknownComputerReadings(),
        networkOnline: true,
        locked: false,
        idle: false,
        fullscreen: classification === 'gaming',
        activeApplication: { id: 'spotify', resourceClass: 'spotify' },
        audio: {
          playing,
          applications: playing ? ['spotify'] : [],
          roles: playing ? ['music'] : [],
        },
        media: [
          {
            player: 'org.mpris.MediaPlayer2.spotify',
            identity: 'Spotify',
            desktopEntry: 'spotify',
            playback: playing ? 'playing' : 'paused',
            title: 'Test track',
            artists: ['Test artist'],
            album: 'Test album',
            contentType: 'audio/mpeg',
          },
        ],
      },
      activity: { classification, source: 'desktop-agent', basis: 'test' },
    };
    engine.acceptComputerObservation(observation);
  }
  return {
    clock,
    music,
    engine,
    capabilities,
    store,
    service: runtime.service,
    computer,
    untrustReceiver: () => {
      receiverTrusted = false;
    },
  };
}

describe('computer context runtime integration', () => {
  it('keeps disabled defaults inert and makes Optical suggestion-only even after explicit auto opt-in', async () => {
    const f = await fixture();
    f.computer('desktop');
    f.clock.advanceBy(6000);
    f.computer('music', true);
    f.clock.advanceBy(12000);
    expect(f.service.snapshot().suggestions).toEqual([]);
    expect(f.music.dispatched).toEqual([]);
    const settings = f.store.snapshot().settings;
    settings.optical = {
      ...settings.optical,
      enabled: true,
      mode: 'auto',
      deviceId: 'desktop',
      target: 'music.room',
      source: 'Optical In',
      stabilityMs: 1000,
    };
    await f.service.updateSettings(settings, f.store.snapshot().generation);
    f.clock.advanceBy(1000);
    f.computer('desktop');
    f.clock.advanceBy(6000);
    f.computer('desktop');
    f.clock.advanceBy(1000);
    f.computer('music', true);
    f.clock.advanceBy(2000);
    expect(f.service.snapshot().optical[0]).toMatchObject({
      automaticAllowed: false,
    });
    expect(f.service.snapshot().suggestions).toContainEqual(
      expect.objectContaining({ kind: 'optical' }),
    );
    expect(f.music.dispatched).toEqual([]);
    f.untrustReceiver();
    f.service.observe();
    expect(f.service.snapshot().suggestions).toEqual([]);
  });

  it('consumes a scene prompt on manual scene choice and preserves that choice throughout the same context', async () => {
    const f = await fixture();
    const settings = f.store.snapshot().settings;
    settings.suggestions = {
      enabled: true,
      cooldownMs: 1000,
      sceneMappings: { gaming: 'scene.focus' },
    };
    await f.service.updateSettings(settings, f.store.snapshot().generation);
    f.computer('desktop');
    f.clock.advanceBy(1000);
    f.computer('gaming');
    f.clock.advanceBy(6000);
    expect(f.service.snapshot().suggestions).toContainEqual(
      expect.objectContaining({ kind: 'scene', sceneId: 'scene.focus' }),
    );
    await f.capabilities.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.soft' },
      { actor: { type: 'user', id: 'test' } },
    );
    await flush();
    expect(f.service.snapshot().suggestions).toEqual([]);
    f.clock.advanceBy(10000);
    f.computer('gaming');
    f.clock.advanceBy(10000);
    expect(f.service.snapshot().suggestions).toEqual([]);
    expect(f.engine.state.lighting.currentScene).toBe('scene.soft');
    expect(f.music.dispatched).toEqual([]);
  });
});
