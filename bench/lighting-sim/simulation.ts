import { HomeAssistantLightingAdapter } from '../../src/adapters/home-assistant-lighting.js';
import { HomeAssistantWebSocketTransport } from '../../src/adapters/home-assistant-websocket.js';
import { PresenceEventIngress } from '../../src/adapters/presence-event-ingress.js';
import { Stl27lMqttPresenceAdapter } from '../../src/adapters/stl27l-mqtt-presence.js';
import { withRoomPresets } from '../../src/application/dashboard-scenes.js';
import { LugnEngine } from '../../src/application/lugn-engine.js';
import type { FastPathTiming, LightingScene } from '../../src/core/schemas.js';
import { latencyProfiles, type LatencyProfile } from './latency-profiles.js';
import { MockHomeAssistant } from './mock-home-assistant.js';
import { SimMqttBroker } from './mqtt-broker.js';
import { keyedLatency } from './random.js';
import { SimClock } from './sim-clock.js';
import type { Workload, WorkloadStep } from './workloads.js';

/** Live entity mapping (BrunoCAM config, read 2026-11-09; no secrets). */
export const liveEntities: Record<string, string> = {
  'lighting.cleverio_bar': 'light.cleverio_lb100',
  'lighting.govee_table': 'light.h6022',
  'lighting.govee_ceiling': 'light.h60a6_2',
  'lighting.govee_strip_1': 'light.h612a_2',
  'lighting.govee_strip_2': 'light.h612f',
  'lighting.yeelight_monitor_front': 'light.yeelight_lamp15_0x305a74b9',
  'lighting.yeelight_monitor_back':
    'light.yeelight_lamp15_0x305a74b9_ambilight',
  'lighting.desk': 'light.h600d',
  'lighting.wled_cct': 'light.brunos_rum_wled',
};

/** Live saved "Vardagsljus" preset (scenes.json, read 2026-11-09). */
const savedEverydayLight: LightingScene = {
  id: 'scene.everyday_light',
  name: 'Vardagsljus',
  lighting: {
    'lighting.cleverio_bar': {
      power: true,
      brightness: 39,
      colorTemperature: 2700,
    },
    'lighting.govee_table': {
      power: true,
      brightness: 60,
      colorTemperature: 2700,
    },
    'lighting.govee_ceiling': { power: false, brightness: 0 },
    'lighting.govee_strip_1': {
      power: true,
      brightness: 55,
      colorTemperature: 2700,
    },
    'lighting.govee_strip_2': {
      power: true,
      brightness: 55,
      colorTemperature: 2700,
    },
    'lighting.yeelight_monitor_front': {
      power: true,
      brightness: 55,
      colorTemperature: 2700,
    },
    'lighting.yeelight_monitor_back': {
      power: false,
      brightness: 0,
      colorTemperature: 2700,
    },
    'lighting.desk': { power: true, brightness: 48, colorTemperature: 2700 },
    'lighting.wled_cct': {
      power: true,
      brightness: 61,
      colorTemperature: 2700,
    },
  },
};

const party: LightingScene = {
  id: 'scene.party',
  name: 'Party',
  lighting: {
    'lighting.cleverio_bar': {
      power: true,
      brightness: 35,
      rgb: [255, 60, 100],
    },
    'lighting.govee_table': {
      power: true,
      brightness: 48,
      rgb: [160, 35, 255],
    },
    'lighting.govee_ceiling': {
      power: false,
      brightness: 0,
      colorTemperature: 2700,
    },
    'lighting.govee_strip_1': {
      power: true,
      brightness: 50,
      rgb: [40, 90, 255],
    },
    'lighting.govee_strip_2': {
      power: true,
      brightness: 50,
      rgb: [255, 35, 145],
    },
    'lighting.yeelight_monitor_front': {
      power: true,
      brightness: 12,
      colorTemperature: 2700,
    },
    'lighting.yeelight_monitor_back': {
      power: true,
      brightness: 42,
      rgb: [35, 180, 255],
    },
    'lighting.desk': { power: true, brightness: 35, rgb: [255, 95, 25] },
    'lighting.wled_cct': {
      power: true,
      brightness: 18,
      colorTemperature: 2700,
    },
  },
};

