// Development fixture only: no config, adapters, network clients or runtime imports.
// Every accepted POST mutates in-memory sample data. Listen on loopback only.
import { createServer } from 'node:http';
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
    data.role = scenario === 'desk' ? 'desk' : 'bed';
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
      ].includes(scenario) &&
      path !== '/fixture-cover.svg'
    )
      return sendJson(response, 404, {});
    const route = parts.slice(1).join('/');
    if (route.startsWith('display-api/')) {
      if (offline)
        return sendJson(response, 503, { error: 'simulated_offline' });
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
        "default-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    response.end(content);
  } catch {
    sendJson(response, 400, { error: 'fixture_request_failed' });
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(
    `Simulated Hub only: http://127.0.0.1:${port}/bed/ (desk, morning, running, legacy, art-error, many)`,
  ),
);
