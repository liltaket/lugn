# Integrations

Integrations are adapters. They should not define core room behavior.

## Home Assistant

Home Assistant remains an important device and integration surface.

Expected uses include:

- controlling/observing lights
- exposing room state
- connecting existing entities
- bridging integrations that already work well in HA

Core decisions should live in Lugn rather than being duplicated in a large set of Home Assistant automations.

The first code adapter uses caller-supplied mappings from Lugn semantic light IDs to Home Assistant light entities. It sends light service requests through the REST API. `HomeAssistantWebSocketTransport` handles WebSocket authentication, `state_changed` subscription, and bounded reconnects; the host supplies credentials and forwards its events to the lighting adapter. Socket creation and HTTP fetch are injectable. No live Home Assistant instance has been configured or verified.

### Configured switches

`HomeAssistantSwitchAdapter` maps semantic IDs such as `switch.desk` to
configured Home Assistant `switch.*` entities. Each entity has one semantic ID.
The adapter dispatches only `switch/turn_on` and `switch/turn_off`, with an
`entity_id` body. It normalizes `on` and `off` observations; every other HA state
(including `unknown`, `unavailable` and a deleted entity) marks the device
unavailable with an unknown observed value.

The host forwards WebSocket `state_changed` events to
`acceptStateChangedEvent` and can supply initial REST state observations to
`acceptState`. HTTP dispatch has a 10-second transport timeout. A successful
service response means request acceptance. The engine separately waits for
matching state feedback and exposes pending or unconfirmed commands when
confirmation is missing. Switches are controlled through explicit typed
capabilities; presence and lighting scenes do not change them. See
[TOOLS.md](TOOLS.md) for confirmation and provenance semantics.

## STL27L / presence sensor

Expected normalized outputs may include:

- occupied / confirmed empty / unknown
- person count
- pre-entry signal
- last reliable position
- optional trajectory/direction
- health/heartbeat
- session/sequence identity where available

Trajectory should be treated as experimental context, not a core dependency.

`PresenceEventIngress` validates normalized `presence.changed` and `presence.prelight` events before forwarding them to the engine. The sensor-specific bridge maps its own protocol into `occupied`, `confirmed_empty`, or `unknown`; unavailable, startup, or tracking-loss states must not be mapped to confirmed empty. Raw LiDAR processing remains outside Lugn core.

`Stl27lMqttPresenceAdapter` subscribes directly to the existing STL27L service's MQTT outputs, without routing sensor data through Home Assistant:

- `/snapshot`: version 1 JSON, QoS 1, retained. `count`, `quality`, `confidence`, and `updated_at` are validated.
- `/availability`: exact `online`/`offline`, QoS 1, retained.
- `/preview`: exact `ON`/`OFF`, QoS 0, non-retained; this emits a separate `presence.prelight` event and never changes occupancy.

Occupancy is derived from `count` only after a **live non-retained heartbeat** has arrived within the configured freshness window (5 seconds by default), the MQTT broker is connected, sensor availability is online, and quality is `CERTAIN`. A positive count maps to `occupied`; zero maps to `confirmed_empty`. Disconnect, offline, stale/malformed data, or non-CERTAIN quality maps to `unknown`. The adapter uses local message receipt time for freshness: sensor `updated_at` is the last ledger-change timestamp and can remain unchanged across healthy periodic heartbeat publishes.

The host supplies an MQTT subscriber and updates the adapter's broker connection state. `PresenceEventIngress` forwards both normalized occupancy and prelight events to `LugnEngine.handleEvent`:

```ts
const ingress = new PresenceEventIngress((event) => engine.handleEvent(event));
const sensor = new Stl27lMqttPresenceAdapter(mqttSubscriber, (event) => {
  void ingress.accept(event);
});
sensor.start();
sensor.setBrokerConnected(mqttClient.connected);
```

The sensor service publishes preview transitions immediately and also republishes state periodically. The preview topic is non-retained, so a disconnected subscriber may miss a transition. The adapter filters duplicate states, and the engine bounds a configured prelight overlay with `prelight.maxDurationMs` (default 5 seconds; allowed 1–30 seconds). Configure `prelight.targets` with the small set of lights and values useful for entry. When preview ends before occupancy is confirmed, known prior values are restored; occupied and confirmed-empty events take over the lighting path.

This is a direct event path from the sensor-processing service to Lugn through the existing MQTT broker. It does not read the STL27L UART itself. The sensor service owns its serial reader, packet parser, calibration, tracking, and early-approach criteria; duplicating those in Lugn would create a second perception pipeline.

## WiiM

Important capabilities:

- playback
- volume
- fades
- source
- presets
- observed state

Presets should be first-class because they provide convenient preconfigured playback choices.

Optical source switching for computer use is useful, subject to ownership/continuity rules.

## HASS.Agent / Windows

The initial plan is to use HASS.Agent or an equivalent existing Windows bridge rather than immediately creating a custom Windows agent.

Useful initial context:

- online / heartbeat
- locked / unlocked
- idle/activity
- fullscreen state
- media playing / now playing
- game/activity classification where practical
- display-off command

Avoid collecting every possible PC metric merely because it exists.

A custom Windows agent remains a future option if existing tooling becomes a limitation.

## Monitor state

The monitor may not provide reliable direct on/off feedback.

A future optional smart plug used **for power measurement** can provide physical evidence of:

- active
- standby
- uncertain

The relay does not need to be used for normal automation.

Thresholds must be calibrated from real measurements and should account for transient behavior.

Automatic monitor wake is not MVP-critical.

Automatic monitor off must be conservative and must never rely only on a momentary LiDAR tracking loss.

Potential inhibit signals:

- recent mouse/keyboard activity
- active game
- fullscreen media
- PC usage state
- presence not confidently empty

## IKEA BILRESA

BILRESA remotes are input devices, not lighting-specific code.

Conceptually:

    button event
      -> configurable binding
      -> capability/tool call

Bindings may be context-sensitive, but should remain predictable.

A bedside remote can reasonably map the same stable button to:

- Good Night during evening context
- Good Morning during morning context
- a normal scene outside those contexts

The second remote can live near a desk or another useful control point.

Basic music control does not need to consume BILRESA buttons when a dedicated WiiM remote already exists.

## Nest Hubs / DashCast

Two display roles are expected:

- bedside
- main desk

DashCast management should keep the Lugn dashboard available while yielding to deliberate user casting.

## Environmental sensors

Temperature, humidity and air-quality sensors are intentionally non-critical.

The architecture and UI should make them easy to add without coupling them to the core presence/lighting/music engine.

Optional air purifier control can later be a small separate module with thresholds, hysteresis, missing-data behavior, and manual override.

## Home Assistant music bridge

The runtime's optional `homeAssistant.music` mappings connect semantic `music.*`
targets to distinct `media_player.*` entities, with a source allowlist per target.
Fixed play, pause, volume and source services support multiple players through
one HA connection. Observed attributes come from the startup state snapshot and
`state_changed` WebSocket events. See [Music](MUSIC.md) and
[Running Lugn](OPERATIONS.md) for the implemented boundaries and setup.
