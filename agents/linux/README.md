# Linux desktop agent

A standalone Rust observation publisher for Kubuntu KDE Plasma/Wayland. It sends
computer telemetry over MQTT and does not depend on the Lugn runtime. Default
operation is observation-only. Optional authenticated MQTT control supports exact
MPRIS Pause and lease-bound Resume; it provides no shell commands, input injection,
screen capture or window control. Lugn-side consumption belongs to a separate PR.

## Install as the desktop user

On Kubuntu install build/runtime prerequisites (Rust 1.85+ with Cargo, C compiler,
CMake for the TLS dependency, `pipewire-bin`, and the normal KDE user session):

```sh
sudo apt install build-essential cmake pkg-config pipewire-bin
# Install a Rust toolchain through your usual trusted source, then:
cd agents/linux
cargo build --release --locked
./scripts/install.sh
```

The installer copies the binary to `~/.local/bin`, installs and enables the user
service, and creates a mode-0600 example configuration **only if absent**. It does
not start the agent before you edit the configuration. Existing configuration is
preserved on upgrades. `XDG_CONFIG_HOME` is supported; otherwise use:

```sh
editor ~/.config/lugn-linux-agent/config.toml
systemctl --user start lugn-linux-agent
systemctl --user status lugn-linux-agent
journalctl --user -u lugn-linux-agent -f
```

Set a unique `device_id`, broker host/port and credentials. The example documents
TLS with system trust or a custom PEM CA (`mqtt_tls`, `mqtt_ca_file`). Credentials
can live in the mode-0600 config; an optional mode-0600 systemd environment file
`~/.config/lugn-linux-agent/environment` can override the password:

```ini
LUGN_MQTT_PASSWORD=your-private-password
```

Never commit that file. In the default mode, grant MQTT write access only to the
three observation topics. Media metadata can contain personal information, so use a trusted broker
and TLS where appropriate. Different desktops need different device IDs.

Automatic startup is tied to `graphical-session.target`; stopping/logging out of
the session stops the service. Crash recovery uses `Restart=on-failure` with a
five-second delay. No lingering/root service is needed. KDE must import
`WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR` and the session D-Bus address into its user
manager (normally automatic). If missing, run from a terminal in that session:

```sh
systemctl --user import-environment WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
systemctl --user restart lugn-linux-agent
```

Run manually with `lugn-linux-agent --config /absolute/path/config.toml`.
Upgrade by rebuilding, rerunning the installer, then restarting the service.
Uninstall with `systemctl --user disable --now lugn-linux-agent`, remove the unit
from `~/.config/systemd/user` (or `$XDG_CONFIG_HOME/systemd/user`), run
`systemctl --user daemon-reload`, and remove the binary. Keep/delete private config
as desired. The observer script is transient and is replaced on agent restart.

## Observation sources

- **Availability:** retained online/offline, MQTT Last Will, 20-second keepalive,
  heartbeat (default 30 seconds), exponential reconnect up to 60 seconds.
- **Internet connectivity:** NetworkManager Connectivity property and native
  PropertiesChanged signals. This is distinct from broker/agent availability;
  connectivity checks disabled by the user may leave this unknown.
- **Lock:** KDE `org.freedesktop.ScreenSaver` GetActive/ActiveChanged, following
  service ownership. No screensaver inhibition or lock requests.
- **Idle/activity:** native `ext_idle_notifier_v1` Wayland events, default threshold
  300 seconds. No keystrokes or pointer events are read. Idle inhibitors are
  respected. Initial notification starts active and counts from subscription
  creation, so startup/reconnect does not reconstruct previous idle time.
- **Focused app/fullscreen:** bundled KWin script reads desktopFileName,
  resourceClass and fullScreen, subscribing to activation and property changes.
  The agent hosts an observation-only D-Bus endpoint, accepts reports only from
  KWin's unique bus owner, and loads the script via KWin's scripting D-Bus API.
  No manual KWin package or privileged Wayland screen access is needed. Plasma 6
  names and Plasma 5 naming/path fallbacks are provided. Older KWin versions
  without ext-idle-notify (including Plasma 5.27) report idle as unknown;
  window observation still uses the Plasma 5 compatibility path.
- **Audio:** one `pw-dump --monitor --no-colors` child consumes native PipeWire
  registry/node events. Reports running playback streams, excluding capture and
  sink nodes. This observes stream state, not audible samples: muted/silent
  streams may count. Runtime requires `pw-dump` from `pipewire-bin`.
- **Media:** MPRIS bus-name lifecycle and PropertiesChanged subscriptions;
  playback state, player identity, desktop entry, title, artists, album and explicit
  content type. No playback-position polling, artwork or URL collection.

