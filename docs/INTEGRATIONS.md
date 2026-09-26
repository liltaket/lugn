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

`PresenceEventIngress` validates normalized `presence.changed` events before forwarding them to the engine. The sensor-specific bridge must map its own protocol into `occupied`, `confirmed_empty`, or `unknown`; unavailable, startup, or tracking-loss states must not be mapped to confirmed empty. Raw LiDAR processing remains outside Lugn core.

`Stl27lPreviewMqttAdapter` can subscribe directly to the existing STL27L service's MQTT preview state, without routing presence through Home Assistant. Its default topic is `bruno/doorway/preview`, with exact `ON`/`OFF` payloads at QoS 0. The adapter emits a distinct `presence.prelight` event; it never changes occupancy. The host supplies its MQTT subscriber, and `PresenceEventIngress` can forward both normalized occupancy and prelight events to `LugnEngine.handleEvent`.

This preview topic carries no confirmed occupancy or empty state. Those still need a separate normalized sensor source. A host can wire the preview adapter to the common ingress like this:

```ts
const ingress = new PresenceEventIngress((event) => engine.handleEvent(event));
const preview = new Stl27lPreviewMqttAdapter(mqttSubscriber, (event) => {
  void ingress.accept(event);
});
preview.start();
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
