# Delivery map: local room-control slice

## Goal

Provide a locally runnable Lugn service that can consume the existing
STL27L service's MQTT events, control configured room devices through Home
Assistant, apply room and music policy, and present a custom dashboard to Nest
Hubs through DashCast.

This checkout contains that implementation. A local source build or read-only
integration query is not proof that this exact revision is deployed, that a
Cast receiver rendered its page, or that a physical device reached its target.

## Implemented

### Presence and automatic control

- `Stl27lMqttPresenceAdapter` maps fresh, trustworthy sensor observations to
  `occupied`, `confirmed_empty` or `unknown`; prelight remains a separate,
  bounded hint.
- Home Assistant home status is read from a configured `person.*` or
  `device_tracker.*` entity, defaulting to `device_tracker.lustigkurre` in the
  example configuration.
- Room occupancy and home/away are independent facts. A confirmed `away`
  suppresses automatic scene reconciliation, prelight and music starts/volume
  policy, and pauses music that is playing. Confirmed-empty light-off and music
  pause still run. Unknown home status is not treated as away.
- Explicit dashboard light and music actions remain available while away.

### Devices, runtime and dashboard

- Home Assistant adapters cover mapped lights, switches, buttons, media
  players, environment sensors and home/away status. Control inputs use
  semantic IDs and fixed service mappings.
- Light presets are assembled for the configured room. Scene requests start
  immediate dispatch and bounded convergence; confirmed-empty is a physical
  off overlay that retains logical intent.
- Music policy includes Spotify DJ preset 1, Optical preset 4, confirmed-empty
  pause, short-context resume, no automatic playback from 23:00 until 06:00, a
  Europe/Stockholm daily volume curve, and a 10-point reduction when the
  STL27L snapshot count is greater than one. An unknown count adds no person
  offset.
- The custom Hub dashboard is served separately from the loopback capability
  API. DashCast manager launches the Bed/Desk pages, monitors receiver state
  and yields to an active external cast.
- The runtime includes local onboarding, config checking, read-only preflight,
  graceful shutdown, command diagnostics and persisted logical lighting
  intent.

## Current integration evidence and limits

- Home-presence state and physical device behavior are live evidence, not
  durable properties of this delivery map. Query the configured Home Assistant
  entity and check current Lugn observations when commissioning.
- An accepted Home Assistant service call is not physical-device feedback.
  Check Lugn's observed state and command status, then confirm the actual
  device separately when commissioning.
- DashCast starting an application is not proof that the receiver fetched or
  rendered the dashboard. For live display issues, inspect a fresh poll or the
  Hub's visible error.
- Sensor event timing starts at local MQTT callback receipt. It does not
  include sensor-to-broker delay or physical lamp response.
- The active host may run a revision different from this checkout. Compare
  deployed commit/build and configuration before attributing runtime behavior
  to local changes.

The STL27L adapter consumes retained `/snapshot` and `/availability` plus a
recent live heartbeat. Availability must be online and quality `CERTAIN`; a
positive count means occupied and zero means confirmed empty. Offline, stale,
malformed or non-CERTAIN data maps to unknown. Lugn uses local heartbeat receipt
time for freshness because snapshot `updated_at` can remain unchanged across
healthy heartbeats. `/preview` is a separate non-retained prelight hint. See
[the sensor integration contract](INTEGRATIONS.md).

## Remaining work

- Live commissioning of the actual HA tracker, sensor feed, mapped lights and
  media player, with explicit verification for home/away and automatic gates.
- Per-receiver confirmation that Bed and Desk dashboards continue rendering
  and that recovery behaves correctly after an external cast or service
  restart.
- A full visual configuration editor, routines, and bindings for remote types
  beyond the configured BILRESA buttons remain outside the current delivered
  slice. The operational control panel supports optional Clerk sign-in.
- Validate the installed HA media integration's preset, Optical, playback and
  feedback behavior. Direct WiiM transport is not implemented, and software
  fade trajectories still need validation against the connected device.

For operator setup and credential handling, see [Running Lugn](OPERATIONS.md).
