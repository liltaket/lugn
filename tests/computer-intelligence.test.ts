import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ComputerIntelligence,
  type IntelligenceCapabilities,
  type IntelligenceTrust,
} from '../src/application/computer-intelligence.js';
import { FakeClock } from '../src/core/clock.js';
import {
  unknownComputerReadings,
  type ComputerObservation,
} from '../src/core/computer.js';
import {
  defaultIntelligenceSettings,
  IntelligenceError,
  IntelligenceSettingsSchema,
  type IntelligenceSettings,
  type IntelligenceSettingsDocument,
  type IntelligenceSettingsRepository,
} from '../src/core/intelligence.js';
import { LugnEngine } from '../src/application/lugn-engine.js';

const services: ComputerIntelligence[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});
const user = {
  actor: { type: 'user' as const, id: 'test-user' },
  source: 'test',
};
const target = 'music.room';
const route = { deviceId: 'desktop', source: 'Optical In' };
function setup(
  options: {
    defaults?: boolean;
    maxAge?: number;
    ttl?: number;
    stability?: number;
    settingsStore?: IntelligenceSettingsRepository;
  } = {},
) {
  const clock = new FakeClock(1_000_000);
  // Engine is a state fixture only. No adapters, runtime configuration or network connections.
  const engine = new LugnEngine(clock, {
    scenes: [],
    deviceIds: [],
    music: { targets: { [target]: ['Optical In', 'Spotify', 'Bluetooth'] } },
  });
  const state = engine.state;
  engine.dispose();
  state.presence.state = 'occupied';
  state.presence.home.state = 'home';
  const receiver = state.music.devices[target]!;
  receiver.observed = {
    playback: 'idle',
    source: 'Spotify',
    volume: 0.2,
    title: null,
  };
  receiver.availability = 'available';
  receiver.observedAt = clock.now();
  let document = {
    settings: defaultIntelligenceSettings(),
    generation: 'generation-1',
  };
  if (!options.defaults) {
    document.settings.optical = {
      ...document.settings.optical,
      enabled: true,
      mode: 'auto',
      ...route,
      target,
      stabilityMs: options.stability ?? 10_000,
      cooldownMs: 30_000,
    };
    document.settings.suggestions = {
      enabled: true,
      cooldownMs: 30_000,
      sceneMappings: {
        music: 'scene.music',
        video: 'scene.film',
        gaming: 'scene.focus',
      },
    };
  }
  const save = vi.fn(
    async (settings: IntelligenceSettings, generation: string) => {
      if (generation !== document.generation)
        throw new IntelligenceError(409, 'intelligence_settings_changed');
      document = {
        settings: structuredClone(settings),
        generation: `generation-${Number(document.generation.split('-')[1]) + 1}`,
      };
      return structuredClone(document);
    },
  );
  const invoke = vi.fn(async (name: string) =>
    name === 'lighting.activateScene'
      ? { sceneRevision: 1 }
      : { accepted: true, commandId: 'fake-command', status: 'pending' },
  );
  const trust: IntelligenceTrust = {
    computerTrusted: true,
    receiverTrusted: true,
    playbackAllowed: true,
    quietHours: false,
    manualPause: false,
    manualSourceHold: false,
  };
  let scenes = ['scene.music', 'scene.film', 'scene.focus'];
  const changed = vi.fn();
  const service = new ComputerIntelligence({
    clock,
    settingsStore: options.settingsStore ?? {
      snapshot: () => structuredClone(document),
      save,
    },
    computerDeviceIds: ['desktop'],
    computerAudio: { [target]: route },
    getState: () => state,
    getTrust: () => trust,
    availableSceneIds: () => scenes,
    capabilities: { invoke } as IntelligenceCapabilities,
    onChange: changed,
    ...(options.maxAge ? { maxObservationAgeMs: options.maxAge } : {}),
    ...(options.ttl ? { suggestionTtlMs: options.ttl } : {}),
  });
  services.push(service);
  let sequence = 0;
  function sample(playing: boolean, patch: Partial<ComputerObservation> = {}) {
    receiver.observedAt = clock.now();
    const computer: ComputerObservation = {
      deviceId: 'desktop',
      availability: 'online',
      freshness: 'fresh',
      reason: 'live',
      observedAt: clock.now(),
      receivedAt: clock.now(),
      sessionId: 'session-1',
      sequence: ++sequence,
      observed: {
        ...unknownComputerReadings(),
        locked: false,
        idle: false,
        activeApplication: { id: 'org.test.Player', resourceClass: null },
        audio: { playing, applications: ['org.test.Player'], roles: ['Music'] },
        media: [
          {
            player: 'org.mpris.MediaPlayer2.test',
            identity: 'Test Player',
            desktopEntry: 'org.test.Player',
            playback: playing ? 'playing' : 'paused',
            title: 'Test track',
            artists: ['Artist'],
            album: null,
            contentType: 'audio/mpeg',
          },
        ],
      },
      activity: {
        classification: playing ? 'music' : 'desktop',
        source: 'desktop-agent',
        basis: 'test',
      },
      lastEvent: null,
      ...patch,
    };
    state.computer.devices['desktop'] = computer;
    service.observe();
    return computer;
  }
  function start() {
    sample(false);
    clock.advanceBy(1000);
    sample(true);
  }
  type VideoSampleOptions = {
    application?: string;
    player?: string;
    spotifyMpris?: 'player' | 'identity' | 'desktopEntry';
    spotifyPipewire?: boolean;
    concurrentSpotify?: boolean;
    noMedia?: boolean;
    locked?: boolean | null;
    idle?: boolean | null;
    sessionId?: string;
    contentType?: string;
  };
  function videoSample(
    playing: boolean,
    options: VideoSampleOptions = {},
    patch: Partial<ComputerObservation> = {},
  ) {
    const application = options.application ?? 'org.test.Player';
    const media: NonNullable<ComputerObservation['observed']['media']> = [
      {
        player:
          options.spotifyMpris === 'player'
            ? 'org.mpris.MediaPlayer2.SpOtIfY'
            : (options.player ?? 'org.mpris.MediaPlayer2.test'),
        identity:
          options.spotifyMpris === 'identity' ? 'sPoTiFy' : 'Test Player',
        desktopEntry:
          options.spotifyMpris === 'desktopEntry'
            ? 'SpOtIfY.desktop'
            : application,
        playback: playing ? 'playing' : 'paused',
        title: 'Test video',
        artists: null,
        album: null,
        contentType: options.contentType ?? 'video/mp4',
      },
    ];
    if (options.concurrentSpotify)
      media.push({
        player: 'org.mpris.MediaPlayer2.SpOtIfY',
        identity: 'sPoTiFy',
        desktopEntry: 'spotify.desktop',
        playback: 'playing',
        title: 'Spotify track',
        artists: null,
        album: null,
        contentType: 'audio/mpeg',
      });
    const observed = {
      ...unknownComputerReadings(),
      locked: options.locked === undefined ? false : options.locked,
      idle: options.idle === undefined ? false : options.idle,
      activeApplication: { id: application, resourceClass: null },
      audio: {
        playing,
        applications: [
          application,
          ...(options.spotifyPipewire ? ['SpOtIfY'] : []),
        ],
        roles: ['Video'],
      },
      media: options.noMedia ? null : media,
      ...patch.observed,
    };
    return sample(playing, {
      ...patch,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      activity: {
        classification: 'video',
        source: 'desktop-agent',
        basis: 'test video playback',
        ...patch.activity,
      },
      observed,
    });
  }
  function startVideo(options: VideoSampleOptions = {}) {
    sample(false);
    clock.advanceBy(1000);
    videoSample(true, options);
  }
  function advanceVideo(
    durationMs: number,
    options: VideoSampleOptions = {},
    intervalMs = 30_000,
  ) {
    let elapsed = 0;
    while (elapsed < durationMs) {
      const step = Math.min(intervalMs, durationMs - elapsed);
      clock.advanceBy(step);
      videoSample(true, options);
      elapsed += step;
    }
  }
  function optical() {
    return service.snapshot().suggestions.find((s) => s.kind === 'optical');
  }
  return {
    clock,
    state,
    receiver,
    service,
    trust,
    invoke,
    sample,
    start,
    videoSample,
    startVideo,
    advanceVideo,
    optical,
    changed,
    save,
    setScenes: (ids: string[]) => {
      scenes = ids;
    },
  };
}

