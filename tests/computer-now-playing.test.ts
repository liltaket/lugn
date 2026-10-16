import { describe, expect, it } from 'vitest';
import { ComputerNowPlayingSelector } from '../src/application/computer-now-playing.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import {
  unknownComputerReadings,
  type ComputerObservation,
} from '../src/core/computer.js';

type Media = NonNullable<ComputerObservation['observed']['media']>[number];
const NOW = 100_000;
function player(player: string, overrides: Partial<Media> = {}): Media {
  return {
    player,
    identity: player,
    desktopEntry: player,
    playback: 'playing',
    title: `${player} title`,
    artists: [`${player} artist`],
    album: 'Album',
    contentType: null,
    ...overrides,
  };
}
function setup() {
  const engine = new LugnEngine(new FakeClock(NOW), {
    scenes: [],
    deviceIds: [],
    music: { targets: { 'music.room': ['Optical In', 'Spotify'] } },
  });
  engine.state.music.devices['music.room']!.observed.source = 'Optical In';
  const selector = new ComputerNowPlayingSelector({
    'music.room': { deviceId: 'kuffe', source: 'Optical In' },
  });
  let sequence = 0;
  const observe = (
    media: Media[] | null,
    overrides: Partial<ComputerObservation> = {},
  ) => {
    const observation: ComputerObservation = {
      deviceId: 'kuffe',
      availability: 'online',
      freshness: 'fresh',
      reason: 'live',
      observedAt: NOW + sequence * 1000,
      receivedAt: NOW + sequence * 1000,
      sessionId: 'session-1',
      sequence: ++sequence,
      observed: {
        ...unknownComputerReadings(),
        networkOnline: true,
        locked: false,
        idle: false,
        media,
      },
      activity: {
        classification: 'desktop',
        basis: 'active_application',
        source: 'desktop-agent',
      },
      lastEvent: null,
      ...overrides,
    };
    engine.acceptComputerObservation(observation);
    selector.observe(engine.state.computer.devices);
    return selector.snapshot(engine.state)['music.room']!;
  };
  return { engine, selector, observe };
}

