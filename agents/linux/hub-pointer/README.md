# lugn-hub-pointer

Lets the desktop mouse slide off the monitor onto the Nest Hub dashboard that
stands below it, left edges roughly level. Push the pointer down out of the
monitor's bottom edge near the bottom-left corner: the edge holds it for a
moment, and once the push carries on far enough downward it disappears from
the desktop and shows up as a cursor just below the top of the Hub page, at
the matching x. A slide sideways along the edge, a move back up, a click or
a pause hands the pointer straight back to the desktop instead. Move the
cursor out of the page's top edge (anywhere along it) or out of its left or
right edge and the desktop pointer comes back just above the monitor's bottom
edge: at the matching x through the top, in the corner through the left, and
just past the Hub's width through the right. The Hub's bottom edge is a wall.
The keyboard always stays on the desktop.

It is a separate binary next to `lugn-linux-agent`:

- The xdg-desktop-portal **InputCapture** portal places a pointer barrier on
  the bottom edge and hands the captured pointer over. KDE only accepts a
  barrier that fills the whole edge, so the barrier is only armed while the
  KWin observer reports the cursor near the entry corner. A push down onto the
  taskbar further right never meets it. Inside the approach area but outside
  the entry corner (`hub_width_px + entry_slack_px` from the left), a push is
  handed straight back and the barrier rests for 300 ms. Inside the corner
  the push is pending until it has gone `entry_push_px` further, mostly
  downward, within `entry_timeout_ms`; only then does the page get `enter`. A
  pending push that slides `entry_push_px` sideways, moves back up more than
  4 px, times out, or sees a button or wheel event is handed back where the
  hand went, and the barrier rests for 400 ms. libei has already taken that
  button or wheel event, so that click is lost (the log says so). Without the
  KWin observer the barrier stays armed while a page is connected. The exact
  line KDE accepts is tried from four candidates on the first arm and
  remembered.
- **libei** (through the `reis` crate) delivers relative motion, buttons and
  scroll while captured.
- A **WebSocket** server pushes the cursor position to the Hub page, at most
  one `move` per 8 ms (latest position wins; the first move after a pause goes
  at once). See [PROTOCOL.md](PROTOCOL.md) for the frames.
- A small read-only **KWin script** reports the focused window, so nothing is
  captured while a game has focus, and whether the cursor is near the entry
  corner, so the agent can warm the Hub up before the pointer arrives.
- KWin's **shake-to-find** effect (`shakecursor`) is unloaded while the pointer
  is on the Hub and loaded back afterwards, so shaking the mouse on the Hub
  does not blow up the hidden desktop cursor.

Tested against KDE Plasma 6.6 (kwin_wayland, xdg-desktop-portal-kde,
InputCapture interface version 1).

## Build

```sh
cd agents/linux/hub-pointer
cargo build --release          # target/release/lugn-hub-pointer
cargo test
```

This is its own Cargo package and workspace; it does not change the
`lugn-linux-agent` build.

## Configure

Copy [config.example.toml](config.example.toml) to
`~/.config/lugn-linux-agent/hub-pointer.toml` (or pass `--config <path>`).

| Key                     | Default              | Meaning                                                                                                  |
| ----------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `listen`                | `"0.0.0.0:8791"`     | WebSocket address; the page connects to `ws://<host>:<port>/hub-pointer?token=…`                         |
| `token`                 | required             | Shared secret, compared in constant time. `LUGN_HUB_POINTER_TOKEN` in the environment overrides it       |
| `allowed_origins`       | `[]`                 | Allowed `Origin` headers for the upgrade, e.g. `["http://192.168.10.132:8788"]`. Empty allows any Origin |
| `hub_width_px`          | `560`                | The Hub's physical width, in desktop logical px. Positions along the edge scale by page width / this     |
| `entry_slack_px`        | `60`                 | How far past the Hub's right edge a push down still enters (at the Hub's last column)                    |
| `entry_push_px`         | `40`                 | Desktop px a push must carry on, mostly downward, before it enters; the same sideways aborts             |
| `entry_timeout_ms`      | `350`                | A push that has not entered by then is handed back to the desktop                                        |
| `gain`                  | `2.0`                | Hub CSS px per desktop logical px of motion                                                              |
| `log_latency`           | `true`               | Log WebSocket round-trip p50/p95/max every 10 s                                                          |
| `suppress_effects`      | `["shakecursor"]`    | KWin effects unloaded while the pointer is on the Hub. Empty disables                                    |
| `game_app_ids`          | launchers, emulators | Window classes or desktop file names that count as games, also when windowed (see below)                 |
| `fullscreen_ok_app_ids` | browsers, players    | Apps whose fullscreen windows do not count as games (see below)                                          |

Unknown keys are rejected (`zone_height` from the left-edge version is gone).
The two id lists replace the defaults when set; the defaults are in
[src/config.rs](src/config.rs). Ids compare case-insensitively, and a
desktop file name matches with or without `.desktop`.

### Game gate

