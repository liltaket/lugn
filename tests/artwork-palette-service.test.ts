import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import type { ArtworkAsset, ArtworkProvider } from '../src/core/artwork.js';
import { FakeClock } from '../src/core/clock.js';
import { ArtworkPaletteService } from '../src/runtime/artwork-palette-service.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

function redPng(): ArtworkAsset {
  const image = new PNG({ width: 32, height: 32 });
  for (let i = 0; i < image.data.length; i += 4)
    image.data.set([220, 20, 20, 255], i);
  return { body: PNG.sync.write(image), contentType: 'image/png' };
}

async function fixture(asset: ArtworkAsset | null, hasArtwork = true) {
  const clock = new FakeClock(Date.parse('2026-11-22T19:00:00Z'));
  const music = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: ['lighting.a'],
    adapter: new SimulatedLightingAdapter(clock),
    scenes: [],
    music: {
      adapter: music,
      targets: { 'music.room': ['Spotify'] },
      observationTrusted: () => true,
    },
  });
  cleanups.push(() => engine.dispose());
  const observe = (playback: 'playing' | 'paused', title = 'Track') =>
    music.observe('music.room', {
      playback,
      volume: 0.3,
      source: 'Spotify',
      title,
    });
  observe('playing');
  await flush();
  const reads: string[] = [];
  const artwork: ArtworkProvider = {
    snapshot: () => ({
      'music.room': {
        url: hasArtwork ? '/palette/token-1' : null,
        status: hasArtwork ? 'available' : 'missing',
        source: 'home_assistant',
      },
    }),
    read: async (token) => {
      reads.push(token);
      return asset;
    },
  };
  const service = new ArtworkPaletteService({ artwork });
  cleanups.push(() => service.dispose());
  return { engine, service, observe, reads };
}

describe('artwork palette service', () => {
  it('reports playing at once and the colours when the artwork has loaded', async () => {
    const f = await fixture(redPng());
    let notified = 0;
    f.service.subscribe(() => notified++);
    expect(f.service.current(f.engine.state)).toEqual({
      playing: true,
      palette: [],
    });
    await flush();
    expect(notified).toBe(1);
    const { playing, palette } = f.service.current(f.engine.state);
    expect(playing).toBe(true);
    expect(palette).toHaveLength(1);
    expect(palette[0]![0]).toBeGreaterThan(200);
    expect(f.reads).toEqual(['token-1']);
    // Cached for the same track.
    f.service.current(f.engine.state);
    await flush();
    expect(f.reads).toHaveLength(1);
  });

  it('is not playing when the player is paused', async () => {
    const f = await fixture(redPng());
    f.observe('paused');
    await flush();
    expect(f.service.current(f.engine.state)).toEqual({
      playing: false,
      palette: [],
    });
    expect(f.reads).toEqual([]);
  });

  it('loads again for the next track', async () => {
    const f = await fixture(redPng());
    f.service.current(f.engine.state);
    await flush();
    f.observe('playing', 'Another track');
    await flush();
    f.service.current(f.engine.state);
    await flush();
    expect(f.reads).toHaveLength(2);
  });

  it('keeps "no colours" for undecodable artwork and does not retry endlessly', async () => {
    const f = await fixture({
      body: new Uint8Array([0, 1, 2]),
      contentType: 'image/png',
    });
    f.service.current(f.engine.state);
    await flush();
    expect(f.service.current(f.engine.state).palette).toEqual([]);
    f.service.current(f.engine.state);
    await flush();
    expect(f.reads).toHaveLength(1);
  });

  it('gives no colours when the track has no artwork or there is no artwork service', async () => {
    const none = await fixture(null, false);
    expect(none.service.current(none.engine.state)).toEqual({
      playing: true,
      palette: [],
    });
    expect(none.reads).toEqual([]);
    const bare = new ArtworkPaletteService({ artwork: undefined });
    expect(bare.current(none.engine.state).palette).toEqual([]);
  });
});