export type SimulationOptions = {
  profile: LatencyProfile | string;
  /** Multiplies measured CPU time; 1 = this machine. */
  cpuScale?: number;
  /** Stream listeners that only receive the cloned update. */
  passiveStreamListeners?: number;
  /** SSE-like listeners that serialize full state on setImmediate. */
  serializingStreamListeners?: number;
  /** Extra options forwarded to HomeAssistantLightingAdapter, if supported. */
  adapterOptions?: Record<string, unknown>;
};

export type EventMeasurement = {
  eventId: string;
  episode: number;
  /** prelight, occupied (entry/return) or empty (confirmed-empty off). */
  kind: string;
  episodeKind: string;
  originAt: number;
  eventToDecisionMs: number | undefined;
  /** Decision -> first/last HA service request on the wire. */
  decisionToFirstSentMs: number | undefined;
  decisionToLastSentMs: number | undefined;
  eventToFirstSentMs: number | undefined;
  eventToLastSentMs: number | undefined;
  /** Modeled lamp response, first and last lamp of this event. */
  eventToFirstPhysicalMs: number | undefined;
  eventToLastPhysicalMs: number | undefined;
  eventToFirstFeedbackMs: number | undefined;
  eventToFullConvergenceMs: number | undefined;
  serviceCalls: number;
  entityCommands: number;
  /** Modeled HA state time per lamp (first command), for calibration. */
  entityStateMs: Record<string, number>;
};

export type CheckpointState = {
  episode: number;
  label: string;
  lights: Record<string, string>;
  presence: string;
  scene: string | null;
  overrides: string[];
};

export type SimulationResult = {
  workload: string;
  seed: number;
  profile: string;
  cpuScale: number;
  events: EventMeasurement[];
  /** Per-command event -> wire latency for every fast-path command. */
  commandSentMs: number[];
  commandPhysicalMs: number[];
  totals: {
    serviceCalls: number;
    entityCommands: number;
    noopEntityCommands: number;
    restCalls: number;
    websocketCalls: number;
    wledRequests: number;
    failedCalls: number;
    unhandledRejections: number;
  };
  checkpoints: CheckpointState[];
  wallMs: number;
};

/** Attribution window for an event's own fast-path commands. */
const fastPathWindowMs = 1_500;

/**
 * Runs one workload against the production engine/adapters with simulated
 * MQTT and Home Assistant. Lugn code runs unmodified; only its transports
 * (MQTT subscriber, fetch, WebSocket factory, clock) are substituted.
 */
