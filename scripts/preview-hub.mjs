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
const probeReports = [];
let offline = false;
const clients = new Set();
const port = Number(process.argv[2] ?? 4178);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid preview port');

function gridCameras(count) {
  const all = [
    ['entrance', 'Entré', '#3d4a45'],
    ['front', 'Framsida', '#4a4438'],
    ['north', 'Norr', '#39485a'],
    ['south', 'Syd', '#4d3f4f'],
    ['back', 'Baksida', '#3f4f3c'],
    ['garage', 'Garage', '#55473a'],
    ['garden', 'Trädgård', '#3a4f4a'],
    ['shed', 'Förråd', '#4a3a3a'],
  ];
  return all
    .slice(0, Math.max(0, Math.min(8, count)))
    .map(([id, name, color]) => ({ id, name, color }));
}

// `POST /__fixture/next-track` starts a second track in the `lyrics`
// scenario, told the way a real one arrives: the player knows at once, its
// cover a moment later, and the dashboard last.
let nextTrackAt = 0;
let nextTrackLines = true;
let tracksStarted = 0;
const nextTrack = { title: 'Andra stranden', artist: 'Astrid Holm' };

const previewLines = [
  'Fönstret står på glänt mot den svala kvällen',
  'Quiet steps along the wooden pier',
  'Ljusen över vattnet drar sig sakta inåt land',
  'We left the harbor lights behind the mist',
  'Stanna kvar en stund tills vinden vänder hem',
  'Holding every echo in the salt and cedar air',
  'Skuggorna blir mjuka över bryggans gråa plank',
  '',
  'And even when the tide pulls out beyond the dark horizon, we keep a lantern burning on the southern stone wall for anyone still drifting home',
  'Ingen brådska nu när natten ligger stilla',
  'Every distant bell rings softer from the shore',
].map((text, index) => ({ at: 6 + index * 9, text }));

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
      name: 'Bertil',
      status: 'printing',
      stage: 'printing',
      progress: 45,
      remainingMinutes: 29,
      endsAt: data.generatedAt + 29 * 60000,
      layer: 22,
      totalLayers: 144,
      task: 'Stand + Box + 3 till',
      nozzle: { current: 220, target: 220 },
      bed: { current: 60, target: 60 },
      statusSince: data.generatedAt - 40 * 60000,
      observedAt: data.generatedAt,
      imageUrl: `/${scenario}/display-api/printer/cover/fixture`,
      light: false,
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
    if (scenario === 'print-long')
      data.printer = printing({
        task: 'Articulated Dragon Full… + 6 till',
        light: true,
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
    // `cameras` (five) or `cameras-N`: a Hub with several cameras and the
    // small camera view open on Hem, for the camera grid page.
    const gridCount = /^cameras(?:-(\d))?$/.exec(scenario);
    if (gridCount) {
      const cameras = gridCameras(Number(gridCount[1] ?? 5));
      data.cameraDashboard = {
        generation: 'fixture',
        settings: {
          enabled: true,
          automaticEnabled: true,
          durationSeconds: 30,
          cameras: Object.fromEntries(cameras.map((c) => [c.id, true])),
          triggers: {},
          viewers: ['bed', 'desk', 'web'],
        },
        definitions: cameras.map((c) => ({
          id: c.id,
          name: c.name,
          enabled: true,
          available: true,
        })),
        triggers: [],
        active: cameras[0]
          ? {
              id: 'fixture-view',
              cameraId: cameras[0].id,
              name: cameras[0].name,
              reason: 'Person vid entrén',
              expiresAt: data.generatedAt + 3600000,
              manual: false,
              imageUrl: `/${scenario}/display-api/cameras/fixture-view/${cameras[0].id}/image`,
            }
          : null,
      };
    }
    if (scenario === 'many')
      data.scenes.push(
        ...Array.from({ length: 7 }, (_, index) => ({
          id: `scene.custom${index}`,
          name: `Eget ljusläge ${index + 1}`,
        })),
      );
    // `seek`: the player's own track with a position. `optical`: a computer's
    // media behind the optical input. Both take steps and seeks.
    if (['seek', 'optical', 'lyrics'].includes(scenario)) {
      const at = { positionSeconds: 42, positionUpdatedAt: data.generatedAt };
      const observed = data.state.music.devices['music.room'].observed;
      data.musicTrackControl = { 'music.room': scenario !== 'optical' };
      if (scenario !== 'optical')
        Object.assign(observed, at, { durationSeconds: 215 });
      else {
        observed.source = 'Optical In';
        data.state.music.computerPlayback = {
          'music.room': {
            active: true,
            deviceId: 'desktop',
            playback: 'playing',
            canPause: true,
            canResume: false,
            canNext: true,
            canPrevious: true,
            canSeek: true,
            pending: false,
            lastCommand: null,
          },
        };
        data.computerNowPlaying = {
          'music.room': {
            status: 'playing',
            reason: 'single_playing',
            deviceId: 'desktop',
            title: 'En lång video',
            artist: 'En kanal',
            application: 'Firefox',
            durationSeconds: 600,
            ...at,
          },
        };
      }
    }
    scenarios.set(scenario, data);
  }
  const data = structuredClone(scenarios.get(scenario));
  data.generatedAt += Date.now() - startedAt;
  if (scenario === 'lyrics' && nextTrackAt) {
    const since = Date.now() - nextTrackAt;
    // The server's own word on the track, ahead of the dashboard's.
    data.nowPlaying = {
      'music.room': {
        ...nextTrack,
        ...(since >= 300 ? { art: '/fixture-cover-2.svg' } : {}),
      },
    };
    if (since > 900) {
      const observed = data.state.music.devices['music.room'].observed;
      Object.assign(observed, nextTrack, {
        positionSeconds: 0,
        positionUpdatedAt: data.generatedAt - since,
      });
      data.artwork['music.room'] =
        since > 2_200
          ? { ...data.artwork['music.room'], url: '/fixture-cover-2.svg' }
          : { url: null, status: 'unavailable', source: 'home_assistant' };
    }
  }
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
    if (path === '/__fixture/next-track' && request.method === 'POST') {
      nextTrackAt = Date.now();
      // `?lines=none`: the next track has nothing to follow.
      nextTrackLines =
        new URL(request.url, 'http://x').searchParams.get('lines') !== 'none';
      tracksStarted += 1;
      Object.assign(nextTrack, {
        title: `Andra stranden ${tracksStarted}`.replace(' 1', ''),
      });
      // Pushed to the open pages, as the track is seen and as its cover is in.
      const push = () => {
        for (const client of clients)
          client.write(`data: ${JSON.stringify(snapshot('lyrics'))}\n\n`);
      };
      push();
      setTimeout(push, 310);
      return sendJson(response, 200, { nextTrackAt });
    }
    if (
      /^\/lyrics\/display-api\/playhead\/music\.room(\/lyrics)?$/.test(path)
    ) {
      const data = snapshot('lyrics');
      const observed = data.state.music.devices['music.room'].observed;
      const since = Date.now() - nextTrackAt;
      // On the preview's own clock, which is the fixture's.
      return sendJson(response, 200, {
        source: 'player',
        playing: true,
        position: nextTrackAt
          ? since / 1000
          : observed.positionSeconds +
            (data.generatedAt - observed.positionUpdatedAt) / 1000,
        duration: observed.durationSeconds,
        track: nextTrackAt
          ? nextTrack
          : { title: observed.title, artist: observed.artist },
        ...(!nextTrackAt
          ? { art: '/fixture-cover.svg' }
          : since > 300
            ? { art: '/fixture-cover-2.svg' }
            : {}),
      });
    }
    // Invented lines for the `lyrics` scenario (and none elsewhere).
    if (/^\/[a-z-]+\/display-api\/lyrics\/music\.room$/.test(path)) {
      if (path.startsWith('/lyrics/') && nextTrackAt)
        await new Promise((resolve) => setTimeout(resolve, 250));
      return sendJson(
        response,
        200,
        !path.startsWith('/lyrics/') || (nextTrackAt && !nextTrackLines)
          ? { status: 'none' }
          : {
              status: 'synced',
              lines: nextTrackAt
                ? previewLines.map((line, index) => ({
                    at: 1 + index * 4,
                    text: previewLines.at(-1 - index).text,
                  }))
                : previewLines,
            },
      );
    }
    if (path === '/__fixture/actions') return sendJson(response, 200, actions);
    if (path === '/__fixture/probe')
      return sendJson(response, 200, probeReports);
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
        'print-long',
        'camera',
        'camera-print',
        'camera-print-solo',
        'print-desk',
        'camera-print-desk',
        'seek',
        'optical',
        'lyrics',
      ].includes(scenario) &&
      !/^cameras(-\d)?$/.test(scenario) &&
      !/^\/fixture-cover(-2)?\.svg$/.test(path)
    )
      return sendJson(response, 404, {});
    const route = parts.slice(1).join('/');
    if (route.startsWith('display-api/')) {
      if (offline)
        return sendJson(response, 503, { error: 'simulated_offline' });
      // The camera grid: one picture per camera, drawn fresh each time (the
      // time in it shows that it updates). `?slow=ms` simulates a slow camera.
      const gridImage = /^display-api\/camera-grid\/([a-z0-9-]+)\/image$/.exec(
        route,
      );
      if (gridImage) {
        const camera = gridCameras(8).find((c) => c.id === gridImage[1]);
        if (!camera) return sendJson(response, 404, {});
        const slow = Number(
          new URL(request.url, 'http://x').searchParams.get('slow') ?? 0,
        );
        if (slow) await new Promise((r) => setTimeout(r, slow));
        const time = new Date().toISOString().slice(11, 19);
        response.writeHead(200, {
          'content-type': 'image/svg+xml',
          'cache-control': 'no-store',
        });
        return response.end(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="${camera.color}"/><rect y="250" width="640" height="110" fill="rgba(0,0,0,0.25)"/><circle cx="${100 + ((Date.now() / 40) % 440)}" cy="190" r="22" fill="#e7e1cf"/><text x="24" y="52" font-size="34" fill="#fff" font-family="sans-serif">${camera.name}</text><text x="24" y="340" font-size="30" fill="#fff" font-family="sans-serif">${time}</text></svg>`,
        );
      }
      const fixtureImage =
        route === 'display-api/printer/cover/fixture'
          ? (process.env.LUGN_PREVIEW_PRINT_COVER ??
            new URL('tests/fixtures/hub/print-cover.svg', root))
          : route.startsWith('display-api/cameras/fixture-view/')
            ? new URL('tests/fixtures/hub/camera.svg', root)
            : null;
      // A cached album copy (the server's photo-frame directory), if given.
      if (process.env.LUGN_PREVIEW_PHOTOS) {
        const dir = process.env.LUGN_PREVIEW_PHOTOS;
        if (route === 'display-api/photos') {
          const index = JSON.parse(await readFile(`${dir}/index.json`, 'utf8'));
          // A listing saved from the server (with neighbours, trips, people)
          // replaces the bare index, to see groups and their names.
          const listing = process.env.LUGN_PREVIEW_LISTING
            ? JSON.parse(
                await readFile(process.env.LUGN_PREVIEW_LISTING, 'utf8'),
              )
            : null;
          return sendJson(
            response,
            200,
            listing ?? {
              revision: 'preview',
              photos: index.photos.map((photo) => ({
                ...photo,
                source: undefined,
              })),
            },
          );
        }
        const photo =
          /^display-api\/photos\/([A-Za-z0-9_-]{24})(\/backdrop)?$/.exec(route);
        if (photo) {
          const body = await readFile(
            `${dir}/${photo[1]}${photo[2] ? '.bg' : ''}.jpg`,
          );
          response.writeHead(200, {
            'content-type': 'image/jpeg',
            'cache-control': 'no-store',
          });
          return response.end(body);
        }
      }
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
      if (route === 'display-api/pointer-bridge')
        return sendJson(response, 404, {
          error: 'pointer_bridge_not_configured',
        });
      if (request.method !== 'POST') return sendJson(response, 405, {});
      if (route === 'display-api/probe') {
        let text = '';
        for await (const chunk of request) text += chunk;
        probeReports.push(JSON.parse(text || '{}'));
        return sendJson(response, 202, { accepted: true });
      }
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 8192) return sendJson(response, 413, {});
      }
      const body = JSON.parse(raw || '{}');
      actions.push({ scenario, route, body });
      if (route === 'display-api/camera' && body.action === 'grid') {
        const count = Number(/^cameras-(\d)$/.exec(scenario)?.[1] ?? 5);
        return sendJson(response, 200, {
          cameraGrid: {
            expiresAt: Date.now() + 45000,
            cameras: gridCameras(count).map((c) => ({
              id: c.id,
              name: c.name,
              imageUrl: `/${scenario}/display-api/camera-grid/${c.id}/image`,
            })),
          },
        });
      }
      if (route === 'display-api/camera' && body.action === 'grid-close')
        return sendJson(response, 200, { ok: true });
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
      } else if (route === 'display-api/music') {
        const media =
          data.computerNowPlaying?.['music.room'] ?? player.observed;
        const { property, value } = body.request;
        if (property === 'seek' || property === 'track')
          Object.assign(media, {
            positionSeconds: property === 'seek' ? value : 0,
            positionUpdatedAt: data.generatedAt + Date.now() - startedAt,
            ...(property === 'track'
              ? { title: value === 'next' ? 'Nästa spår' : 'Förra spåret' }
              : {}),
          });
        else player.observed[property] = value;
      } else if (route === 'display-api/music-preset')
        player.observed.source = body.presetId === 4 ? 'Optical In' : 'Spotify';
      else if (route === 'display-api/volume-authority') {
        const policy = data.musicVolumePolicies['music.room'];
        policy.mode = body.mode;
        policy.activeOwner = body.mode === 'auto' ? 'lugn' : 'manual';
      } else if (route === 'display-api/printer/light') {
        if (!data.printer) return sendJson(response, 404, {});
        setTimeout(() => {
          data.printer.light = body.on === true;
          data.state.revision++;
        }, 900);
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
    const name = /^\/fixture-cover(-2)?\.svg$/.test(path)
      ? 'tests/fixtures/hub/cover.svg'
      : !route
        ? 'src/ui/display.html'
        : [
              'display.css',
              'display.js',
              'pointer-bridge.js',
              'pages.css',
              'pages.js',
              'page-views.js',
              'cameras-page.css',
              'cameras-page.js',
              'lyrics-view.css',
              'lyrics-view.js',
              'quick-menu.css',
              'quick-menu.js',
              'photos-page.css',
              'photos-page.js',
              'hub-history.js',
              'hub-probe.js',
            ].includes(route)
          ? `src/ui/${route}`
          : null;
    if (!name) return sendJson(response, 404, {});
    let content = await readFile(new URL(name, root), 'utf8');
    // The second cover: the same drawing with red and blue swapped.
    if (path === '/fixture-cover-2.svg')
      content = content.replace(
        /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/gi,
        '#$3$2$1',
      );
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
    `Simulated Hub only: http://127.0.0.1:${port}/bed/ (desk, morning, running, legacy, art-error, many, print, print-solo, print-paused, print-prep, print-done, print-long, camera, camera-print, camera-print-solo, seek, optical, lyrics)`,
  ),
);
