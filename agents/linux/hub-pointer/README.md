# lugn-hub-pointer

Lets the desktop mouse slide off the monitor onto the Nest Hub Max dashboard
that stands to the left of it, with the bottom edges level. Push the pointer
against the lower part of the monitor's left edge and it disappears from the
desktop and shows up as a cursor at the right edge of the Hub page. Move it
out past the page's right edge and the desktop pointer comes back just inside
the monitor at the matching height. The keyboard always stays on the desktop.

It is a separate binary next to `lugn-linux-agent`:

- The xdg-desktop-portal **InputCapture** portal places a pointer barrier on
  the left edge and hands the captured pointer over.
- **libei** (through the `reis` crate) delivers relative motion, buttons and
  scroll while captured.
- A **WebSocket** server pushes the cursor position to the Hub page, one
  message per libei frame. See [PROTOCOL.md](PROTOCOL.md) for the frames.

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

| Key               | Default          | Meaning                                                                                                  |
| ----------------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| `listen`          | `"0.0.0.0:8791"` | WebSocket address; the page connects to `ws://<host>:<port>/hub-pointer?token=…`                         |
| `token`           | required         | Shared secret, compared in constant time. `LUGN_HUB_POINTER_TOKEN` in the environment overrides it       |
| `allowed_origins` | `[]`             | Allowed `Origin` headers for the upgrade, e.g. `["http://192.168.10.132:8788"]`. Empty allows any Origin |
| `zone_height`     | `420`            | Length of the barrier, in desktop logical px measured up from the monitor's bottom edge                  |
| `gain`            | `1.0`            | Hub CSS px per desktop logical px of motion                                                              |
| `log_latency`     | `true`           | Log WebSocket round-trip p50/p95/max every 10 s                                                          |

Unknown keys are rejected.

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
  connected and has sent `hello`. When the page goes away the session is
  disabled.
- Capture ends (Release, then `leave` to the page) when the page disconnects,
  is replaced by a new connection, stops reading, or has not answered a ping
  for 2.5 s. A silent page is also dropped and the barrier disarmed, even
  when no capture is running.
- The compositor's `Deactivated` and `Disabled` signals end capture on our
  side, and the page gets `leave`.
- On SIGINT/SIGTERM it releases, disables and closes the portal session.
- If the process dies, its D-Bus connection closes, the portal closes the
  session and kwin gives the pointer back. Every portal call has a timeout,
  and if a Release or Disable gets no answer within 2 s the process exits on
  purpose to get that effect.
- The WebSocket never blocks input handling. Each page has its own task and
  a bounded queue; a full queue counts as a dead page.

Escape hatch: if the pointer ever seems stuck, `systemctl --user stop
lugn-hub-pointer` (or killing the process) frees it.

## Tuning

- **gain**: raise it if the Hub cursor feels slow compared with the desktop
  pointer, lower it if it feels twitchy. It also sets how heights map: with
  `gain = 1`, entering 200 px above the monitor's bottom puts the cursor 200
  CSS px above the bottom of the Hub page. Scroll is not scaled by gain. A
  wheel notch scrolls 48 px.
- **zone_height**: how much of the left edge, from the bottom up, captures the
  pointer. Above it, pushing left stops at the screen edge as usual. The Hub
  Max screen is about 13.5 cm tall, roughly 600 desktop px on an 80 cm wide
  3658 px monitor, so values up to about 600 match the Hub's physical height.
- Watch `ws: rtt p50 … p95 …` in the log. The round trip includes the Hub's
  event loop, so a high p95 usually means the page was busy rendering.
