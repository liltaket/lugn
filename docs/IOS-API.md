# Paired-device API (v1)

This is the server contract for Lugn's native iOS app. The machine-readable
contract is [api/openapi.v1.yaml](api/openapi.v1.yaml), generated from the Zod
schemas in `src/core/device-api.ts` with `npm run api:generate`. A test fails
when the committed document is stale. This page describes behaviour the
schemas cannot express.

## Reachability and transport

- One separate listener, **off by default**, configured under `device` in
  `config.json` (see [OPERATIONS.md](OPERATIONS.md#paired-device-api-native-app)).
- It is reached over Tailscale only. There is no WAN exposure and no port
  forward. The listener itself speaks plain HTTP and binds loopback; the
  recommended deployment puts `tailscale serve` in front of it so clients use
  HTTPS on the MagicDNS name (see [ios/REACHABILITY.md](ios/REACHABILITY.md)).
  Binding a LAN/Tailscale address directly stays possible but sends the token
  unencrypted whenever the tunnel is down.
- The client must send a Host header that exactly matches one of the
  configured `allowedHosts` (`host:port`). Anything else returns `421`.
- The API is for native clients. Requests carrying an `Origin` header return
  `403 browser_origin_not_allowed`, no CORS headers are sent, and `OPTIONS`
  returns `405`. There are no cookies.
- All JSON responses carry `Cache-Control: no-store` and
  `X-Lugn-API-Version: 1`. Errors use `{ "error": "<code>" }`, with `issues`
  for validation failures and `retryAfterSeconds` for `429`.
- iOS App Transport Security: with the recommended `tailscale serve` HTTPS URL
  the app needs no ATS exception. Plain HTTP (for example a loopback dev
  server in a Debug build) needs a narrowly scoped exception for that host only;
  do not ship `NSAllowsArbitraryLoads`.

## Pairing and tokens

1. The operator creates a one-time pairing code in the authenticated control
   panel API (`POST /ui/api/devices/pairing`) or on the host's loopback API
   (`POST /devices/pairing`). The code looks like `7K3Q-M9TD`, is valid for
   five minutes (60–900 s configurable per code) and can carry a subset of
   scopes. At most four codes are outstanding; ten wrong guesses invalidate
   all of them.
2. The app calls `POST /api/v1/pair` with `{ code, name, platform: "ios",
appVersion? }`. Codes are case-insensitive and the dash is optional.
3. The response contains `deviceId` and `token`. **The token is shown once.**
   Store it in the Keychain. Lugn stores only its SHA-256 digest.
4. Send `Authorization: Bearer <token>` on every other request.
   `GET /api/v1/me` confirms the token and returns the server clock.

### Pairing link and QR code

The control panel (Inställningar → Telefoner) shows the code as text and,
when it knows the server URL, as a QR code (byte mode, level M) that holds:

```text
lugn://pair?server=https%3A%2F%2Flugn.example.ts.net%3A8789&code=7K3Q-M9TD
```

- `server` is the percent-encoded base URL: an origin only
  (`https://host[:port]`, no path, no trailing slash). It comes from
  `device.publicUrl` in `config.json`, or from a field the operator fills in
  the panel. `code` is the pairing code with its dash.
- Scanning it with the system camera opens the app through the `lugn` URL
  scheme; the app's own scanner can read the same payload. Typing the code
  by hand stays supported, so the QR code is a convenience, not a
  requirement.
- Treat both values as untrusted input. Accept only `https` (or `http` for a
  loopback development server) origins, validate `code` with the same pattern
  as `PairRequest.code`, show the host before pairing, and never send an
  existing token to a server URL that came from a link.
- The link carries no secret beyond the five-minute, one-time code.

Tokens look like `lgn1.<deviceId>.<secret>` and are compared in constant time.
A `401` means the token is unknown or was revoked: discard it and ask the
user to pair again. Revocation also closes that device's live streams.

| Scope            | Grants                                       |
| ---------------- | -------------------------------------------- |
| `state:read`     | `GET /api/v1/state`, `GET /api/v1/events`    |
| `commands:write` | `POST /api/v1/commands`                      |
| `phone:ingest`   | `POST /api/v1/phone/observations` and config |

## Limits

| Budget (per device unless noted)    | Burst | Sustained |
| ----------------------------------- | ----- | --------- |
| Reads (`state`, `me`, config)       | 60    | 120/min   |
| Commands                            | 20    | 60/min    |
| Phone observation batches           | 30    | 60/min    |
| New event streams                   | 6     | 6/min     |
| Pairing attempts (per address)      | 5     | 5/min     |
| Failed authentication (per address) | 10    | 10/min    |

Exceeding a budget returns `429` with `Retry-After`. Request bodies are
limited per route (`x-lugn-max-bytes` in the OpenAPI document); larger bodies
return `413`. A body must be `application/json` (`415` otherwise).

## Provenance

The server derives provenance; the client cannot set it. A command from a
paired phone runs as a human actor `{ type: "user", id: "mobile:<deviceId>" }`
with `source: "lugn.mobile"`, so manual-override rules treat a phone tap like
any other explicit human action. Phone observations are never actor
commands; they are hints with their own provenance (see below).

## State: `GET /api/v1/state`

Returns a `StateView`: a compact DTO built for the app, not the engine's
internal `RoomState`. It never contains command ledgers, raw diagnostics or
timings. Top-level sections:

| Section       | Contents                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presence`    | `occupied` / `confirmed_empty` / `unknown` from the LiDAR sensor, `personCount` (null when unknown), `exitPending` countdown, continuity deadline and Home Assistant `home` / `away` / `unknown`. |
| `session`     | Room session `active` / `suspended` / `ended` / `none`.                                                                                                                                           |
| `lighting`    | Scenes (`id`, `name`, semantic `icon`, `canEdit`, `allOff`), the current scene, and per light `observed` versus `intent`, `matchesIntent`, `overridden` properties and availability.              |
| `music`       | Per player: observed playback/volume/source/track, allowed sources, presets, volume authority (`controller` you/lugn, `mode`, targets) and playback policy (`quietHours`, `manualPause`).         |
| `routines`    | Next runs with names, running routines and the Godnatt/God morgon plan. `generation` is needed for bedtime commands.                                                                              |
| `environment` | Temperature, humidity, CO₂ and PM2.5 with `observedAt` (null values when unavailable).                                                                                                            |
| `suggestions` | Active computer-context suggestions. They only suggest; nothing is applied without a command.                                                                                                     |
| `computer`    | Desktop availability, freshness and activity summary.                                                                                                                                             |
| `phone`       | Paired phones' latest hint signals with `fresh` flags, and typed `facts`. Never room presence.                                                                                                    |
| `health`      | Integration status.                                                                                                                                                                               |
| `why`         | Up to 30 newest plain-Swedish explanations, see below.                                                                                                                                            |

Rules the app must keep:

- `presence.state: "unknown"` is not empty and not occupied. Show it as
  unknown. `home.state: "unknown"` is not away.
- `lighting.lights[].intent` is Lugn's remembered effective intent. While the
  room is confirmed empty the lights are physically off but intent is kept,
  so `matchesIntent` can be false; that is expected.
- `name` on lights is derived from the semantic id. Lugn has no friendly light
  names; the app may map ids to its own labels.
- `music.targets[].playback.quietHours` is true from 23:00 to 06:00
  (Europe/Stockholm). Automatic playback never starts or resumes then; an
  explicit `music.play` from the phone is still a manual action.

### The `why` feed

Each entry has `text` (for example `Släckte: rummet är tomt` or
`Förtände inte: du är borta enligt Home Assistant`), `outcome` (`acted`,
`skipped`, `observed`, `failed`), `domain`, `trigger` (`Närvarosensor`,
`Telefon`, `Hub`, `Kontrollpanel`, `Rutin`, `Knapp`, `Home Assistant`,
`Manuellt` or null) and `conditions`. It is derived from the engine's existing
diagnostic ledger and music policy decisions, so it is bounded to what those
ledgers keep (the latest 256 diagnostics, 128 music decisions) and resets on
restart. `skipped` entries explain deliberate non-actions where Lugn already
records them: prelight suppression, away blocking, unknown presence, quiet
hours, manual pause and manual volume.

## Commands: `POST /api/v1/commands`

```json
{
  "requestId": "3c1f6a2e-0d4b-4e8a-9f7c-2a1b3c4d5e6f",
  "command": "lighting.activateScene",
  "input": { "sceneId": "scene.soft_light" },
  "reason": "optional, ≤200 chars"
}
```

- `requestId` is a client UUID. Retrying with the same id and identical body
  returns the stored answer with `replayed: true` and does not act twice
  (per device, 24 hours, last 256 ids, in memory). The same id with a
  different body returns `409 request_id_conflict`. A failed command is not
  stored; retrying it runs it again.
- `status: "accepted"` means Lugn took the intent. Physical confirmation
  arrives through state (`matchesIntent`, music `observed`). `confirmed` is
  returned only when the capability itself already observed feedback.
- Commands map to the existing capability registry; the phone cannot reach
  sensor configuration, presence feedback settings or the Govee bridge
  controls. `input` per command is in the OpenAPI document under
  `CommandInput.<command>` (`x-lugn-command-inputs`).
- `routines.bedtime`, `routines.action` and `suggestions.respond` use the same
  validated routes as the Hub and the panel. Bedtime needs
  `routines.generation` as `expectedGeneration` and its own `requestId`.
- Errors: `400 invalid_command_input`, `404 target_not_configured` /
  `scene_not_found`, `409` for policy refusals with the capability's code,
  `502 command_failed`.

## Events: `GET /api/v1/events`

Server-sent events with bearer authentication:

```text
retry: 5000

event: snapshot
id: f1x7e5a3c0de-7
data: {StateView}

event: patch
id: f1x7e5a3c0de-18
data: {"instanceId":"…","revision":18,"generatedAt":…,"sections":{"lighting":{…}}}

event: heartbeat
data: {"instanceId":"…","revision":18,"serverTime":…}
```

- A `patch` replaces each listed section wholesale; sections not listed are
  unchanged. There are no field-level diffs.
- Event ids are `<instanceId>-<revision>`. Reconnect with `Last-Event-ID`
  (or `?lastEventId=` when the header cannot be set). If the instance matches
  and the revision is still in the engine's 128-update history, the first
  event is a `patch` with every section that may have changed, plus
  `routines`, `environment`, `suggestions`, `health` and `music`, which change
  outside the engine revision. Otherwise the first event is a fresh
  `snapshot`. A new `instanceId` always means a server restart.
- Several events can share an id because routine, suggestion and clock-driven
  changes do not advance the engine revision. Resume stays correct because
  those sections are always resent.
- Heartbeats every 15 s carry no id. Treat 45 s of silence as a dead stream.
  Streams end after 30 minutes; reconnect with `Last-Event-ID`.
- At most two streams per device: a third replaces the oldest. A slow client
  skips patches and receives a full `snapshot` once its socket drains.
- Use the stream only while the app is in the foreground. In the background,
  rely on `GET /api/v1/state` when the app wakes. There is no push channel
  yet; APNs can be added later as an additional channel without changing this
  contract.

## Fixtures

`docs/api/fixtures/` holds example payloads generated by the real engine,
view builder, registry and HTTP listener with simulated devices
(`npm run api:generate`). Tokens are redacted; ids, session UUIDs and
generations differ per run. A test validates every fixture against the
schemas. Copy them into the app's test fixtures.

For live, changing data during app development, run the device simulator
(`npm run device-sim`, see [ios/DEVSIM.md](ios/DEVSIM.md)). It serves this
same API from the real engine with simulated devices and a scripted day, and
can record and replay sessions for deterministic UI tests.

## Phone observations

`GET /api/v1/phone/config` tells the app which signals Lugn accepts, the
maximum observation age and each signal's freshness and retention windows.
Do not collect disabled signals.

`POST /api/v1/phone/observations` takes a batch (1–100, ≤64 KiB):

```json
{
  "sessionId": "5d0c4b9a-8e7f-4a6b-9c1d-2e3f4a5b6c7d",
  "observations": [
    {
      "eventId": "1a2b3c4d-0001-4e5f-8a9b-0c1d2e3f4a5b",
      "sequence": 1,
      "observedAt": 1794853683000,
      "type": "geofence",
      "zoneId": "home",
      "transition": "enter"
    }
  ]
}
```

| `type`       | Fields                                                                                |
| ------------ | ------------------------------------------------------------------------------------- |
| `app`        | `state`: `foreground`, `background`, `heartbeat` (last-seen)                          |
| `geofence`   | `zoneId` (`[a-z0-9_-]`, ≤32), `transition`: `enter` / `exit`                          |
| `power`      | `charging` (bool or null), `batteryLevel` 0–1 or null                                 |
| `focus`      | `mode`: `sleep`, `dnd`, `other`, `none`, `unknown`                                    |
| `wake_alarm` | `at` (ms epoch or null), `source`: `sleep_schedule`, `shortcut`, `manual`, `unknown`  |
| `motion`     | `activity` (`stationary` … `automotive`, `unknown`), `confidence`                     |
| `network`    | `kind`: `wifi`, `cellular`, `none`, `unknown`; `homeNetwork` (bool or null; no SSIDs) |

- `sessionId` is a UUID per app launch; `sequence` increases within it.
  `eventId` is a UUID per observation. Queue observations while offline and
  resend the same events: duplicates are harmless.
- `observedAt` is the device clock. Events older than
  `maxObservationAgeSeconds` (6 h by default) or more than 5 minutes in the
  future are rejected. Use `serverTime` in the response to estimate skew.
- Each result is `applied`, `duplicate`, `superseded` (`older_than_current`),
  `rejected` (`stale`, `future_timestamp`, `sequence_reused`) or `ignored`
  (`signal_disabled`). Drop rejected and ignored events from the queue; do not
  retry them.
- Lugn derives provenance from the token. Observations never mark the room
  occupied or empty and never run commands. See
  [PRESENCE.md](PRESENCE.md#phone-hints) for the fusion rules, including the
  optional, default-off arrival prelight hint.
- The `phone` section of the state view shows each device's latest signals
  with `fresh` flags and `facts` (wake alarm, Focus, charging). Stale signals
  are forgotten after their retention window: absence of events is unknown,
  not "still home". Phone state is memory-only and resets on restart.
- Without APNs, send observations when iOS wakes the app (geofence region
  events, background refresh, foreground). A `heartbeat` on foreground and on
  background refresh keeps `app` fresh.
