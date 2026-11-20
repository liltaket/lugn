// Development fixture only: no config, adapters, network clients or runtime imports.
// Every accepted POST mutates in-memory sample data. Listen on loopback only.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tomorrowStockholm } from '../dist/core/routines.js';
import { readFile } from 'node:fs/promises';
import { lightingFeedbackMatches } from '../dist/core/lighting-feedback.js';

const root = new URL('../', import.meta.url);
const fixture = JSON.parse(
  await readFile(new URL('tests/fixtures/hub/state.json', root), 'utf8'),
);
const startedAt = Date.now();
const scenarios = new Map();
const actions = [];
let offline = false;
const clients = new Set();
const port = Number(process.argv[2] ?? 4178);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid preview port');

function snapshot(scenario) {
  if (!scenarios.has(scenario)) {
    const data = structuredClone(fixture);
    data.role =
      scenario === 'desk' || scenario.endsWith('-desk') ? 'desk' : 'bed';
    data.scenes.push({ id: 'scene.party', name: 'Party' });
    data.routines.bedtime = {
      nightRoutineId: 'bedtime-night',
      morningRoutineId: 'bedtime-morning',
      nightAvailable: true,
      morningAvailable: true,
      musicAvailable: true,
      plan: null,
      ready: null,
      skippedTargets: [],
    };
    data.routines.definitions.push(
      {
        id: 'bedtime-night',
        name: 'God natt',
        kind: 'good_night',
        enabled: true,
        schedule: null,
        steps: [{ type: 'delay', durationMs: 900000 }],
      },
      {
        id: 'bedtime-morning',
        name: 'God morgon',
        kind: 'good_morning',
        enabled: true,
        schedule: null,
        steps: [{ type: 'delay', durationMs: 1200000 }],
      },
    );
    if (scenario === 'legacy') {
      delete data.routines;
      delete data.intelligence;
      delete data.artwork;
    }
    if (scenario === 'morning') {
      data.generatedAt += 9 * 3600000;
      data.routines.definitions[0].enabled = false;
    }
    if (scenario === 'running')
      data.routines.runs.push({
        id: 'fixture-run',
        routineId: 'night',
        status: 'running',
        stepIndex: 1,
        startedAt: data.generatedAt,
        updatedAt: data.generatedAt,
        reason: null,
      });
    if (scenario === 'art-error')
      data.artwork['music.room'].url = '/missing-art.svg';
    const printing = (overrides = {}) => ({
      name: 'A1',
      status: 'printing',
      stage: 'printing',
      progress: 45,
      remainingMinutes: 29,
      endsAt: data.generatedAt + 29 * 60000,
      layer: 22,
      totalLayers: 144,
      task: 'Stand + Box + Lid + Screw + Cable Mount',
      nozzle: { current: 220, target: 220 },
      bed: { current: 60, target: 60 },
      statusSince: data.generatedAt - 40 * 60000,
      observedAt: data.generatedAt,
      imageUrl: `/${scenario}/display-api/printer/cover/fixture`,
      ...overrides,
    });
    if (scenario.startsWith('print') || scenario.startsWith('camera'))
      data.printer = printing();
    if (scenario === 'print-solo' || scenario === 'camera-print-solo')
      data.state.music.devices['music.room'].observed.playback = 'paused';
    if (scenario === 'print-paused')
      data.printer = printing({
        status: 'paused',
        stage: 'paused_filament_runout',
        progress: 71,
        remainingMinutes: 12,
      });
    if (scenario === 'print-prep')
      data.printer = printing({
        status: 'preparing',
        stage: 'heatbed_preheating',
        progress: 0,
        layer: 0,
        nozzle: { current: 141, target: 220 },
        bed: { current: 38, target: 60 },
        task: 'Vase',
      });
    if (scenario === 'print-done')
      data.printer = printing({
        status: 'finished',
        stage: 'idle',
        progress: 100,
        remainingMinutes: 0,
        endsAt: null,
        layer: 144,
        statusSince: data.generatedAt - 4 * 60000,
      });
    if (scenario.startsWith('camera'))
      data.cameraDashboard = {
        generation: 'fixture',
        settings: {
          enabled: true,
          automaticEnabled: true,
          durationSeconds: 30,
          cameras: { entrance: true },
          triggers: {},
          viewers: ['bed', 'desk', 'web'],
        },
        definitions: [
          { id: 'entrance', name: 'Entré', enabled: true, available: true },
        ],
        triggers: [],
        active: {
          id: 'fixture-view',
          cameraId: 'entrance',
          name: 'Entré',
          reason: 'Person vid entrén',
          expiresAt: data.generatedAt + 3600000,
          manual: false,
          imageUrl: `/${scenario}/display-api/cameras/fixture-view/entrance/image`,
        },
      };
    if (scenario === 'camera') delete data.printer;
    if (scenario === 'many')
      data.scenes.push(
        ...Array.from({ length: 7 }, (_, index) => ({
          id: `scene.custom${index}`,
          name: `Eget ljusläge ${index + 1}`,
        })),
      );
    scenarios.set(scenario, data);
  }
  const data = structuredClone(scenarios.get(scenario));
  data.generatedAt += Date.now() - startedAt;
  for (const reading of Object.values(data.environment))
    reading.observedAt = Date.now();
  return data;
}

