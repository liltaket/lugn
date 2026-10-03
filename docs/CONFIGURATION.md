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

The `/ui/` operational panel supports optional Clerk sign-in, but it does not
edit configuration. A future configuration UI should edit the same validated
schema, while advanced users can inspect or export JSON. Potential areas for
visual editing include:

- device and adapter mappings;
- scenes and quiet-hour policy;
- music preset IDs, sources, and volume schedule;
- routines and advanced remote bindings (BILRESA button events are configured
  under `homeAssistant.bilresa` in JSON);
- Hub roles and DashCast behavior;
- convergence, retry and diagnostic settings.

Avoid burying ordinary user behavior in hardcoded application logic as these
settings expand. The current `homeAssistant.buttons` map is an explicit
allowlist of semantic IDs to `button.*` entities; the runtime exposes only the
typed `button.press` action for mapped targets. Discovery and preflight do not
invoke the buttons. See [IKEA BILRESA](INTEGRATIONS.md#ikea-bilresa) and
[Running Lugn](OPERATIONS.md#home-assistant-buttons).

## Default scene and lighting intent

`defaultSceneId` is optional and must name one of the configured scenes. When
set, Lugn selects it as the default scene but waits for confirmed occupancy
before applying its lighting values. Unknown presence and startup observations
alone do not turn lights on. A confirmed-empty event continues to apply the
normal physical-off policy; a live preview may also apply configured prelight.
The onboarding wizard writes `scenes: []`; the runtime expands this to its
built-in room presets for the mapped lights. Onboarding does not write a
`scene.everyday` preset or set `defaultSceneId`.

## HTTP trusted origins

`http.trustedOrigins` defaults to an empty list. Direct requests must use a
loopback host. If Lugn is behind a TLS-terminating reverse proxy, add the exact
origin (scheme and host, without a path) and keep `bearerTokenEnv` configured;
the proxy must preserve the external `Host` header. Other host/origin pairs
are rejected to protect the loopback API against DNS rebinding.

## BILRESA event entities

The current BILRESA adapter reads Home Assistant `event.*` state changes. The
default configuration uses the four entity IDs retained from the previous room
engine; override `homeAssistant.bilresa.button1Entities` or
`homeAssistant.bilresa.button2Entities` when Home Assistant uses different IDs.
See [IKEA BILRESA](INTEGRATIONS.md#ikea-bilresa) for the gesture-to-room-action
mapping.

## Persistence

The runtime stores versioned lighting intent in
`$HOME/.local/state/lugn/lighting-intent.json` by default. `statePath` in
`config.json` or `LUGN_STATE_PATH` in `lugn.env` may select another direct-child
file under `$HOME/.local/state/lugn/`. The file contains the selected scene,
logical baseline/effective values, property ownership, and the absolute
continuity expiry. It never contains sensor presence, observed device values,
pending commands, or command history. Writes are atomic and restricted to
mode `0600`. The systemd installer grants the service write access only to
that state directory.

After restart, Lugn restores logical lighting intent and its absolute
continuity expiry, starts with unknown presence and no prior observations or
command ledger, and obtains fresh Home Assistant observations without issuing
commands. It reconciles restored intent on the next confirmed occupancy unless
continuity has expired. A confirmed-empty heartbeat immediately after restart
still switches lights off but does not extend the restored deadline. Corrupt,
unsupported, or device/scene-mismatched state is ignored safely. Music state and
configuration are not part of this lighting-intent file. See [Lighting intent
persistence](OPERATIONS.md#lighting-intent-persistence) for service setup.

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
