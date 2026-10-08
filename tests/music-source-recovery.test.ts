import { expect, it } from 'vitest';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const target = 'music.room';
const start = Date.parse('2026-10-04T12:00:00+02:00');
const human = { actor: { type: 'user' as const }, source: 'dashboard' };
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
async function setup() {
  const clock = new FakeClock(start);
  const services: string[] = [];
  const reads: string[] = [];
  let snapshot = {
    entity_id: 'media_player.room',
    state: 'playing',
    last_changed: new Date(start - 60_000).toISOString(),
    last_updated: new Date(start - 1).toISOString(),
    attributes: {
      source: 'Spotify' as string | null,
      volume_level: 0.3,
      media_title: 'Track',
    },
  };
  const adapter = new HomeAssistantMusicAdapter(
    {
      baseUrl: 'http://home-assistant.test',
      token: 'test-token',
      entities: {
        [target]: {
          entityId: 'media_player.room',
          sources: ['Spotify', 'Optical'],
        },
      },
    },
    async (input, init) => {
      if (init?.method === 'GET') {
        reads.push(String(input));
        return Response.json(snapshot);
      }
      services.push(String(input).split('/').at(-1)!);
      return Response.json([]);
    },
    clock,
  );
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: {
      targets: { [target]: ['Spotify', 'Optical'] },
      adapter,
      feedbackTimeoutMs: 1_000,
    },
  });
  await engine.handleBilresaPress('2', 'multi_press_1');
  expect(adapter.acceptState(snapshot)).toBe(true);
  const change = (
    source: string | null,
    playback = 'playing',
    changedAt = start - 60_000,
  ) => {
    snapshot = {
      ...snapshot,
      state: playback,
      last_updated: new Date(clock.now()).toISOString(),
      last_changed: new Date(changedAt).toISOString(),
      attributes: {
        ...snapshot.attributes,
        source,
        media_title: `Track ${clock.now()}`,
      },
    };
  };
  const emit = () =>
    expect(
      adapter.acceptStateChangedEvent({
        event_type: 'state_changed',
        data: { entity_id: snapshot.entity_id, new_state: snapshot },
      }),
    ).toBe(true);
  const advance = async (ms: number) => {
    clock.advanceBy(ms);
    await flush();
  };
  const pause = async () => {
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    await flush();
    return engine.state.music.commands.at(-1)!;
  };
  const record = (id: string) =>
    engine.state.music.commands.find((command) => command.id === id)!;
  return {
    clock,
    engine,
    services,
    reads,
    adapter,
    change,
    emit,
    advance,
    pause,
    record,
  };
}

it.each([
  'subscription',
  'same-tick-subscription',
  'first-read',
  'pre-retry-read',
] as const)(
  'physical source selection cancels an automatic Pause through %s without changing playback ownership',
  async (path) => {
    const s = await setup();
    try {
      const pause = await s.pause();
      if (path === 'subscription' || path === 'pre-retry-read') {
        await s.advance(1_000);
        expect(s.record(pause.id).recovery?.stage).toBe('waiting_retry');
        await s.advance(1);
      } else if (path === 'first-read') await s.advance(1);
      s.change('Optical');
      if (path.includes('subscription')) s.emit();
      const before = structuredClone(s.engine.state.intent);
      await s.advance(path === 'first-read' ? 999 : 2_000);
      expect(s.services).toEqual(['media_pause']);
      expect(s.record(pause.id).recovery).toMatchObject({
        stage: 'stopped',
        stopReason: path.includes('subscription')
          ? 'superseded'
          : 'newer_report',
      });
      expect(s.engine.state.intent).toEqual(before);
      expect(s.engine.state.intent.holds).toEqual([]);
      expect(s.engine.getMusicState(target).observed).toMatchObject({
        playback: 'playing',
        source: path.includes('subscription') ? 'Optical' : 'Spotify',
      });
      expect(s.record(pause.id).status).not.toBe('confirmed');
    } finally {
      s.engine.dispose();
    }
  },
);

it('source selection preserves explicit Pause and independent manual volume recovery', async () => {
  const s = await setup();
  try {
    const volume = await s.engine.requestMusic(
      target,
      { property: 'volume', value: 0.4 },
      human,
    );
    const pause = await s.engine.requestMusic(
      target,
      { property: 'playback', value: 'paused' },
      human,
    );
    const intent = s.engine.getMusicIntentSnapshot();
    await s.advance(1_000);
    await s.advance(1);
    s.change('Optical');
    s.emit();
    // Source cancellation cannot invalidate the independent volume generation
    // or change its human ownership, baseline and destination.
    expect(s.record(volume.id).recovery?.stage).toBe('waiting_retry');
    expect(s.record(pause.id).recovery?.stopReason).toBe('superseded');
    expect(s.engine.getMusicIntentSnapshot()).toEqual(intent);
    expect(s.engine.state.intent.holds).toMatchObject([
      { createdAt: pause.issuedAt, provenance: human },
    ]);
  } finally {
    s.engine.dispose();
  }
});

it('title/metadata repeats keep unchanged-source Pause recovery eligible', async () => {
  const s = await setup();
  try {
    const pause = await s.pause();
    await s.advance(1_000);
    await s.advance(1);
    s.change('Spotify');
    s.emit();
    await s.advance(1_999);
    expect(s.services).toEqual(['media_pause', 'media_pause']);
    expect(s.record(pause.id).recovery?.attemptCount).toBe(2);
    expect(s.engine.state.intent.holds).toEqual([]);
  } finally {
    s.engine.dispose();
  }
});

