import { describe, expect, it, vi } from 'vitest';
import { ComputerNowPlayingSelector } from '../src/application/computer-now-playing.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import {
  unknownComputerReadings,
  type ComputerObservation,
} from '../src/core/computer.js';
import { HomeAssistantArtworkService } from '../src/runtime/artwork-service.js';

const target = 'music.room';
const id = 'ab67616d0000b2737c6236a76fbcee4f1b8ace08';
const prefix = '/ui/api/artwork/';
const jpeg = Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]);
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
function setup(
  enabled = true,
  transport: typeof fetch = async () =>
    new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }),
) {
  const clock = new FakeClock(100_000);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { [target]: [] } },
  });
  const state = engine.state;
  const route = { deviceId: 'desktop', source: 'Optical In' };
  const selector = new ComputerNowPlayingSelector({ [target]: route });
  const receiver = state.music.devices[target]!;
  receiver.availability = 'available';
  receiver.observed = {
    playback: 'playing',
    source: route.source,
    title: '4',
    volume: 0.3,
  };
  const computer: ComputerObservation = {
    deviceId: 'desktop',
    availability: 'online',
    freshness: 'fresh',
    reason: 'live',
    observedAt: clock.now(),
    receivedAt: clock.now(),
    sessionId: 'session-1',
    sequence: 1,
    observed: {
      ...unknownComputerReadings(),
      media: [
        {
          player: 'spotify',
          identity: 'Spotify',
          desktopEntry: 'spotify',
          playback: 'playing',
          title: 'Song',
          artists: ['Artist'],
          album: 'Album',
          contentType: null,
          artwork: { provider: 'spotify', id },
        },
      ],
    },
    activity: { classification: 'music', source: 'desktop-agent', basis: null },
    lastEvent: null,
  };
  state.computer.devices['desktop'] = computer;
  let trusted = true;
  const fetch = vi.fn(transport);
  const service = new HomeAssistantArtworkService(
    {
      baseUrl: 'http://ha.test',
      token: 'private-ha-token',
      entities: { [target]: 'media_player.room' },
      metadataProvider: () => null,
      observationTrusted: () => trusted,
      excludedSources: { [target]: [route.source] },
      computer: { routes: enabled ? { [target]: route } : {}, selector },
    },
    fetch,
    clock,
  );
  const snapshot = () => service.snapshot(state, prefix)[target]!;
  const token = () => snapshot().url!.split('/').at(-1)!;
  return {
    service,
    fetch,
    clock,
    state,
    computer,
    receiver,
    selector,
    snapshot,
    token,
    distrust: () => {
      trusted = false;
    },
    dispose: () => {
      service.dispose();
      engine.dispose();
    },
  };
}

describe('selected computer artwork on confirmed Optical route', () => {
  it('fetches only the exact Spotify image without HA credentials and reuses it through heartbeats', async () => {
    const s = setup();
    expect(s.snapshot().url).toBeNull();
    expect(s.fetch).not.toHaveBeenCalled();
    await settle();
    expect(s.snapshot()).toMatchObject({
      status: 'available',
      source: 'computer',
    });
    expect(s.fetch).toHaveBeenCalledExactlyOnceWith(
      `https://i.scdn.co/image/${id}`,
      expect.objectContaining({
        redirect: 'manual',
        headers: { Accept: expect.any(String) },
      }),
    );
    expect(await s.service.read(s.token(), s.state)).toEqual({
      body: new Uint8Array(jpeg),
      contentType: 'image/jpeg',
    });
    const oldToken = s.token();
    s.computer.sequence!++;
    s.computer.observedAt! += 30_000;
    expect(s.token()).toBe(oldToken);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    s.computer.observed.media![0]!.title = 'Another song';
    expect(await s.service.read(oldToken, s.state)).toBeNull();
    s.dispose();
  });

  it('serves Firefox local thumbnails for the same selected player as its title, without fetching any URL', async () => {
    const s = setup();
    s.computer.observed.activeApplication = {
      id: 'firefox',
      resourceClass: 'firefox',
    };
    s.computer.observed.media!.push({
      ...s.computer.observed.media![0]!,
      player: 'firefox',
      identity: 'Firefox',
      desktopEntry: 'firefox',
      title: 'Video',
      artwork: { provider: 'inline', data: jpeg.toString('base64') },
    });
    expect(s.selector.snapshot(s.state)[target]!.title).toBe('Video');
    s.snapshot();
    await settle();
    expect(s.snapshot().status).toBe('available');
    expect(await s.service.read(s.token(), s.state)).toEqual({
      body: new Uint8Array(jpeg),
      contentType: 'image/jpeg',
    });
    expect(s.fetch).not.toHaveBeenCalled();
    s.dispose();
  });

  it.each([
    'disabled',
    'stale',
    'offline',
    'ambiguous',
    'wrong_source',
    'untrusted',
    'receiver_off',
  ] as const)('does not show or fetch artwork when %s', async (reason) => {
    const s = setup(reason !== 'disabled');
    if (reason === 'stale') s.computer.freshness = 'stale';
    if (reason === 'offline') s.computer.availability = 'offline';
    if (reason === 'ambiguous')
      s.computer.observed.media!.push({
        ...s.computer.observed.media![0]!,
        player: 'other',
      });
    if (reason === 'wrong_source') s.receiver.observed.source = 'Spotify';
    if (reason === 'untrusted') s.distrust();
    if (reason === 'receiver_off') s.receiver.observed.playback = 'off';
    expect(s.snapshot().url).toBeNull();
    await settle();
    expect(s.fetch).not.toHaveBeenCalled();
    s.dispose();
  });

  it('revokes current image tokens immediately on loss of freshness or source change', async () => {
    const s = setup();
    s.snapshot();
    await settle();
    const token = s.token();
    s.computer.freshness = 'stale';
    expect(await s.service.read(token, s.state)).toBeNull();
    s.computer.freshness = 'fresh';
    s.receiver.observed.source = 'Spotify';
    expect(await s.service.read(token, s.state)).toBeNull();
    s.dispose();
  });

  it.each([
    { provider: 'spotify', id: 'https://127.0.0.1/private' },
    { provider: 'spotify', id: `${id}/../private` },
    { provider: 'inline', data: Buffer.from('<svg/>').toString('base64') },
    { provider: 'inline', data: jpeg.toString('base64') + '===' },
    { provider: 'inline', data: Buffer.alloc(24_577, 255).toString('base64') },
    { provider: 'url', url: 'file:///etc/passwd' },
  ])('rejects unsafe references %# without fetching', async (reference) => {
    const s = setup();
    Object.assign(s.computer.observed.media![0]!, { artwork: reference });
    expect(s.snapshot().url).toBeNull();
    await settle();
    expect(s.fetch).not.toHaveBeenCalled();
    s.dispose();
  });

  it('negative-caches rejected CDN redirects and times out slow responses without blocking snapshots', async () => {
    const s = setup(
      true,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/private' },
        }),
    );
    s.snapshot();
    await settle();
    s.snapshot();
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.snapshot().url).toBeNull();
    s.dispose();
    const slow = setup(true, () => new Promise(() => {}));
    slow.snapshot();
    await settle();
    slow.clock.advanceBy(3_000);
    await settle();
    slow.snapshot();
    await settle();
    expect(slow.fetch).toHaveBeenCalledTimes(1);
    expect(slow.snapshot().url).toBeNull();
    slow.dispose();
  });
});
