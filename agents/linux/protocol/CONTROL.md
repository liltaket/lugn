# Targeted media control v1

This additive contract leaves the observation v1 schemas and topics unchanged.
The observation-only statements in [README.md](README.md) describe the default
mode. `control_enabled` defaults to `false`. Enabling it requires a configured
MQTT username and password, plus broker ACLs limited to the intended device's
topics. Control accepts only targeted pause and lease-bound resume; it provides
no shell commands, arbitrary D-Bus methods, generic player selection, or
`PlayPause` toggle.

## Topics and wire limits

The root is `{topic_prefix}/{device_id}`, normally `lugn/computers/desktop`.

| Topic below the root | Publisher             | QoS | Retained | Maximum JSON payload |
| -------------------- | --------------------- | --- | -------- | -------------------- |
| `control/state`      | Agent                 | 1   | Yes      | 65,536 bytes         |
| `control/command`    | Authorized controller | 1   | No       | 8,192 bytes          |
| `control/ack`        | Agent                 | 1   | No       | 8,192 bytes          |

State contains at most 64 players. All schema fields are required, including
fields whose value may be `null`; unknown fields are rejected by the schemas.
Integers are limited to JSON's safe range, 0–9,007,199,254,740,991; sequence is
positive. Device IDs contain 1–64 ASCII letters, digits, `_` or `-`, starting
with a letter or digit. `player` is the exact well-known
`org.mpris.MediaPlayer2.*` D-Bus name, at most 255 bytes. UUID fields use the
canonical lowercase, hyphenated representation.

The agent publishes observation topics and `control/state`/`control/ack`, and
subscribes only to its own `control/command` when enabled. The controller reads
the matching observation, availability, control state and acknowledgment topics,
and publishes only that device's control command topic. Restrict these rights
with authenticated broker ACLs; keep unrelated clients from publishing commands
or spoofing telemetry. Lease tokens are authority within their guarded scope,
so protect broker access and logs.

## Freshness and identity

`session_id` is the same process UUID used by observation v1. `connection_id` is
a fresh UUID for each MQTT connection, including reconnects. A control nonce is
advertised only after the command subscription receives a successful SUBACK.
Control state has its own sequence: it starts at 1 for each connection and
increases on every control-state publication. Order and deduplicate it using
`(session_id, connection_id, sequence)`, independently of observation sequence.
The heartbeat interval matches observation v1: normally 30,000 ms, configurable
from 5,000 to 300,000 ms. Timestamps are UTC Unix milliseconds.

Before sending anything, Lugn must have matching online availability and fresh,
live observation state **and** fresh, live control state for this session and
connection. Apply both wall-clock age/future-skew checks and monotonic receive
age. Retained state can seed a display but cannot authorize an action. After a
broker disconnect, invalidate authorization and wait for new live state and
matching online availability. Never queue commands while offline. State and
availability can arrive in either order; acknowledgments do not refresh them.

The agent drops retained command deliveries. MQTT 3.1.1 clears the RETAIN flag
when a publication matches an existing subscription, even if its sender set
RETAIN. Consequently, RETAIN alone cannot reject every retained publication.
The fresh connection nonce, exact identities and short command expiry are the
replay fences. Controllers must still publish commands with `retain=false`.

## Commands

Every command names the exact device, session, connection, player bus name,
`player_instance_id` and `content_id` from current live state. Each new logical
command gets a new UUID `command_id`. Use a 10-second controller delivery TTL:
`expires_at_ms = issued_at_ms + 10000`. The agent accepts at most 15,000 ms,
requires expiry strictly after issue time and strictly after the current time,
and allows issue time at most 2,000 ms into its future. Waiting or processing
cannot extend the remaining delivery budget; expiry is bounded by wall and
monotonic time. Schemas express field bounds; the agent also checks these
cross-field, clock, identity and ownership rules.

For `action: "pause"`, `pause_command_id` and `resume_token` must be `null`.
`lease_ttl_ms` must be an explicit integer from 1,000 through 3,600,000; use
1,200,000 ms (20 minutes) by default. A missing or null TTL is invalid.

The agent freshly reads MPRIS properties and requires the exact player instance
and content, `PlaybackStatus=Playing`, `CanPause=true` and `CanControl=true`.
It then calls `Pause` and confirms `Paused` before issuing a lease. A player
already Paused is not claimed. An uncertain or unconfirmed pause grants no
ownership and no resume token.

The method reply alone is not confirmation. The agent waits on native events for
the expected raw transition, within the original command expiry and a three-second
confirmation window, then freshly checks the owner and properties again. It
does not poll, retry the method or claim ownership from a snapshot alone.
`CanPause` is required before dispatching Pause; an owned Paused lease and Resume
require playback capability (`CanPlay` and `CanControl`), not `CanPause`. A known
`CanPause` change alone does not establish user intent or revoke that lease;
unknown properties and loss of playback/control capability still invalidate it.

