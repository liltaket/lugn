# Validation evidence and target acceptance

Validated on Kuffe (x86_64 Linux), 2026-10-16. The isolated software evidence and
the subsequent live desktop installation are distinguished below. The PR remains
Draft for the remaining interactive desktop acceptance checks.

## Automated evidence

- Rust stable 1.99.1: release build, rustfmt, Clippy all targets with warnings
  denied, and focused unit tests passed. Rust 1.85.1 `cargo check --locked` also
  passed against the committed lockfile.
- Unit tests exercise fragmented PipeWire JSON, partial patches/removals/ID reuse,
  exclusion of sinks/capture, collection and escaped-JSON payload bounds,
  multi-seat idle semantics, exact protocol fixtures, conservative classification,
  configuration validation and heartbeat identity. Twenty unit tests pass, and
  both private-bus integration tests pass when run explicitly.
- Private `dbus-run-session` fixtures exercise initial snapshots, lock/media/network
  signals, name loss/reacquisition and transient media failure recovery. A lock
  transition arrives within 500 ms while a media getter deliberately sleeps two
  seconds. A second fixture checks KWin script loading/reloading, caller ownership,
  rejected spoofed observations and cleanup. These are fake services on an
  isolated bus, not real KDE observations.
- The actual bundled KWin script passes fixtures for Plasma 5 and 6 naming,
  activation, fullscreen/app identity changes, loss of focus and removal of old
  signal listeners after repeated activation. This does not prove real KWin JS
  wrapper/property behavior.
- Real temporary Mosquitto 2.0.22 integration passed: 31 live payloads checked
  against the local schemas; retained state/availability for late subscribers;
  live retain flags; heartbeat timestamp/sequence; state/event matching;
  graceful shutdown offline acknowledgement; SIGKILL Last Will; new process
  sessions; broker restart, offline change coalescing and no event replay;
  resumed changes; rejected wrong credentials and environment password override.
- Installer shell tests and ShellCheck passed. An enabled graphical-target/unit
  fixture passed `systemd-analyze --user verify` using `/usr/bin/true` as its binary
  to avoid installing/running the service. Real login/start/stop/recovery behavior
  is still a target test. An unrelated host spice-vdagent unit warning was ignored.
- Existing Lugn baseline regression suite: 61 files, **782 tests passed**, plus
  its shell installer fixture; TypeScript build/typecheck, ESLint and repository
  formatting passed. The agent adds no Lugn runtime behavior.