Missing APIs report `null`; loss clears previous observations. Source failures
retry with bounded exponential backoff; a healthy idle subscription blocks on
events. D-Bus snapshots follow subscription setup to avoid missing transitions.
Unavailable optional sources do not prevent MQTT or other sources working.
`pw-dump` uses a bounded frame/parser and graph cache; metadata, collections and
outgoing payloads are bounded. A bounded channel supplies a single state reducer;
MQTT retains only the latest state during outages or slow acknowledgements.

Classification is conservative and advisory. Configure exact KWin app IDs using
`gaming_app_ids`, `video_app_ids`, `music_app_ids` after observing local values.
Steam game resource classes are recognized. Fullscreen and generic browser/audio
activity alone do not identify gaming/video/music. See the canonical
[MQTT v1 contract](protocol/README.md), schemas and fixtures for fields, precedence,
freshness rules, session/sequence handling and retained-message semantics.

## Optional targeted media control

Control is disabled by default. Set `control_enabled = true` only with configured
MQTT username/password and broker ACLs granting the agent subscribe access to its
own `control/command` and publish access to `control/state` and `control/ack`.
The existing three observation topics and v1 payloads remain unchanged.

Read the separate [CONTROL v1 contract](protocol/CONTROL.md) before enabling.
Commands target the exact agent connection, player instance and content generation,
expire after at most 15 seconds, and are deduplicated. Pause grants ownership only
after confirming an actual Playing-to-Paused transition. Resume needs that still
valid pause lease and consumes its token before attempting Play. Reconnect,
unknown identity, observed user changes and expiry revoke ownership. No automatic
resume occurs after reconnect, no arbitrary player start is exposed, and no
`PlayPause` toggle is used. Lugn chooses the player and owns room/source policy.

These are guarded MPRIS operations, not atomic compare-and-swap. A concurrent
manual pause can be indistinguishable from the requested pause, and an already
sent method can execute after a timeout or disconnect. Uncertain operations never
grant a lease and are not retried automatically. Control identity may examine
track IDs and URLs privately; URLs are never emitted into telemetry or logs.

## Validate

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
bash tests/install.sh
shellcheck scripts/install.sh tests/install.sh
node tests/kwin.mjs
cargo test --locked mqtt_control_wire -- --ignored
# Isolated bus only; these tests create fake KDE/MPRIS service names:
LUGN_TEST_DBUS=1 dbus-run-session -- sh -c 'DBUS_SYSTEM_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" cargo test --locked dbus_lifecycle -- --ignored --test-threads=1'
# Real temporary broker, no production broker or actual desktop APIs:
python3 tests/mqtt_integration.py --broker /usr/sbin/mosquitto --agent target/debug/lugn-linux-agent --password-tool /usr/bin/mosquitto_passwd
```

The Python broker harness uses only the standard library and starts a private
loopback Mosquitto instance. It deliberately isolates Wayland/D-Bus and substitutes
PipeWire fixtures. See [validation and measurements](VALIDATION.md) for observed
results, reproduction and the remaining physical-desktop acceptance checklist.

For an explicitly requested check through the installed agent and broker, the
ignored host fixture registers only
`org.mpris.MediaPlayer2.lugn_control_test` on the selected session bus. It starts
**Paused**, has no track title or desktop-app alias, creates no audio, and never
calls the agent or another player. Run from `agents/linux` on the intended desktop:

```sh
LUGN_HOST_CONTROL_FIXTURE=1 cargo test --locked host_fake_control_player -- --ignored --nocapture --test-threads=1
```

An already-built test executable can be used directly instead:
`LUGN_HOST_CONTROL_FIXTURE=1 /absolute/path/to/lugn_linux_agent-<test-hash> host_fake_control_player --ignored --nocapture --test-threads=1`.
`cargo test --locked --no-run` prints that executable's path. The helper prints
its exact PID, player name and initial Paused state. After the controller is ready,
send `kill -USR1 <printed-pid>` to announce fake Playing; this changes only the
fixture's state. Target commands to that exact player. Ctrl-C stops the helper;
it also exits after 180 seconds total or 60 seconds after the start signal,
whichever comes first, releasing its bus name and printing final Pause/Play
counters. It is separate from the `dbus_lifecycle` test filter.

Primary API references: [KDE scripting](https://develop.kde.org/docs/plasma/kwin/),
[KWin implementation](https://invent.kde.org/plasma/kwin/-/tree/master/src/scripting),
[Wayland idle protocol](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/staging/ext-idle-notify/ext-idle-notify-v1.xml),
[PipeWire pw-dump](https://docs.pipewire.org/page_man_pw-dump_1.html),
[MPRIS](https://specifications.freedesktop.org/mpris/latest/), and
[NetworkManager](https://networkmanager.dev/docs/api/latest/gdbus-org.freedesktop.NetworkManager.html).