For `action: "resume"`, `lease_ttl_ms` must be `null`, while
`pause_command_id` and `resume_token` must exactly match the still-valid lease
from the applied pause. A resume uses its own new `command_id`. The agent
requires the same instance/content to have remained observably Paused, rechecks
the current properties and playback capability, and consumes the lease **before**
attempting `Play`. Resume cannot start an arbitrary player or recreate a lease.
Lease expiry uses both the original wall-clock deadline and a monotonic budget;
clock changes and repeated deliveries cannot extend it.
The agent also rotates the MQTT control connection after a wall-clock step of
more than two seconds relative to monotonic time. Command-cache retirement uses
a nondecreasing logical clock so a backward adjustment cannot make a retired
command executable again.

## Player and content generations

`player_instance_id` is an opaque UUID tied to the observed D-Bus owner instance.
`content_id` is an opaque UUID for an observed content generation, not a media
URL, track ID, metadata hash or stable cross-session identity. An observed
A→B→A transition creates three different generations. The agent compares a
bounded, full internal identity from track ID, URL and identifying metadata;
it accepts a usable track ID as either an object path or a string (needed for
Spotify's incorrect variant type), or an absolute `xesam:url` as a fallback.
Empty/sentinel IDs without a usable URL and semantic text alone do not establish
identity. An identifier must fit 4,096 bytes to establish eligibility; the full
metadata fingerprint is limited to 65,536 bytes. It does not publish URLs. Missing reliable identity produces `content_id: null`
and makes the player ineligible for control. Nullable playback status means
unknown, never Paused. Advertised capability flags do not replace the fresh
MPRIS checks performed for a command.

`pause_lease` is either null or an object with the originating pause command ID,
resume token and wall-clock expiry. Revoke a lease on observed Stopped or Playing
outside the agent's own transition, `Seeked`, content changes, owner changes,
unknown observations, D-Bus loss, MQTT disconnect or process restart. No lease
is stored on disk or restored after reconnect. A controller must discard its
local lease on any such invalidation and on any uncertain outcome.

## Acknowledgments and duplicate delivery

Each acknowledgment echoes the command's target and IDs, with the agent's
current session/connection, a publication timestamp, `outcome` and `reason`.
Only an applied pause returns a non-null `resume_token` and
`lease_expires_at_ms`. An applied resume consumes ownership and returns null for
both fields. `applied` means the requested outcome was confirmed; `rejected`
means the guards rejected the request; `uncertain` means a call or confirmation
could not establish a safe outcome. Never automatically retry an uncertain
action, and never infer lease ownership from it. A missing acknowledgment is
also not evidence of success. Malformed, oversized or uncorrelatable envelopes
can be discarded without an acknowledgment.

Reason values are exactly:

| Category                            | Reasons                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed outcome                   | `paused`, `resumed`                                                                                                             |
| Delivery, identity or configuration | `disabled`, `retained`, `expired`, `invalid_command`, `wrong_session`, `wrong_connection`, `id_conflict`, `busy`, `unavailable` |
| Target and ownership guards         | `unknown_player`, `player_changed`, `content_changed`, `not_playing`, `not_paused`, `not_capable`, `not_owner`, `lease_expired` |
| Call or confirmation status         | `timeout`, `unconfirmed`                                                                                                        |

The bounded in-memory cache holds 256 command IDs. While an entry is cached,
redelivery of the same parsed payload and ID returns the cached acknowledgment
without repeating an action. Reusing that ID with different fields is
`id_conflict`. Entries cannot be displaced before their delivery expiry just
to make room; when no slot can be freed, reject new work as `busy`. This is
bounded deduplication, not exactly-once delivery or durable history. There is no
offline command queue, event replay, persisted token or persisted lease.

## Accepted limit: guarded best effort

This feature deliberately provides guarded best effort, not an atomic
compare-and-swap operation against MPRIS. A manual Pause between the final
Playing read and `Pause` is indistinguishable from the agent's pause. A user
Stop or content replacement can occur between the final read and `Play`.
A sent method may complete after a timeout or disconnect; cancelling the local
request cannot retract it from the player.

The agent fails closed on observed guard changes, never retries an uncertain
action and grants no lease for an uncertain pause. These rules reduce risk but
cannot promise to recognize every manual race or prevent every late player
action. The user accepted this limitation; consumers must preserve it in their
UI and policy rather than present resume as an unconditional or atomic action.

## Canonical fixtures

The files share coherent device/session/connection/player/content IDs.
`control-pause.example.json` requests a 20-minute lease with a 10-second
delivery TTL. `control-ack-paused.example.json` confirms it, and
`control-state.example.json` shows the resulting owned Paused state.
`control-resume.example.json` echoes that exact lease and
`control-ack-resumed.example.json` confirms consumption. Their fixed historical
timestamps are illustrative, not currently valid commands. Tests and other
consumers should substitute a controlled clock when using them.
