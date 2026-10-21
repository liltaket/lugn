/** Loopback-only, in-memory UI fixture. Imports no runtime, config, adapters or device clients. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { lightingFeedbackMatches } from '../src/core/lighting-feedback.ts';

export function webFixtureSnapshot() {
  const now = Date.UTC(2026, 9, 21, 20, 15);
  return {
    instanceId: 'web-fixture-only',
    deliveryRevision: 1,
    presetsEnabled: true,
    health: {
      status: 'ok',
      integrations: {
        home_assistant: 'not_configured',
        mqtt: 'not_configured',
      },
    },
    scenes: [
      {
        id: 'scene.cozy',
        name: 'Mysljus',
        canEdit: true,
        lighting: {
          'lighting.bed': { power: true, brightness: 25 },
          'lighting.desk': { power: false },
        },
      },
      {
        id: 'scene.focus',
        name: 'Arbetsljus',
        canEdit: true,
        lighting: { 'lighting.desk': { power: true, brightness: 70 } },
      },
      {
        id: 'scene.off',
        name: 'Släck rummet',
        canEdit: false,
        lighting: {
          'lighting.bed': { power: false },
          'lighting.desk': { power: false },
        },
      },
    ],
    state: {
      revision: 1,
      updatedAt: now,
      presence: { state: 'occupied', personCount: 1 },
      lighting: {
        currentScene: 'scene.cozy',
        devices: Object.fromEntries(
          ['bed', 'desk'].map((name) => [
            `lighting.${name}`,
            {
              availability: 'available',
              observed: { power: true, brightness: 25 },
              effectiveDesired: { power: true, brightness: 25 },
              ownership: {},
            },
          ]),
        ),
      },
      music: {
        devices: {
          'music.room': {
            availability: 'available',
            observedAt: now,
            observed: {
              playback: 'paused',
              title: 'Kväll i rummet',
              source: 'Optical',
              volume: 0.3,
            },
            allowedSources: ['Optical', 'Spotify'],
            requested: {},
          },
        },
        commands: [],
        fades: {},
      },
      computer: {
        devices: {
          'computer.desk': {
            availability: 'unavailable',
            freshness: 'stale',
            observed: {},
          },
        },
      },
    },
    routines: {
      version: 1,
      generation: 'r1',
      definitions: [
        {
          id: 'night',
          name: 'God natt',
          kind: 'good_night',
          enabled: false,
          schedule: { time: '22:30', weekdays: [1, 2, 3, 4, 5, 6, 7] },
          steps: [
            { type: 'scene', sceneId: 'scene.cozy' },
            {
              type: 'light',
              targets: ['lighting.bed', 'lighting.desk'],
              brightness: 0,
              durationMs: 600000,
            },
          ],
        },
      ],
      runs: [],
      next: [],
    },
    intelligence: {
      generation: 'i1',
      settings: {
        version: 1,
        optical: {
          enabled: false,
          mode: 'suggest',
          deviceId: 'computer.desk',
          target: 'music.room',
          source: 'Optical',
          stabilityMs: 30000,
          cooldownMs: 300000,
          allowedActivities: ['gaming', 'media'],
          respectManual: true,
        },
        suggestions: {
          enabled: false,
          cooldownMs: 600000,
          sceneMappings: { gaming: 'scene.focus' },
        },
      },
      suggestions: [],
      optical: [
        {
          deviceId: 'computer.desk',
          status: 'suppressed',
          reason: 'Optical är avstängt. Inga aktuella datorrapporter.',
          evidence: { fresh: false, audible: 'unknown' },
        },
      ],
    },
    artwork: { 'music.room': { status: 'missing', url: null, source: null } },
  };
}

export function createWebFixture() {
  let snapshot = webFixtureSnapshot();
  let revision = 1;
  const requests = [];
  const events = new Set();
  const sendEvents = () => {
    snapshot.deliveryRevision += 1;
    snapshot.state.revision += 1;
    for (const stream of events)
      stream.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (value, status = 200) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && url.pathname === '/ui/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      });
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      events.add(res);
      req.on('close', () => events.delete(res));
      return;
    }
    if (req.method === 'GET') {
      const data = {
        '/ui/api/auth-config': { provider: 'token' },
        '/ui/api/session': {
          authenticated: true,
          tokenRequired: false,
          csrfToken: 'fixture-csrf',
        },
        '/ui/api/overview': snapshot,
        '/ui/api/routines': snapshot.routines,
      }[url.pathname];
      if (data) return json(data);
      const asset = {
        '/': 'index.html',
        '/ui/': 'index.html',
        '/ui/index.html': 'index.html',
        '/ui/styles.css': 'styles.css',
        '/ui/app.js': 'app.js',
      }[url.pathname];
      if (asset) {
        res.writeHead(200, {
          'content-type': asset.endsWith('.css')
            ? 'text/css'
            : asset.endsWith('.js')
              ? 'text/javascript'
              : 'text/html',
          'cache-control': 'no-store',
        });
        const content = await readFile(
          new URL(`../web/${asset}`, import.meta.url),
          'utf8',
        );
        res.end(
          asset === 'app.js'
            ? `const lightingFeedbackMatches = ${lightingFeedbackMatches.toString()};\n${content}`
            : content,
        );
        return;
      }
      return json({ error: 'fixture_route_missing' }, 404);
    }
    if (req.method !== 'POST') return json({ error: 'fixture_method' }, 405);
    if (req.headers['x-lugn-csrf'] !== 'fixture-csrf')
      return json({ error: 'csrf_failed' }, 403);
    let body;
    try {
      let text = '';
      for await (const part of req) {
        text += part;
        if (text.length > 100000) throw new Error('size');
      }
      body = JSON.parse(text || '{}');
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    requests.push({ path: url.pathname, body });
    // Test-only mutation stays in memory and broadcasts through the real UI SSE path.
    if (url.pathname === '/__fixture') {
      if (body.snapshot) snapshot = body.snapshot;
      if (body.suggestions)
        snapshot.intelligence.suggestions = body.suggestions;
      if (body.runs) snapshot.routines.runs = body.runs;
      if (body.staged) {
        delete snapshot.routines;
        delete snapshot.intelligence;
      }
      sendEvents();
      return json({ ok: true });
    }
    if (url.pathname === '/ui/api/routines/preview') {
      let atMs = 0;
      const timeline = body.definition.steps.map((step) => {
        const entry = {
          atMs,
          label: {
            scene: 'Välj ljusscen',
            light: 'Dimma lampor',
            volume: 'Ändra volym',
            delay: 'Vänta',
            playback: 'Ändra uppspelning',
            source: 'Välj källa',
            preset: 'Välj musikpreset',
            condition: 'Pröva villkor',
          }[step.type],
        };
        atMs += step.durationMs ?? 0;
        return entry;
      });
      return json({
        timeline,
        durationMs: atMs,
        warnings: body.definition.enabled ? [] : ['Rutinen är avstängd.'],
      });
    }
    if (
      url.pathname === '/ui/api/routines/save' ||
      url.pathname === '/ui/api/routines/delete'
    ) {
      if (body.expectedGeneration !== snapshot.routines.generation)
        return json({ error: 'generation_conflict' }, 409);
      if (body.definition)
        snapshot.routines.definitions = [
          ...snapshot.routines.definitions.filter(
            (item) => item.id !== body.definition.id,
          ),
          body.definition,
        ];
      else
        snapshot.routines.definitions = snapshot.routines.definitions.filter(
          (item) => item.id !== body.id,
        );
      snapshot.routines.generation = `r${++revision}`;
      snapshot.routines.next = snapshot.routines.definitions
        .filter((item) => item.enabled && item.schedule)
        .map((item) => ({
          routineId: item.id,
          at: Date.UTC(2026, 9, 21, 20, 30),
        }));
      sendEvents();
      return json(snapshot.routines);
    }
    if (url.pathname === '/ui/api/routines/action') {
      if (body.action === 'start') {
        const definition = snapshot.routines.definitions.find(
          (item) => item.id === body.id,
        );
        if (!definition?.enabled) return json({ error: 'disabled' }, 409);
        snapshot.routines.runs.push({
          id: `run-${++revision}`,
          routineId: body.id,
          status: 'running',
          stepIndex: 0,
          startedAt: 0,
          updatedAt: 0,
          reason: null,
        });
      } else if (body.action === 'cancel') {
        for (const run of snapshot.routines.runs)
          if (run.routineId === body.id && run.status === 'running')
            run.status = 'cancelled';
      } else if (body.action === 'skip')
        snapshot.routines.next = snapshot.routines.next.filter(
          (item) => item.routineId !== body.id,
        );
      sendEvents();
      return json(snapshot.routines);
    }
    if (url.pathname === '/ui/api/intelligence/settings') {
      if (body.expectedGeneration !== snapshot.intelligence.generation)
        return json({ error: 'generation_conflict' }, 409);
      snapshot.intelligence.settings = body.settings;
      snapshot.intelligence.generation = `i${++revision}`;
      sendEvents();
      return json(snapshot.intelligence);
    }
    if (url.pathname === '/ui/api/intelligence/suggestion') {
      snapshot.intelligence.suggestions =
        snapshot.intelligence.suggestions.filter((item) => item.id !== body.id);
      sendEvents();
      return json(snapshot.intelligence);
    }
    // No capability/device routes: the fixture cannot forward or issue commands.
    return json(
      {
        error: 'fixture_route_missing',
        message: 'Den här kontrollen simuleras inte i webbfixturen.',
      },
      404,
    );
  });
  return {
    server,
    requests,
    snapshot: () => structuredClone(snapshot),
    close: async () => {
      for (const stream of events) stream.end();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = createWebFixture();
  fixture.server.listen(Number(process.argv[2] ?? 8799), '127.0.0.1', () =>
    console.log(
      `Simulated web UI only: http://127.0.0.1:${fixture.server.address().port}/ui/`,
    ),
  );
}
