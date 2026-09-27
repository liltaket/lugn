# Running Lugn

Lugn runs as a local Node.js service. The runtime controls configured Home
Assistant lights through the REST API, observes their state over Home Assistant
WebSocket, and can consume normalized STL27L events from MQTT. It does not read
the sensor's serial port or implement another LiDAR tracker.

## Requirements and configuration

- Node.js 22 or newer.
- A Home Assistant URL and long-lived access token.
- Optional semantic buttons mapped to Home Assistant `button.*` entities.
- Optional semantic switches mapped to Home Assistant `switch.*` entities.
- Optional semantic music targets mapped to Home Assistant `media_player.*` entities.
- An MQTT broker reachable from the host running Lugn when using STL27L events.
- Semantic light IDs mapped to Home Assistant `light.*` entities.

Copy `config.example.json` to `config.json` and edit its URLs, topic, light,
button, switch and media entity IDs, scenes, and prelight values for your
installation. Keep `homeAssistant.buttons` empty if no button actions are
needed. Otherwise, map each semantic button ID to one `button.*` entity you
deliberately want Lugn to invoke; see [Home Assistant buttons](#home-assistant-buttons).
The JSON file contains environment variable names for secrets, never secret
values. Keep the installation's `config.json` out of source control.

Provide the referenced environment variables in the service manager or shell.
For example, use your secret manager or a protected service environment to set
`HOME_ASSISTANT_TOKEN`, `MQTT_USERNAME`, `MQTT_PASSWORD`, and
`LUGN_API_TOKEN`. The API token should be a long random value. If MQTT uses
anonymous access, remove both MQTT credential references from the config.
For a local checkout, a repo-root `lugn.env` is git-ignored; keep it mode
`0600` and never commit it.

## Interactive first-run setup

Run the commissioning wizard in a local terminal or interactive SSH session:

```sh
npm run onboard
```

It uses `$HOME/.config/lugn/config.json` when that installed config already
exists. Otherwise it writes `config.json` and `lugn.env` in the current
repository. Pass both output paths explicitly when needed:

```sh
npm run onboard -- /path/to/config.json /path/to/lugn.env
```

The wizard asks for the Home Assistant URL and a long-lived token, then makes
one read-only `GET /api/states` request and offers currently discovered light
IDs with Home Assistant friendly names when available. Display labels have
terminal control characters removed; the stable entity ID remains visible for
each choice. It also asks for the MQTT broker URL and STL27L base
topic, optional broker credentials, and optional brief entry-light targets
with a conservative brightness default. Color temperature is only applied if
you keep the default or enter a value; choose `skip` for lights that do not
support it. The wizard creates a separate random token for Lugn's loopback
HTTP API.

Secrets are entered without terminal echo. The wizard stores their base64url
encoding in environment variables ending in `_B64`, so Node and systemd read
the same one-line values even when a broker password contains punctuation.
This is encoding, not encryption; the config and secret files are written with
mode `0600`. The runtime decodes only environment references whose names end
in `_B64`, while existing plain environment variable names continue to work.
The wizard refuses symbolic-link targets and asks before replacing existing
files. It does not call Home Assistant services, publish MQTT, enable systemd,
or start Lugn. After setup, run the read-only preflight command printed by the
wizard and review the generated mapping before enabling the service.

The HTTP listener defaults to `127.0.0.1:8787` and only accepts loopback bind
addresses. Lugn's listener is plain HTTP. For remote access, keep the Lugn
listener on loopback and use a TLS-terminating reverse proxy on a trusted
network; do not bind Lugn directly to a LAN address or forward this port to the
public internet.

## Build and start

From the repository root, after setting the environment variables:

```sh
npm ci
npm run build
npm start
```

To load a protected repo-root `lugn.env` for a local run, use:

```sh
chmod 600 lugn.env
node --env-file=./lugn.env dist/runtime/main.js
```

Set `LUGN_CONFIG_PATH` to use a config file elsewhere, or pass a file path to
`npm start -- /path/to/config.json`. The service handles `SIGINT` and
`SIGTERM` by closing HTTP, MQTT, and Home Assistant WebSocket connections.
Startup and operational logs omit tokens and raw broker/HA errors.

## Discover Home Assistant mappings

Use the read-only discovery command to find current `button.*`, `light.*`,
`switch.*`, and `media_player.*` IDs before editing the mappings. The
media-player list includes `source_list`; current states and media titles are
not printed. It makes one Home Assistant `GET /api/states` request and does not
call device services:

```sh
npm run build
node --env-file=/secure/path/lugn.env dist/runtime/ha-discover.js \
  --url http://homeassistant.local:8123
```

The environment file should define `HOME_ASSISTANT_TOKEN`; the URL can also
come from `HOME_ASSISTANT_URL`. Keep the token in the environment file or a
secret manager rather than a command-line argument. The example URL was
verified on this host as a Home Assistant endpoint, but change it if Lugn runs
on a different network or installation.

## Read-only commissioning preflight

Before starting Lugn, run the preflight with the same protected environment and
configuration that the service will use:

```sh
node --env-file=./lugn.env dist/runtime/preflight.js
node --env-file=/secure/path/lugn.env dist/runtime/preflight.js \
  /secure/path/config.json
```

`npm run preflight -- [config-path]` builds and runs the same command. It makes
one authenticated Home Assistant `GET /api/states` request and checks that all
configured button, light, switch, and media-player entities are present. If
MQTT is configured, it connects to the broker and uses the runtime STL27L presence
adapter to verify an online sensor with a fresh, live, non-retained snapshot of
`CERTAIN` quality. It subscribes read-only to the configured snapshot,
availability, and preview topics; it never publishes MQTT messages or invokes
Home Assistant services. MQTT is reported as not configured when absent.

Output contains only categorical results and entity counts. It omits
credentials, URLs, hostnames, entity IDs, media titles, sensor payloads, and
raw external errors. MQTT checks are bounded; the connection is closed after a
fresh result, a connection error, disconnection, or timeout. A fresh feed proves
that the configured sensor contract is reaching Lugn at preflight time; it
does not prove physical light response or ongoing service health.

## Keep Lugn running with systemd

On Linux hosts with systemd, the repository includes a user-service installer.
It does not use `sudo`, connect to any configured service, or start Lugn during
installation. Build Lugn first, then run:

```sh
npm ci
npm run build
./deploy/install-user-service.sh
```

The installer writes a user unit under `$HOME/.config/systemd/user/`, and
creates `$HOME/.config/lugn/config.json` from the example only when no config
already exists. It creates an empty `$HOME/.config/lugn/lugn.env` with mode
`0600`; put the secret values referenced by the config there, one
`NAME=value` per line. Keep both files private. The installer prints the
resolved paths when it finishes. Edit the config with the actual Home
Assistant URL/entity IDs and the sensor's MQTT URL/topic before starting the
service. It also creates `$HOME/.local/state/lugn/` for the durable lighting
intent file and grants the service write access only to that directory. The
optional `statePath` config field or `LUGN_STATE_PATH` environment variable
must name a direct child of this directory. Validate the config and secrets without
contacting any service:

```sh
node --env-file="$HOME/.config/lugn/lugn.env" \
  dist/runtime/config-check.js "$HOME/.config/lugn/config.json"
```

When the checker reports a valid configuration, enable and start Lugn:

```sh
systemctl --user enable --now lugn.service
systemctl --user status lugn.service
journalctl --user -u lugn.service -f
```

A user service starts while the account's systemd user manager is running. For
automatic startup after a reboot before that user logs in, the host
administrator must enable lingering for the account using
`loginctl enable-linger <user>`. The service runs as the installing user and
keeps the HTTP API bound to loopback. Re-run the installer after moving the
checkout or changing the Node.js executable path.

## Room control panel

The loopback control panel is available at `/ui/`. From another computer,
open an SSH tunnel to the Lugn host:

```sh
ssh -N -L 8787:127.0.0.1:8787 <user>@<host>
```

Then visit `http://127.0.0.1:8787/ui/`. When the API bearer token is configured,
enter it in the panel to create a short-lived browser session. The browser does
not save the token. To read the configured token on the Lugn host, run this
command in a private terminal and paste its output only into the local panel:

```sh
node --env-file="$HOME/.config/lugn/lugn.env" -e '
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.env.HOME + "/.config/lugn/config.json", "utf8"));
const name = config.http.bearerTokenEnv;
const value = process.env[name];
process.stdout.write(name.endsWith("_B64") ? Buffer.from(value, "base64url").toString("utf8") : value);
'
```

For a TLS reverse proxy, add its exact origin to `http.trustedOrigins` (for
example, `https://lugn.example.org`) and keep `bearerTokenEnv` configured. The
proxy must preserve that host when forwarding to loopback. Lugn rejects
unconfigured hosts and cross-origin browser requests to prevent DNS rebinding.
The panel shows reported state and command feedback; a dispatch alone does not
prove a physical light changed.

## HTTP API

When `bearerTokenEnv` is set, send the matching bearer token to all routes,
including loopback requests. If it is omitted, unauthenticated access is
available only on the default loopback listener.

```sh
curl -sS -H "Authorization: Bearer $LUGN_API_TOKEN" \
  http://127.0.0.1:8787/health

curl -sS -H "Authorization: Bearer $LUGN_API_TOKEN" \
  http://127.0.0.1:8787/state

curl -sS -H "Authorization: Bearer $LUGN_API_TOKEN" \
  http://127.0.0.1:8787/capabilities

curl -sS -X POST \
  -H "Authorization: Bearer $LUGN_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"sceneId":"scene.cozy"},"requestId":"manual-1"}' \
  http://127.0.0.1:8787/capabilities/lighting.activateScene
```

`GET /health` reports integration connection states without credential details.
`GET /state` returns the read-only room snapshot. `GET /capabilities` lists the
registered typed operations. `POST /capabilities/<name>` validates its `input`
with the same schema used by the in-process capability registry. Invalid
requests return `400`; unknown operations return `404`. There is no arbitrary
Home Assistant service-call endpoint.

### Home Assistant buttons

Button actions are opt-in. Add a semantic ID and its exact Home Assistant
`button.*` entity under `homeAssistant.buttons`; the example configuration
leaves this mapping empty by default:

```json
"buttons": {
  "button.pc_lock": "button.desktop_lock"
}
```

The read-only discovery command lists available button entity IDs, and
commissioning preflight checks that every configured button entity exists. To
invoke a mapped target, call the fixed `button.press` capability:

```sh
curl -sS -X POST \
  -H "Authorization: Bearer $LUGN_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"target":"button.pc_lock"}}' \
  http://127.0.0.1:8787/capabilities/button.press
```

The input accepts only the semantic target. The adapter sends Home Assistant's
fixed `button.press` service for the entity in the configured allowlist; callers
cannot supply an entity ID or choose an arbitrary service. A response of
`{"accepted":true}` means Home Assistant accepted the request. Button entities
have no completion feedback here, so this does not prove that a device finished
the action or changed physical state. Map only deliberate button actions.

Optional switch entities are configured under `homeAssistant.switches`, keyed
by Lugn IDs such as `switch.desk_power`. Only configured switches are
controllable, through `switch.set` and `switch.getState`:

```sh
curl -sS -X POST \
  -H "Authorization: Bearer $LUGN_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"target":"switch.desk_power","state":true}}' \
  http://127.0.0.1:8787/capabilities/switch.set
```

For example, to set a mapped light directly:

```sh
curl -sS -X POST \
  -H "Authorization: Bearer $LUGN_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"target":"lighting.ceiling","values":{"power":true,"brightness":45}}}' \
  http://127.0.0.1:8787/capabilities/lighting.set
```

## Optional music players

Leave `homeAssistant.music` as `{}` when no music integration is configured.
For each player, configure one distinct entity and the exact allowed source
names from its HA `source_list`:

```json
"music": {
  "music.room": {
    "entityId": "media_player.living_room_wiim",
    "sources": ["Optical", "Bluetooth"]
  },
  "music.desk": {
    "entityId": "media_player.desk",
    "sources": []
  }
}
```

Replace these examples with actual installation entities and source names.
The Home Assistant integration must support the requested action. Lugn neither
creates a media integration nor automatically starts music on presence.

```sh
curl -sS -X POST \
  -H "Authorization: Bearer $LUGN_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input":{"target":"music.room","volume":0.35}}' \
  http://127.0.0.1:8787/capabilities/music.setVolume
```

Use `music.play` and `music.pause` with `{ "target": "music.room" }`, or
`music.selectSource` with `{ "target": "music.room", "source": "Optical" }`.
`music.getState` returns observed playback, volume, source, title, availability
and requested values. Check the matching command in `/state` for
`pending`, `confirmed`, `unconfirmed`, `superseded` or `failed`. Confirmation
means HA reported a matching value after request dispatch; physical playback
still needs observation at the device. A failed or timed-out command is not retried.

## Presence and prelight

The optional MQTT adapter subscribes to `${baseTopic}/snapshot`,
`${baseTopic}/availability`, and `${baseTopic}/preview`. It forwards retained
metadata to the STL27L presence adapter, which uses live heartbeat freshness
before accepting snapshot state. Configure `baseTopic` to the topic prefix
published by the sensor service. A stale/unavailable sensor does not become
`confirmed_empty`; preview only requests a bounded prelight and never changes
occupancy.

Set `prelight.targets` to the lights and values useful for a fast approach
response. The preview may arrive before the full occupancy event. Its temporary
lighting is bounded by `maxDurationMs` and then yields to a confirmed presence
or later explicit capability request. To disable prelight, use an empty
`targets` object.

Home Assistant's `/api/states` endpoint seeds initial observations at startup;
the WebSocket subscription supplies later `state_changed` updates. If the
initial query fails, Lugn stays available and waits for WebSocket observations.

## Operational boundaries

- The runtime speaks to configured systems only; it does not start, configure,
  or modify a broker, sensor service, or Home Assistant instance.
- MQTT credentials, Home Assistant tokens, and API bearer tokens must come from
  the process environment.
- A reachable MQTT broker does not prove that the sensor is present or fresh;
  check `/health` and the room state.
- Successful API acceptance means Lugn accepted a typed command. Check
  `/state` for observed convergence before treating the physical device as
  confirmed.
- No live Home Assistant, MQTT broker, or STL27L device is contacted by the
  build command.

## Runtime history and restarts

The in-memory state stream retains the newest 256 timing and diagnostic
records. Lighting and switch ledgers retain every pending command plus the
newest 256 terminal commands; the music ledger retains every pending command
plus up to 128 terminal commands. A command that has just completed after
remaining pending is preserved while the oldest other terminal record is
pruned. Old terminal records are pruned as new commands finish. Pending
lighting commands without matching feedback are
terminalized after the 60-second convergence timeout; switch and music
feedback time out after 10 seconds. These limits keep the runtime bounded in
normal operation while leaving active commands attributable until feedback or
timeout.

Runtime command history, command-ID attribution, Home Assistant observations,
sensor presence, diagnostics, and timing records are not persisted. The
separate lighting-intent file retains only the selected scene, logical desired
values, manual property ownership, and absolute continuity expiry. Restart does
not replay old physical commands; the new process starts with unknown presence,
seeds fresh Home Assistant observations, and waits for confirmed occupancy
before reconverging saved intent. Back up the installation config and secret
file separately; the runtime state stream is diagnostic history, not durable
storage.