describe('computer intelligence safety and evidence', () => {
  it('defaults to disabled, with no timer, suggestion or command', () => {
    const s = setup({ defaults: true });
    s.start();
    s.clock.advanceBy(24 * 60 * 60_000);
    expect(s.service.snapshot().settings).toEqual(
      defaultIntelligenceSettings(),
    );
    expect(s.service.snapshot().optical[0]?.reason).toBe('disabled');
    expect(s.service.snapshot().suggestions).toEqual([]);
    expect(s.clock.pendingTimers()).toBe(0);
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('requires stable fresh transition and explains why even auto mode is suggestion-first', async () => {
    const s = setup();
    s.start();
    s.clock.advanceBy(9999);
    expect(s.optical()).toBeUndefined();
    expect(s.service.snapshot().optical[0]?.state).toBe('pending');
    s.clock.advanceBy(1);
    expect(s.optical()).toMatchObject({
      target,
      source: 'Optical In',
      deviceId: 'desktop',
    });
    expect(s.service.snapshot().optical[0]).toMatchObject({
      reason: 'suggestion_only_no_audibility',
      automaticAllowed: false,
      suggestionAllowed: true,
      evidence: expect.arrayContaining([
        'live_start_transition',
        'explicit_content_type',
      ]),
    });
    expect(s.invoke).not.toHaveBeenCalled();
    const id = s.optical()!.id;
    await s.service.respondSuggestion(id, 'accept', user);
    expect(s.invoke).toHaveBeenCalledExactlyOnceWith(
      'music.selectSource',
      { target, source: 'Optical In' },
      user,
    );
    expect(s.receiver.observed.source).toBe('Spotify'); // Acceptance is not feedback.
    await expect(
      s.service.respondSuggestion(id, 'accept', user),
    ).rejects.toMatchObject({ code: 'suggestion_unavailable' });
  });
  it.each(['playing', 'unknown', 'off'] as const)(
    'never interrupts %s receiver or claims permission',
    (playback) => {
      const s = setup();
      s.receiver.observed.playback = playback;
      s.start();
      s.clock.advanceBy(15_000);
      expect(s.optical()).toBeUndefined();
      expect(s.service.snapshot().optical[0]?.reason).toBe('receiver_busy');
      expect(s.invoke).not.toHaveBeenCalled();
    },
  );
  it('permits known paused receiver only without Pause hold', () => {
    const s = setup();
    s.receiver.observed.playback = 'paused';
    s.start();
    s.clock.advanceBy(10_000);
    expect(s.optical()).toBeDefined();
    s.trust.manualPause = true;
    s.service.observe();
    expect(s.optical()).toBeUndefined();
    s.trust.manualPause = false;
    s.service.observe();
    expect(s.optical()).toBeUndefined();
    expect(s.service.snapshot().optical[0]?.reason).toBe('context_suppressed');
  });
  it.each(['away', 'unknown'] as const)('blocks %s home status', (home) => {
    const s = setup();
    s.state.presence.home.state = home;
    s.start();
    s.clock.advanceBy(10_000);
    expect(s.optical()).toBeUndefined();
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it.each(['confirmed_empty', 'unknown'] as const)(
    'blocks %s room presence',
    (presence) => {
      const s = setup();
      s.state.presence.state = presence;
      s.start();
      s.clock.advanceBy(10_000);
      expect(s.service.snapshot().suggestions).toEqual([]);
    },
  );
  it.each([
    'quietHours',
    'manualPause',
    'manualSourceHold',
    'computerTrusted',
    'receiverTrusted',
    'playbackAllowed',
  ] as const)('revalidates %s before acceptance', (gate) => {
    return (async () => {
      const s = setup();
      s.start();
      s.clock.advanceBy(10_000);
      const id = s.optical()!.id;
      s.trust[gate] = [
        'quietHours',
        'manualPause',
        'manualSourceHold',
      ].includes(gate);
      await expect(
        s.service.respondSuggestion(id, 'accept', user),
      ).rejects.toMatchObject({ code: 'suggestion_unavailable' });
      expect(s.invoke).not.toHaveBeenCalled();
    })();
  });
  it('revalidates newly active Spotify, receiver age and pending intent on accept', async () => {
    for (const gate of ['spotify', 'age', 'pending'] as const) {
      const s = setup();
      s.start();
      s.clock.advanceBy(10_000);
      const id = s.optical()!.id;
      if (gate === 'spotify') s.receiver.observed.playback = 'playing';
      if (gate === 'age') s.receiver.observedAt = 0;
      if (gate === 'pending') s.receiver.requested.preset = 'spotify_dj';
      await expect(
        s.service.respondSuggestion(id, 'accept', user),
      ).rejects.toMatchObject({ code: 'suggestion_unavailable' });
      expect(s.invoke).not.toHaveBeenCalled();
    }
  });
  it('honors independent engine playback holds', () => {
    const s = setup();
    s.start();
    s.clock.advanceBy(10_000);
    s.state.intent.holds.push({
      scope: 'music.playback',
      target,
      intent: 'paused',
      provenance: user,
      createdAt: s.clock.now(),
      resetPolicy: 'explicit_playback',
    });
    s.service.observe();
    expect(s.optical()).toBeUndefined();
    expect(s.service.snapshot().optical[0]?.reason).toBe('manual_hold');
  });
  it('suppresses a manual source change for the whole context, without feedback loops or switch back', async () => {
    const s = setup();
    s.start();
    s.clock.advanceBy(10_000);
    s.receiver.observed.source = 'Bluetooth';
    s.service.observe();
    expect(s.optical()).toBeUndefined();
    s.receiver.observed.source = 'Spotify';
    s.service.observe();
    expect(s.optical()).toBeUndefined();
    s.clock.advanceBy(1000);
    s.sample(false);
    s.clock.advanceBy(6000);
    s.sample(true);
    s.clock.advanceBy(30_000);
    expect(s.optical()).toBeDefined();
    await s.service.respondSuggestion(s.optical()!.id, 'accept', user);
    s.receiver.observed.source = 'Optical In';
    s.service.observe();
    s.clock.advanceBy(1000);
    s.sample(false);
    s.clock.advanceBy(60_000);
    expect(s.invoke).toHaveBeenCalledTimes(1);
    expect(s.invoke.mock.calls[0]?.[0]).toBe('music.selectSource');
  });
  it.each([
    'retained',
    'stale',
    'offline',
    'broker_disconnected',
    'malformed',
  ] as const)(
    'rejects %s observations and recovery cannot replay a start',
    (reason) => {
      const s = setup();
      s.start();
      s.clock.advanceBy(1000);
      s.sample(true, { reason });
      s.clock.advanceBy(10_000);
      expect(s.optical()).toBeUndefined();
      s.sample(true);
      s.clock.advanceBy(10_000);
      expect(s.optical()).toBeUndefined();
      expect(s.invoke).not.toHaveBeenCalled();
    },
  );
  it('rejects out of order, duplicate payload changes and retired sessions', () => {
    const s = setup();
    s.start();
    const original = structuredClone(s.state.computer.devices['desktop']!);
    s.clock.advanceBy(1000);
    s.sample(true, { sequence: 1 });
    s.clock.advanceBy(10_000);
    expect(s.optical()).toBeUndefined();
    s.sample(true);
    s.clock.advanceBy(1000);
    s.sample(true, { sessionId: 'session-2' });
    s.clock.advanceBy(1000);
    s.sample(true, { sessionId: 'session-1' });
    expect(s.service.snapshot().optical[0]?.reason).toBe('out_of_order');
    s.state.computer.devices['desktop'] = original;
    s.service.observe();
    expect(s.optical()).toBeUndefined();
    const d = setup();
    d.start();
    d.clock.advanceBy(1000);
    d.state.computer.devices['desktop']!.observed.media![0]!.title =
      'Mutated duplicate';
    d.service.observe();
    expect(d.service.snapshot().optical[0]?.reason).toBe('out_of_order');
  });
  it('does not renew freshness from repeated reads or duplicate delivery', () => {
    const s = setup({ maxAge: 15_000 });
    s.start();
    s.clock.advanceBy(10_000);
    expect(s.optical()).toBeDefined();
    s.clock.advanceBy(5000);
    expect(s.optical()).toBeUndefined();
    expect(s.service.snapshot().optical[0]?.reason).toBe('computer_stale');
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('ignores startup/restart already-playing baselines and unknown discovery', () => {
    const s = setup();
    s.sample(true);
    s.clock.advanceBy(10_000);
    s.sample(true);
    s.clock.advanceBy(10_000);
    expect(s.optical()).toBeUndefined();
    s.sample(true, { sessionId: 'new-session' });
    s.clock.advanceBy(20_000);
    expect(s.optical()).toBeUndefined();
    const d = setup();
    d.sample(false);
    d.clock.advanceBy(1000);
    const computer = d.sample(true);
    computer.observed.media![0]!.player = 'newly-discovered';
    d.clock.advanceBy(10_000);
    expect(d.optical()).toBeUndefined();
  });
  it.each([
    'pipewire_only',
    'no_content',
    'two_players',
    'no_focus',
    'no_audio_app',
    'locked',
    'idle',
    'unknown_idle',
    'activity_mismatch',
    'missing_title',
  ] as const)('rejects false/ambiguous evidence: %s', (evidence) => {
    const s = setup();
    s.sample(false);
    s.clock.advanceBy(1000);
    const computer = s.sample(true);
    const observed = structuredClone(computer.observed);
    if (evidence === 'pipewire_only') observed.media = [];
    if (evidence === 'no_content') observed.media![0]!.contentType = null;
    if (evidence === 'two_players')
      observed.media!.push({ ...observed.media![0]!, player: 'other' });
    if (evidence === 'no_focus') observed.activeApplication = null;
    if (evidence === 'no_audio_app')
      observed.audio!.applications = ['Unrelated'];
    if (evidence === 'locked') observed.locked = true;
    if (evidence === 'idle') observed.idle = true;
    if (evidence === 'unknown_idle') observed.idle = null;
    if (evidence === 'activity_mismatch')
      observed.media![0]!.contentType = 'video/mp4';
    if (evidence === 'missing_title') observed.media![0]!.title = ' ';
    s.clock.advanceBy(1);
    s.sample(true, { observed });
    s.clock.advanceBy(20_000);
    expect(s.optical()).toBeUndefined();
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it.each([9000, 10000])(
    'does not transfer player stability or an existing suggestion to a replacement player after %sms',
    async (elapsed) => {
      const s = setup();
      const a = s.sample(false);
      const b = {
        ...a.observed.media![0]!,
        player: 'org.mpris.MediaPlayer2.other',
        desktopEntry: 'other',
        identity: 'other',
      };
      a.observed.media!.push(b);
      s.clock.advanceBy(1000);
      const first = structuredClone(a.observed);
      first.media![0]!.playback = 'playing';
      first.audio!.playing = true;
      s.sample(true, { observed: first });
      s.clock.advanceBy(elapsed);
      const oldId = s.optical()?.id;
      const replacement = structuredClone(first);
      replacement.media![0]!.playback = 'paused';
      replacement.media![1]!.playback = 'playing';
      replacement.activeApplication = { id: 'other', resourceClass: null };
      replacement.audio!.applications = ['other'];
      s.sample(true, { observed: replacement });
      s.clock.advanceBy(1000);
      expect(s.optical()).toBeUndefined();
      expect(s.service.snapshot().optical[0]?.reason).toBe(
        'awaiting_start_transition',
      );
      if (oldId)
        await expect(
          s.service.respondSuggestion(oldId, 'accept', user),
        ).rejects.toMatchObject({ code: 'suggestion_unavailable' });
      expect(s.invoke).not.toHaveBeenCalled();
    },
  );
  it('allows reentrant observers without leaking maintenance timers', () => {
    const s = setup();
    const unsubscribe = s.service.subscribe(() => s.service.observe());
    s.start();
    s.clock.advanceBy(10000);
    expect(s.clock.pendingTimers()).toBe(1);
    unsubscribe();
    s.service.dispose();
    expect(s.clock.pendingTimers()).toBe(0);
  });
  it('uses hysteresis, cooldown and one suggestion per running context', async () => {
    const s = setup();
    s.start();
    s.clock.advanceBy(10_000);
    await s.service.respondSuggestion(s.optical()!.id, 'dismiss');
    s.clock.advanceBy(1000);
    s.sample(false);
    s.clock.advanceBy(1000);
    s.sample(true);
    s.clock.advanceBy(30_000);
    expect(s.optical()).toBeUndefined();
    s.sample(false);
    s.clock.advanceBy(6000);
    s.sample(true);
    s.clock.advanceBy(10_000);
    expect(s.optical()).toBeDefined();
    await s.service.respondSuggestion(s.optical()!.id, 'reject');
    s.clock.advanceBy(1000);
    s.sample(false);
    s.clock.advanceBy(6000);
    s.sample(true);
    s.clock.advanceBy(10_000);
    expect(s.optical()).toBeUndefined();
    expect(s.service.snapshot().optical[0]?.reason).toBe('cooldown');
    s.clock.advanceBy(15_000);
    expect(s.optical()).toBeDefined();
  });
  it.each(['reject', 'dismiss'] as const)(
    'keeps %s suppression through expiry and fresh heartbeats',
    async (action) => {
      const s = setup({ ttl: 5000 });
      s.start();
      s.clock.advanceBy(10_000);
      await s.service.respondSuggestion(s.optical()!.id, action);
      for (let i = 0; i < 20; i++) {
        s.clock.advanceBy(5000);
        s.sample(true);
      }
      expect(s.optical()).toBeUndefined();
      expect(s.invoke).not.toHaveBeenCalled();
    },
  );
  it('expires unhandled suggestions without recreating them and refuses stale accept', async () => {
    const s = setup({ ttl: 5000 });
    s.start();
    s.clock.advanceBy(10_000);
    const id = s.optical()!.id;
    s.clock.advanceBy(5000);
    expect(s.optical()).toBeUndefined();
    expect(s.service.snapshot().optical[0]?.reason).toBe('context_suppressed');
    await expect(
      s.service.respondSuggestion(id, 'accept', user),
    ).rejects.toMatchObject({ code: 'suggestion_unavailable' });
    s.clock.advanceBy(30_000);
    s.sample(true);
    expect(s.optical()).toBeUndefined();
  });
  it('handles a long stability interval with fresh heartbeats without any automatic actions', () => {
    const s = setup({ stability: 300_000 });
    s.start();
    for (let i = 0; i < 10; i++) {
      s.clock.advanceBy(29_000);
      s.sample(true);
      expect(s.optical()).toBeUndefined();
    }
    s.clock.advanceBy(10_000);
    expect(s.optical()).toBeDefined();
    for (let i = 0; i < 360; i++) {
      s.clock.advanceBy(30_000);
      s.sample(true);
    }
    expect(s.optical()).toBeUndefined();
    expect(s.invoke).not.toHaveBeenCalled();
    s.service.dispose();
    const publications = s.changed.mock.calls.length;
    expect(s.clock.pendingTimers()).toBe(0);
    s.clock.advanceBy(24 * 60 * 60_000);
    s.service.observe();
    expect(s.changed).toHaveBeenCalledTimes(publications);
    expect(s.clock.pendingTimers()).toBe(0);
  });
});

describe('scene suggestions, settings and subscriptions', () => {
  it('suggests only configured available scenes after activity transition, never activates automatically', async () => {
    const s = setup();
    s.start();
    s.clock.advanceBy(5000);
    const suggestion = s.service
      .snapshot()
      .suggestions.find((s) => s.kind === 'scene')!;
    expect(suggestion.sceneId).toBe('scene.music');
    expect(s.invoke).not.toHaveBeenCalled();
    await s.service.respondSuggestion(suggestion.id, 'accept', user);
    expect(s.invoke).toHaveBeenCalledExactlyOnceWith(
      'lighting.activateScene',
      { sceneId: 'scene.music' },
      user,
    );
  });
  it('does not offer a video scene after the existing five-second activity window', () => {
    const s = setup();
    s.startVideo();
    s.clock.advanceBy(5000);
    expect(
      s.service
        .snapshot()
        .suggestions.filter((suggestion) => suggestion.kind === 'scene'),
    ).toEqual([]);
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('offers a video scene only at five minutes of fresh playing audio and waits for acceptance', async () => {
    const s = setup();
    s.startVideo();
    s.advanceVideo(5 * 60_000 - 1);
    expect(
      s.service
        .snapshot()
        .suggestions.filter((suggestion) => suggestion.kind === 'scene'),
    ).toEqual([]);
    s.clock.advanceBy(1);
    s.videoSample(true);
    const suggestion = s.service
      .snapshot()
      .suggestions.find(
        (candidate) =>
          candidate.kind === 'scene' && candidate.sceneId === 'scene.film',
      );
    expect(suggestion).toBeDefined();
    expect(s.invoke).not.toHaveBeenCalled();
    await s.service.respondSuggestion(suggestion!.id, 'accept', user);
    expect(s.invoke).toHaveBeenCalledExactlyOnceWith(
      'lighting.activateScene',
      { sceneId: 'scene.film' },
      user,
    );
  });
  it.each([
    ['MPRIS player', { spotifyMpris: 'player' }],
    ['MPRIS identity', { spotifyMpris: 'identity' }],
    ['MPRIS desktop entry', { spotifyMpris: 'desktopEntry' }],
    ['PipeWire application', { spotifyPipewire: true }],
    ['concurrent MPRIS player', { concurrentSpotify: true }],
  ] as const)(
    'suppresses video scene suggestions while Spotify is active through %s',
    (_source, options) => {
      const s = setup();
      s.startVideo(options);
      s.advanceVideo(5 * 60_000, options);
      expect(
        s.service
          .snapshot()
          .suggestions.filter((suggestion) => suggestion.kind === 'scene'),
      ).toEqual([]);
      expect(s.invoke).not.toHaveBeenCalled();
    },
  );
  it('starts a fresh five-minute window after Spotify stops', () => {
    const s = setup();
    s.startVideo({ spotifyPipewire: true });
    s.advanceVideo(5 * 60_000, { spotifyPipewire: true });
    expect(
      s.service
        .snapshot()
        .suggestions.filter((suggestion) => suggestion.kind === 'scene'),
    ).toEqual([]);
    s.clock.advanceBy(1000);
    s.videoSample(true);
    s.advanceVideo(5 * 60_000 - 1);
    expect(
      s.service
        .snapshot()
        .suggestions.filter((suggestion) => suggestion.kind === 'scene'),
    ).toEqual([]);
    s.clock.advanceBy(1);
    s.videoSample(true);
    expect(
      s.service
        .snapshot()
        .suggestions.some(
          (suggestion) =>
            suggestion.kind === 'scene' && suggestion.sceneId === 'scene.film',
        ),
    ).toBe(true);
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('allows a revoked pending film prompt to return only after five fresh minutes', () => {
    const s = setup({ ttl: 300_000 });
    s.startVideo();
    s.advanceVideo(5 * 60_000);
    expect(
      s.service
        .snapshot()
        .suggestions.some(
          (suggestion) =>
            suggestion.kind === 'scene' && suggestion.sceneId === 'scene.film',
        ),
    ).toBe(true);
    s.clock.advanceBy(1000);
    s.videoSample(true, { spotifyPipewire: true });
    expect(
      s.service
        .snapshot()
        .suggestions.filter(
          (suggestion) =>
            suggestion.kind === 'scene' && suggestion.sceneId === 'scene.film',
        ),
    ).toEqual([]);
    s.clock.advanceBy(1000);
    s.videoSample(true);
    s.advanceVideo(5 * 60_000 - 1);
    expect(
      s.service
        .snapshot()
        .suggestions.filter(
          (suggestion) =>
            suggestion.kind === 'scene' && suggestion.sceneId === 'scene.film',
        ),
    ).toEqual([]);
    s.clock.advanceBy(1);
    s.videoSample(true);
    expect(
      s.service
        .snapshot()
        .suggestions.some(
          (suggestion) =>
            suggestion.kind === 'scene' && suggestion.sceneId === 'scene.film',
        ),
    ).toBe(true);
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('resets on a pause and requires a new uninterrupted five-minute audio window', () => {
    const s = setup();
    s.startVideo();
    s.advanceVideo(2 * 60_000);
    s.clock.advanceBy(1000);
    s.videoSample(false);
    s.clock.advanceBy(11_000);
    s.videoSample(true);
    s.advanceVideo(5 * 60_000 - 1);
    expect(
      s.service
        .snapshot()
        .suggestions.filter((suggestion) => suggestion.kind === 'scene'),
    ).toEqual([]);
    s.clock.advanceBy(1);
    s.videoSample(true);
    expect(
      s.service
        .snapshot()
        .suggestions.some(
          (suggestion) =>
            suggestion.kind === 'scene' && suggestion.sceneId === 'scene.film',
        ),
    ).toBe(true);
  });
  it('resets the audio window on an MPRIS player change', () => {
    const s = setup();
    s.startVideo();
    s.advanceVideo(4 * 60_000 + 50_000);
    s.clock.advanceBy(1000);
    s.videoSample(true, {
      application: 'org.other.Player',
      player: 'org.mpris.MediaPlayer2.other',
    });
    s.advanceVideo(5 * 60_000 - 1, {
      application: 'org.other.Player',
      player: 'org.mpris.MediaPlayer2.other',
    });
    expect(
      s.service
        .snapshot()
        .suggestions.filter((suggestion) => suggestion.kind === 'scene'),
    ).toEqual([]);
    s.clock.advanceBy(1);
    s.videoSample(true, {
      application: 'org.other.Player',
      player: 'org.mpris.MediaPlayer2.other',
    });
    expect(
      s.service
        .snapshot()
        .suggestions.some(
          (suggestion) =>
            suggestion.kind === 'scene' && suggestion.sceneId === 'scene.film',
        ),
    ).toBe(true);
  });
  it.each(['retained', 'restart'] as const)(
    'does not carry video stability through a %s observation boundary',
    (boundary) => {
      const s = setup();
      s.startVideo();
      s.advanceVideo(4 * 60_000 + 50_000);
      s.clock.advanceBy(1000);
      if (boundary === 'retained')
        s.videoSample(true, {}, { reason: 'retained' });
      else s.videoSample(true, { sessionId: 'session-2' });
      s.clock.advanceBy(9000);
      s.videoSample(
        true,
        boundary === 'restart' ? { sessionId: 'session-2' } : {},
      );
      expect(
        s.service
          .snapshot()
          .suggestions.filter(
            (suggestion) =>
              suggestion.kind === 'scene' &&
              suggestion.sceneId === 'scene.film',
          ),
      ).toEqual([]);
      expect(s.invoke).not.toHaveBeenCalled();
    },
  );
  it('revokes a pending video scene on pause, staleness, Spotify or player handoff', async () => {
    for (const reason of ['pause', 'stale', 'spotify', 'player'] as const) {
      const s = setup({ ttl: 300_000 });
      s.startVideo();
      s.advanceVideo(5 * 60_000);
      const id = s.service
        .snapshot()
        .suggestions.find(
          (candidate) =>
            candidate.kind === 'scene' && candidate.sceneId === 'scene.film',
        )?.id;
      expect(id).toBeDefined();
      if (reason === 'pause') {
        s.clock.advanceBy(1000);
        s.videoSample(false);
      } else if (reason === 'stale') s.clock.advanceBy(90_001);
      else {
        s.clock.advanceBy(1000);
        if (reason === 'spotify')
          s.videoSample(true, { spotifyPipewire: true });
        else
          s.videoSample(true, {
            application: 'org.other.Player',
            player: 'org.mpris.MediaPlayer2.other',
          });
      }
      expect(
        s.service
          .snapshot()
          .suggestions.filter(
            (suggestion) =>
              suggestion.kind === 'scene' &&
              suggestion.sceneId === 'scene.film',
          ),
      ).toEqual([]);
      await expect(
        s.service.respondSuggestion(id!, 'accept', user),
      ).rejects.toMatchObject({ code: 'suggestion_unavailable' });
      expect(s.invoke).not.toHaveBeenCalled();
    }
  });
  it('does not count audio when the desktop is locked or idle, or when only an app is open', () => {
    for (const options of [{ locked: true }, { idle: null }]) {
      const s = setup();
      s.startVideo({ ...options, noMedia: true });
      s.advanceVideo(5 * 60_000, { ...options, noMedia: true });
      expect(
        s.service
          .snapshot()
          .suggestions.filter((suggestion) => suggestion.kind === 'scene'),
      ).toEqual([]);
    }
    const silent = setup();
    silent.startVideo({ noMedia: true });
    silent.clock.advanceBy(1000);
    silent.videoSample(false, { noMedia: true });
    for (let elapsed = 0; elapsed < 5 * 60_000; elapsed += 30_000) {
      silent.clock.advanceBy(30_000);
      silent.videoSample(false, { noMedia: true });
    }
    expect(
      silent.service
        .snapshot()
        .suggestions.filter((suggestion) => suggestion.kind === 'scene'),
    ).toEqual([]);
  });
  it('allows audio evidence without MPRIS only when audio is actively playing', () => {
    const s = setup();
    s.startVideo({ noMedia: true });
    s.advanceVideo(5 * 60_000, { noMedia: true });
    expect(
      s.service
        .snapshot()
        .suggestions.some(
          (suggestion) =>
            suggestion.kind === 'scene' && suggestion.sceneId === 'scene.film',
        ),
    ).toBe(true);
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('requires corroborated MPRIS video evidence when a media observation exists', () => {
    const s = setup();
    const options = { contentType: 'audio/mpeg' };
    s.startVideo(options);
    s.advanceVideo(5 * 60_000, options);
    expect(
      s.service
        .snapshot()
        .suggestions.filter((suggestion) => suggestion.kind === 'scene'),
    ).toEqual([]);
  });
  it('keeps dismissal priority and never dispatches a scene until accepted', async () => {
    const s = setup({ ttl: 300_000 });
    s.startVideo();
    s.advanceVideo(5 * 60_000);
    const scene = s.service
      .snapshot()
      .suggestions.find(
        (candidate) =>
          candidate.kind === 'scene' && candidate.sceneId === 'scene.film',
      )!;
    await s.service.respondSuggestion(scene.id, 'dismiss');
    s.advanceVideo(5 * 60_000);
    expect(
      s.service
        .snapshot()
        .suggestions.filter(
          (suggestion) =>
            suggestion.kind === 'scene' && suggestion.sceneId === 'scene.film',
        ),
    ).toEqual([]);
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('uses the five-minute guard if scene.movie_light is mapped to another activity', async () => {
    const s = setup();
    s.setScenes([
      'scene.music',
      'scene.film',
      'scene.focus',
      'scene.movie_light',
    ]);
    const document = s.service.snapshot();
    document.settings.suggestions.sceneMappings['music'] = 'scene.movie_light';
    await s.service.updateSettings(document.settings, document.generation);
    s.start();
    s.clock.advanceBy(5000);
    expect(
      s.service
        .snapshot()
        .suggestions.filter(
          (suggestion) =>
            suggestion.kind === 'scene' &&
            suggestion.sceneId === 'scene.movie_light',
        ),
    ).toEqual([]);
    for (let elapsed = 0; elapsed < 5 * 60_000; elapsed += 30_000) {
      s.clock.advanceBy(30_000);
      s.sample(true);
    }
    expect(
      s.service
        .snapshot()
        .suggestions.some(
          (suggestion) =>
            suggestion.kind === 'scene' &&
            suggestion.sceneId === 'scene.movie_light',
        ),
    ).toBe(true);
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('revalidates availability and scene mappings before accept', async () => {
    const s = setup();
    s.start();
    s.clock.advanceBy(5000);
    const id = s.service
      .snapshot()
      .suggestions.find((s) => s.kind === 'scene')!.id;
    s.setScenes([]);
    await expect(
      s.service.respondSuggestion(id, 'accept', user),
    ).rejects.toMatchObject({ code: 'suggestion_unavailable' });
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('dismisses a scene for the current activity context, with expiry and rate limiting', async () => {
    const s = setup({ ttl: 5000 });
    s.start();
    s.clock.advanceBy(5000);
    const scene = s.service
      .snapshot()
      .suggestions.find((s) => s.kind === 'scene')!;
    await s.service.respondSuggestion(scene.id, 'dismiss');
    for (let i = 0; i < 10; i++) {
      s.clock.advanceBy(5000);
      s.sample(true);
    }
    expect(
      s.service.snapshot().suggestions.filter((s) => s.kind === 'scene'),
    ).toEqual([]);
    s.clock.advanceBy(1000);
    s.sample(false);
    s.clock.advanceBy(1000);
    s.sample(true);
    s.clock.advanceBy(5000);
    expect(
      s.service.snapshot().suggestions.filter((s) => s.kind === 'scene'),
    ).toHaveLength(1);
  });
  it('rejects unmapped routes and unavailable scenes without writing settings', async () => {
    const s = setup();
    const snapshot = s.service.snapshot();
    snapshot.settings.optical.source = 'Invented';
    await expect(
      s.service.updateSettings(snapshot.settings, snapshot.generation),
    ).rejects.toMatchObject({ code: 'optical_mapping_unavailable' });
    snapshot.settings.optical.source = 'Optical In';
    snapshot.settings.suggestions.sceneMappings['music'] = 'scene.missing';
    await expect(
      s.service.updateSettings(snapshot.settings, snapshot.generation),
    ).rejects.toMatchObject({ code: 'scene_unavailable' });
    expect(s.save).not.toHaveBeenCalled();
  });
  it('updates with optimistic generation, clears old evidence and stops timers when disabled', async () => {
    const s = setup();
    s.start();
    s.clock.advanceBy(10_000);
    const before = s.service.snapshot();
    const result = await s.service.updateSettings(
      defaultIntelligenceSettings(),
      before.generation,
    );
    expect(result.generation).not.toBe(before.generation);
    expect(result.suggestions).toEqual([]);
    expect(s.clock.pendingTimers()).toBe(0);
    await expect(
      s.service.updateSettings(
        defaultIntelligenceSettings(),
        before.generation,
      ),
    ).rejects.toMatchObject({ code: 'intelligence_settings_changed' });
  });
  it('allows disabling scene suggestions after a mapped scene disappears', async () => {
    const s = setup();
    const snapshot = s.service.snapshot();
    s.setScenes([]);
    snapshot.settings.suggestions.enabled = false;
    const saved = await s.service.updateSettings(
      snapshot.settings,
      snapshot.generation,
    );
    expect(saved.settings.suggestions.enabled).toBe(false);
  });
  it('treats first known activity after an unknown restart baseline as discovery', () => {
    const s = setup();
    s.sample(false, {
      activity: {
        classification: 'unknown',
        source: 'desktop-agent',
        basis: null,
      },
    });
    s.clock.advanceBy(1000);
    s.sample(true);
    s.clock.advanceBy(5000);
    expect(
      s.service.snapshot().suggestions.filter((s) => s.kind === 'scene'),
    ).toEqual([]);
  });
  it('does not infer a start from enabling settings while media is playing', async () => {
    const s = setup({ defaults: true });
    s.sample(true);
    const snapshot = s.service.snapshot();
    snapshot.settings.optical = {
      ...snapshot.settings.optical,
      enabled: true,
      ...route,
      target,
    };
    await s.service.updateSettings(snapshot.settings, snapshot.generation);
    s.clock.advanceBy(1000);
    s.sample(true);
    s.clock.advanceBy(10_000);
    expect(s.optical()).toBeUndefined();
  });
  it('requires human provenance, consumes before async dispatch, and does not replay failed commands', async () => {
    const s = setup();
    s.start();
    s.clock.advanceBy(10_000);
    const id = s.optical()!.id;
    await expect(
      s.service.respondSuggestion(id, 'accept'),
    ).rejects.toMatchObject({ code: 'human_actor_required' });
    s.invoke.mockRejectedValueOnce(new Error('mock adapter failure'));
    await expect(
      s.service.respondSuggestion(id, 'accept', user),
    ).rejects.toThrow('mock adapter failure');
    await expect(
      s.service.respondSuggestion(id, 'accept', user),
    ).rejects.toMatchObject({ code: 'suggestion_unavailable' });
    expect(s.invoke).toHaveBeenCalledTimes(1);
  });
  it('subscribes to state changes with isolated snapshots and supports unsubscribe/dispose', () => {
    const s = setup();
    const listener = vi.fn((snapshot) => {
      snapshot.suggestions.length = 0;
    });
    const unsubscribe = s.service.subscribe(listener);
    s.start();
    s.clock.advanceBy(10_000);
    expect(listener).toHaveBeenCalled();
    expect(s.optical()).toBeDefined();
    unsubscribe();
    const count = listener.mock.calls.length;
    s.clock.advanceBy(1000);
    s.service.dispose();
    s.clock.advanceBy(100_000);
    expect(listener).toHaveBeenCalledTimes(count);
    expect(s.clock.pendingTimers()).toBe(0);
  });
  it('validates settings strictly, including non-disableable manual protection', () => {
    expect(
      IntelligenceSettingsSchema.parse(defaultIntelligenceSettings())
        .suggestions.sceneMappings,
    ).toEqual({});
    const settings = defaultIntelligenceSettings();
    expect(
      IntelligenceSettingsSchema.safeParse({
        ...settings,
        optical: { ...settings.optical, respectManual: false },
      }).success,
    ).toBe(false);
  });
});

/** Models the store's rename/publication before the delayed directory-sync completion. */
function deferredSettingsStore(initial = defaultIntelligenceSettings()) {
  let document: IntelligenceSettingsDocument = {
    settings: initial,
    generation: 'generation-1',
  };
  let serial = 1;
  const writes: {
    publish: () => void;
    finish: () => void;
    fail: () => void;
  }[] = [];
  const repository: IntelligenceSettingsRepository = {
    snapshot: () => structuredClone(document),
    save: (settings, expectedGeneration) =>
      new Promise((resolve, reject) => {
        let committed: IntelligenceSettingsDocument | undefined;
        writes.push({
          publish: () => {
            if (document.generation !== expectedGeneration) {
              reject(
                new IntelligenceError(409, 'intelligence_settings_changed'),
              );
              return;
            }
            committed = {
              settings: structuredClone(settings),
              generation: `generation-${++serial}`,
            };
            document = committed;
          },
          finish: () => {
            if (!committed)
              throw new Error('Write must publish before sync completion');
            resolve(structuredClone(committed));
          },
          fail: () =>
            reject(
              new IntelligenceError(503, 'intelligence_settings_save_failed'),
            ),
        });
      }),
  };
  return { repository, writes };
}
function enabledSettings(): IntelligenceSettings {
  const settings = defaultIntelligenceSettings();
  settings.optical = { ...settings.optical, enabled: true, ...route, target };
  settings.suggestions = {
    ...settings.suggestions,
    enabled: true,
    sceneMappings: { music: 'scene.music' },
  };
  return settings;
}

describe('settings generation publication boundaries', () => {
  it('rebases disabled evidence before evaluation while directory sync is still pending', async () => {
    const store = deferredSettingsStore();
    const s = setup({ settingsStore: store.repository });
    s.start();
    s.clock.advanceBy(10000); // A mature scene transition collected while disabled.
    const pending = s.service.updateSettings(
      enabledSettings(),
      store.repository.snapshot().generation,
    );
    store.writes[0]!.publish(); // Atomic rename makes the new document visible; save is unresolved.
    s.service.observe();
    expect(s.service.snapshot().suggestions).toEqual([]);
    expect(s.service.snapshot().optical[0]?.reason).toBe('restart_baseline');
    s.clock.advanceBy(1000);
    s.sample(true);
    s.clock.advanceBy(10000);
    expect(s.service.snapshot().suggestions).toEqual([]);
    store.writes[0]!.finish();
    await pending;
    expect(s.service.snapshot().suggestions).toEqual([]);
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('never projects old suggestions or decisions together with a newly published generation', async () => {
    const store = deferredSettingsStore(enabledSettings());
    const s = setup({ settingsStore: store.repository });
    s.start();
    s.clock.advanceBy(10000);
    const before = s.service.snapshot();
    expect(before.suggestions).toHaveLength(2);
    const settings = enabledSettings();
    settings.suggestions.sceneMappings['music'] = 'scene.film';
    const pending = s.service.updateSettings(settings, before.generation);
    store.writes[0]!.publish();
    const snapshot = s.service.snapshot();
    expect(snapshot.generation).toBe(store.repository.snapshot().generation);
    expect(snapshot.suggestions).toEqual([]);
    expect(snapshot.optical).toEqual([]);
    await expect(
      s.service.respondSuggestion(before.suggestions[0]!.id, 'accept', user),
    ).rejects.toMatchObject({ code: 'suggestion_unavailable' });
    store.writes[0]!.finish();
    await pending;
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('preserves new-generation evidence when the older save finally completes', async () => {
    const store = deferredSettingsStore();
    const s = setup({ settingsStore: store.repository });
    s.sample(false);
    const pending = s.service.updateSettings(
      enabledSettings(),
      store.repository.snapshot().generation,
    );
    store.writes[0]!.publish();
    s.service.observe();
    s.clock.advanceBy(1000);
    s.sample(true);
    s.clock.advanceBy(10000);
    const suggestions = s.service.snapshot().suggestions;
    expect(suggestions).toHaveLength(2);
    store.writes[0]!.finish();
    const result = await pending;
    expect(result.suggestions).toEqual(suggestions);
    expect(s.clock.pendingTimers()).toBe(1);
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it('does not reactivate a newer disabled generation when an older enabled save completes late', async () => {
    const store = deferredSettingsStore();
    const s = setup({ settingsStore: store.repository });
    s.sample(false);
    const enabling = s.service.updateSettings(
      enabledSettings(),
      store.repository.snapshot().generation,
    );
    store.writes[0]!.publish();
    s.service.observe();
    const disabling = s.service.updateSettings(
      defaultIntelligenceSettings(),
      store.repository.snapshot().generation,
    );
    store.writes[1]!.publish();
    s.service.observe();
    const disabledGeneration = store.repository.snapshot().generation;
    store.writes[1]!.finish();
    await disabling;
    store.writes[0]!.finish();
    const result = await enabling;
    expect(result.generation).toBe(disabledGeneration);
    expect(result.settings).toEqual(defaultIntelligenceSettings());
    s.clock.advanceBy(1000);
    s.sample(true);
    s.clock.advanceBy(100000);
    expect(s.service.snapshot().suggestions).toEqual([]);
    expect(s.clock.pendingTimers()).toBe(0);
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'reconciles failed saves using only the committed generation (published=%s)',
    async (published) => {
      const store = deferredSettingsStore(enabledSettings());
      const s = setup({ settingsStore: store.repository });
      s.start();
      s.clock.advanceBy(10000);
      const before = s.service.snapshot();
      const pending = s.service.updateSettings(
        defaultIntelligenceSettings(),
        before.generation,
      );
      if (published) store.writes[0]!.publish();
      store.writes[0]!.fail();
      await expect(pending).rejects.toMatchObject({
        code: 'intelligence_settings_save_failed',
      });
      if (published) {
        expect(s.changed.mock.calls.at(-1)?.[0].generation).toBe(
          store.repository.snapshot().generation,
        );
        expect(s.service.snapshot().suggestions).toEqual([]);
        expect(s.clock.pendingTimers()).toBe(0);
      } else {
        expect(s.service.snapshot().suggestions).toEqual(before.suggestions);
        expect(s.clock.pendingTimers()).toBe(1);
      }
      expect(s.invoke).not.toHaveBeenCalled();
    },
  );
  it('does not clear newer evidence after a concurrent stale-generation save rejection', async () => {
    const store = deferredSettingsStore();
    const s = setup({ settingsStore: store.repository });
    s.sample(false);
    const oldGeneration = store.repository.snapshot().generation;
    const enabling = s.service.updateSettings(enabledSettings(), oldGeneration);
    store.writes[0]!.publish();
    s.service.observe();
    s.clock.advanceBy(1000);
    s.sample(true);
    s.clock.advanceBy(10000);
    const suggestions = s.service.snapshot().suggestions;
    const stale = s.service.updateSettings(
      defaultIntelligenceSettings(),
      oldGeneration,
    );
    store.writes[1]!.publish();
    await expect(stale).rejects.toMatchObject({
      code: 'intelligence_settings_changed',
    });
    expect(s.service.snapshot().suggestions).toEqual(suggestions);
    store.writes[0]!.finish();
    await enabling;
    expect(s.service.snapshot().suggestions).toEqual(suggestions);
    expect(s.invoke).not.toHaveBeenCalled();
  });
  it.each(['finish', 'fail'] as const)(
    'does not publish or schedule after dispose during a pending save (%s)',
    async (completion) => {
      const store = deferredSettingsStore();
      const s = setup({ settingsStore: store.repository });
      s.start();
      const pending = s.service.updateSettings(
        enabledSettings(),
        store.repository.snapshot().generation,
      );
      store.writes[0]!.publish();
      s.service.dispose();
      const publications = s.changed.mock.calls.length;
      store.writes[0]![completion]();
      if (completion === 'finish') await pending;
      else
        await expect(pending).rejects.toMatchObject({
          code: 'intelligence_settings_save_failed',
        });
      s.clock.advanceBy(24 * 60 * 60000);
      s.service.observe();
      expect(s.service.snapshot().suggestions).toEqual([]);
      expect(s.clock.pendingTimers()).toBe(0);
      expect(s.changed).toHaveBeenCalledTimes(publications);
      expect(s.invoke).not.toHaveBeenCalled();
    },
  );
});
