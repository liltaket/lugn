# Optical switch settings and state v1

This additive contract leaves observation v1, [CONTROL v1](CONTROL.md) and
[DISPLAY v1](DISPLAY.md) unchanged. It lets Lugn's control panel tune the agent's
fast WiiM Optical switching and shows what the agent is doing. The switching
itself never goes through MQTT: the agent talks to the WiiM directly.

Fast switching is **on by default** in the agent. Without any address it finds
the WiiM on the LAN (SSDP search, each candidate confirmed by the WiiM player
status). `optical_switch_enabled = false` turns it off in the agent's own file.

## What the agent does

When the computer plays sustained sound and the WiiM is not playing its own
music, the agent switches the WiiM to Optical itself:

1. The agent captures the sink monitor with `pw-record` and reduces it to one
   loudness decision per 20 ms frame. Samples are never stored, logged or sent.
   A run of sound counts when it lasts `min_audible_ms`, is mostly above
   `level_db` and tolerates gaps up to 200 ms, so a notification blip never
   switches.
2. The WiiM is read as soon as sound starts, so confirmation only has to send
   the switch. Already on Optical: nothing. Playing or loading its own source:
   nothing, re-read every two seconds while the computer keeps playing. Paused,
   stopped or idle: the switch is sent and then confirmed by reading the input
   back.
3. After a decision the agent waits for `release_ms` of silence before acting
   again, so a deliberate input choice is never fought. After three failed
   switches it gives up until the sound has stopped.

### The WiiM protocol

WiiM devices run LinkPlay firmware, which serves a small HTTP API at
`https://<host>/httpapi.asp?command=...` with a self-signed certificate. The
agent sends only two commands:

- `getPlayerStatus` returns JSON with `mode` (the selected input: `43` is
  Optical) and `status` (`play`, `pause`, `stop`, `load`).
- `setPlayerCmd:switchmode:optical` selects the Optical input and answers `OK`.

Both were verified against a WiiM Amp Ultra. Because the certificate cannot be
validated, the chain is not checked (handshake signatures are), and a host that
arrives over MQTT must be a private or link-local IPv4 address or a `.local` name.

## Topics

Under `<topic_prefix>/<device_id>/optical/`:

| Topic      | Publisher | QoS | Retained | Content                                         |
| ---------- | --------- | --- | -------- | ----------------------------------------------- |
| `settings` | Lugn      | 1   | yes      | [settings schema](optical-settings.schema.json) |
| `state`    | agent     | 1   | yes      | [state schema](optical-state.schema.json)       |

Settings from Lugn are used only when the agent has MQTT credentials and may
subscribe to `settings` (`optical_remote_settings`, default on). Without them the
agent keeps the values in its own file and `state` says `settings_source:
"config"`. The ACL needs subscribe on `settings` and publish on `state`.

## Settings

`generation` identifies the saved document. Every field replaces the agent's own
value except `wiim_host` and `audio_sink`: `null` there means "use the agent's
own setting, then discovery (host) or the default sink". The whole message is
ignored when any field is out of range, the device id differs or the host is not
on the LAN; the previous settings keep running.

| Field            | Range               | Meaning                                   |
| ---------------- | ------------------- | ----------------------------------------- |
| `enabled`        | boolean             | Off: the agent leaves the WiiM alone.     |
| `wiim_host`      | LAN host or `null`  | `host` or `host:port`.                    |
| `audio_sink`     | node name or `null` | Exact PipeWire sink the WiiM is wired to. |
| `min_audible_ms` | 200–5000            | Sustained sound needed before switching.  |
| `release_ms`     | 500–10000           | Silence that ends a run of sound.         |
| `level_db`       | -80 to -20          | Loudness a frame needs to count as sound. |

## State

Published on every change and as a heartbeat (`heartbeat_secs`). `phase` is
`disabled`, `searching` (no address yet), `idle` or `sound` (sustained sound is
playing). `capture` is `off`, `ok` or `unavailable` (no `pw-record` or sink).
`wiim` is what the last read showed (`reachable`, `optical`, `playing`) and is
`null` before the first read. `host_source` is `config`, `lugn` or `discovered`.
`discovered` lists the LinkPlay devices the last search found, so a panel can
offer a choice when there are several. `last_switch` records the outcome and,
for a success, the time from the start of the sound to the confirmed switch.
`settings_generation` is the generation of the settings in use, so a panel can
tell whether the agent has received what it saved.
