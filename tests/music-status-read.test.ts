import { expect, it, vi } from 'vitest';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import { FakeClock } from '../src/core/clock.js';

const now = Date.parse('2026-10-04T12:00:00+02:00');
function setup() {
  const clock = new FakeClock(now);
  const state = {
    entity_id: 'media_player.room',
    state: 'playing',
    attributes: { volume_level: 0.4, source: 'Optical' },
    last_updated: new Date(now - 10_000).toISOString(),
    last_changed: new Date(now - 20_000).toISOString(),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(state));
  const adapter = new HomeAssistantMusicAdapter(
    {
      baseUrl: 'http://ha.test',
      token: 'test-token',
      entities: {
        'music.room': { entityId: state.entity_id, sources: ['Optical'] },
      },
    },
    fetcher,
    clock,
  );
  const listener = vi.fn();
  adapter.subscribe(listener);
  return { clock, state, fetcher, adapter, listener };
}

it('targets the mapped HA entity and returns a pure report without consuming ordinary feedback', async () => {
  const s = setup();
  const observation = await s.adapter.readStatus('music.room');
  expect(s.fetcher).toHaveBeenCalledWith(
    'http://ha.test/api/states/media_player.room',
    {
      method: 'GET',
      headers: {
        Authorization: 'Bearer test-token',
        Accept: 'application/json',
      },
      signal: expect.any(AbortSignal),
      redirect: 'error',
    },
  );
  expect(observation).toMatchObject({
    target: 'music.room',
    available: true,
    observedAt: now,
    sourceUpdatedAt: now - 10_000,
    values: { volume: 0.4, playback: 'playing' },
    provenance: { source: 'home_assistant.status_read' },
  });
  expect(observation.commandId).toBeUndefined();
  expect(s.listener).not.toHaveBeenCalled();
  expect(s.adapter.acceptState(s.state)).toBe(true);
  expect(s.listener).toHaveBeenCalledTimes(1);
});

it.each(['target', 'timestamp', 'future', 'stale', 'http', 'network'] as const)(
  'rejects %s verification and keeps subscription watermarks untouched',
  async (kind) => {
    const s = setup();
    s.adapter.acceptState(s.state);
    s.listener.mockClear();
    if (kind === 'http')
      s.fetcher.mockResolvedValue(Response.json({}, { status: 503 }));
    else if (kind === 'network')
      s.fetcher.mockRejectedValue(new Error('offline'));
    else
      s.fetcher.mockResolvedValue(
        Response.json({
          ...s.state,
          ...(kind === 'target' ? { entity_id: 'media_player.other' } : {}),
          last_updated:
            kind === 'timestamp'
              ? 'bad'
              : new Date(
                  kind === 'future'
                    ? now + 1
                    : kind === 'stale'
                      ? now - 10_001
                      : now - 10_000,
                ).toISOString(),
        }),
      );
    await expect(s.adapter.readStatus('music.room')).rejects.toThrow();
    expect(s.listener).not.toHaveBeenCalled();
    s.clock.advanceBy(1);
    s.adapter.acceptState({
      ...s.state,
      last_updated: new Date(now - 9_999).toISOString(),
    });
    expect(s.listener).toHaveBeenCalledTimes(1);
  },
);

it('does not send a read for an unmapped target and propagates caller cancellation', async () => {
  const s = setup();
  await expect(s.adapter.readStatus('music.other')).rejects.toThrow();
  expect(s.fetcher).not.toHaveBeenCalled();
  const controller = new AbortController();
  await s.adapter.readStatus('music.room', controller.signal);
  const signal = s.fetcher.mock.calls[0]![1]!.signal!;
  controller.abort();
  expect(signal.aborted).toBe(true);
});