function sendJson(response, code, value) {
  response.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  try {
    const allowedHost = `127.0.0.1:${port}`;
    if (
      request.headers.host !== allowedHost &&
      request.headers.host !== `localhost:${port}`
    )
      return sendJson(response, 403, { error: 'loopback_only' });
    if (
      request.headers.origin &&
      ![`http://${allowedHost}`, `http://localhost:${port}`].includes(
        request.headers.origin,
      )
    )
      return sendJson(response, 403, { error: 'origin' });
    const path = new URL(request.url, `http://${allowedHost}`).pathname;
    if (path === '/__fixture/actions') return sendJson(response, 200, actions);
    if (path === '/__fixture/offline' && request.method === 'POST') {
      offline = !offline;
      if (offline) for (const client of clients) client.end();
      return sendJson(response, 200, { offline });
    }
    const parts = path.split('/').filter(Boolean);
    const scenario = parts[0] ?? 'bed';
    if (
      ![
        'bed',
        'desk',
        'legacy',
        'morning',
        'running',
        'art-error',
        'many',
        'print',
        'print-solo',
        'print-paused',
        'print-prep',
        'print-done',
        'camera',
        'camera-print',
        'camera-print-solo',
        'print-desk',
        'camera-print-desk',
      ].includes(scenario) &&
      path !== '/fixture-cover.svg'
    )
      return sendJson(response, 404, {});
    const route = parts.slice(1).join('/');
    if (route.startsWith('display-api/')) {
      if (offline)
        return sendJson(response, 503, { error: 'simulated_offline' });
      const fixtureImage =
        route === 'display-api/printer/cover/fixture'
          ? (process.env.LUGN_PREVIEW_PRINT_COVER ??
            new URL('tests/fixtures/hub/print-cover.svg', root))
          : route.startsWith('display-api/cameras/fixture-view/')
            ? new URL('tests/fixtures/hub/camera.svg', root)
            : null;
      if (fixtureImage) {
        const body = await readFile(fixtureImage);
        response.writeHead(200, {
          'content-type': String(fixtureImage).endsWith('.png')
            ? 'image/png'
            : 'image/svg+xml',
          'cache-control': 'no-store',
        });
        return response.end(body);
      }
      if (route === 'display-api/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
        });
        const tick = () =>
          response.write(`data: ${JSON.stringify(snapshot(scenario))}\n\n`);
        tick();
        const timer = setInterval(tick, 2000);
        clients.add(response);
        response.on('close', () => {
          clearInterval(timer);
          clients.delete(response);
        });
        return;
      }
      if (route === 'display-api/state')
        return sendJson(response, 200, snapshot(scenario));
      if (request.method !== 'POST') return sendJson(response, 405, {});
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 8192) return sendJson(response, 413, {});
      }
      const body = JSON.parse(raw || '{}');
      actions.push({ scenario, route, body });
      const data =
        scenarios.get(scenario) ??
        (snapshot(scenario), scenarios.get(scenario));
      const player = data.state.music.devices['music.room'];
      if (route === 'display-api/bedtime') {
        if (body.expectedGeneration !== data.routines.generation)
          return sendJson(response, 409, { error: 'routines_changed' });
        if (['start', 'plan'].includes(body.action)) {
          data.routines.bedtime.plan =
            body.mode === 'none'
              ? null
              : {
                  at: tomorrowStockholm(
                    body.wakeTime,
                    snapshot(scenario).generatedAt,
                  ),
                  time: body.wakeTime,
                  mode: body.mode,
                  music: body.music === true,
                };
        } else if (body.action === 'clear') data.routines.bedtime.plan = null;
        if (['start', 'morning'].includes(body.action))
          data.routines.runs = [
            {
              id: randomUUID(),
              routineId:
                body.action === 'start' ? 'bedtime-night' : 'bedtime-morning',
              status: 'running',
              stepIndex: 0,
              startedAt: data.generatedAt,
              updatedAt: data.generatedAt,
              reason: null,
            },
          ];
        data.routines.generation = randomUUID();
        return sendJson(response, 200, data.routines);
      }
      if (route === 'display-api/routine') {
        const definition = data.routines?.definitions.find(
          (item) => item.id === body.id,
        );
        if (!definition) return sendJson(response, 404, {});
        if (body.action === 'start') {
          if (!definition.enabled) return sendJson(response, 409, {});
          data.routines.runs = [
            {
              id: 'fixture-run',
              routineId: body.id,
              status: 'running',
              stepIndex: 0,
              startedAt: data.generatedAt,
              updatedAt: data.generatedAt,
              reason: null,
            },
          ];
        } else if (body.action === 'cancel') {
          for (const run of data.routines.runs)
            if (run.routineId === body.id) run.status = 'cancelled';
        } else if (body.action === 'skip')
          data.routines.next = data.routines.next.filter(
            (item) => item.routineId !== body.id,
          );
        else if (body.action === 'snooze')
          for (const next of data.routines.next)
            if (next.routineId === body.id) next.at += body.minutes * 60000;
      } else if (route === 'display-api/suggestion') {
        const suggestion = data.intelligence.suggestions.find(
          (item) => item.id === body.id,
        );
        if (suggestion && body.action === 'accept')
          data.state.lighting.currentScene = suggestion.sceneId;
        data.intelligence.suggestions = data.intelligence.suggestions.filter(
          (item) => item.id !== body.id,
        );
      } else if (route === 'display-api/scene') {
        data.state.lighting.currentScene = body.sceneId;
        for (const run of data.routines?.runs ?? [])
          if (run.status === 'running') run.status = 'cancelled';
      } else if (route === 'display-api/music')
        player.observed[body.request.property] = body.request.value;
      else if (route === 'display-api/music-preset')
        player.observed.source = body.presetId === 4 ? 'Optical In' : 'Spotify';
      else if (route === 'display-api/volume-authority') {
        const policy = data.musicVolumePolicies['music.room'];
        policy.mode = body.mode;
        policy.activeOwner = body.mode === 'auto' ? 'lugn' : 'manual';
      } else if (route === 'display-api/presence-count-one')
        data.state.presence.personCount = 1;
      else return sendJson(response, 404, {});
      data.state.revision++;
      data.deliveryRevision++;
      return sendJson(
        response,
        200,
        route === 'display-api/routine'
          ? data.routines
          : { accepted: true, simulated: true },
      );
    }
    const name =
      path === '/fixture-cover.svg'
        ? 'tests/fixtures/hub/cover.svg'
        : !route
          ? 'src/ui/display.html'
          : ['display.css', 'display.js'].includes(route)
            ? `src/ui/${route}`
            : null;
    if (!name) return sendJson(response, 404, {});
    let content = await readFile(new URL(name, root), 'utf8');
    if (route === 'display.js')
      content = `const lightingFeedbackMatches = ${lightingFeedbackMatches.toString()};\n${content}`;
    const type = name.endsWith('.svg')
      ? 'image/svg+xml'
      : name.endsWith('.js')
        ? 'text/javascript'
        : name.endsWith('.css')
          ? 'text/css'
          : 'text/html';
    response.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    response.end(content);
  } catch {
    sendJson(response, 400, { error: 'fixture_request_failed' });
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(
    `Simulated Hub only: http://127.0.0.1:${port}/bed/ (desk, morning, running, legacy, art-error, many, print, print-solo, print-paused, print-prep, print-done, camera, camera-print, camera-print-solo)`,
  ),
);