it.each(['source', 'preset'] as const)(
  'a delayed own %s source echo retains accepted automatic Pause attribution without inventing a hold',
  async (kind) => {
    const s = await setup();
    try {
      await s.engine.requestMusic(
        target,
        kind === 'source'
          ? { property: 'source', value: 'Optical' }
          : { property: 'preset', value: 'optical' },
        human,
      );
      const pause = await s.pause();
      await s.advance(1_000);
      await s.advance(1);
      s.change('Optical', 'paused', s.clock.now());
      s.emit();
      expect(s.engine.state.intent.holds).toEqual([]);
      expect(s.record(pause.id).status).toBe('confirmed');
      await s.advance(2_000);
      expect(
        s.services.filter((service) => service === 'media_pause'),
      ).toHaveLength(1);
    } finally {
      s.engine.dispose();
    }
  },
);

it('ordinary source feedback still confirms the current source request', async () => {
  const s = await setup();
  try {
    const selection = await s.engine.requestMusic(
      target,
      { property: 'source', value: 'Optical' },
      human,
    );
    await s.advance(1);
    s.change('Optical');
    s.emit();
    expect(s.record(selection.id).status).toBe('confirmed');
    expect(s.engine.state.intent.holds).toEqual([]);
  } finally {
    s.engine.dispose();
  }
});

it('a source-only fresh read cancels Play recovery even when reported playback matches', async () => {
  const s = await setup();
  try {
    const play = await s.engine.requestMusic(
      target,
      { property: 'playback', value: 'playing' },
      human,
    );
    const before = structuredClone(s.engine.state.intent);
    await s.advance(1);
    s.change('Optical');
    await s.advance(999);
    expect(s.record(play.id)).toMatchObject({
      status: 'unconfirmed',
      recovery: {
        stage: 'stopped',
        stopReason: 'newer_report',
        reported: { source: 'Optical', playback: 'playing' },
      },
    });
    expect(s.engine.state.intent).toEqual(before);
    expect(s.engine.getMusicState(target).observed.source).toBe('Spotify');
    expect(s.reads).toEqual([
      'http://home-assistant.test/api/states/media_player.room',
    ]);
  } finally {
    s.engine.dispose();
  }
});

it('a source observation published during retry cancels synchronously before dispatch', async () => {
  const s = await setup();
  let unsubscribe = () => {};
  try {
    const pause = await s.pause();
    let emitted = false;
    unsubscribe = s.engine.stream.subscribe((update) => {
      if (
        emitted ||
        update.patch.music?.commands.find((command) => command.id === pause.id)
          ?.recovery?.stage !== 'retrying'
      )
        return;
      emitted = true;
      s.change('Optical');
      s.emit();
    });
    await s.advance(1_000);
    await s.advance(2_000);
    expect(emitted).toBe(true);
    expect(s.services).toEqual(['media_pause']);
    expect(s.record(pause.id).recovery?.stopReason).toBe('superseded');
  } finally {
    unsubscribe();
    s.engine.dispose();
  }
});

it.each(['source', 'preset'] as const)(
  'a recent accepted %s cannot authorize Pause retries over a later physical source choice',
  async (kind) => {
    const s = await setup();
    try {
      await s.engine.requestMusic(
        target,
        kind === 'source'
          ? { property: 'source', value: 'Optical' }
          : { property: 'preset', value: 'optical' },
        human,
      );
      const pause = await s.pause();
      await s.advance(1_000);
      await s.advance(1);
      s.change('Optical');
      s.emit();
      await s.advance(2_000);
      expect(s.record(pause.id).recovery?.stopReason).toBe('superseded');
      expect(
        s.services.filter((service) => service === 'media_pause'),
      ).toHaveLength(1);
      expect(s.engine.state.intent.holds).toEqual([]);
    } finally {
      s.engine.dispose();
    }
  },
);

it('a physical source and Paused transition still creates its own Pause hold', async () => {
  const s = await setup();
  try {
    const play = await s.engine.requestMusic(
      target,
      { property: 'playback', value: 'playing' },
      human,
    );
    await s.advance(1);
    s.change('Optical', 'paused', s.clock.now());
    s.emit();
    expect(s.record(play.id).recovery?.stopReason).toBe('superseded');
    expect(s.engine.state.intent.holds).toMatchObject([
      {
        createdAt: s.clock.now(),
        provenance: {
          actor: { type: 'home_assistant' },
          source: 'home_assistant.state_changed',
        },
      },
    ]);
  } finally {
    s.engine.dispose();
  }
});

it.each(['null-report', 'unknown-baseline'] as const)(
  '%s is not evidence of a changed physical source',
  async (kind) => {
    const s = await setup();
    try {
      if (kind === 'unknown-baseline') {
        s.change(null);
        s.emit();
      }
      const pause = await s.pause();
      await s.advance(1_000);
      await s.advance(1);
      s.change(kind === 'null-report' ? null : 'Optical');
      s.emit();
      await s.advance(1_999);
      expect(s.services).toEqual(['media_pause', 'media_pause']);
      expect(s.record(pause.id).recovery?.attemptCount).toBe(2);
      expect(s.engine.state.intent.holds).toEqual([]);
    } finally {
      s.engine.dispose();
    }
  },
);