Reproduction commands are in the [README](README.md#validate), and agent CI runs
the Rust, isolated-bus, KWin fixture, installer and real-broker checks. Network
sockets and D-Bus require a normal execution environment; the development sandbox
blocked them, so integration checks were rerun outside that sandbox. TLS certificate
handshake paths are supported through rumqttc/rustls but were not exercised here.

## Basic release resource measurements

Release binary: **7,050,816 bytes** (~6.72 MiB), stripped, thin LTO. Memory below is
resident memory read from `/proc/<pid>/stat`, not allocated heap or proportional
set size. Adding RSS double-counts shared pages. All samples exclude the broker.

Native PipeWire sample: fresh release process publishing to an isolated loopback
broker, heartbeat five seconds, actual `pw-dump` 1.6.2 subscription on the host's
otherwise unchanged graph. Session/system D-Bus and Wayland addresses were
intentionally unavailable, so this does **not** measure a complete live KDE setup.
After a two-second warmup, sample RSS every 0.5 seconds for 10.004 seconds:

- Agent peak RSS: **8,900 KiB** (~8.69 MiB).
- Native `pw-dump` peak RSS: **6,600 KiB** (~6.45 MiB).
- Summed RSS: **15,500 KiB** (~15.14 MiB).
- Each process accumulated **0 observed CPU ticks** at 100 Hz. Resolution is
  10 ms per counter; usage was below that tick resolution in this short sample.
  This is not proof of zero CPU use. No event storm or audio load was simulated.

The repeatable broker harness also measured the final release with a controlled
Python helper in place of PipeWire for six seconds: agent 6,283,264 bytes peak RSS,
helper 12,144,640 bytes, aggregate 18,427,904 bytes, zero observed CPU ticks. That
helper's memory is Python test overhead and is not part of the installed agent.

```sh
python3 tests/mqtt_integration.py --agent target/release/lugn-linux-agent \
  --broker /usr/sbin/mosquitto --password-tool /usr/bin/mosquitto_passwd \
  --measure-seconds 6
```

For representative target measurements, install `sysstat` if desired and sample
both the agent and its native helper during idle and active use:

```sh
agent_pid=$(systemctl --user show -p MainPID --value lugn-linux-agent)
helper_pid=$(pgrep -P "$agent_pid" -x pw-dump)
pidstat -u -r -p "$agent_pid,$helper_pid" 1 60
```

## Live Kuffe installation

After the final unit/isolated-bus/installer/KWin-fixture checks and successful
GitHub CI, release commit `5352fb8` was installed on Kuffe as
`lugn-linux-agent.service`, enabled for graphical-session startup. The binary is
`~/.local/bin/lugn-linux-agent`; configuration is private mode 0600 under
`~/.config/lugn-linux-agent/`. Existing Lugn MQTT credential references were
resolved privately, including their base64url encoding, without logging values.

Read-only subscriptions to the real `lugn/computers/kuffe/` topics verified
matching online/session identity, fresh non-retained snapshots, increasing
sequence and live change notifications. All six sources reported known values:
NetworkManager, lock, idle, active application/fullscreen, actual PipeWire
playback and MPRIS players. No collector errors were logged. This establishes
initial real API access; it does not prove every physical transition below.

A controlled SIGKILL of only the installed agent's main process verified actual
offline Last Will, systemd automatic recovery, a new process session and a fresh
snapshot with all sources known within **5,196 ms**. The KWin observer recovered
the already-focused application after restart. No synthetic payloads were sent
to real device topics, and no screen/input/window control was used.

Companion Lugn PR #65 release `21fa581` was then deployed on BrunoCAM by its
owner. An independent authenticated read of its real loopback `/state` API
returned HTTP 200 and `computer.devices.kuffe` as **online / fresh / live**,
with all normalized readings known. The sequence advanced from 16 in the
consumer owner's check to 18 in the independent check; source age was about
16 seconds, within the configured 90-second consumer freshness limit. Thus
the installed agent → existing MQTT broker → actual Lugn API path is verified.

## Remaining Kubuntu hardware/service checks

Use a private broker/topic and inspect state, availability and events together.
Verify the JSON schema and note the installed Plasma/KWin/PipeWire versions.

- Verify login starts the user service and clean logout stops it. Controlled
  crash recovery and new-session identity have already passed on Kuffe.
- Start with APIs ready, then stop/restart optional media/PipeWire services and
  verify null clearing and recovery without restarting the agent.
- Lock/unlock, leave input idle beyond the configured threshold, resume activity,
  and suspend/resume. Verify inhibitor behavior while a media app is playing.
- Switch native Wayland and XWayland applications; enter/leave fullscreen; close
  the focused window; focus the desktop; restart the agent with the same window
  focused. Verify there are no accumulating duplicate KWin subscriptions.
- Play/pause/stop PipeWire output, with and without MPRIS; test capture-only,
  multiple outputs, muted playback and players disappearing/reappearing.
- Verify real MPRIS metadata and configured application IDs for games/video/music.
  Generic browsers and fullscreen alone should not claim video/gaming.
- Disconnect the network/broker; verify retained offline/LWT and downstream
  freshness expiry; change apps while disconnected; reconnect and receive the
  current snapshot without obsolete transition events.
- Check broker credentials/TLS against the actual deployment and measure CPU/RSS
  under a normal idle desktop, playback and rapid application switching.

Older KWin versions without `ext_idle_notifier_v1` (including Plasma 5.27) keep idle
unknown. The Plasma 5 window-observer naming/path fallback is fixture-tested only.
