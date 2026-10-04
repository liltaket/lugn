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

The runtime maps Lugn semantic light IDs to Home Assistant light entities and
dispatches through the REST API. `HomeAssistantWebSocketTransport` handles
authentication, `state_changed` subscription and bounded reconnects; the host
supplies credentials and forwards events to the adapters. Startup also makes
one read-only `/api/states` query to seed configured observations. Transport
creation and HTTP fetch are injectable. Live state is time-dependent: query
Home Assistant and Lugn when checking a current home/away state; this document
does not claim that the resident is home or that a physical device reached a
requested state.

### Home and room presence

`homeAssistant.homePresence.entity` accepts one `person.*` or
`device_tracker.*` entity and defaults to `device_tracker.lustigkurre` in
`config.example.json`. The Home Assistant REST state snapshot seeds the initial
value; WebSocket `state_changed` events update it. `home` maps to home,
`unknown` and `unavailable` map to unknown, and other named zones (including
`not_home`) map to away.

This state is separate from STL27L room occupancy. Explicit away suppresses
automatic room-scene activation, prelight, music start/resume and automatic
volume changes; it pauses music that is playing. Confirmed-empty light-off and
music pause remain active. Unknown is displayed but does not count as away.
Manual dashboard requests are still permitted while away. The room dashboard
shows both statuses so that `room occupied` and `resident home` cannot be
mistaken for the same signal.

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

### Configured buttons

`homeAssistant.buttons` is an explicit semantic allowlist from Lugn IDs such as
`button.pc_lock` to Home Assistant `button.*` entities. The runtime exposes
only `button.press({ target })` for these mappings and dispatches the fixed
Home Assistant `button.press` service with the configured entity ID. Entity IDs
and service names are not accepted as capability inputs, and there is no
arbitrary Home Assistant service-call capability. Empty mappings leave this
capability without any invokable target.

The read-only discovery command lists button entity IDs, while commissioning
preflight checks that configured button entities are present. Neither operation
presses a button. A successful capability result means Home Assistant accepted
the request; this adapter has no button completion feedback and cannot confirm
that a device carried it out. This uses entities already exposed through Home
Assistant; it is not a separate native Windows or HASS.Agent adapter. See
[Running Lugn](OPERATIONS.md#home-assistant-buttons) for setup and use.

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

Fast-path timing records include elapsed milliseconds from local MQTT callback receipt to the engine decision, first command dispatch, first feedback attributable to a Lugn command, and full convergence. Elapsed values use a monotonic clock and remain separate from wall-clock timestamps. They measure only the Lugn process after MQTT delivery; measuring sensor publication, broker/network delay, or physical light response requires live instrumentation at those boundaries.

## Music players / WiiM through Home Assistant

The implemented `HomeAssistantMusicAdapter` maps semantic `music.*` targets
to distinct Home Assistant `media_player.*` entities. It dispatches fixed
play, pause, set-volume, select-source and play-media services. Per-target
source allowlists use exact names from the entity's `source_list`; Spotify DJ
preset `1` and Optical preset `4` are the defaults and can be overridden in
config. The Hub dashboard exposes those two preset actions, play/pause and
5-point volume buttons, but no source selector.

The `MusicAutomation` policy handles room-empty pause, short-context resume,
entry autostart before 23:00, confirmed-away gating and the daily volume curve.
See [Music](MUSIC.md) for exact behavior. The selected preset cannot be
confirmed from current Home Assistant observations. Direct WiiM transport is
not implemented, and software fade timing has not been measured against the
connected WiiM.

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

BILRESA button events come from Home Assistant `event.*` entities and enter
Lugn through the same WebSocket `state_changed` stream as other observations.
The four default entity IDs preserve the two event entities per physical button
used by the previous Bruno Intelligence Engine; deployments can override those
IDs in `homeAssistant.bilresa`.

Only an advancing event entity timestamp counts as a new remote action.
Availability changes, attribute updates, and restored historical states establish
or retain the timestamp baseline without replaying a gesture. Repeated presses
from one entity remain supported; the adapter separately deduplicates mirrored
entities and paired long-press/release events.

The room remote has these fixed, predictable actions:

| Input                                   | Action                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Button 1 short press (`multi_press_1`)  | Toggle between the active scene and **Helt släckt**.                                                                                 |
| Button 1 double press (`multi_press_2`) | Restore the last non-off scene (or the first available room scene).                                                                  |
| Button 1 long press (`long_press`)      | Toggle the configured **Sleep** scene; if none exists, toggle **Helt släckt** and the last scene.                                    |
| Button 2 short press (`multi_press_1`)  | Toggle automatic music-volume adjustment, leaving playback controls and lighting alone.                                              |
| Button 2 double press (`multi_press_2`) | Select **Helt släckt**.                                                                                                              |
| Button 2 long press (`long_press`)      | Toggle **Bilresa**: turn lights off and pause automatic volume adjustment; repeat to restore the last scene and prior volume policy. |

The earlier global passive switch is intentionally narrowed: short press on
button 2 affects automatic music volume only. Bilresa mode pauses that same
volume policy while maintaining an explicit room-off scene, which keeps sensor
reconciliation from lighting the room during sleep/away. A user-selected
dashboard scene remains an explicit command. Remote commands are attributed to
the physical remote in Lugn's command ledger.

## Nest Hubs / DashCast

The runtime serves custom Bed and Desk room pages on a separate display
listener and manages configured Cast receivers through DashCast. It yields to
active external casting and can restore its page after 90 seconds idle. The
Hub page is not a Home Assistant dashboard. DashCast app control is distinct
from page fetch/render confirmation; receiver-side evidence is needed to
verify what appeared on screen. Configuration and access boundaries are in
[UI](UI.md) and [Operations](OPERATIONS.md#lugn-nest-hub-dashboards).

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
