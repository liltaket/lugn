import type { LatencyDistribution } from './random.js';

/** Modeled behavior of one Home Assistant light integration. */
export type IntegrationProfile = {
  /** HA receipt -> service call completes (REST response / WS result). */
  serviceMs: LatencyDistribution;
  /** HA receipt -> state_changed is emitted. */
  stateMs: LatencyDistribution;
  /** HA receipt -> the lamp visibly changes (estimate, never observed). */
  physicalMs: LatencyDistribution;
  /** Probability that a command's state_changed is never emitted. */
  feedbackDropRate?: number;
  /** Probability that the service call fails with an HA error. */
  errorRate?: number;
  /** Probability that the service call never answers (client timeout). */
  hangRate?: number;
  /** Commands for entities sharing this key execute one at a time. */
  serialKey?: string;
};

/**
 * Transport and integration model for one simulated installation. Every
 * value is an assumption unless the report names its source; profiles marked
 * `derivedFrom` are fitted to the read-only HA history described there.
 */
export type LatencyProfile = {
  name: string;
  derivedFrom?: string;
  /** Sensor publish -> broker -> Lugn MQTT callback. */
  mqttDeliveryMs: LatencyDistribution;
  /** One-way Lugn <-> HA network delay. */
  lanOneWayMs: LatencyDistribution;
  /** TCP connect for a REST request without a warm keep-alive socket. */
  restConnectMs: LatencyDistribution;
  /** undici closes idle keep-alive sockets after this long (default 4 s). */
  restKeepAliveMs: number;
  /** Modeled client-side request encoding cost on the reference CPU. */
  restClientCpuMs: number;
  websocketClientCpuMs: number;
  /** HA event-loop time per request/frame and per entity, serialized. */
  haCpuMs: { rest: number; websocket: number; perEntity: number };
  /** HA entity id -> integration name. */
  entityIntegration: Record<string, string>;
  integrations: Record<string, IntegrationProfile>;
  wled: { requestMs: LatencyDistribution; physicalMs: LatencyDistribution };
};

const govee = (scale = 1): IntegrationProfile => ({
  // govee_light_local sends UDP and writes optimistic state immediately.
  serviceMs: { kind: 'lognormal', medianMs: 6 * scale, p95Ms: 25 * scale },
  stateMs: { kind: 'lognormal', medianMs: 8 * scale, p95Ms: 30 * scale },
  physicalMs: { kind: 'lognormal', medianMs: 70 * scale, p95Ms: 180 * scale },
});

const yeelight = (scale = 1): IntegrationProfile => ({
  serviceMs: { kind: 'lognormal', medianMs: 45 * scale, p95Ms: 160 * scale },
  stateMs: { kind: 'lognormal', medianMs: 80 * scale, p95Ms: 260 * scale },
  physicalMs: { kind: 'lognormal', medianMs: 60 * scale, p95Ms: 200 * scale },
  serialKey: 'yeelight_lamp15_0x305a74b9',
});

const tuyaCloud = (scale = 1): IntegrationProfile => ({
  serviceMs: { kind: 'lognormal', medianMs: 420 * scale, p95Ms: 1400 * scale },
  stateMs: { kind: 'lognormal', medianMs: 560 * scale, p95Ms: 1800 * scale },
  physicalMs: { kind: 'lognormal', medianMs: 650 * scale, p95Ms: 2000 * scale },
  feedbackDropRate: 0.08,
  serialKey: 'tuya_cleverio',
});

const liveEntities: Record<string, string> = {
  'light.cleverio_lb100': 'tuya',
  'light.h6022': 'govee_light_local',
  'light.h60a6_2': 'govee_light_local',
  'light.h612a_2': 'govee_light_local',
  'light.h612f': 'govee_light_local',
  'light.yeelight_lamp15_0x305a74b9': 'yeelight',
  'light.yeelight_lamp15_0x305a74b9_ambilight': 'yeelight',
  'light.h600d': 'govee_light_local',
  'light.brunos_rum_wled': 'wled',
};

const fittedTransport: Omit<LatencyProfile, 'name' | 'derivedFrom'> = {
  mqttDeliveryMs: { kind: 'lognormal', medianMs: 3, p95Ms: 12 },
  lanOneWayMs: { kind: 'lognormal', medianMs: 0.6, p95Ms: 2.5 },
  restConnectMs: { kind: 'lognormal', medianMs: 1.5, p95Ms: 6 },
  restKeepAliveMs: 4_000,
  restClientCpuMs: 0.25,
  websocketClientCpuMs: 0.03,
  haCpuMs: { rest: 3, websocket: 1.2, perEntity: 1.5 },
  entityIntegration: liveEntities,
  integrations: {
    govee_light_local: govee(),
    yeelight: yeelight(),
    tuya: tuyaCloud(),
  },
  wled: {
    requestMs: { kind: 'lognormal', medianMs: 18, p95Ms: 60 },
    physicalMs: { kind: 'lognormal', medianMs: 25, p95Ms: 70 },
  },
};

