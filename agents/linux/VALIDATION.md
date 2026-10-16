# Validation evidence and target acceptance

Observation baseline validated on Kuffe (x86_64 Linux), 2026-10-16; the control
extension was validated 2026-10-17. The isolated software evidence and
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

## Guarded control extension (2026-10-17)

The explicitly requested CONTROL v1 extension is opt-in; the original observation
v1 schemas and fixtures are unchanged. Its canonical contract, three schemas and
five coherent fixtures live under [protocol/CONTROL.md](protocol/CONTROL.md).

- Final Rust checks: 34 unit tests passed, rustfmt passed and Clippy all targets
  passed with warnings denied. The seven serial private-bus lifecycle tests and
  the separate MQTT wire test passed explicitly (42 automated tests; the opt-in
  host fixture is recorded separately below).
- Isolated fake MPRIS tests cover confirmed Pause/owned Resume, exact duplicate
  acknowledgment replay, conflicting IDs, retained/expired/old-epoch commands,
  manual transitions during GetAll/Pause, Seeked/Stopped, content A→B→A,
  owner replacement, lease expiry and reconnect invalidation. Ready raw revocation
  prevents the lazy D-Bus method future's first poll. A continuous ready-signal
  stream cannot starve its deadline. Clock tests cover monotonic expiry,
  command-cache retirement after rollback and MQTT epoch rotation after clock steps.
  Spotify's string-variant track ID and missing/wrong/NoTrack ID with a usable
  absolute URL are covered. URL-only content A→B→A and lost identity revoke leases;
  semantic text alone cannot authorize control. The full-broker fixture uses the
  same string-path variant observed read-only on Kuffe's real Spotify player.
  An actually sent Pause that times out grants no token; its eventual late Paused
  observation cannot restore ownership or cause another Pause/Play.
- A real temporary Mosquitto plus the full MQTT publisher/control actor and fake
  MPRIS player confirms Pause, duplicate suppression, owned Resume and rejection
  after a new epoch. These are isolated software tests; they do not control any
  desktop player. Backend unit/lifecycle/composition tests also pass on Rust 1.85.1.
- The final release preserves observation behavior in the real temporary broker
  harness: 31 live payload/schema checks, heartbeat, retained startup, graceful
  offline, crash LWT, broker restart/coalescing and credentials. All canonical
  control fixtures pass their schemas; installer, ShellCheck, KWin fixtures and
  repository formatting pass. Independent review findings were resolved.

Generic MPRIS has no atomic conditional Pause/Play. The documented manual-action
race and possible late completion of an already-sent method remain accepted
limitations. Neither successful software tests nor fresh telemetry establish
physical room/Optical behavior; that belongs to coordinated user acceptance.

The control-enabled release `811fe1e` was installed on Kuffe with a
protected binary/unit/config backup and `control_enabled=true`. A read-only
subscription verified fresh non-retained control and observation snapshots,
matching online session and all six observation sources known. The user service
was active with zero restarts and no connection/subscription errors. No synthetic
state was published on its real topics. Spotify was actually Playing with a
non-null content identity and both playback capabilities true; Firefox was
Paused with known identity and capabilities. Both had no owned lease. This
verification used subscriptions and metadata property reads only, without
invoking either real player's playback methods.

An explicitly requested production-broker check then registered only the silent
`org.mpris.MediaPlayer2.lugn_control_test` fixture on Kuffe's real session bus.
It started Paused, had no title or desktop alias, and required SIGUSR1 before a
bounded Playing phase. The companion deployment owner's actual BrunoCAM
`ComputerPlaybackMqttAdapter` used its loaded protected credentials to publish
exactly two commands through the real broker and installed `811fe1e` agent:
Pause acknowledged applied, matching owned Paused lease observed, Resume
acknowledged applied, then fresh Playing with no lease. This establishes the
actual command publish ACL and end-to-end control transport for the fake target.
The fixture confirmed **one Pause and one Play** and exited cleanly on Ctrl-C;
its D-Bus name was absent afterward and the agent stayed active with zero restarts.
The subsequent read-only MQTT probe confirmed the fake absent from control state,
only the normal Firefox/Spotify players, no leases, all observation sources known
and advancing live observation sequence in the same healthy session/connection.
During this fake-target check there were no Spotify/Firefox/user-player commands and no synthetic observation
publications. Actual room walks, WiiM Optical passthrough and user-media behavior
remain separate field acceptance checks.

### Normal Spotify pause and confirmation repair

Subsequent requested room-presence automation sent one actual Spotify Pause at
2026-10-16 22:41:33 UTC. Spotify became Paused, while the agent returned a correlated
`uncertain:unconfirmed` acknowledgment and granted no lease. No method was retried
and no Play or ownership reconstruction was attempted. A read-only GetAll afterward
reported Paused with CanPause, CanPlay and CanControl all true; the agent had not
restarted and its journal had no entries around the command. Raw signals and the
original acknowledgment timestamp were not retained, so the incident's exact
guard failure cannot be established from that evidence.

Isolated regressions independently reproduced two implementation false negatives:
Pause/GetAll can complete before a delayed raw Paused signal arrives, and a known
CanPause change after Pause was incorrectly treated as lost resume authority.
The repair waits on native events within the original command budget, then
freshly rechecks owner/properties. It preserves raw Stop/Seeked, content/owner,
capability-loss and expiry guards; it neither polls nor retries a method or
claims ownership from a snapshot alone. The old uncertain pause remains unowned.
This establishes the software bugs without asserting either caused the real
incident. Actual ownership through a future normal Spotify presence cycle is a
separate field check.

Both positive fixtures failed with `uncertain:unconfirmed` before the repair and
pass afterward, including bundled and separate CanPause updates. Twelve negative
confirmation cases cover missing/late raw signal, Stop, Seeked, content/owner
changes, CanPlay/CanControl loss or unknown values, malformed/invalidated required
properties and expiry. They grant no lease, retry no method and issue no Play.
A separate zero-poll assertion preserves the strict CanPause gate before dispatch.
Uncertain outcomes now log a validated command UUID, fixed failure stage/reason,
confirmation flags and elapsed time; no metadata, payloads or tokens are logged.

A 10.004-second installed full-desktop sample of `85a58ec` (control enabled, actual KDE,
two MPRIS players and native PipeWire helper) measured agent peak RSS
9,408,512 bytes and `pw-dump` 7,266,304 bytes. Both accumulated zero observed CPU
ticks at 100 Hz; this short sample does not establish zero CPU use under load.

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