export async function runSimulation(
  workload: Workload,
  options: SimulationOptions,
): Promise<SimulationResult> {
  const started = performance.now();
  const profile =
    typeof options.profile === 'string'
      ? latencyProfiles[options.profile]
      : options.profile;
  if (!profile)
    throw new Error(`Unknown latency profile ${String(options.profile)}`);
  const cpuScale = options.cpuScale ?? 1;
  const clock = new SimClock(Date.parse('2026-11-09T14:00:00+01:00'), cpuScale);
  const ha = new MockHomeAssistant(
    clock,
    profile,
    workload.seed,
    Object.values(liveEntities),
  );
  let unhandledRejections = 0;
  const lighting = new HomeAssistantLightingAdapter(
    {
      baseUrl: 'http://192.168.10.40:8123',
      token: 'simulated-token',
      entities: liveEntities,
      wledCct: {
        'lighting.wled_cct': { baseUrl: 'http://192.168.10.184', segmentId: 0 },
      },
      ...(options.adapterOptions ?? {}),
    } as ConstructorParameters<typeof HomeAssistantLightingAdapter>[0],
    ha.fetch,
    clock,
  );
  const deviceIds = Object.keys(liveEntities);
  const engine = new LugnEngine(clock, {
    adapter: lighting,
    deviceIds,
    // Mirrors main.ts: configured scenes + room presets, the saved preset
    // overlay, and scene.everyday resolving to scene.everyday_light.
    scenes: withRoomPresets([party], deviceIds).map((scene) =>
      scene.id === savedEverydayLight.id ? savedEverydayLight : scene,
    ),
    defaultSceneId: 'scene.everyday_light',
    prelight: {
      targets: {
        'lighting.govee_ceiling': {
          power: true,
          brightness: 35,
          colorTemperature: 2700,
        },
      },
      maxDurationMs: 5_000,
    },
    windowLighting: {
      target: 'lighting.govee_strip_1',
      presenceMode: 'always',
      brightness: 55,
      maxSunElevation: 6,
    },
    lightingControlModes: { 'lighting.cleverio_bar': 'enforce' },
  });
  for (let index = 0; index < (options.passiveStreamListeners ?? 4); index += 1)
    engine.stream.subscribe(() => undefined);
  for (
    let index = 0;
    index < (options.serializingStreamListeners ?? 3);
    index += 1
  ) {
    let pending: NodeJS.Immediate | undefined;
    engine.stream.subscribe(() => {
      if (pending) return;
      pending = setImmediate(() => {
        pending = undefined;
        JSON.stringify(engine.state);
      });
    });
  }
  const socket = new HomeAssistantWebSocketTransport(
    { baseUrl: 'http://192.168.10.40:8123', token: 'simulated-token' },
    (event) => {
      lighting.acceptStateChangedEvent(event);
    },
    {
      createSocket: ha.createSocket,
      clock,
      onConnected: (connection) => {
        const states = clock.excluded(() => ha.snapshot());
        if (!connection.isCurrent()) return;
        for (const state of states) lighting.acceptStateChangedEvent(state);
      },
    },
  );
  (
    lighting as { attachWebSocket?: (transport: unknown) => void }
  ).attachWebSocket?.(socket);
  let brokerSeq = 0;
  const broker = new SimMqttBroker(clock, () =>
    Math.max(
      0,
      keyedLatency(profile.mqttDeliveryMs, workload.seed, 'mqtt', brokerSeq++),
    ),
  );
  const ingress = new PresenceEventIngress((event) =>
    engine.handleEvent(event),
  );
  const sensor = new Stl27lMqttPresenceAdapter(
    broker,
    (event) => {
      void ingress.accept(event).catch(() => {
        unhandledRejections += 1;
      });
    },
    { baseTopic: 'bruno/doorway', maxAgeMs: 7_000, clock },
  );
  broker.onConnection((connected) => sensor.setBrokerConnected(connected));
  sensor.start();
  sensor.setBrokerConnected(true);
  socket.start();

  const onRejection = (): void => {
    unhandledRejections += 1;
  };
  process.on('unhandledRejection', onRejection);

  const timings = new Map<string, FastPathTiming>();
  const timingEpisode = new Map<
    string,
    { episode: number; kind: string; episodeKind: string }
  >();
  let episode = -1;
  let episodeKind = 'startup';
  const collectTimings = (): void => {
    const list = engine.state.timings;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const timing = list[index]!;
      if (timings.has(timing.eventId)) break;
      timings.set(timing.eventId, timing);
      timingEpisode.set(timing.eventId, {
        episode,
        kind: timing.eventId.startsWith('prelight-')
          ? 'prelight'
          : engine.state.presence.state === 'occupied'
            ? 'occupied'
            : 'empty',
        episodeKind,
      });
    }
  };
  const checkpoints: CheckpointState[] = [];

  const settle = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const runUntil = async (at: number): Promise<void> => {
    for (;;) {
      await settle();
      collectTimings();
      if (clock.runNextDue()) continue;
      const next = clock.nextDueAt();
      if (next === undefined || next > at) {
        clock.skipTo(at);
        await settle();
        collectTimings();
        return;
      }
      clock.skipTo(next);
    }
  };
  const apply = (step: WorkloadStep): void => {
    switch (step.kind) {
      case 'mqtt':
        broker.publish(`bruno/doorway/${step.topic}`, step.text, {
          ...(step.retain === undefined ? {} : { retain: step.retain }),
          ...(step.extraDelayMs === undefined
            ? {}
            : { extraDelayMs: step.extraDelayMs }),
        });
        return;
      case 'manual':
        ha.manualChange(step.entity, step.values);
        return;
      case 'scene':
        void engine
          .activateScene(
            step.sceneId,
            { type: 'user', id: 'simulated-user' },
            'ui',
          )
          .catch(() => {
            unhandledRejections += 1;
          });
        return;
      case 'faults':
        Object.assign(ha.faults, step.faults);
        return;
      case 'ws-drop':
        ha.dropWebSockets();
        return;
      case 'broker':
        broker.setConnected(step.connected);
        return;
      case 'sun':
        void engine.handleSunElevation(step.elevation);
        return;
      case 'checkpoint':
        checkpoints.push(captureCheckpoint(step.episode, step.label));
        return;
    }
  };
  const captureCheckpoint = (
    index: number,
    label: string,
  ): CheckpointState => ({
    episode: index,
    label,
    lights: Object.fromEntries(
      Object.values(liveEntities).map((entity) => {
        const state = ha.state(entity);
        const brightness = state?.attributes['brightness'];
        return [
          entity,
          state?.state === 'on'
            ? `on:${String(brightness)}:${String(state.attributes['color_mode'])}`
            : String(state?.state),
        ];
      }),
    ),
    presence: engine.state.presence.state,
    scene: engine.state.lighting.currentScene,
    overrides: Object.entries(engine.state.lighting.devices).flatMap(
      ([target, device]) =>
        Object.entries(device.ownership)
          .filter(([, owner]) => owner?.kind === 'override')
          .map(([property]) => `${target}.${property}`),
    ),
  });

  const episodeStarts = [...workload.episodes].sort(
    (a, b) => a.startAt - b.startAt,
  );
  let nextEpisode = 0;
  await runUntil(500);
  for (const step of workload.steps) {
    await runUntil(step.at);
    while (
      nextEpisode < episodeStarts.length &&
      episodeStarts[nextEpisode]!.startAt <= step.at
    ) {
      episode = episodeStarts[nextEpisode]!.index;
      episodeKind = episodeStarts[nextEpisode]!.kind;
      nextEpisode += 1;
    }
    apply(step);
  }
  await runUntil(workload.endAt);
  process.off('unhandledRejection', onRejection);
  sensor.stop();
  socket.stop();
  engine.dispose();

  // Attribute each HA request to the newest preceding fast-path event.
  const origins = [...timings.values()]
    .map((timing) => ({
      timing,
      decisionAt: clock.toMonotonic(
        timing.decisionCompletedAt ?? timing.eventReceivedAt,
      ),
    }))
    .map(({ timing, decisionAt }) => ({
      timing,
      decisionAt,
      originAt: decisionAt - (timing.eventToDecisionMs ?? 0),
    }))
    .sort((a, b) => a.originAt - b.originAt);
  // One row per entity command: a group call contributes one row per entity.
  const wireCommands = [
    ...ha.calls.flatMap((call) =>
      call.entities.map((entity) => {
        const effect = call.effects.find((entry) => entry.entity === entity);
        return {
          entity,
          invokedAt: call.invokedAt,
          wireAt: call.wireAt,
          stateAt: effect?.stateAt,
          physicalAt: effect?.physicalAt,
          firstOfCall: entity === call.entities[0],
        };
      }),
    ),
    ...ha.wledCalls
      .filter((call) => call.method === 'POST')
      .map((call) => ({
        entity: 'light.brunos_rum_wled',
        invokedAt: call.invokedAt,
        wireAt: call.invokedAt as number | undefined,
        stateAt: call.physicalAt,
        physicalAt: call.physicalAt,
        firstOfCall: true,
      })),
  ].sort((a, b) => a.invokedAt - b.invokedAt);
  const events: EventMeasurement[] = [];
  const commandSentMs: number[] = [];
  const commandPhysicalMs: number[] = [];
  let cursor = 0;
  for (let index = 0; index < origins.length; index += 1) {
    const origin = origins[index]!;
    const nextOrigin = origins[index + 1]?.originAt ?? Number.POSITIVE_INFINITY;
    const windowEnd = Math.min(
      nextOrigin,
      origin.decisionAt + fastPathWindowMs,
    );
    while (
      cursor < wireCommands.length &&
      wireCommands[cursor]!.invokedAt < origin.originAt
    )
      cursor += 1;
    const own: typeof wireCommands = [];
    for (let scan = cursor; scan < wireCommands.length; scan += 1) {
      const command = wireCommands[scan]!;
      if (command.invokedAt >= windowEnd) break;
      own.push(command);
    }
    // Latency targets the first command per lamp; bounded repeats (Cleverio
    // off, retries) still count as calls but not as later "last lamp" sends.
    const firstByEntity = new Map<string, (typeof own)[number]>();
    for (const command of own)
      if (!firstByEntity.has(command.entity))
        firstByEntity.set(command.entity, command);
    const first = [...firstByEntity.values()];
    const sent = first
      .map((command) => command.wireAt)
      .filter((at): at is number => at !== undefined);
    const physical = first
      .map((command) => command.physicalAt)
      .filter((at): at is number => at !== undefined);
    for (const at of sent) commandSentMs.push(at - origin.originAt);
    for (const at of physical) commandPhysicalMs.push(at - origin.originAt);
    const meta = timingEpisode.get(origin.timing.eventId) ?? {
      episode: -1,
      kind: 'unknown',
      episodeKind: 'startup',
    };
    events.push({
      eventId: origin.timing.eventId,
      episode: meta.episode,
      kind: meta.kind,
      episodeKind: meta.episodeKind,
      originAt: origin.originAt,
      eventToDecisionMs: origin.timing.eventToDecisionMs,
      decisionToFirstSentMs: sent.length
        ? Math.min(...sent) - origin.decisionAt
        : undefined,
      decisionToLastSentMs: sent.length
        ? Math.max(...sent) - origin.decisionAt
        : undefined,
      eventToFirstSentMs: sent.length
        ? Math.min(...sent) - origin.originAt
        : undefined,
      eventToLastSentMs: sent.length
        ? Math.max(...sent) - origin.originAt
        : undefined,
      eventToFirstPhysicalMs: physical.length
        ? Math.min(...physical) - origin.originAt
        : undefined,
      eventToLastPhysicalMs: physical.length
        ? Math.max(...physical) - origin.originAt
        : undefined,
      eventToFirstFeedbackMs: origin.timing.eventToFirstFeedbackMs,
      eventToFullConvergenceMs: origin.timing.eventToFullConvergenceMs,
      serviceCalls: own.filter((command) => command.firstOfCall).length,
      entityCommands: own.length,
      entityStateMs: Object.fromEntries(
        first
          .filter((command) => command.stateAt !== undefined)
          .map((command) => [
            command.entity,
            Math.round((command.stateAt! - origin.originAt) * 10) / 10,
          ]),
      ),
    });
  }
  const effects = ha.calls.flatMap((call) => call.effects);
  return {
    workload: workload.name,
    seed: workload.seed,
    profile: profile.name,
    cpuScale,
    events,
    commandSentMs,
    commandPhysicalMs,
    totals: {
      serviceCalls:
        ha.calls.length +
        ha.wledCalls.filter((call) => call.method === 'POST').length,
      entityCommands: effects.length,
      noopEntityCommands: effects.filter((effect) => effect.noop).length,
      restCalls: ha.calls.filter((call) => call.transport === 'rest').length,
      websocketCalls: ha.calls.filter((call) => call.transport === 'websocket')
        .length,
      wledRequests: ha.wledCalls.length,
      failedCalls: ha.calls.filter(
        (call) => call.outcome !== undefined && call.outcome !== 'ok',
      ).length,
      unhandledRejections,
    },
    checkpoints,
    wallMs: performance.now() - started,
  };
}
