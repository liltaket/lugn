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

The web panel also manages lighting presets. Each preset has a separate edit
button; the inline editor provides a name, inclusion checkbox and 0–100% slider
with an exact numeric input for each configured lamp. Zero means off. Excluded
lamps retain their existing intent when the preset is activated. New presets
start from the selected preset, or from current desired lighting when none is
selected. Saving changes the definition while retaining the previously applied
lighting across restart; **Spara och aktivera** additionally
uses the existing scene activation capability. Live state updates preserve the
open draft. Deleting or discarding unsaved changes requires an inline
confirmation. Deleting an active preset retains the current lamp intent.

Preset definitions and deleted built-in presets are persisted separately in
`<statePath>.scenes.json`, loaded after the generated room presets, before
restoring lighting intent. Writes are atomic and must succeed before changes
are published. Edits require a web session, same-origin request and CSRF token;
stale edits are rejected instead of overwriting newer changes. **Helt släckt**
remains a protected system action; the configured automation default can be
edited but cannot be deleted. Nest Hubs keep their activation controls and
receive updated presets, with no preset editor on their pages.

The Datorer page also has a **Skärmstyrning** section for computers configured
for display sleep and wake: the live status per computer and a settings form
(master switch, waits, away, sleep after inactivity, ignored blockers, waking).
Saving requires the same web session, same-origin request and CSRF token as other
edits, is checked against the settings generation so stale edits are rejected,
and applies at once. See [Computer integration](COMPUTER.md#settings-in-the-control-panel).

The Datorer page also has a **Datorljud till WiiM** section for the agent's fast
WiiM Optical switching: the live status per computer and a settings form (master
switch, how long sound must last, silence that ends it, sensitivity, WiiM
address, sound output). Saves use the same session, same-origin and CSRF checks
and generation conflict detection. See
[Computer integration](COMPUTER.md#fast-wiim-optical-switching).

## Current Hub dashboard

Lugn serves its own room dashboard for Nest Hubs. It is a custom Lugn page, not
a Home Assistant dashboard. The primary layout fits the Hub screen without
horizontal or vertical scrolling. The Hub presents clock, climate, paged lighting
scenes, all-off, routines, camera, and music controls. Bed keeps text and controls
outside the top-right system-overlay area; cover art may extend underneath it.
Camera images keep their original proportions.

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
  play/pause and the Automatisk/Manuell volume selector.

The layout (2026-11) is drawn 600 px tall and scaled to the Hub's viewport; the
canvas takes the viewport's full width. The room is on the left: date over the
clock, the air values on one line, the person count in a capsule (tapping it
sets the count to 1), the five room scenes in two rows, and one bottom row with
Släck allt and the cameras (Entré, Framsida) as direct choices. Custom
`scene.custom_*` presets (the Govee scenes) stay in the control panel and are
not shown on the Hub, and the Hub has no scene paging, Villkor, Rutiner or
Musik buttons. Music is the right column: the artwork at the top in its own
proportions over a blurred copy of itself, the source switch, the title, and
one capsule holding the volume selector and play/pause. The ring around
play/pause shows the playback position (Home Assistant `media_position` and
`media_duration`, or the computer agent's MPRIS `Position` and `mpris:length`),
and a thin bar under the capsule shows the reported volume. The Hub has no
volume `−` / `+` buttons. When nothing plays and no camera shows, the music
column narrows and the room controls widen; it shows a resting record and the
two sources as play buttons. An open camera takes the top of the music column
and music becomes a compact card under it.

The right column holds at most two live activities: a top card and the music
card under it. While the optional 3D printer (see
[3D printer](CONFIGURATION.md#3d-printer)) prepares, prints or is paused, and
for `resultVisibleMinutes` after it finishes or fails, the print takes the top
card: the model's cover image on a pale plate, the printer's name, the task
name, the percentage, time left with the estimated finish (or the stage, such
as `värmer bädden`, when the printer is not simply printing), a green
progress bar, and the layer count (nozzle and bed temperatures while it heats).
The task name fits two lines: one name keeps up to 60 characters, and several
parts read `Stand + Box + 5 till`, with the names shortened first so the count
always shows. A round lamp button at the end of the percentage row switches
the printer's chamber light; it appears only while Home Assistant reports the
light on or off, shows the tapped state at once and pulses until Home
Assistant confirms it. While the light is on, the button fills warm and the
plate the model stands on turns warm too. The card is flat like the music
card; the status color appears in the progress bar, and in the words only
for a paused or failed print.
A paused print turns amber and a failed one red. A camera has priority and
borrows the top card; the print and the music then share the lower card. Music
keeps it while it plays, unless the print is paused, finished or failed; a chip
on the camera (`A1 45 %` or `Musik`) swaps the two until the camera closes.
The Hub never starts, pauses or stops a print.

There are no individual light sliders on this Hub view.
Home/away gates automatic lighting and music behavior only; the explicit
preset, playback and volume controls remain available while away.

The volume step logic below remains in `display.js` but has no visible buttons.
Volume steps and their boundary buttons use the latest pending requested volume,
falling back to the reported volume after confirmation, failure, expiry or an
external change. The displayed current volume remains the player's observation.

The volume controls reflect backend authority and observed values. Detailed
policy explanations remain available in the desktop control panel.

The music panel stays visible for two minutes after a trusted playback pause;
the last loaded cover remains visible during that interval. For the first 30
seconds the title shows as it was; after that it reads `Senast spelat: <title>`
(a computer's media reads `Pausad`, then `Senast spelat`). `Musik` can keep the
panel open longer. Changing source or losing trusted observations clears retained
media. Playing artwork can tint the dashboard; otherwise the palette is neutral.

The compact Automatisk/Manuell buttons in the volume strip select temporary
per-player authority. The highlight comes from backend ownership, with neither
selected when no controller is active. Manual claims current trusted volume
without sending a volume change; Auto releases that player's hold and re-evaluates
eligible volume policy. Both leave playback/Pause independent. Backend reasons
explain offline, unsettled volume and active fades. The soft Manual selection
ends on meaningful room/count/home/enable transitions; real volume adjustments
keep their existing continuity. See [temporary authority](MUSIC.md#temporary-hub-authority-selector).

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

The `music.getPolicy` capability exposes current volume and playback reasons
and the selected player’s bounded process history.

After command acceptance the Hub waits for a new status read started after
acceptance before enabling the controls again. An earlier background poll is
allowed to finish first, but cannot replace that fresh read.

## Hub responsiveness rules

The Hub's main thread is slow, so the page follows a few rules that keep
clicks and the pointer bridge responsive while something plays:

- The playback ring is two clipped half rings that are only rotated
  (`transform`, composited). A transition of the progress value itself would
  restyle and repaint the page every frame while music plays.
- Nothing inherited that changes per frame may be transitioned on `#app-root`
  or any ancestor of many elements. The artwork theme (`--art-*`) therefore
  changes once: the page background cross-fades on its own layer
  (`#app-root::before`, opacity, composited; the script holds the previous
  look in `--hold-image` / `--hold-color` for 1.5 s), and the few cards that
  carry a theme color fade it locally (`--fx-panel`, a non-inheriting
  `<color>` property per card). The blurred artwork and camera copies are their
  own layers so a card repainting does not blur them again.
- A state message that differs from the last drawn one only in
  `deliveryRevision` and `generatedAt` (the stream heartbeat) is not parsed or
  rendered; only the clock reference moves. Any other difference, a poll or a
  reconnect draws in full.
- `pulse()` restarts an animation class once per frame at the start of the next
  frame, not with a forced reflow in the middle of the render. A command only
  redraws the controls of its own kind while pending.
- Releasing a press redraws only if a render was held back during the press.

## Hub pages

The Hub dashboard is the first of several whole-screen pages (`src/ui/pages.js`,
`pages.css`, `page-views.js`): **Hem** (the dashboard above), **Musik** (Hem's
music full screen: cover over a soft, enlarged copy of itself, source, title, artist,
progress with elapsed and total time, play/pause and the reported volume; the
Spotify DJ and Optical choices when nothing plays), **Klocka** (large clock,
indoor air and presence) and **Info** (connection, stream, revisions, memory,
screen, browser, and an opt-in swipe probe). Tapping the cover on Hem opens
Musik; the controls on and around it keep their own actions. **Foto** (between
Klocka and Info) is a picture frame over a public iCloud shared album (see
CONFIGURATION.md): one to three pictures at a time in changing layouts (a
landscape full screen, two portraits, a portrait with a landscape, three
portraits, a landscape with two portraits, three landscapes, two panoramas; a
portrait never stands alone with black around it unless nothing else is left).
Pictures taken within a few hours of each other and in the same area are played
near each other, but the groups are shuffled and some pictures wander, so no
group is fixed. Newly added pictures play next, each with a
quiet caption of the place and date the picture was taken. The quick menu (`quick-menu.js`) slides up from the bottom edge when the mouse
moves over the page (a real mouse, or the Hub's bridged one, which
`pointer-bridge.js` announces as the window event `lugn:pointer-move`) or the
page is tapped: Hem's scenes (the dock of the other pages), a camera button
(to the Kameror page) and, on Foto, a button for the next picture. A soft
veil, drawn from each picture's own bottom edge (no blur is computed), a short
dark floor and a very thin dimming of the whole page make the buttons readable. It closes four seconds after the mouse
stops, eight after a tap, on a tap beside it or when the page is left. The
picture stays while it is open. On Foto the music widget (pause, title and
artist; Hem's own play button is pressed) is there whenever music plays, at the
lower left, and is lifted over the menu while that is open; the caption sits at
the lower right. Musik and Klocka have the same menu without the music controls, and no
longer show their dock all the time. The veil is only on the pictures that reach
the bottom edge of the screen (not on the upper ones of a stack). Each picture
drifts and swells about ten percent over the time it is shown (one transform
animation per picture; paused while the page is away; off with the Hub's
localStorage `lugn.photos.kenburns` = `off` or reduced motion). A slide is built off screen, every picture is decoded before it is
shown and only the slide's opacity animates; nothing changes while the pager is
moving, and the page releases its pictures when it is two pages away.

**Kameror** (after Musik) shows every camera at once in a grid; a tap shows
one large, and tapping the small camera view on Hem opens the page on that
camera. It asks the server for pictures only while it is the shown page; see
[Event camera previews](CAMERAS.md#the-camera-grid-page).

Musik and Klocka end in a **scene dock**: Hem's scenes (not the custom ones),
at most six, with Släck last. Its buttons send what Hem's scene buttons send and
show the state Hem's buttons show (selected, pending, waiting for lamps). Musik
reads title, artist, source and cover from Hem's music card, so the same pause
grace, computer media and retained artwork rules apply, and play/pause sends
Hem's playback command. Its progress bar is one compositor animation from the
current position to the end of the track, run only while Musik is shown. A swipe with a finger or
the desk Hub's bridged mouse, a horizontal wheel or trackpad, a vertical wheel
notch outside scrollable areas and the arrow keys turn the page; small dots at
the bottom show where you are. A swipe turns at most one page. Taps and
vertical moves stay with the page, but a press that moved more than 10 px in
any direction is not a tap: the click that may follow it (the browser's after a
mouse drag, or the pointer bridge's) is swallowed.

The pager follows the responsiveness rules above:

- Only the track moves, by `transform`. A drag writes one transform per move;
  the settle after release is one Web Animation sampled from a spring, so it
  runs on the compositor and a busy main thread does not make it stutter.
  Past the first or last page the track follows with resistance.
- The current page is `active`; its neighbours are `near` (painted, static, so
  a swipe reveals them at once; they are drawn from the latest state in idle
  time, about 1.5 s after load and then every 2 s while nothing moves, never
  by the press that starts a swipe); every other page is `off`
  (`content-visibility: hidden`). Page timers run only while their page is
  active (Klocka's minute also while it is a neighbour). Pages other than the
  current one are `aria-hidden`; only `off` pages are also `inert`, because
  toggling `inert` restyles a page's whole subtree and a page turns active in
  the middle of its motion (on a Hub that cost about 100 ms of style and
  layout in the swipe's frames). Focus that lands on a neighbour is sent back,
  and focus left on the page a swipe leaves is let go when the motion ends.
  With a keyboard, Tab passes the neighbours' controls as empty stops; the
  Hubs have none (the pointer bridge keeps the keyboard on the desktop), so
  this is accepted.
- Page modules register `prepare`, `enter`, `leave` and `sleep` hooks with
  `lugnPages.define(id, hooks)` (`enter` and `leave` run once the motion has
  ended, never in its frames); `lugnPages.go(id)` and `lugnPages.onChange`
  are the entry points for later context switching. New pages read dashboard
  data from `display.js` read-only.
- **Mät svep** on Info records animation-frame gaps during swipes and long
  tasks, so the Hub itself can report how a swipe ran; it is off by default and
  remembered per Hub.

The pager announces each page change as a `lugn:page` window event and the
end of every motion as `lugn:pages-settled`; the pointer bridge measures its
hover again on the latter. While a page other than Hem is shown, Hem's camera
view fetches no frames; the last frame stays and fetching resumes when Hem is
shown again. Hem's playback ring keeps running, which costs nothing while it
is not painted.

## Hub roles and access

Each configured Hub has a role (`bed` or `desk`), a Cast receiver IP and a
separate secret URL path. The dashboard listener is configured independently
from the bearer-protected, loopback-only capability API. Keep the display
listener on a trusted LAN and do not publish it to the internet.

Bed prioritizes Helt släckt and Mysljus, followed by Sleep if that scene is
configured, then the remaining available scenes. Desk prioritizes Fokus and
Vardagsljus. Six non-off scenes fit on each page; additional scenes are paged.
All-off remains separate. Missing preferred scenes are skipped rather than
invented. Desk puts Optical before Spotify DJ; Bed keeps Spotify DJ first.
Playback and volume controls remain available on both roles.
The layout pages configured scenes to keep the primary interface within the Hub
viewport, including larger custom scene sets. See
[Hub design and simulated evidence](lugn-2/HUB-UI.md).

Scene, light, music and preset commands identify the authenticated role as actor
`nest-dashboard:bed` / `nest-dashboard:desk` and source
`lugn.cast_dashboard.bed` / `lugn.cast_dashboard.desk`. The server resolves that
role from the Hub's secret path; client-supplied role/source fields are rejected,
and headers cannot override it. This is action provenance, not presence evidence.

The custom Hub dashboard does not use Clerk; it uses a separate secret path
for each receiver. The local operational control panel at `/ui/` supports
optional Clerk sign-in. The machine API continues to use its bearer token, and
the web panel adds routine editing and explicit intelligence preferences. See
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

## Configuration sections

The web panel now separates Overview, Lighting, Music, Routines, Intelligence and
System. It includes visual scene/routine editors, music settings, diagnostics and
disabled-by-default intelligence preferences. Integration topology, home-presence
mapping and receiver roles still use runtime configuration. See
[web behavior and contracts](lugn-2/WEB.md).

### Music automation settings

The web panel's **Musikautomatik** section edits a fixed Auto base for each player,
the shared daily volume curve, additional reduction for multiple people, automatic volume limits and enable
state. Time points use Stockholm local time; the endpoints are 00:00 and 24:00
with matching offsets. Numeric inputs and sliders update the chart together.
Advanced contains the occupancy offset and limits.

The persistent **Auto / Manuellt** selector changes the actual per-player mode.
Manual adjustments also select Manual. Count, room presence and home/away changes
retain that choice until explicit Auto hand-back, including after restart.
**Sänk även manuell volym vid fler än en person** is off by default. When enabled,
Manual uses its own reference plus the person offset, without the daily curve;
one → two → one people restores that reference without stacking discounts.

The current explanation separates reported player volume, configured Auto base,
manual reference, offsets, automatic/effective target and suspension reason.
**Förhandsvisa** uses the draft's configured base at the chosen
time/person count and never dispatches a device command. **Spara och tillämpa**
persists before applying volume policy to eligible players. Manual volume holds
and playback/Pause are retained. **Avbryt ändringar** reloads current settings;
**Återställ standardvärden** only changes the draft until saved. Live state
updates retain dirty drafts, navigation warns about unsaved work, and concurrent
saves are rejected with the draft retained. A BILRESA enable/suspension change
during save preparation also rejects the save before replacing preferences. If
it arrives while the atomic replacement is completing or afterward, the saved
curve/limits apply while the newer BILRESA intent retains control of enable state.

Each saved preference document has a generation also recorded in music intent.
On restart, BILRESA enable/suspension state is restored only for the same saved
generation; older intent cannot override newer preferences even if their values
are identical. Legacy documents without generation metadata remain readable.
A failure before replacement leaves the previous preferences and generation
intact. A directory-sync failure after replacement warns about durability while
keeping the committed preferences and generation in use.

This editor uses the existing authenticated web session, same-origin and CSRF
write protections. It is absent from Nest Hub pages and their API allowlist.

Optional [event camera previews](CAMERAS.md) preserve the Hub scene controls and
music transport while showing a selected camera for a bounded interval. Camera
and event choices, screens, duration and independent automatic/manual switches
are available in the web Intelligence section. New installations start disabled.

The Hub lighting scenes use centered SVG pictograms with small name captions: power for
all off, crescent for cozy lighting, sun for everyday lighting, desk lamp for
focus and screen/play for movie lighting. A configured Party scene uses a disco-ball
pictogram. Touch areas and actions are unchanged.
Accessible names and native tooltips retain scene names and live confirmation
state. Small 13–14px names beneath the icons help users learn their meaning. User-created presets keep their text labels, since their meaning cannot
be safely inferred from an arbitrary name.
