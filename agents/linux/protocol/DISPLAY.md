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

**There is no feedback.** A monitor may ignore the request, wake by itself on
input or a signal change, or be switched off physically. `applied` therefore
means _the desktop accepted the request_ (the command exited successfully),
never that the panel is dark or lit. `last_command` in the state is the last
request this connection executed, not an observation of the display. Consumers
that need evidence should measure it elsewhere, for example with a power-metering
smart plug; Lugn can do this (see `docs/COMPUTER.md`).

Requests are idempotent: asking for `off` twice is harmless, which is why a
controller may repeat it at a low rate to cover a display that woke again.

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

`failed` is a non-zero backend exit, `unavailable` a missing program or backend.
`uncertain` means the backend did not finish in time and the request may still
have landed. Never infer success from a missing acknowledgment, and treat
`uncertain` as "retry later, subject to backoff".

A bounded cache of 64 command IDs deduplicates redelivery: the same payload
returns the cached acknowledgment without repeating the action, and reusing an
ID with different fields is `id_conflict`. This is bounded deduplication, not
exactly-once delivery or durable history.
