import { expect, it } from 'vitest';
import { createWebFixture } from '../scripts/preview-web.mjs';

it('serves exact direct mutation snapshots and disabled defaults through a loopback-only fixture', async () => {
  const fixture = createWebFixture();
  await new Promise((resolve) =>
    fixture.server.listen(0, '127.0.0.1', resolve),
  );
  try {
    const address = fixture.server.address();
    expect(address.address).toBe('127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    const post = async (path, body) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Lugn-CSRF': 'fixture-csrf',
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const initial = await (await fetch(`${base}/ui/api/overview`)).json();
    expect(initial.routines.definitions.every((item) => !item.enabled)).toBe(
      true,
    );
    expect(initial.intelligence.settings.optical.enabled).toBe(false);
    expect(initial.intelligence.settings.suggestions.enabled).toBe(false);
    expect(
      (await post('/ui/api/routines/action', { id: 'night', action: 'start' }))
        .status,
    ).toBe(409);
    const saved = await post('/ui/api/routines/save', {
      definition: { ...initial.routines.definitions[0], enabled: true },
      expectedGeneration: 'r1',
    });
    expect(saved.body.definitions[0].enabled).toBe(true);
    const started = await post('/ui/api/routines/action', {
      id: 'night',
      action: 'start',
      requestId: 'fixture-start',
    });
    expect(started.body.runs[0].status).toBe('running');
    expect(started.body.runs[0].routineId).toBe('night');
    expect(started.body.runs[0].id).not.toBe('night');
    const cancelled = await post('/ui/api/routines/action', {
      id: started.body.runs[0].routineId,
      action: 'cancel',
      requestId: 'fixture-cancel',
    });
    expect(cancelled.body.runs[0].status).toBe('cancelled');
    expect(cancelled.body.runs.some((run) => run.status === 'running')).toBe(
      false,
    );
    const afterCancel = await (await fetch(`${base}/ui/api/overview`)).json();
    expect(afterCancel.routines.runs).toEqual(cancelled.body.runs);
    await post('/__fixture', {
      suggestions: [
        {
          id: 's1',
          kind: 'optical',
          title: 'Fixture',
          reason: 'Mock evidence',
        },
      ],
    });
    const responded = await post('/ui/api/intelligence/suggestion', {
      id: 's1',
      action: 'dismiss',
    });
    expect(responded.body.settings.optical.enabled).toBe(false);
    expect(responded.body.suggestions).toEqual([]);
    const forbidden = await post('/ui/api/invoke', {
      capability: 'music.play',
    });
    expect(forbidden.status).toBe(404);
    expect(
      fixture.snapshot().state.music.devices['music.room'].observed.playback,
    ).toBe('paused');
  } finally {
    await fixture.close();
  }
});
