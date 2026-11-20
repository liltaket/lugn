# Hub pointer bridge, wire protocol v2

`lugn-hub-pointer` runs on the desktop. The Hub stands **below** the monitor,
its left edge roughly level with the monitor's left edge. When the desktop
pointer is pushed down out of the monitor's bottom edge near the bottom-left
corner, the compositor hands the pointer to the agent (xdg-desktop-portal
InputCapture plus libei). Once the push has carried on far enough downward,
the agent drives a virtual cursor on one Nest Hub dashboard page. Moving out
of the Hub's top, left or right edge gives the pointer back.

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

| `t`     | Fields                                                                                            | When                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `hello` | `v` (1 or 2), `w`, `h` (viewport CSS px, `innerWidth`/`innerHeight`)                              | On open, and again on every resize                                                      |
| `pong`  | `id` (echoed)                                                                                     | Reply to every `ping`, sent straight from the message handler                           |
| `perf`  | `frames`, `moves`, `lagP50`, `lagP95`, `lagMax`, `gapMax`, `longTasks`, `longTaskMs`, `span` (ms) | About every 2 s while the cursor is shown, and once right after `leave` (see Telemetry) |

## Agent to page

| `t`      | Fields                                                              | Meaning                                                                       |
| -------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `enter`  | `x`, `y`                                                            | Capture started; show the cursor at this viewport point                       |
| `move`   | `x`, `y`                                                            | Absolute viewport CSS px (floats). At most one per 8 ms, latest position wins |
| `button` | `button` (`"left"`, `"right"`, `"middle"`), `down` (bool), `x`, `y` | Press or release at the point                                                 |
| `wheel`  | `dx`, `dy` (CSS px, positive = down/right), `x`, `y`                | Scroll at the point                                                           |
| `leave`  | none                                                                | Capture ended; hide the cursor and release any held button                    |
| `warm`   | `on` (bool)                                                         | The desktop pointer is near the entry corner (or left it); get ready to draw  |
| `ping`   | `id` (integer)                                                      | Once per second while connected; every 20 ms while warm; page answers `pong`  |

The agent owns the cursor position and clamps it to `0 <= x < w`,
`y < h`. `enter` is not sent when the compositor hands the pointer over,
but only after the push has gone on `entry_push_px` (40 by default) further,
mostly downward; a push that slides sideways, moves back up, sees a button
or wheel event or takes longer than `entry_timeout_ms` (350) is handed back
to the desktop and the page sees nothing. The cursor enters near the top of
the Hub page (`y` = 24 plus any overshoot past the push, times gain) at the
x that matches the desktop pointer's position along the entry zone. Moving
above the top (`y < 0`), left of the left edge (`x < 0`) or right of the
right edge (`x >= w`) sends `leave`, ends capture and puts the desktop
pointer back just above the monitor's bottom edge: at the matching x through
the top, in the bottom-left corner through the left, and just right of the
Hub's width through the right. The bottom edge holds the cursor at
`y = h - 1`. Buttons and wheel are sent immediately; a pending `move` is
flushed first so they land at the right point.

## Page behavior

- Right button: acts as Escape (closes an open sheet or camera view).
- Left button: pointerdown/mousedown on press, pointerup/mouseup on release,
  then `click` when press and release hit the same control.
- The page hides the cursor on `leave`, on disconnect, and when the socket is
  closed. It reconnects with backoff.
- The cursor element exists from the moment the bridge is configured, so the
  first `enter` does no DOM creation.

## Telemetry

`lag` is the time from a `move` arriving in the page's message handler to the
animation frame that writes it to the cursor. `gapMax` is the longest interval
between animation frames while the cursor was shown. `longTasks` and
`longTaskMs` come from a `longtask` PerformanceObserver where the engine has
one (otherwise 0). `span` is the window the numbers cover. The agent logs them
next to its own rates (libei frames and `move`s sent per second).

## Safety

The agent ends capture when the page disconnects, when no `pong` has arrived
for 2.5 s, on the compositor's `Deactivated` signal, and on exit. A page that
has not answered a `ping` for 2.5 s is treated as gone even when nothing is
captured: the agent closes its socket and disarms the barrier, and the page
reconnects as after any disconnect. Barriers are only armed while a page is
connected and has sent `hello`, and while the focused window is not a game,
so the desktop pointer is never captured with nothing to show it or in the
middle of a game.
