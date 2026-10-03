import { expect, it, vi } from 'vitest';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const user = { actor: { type: 'user' as const }, source: 'dashboard' };

function setup() {
  const clock = new FakeClock(Date.parse('2026-10-04T12:00:00+02:00'));
  const transport = vi.fn(async () => new Response(null, { status: 200 }));
  const adapter = new HomeAssistantMusicAdapter(
    {
      baseUrl: 'http://home-assistant.test:8123',
      token: 'test-token',
      entities: { 'music.room': { entityId: 'media_player.room' } },
    },
    transport,
    clock,
  );
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { 'music.room': [] }, adapter, feedbackTimeoutMs: 1_000 },
  });
  const observe = (volume: number) => {
    clock.advanceBy(1);
    expect(
      adapter.acceptStateChangedEvent({
        event_type: 'state_changed',
        data: {
          entity_id: 'media_player.room',
          new_state: {
            entity_id: 'media_player.room',
            state: 'playing',
            attributes: { volume_level: volume, media_title: 'Track' },
            last_updated: new Date(clock.now()).toISOString(),
            last_changed: '2026-10-04T09:00:00Z',
          },
        },
      }),
    ).toBe(true);
  };
  const request = (volume: number) =>
    engine.requestMusic(
      'music.room',
      { property: 'volume', value: volume },
      user,
    );
  observe(0.3);
  return { clock, engine, transport, observe, request };
}

it('attributes a delayed superseded HA volume step without discarding or confirming the newer target', async () => {
  const { clock, engine, observe, request } = setup();
  try {
    const older = await request(0.35);
    clock.advanceBy(100);
    const newer = await request(0.4);
    observe(0.35);
    expect(engine.getMusicState('music.room').observed.volume).toBe(0.35);
    expect(engine.getMusicState('music.room').requested.volume).toBe(0.4);
    expect(
      engine.state.music.commands.find((c) => c.id === older.id)?.status,
    ).toBe('superseded');
    expect(
      engine.state.music.commands.find((c) => c.id === newer.id)?.status,
    ).toBe('pending');
    expect(engine.getMusicVolumePolicySnapshots()['music.room']?.baseline).toBe(
      0.4,
    );
    observe(0.4);
    expect(
      engine.state.music.commands.find((c) => c.id === newer.id)?.status,
    ).toBe('confirmed');
    expect(engine.getMusicState('music.room').requested.volume).toBeUndefined();
    // The old step's attribution was consumed. A later physical change to that
    // same level must update the baseline normally.
    observe(0.35);
    expect(engine.getMusicVolumePolicySnapshots()['music.room']?.baseline).toBe(
      0.35,
    );
  } finally {
    engine.dispose();
  }
});

it.each([
  'different value',
  'expired old step',
  'already confirmed',
  'failed old step',
] as const)('retains external volume changes for %s', async (scenario) => {
  const { clock, engine, transport, observe, request } = setup();
  try {
    if (scenario === 'failed old step') {
      transport.mockResolvedValueOnce(new Response(null, { status: 500 }));
      await expect(request(0.35)).rejects.toThrow('Music command failed');
    } else {
      await request(0.35);
    }
    if (scenario === 'expired old step') clock.advanceBy(1_000);
    if (scenario === 'already confirmed') observe(0.35);
    await request(0.4);
    if (scenario === 'already confirmed') observe(0.4);
    const external = scenario === 'different value' ? 0.55 : 0.35;
    observe(external);
    expect(engine.getMusicState('music.room').requested.volume).toBeUndefined();
    expect(engine.getMusicVolumePolicySnapshots()['music.room']?.baseline).toBe(
      external,
    );
  } finally {
    engine.dispose();
  }
});
