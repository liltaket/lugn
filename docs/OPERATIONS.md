# Running Lugn

Lugn runs as a local Node.js service. The runtime controls configured Home
Assistant lights through the REST API, observes their state over Home Assistant
WebSocket, and can consume normalized STL27L events from MQTT. It does not read
the sensor's serial port or implement another LiDAR tracker.

## Requirements and configuration

- Node.js 22 or newer.
- A Home Assistant URL and long-lived access token.
- Optional semantic switches mapped to Home Assistant `switch.*` entities.
- Optional semantic music targets mapped to Home Assistant `media_player.*` entities.
- An MQTT broker reachable from the host running Lugn when using STL27L events.
- Semantic light IDs mapped to Home Assistant `light.*` entities.

Copy `config.example.json` to `config.json` and edit its URLs, topic, light
entity IDs, scenes, and prelight values for your installation. The JSON file
contains environment variable names for secrets, never secret values. Keep the
installation's `config.json` out of source control.

Provide the referenced environment variables in the service manager or shell.
For example, use your secret manager or a protected service environment to set
`HOME_ASSISTANT_TOKEN`, `MQTT_USERNAME`, `MQTT_PASSWORD`, and
`LUGN_API_TOKEN`. The API token should be a long random value. If MQTT uses
anonymous access, remove both MQTT credential references from the config.

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

Set `LUGN_CONFIG_PATH` to use a config file elsewhere, or pass a file path to
`npm start -- /path/to/config.json`. The service handles `SIGINT` and
`SIGTERM` by closing HTTP, MQTT, and Home Assistant WebSocket connections.
Startup and operational logs omit tokens and raw broker/HA errors.

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