describe('computer media presentation for observed Optical input', () => {
  it('shows Playing Spotify instead of a paused browser title or numeric preset, without changing observed music', () => {
    const { engine, observe } = setup();
    engine.state.music.devices['music.room']!.observed.title = '4';
    const result = observe([
      player('firefox', { playback: 'paused' }),
      player('spotify', { title: 'Catch Me', artists: ['WizTheMc'] }),
    ]);
    expect(result).toMatchObject({
      status: 'playing',
      title: 'Catch Me',
      artist: 'WizTheMc',
      application: 'spotify',
    });
    expect(engine.state.music.devices['music.room']!.observed.title).toBe('4');
    engine.dispose();
  });

  it('uses the actual observed source, not pending Optical preset intent or title4', () => {
    const { engine, selector, observe } = setup();
    observe([player('spotify')]);
    engine.state.music.devices['music.room']!.requested.preset = 'optical';
    engine.state.music.devices['music.room']!.observed.source = 'Spotify';
    engine.state.music.devices['music.room']!.observed.title = '4';
    expect(selector.snapshot(engine.state)).toEqual({});
    engine.state.music.devices['music.room']!.observed.source = null;
    expect(selector.snapshot(engine.state)).toEqual({});
    engine.dispose();
  });

  it('prefers a unique focused application using explicit DesktopEntry aliases, regardless of media ordering or fullscreen', () => {
    const { engine, observe } = setup();
    const observed = {
      ...unknownComputerReadings(),
      activeApplication: {
        id: 'org.mozilla.firefox',
        resourceClass: 'firefox',
      },
      fullscreen: true,
      media: [
        player('spotify'),
        player('firefox', { desktopEntry: 'firefox_firefox', title: 'Video' }),
      ],
    };
    expect(observe(observed.media, { observed })).toMatchObject({
      title: 'Video',
      reason: 'focused_application',
    });
    const next = {
      ...observed,
      fullscreen: false,
      media: [...observed.media].reverse(),
    };
    expect(observe(next.media, { observed: next })).toMatchObject({
      title: 'Video',
      reason: 'focused_application',
    });
    engine.dispose();
  });

  it('corroborates only an unambiguous app name, never pairs independent audio roles to players', () => {
    const { engine, observe } = setup();
    const media = [
      player('spotify'),
      player('firefox', { desktopEntry: 'firefox_firefox' }),
    ];
    const observed = {
      ...unknownComputerReadings(),
      media,
      audio: {
        playing: true,
        applications: ['Spotify'],
        roles: ['Video', 'Music'],
      },
    };
    expect(observe(media, { observed })).toMatchObject({
      title: 'spotify title',
      reason: 'audio_application',
    });
    engine.dispose();
  });

  it('does not guess between two browser players or treat global audio.playing/fullscreen as a player identity', () => {
    const { engine, observe } = setup();
    const media = [
      player('browser1', { desktopEntry: 'firefox' }),
      player('browser2', { desktopEntry: 'firefox' }),
    ];
    const observed = {
      ...unknownComputerReadings(),
      media,
      fullscreen: true,
      audio: { playing: true, applications: ['Firefox'], roles: ['Video'] },
    };
    expect(observe(media, { observed })).toMatchObject({
      status: 'ambiguous',
      title: null,
    });
    engine.dispose();
  });

  it('allows Playing silent video and unavailable audio observation instead of gating on PipeWire', () => {
    const { engine, observe } = setup();
    const media = [player('firefox')];
    expect(
      observe(media, {
        observed: {
          ...unknownComputerReadings(),
          media,
          audio: { playing: false, applications: [], roles: [] },
        },
      }),
    ).toMatchObject({ status: 'playing' });
    expect(observe(media)).toMatchObject({ status: 'playing' });
    engine.dispose();
  });

  it('prefers a newly resumed player and does not turn heartbeats or array order into recency', () => {
    const { engine, observe } = setup();
    const spotify = player('spotify'),
      pausedVideo = player('firefox', { playback: 'paused' });
    expect(observe([spotify, pausedVideo]).title).toBe(spotify.title);
    const video = player('firefox');
    expect(observe([spotify, video])).toMatchObject({
      title: video.title,
      reason: 'recent_playback',
    });
    for (let i = 0; i < 3; i++)
      expect(observe([video, spotify]).title).toBe(video.title);
    engine.dispose();
  });

  it('tracks useful title/artist/album changes, and stable winner wins equal timestamps', () => {
    const { engine, observe } = setup();
    const a = player('spotify'),
      b = player('firefox');
    expect(observe([a, b]).status).toBe('ambiguous');
    expect(observe([{ ...a, title: 'New song' }, b])).toMatchObject({
      title: 'New song',
      reason: 'recent_track',
    });
    expect(
      observe([
        { ...a, title: 'Next song' },
        { ...b, title: 'New video' },
      ]),
    ).toMatchObject({ title: 'Next song', reason: 'stable_selection' });
    engine.dispose();
  });

  it('does not treat unknown playback recovering to Playing as a new start', () => {
    const { engine, observe } = setup();
    const spotify = player('spotify'),
      video = player('firefox');
    expect(observe([spotify, video]).status).toBe('ambiguous');
    expect(observe([spotify, { ...video, playback: 'unknown' }]).title).toBe(
      spotify.title,
    );
    expect(observe([spotify, video])).toMatchObject({
      title: spotify.title,
      reason: 'stable_selection',
    });
    engine.dispose();
  });

  it('preserves fingerprints through transient media:null without awarding recovery or identity enrichment recency', () => {
    const { engine, observe } = setup();
    const a = player('spotify'),
      b = player('firefox');
    expect(observe([a, b]).status).toBe('ambiguous');
    expect(observe(null).status).toBe('unavailable');
    expect(observe([a, b]).status).toBe('ambiguous');
    expect(observe([{ ...a, identity: 'Spotify Premium' }, b]).status).toBe(
      'ambiguous',
    );
    expect(observe(null).status).toBe('unavailable');
    expect(
      observe([{ ...a, identity: 'Spotify Premium', title: 'New song' }, b]),
    ).toMatchObject({ title: 'New song', reason: 'recent_track' });
    engine.dispose();
  });

  it('does not treat first discovery, null-to-useful title enrichment, or reappearance as a new playback start', () => {
    const { engine, observe } = setup();
    const a = player('spotify', { title: null }),
      b = player('firefox');
    observe([a, b]);
    // No earlier useful title exists to establish that this is a different track.
    expect(observe([{ ...a, title: 'Discovered title' }, b]).title).toBe(
      b.title,
    );
    observe([]);
    expect(observe([player('spotify'), b]).status).toBe('ambiguous');
    engine.dispose();
  });

  it.each(['offline', 'stale', 'session'] as const)(
    'rebases recency and clears old selection on %s',
    (mode) => {
      const { engine, observe } = setup();
      const a = player('spotify'),
        b = player('firefox');
      observe([a, b]);
      expect(observe([{ ...a, title: 'New song' }, b]).title).toBe('New song');
      if (mode === 'offline')
        observe(null, {
          availability: 'offline',
          freshness: 'unknown',
          reason: 'offline',
        });
      if (mode === 'stale')
        observe(null, {
          availability: 'unknown',
          freshness: 'stale',
          reason: 'stale',
        });
      expect(
        observe([a, b], mode === 'session' ? { sessionId: 'session-2' } : {})
          .status,
      ).toBe('ambiguous');
      engine.dispose();
    },
  );

  it('never shows paused, stopped, missing metadata or unknown media as now playing', () => {
    const { engine, observe } = setup();
    expect(observe([player('spotify', { playback: 'paused' })]).status).toBe(
      'idle',
    );
    expect(observe([]).status).toBe('idle');
    expect(observe([player('spotify', { title: ' ' })]).status).toBe(
      'unavailable',
    );
    expect(observe(null).status).toBe('unavailable');
    engine.dispose();
  });

  it('only uses the explicitly routed computer and bounds selection history to currently known players', () => {
    const { engine, selector, observe } = setup();
    observe([player('spotify')]);
    const other = structuredClone(engine.state.computer.devices['kuffe']!);
    other.deviceId = 'other';
    other.observed.media = [player('other')];
    engine.acceptComputerObservation(other);
    expect(selector.snapshot(engine.state)['music.room']?.title).toBe(
      'spotify title',
    );
    selector.reset();
    expect(selector.snapshot(engine.state)['music.room']?.title).toBe(
      'spotify title',
    );
    engine.dispose();
  });
});
