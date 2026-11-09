# Lighting latency simulator

Offline harness for the path STL27L MQTT event -> Lugn decision -> Home
Assistant light command. It runs the production `LugnEngine`,
`Stl27lMqttPresenceAdapter`, `PresenceEventIngress`,
`HomeAssistantLightingAdapter` and `HomeAssistantWebSocketTransport`
unmodified; only their transports and clock are substituted. Nothing here
contacts a broker, Home Assistant or a lamp.

```sh
npm run bench:lighting -- --label baseline --set all --episodes 100 \
  --cpu-scale 12 --out bench/results/baseline.json
```

- `--set train|test|all`: training workloads (seeds 101/102, ordinary mix,
  `brunocam-fitted` profile) and held-out workloads (seeds 201/202, fault-heavy
  mix, unseen `unseen-slow-ha` and `unseen-wifi-jitter` profiles).
- `--cpu-scale`: multiplies measured Lugn CPU time. `12` approximates the
  Raspberry Pi 3 that runs Lugn live (see the report's calibration section).
- `--adapter-options '<json>'`: extra `HomeAssistantLightingAdapter` options.

## Pieces (`bench/lighting-sim/`)

- `SimClock`: elapsed time is real CPU time (optionally scaled) plus skipped
  idle time, so synchronous work is measured while modeled network/device
  delays cost no wall time. Simulator-side work runs in `clock.excluded()`.
- `SimMqttBroker`: in-process broker with delivery delay, retained messages,
  reordering (`extraDelayMs`) and connect/disconnect.
- `MockHomeAssistant`: REST light services (with an undici-like keep-alive
  pool and cold-connect timing), the WebSocket API (auth, `state_changed`,
  `call_service`), a WLED JSON endpoint, a serialized HA event loop,
  per-integration latency/fault models, manual changes, dropped/delayed/stale
  feedback and server-side socket drops. Samples are keyed by
  (seed, entity, nth command), so candidates that send fewer commands do not
  shift other samples.
- `generateWorkload`: seeded episode timelines (entries with and without
  preview, false previews, bounces, second person, preview storms, sensor
  flaps, manual overrides, scene changes, WebSocket drops, broker reconnects,
  out-of-order MQTT/HA, feedback stalls, REST errors).
- `runSimulation` returns per-event measurements (event -> decision,
  decision -> first/last command on the wire, modeled physical response),
  command counts (including no-op commands that would not change HA state)
  and settled checkpoints for differential correctness checks.

Custom workloads are plain `WorkloadStep[]` timelines, for example:

```ts
import { runSimulation } from './bench/lighting-sim/index.js';
const steps = [
  { at: 0, kind: 'sun', elevation: -8 },
  { at: 10, kind: 'mqtt', topic: 'availability', text: 'online', retain: true },
  { at: 5_000, kind: 'mqtt', topic: 'preview', text: 'ON' },
];
const result = await runSimulation(
  { name: 'custom', seed: 1, steps, endAt: 20_000, episodes: [] },
  { profile: 'brunocam-fitted', cpuScale: 12 },
);
```

Simulated results prove relative software behavior under the modeled
transports. They are not measurements of real lamps, Home Assistant or the
STL27L, and they do not guarantee live latency.
