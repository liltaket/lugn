# Roadmap

This roadmap separates the local vertical slice that exists from the work that
would make Lugn easier to configure, validate and extend. It does not imply
that live devices are currently controlled by this checkout.

## In the current runtime

- Deterministic room engine with normalized occupied, confirmed-empty and
  unknown states, short-absence continuity and per-property light overrides.
- Direct STL27L service input through MQTT for occupancy and prelight; raw
  serial/perception work stays in `liltaket/stl27-presence`.
- Home Assistant REST/WebSocket adapters for mapped lights, switches, buttons,
  media players, environment sensors and home/away status.
- Confirmed-away gating for automatic light/prelight activation and music
  automation, while preserving explicit dashboard controls.
- Built-in light presets and room-scene convergence; local persistence for
  logical lighting intent only.
- Music presets, play/pause and volume policy through HA media-player entities,
  including the 23:00 start cutoff and Stockholm daily volume curve.
- Custom Bed/Desk room dashboard, separate from Home Assistant, served and
  monitored through DashCast.
- Local onboarding, configuration validation, read-only commissioning
  preflight and systemd user-service support.

See [MVP status](MVP.md), [Operations](OPERATIONS.md) and the [delivery map](DELIVERY_MAP.md)
for implementation detail and evidence boundaries.

## Next product work

### Configuration and access

- Build the general human-facing configuration site and finish its Clerk
  authentication flow.
- Support safe edits to Home Assistant entity maps, display roles, light
  presets, quiet hours and home-presence entity without hand-editing JSON.
- Document how operators rotate HA, MQTT, API and Hub secrets.

### Routines and inputs

- Add declarative Good Morning / Good Night routines, scheduling and
  cancellation.
- Add configurable capability bindings for other remotes and input sources.
- Keep routine or button-triggered actions routed through the typed capability
  layer.

### Music integration

- Validate preset selection, Optical behavior, volume feedback and pause/resume
  against the installed Home Assistant media-player integration.
- Decide whether direct WiiM transport adds useful capabilities beyond HA.
- Tune fade and command-attribution policy only with measured device feedback.

### Operations and diagnosis

- Add integration acceptance for live event freshness, mapped entities, Hub
  rendering and physical device response.
- Make receiver-specific dashboard errors and service health easier to inspect.
- Consider migrations or a small database if configuration and persisted
  state outgrow the current JSON/runtime boundary.

## Later, after deterministic behavior is dependable

- Computer context through HASS.Agent or another existing Home Assistant
  integration.
- Optional trajectory-based intent, personal schedules, voice and learned
  scene suggestions.
- More environment or air-purifier automation.

These remain optional; core lighting, presence and music must stay usable
without AI or a cloud decision service.
