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
- semantic light, switch, button and media-player mappings (plus optional
  direct LAN WiiM targets under `wiim.music`; see
  [Direct WiiM transport](WIIM-DIRECT.md));
- per-light `lightingControlModes` (`respect_manual` by default or opt-in
  `enforce` for continued retries; see [Lighting](LIGHTING.md#lighting-control-modes));
- one Home Assistant home-presence `person.*` or `device_tracker.*` entity;
- Home Assistant temperature, humidity, CO₂ and PM2.5 mappings;
- MQTT connection, topic and freshness window for STL27L events;
- optional computer observations through `mqtt.computers`, including opt-in
  presence-driven display sleep/wake per computer, with defaults here and live
  settings in the control panel (see [Computer integration](COMPUTER.md)),
  and the defaults for fast WiiM Optical switching (`opticalSwitch`, on by
  default), also tunable in the panel;
- prelight targets and duration;
- scenes and optional Bed/Desk Hub roles, Cast receiver addresses and tokens.

The example uses `device_tracker.lustigkurre` for home presence. Change it to
the correct entity for another installation. Explicit `away` gates automatic
lighting and music actions; home status is separate from room occupancy. See
[Presence](PRESENCE.md) for the behavior and [Operations](OPERATIONS.md) for
the full config shape.

The `/ui/` operational control panel can optionally use Clerk for human
sign-in. Lighting presets and volume automation preferences can be edited there;
other configuration still comes from the validated JSON file. See [Control panel authentication](OPERATIONS.md#control-panel-authentication).

Credentials are named in JSON but supplied through the process environment or
a protected secret file. Never put credential values in checked-in config.

## Future configuration goals

The `/ui/` operational panel supports optional Clerk sign-in, but it does not
edit general configuration. Its preset and volume editors share typed runtime
models. A broader configuration UI should edit the same validated
schema, while advanced users can inspect or export JSON. Potential areas for
visual editing include:

- device and adapter mappings;
- scenes and quiet-hour policy;
- music preset IDs and sources;
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
See [LAN desktop access](OPERATIONS.md) for the TLS proxy installer, local DNS,
certificate trust and LAN firewall setup. The API remains loopback-only and the
separate Nest Hub listener retains its own configuration.

## BILRESA event entities

The current BILRESA adapter reads Home Assistant `event.*` state changes. The
default configuration uses the four entity IDs retained from the previous room
engine; override `homeAssistant.bilresa.button1Entities` or
`homeAssistant.bilresa.button2Entities` when Home Assistant uses different IDs.
See [IKEA BILRESA](INTEGRATIONS.md#ikea-bilresa) for the gesture-to-room-action
mapping.

## 3D printer

`homeAssistant.printer` is optional. It follows one printer from
the Bambu Lab Home Assistant integration (`ha-bambulab`) and shows the print as
a live activity on the Hubs (see [Hub dashboard](UI.md#current-hub-dashboard)).
All entity IDs come from the device prefix, for example
`sensor.<entityPrefix>_print_status`, `_print_progress`, `_remaining_time`,
`_current_stage`, `_current_layer`, `_total_layer_count`, `_task_name`,
`_printer_name`, `_printable_objects`, the nozzle and bed temperatures,
`image.<entityPrefix>_cover_image` and `light.<entityPrefix>_chamber_light`.
The only command Lugn sends is `light.turn_on` or `light.turn_off` for the
chamber light, when someone taps the lamp button on a Hub; it never starts, pauses or
stops a print.

```json
"printer": { "entityPrefix": "a1_0123456789abcde" }
```

- `name` overrides the printer's own name sensor on the Hub.
- `resultVisibleMinutes` (default 20, 0–240) keeps a finished or failed print
  on the Hubs for that long after the status changed.

Lugn fetches the cover image through Home Assistant's image proxy with its own
token and serves it to the Hubs under an opaque per-cover link. The browser never
receives a Home Assistant URL or token.

## Photo frame

The Hubs' **Foto** page shows pictures from one public iCloud shared album
(Photos → the album → people → Public Website; use the `photos.icloud.com/shared/album/…`
link of an album upgraded in iOS 27). The link is a secret in practice: anyone
holding it can see the album, so it belongs in `config.json` only.

```json
"photoFrame": {
  "albumUrl": "https://photos.icloud.com/shared/album/…",
  "refreshMinutes": 30,
  "maxPhotos": 150,
  "cacheDir": "/optional/path"
}
```

Only `albumUrl` is required. The server reads the album anonymously (no Apple
account, nothing is signed in), downloads each new picture once, scales it to
at most 1024 px wide (landscape) or 640 px high (portrait) and keeps the copy,
with a tiny blurred backdrop, in `cacheDir` (default: `photo-frame` next to the
state file). Videos are skipped. The Hubs only ever fetch these local copies;
the album link and Apple's addresses never reach a browser. Places come from
`data/places.tsv` (GeoNames, CC BY 4.0), matched offline: no coordinates leave
the machine. Apple documents none of this; if it stops working, the cache keeps
showing what it has and `photo frame refresh failed` is logged.

### Photo analysis

```json
"photoFrame": {
  "albumUrl": "https://photos.icloud.com/shared/album/…",
  "intelligence": {
    "enabled": true,
    "modelsDir": "/optional/path",
    "home": { "latitude": 59.33, "longitude": 18.07 }
  }
}
```

`intelligence` is optional. With the models installed (`npm run photos:models`)
Lugn looks at each new picture once, on this machine, and finds faces and what
the picture shows, so the Hubs can show related pictures together and name the
group; people are named in the control panel under Inställningar → Foton.
`enabled: false` turns it off; missing models or a missing ONNX runtime leave
the frame working as before. `home` tells trips from days at home; without it
home is where most pictures were taken. Models, licences, the files written and
how pictures are grouped and named are in
[PHOTO-INTELLIGENCE.md](PHOTO-INTELLIGENCE.md).

## Persistence

The runtime stores versioned lighting and music intent in
`$HOME/.local/state/lugn/lighting-intent.json` by default. `statePath` in
`config.json` or `LUGN_STATE_PATH` in `lugn.env` may select another direct-child
file under `$HOME/.local/state/lugn/`. The file contains the selected scene,
logical baseline/effective values, property ownership, and the absolute
continuity expiry. An optional separately validated music section retains volume
baselines and manual holds, explicit Pause, policy enable state, temporary BILRESA
restore state and absolute music absence/resume deadlines. A saved confirmed
absence marker preserves deadline ordering; it is not current sensor presence.
The file never contains sensor measurements, observed device values,
pending commands, or command history. Writes are atomic and restricted to
mode `0600`. The systemd installer grants the service write access only to
that state directory.

After restart, Lugn restores logical lighting intent and its absolute
continuity expiry, starts with unknown presence and no prior observations or
command ledger, and obtains fresh Home Assistant observations without issuing
commands. It reconciles restored intent on the next confirmed occupancy unless
continuity has expired. A confirmed-empty heartbeat immediately after restart
still switches lights off but does not extend the restored deadline. Corrupt,
unsupported, or device/scene-mismatched state is ignored safely. Invalid music is
ignored independently of valid lighting. Music intent is restored before HA
seeding without replaying commands or fades. Explicit Pause remains independent
of continuity; unknown startup presence preserves valid volume ownership.
Music installations write version 2; the new reader accepts version 1, but old
binaries reject version 2. Lighting-only installations retain version 1.
Configuration remains separate. See [Lighting intent
persistence](OPERATIONS.md#lighting-intent-persistence) for service setup.

Presence feedback (exit grace and chime) is a separate small file next to it,
`<state file>.presence-feedback.json`, written the same way and edited from the
Närvaro page. An unreadable file keeps the defaults (no grace, no chime) and
blocks saving instead of being overwritten. The only file configuration is the
optional `presenceFeedback.audioDevice`, an ALSA device name for the chime.

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

## Saved volume automation preferences

`/ui/` supports a focused typed volume settings editor. Settings are stored in
`<statePath>.volume.json` with atomic serialized writes and loaded before HA
state seeding. Include this file in state backups. With no saved preferences,
the existing daily curve, −10pp multi-person offset, 5–80% limits and existing
persisted enable intent remain in effect. Invalid/unreadable saved preferences
fall back to existing defaults with a warning and block writes to avoid data
loss. A separate optional settings marker in music intent lets later BILRESA
toggles survive restart when preferences match, while newly saved preferences
win over older intent after a crash between the two writes.

`autoBaseVolumes` maps each semantic music target to its fixed 0..1 Auto base
(for example, `{ "music.room": 0.4 }`). Targets without an entry use 0.3.
Only an explicit settings save changes that base; physical/HA/dashboard volume
adjustments and fades change a separate manual reference. Auto uses configured
base + daily offset + person offset, clamped to minimum/maximum.

`passiveMultiPersonReductionEnabled` defaults to `false`, including when loading
older settings documents. Enabling it applies the configured person offset to
the manual reference while occupied, home and available; it does not apply the
daily curve. Repeated count samples do not accumulate discounts. Unknown/empty
presence, away and unavailable players suppress volume corrections while
retaining Manual mode for a short absence. Manual resets after 20 minutes of
confirmed room absence, or 20 minutes after a newer manual adjustment made while
absent. Mode and manual reference persist separately from automatic preferences. Legacy inferred/user baselines are never promoted into
the configured Auto settings during upgrade; review the fixed base in the editor.
