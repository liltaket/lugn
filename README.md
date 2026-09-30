# Lugn

**A local-first room controller for lights, music, presence and room displays.**

Lugn combines fast room-presence events with a deterministic state engine. It
controls configured Home Assistant devices, remembers lighting intent across
restarts, and serves a purpose-built dashboard to Nest Hubs through DashCast.
It is designed to be understandable when an automation makes a decision and
safe to use alongside physical controls and Home Assistant.

> **Current scope:** a working local runtime, custom Hub dashboard and
> operational control panel with optional Clerk sign-in. A general visual
> configuration editor, editable routines and direct WiiM transport are not
> part of the current runtime.

## What works

| Area          | Current behavior                                                                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room presence | Consumes normalized STL27L occupancy and prelight events over MQTT. `occupied`, `confirmed_empty` and `unknown` stay distinct.                                                                                                      |
| Home/away     | Reads a configured Home Assistant `person.*` or `device_tracker.*` entity. The example defaults to `device_tracker.lustigkurre`. Explicit `away` blocks automatic room activation and music; unknown status does not count as away. |
| Lights        | Home Assistant light mappings, room presets, temporary prelight, confirmed-empty shutoff, scene convergence and retries, and persisted logical lighting intent.                                                                     |
| BILRESA       | Button 1 toggles room scenes and Sleep; Button 2 short press toggles volume automation, and long press toggles Bilresa mode.                                                                                                        |
| Music         | HA player mappings, DJ/Optical presets, controls, volume curve and owner/target status; STL27L count above one adds a 10-point reduction.                                                                                           |
| Hub dashboard | Custom Bed/Desk DashCast pages with room occupancy and count.                                                                                                                                                                       |
| Room data     | Temperature, humidity, CO₂ and PM2.5 from configured Home Assistant sensor mappings.                                                                                                                                                |
| Local API     | Loopback-only HTTP health, state and typed capability routes.                                                                                                                                                                       |

### Automatic behavior

- A confirmed empty room turns configured lights off and pauses configured
  music while retaining room intent for a short return.
- A confirmed occupied event can restore the current light scene, except
  during quiet hours (23:00–06:00), when the selected scene is **Helt släckt**,
  or when Home Assistant explicitly reports **Borta**.
- Prelight is temporary and is suppressed if the room is already lit, the
  selected scene is fully off, quiet hours are active, or Home Assistant
  reports **Borta**.
- An explicit Home Assistant `away` state pauses playing music and blocks
  presence-driven music starts and automatic volume adjustments. Home status
  `unknown` is shown separately and does not itself block room automation.
- Manual dashboard actions remain available while away. The gate applies to
  automatic actions only.
- Music never starts or resumes automatically at or after 23:00. The daily
  volume curve lowers the baseline overnight and early morning; two or more
  people in the room add a further 10 percentage-point reduction.

See [Music](docs/MUSIC.md) and [Presence](docs/PRESENCE.md) for exact rules.

### Built-in light presets

The room dashboard offers five large buttons:

| Preset      | Effect                                                                        |
| ----------- | ----------------------------------------------------------------------------- |
| Helt släckt | Turns every configured room light off.                                        |
| Mysljus     | Warm, low accent lights; ceiling light off.                                   |
| Vardagsljus | Brighter warm accent lights; ceiling light off.                               |
| Filmkväll   | Warm accents dim; ceiling/front light/Cleverio bar off; monitor backlight on. |
| Fokus       | All configured lights on at 100% and 4000 K.                                  |

The exact semantic light target for the ceiling is selected from configured
targets; if no target looks like a ceiling light, Lugn uses the first configured
target.

## Quick start

Requires Node.js 22 or newer.

```sh
npm ci
cp config.example.json config.json
npm run onboard
npm run config:check
npm run build
npm start
```

The onboarding wizard writes configuration and a protected local environment
file. It discovers Home Assistant lights and asks for MQTT details, but it
does not call device services, publish MQTT, or start the service. Review the
generated config and update entity mappings to match your installation before
starting Lugn. See [Running Lugn](docs/OPERATIONS.md) for full setup, systemd,
Hub and recovery instructions.

To use a protected `lugn.env` for a local run:

```sh
chmod 600 lugn.env
node --env-file=./lugn.env dist/runtime/main.js
```

The standard capability API listens on `127.0.0.1:8787`. The optional custom
Nest Hub display listener is configured separately (example port `8788`) and
is intended for the trusted local network only.

## Home Assistant configuration

The example configuration maps home status to:

```json
"homePresence": {
  "entity": "device_tracker.lustigkurre"
}
```

Change that ID to the `person.*` or `device_tracker.*` entity that represents
the resident for your installation. Home/away is independent from STL27L room
occupancy: a person can be home while the room is empty, or away while a stale
room signal still says occupied. Lugn seeds the value from Home Assistant's
initial state query and follows later WebSocket state changes.

Credentials are referenced by environment variable name in the JSON config;
keep token and broker values in a protected environment file or service secret
store. Do not commit `config.json` or `lugn.env`.

## Dashboard

The Hub view puts the room presets first, with a clock/date, live room count,
home status, temperature, humidity, CO₂, PM2.5, and compact music controls.
Music buttons start Spotify DJ preset 1 or Optical preset 4; volume controls
change by 5 percentage points. The screen is designed to fit without scrolling.

Each Hub has a separate role and private path token. Lugn starts DashCast on
configured Cast receivers, yields while another cast is active, and can restore
its dashboard after the receiver is idle. DashCast control confirms that Lugn
started the cast app; it does not prove that the browser rendered the page.
See [UI, Nest Hubs and DashCast](docs/UI.md).

## Development

```sh
npm ci
npm run build
npm run typecheck
```

The core and runtime use typed state and capability schemas. The runtime keeps
physical observations separate from logical intent. Its local lighting
snapshot persists the selected scene, desired values, property-level overrides
and confirmed-empty continuity deadline. It does not restore old observations
or replay pending device commands after restart.

## Documentation

- [Running Lugn](docs/OPERATIONS.md) — onboarding, config, startup, dashboards
  and operational boundaries
- [Behavior model](docs/BEHAVIOR.md) — desired state, observed state and
  overrides
- [Presence and continuity](docs/PRESENCE.md) — room occupancy versus home
  status, prelight and short absences
- [Lighting](docs/LIGHTING.md) — presets, scene behavior and fast path
- [Music](docs/MUSIC.md) — presets, away gate, 23:00 rule and volume curve
- [UI, Nest Hubs and DashCast](docs/UI.md) — custom dashboard and receiver
  lifecycle
- [Integrations](docs/INTEGRATIONS.md) — Home Assistant, STL27L/MQTT and
  supported boundaries
- [Configuration and persistence](docs/CONFIGURATION.md)
- [MVP status](docs/MVP.md)
- [Roadmap](docs/ROADMAP.md)
- [Decisions and open questions](docs/DECISIONS.md)
- [Testing strategy](docs/TESTING.md)

## License

Lugn is source-available under the [PolyForm Small Business License 1.0.0](LICENSE).
This is not an OSI-approved open-source license.
