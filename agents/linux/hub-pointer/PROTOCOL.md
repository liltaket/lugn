# Hub pointer bridge, wire protocol v1

`lugn-hub-pointer` runs on the desktop. When the desktop pointer is pushed
against a barrier on the lower part of the monitor's left edge, the
compositor hands the pointer to it (xdg-desktop-portal InputCapture plus
libei). It then drives a virtual cursor on one Nest Hub dashboard page.

The Hub page connects directly to the desktop over the LAN:

    ws://<desktop-lan-ip>:<port>/hub-pointer?token=<token>

The token is a shared secret held in both the agent config and Lugn's
environment. Lugn passes the URL and token to the page that belongs to the
configured Hub only. The agent rejects a connection with a wrong token or an
`Origin` header that is not on its allow list. It keeps one page connection:
a new valid connection replaces the old one.

All frames are JSON text frames with a `t` field. Unknown `t` values and
unknown fields are ignored by both sides.

## Page to agent

| `t`     | Fields                                                         | When                               |
| ------- | -------------------------------------------------------------- | ---------------------------------- |
| `hello` | `v: 1`, `w`, `h` (viewport CSS px, `innerWidth`/`innerHeight`) | On open, and again on every resize |
| `pong`  | `id` (echoed)                                                  | Reply to every `ping`              |

## Agent to page

| `t`      | Fields                                                              | Meaning                                                      |
| -------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `enter`  | `x`, `y`                                                            | Capture started; show the cursor at this viewport point      |
| `move`   | `x`, `y`                                                            | Absolute viewport CSS px (floats). Sent once per libei frame |
| `button` | `button` (`"left"`, `"right"`, `"middle"`), `down` (bool), `x`, `y` | Press or release at the point                                |
| `wheel`  | `dx`, `dy` (CSS px, positive = down/right), `x`, `y`                | Scroll at the point                                          |
| `leave`  | none                                                                | Capture ended; hide the cursor and release any held button   |
| `ping`   | `id` (integer)                                                      | Once per second while connected; page answers `pong`         |

The agent owns the cursor position and clamps it to `0 <= x`, `0 <= y < h`.
The Hub stands to the left of the monitor with its bottom edge level with the
monitor's bottom edge, so the cursor enters at the right edge of the Hub page
(`x = w - 1`). Moving past the right edge (`x >= w`) ends capture and puts the
desktop pointer back just inside the monitor's left edge at the matching
height.

## Page behavior

- Right button: acts as Escape (closes an open sheet or camera view).
- Left button: pointerdown/mousedown on press, pointerup/mouseup on release,
  then `click` when press and release hit the same control.
- The page hides the cursor on `leave`, on disconnect, and when the socket is
  closed. It reconnects with backoff.

## Safety

The agent ends capture when the page disconnects, when no `pong` has arrived
for 2.5 s, on the compositor's `Deactivated` signal, and on exit. A page that
has not answered a `ping` for 2.5 s is treated as gone even when nothing is
captured: the agent closes its socket and disarms the barrier, and the page
reconnects as after any disconnect. Barriers are
only armed while a page is connected and has sent `hello`, so the desktop
pointer is never captured with nothing to show it.
