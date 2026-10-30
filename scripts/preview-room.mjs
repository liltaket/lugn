// Fully simulated integration preview. Never loads runtime configuration or connects
// to HA, MQTT, Cast, the desktop agent or any physical device.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatedLightingAdapter } from '../dist/adapters/simulated-lighting.js';
import { SimulatedMusicAdapter } from '../dist/adapters/simulated-music.js';
import { LugnEngine } from '../dist/application/lugn-engine.js';
import { CapabilityRegistry } from '../dist/application/capabilities.js';
import { RoutineService } from '../dist/application/routines.js';
import { systemClock } from '../dist/core/clock.js';
import { createRoutineTemplates } from '../dist/core/routines.js';
import { unknownComputerReadings } from '../dist/core/computer.js';
import { defaultMusicVolumeSettings } from '../dist/core/music-volume-settings.js';
import { RoutineStore } from '../dist/runtime/routine-store.js';
import { RoutineApi } from '../dist/runtime/routine-api.js';
import { IntelligenceSettingsStore } from '../dist/runtime/intelligence-settings-store.js';
import { IntelligenceApi } from '../dist/runtime/intelligence-api.js';
import { createComputerIntelligenceRuntime } from '../dist/runtime/computer-intelligence-runtime.js';
import { LugnHttpServer } from '../dist/runtime/http-server.js';
import { LugnDisplayServer } from '../dist/runtime/display-server.js';
import { ScenePresetStore } from '../dist/runtime/scene-preset-store.js';
import { MusicVolumeSettingsStore } from '../dist/runtime/music-volume-settings-store.js';

const port = Number(process.argv[2] ?? 4206);
if (!Number.isInteger(port) || port < 1024 || port > 65534)
  throw new Error('Choose an unprivileged local port below 65535');
