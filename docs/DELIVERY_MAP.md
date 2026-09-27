# Lugn to a connectable local runtime

## Destination

Deliver a locally runnable and configurable Lugn service that can receive STL27L
presence directly from its existing sensor service, drive multiple real lights
through an existing integration, and expose a safe path to additional system
adapters. Document setup, credentials, health, shutdown, and what has and has
not been verified against physical systems.

This map tracks implementation and commissioning toward a configurable local
runtime. The first live deployment is running on the room host; remaining work
is called out separately from observed software and device behavior.

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
  non-retained prelight hint. The current Room Engine source also consumes
  `bruno/doorway` directly, confirming Lugn can avoid an HA sensor-entity hop.
  Live commissioning confirmed a fresh STL27L feed over MQTT and a Govee Local
  dispatch about 13 ms after Lugn received a prelight event. This measures the
  software dispatch path, not physical light response. See [sensor integration
  contract](INTEGRATIONS.md).

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

### Long-running history retention

- Question: How should command, diagnostic, timing, and correlation histories
  stay bounded over long runtimes without misclassifying delayed device
  feedback as a manual override?
- Depends on: command attribution and state-stream contracts.
- Status: resolved for the in-memory runtime. Lighting/switch commands retain
  all pending records plus the newest 256 terminal records; music retains all
  pending plus up to 128 terminal records, protecting a just-completed pending
  command while pruning the oldest other terminal record; diagnostics/timings retain the
  newest 256. Unconfirmed lighting commands become terminal after the existing
  60-second convergence timeout, switches after 10 seconds, and music after 10
  seconds. Retired lighting IDs remain recognizable for the process lifetime
  without retaining every record. Only logical lighting intent and continuity
  expiry persist across restart; observations, presence, command ledgers,
  diagnostics, timing, switches, and music remain in memory. Old physical
  commands are never replayed. See [configuration](CONFIGURATION.md) and the
  [operator guide](OPERATIONS.md) for persistence and restart behavior.

### Room control panel

- Question: How can an operator inspect presence, scene ownership, mapped
  lights, and reported feedback while tuning devices?
- Status: an authenticated local lighting panel uses same-origin sessions and
  the existing typed capability API. It is served through the loopback runtime
  and supports an SSH tunnel or an explicitly trusted TLS proxy origin.

### Live integration acceptance

- Question: What evidence proves sensor-event-to-command latency and physical
  feedback on Bruno's actual broker, Home Assistant, sensor, and lights?
- Depends on: implementation, user-provided endpoint/entity configuration,
  and explicit authorization to connect to those live systems.
- Status: deployed and actively commissioned on BrunoCAM at
  `616d74ea90269f30dbe3ccca1a365d46193c77bb`. Latest live health returned
  Home Assistant and MQTT connected; the runtime reported confirmed occupancy,
  `scene.everyday`, and eight mapped devices. The user observed that entering
  the room turned on lighting. One HA feedback confirmation was present at the
  latest check; two targets remain degraded and are listed in the Draft PR.
  The deployment created a private intent file, but a second restart has not
  yet been used as live proof of restoration. Automated tests cover the restart
  safety contract. This is operator-reported evidence, not hardware sign-off.

## Not yet specified

- GUI-driven lighting mapping and scene tuning after the initial panel is
  available.
- The next non-light system and its device-specific behavior contract.
- A second live restart observation to confirm persistence behavior on the
  installed host.

## Out of scope

- Porting raw STL27L UART parsing, calibration, or tracking into Lugn.
- Claiming measured latency or physical success from unit or CI checks alone.
