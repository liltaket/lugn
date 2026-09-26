# Lugn to a connectable local runtime

## Destination

Deliver a locally runnable and configurable Lugn service that can receive STL27L
presence directly from its existing sensor service, drive multiple real lights
through an existing integration, and expose a safe path to additional system
adapters. Document setup, credentials, health, shutdown, and what has and has
not been verified against physical systems.

This map tracks implementation toward a configurable local runtime. Live
integration acceptance requires installation-specific endpoints and explicit
authorization to connect to them.

## Notes

- Keep deterministic room behavior in Lugn; keep raw LiDAR parsing and tracking
  in `liltaket/stl27-presence`.
- Keep Home Assistant as a supported bridge for existing devices and systems.
- Keep presence, prelight, and confirmed empty as separate signals. Unknown
  never means empty.
- Runtime secrets must come from the host environment or a local secret store,
  never checked-in configuration.
- Use the active `wayfinding-planner` and `orchestration` skills for this
  multi-stage effort.

## Decisions so far

- [Fast preview event via MQTT](INTEGRATIONS.md) — Lugn has an injectable adapter
  for `bruno/doorway/preview`; it is prelight only and QoS 0/non-retained.
- [Lighting through Home Assistant](INTEGRATIONS.md) — current adapter maps
  semantic Lugn lights to caller-supplied HA entities and uses REST plus an
  injectable WebSocket state transport.
- [Bounded switch and music control](INTEGRATIONS.md) — typed light, switch,
  and media-player operations stay behind semantic mappings and fixed HA
  services; HA feedback remains separate from command acceptance.

## Frontier tickets

### Sensor occupancy and health contract

- Question: Which retained/versioned sensor outputs safely represent count,
  availability, and normalized `occupied` / `confirmed_empty` / `unknown`?
- Depends on: none.
- Status: resolved from the current sensor repo source.
- Answer: consume retained `/snapshot` plus retained `/availability`; only map
  a recently delivered live heartbeat to occupied/empty when availability is
  online and quality is CERTAIN. Count >0 means occupied, count 0 means
  confirmed empty. Offline, stale, malformed, or non-CERTAIN data maps to
  unknown. Do not age by snapshot `updated_at`: the source preserves the time
  of the last ledger change across heartbeats. `/preview` remains a separate
  non-retained prelight hint. See [sensor integration contract](INTEGRATIONS.md).

### Runnable host and configuration contract

- Question: What minimal local process/config format starts the engine, MQTT
  sensor bridge, HA lighting adapter, and clean shutdown as one application?
- Depends on: sensor occupancy and health contract.
- Status: resolved; `npm start` runs the local Node service, with environment
  secrets, loopback-only HTTP, MQTT reconnect, HA REST/WebSocket, status/state/
  capability routes, and graceful shutdown. See [operator guide](OPERATIONS.md).

### Home Assistant switch domain

- Question: What state, ownership, capability, and HA service contract safely
  controls configured `switch` entities alongside lighting?
- Depends on: runnable host and configuration contract.
- Status: resolved; semantic switch mappings expose `switch.set` and
  `switch.getState`, with only allowlisted `switch.turn_on` /
  `switch.turn_off` operations, observed feedback, and no presence-driven
  switch automation.

### Additional room systems

- Question: Which WiiM playback/source/volume behaviors and PC/display controls
  can be added while preserving the documented ownership and safety contracts?
- Depends on: local host, typed switch/capability surface, device-specific
  configuration and observations.
- Status: first bounded slice implemented through HA `media_player.*` mappings:
  explicit play, pause, volume, and configured-source operations with observed
  state and pending/confirmed/unconfirmed outcomes. Presets, fades,
  presence-driven music, and direct WiiM transport remain open until actual
  entity capabilities and feedback cadence are confirmed.

### Operator setup and recovery

- Question: What setup, health checks, stale-state behavior, and recovery steps
  make the local runtime understandable and safe to operate?
- Depends on: runnable host and sensor contract.
- Status: resolved in [operator guide](OPERATIONS.md), including example JSON,
  secret environment variables, local API calls, presence freshness, and
  command feedback semantics.

### Live integration acceptance

- Question: What evidence proves sensor-event-to-command latency and physical
  feedback on Bruno's actual broker, Home Assistant, sensor, and lights?
- Depends on: implementation, user-provided endpoint/entity configuration,
  and explicit authorization to connect to those live systems.
- Status: pending those deployment details and live-connection authorization;
  no live endpoints or devices have been contacted.

## Not yet specified

- Deployment host and service manager.
- Broker address/credentials and the sensor repo's current deployment settings.
- Which HA entities represent the multiple lights and the next non-light system.
- Whether the desired final surface is CLI/service only or also a UI/API.

## Out of scope

- Porting raw STL27L UART parsing, calibration, or tracking into Lugn.
- Deploying to a host, writing live HA configuration, or actuating physical
  devices before the host/entity details and live-connection authorization are
  established.
- Claiming measured latency or physical success from unit or CI checks.
