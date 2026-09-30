# Configuration and persistence

## Current configuration surface

The runtime reads a validated JSON configuration, usually copied from
`config.example.json`. `npm run config:check` validates it without contacting
Home Assistant, MQTT or a device. `npm run onboard` helps create an initial
configuration and protected environment file. The full graphical
configuration editor is future work; the custom Nest Hub dashboard is for
room control rather than configuration.

Current configuration covers:

- Home Assistant URL/token environment name;
- semantic light, switch, button and media-player mappings;
- one Home Assistant home-presence `person.*` or `device_tracker.*` entity;
- Home Assistant temperature, humidity, CO₂ and PM2.5 mappings;
- MQTT connection, topic and freshness window for STL27L events;
- prelight targets and duration;
- scenes and optional Bed/Desk Hub roles, Cast receiver addresses and tokens.

The example uses `device_tracker.lustigkurre` for home presence. Change it to
the correct entity for another installation. Explicit `away` gates automatic
lighting and music actions; home status is separate from room occupancy. See
[Presence](PRESENCE.md) for the behavior and [Operations](OPERATIONS.md) for
the full config shape.

The `/ui/` operational control panel can optionally use Clerk for human
sign-in. This does not provide a visual configuration editor; settings still
come from the validated JSON file. See [Control panel authentication](OPERATIONS.md#control-panel-authentication).

Credentials are named in JSON but supplied through the process environment or
a protected secret file. Never put credential values in checked-in config.

## Future configuration goals

A future configuration UI should edit the same validated schema, while
advanced users can inspect or export JSON. The current runtime does not yet
offer visual editing for:

- device and adapter mappings;
- scenes and quiet-hour policy;
- music preset IDs, sources, and volume schedule;
- routines and advanced remote bindings (BILRESA button events are configured
  under `homeAssistant.bilresa` in JSON);
- Hub roles and DashCast behavior;
- convergence, retry and diagnostic settings.

Avoid burying ordinary user behavior in hardcoded application logic as these
settings expand.

## BILRESA event entities

The current BILRESA adapter reads Home Assistant `event.*` state changes. The
default configuration uses the four entity IDs retained from the previous room
engine; override `homeAssistant.bilresa.button1Entities` or
`homeAssistant.bilresa.button2Entities` when Home Assistant uses different IDs.
See [IKEA BILRESA](INTEGRATIONS.md#ikea-bilresa) for the gesture-to-room-action
mapping.

## Persistence

The runtime currently persists a smaller first slice: the selected lighting
scene, desired lighting values, per-property ownership, and the confirmed-
empty continuity deadline. The versioned snapshot is atomically written to a
private JSON file under the service account's state directory. Device
observations, current home/room presence, music context and pending commands
are not restored. See [Lighting intent persistence](OPERATIONS.md#lighting-intent-persistence).

On restart, saved lighting intent can be reconciled with newly observed device
state. Stale physical commands are not blindly replayed.

## Later persistence needs

If the runtime grows, likely candidates include configuration versions,
device registry, scenes, routines, Hub settings, scheduling preferences and
selected continuity state. Migrations should be explicit so that an older
configuration or snapshot is never silently reinterpreted under a new schema.

## History and time

The current command and diagnostic histories are bounded in memory and are
not durable storage. They are intended to answer what event arrived, what
Lugn believed, which decision it made, what request it sent and what feedback
arrived. Sensor-to-process and physical response latency require separate
measurement.

Room and music schedules use Europe/Stockholm local time. Core time-dependent
behavior uses an injectable clock so it can be exercised deterministically.
