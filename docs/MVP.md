# MVP status

This document records what the current local runtime already does and what
still needs work before Lugn is a broadly configurable, finished product.

## Implemented local runtime

### Presence and lighting

- MQTT adapter consumes normalized STL27L occupancy, health and prelight
  events. The sensor's raw LiDAR parsing remains in the separate sensor
  service.
- Room state keeps `occupied`, `confirmed_empty` and `unknown` distinct.
- A confirmed empty room turns configured lights off immediately while
  preserving the logical scene and selected overrides for continuity.
- A short confirmed return reconciles the current effective light intent.
- Prelight is a bounded overlay and does not imply occupancy.
- Home Assistant home/away is tracked separately through a configured
  `person.*` or `device_tracker.*` entity. The sample defaults to
  `device_tracker.lustigkurre`.
- Confirmed `away` suppresses automatic entry lighting and prelight. Unknown
  home status is not treated as away. Confirmed-empty shutoff still runs.
- Manual scene and light capabilities remain available when away.
- Built-in room presets are Helt släckt, Mysljus, Vardagsljus, Filmkväll and
  Fokus; the dashboard gives them the primary controls.
- Scene convergence, retries, command diagnostics and a versioned logical
  lighting/music intent snapshot are implemented. Physical state and pending
  commands are not restored after restart.

### Music

- Optional Home Assistant `media_player.*` targets support observed playback,
  volume, source and preset requests where the entity/integration supports
  them.
- Confirmed room-empty pauses music. On a confirmed away state, active music is
  paused and automatic music starts/resumes and volume adjustment are gated.
- A confirmed room return between 06:00 and 23:00 resumes recent playing context or starts
  Spotify DJ preset 1. From 23:00 until 06:00, automatic start and resume are
  suppressed.
- The daily volume curve, two-person reduction and manual dashboard ±5-point
  volume controls are implemented; the exact curve is in [Music](MUSIC.md).
- Manual music capability requests remain available while away.

### Local runtime and room display

- One Node.js service hosts typed state/capability APIs, MQTT presence, Home
  Assistant adapters and bounded command histories.
- A separate custom Hub dashboard is served by Lugn and managed through
  DashCast. It shows large scene buttons, home/room status, clock/date, room
  measurements and compact music controls.
- Bed and desk receiver roles, receiver monitoring and yielding to an active
  external cast are implemented.
- Temperature, humidity, CO₂ and PM2.5 can be read from mapped Home Assistant
  sensors and displayed when data is available.
- A local onboarding wizard, config checker, read-only preflight and systemd
  user-service installer are included.

## Still outside this MVP

- A full visual configuration editor. The local operational control panel
  supports optional Clerk sign-in; custom Hub pages use their own per-Hub
  secret paths, and machine API routes retain bearer-token authentication.
- A routine editor/scheduler, BILRESA binding UI, or broad configuration UI.
- Direct WiiM transport. Music control uses Home Assistant media-player
  entities and remains subject to the services and feedback those entities
  expose.
- Reliable confirmation of physical lamp or audio output based only on an
  accepted Home Assistant request. Lugn records observed HA feedback, which is
  not the same as physical verification.
- Measured sensor-to-physical-light latency and receiver-rendering proof for
  every Hub. DashCast acceptance is not proof that the browser rendered a
  dashboard.

## Acceptance checks for the current slice

- Unknown room presence does not turn lights off or expire continuity.
- Unknown home status is distinct from confirmed away; only confirmed away
  suppresses automatic room activation.
- Away never suppresses confirmed-empty shutoff or explicitly requested
  dashboard actions.
- Prelight is suppressed when the room is already lit, the current scene is
  fully off, quiet hours are active, or the resident is away.
- The dashboard is self-contained and does not route users into Home Assistant
  dashboards.
- Music stays silent from automatic start/resume between 23:00 and 06:00; user-selected
  preset and playback controls remain manual actions.
- The fast entry-light command is dispatched without waiting for persistence or
  UI work. Confirmed empty turns lights off immediately while retaining the
  logical scene; a short return restores the effective scene and overrides.
- Scene selection converges all configured targets. A manual change is tracked
  only for the property changed when possible, and an unreachable target does
  not create a false manual override.
- Bed and Desk Hub roles use separate pages/tokens; DashCast yields to an active
  external cast and the dashboard reflects current runtime state.
- Music fade feedback does not create false manual ownership. Explicit volume
  changes update the user's baseline, while automatic adjustments identify
  Lugn as the controller and expose their target.
- Restart restores logical lighting intent only after fresh occupancy; old
  presence, observations, command ledgers and pending commands are not replayed.
- Saved music ownership and explicit Pause restore before HA seeding. Short
  absence resume eligibility keeps its original absolute deadline.
