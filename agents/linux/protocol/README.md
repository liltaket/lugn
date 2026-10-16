# Computer MQTT contract v1

Canonical contract shared by the standalone Linux publisher (PR1) and the
separate Lugn ComputerMqttAdapter (PR2). JSON schemas and example fixtures in this
directory define exact wire names. No Lugn integration is included in PR1.

## Topics and deliveries

Default prefix: `lugn/computers`; device ID: 1–64 ASCII letters, digits, `_`, `-`, starting with a letter or digit.
Configure a unique device ID per computer and use one publisher per device.

- `{prefix}/{device_id}/state`: QoS 1, retained, complete state snapshot.
- `{prefix}/{device_id}/availability`: QoS 1, retained, online/offline.
- `{prefix}/{device_id}/events`: QoS 1, **not retained**, `state_changed`
  notification. No event history or offline queue. An event points to a state
  snapshot with the same session, sequence and timestamp; it carries no authority.

In default observation-only mode, the publisher subscribes to **no MQTT topics**;
broker ACLs need publish access only to those three topics. Separate opt-in
[CONTROL v1](CONTROL.md) adds targeted Pause/owned Resume without changing any
observation v1 schema or delivery rule.

All fields shown in the schemas are required, including nullable fields. `null`
means unknown/unavailable, never false. `media: []` means discovery succeeded and
found no players; `media: null` means discovery failed. Unknown API state is
cleared on connection loss; supported sources retain unchanged observations while
their subscriptions remain healthy. `active_application: null` also covers no
focused window (including desktop focus). No window captions, URLs or artwork
are collected. Media titles/artists/albums are published; protect broker access.

## Liveness, clocks, sessions and ordering

`schema_version` is 1. `device_id` must match the topic. Each process start creates
a random UUID `session_id`, unchanged across MQTT reconnects. `sequence` starts
at 1 and increases for **every state publication**, including heartbeat and
reconnect. Values are positive integers within JSON's safe integer range.
QoS 1 duplicates have the same session/sequence; delivery is not exactly once.

`timestamp_ms` is wall-clock UTC Unix milliseconds when the agent assembles the
publication. It is neither elapsed time nor a per-input-event timestamp.
`heartbeat_interval_ms` defaults to 30000 (configurable 5000–300000).
`reason` is `startup`, `change`, `heartbeat`, or `reconnect`. The initial broker
connection publishes startup; subsequent connections publish reconnect, using
the **current** snapshot. Changes while offline are coalesced, never replayed.
Heartbeat renews the publication timestamp and sequence even if inputs do not
change. Pending changes during a slow PUBACK are coalesced into the latest state.
Events accompany only live `change` snapshots; startup/reconnect/heartbeat do not
emit events. Consumers must not depend on receiving every transition.

Availability has exactly `schema_version`, `device_id`, `session_id`, `status`.
Status is `online` or `offline`. Retained Last Will is offline, QoS 1; it is
configured before CONNECT. Graceful shutdown attempts offline and waits for its
PUBACK before DISCONNECT. Availability has **no timestamp**: a Last Will cannot
know its emission time. MQTT keepalive is 20 seconds; broker LWT timing follows
MQTT failure detection, not an immediate physical power/network event.

The publisher queues online before state, but consumers must tolerate either
arrival order across subscriptions. On a new online session, invalidate previous
state. Offline for an older session must not invalidate a newer online session.
On broker reconnect invalidate local liveness; wait for a new **non-retained**,
fresh state and matching online availability. Retained state alone never proves
liveness, even if recent. Availability itself may be retained.

Recommended consumer rules:

1. Validate topic identity, schema, session and safe-integer sequence/timestamp.
   Ignore unknown schema versions. Handle duplicates separately per topic.
2. Require online availability with matching session before using state. Either
   message may arrive first. Buffer at most the latest candidate state.
3. Bound wall-clock age (for example 3 heartbeat intervals) and future skew
   (for example 5 seconds). Also expire by monotonic elapsed time since the last
   accepted fresh snapshot. Do not accept out-of-order sequence within a session;
   switching sessions requires matching online availability.
4. Drop retained events; events never refresh state freshness, replace a snapshot,
   or revive an offline computer. Deduplicate events independently of state.
5. Offline, missing availability, expired state or malformed input is unavailable,
   not proof the user left the room. Published `network_online` describes
   NetworkManager Internet connectivity, separate from agent availability.

## Observations versus inference

`locked`: KDE ScreenSaver GetActive/ActiveChanged. `idle`: compositor idle
notification at the configured threshold (v1 respects idle inhibitors). Idle
begins relative to subscription creation; startup does not reconstruct elapsed
idle time. `network_online`: NetworkManager Connectivity full=true,
none/portal/limited=false, unknown=null. No active network probes are requested.
`active_application`: KWin desktopFileName (`app_id`), resourceClass and fullscreen.
`audio`: running PipeWire Stream/Output/Audio nodes, with reported application
names and media roles. Running is stream state, not proof samples are audible;
muted/zero-volume/silent streams may count. Capture and sink device nodes do not.
`media`: MPRIS players sorted by bus name; metadata can be null. Playback status
is Playing/Paused/Stopped or null. `content_type` is explicit xesam:contentType,
not inferred from URL, title or browser identity.

`inference` is advisory, separate from observations. Precedence:
locked/idle → idle; configured active game app ID or `steam_app_` resource class
→ gaming; configured video/music app ID plus playback evidence → video/music;
playing MPRIS explicit video/audio content type → video/music; focused app →
desktop; otherwise unknown. Fullscreen alone does not establish video/gaming.
Rules match exact KWin app IDs, case sensitive. No process scans or title matching.

Producer bounds: strings ≤512 UTF-8 bytes; media ≤64, artists per player ≤64,
audio applications/roles ≤128 each; aggregate serialized media and audio each
≤96 KiB. Full
snapshots remain below 256 KiB. Truncation limits telemetry, not desktop behavior.