The focused window counts as a game, and the barrier stays disarmed so the
screen edge behaves normally, when its window class starts with
`steam_app_`, ends with `.exe` (Wine), or its class or desktop file is in
`game_app_ids`, or when it is fullscreen and neither is in
`fullscreen_ok_app_ids`. A capture that is already running when a game takes
focus is left alone. The log shows `gate: blocked by <class> (<rule>)` and
`gate: open`. If the KWin script cannot be loaded, the gate stays open.
Window classes as KWin sees them (Zen is `zen`, snap Firefox is
`firefox_firefox`) can be read with the KWin debug console.

## Run

```sh
lugn-hub-pointer --config ~/.config/lugn-linux-agent/hub-pointer.toml
```

It needs the graphical session's D-Bus (`DBUS_SESSION_BUS_ADDRESS`), so run it
inside the Plasma session or as a user service. On start, KDE shows an **Input
Capture Requested** dialog; nothing works until you press **Allow**. The
process waits for that answer as long as it takes (nothing is captured
meanwhile). Declining makes it exit with status 3, which the unit below does
not restart on. The version 1 portal has no way to remember the choice, so the
dialog appears every time the process starts. Logs go to stderr (the journal
under systemd).

As a user service, with the unit file in this directory (not installed by
anything here):

```sh
install -m 755 target/release/lugn-hub-pointer ~/.local/bin/
install -m 644 lugn-hub-pointer.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lugn-hub-pointer.service
journalctl --user -fu lugn-hub-pointer
```

The unit reads an optional `~/.config/lugn-linux-agent/hub-pointer.env`, which
may hold `LUGN_HUB_POINTER_TOKEN=…`.

## Safety

The rule is that the pointer must never be captured when nothing can show it,
and capture must always end quickly when something goes wrong.

- The barrier is only armed (SetPointerBarriers + Enable) while a page is
  connected and has sent `hello`, and while the focused window is not a game.
  When the page goes away the session is disabled.
- Capture ends (Release, then `leave` to the page) when the page disconnects,
  is replaced by a new connection, stops reading, or has not answered a ping
  for 2.5 s. A silent page is also dropped and the barrier disarmed, even
  when no capture is running.
- The compositor's `Deactivated` and `Disabled` signals end capture on our
  side, and the page gets `leave`.
- On SIGINT/SIGTERM it releases, disables, loads back the effects it
  unloaded, unloads its KWin script and closes the portal session.
- KWin calls (script, effects) run on their own tasks and never hold up
  input handling. The script's D-Bus service (`org.lugn.HubPointer`) only
  accepts calls from the `org.kde.KWin` bus owner.
- If the process is killed during a capture, `shakecursor` stays unloaded
  until KWin restarts or the effect is turned off and on again in System
  Settings (or `qdbus6 org.kde.KWin /Effects loadEffect shakecursor`). The
  agent does not load it on startup, since it cannot tell a crash from a
  choice.
- If the process dies, its D-Bus connection closes, the portal closes the
  session and kwin gives the pointer back. Every portal call has a timeout,
  and if a Release or Disable gets no answer within 2 s the process exits on
  purpose to get that effect.
- The WebSocket never blocks input handling. Each page has its own task and
  a bounded queue; a full queue counts as a dead page.

Escape hatch: if the pointer ever seems stuck, `systemctl --user stop
lugn-hub-pointer` (or killing the process) frees it.

## Tuning

- **hub_width_px**: the Hub screen's width in cm times the monitor's desktop
  px per cm. Set it so the cursor enters the Hub below where the desktop
  pointer left the monitor.
- **entry_slack_px**: pushes down this far right of the Hub still enter, at
  the Hub's right edge. Further right, pushing down stops at the screen edge as
  usual; close to the corner the pointer may hitch for a moment while the
  barrier hands it back.
- **entry_push_px** and **entry_timeout_ms**: how deliberate a push into the
  Hub must be. Raise the push if the Hub takes the pointer when you only meant
  to reach the taskbar; lower it, or raise the timeout, if entering feels
  sticky. On entry the cursor lands 24 Hub px below the top (plus any push
  past `entry_push_px`, times gain), so a small twitch upward right after
  entering does not leave again.
- **gain**: the Nest Hub page is 1024 CSS px wide on a ~15.5 cm screen, about
  66 px/cm; the 3657 px monitor is ~119 cm wide, about 30.7 px/cm. 2.0 keeps
  the cursor's physical speed about the same on both. Raise it if the Hub
  cursor feels slow compared with the desktop
  pointer, lower it if it feels twitchy. Scroll is not scaled by gain. A wheel
  notch scrolls 48 px.
- **Warm-up**: while the cursor is within `hub_width_px + entry_slack_px + 200`
  px of the left edge and 220 px of the bottom (and the gate is open), the
  agent sends `warm {on: true}` and pings every 20 ms instead of every second,
  which keeps the Hub's Wi-Fi out of power save. It goes back to 1 s pings and
  sends `warm {on: false}` 1.5 s after the cursor leaves that area. During a
  capture it pings once a second; the moves keep the link busy.
- Watch `ws: rtt p50 … p95 … (N pongs, M fast)` in the log. The round trip
  includes the Hub's event loop, so a high p95 usually means the page was busy
  rendering.
- Watch `perf: hub lag … ; agent ei …/s sent …/s` while the cursor is on the
  Hub: the page's own move-to-paint lag, its longest frame gap and long tasks,
  next to how many libei frames came in and how many `move`s went out.