/** Training profile: medians fitted to HA logbook offsets (see report). */
export const brunocamProfile: LatencyProfile = {
  ...fittedTransport,
  name: 'brunocam-fitted',
  derivedFrom:
    'HA 2026.10.3 logbook/history, 10 days to 2026-11-09: relative per-integration state offsets after Lugn bursts',
};

/** Held-out profile: slower HA host, more jitter and flakier integrations. */
export const unseenSlowHaProfile: LatencyProfile = {
  name: 'unseen-slow-ha',
  mqttDeliveryMs: {
    kind: 'mixture',
    parts: [
      {
        weight: 0.9,
        distribution: { kind: 'lognormal', medianMs: 5, p95Ms: 20 },
      },
      { weight: 0.1, distribution: { kind: 'uniform', minMs: 40, maxMs: 250 } },
    ],
  },
  lanOneWayMs: { kind: 'lognormal', medianMs: 1.5, p95Ms: 12 },
  restConnectMs: { kind: 'lognormal', medianMs: 4, p95Ms: 30 },
  restKeepAliveMs: 4_000,
  restClientCpuMs: 0.35,
  websocketClientCpuMs: 0.05,
  haCpuMs: { rest: 9, websocket: 3, perEntity: 4 },
  entityIntegration: liveEntities,
  integrations: {
    govee_light_local: { ...govee(2.5), errorRate: 0.01 },
    yeelight: { ...yeelight(2), feedbackDropRate: 0.03, errorRate: 0.02 },
    tuya: { ...tuyaCloud(1.8), feedbackDropRate: 0.2, hangRate: 0.02 },
  },
  wled: {
    requestMs: { kind: 'lognormal', medianMs: 40, p95Ms: 200 },
    physicalMs: { kind: 'lognormal', medianMs: 30, p95Ms: 90 },
  },
};

/** Held-out profile: fast host but bursty Wi-Fi with heavy-tailed jitter. */
export const unseenJitterProfile: LatencyProfile = {
  ...fittedTransport,
  name: 'unseen-wifi-jitter',
  lanOneWayMs: {
    kind: 'mixture',
    parts: [
      {
        weight: 0.85,
        distribution: { kind: 'lognormal', medianMs: 1, p95Ms: 4 },
      },
      {
        weight: 0.15,
        distribution: { kind: 'lognormal', medianMs: 30, p95Ms: 180 },
      },
    ],
  },
  restConnectMs: { kind: 'lognormal', medianMs: 6, p95Ms: 80 },
  integrations: {
    govee_light_local: { ...govee(1.5), feedbackDropRate: 0.05 },
    yeelight: { ...yeelight(1.5), hangRate: 0.01 },
    tuya: { ...tuyaCloud(1.2), errorRate: 0.05 },
  },
};

/**
 * Placement experiment. Network hops use RTT/2 from 200 pings measured
 * 2026-11-09 (brunocam is on Wi-Fi: RTT to HA/broker P50 4.2, P95 8.9, P99
 * 12.4 ms; putte is wired: P50 0.26, P95 0.33, P99 0.8 ms). The STL27L stays
 * on brunocam, so its publish to the broker crosses Wi-Fi in both cases.
 */
const wifiOneWay: LatencyDistribution = {
  kind: 'lognormal',
  medianMs: 2.1,
  p95Ms: 4.5,
  maxMs: 7.5,
};

export const placementBrunocamProfile: LatencyProfile = {
  ...fittedTransport,
  name: 'placement-brunocam',
  derivedFrom:
    'measured brunocam (Wi-Fi) RTTs; integrations as brunocam-fitted',
  // sensor -> broker (Wi-Fi) + broker -> Lugn on the same Pi (Wi-Fi).
  mqttDeliveryMs: { kind: 'lognormal', medianMs: 4.8, p95Ms: 8.8, maxMs: 15 },
  lanOneWayMs: wifiOneWay,
};

export const placementPutteProfile: LatencyProfile = {
  ...fittedTransport,
  name: 'placement-putte',
  derivedFrom: 'measured putte (wired) RTTs; integrations as brunocam-fitted',
  // sensor -> broker (Wi-Fi) + broker -> putte (wired).
  mqttDeliveryMs: { kind: 'lognormal', medianMs: 2.6, p95Ms: 4.9, maxMs: 8.5 },
  lanOneWayMs: { kind: 'lognormal', medianMs: 0.13, p95Ms: 0.17, maxMs: 0.6 },
};

export const latencyProfiles: Record<string, LatencyProfile> = {
  [brunocamProfile.name]: brunocamProfile,
  [placementBrunocamProfile.name]: placementBrunocamProfile,
  [placementPutteProfile.name]: placementPutteProfile,
  [unseenSlowHaProfile.name]: unseenSlowHaProfile,
  [unseenJitterProfile.name]: unseenJitterProfile,
};