const directory = await mkdtemp(join(tmpdir(), 'lugn-simulated-preview-'));
const lights = ['lighting.bed', 'lighting.desk', 'lighting.ceiling'];
const scenes = [
  {
    id: 'scene.cozy',
    name: 'Mysljus',
    lighting: {
      'lighting.bed': { power: true, brightness: 25 },
      'lighting.desk': { power: true, brightness: 30 },
      'lighting.ceiling': { power: false },
    },
  },
  {
    id: 'scene.focus',
    name: 'Fokus',
    lighting: {
      'lighting.bed': { power: false },
      'lighting.desk': { power: true, brightness: 80 },
      'lighting.ceiling': { power: true, brightness: 60 },
    },
  },
  {
    id: 'scene.everyday',
    name: 'Vardagsljus',
    lighting: Object.fromEntries(
      lights.map((id) => [id, { power: true, brightness: 60 }]),
    ),
  },
  {
    id: 'scene.movie',
    name: 'Filmkväll',
    lighting: {
      'lighting.bed': { power: true, brightness: 10 },
      'lighting.desk': { power: true, brightness: 15 },
      'lighting.ceiling': { power: false },
    },
  },
  {
    id: 'scene.all_off',
    name: 'Helt släckt',
    lighting: Object.fromEntries(lights.map((id) => [id, { power: false }])),
  },
];
const lighting = new SimulatedLightingAdapter(systemClock);
let engine;
class PreviewMusic extends SimulatedMusicAdapter {
  async dispatch(command) {
    await super.dispatch(command);
    queueMicrotask(() => {
      const previous = engine.getMusicState(command.target).observed;
      const next = { ...previous };
      if (command.requested.property === 'preset') {
        next.source =
          command.requested.value === 'optical' ? 'Optical In' : 'Spotify';
        next.playback = 'playing';
      } else next[command.requested.property] = command.requested.value;
      this.observe(command.target, next, true, command.id);
    });
  }
}
const music = new PreviewMusic(systemClock);
const presets = new ScenePresetStore({
  filePath: join(directory, 'scenes.json'),
  deviceIds: lights,
});
const configuredScenes = await presets.load(scenes);
engine = new LugnEngine(systemClock, {
  deviceIds: lights,
  scenes: configuredScenes,
  adapter: lighting,
  music: {
    adapter: music,
    targets: { 'music.room': ['Spotify', 'Optical In'] },
    observationTrusted: () => true,
  },
  musicVolumeSettings: { ...defaultMusicVolumeSettings, enabled: false },
});
const capabilities = new CapabilityRegistry(engine);
await engine.handleHomePresence('home');
await engine.handlePresence({
  type: 'presence.changed',
  presence: 'occupied',
  personCount: 1,
});
await engine.activateScene('scene.cozy', {
  type: 'user',
  id: 'simulated-preview',
});
music.observe('music.room', {
  playback: 'playing',
  volume: 0.25,
  source: 'Spotify',
  title: 'A quiet evening',
  artist: 'Simulated artist',
  album: 'Local preview',
});
const store = new RoutineStore(
  join(directory, 'routines.json'),
  createRoutineTemplates({ lightTargets: lights, musicTarget: 'music.room' }),
);
await store.load();
// Only in this temporary simulation: demonstrate an explicitly enabled manual routine.
const night = store.snapshot().definitions.find((d) => d.kind === 'good_night');
await store.save(
  {
    ...night,
    enabled: true,
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
  store.snapshot().generation,
);
const routines = new RoutineService(systemClock, {
  engine,
  capabilities,
  store,
  bedtime: {
    lightTargets: ['lighting.bed', 'lighting.desk'],
    musicTarget: 'music.room',
  },
});
const intelligenceStore = new IntelligenceSettingsStore(
  join(directory, 'intelligence.json'),
);
await intelligenceStore.load();
const computerContext = createComputerIntelligenceRuntime({
  clock: systemClock,
  engine,
  capabilities,
  settingsStore: intelligenceStore,
  computerDeviceIds: ['preview-desktop'],
  computerAudio: {
    'music.room': { deviceId: 'preview-desktop', source: 'Optical In' },
  },
  observationTrusted: () => true,
});
const experience = new IntelligenceApi(
  new RoutineApi(routines, store),
  computerContext.service,
);
let sequence = 0;
function computerHeartbeat() {
  engine.acceptComputerObservation({
    deviceId: 'preview-desktop',
    availability: 'online',
    freshness: 'fresh',
    reason: 'live',
    observedAt: Date.now(),
    receivedAt: Date.now(),
    sessionId: 'simulated-preview-session',
    sequence: sequence++,
    lastEvent: null,
    observed: {
      ...unknownComputerReadings(),
      networkOnline: true,
      locked: false,
      idle: false,
      activeApplication: { id: 'org.kde.kate', resourceClass: 'kate' },
      fullscreen: false,
      audio: { playing: false, applications: [], roles: [] },
      media: [],
    },
    activity: {
      classification: 'desktop',
      source: 'desktop-agent',
      basis: 'simulated active editor',
    },
  });
}
computerHeartbeat();
const heartbeat = setInterval(computerHeartbeat, 15000);
const volumeSettings = new MusicVolumeSettingsStore(
  join(directory, 'volume.json'),
);
await volumeSettings.load();
const http = new LugnHttpServer({
  host: '127.0.0.1',
  port,
  engine,
  capabilities,
  experience,
  scenePresetStore: presets,
  volumeSettingsStore: volumeSettings,
  integrations: () => ({
    home_assistant: 'not_configured',
    mqtt: 'not_configured',
  }),
  musicObservationTrustProvider: () => ({ 'music.room': true }),
});
const display = new LugnDisplayServer({
  host: '127.0.0.1',
  port: port + 1,
  hubs: [
    {
      id: 'bed',
      role: 'bed',
      castHost: '127.0.0.1',
      token: 'simulated-bed-token-00000000000000',
    },
    {
      id: 'desk',
      role: 'desk',
      castHost: '127.0.0.1',
      token: 'simulated-desk-token-0000000000000',
    },
  ],
  capabilities,
  experience,
  scenes: configuredScenes,
  scenesProvider: () => [...engine.scenes.values()],
  stateProvider: () => engine.state,
  stateStream: engine.stream,
  musicObservationTrustProvider: () => ({ 'music.room': true }),
  musicVolumePoliciesProvider: () => engine.getMusicVolumePolicySnapshots(),
  musicPlaybackPoliciesProvider: () => engine.getMusicPlaybackPolicySnapshots(),
  environmentProvider: () => ({
    temperature: { value: 21.4, unit: '°C', observedAt: Date.now() },
    humidity: { value: 43, unit: '%', observedAt: Date.now() },
    co2: { value: 612, unit: 'ppm', observedAt: Date.now() },
    pm25: { value: 2, unit: 'µg/m³', observedAt: Date.now() },
  }),
});
await http.start();
await display.start();
console.log(
  `SIMULATED ONLY. Web: http://127.0.0.1:${port}/ui/ (press Anslut; no token required)`,
);
console.log(`Bed: http://127.0.0.1:${port + 1}${display.pathForHub('bed')}`);
console.log(`Desk: http://127.0.0.1:${port + 1}${display.pathForHub('desk')}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  routines.dispose();
  computerContext.dispose();
  await display.stop();
  await http.stop();
  engine.dispose();
  await rm(directory, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => void stop().then(() => process.exit()));
