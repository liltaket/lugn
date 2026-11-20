# Display power requests v1

This additive contract leaves observation v1 and [CONTROL v1](CONTROL.md)
unchanged. `display_control_enabled` defaults to `false`. Enabling it requires a
configured MQTT username and password plus broker ACLs limited to the intended
device's topics. It accepts only a request to put the display to sleep (`off`)
or wake it (`on`). It offers no shell commands, no configurable command text and
no screen capture.

## What the agent does, and does not know

The agent runs one fixed command per request:

| Backend   | `off`                       | `on`                       | Chosen when              |
| --------- | --------------------------- | -------------------------- | ------------------------ |
| `kscreen` | `kscreen-doctor --dpms off` | `kscreen-doctor --dpms on` | `WAYLAND_DISPLAY` is set |
| `xset`    | `xset dpms force off`       | `xset dpms force on`       | only `DISPLAY` is set    |

`display_backend` (`auto`, `kscreen`, `xset`) can force one. Plasma Wayland needs
`kscreen-doctor`; Xwayland servers have no DPMS extension, so `auto` never
picks `xset` on Wayland. With no backend the agent still publishes state with
`backend: null` and rejects requests as `unavailable`.

**Feedback.** The agent samples the kernel's per-connector `dpms` state under
`/sys/class/drm/card*-*/` (connected connectors only; `Standby`/`Suspend` count as
off) every 2 seconds and every 100 ms while it verifies a request. It publishes it
as `power`: `on`, `off`, `partial` (outputs disagree), `none` (connectors exist but
none is connected, for example a monitor that dropped off the bus) or `unknown`
(the kernel offers nothing readable). On the reference desktop the kernel value
follows a `kscreen-doctor --dpms` request within 0.5–1.5 s. This is the GPU's view
of the picture signal, **not proof that the panel is dark**: a monitor can show its
own "no signal" message for a few seconds, or go to standby while the GPU still
sends a picture.

An `applied` acknowledgment therefore means the kernel state reached the target
within three seconds of the command exiting successfully. A command that exits 0
and changes nothing is `uncertain`/`not_observed`. This really happened on the
reference desktop (two of four early requests were acknowledged by exit status
while the picture signal never dropped, cause not established) and is why exit
status alone is not trusted. KWin also re-wakes the display on any input event. Where `power` is `unknown`, `applied` falls
back to "the command exited 0" and consumers must not assume the display changed.

Separately, `input_idle` reports whether there was no keyboard or pointer input
for `display_input_idle_secs` (default 120), using `ext_idle_notifier_v1` version 2
`get_input_idle_notification`, which **ignores idle inhibitors**. Observation v1's
`idle` honors them, so a playing video or a busy tool keeps it `false` and it
cannot tell a person from an inhibitor. `null` means the compositor cannot report
it. It is published only here, never in observation v1. `input_idle_since_ms` is
an estimate of the last input (the idled event's time minus the timeout) while
`input_idle` is true, and null otherwise, so a controller can measure a long
stretch of inactivity with a short idle timeout.

`idle_blockers` lists what PowerDevil (`PolicyAgent.ListInhibitions`) says is
holding the machine awake, as at most eight `{app, reason}` pairs of up to 64
characters: for example a browser's "Playing video" or "Playing audio", or a
tool's "Agents are working". It is how a controller tells a film from music. It
is sampled every 15 seconds and is `null` (unknown, not "nothing") when it cannot
be read, for example outside Plasma. The method is deprecated upstream but still
served. Application names are published, so protect broker access as for media
titles.

Requests are idempotent: asking for `off` twice is harmless. With a reported
`power` a controller should send only to change the observed state and not repeat
blindly; the state's `power`, `outputs` (connector, `on`/`off`/`unknown`, at most
16), `power_changed_at_ms` and `last_command` (this connection's last request) let
it verify, and `input_idle` lets it avoid acting while someone is at the keyboard.

## Topics and wire limits

The root is `{topic_prefix}/{device_id}`, normally `lugn/computers/desktop`.

| Topic below the root | Publisher             | QoS | Retained | Maximum JSON payload |
| -------------------- | --------------------- | --- | -------- | -------------------- |
| `display/state`      | Agent                 | 1   | Yes      | 8,192 bytes          |
| `display/command`    | Authorized controller | 1   | No       | 4,096 bytes          |
| `display/ack`        | Agent                 | 1   | No       | 4,096 bytes          |

All schema fields are required, including fields whose value may be `null`;
unknown fields are rejected. Integers are limited to JSON's safe range. UUIDs are
canonical lowercase. Schemas: `display-state.schema.json`,
`display-command.schema.json`, `display-ack.schema.json`; fixtures:
`display-*.example.json`.

The agent subscribes only to its own `display/command` when enabled. Restrict
broker access so only the intended controller can publish commands.

## Freshness and identity

`session_id` is the observation v1 process UUID. `connection_id` is a fresh UUID
for each MQTT connection and is advertised only after the command subscription
received a successful SUBACK. It is the same nonce CONTROL v1 uses. State has its
own sequence starting at 1 per connection, ordered by
`(session_id, connection_id, sequence)`. Heartbeat follows observation v1
(default 30,000 ms). Timestamps are UTC Unix milliseconds.

Before sending, a controller must hold matching online availability and a fresh
live observation, **and** fresh live display state for the same session and
connection, with `backend` not `null`. Retained state can seed a display but never
authorizes a request. After a broker disconnect, invalidate authorization and
wait for new live state. Never queue commands while offline.

The agent drops retained command deliveries. The connection nonce and the short
expiry are the replay fences, so a delayed `off` can never be executed later.

## Commands and acknowledgments

A command names the exact device, session and connection, a new UUID
`command_id`, `action` (`off` or `on`) and `issued_at_ms`/`expires_at_ms`. Use a
10-second delivery TTL. The agent accepts at most 15,000 ms, requires expiry
after both issue time and now, and allows issue time at most 2,000 ms ahead. A
backend call is also bounded by the remaining delivery budget (and five seconds).

Each acknowledgment echoes the identities with the agent's current
session/connection, `timestamp_ms`, `outcome` and `reason`:

| Outcome     | Reasons                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `applied`   | `display_off`, `display_on`                                                                                                   |
| `rejected`  | `retained`, `expired`, `invalid_command`, `wrong_session`, `wrong_connection`, `id_conflict`, `busy`, `unavailable`, `failed` |
| `uncertain` | `timeout`                                                                                                                     |

`failed` is a non-zero backend exit, `unavailable` a missing program or backend,
`no_output` that no connected output exists to act on. `not_observed` means the
command exited 0 but the kernel state did not follow (the display did not
change). `timeout` means the backend did not finish in time and the request may
still have landed. Never infer success from a missing acknowledgment, and treat
`uncertain` as "retry later, subject to backoff".

A bounded cache of 64 command IDs deduplicates redelivery: the same payload
returns the cached acknowledgment without repeating the action, and reusing an
ID with different fields is `id_conflict`. This is bounded deduplication, not
exactly-once delivery or durable history.
