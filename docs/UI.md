# UI, Nest Hubs and DashCast

## Live Hub state

Hub displays subscribe to the existing runtime state stream through their private
`/k/<token>/display-api/events` path. Each connection receives a current full
snapshot and coalesced state changes; five-second heartbeat snapshots also
refresh environment and Cast status. A reconnect receives current truth rather
than replaying obsolete commands. The same Host, path credential and Origin
checks protect the stream; connections are limited to two per configured Hub.

The display rejects older state/delivery revisions within a server instance.
An instance ID allows recovery after runtime restart while delayed reads from
retired instances remain ignored. Streaming silence or errors trigger polling
every two seconds and reconnect backoff from one to thirty seconds. Displays
without EventSource keep polling. Healthy streams retain a fifteen-second
verification poll; hidden pages close the stream and visible pages reconnect.

Selected scenes show sending, waiting for lamps, and confirmed states separately.
Reported music volume is labelled `Nu`, or `Senast` when the player or Lugn is
unavailable. Requested volume is a separate fact in Details. Command acceptance triggers a
fresh status read and never invents an observed state or physical convergence.

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
a Home Assistant dashboard. The primary layout fits the Hub screen without
horizontal or vertical scrolling. The in-place Details pane may scroll its
secondary explanations; music controls remain visible and `Tillbaka` restores
lighting controls.

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

Volume steps and their boundary buttons use the latest pending requested volume,
falling back to the reported volume after confirmation, failure, expiry or an
external change. The displayed current volume remains the player's observation.

The main music panel names the active volume owner and its typed reason. The
effective target belongs to that owner; it does not become a requested volume
merely because a command was accepted. Details separates automatic policy
enabled/activity, the last reported volume changer, requested volume, baseline,
daily/person-count offsets and the calculated automatic target. A matching
uncorrelated report is labelled as matching a request, rather than proof of
who moved the physical control. Missing attribution remains unknown.

Manual volume continuity counts down only when the backend supplies a confirmed
absence deadline. The countdown uses server time plus elapsed client time; at
the boundary the dashboard waits for backend authority instead of releasing a
hold itself. A lost connection marks authority/activity unknown and preserves
last reported values.

Playback explanations come from the shared backend policy. They distinguish
manual Pause, home/away, unknown/empty presence, the 23–06 automatic-start gate,
and eligibility for the next confirmed entry. Enabling volume automation does
not disable or enable playback automation. Pending, failed and unconfirmed
commands remain separate from reported playback. When a Pause hold exists,
`Spela` explicitly releases it even if the player still reports playing after
a failed Pause; volume ownership stays independent.

Details shows the selected player's newest eight typed decisions from the
backend's bounded 128-entry process history. It records evaluated policy
transitions, not every clock tick or device event, and is not persisted. The
`music.getPolicy` read capability exposes current volume/playback reasons,
reported volume-change attribution and that player's history. This implements
the music portion of issue #14; lighting/prelight history remains follow-up work.

After command acceptance the Hub waits for a new status read started after
acceptance before enabling the controls again. An earlier background poll is
allowed to finish first, but cannot replace that fresh read.

## Hub roles and access

Each configured Hub has a role (`bed` or `desk`), a Cast receiver IP and a
separate secret URL path. The dashboard listener is configured independently
from the bearer-protected, loopback-only capability API. Keep the display
listener on a trusted LAN and do not publish it to the internet.

Bed prioritizes Helt släckt and Mysljus, followed by Sleep if that scene is
configured, then the remaining available scenes. Desk prioritizes Fokus and
Vardagsljus. With up to six scenes, the first two available scenes have larger
full-width controls; larger sets use paired buttons to preserve space. All
configured scenes remain available and require one touch. Missing preferred
scenes are skipped rather than invented. Unknown roles retain the neutral scene
order. Desk puts Optical before Spotify DJ in actual button and keyboard order;
Bed and unknown roles keep Spotify DJ first. Playback, volume, Details and the
same backend reasons remain available on both roles. The role adds no separate
room state, PC capability, or inferred confirmed occupancy.
The target layout covers the five built-in scenes plus optional Sleep, with a
paired fallback for seven/eight scenes. Larger custom scene sets need separate
viewport validation or future pagination.

Scene, light, music and preset commands identify the authenticated role as actor
`nest-dashboard:bed` / `nest-dashboard:desk` and source
`lugn.cast_dashboard.bed` / `lugn.cast_dashboard.desk`. The server resolves that
role from the Hub's secret path; client-supplied role/source fields are rejected,
and headers cannot override it. This is action provenance, not presence evidence.

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
