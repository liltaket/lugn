# UI, Nest Hubs and DashCast

## Operational control panel

The initial web surface is a focused lighting panel. It shows current presence,
integration health, configured scenes, and every mapped light's availability,
desired values, reported values, and ownership. Operators can select or reapply
a scene, toggle a mapped light, and adjust its brightness when the adapter
reports that property. Command acceptance remains separate from device
feedback.

The panel supports optional Clerk sign-in. Lugn verifies the signed Clerk
session token, applies the configured server-side user policy, and creates a
short-lived same-origin session with CSRF protection. The Clerk secret key is
server-only. The API bearer token remains available for machine clients and
does not sign humans into the panel. Keep the HTTP service on loopback and use
an SSH tunnel for local operation, or configure the exact TLS proxy origin in
`http.trustedOrigins`. The existing typed capabilities remain the only path to
device commands. Clerk project sign-up settings control who can create an
account; the Lugn allowlist can restrict which authenticated users may operate
the panel.

This panel is for observing and tuning configured lights. Editing Home
Assistant mappings and broader room systems remain future UI work.

## Current Hub dashboard

Lugn serves its own room dashboard for Nest Hubs. It is a custom Lugn page, not
a Home Assistant dashboard. The layout is designed to fit the Hub screen
without horizontal or vertical scrolling.

The primary controls are large room-light preset buttons:

- Helt släckt
- Mysljus
- Vardagsljus
- Filmkväll
- Fokus

The rest of the one-screen view shows:

- room occupancy and person count;
- Home Assistant home/away status (`Hemma`, `Borta` or `Hemstatus okänd`);
- local time and date;
- temperature, humidity, CO₂ and PM2.5, with missing or stale values marked;
- music playback/title and volume, with Spotify DJ and Optical preset buttons,
  play/pause, and volume `−` / `+` controls in 5-point steps.

There are no individual light sliders or source selector on this Hub view.
Home/away gates automatic lighting and music behavior only; the explicit
preset, playback and volume controls remain available while away.

## Hub roles and access

Each configured Hub has a role (`bed` or `desk`), a Cast receiver IP and a
separate secret URL path. The dashboard listener is configured independently
from the bearer-protected, loopback-only capability API. Keep the display
listener on a trusted LAN and do not publish it to the internet.

The custom Hub dashboard does not use Clerk; it uses a separate secret path
for each receiver. The local operational control panel at `/ui/` supports
optional Clerk sign-in. The machine API continues to use its bearer token, and
the full visual configuration editor remains future work. See
[Running Lugn](OPERATIONS.md#control-panel-authentication) for Clerk setup.

See [Running Lugn](OPERATIONS.md#lugn-nest-hub-dashboards) for configuration,
token setup, ports and receiver requirements.

## DashCast lifecycle

Lugn's DashCast manager connects to configured Cast receivers, launches the
DashCast app and opens the Hub's own dashboard URL. It monitors Cast state and
yields when another cast session is active. After the receiver is idle for 90
seconds, Lugn may restore its dashboard.

These are separate facts:

1. **DashCast control** — Lugn connected to the receiver and issued the app
   launch request.
2. **Dashboard fetch/render** — the browser on that receiver loaded and
   rendered the page.

The first does not prove the second. For a blank page or 503, check the affected
Hub's fresh displayed error/poll, the display listener's reachability from
that Hub, and its status on Lugn's dashboard. Do not diagnose receiver
rendering only from an HTTP response on the Lugn host.

## Future configuration editor

A full visual settings editor is not part of the current delivery. Future
settings can include scenes, home-presence mapping, music policy, routines,
receiver roles and diagnostics, using the typed Lugn capability layer.
