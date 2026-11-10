# Presence and room continuity

Presence answers "is the room active now?"

Continuity answers "should the room still remember what was happening before the absence?"

These must be separate concepts.

Home/away is a third, independent signal. It answers whether the resident's
configured Home Assistant person or tracker is at home; it does not replace
room occupancy.

## Home and room presence

The runtime reads one Home Assistant `person.*` or `device_tracker.*` entity,
configured as `homeAssistant.homePresence.entity`. The example defaults to
`device_tracker.lustigkurre`. Its state is normalized to `home`, `away` or
`unknown` and displayed separately from STL27L room occupancy.

Only a confirmed `away` state blocks automatic room activation. It suppresses
presence-triggered scene reconciliation, prelight and music automation. If
music is already playing, Lugn pauses it. Confirmed-empty still turns lights
off and pauses music. Home status `unknown` is not treated as away.
When `away` clears to `home` or `unknown` while the room is occupied, lighting
reconciles immediately, including at night, without another sensor entry.

The gate applies to automation. Explicit dashboard scene, light and music
requests remain usable while away. That lets a person intentionally control a
room remotely without allowing a passer-by sensor event to reactivate it.

## Normalized presence state

At minimum:

- occupied
- confirmed_empty
- unknown

Unknown must not be silently converted to empty.

Examples that can produce unknown:

- sensor communication failure
- tracking uncertainty
- restart before reliable state is established

## Person count

Person count can be known or unknown independently from occupancy. The current
MQTT adapter reads the STL27L snapshot count; a different sensor integration
should preserve unknown count when it cannot count people rather than invent
one.

When occupied state includes a valid count, Lugn shows that count on the Hub
dashboard and labels the music adjustment with the same number. If an event
does not include a count, Lugn clears the prior count and shows it as unknown
instead of reusing a stale value. A confirmed-empty event with no count is
normalized to zero people.

An optional `presenceControl.baseUrl` enables "Sätt till 1 person" on both
authenticated Hub dashboards. The `presence.setCountOne` capability corrects
the STL27L sensor's persistent ledger through `POST /api/manual` and requires
an acknowledgement of count 1. Dashboard provenance uses the authenticated
Hub role, independently from occupancy. Neither accepting the correction nor
the sensor's HTTP acknowledgement updates Lugn's presence: MQTT remains the
source of reported room state and automatic lighting/music decisions. The
dashboard therefore confirms the ledger acknowledgement while waiting for
sensor status. An unavailable sensor or invalid acknowledgement reports a
failure; the control stays hidden when no URL is configured.

## Sensor page in the control panel

With `presenceControl.baseUrl` set, **Inställningar → Närvaro** shows the
sensor live and edits it. The page is Lugn's; the sensor service remains the
owner of its configuration, ledger and perception.

- **Live radar and status.** The browser opens `GET /ui/api/presence-sensor/stream`
  (server-sent events). Lugn keeps one WebSocket to the sensor's `/ws/stream`
  only while someone is watching, validates each frame, and drops fields the
  page does not draw (the Home Assistant door entity and the serial port).
  A slow viewer skips frames instead of queueing them. Leaving the page closes
  the stream. The sensor's processing thread runs close to capacity on its Pi, so
  Lugn asks for 5 frames/s and every 8th point (`?max_fps=5&point_step=8`),
  about a tenth of the overhead of the sensor's own page; a sensor that predates
  these options ignores them and streams at full rate.
- **Settings.** The form is built from the sensor's `GET /api/v1/config`
  (keys, ranges, units) and saved with `PUT /api/v1/config`, so ranges are
  defined once, in the sensor. The sensor validates the whole request before
  it applies anything and rejects unknown keys. Lugn sends only changed keys.
- **Recalibration.** Changing geometry or motion settings makes the sensor
  learn its background again; the page asks for confirmation first, and while
  it relearns the sensor's quality is not `CERTAIN`, which Lugn already maps
  to `unknown` rather than empty.
- **Count correction.** −1, +1 and Nollställ write the sensor's ledger through
  `/api/manual`. As with "Sätt till 1 person", Lugn's own presence state
  still follows MQTT.

These actions are typed capabilities (`presence.getSensorConfig`,
`presence.updateSensorConfig`, `presence.recalibrate`, `presence.setCount`) and
use the panel's session, same-origin and CSRF checks. They are not exposed on
the Hub dashboards. The prelight and confirmed-occupancy path stays on MQTT
and does not depend on this page.

## STL27L role

The STL27L path may provide:

- occupancy
- person count
- possible pre-entry signal
- door/passage context
- last reliable position
- movement direction / trajectory when reliable
- sensor health
- source/session/sequence information

Raw LiDAR processing belongs in the sensor side, not inside lighting or music logic.

## Stillness is not absence

For a people-counting / tracking model:

> No motion is not equivalent to an empty room.

A stationary user must not disappear merely because there has been no movement event.

Likewise:

> Unchanged person count is not evidence that the sensor is dead.

Heartbeat/health and count changes are different observations.

## Immediate physical behavior

Confirmed transition to empty can trigger immediate physical actions:

- lighting off
- music pause

There should not be a long grace period before the room visibly shuts down.
By default there is none. An optional short exit grace (below) lets a quick
trip out of the room pass without lights and music following it.

## Exit grace and chime

Both live in **Inställningar → Närvaro → Utgång och ljud** (the page appears
with `presenceControl.baseUrl`), are saved next to
the lighting intent (`<state>.presence-feedback.json`) and apply without a
restart. They sit between the sensor's MQTT adapter and the engine.

- **Exit grace** (`exitGraceSeconds`, 0–600, default 0). When the sensor
  reports confirmed empty after a confirmed occupied, the engine is told only
  after this many seconds. If the sensor reports occupied first, the engine
  never hears about the exit, so lights do not flicker and music does not
  pause and resume. A repeated empty report does not extend the wait. `unknown`
  cancels it and is forwarded: unknown never shuts a room down, and the next
  confirmed empty starts a new wait. Entry, prelight, count corrections and the
  first report after a restart are never delayed. Changing the setting re-times
  a wait that is already running from its original start. Presence itself
  therefore still reads occupied during the wait. The wait is its own state,
  `presence.exitPending` (`startedAt`, `until`), set when the wait starts or is
  re-timed and cleared by the next presence report. The control panel shows it
  as "Rummet verkar tomt" with a countdown (on the server's clock, so a wrong
  browser clock does not matter), a banner with a progress bar on the Närvaro
  page, and "släcker snart" on the Hub displays. Engine diagnostics record
  `presence.exit_pending`.
- **Chime** (`chime.enabled`, `entry`, `exit`, `volume`, `style`). A short,
  quiet two-note blip (rising for entry, falling for exit) played from
  BrunoCAM. Three styles: `glass` (soft bell-like blip, the default), `soft`
  (rounder, more muted) and `tick` (short and dry). Every style is scaled to the
  same peak, so a style change does not change the loudness, and moving the
  volume or picking a style on the page plays it at once.
  It follows what the sensor reported, not the grace, so it still confirms an
  exit that Lugn has not acted on yet. A higher person count is an entry and a
  lower one an exit, so it also answers when the room stays occupied. It is
  silent for `unknown` (the count is not compared across one), for the first
  report after a restart, and for repeats. The audition buttons play the
  volume currently on screen, saved or not.

The chime runs in its own `aplay` process, started after the engine has been
given the event, so playback cannot delay lighting. All voices are rendered at
startup, so an event only scales one to the volume (about 2 ms on the Pi) and
starts `aplay`; the sound begins 20 ms of silence after the device opens. Blips closer than 1.5 s
apart are dropped, never queued. Optional
`presenceFeedback.audioDevice` in `config.json` names the ALSA device
(`aplay -L`); without it the system default is used. A failing player is
logged at most once every five minutes and never affects presence.

## Continuity after leaving

Logical context remains for a configurable period.

Example:

    occupied
      -> confirmed_empty
      -> lights OFF immediately
      -> music PAUSE immediately
      -> scene + overrides + media context remain remembered

If the user returns shortly:

    restore effective scene
    restore remembered media context
    continue same room continuity

If confirmed absence lasts long enough:

    selected state expires according to its policy
    next entry can behave as a fresh visit

A short bathroom break should therefore not be treated as returning home hours later.

## Decay only from trustworthy absence

Decay timers should normally begin from confirmed_empty, not from unknown.

An `unknown` sample between two `confirmed_empty` samples does not count as a
second exit: it must not extend the continuity deadline or reset the music
resume window. A real exit is based on the last confirmed room state, so
`occupied -> unknown -> confirmed_empty` still starts one.

Sensor tracking loss must not cause:

- clearing overrides
- starting a new room session
- unwanted Spotify autostart on rediscovery
- shutting down a monitor while someone is watching or playing

After a restart, a retained expired sleep scene may remain the logical scene,
but its positive light output waits for a fresh confirmed occupied event.
Explicit all-off intent remains safe to reassert while presence is unknown.

## Last known position

Track separately:

- current position, if reliable
- last reliable position
- last seen timestamp

If the sensor last saw a person enter a desk area and then tracking becomes uncertain, that may remain useful context.

It is evidence, not permanent truth.

## Prelight

Prelight is separate from confirmed occupancy.

Desired behavior:

    possible entry -> preview the selected scene's on-lights only
    confirmed entry -> apply the selected scene, including explicit off states
    preview OFF -> keep the temporary output until entry is confirmed or the
                    existing maximum duration expires
    no confirmation by timeout -> restore the physical state observed before prelight

When no scene is selected, prelight uses the Vardagsljus preset. It must never
use a static target list that can turn on a light excluded by that scene. The
prelight snapshot gives current device observations precedence over remembered
desired state, and timeout restoration is sent even when the preview receives
no device feedback. Occupancy and explicit user intent take over only after any
restore already in flight completes, then reconcile the final scene so an old
restore cannot leave the room off.

Prelight must not:

- start music
- increment person count
- clear manual overrides
- pretend occupancy is confirmed

In addition, prelight is suppressed when Home Assistant explicitly reports
away, when the room is occupied, when the active scene requests all
configured lights off, when every light it would turn on was switched off by
hand, or when a configured room light is already on. Prelight is not limited
by the time of day. The exact gate is reported in the runtime diagnostics.

## Future computer-intent inference

Presence alone should not mean "turn the monitor on."

A future experimental intent layer may combine:

- desk-zone information
- movement toward desk
- last reliable position
- recent keyboard/mouse activity
- PC lock/idle state
- fullscreen/media/game context

Mouse/keyboard activity remains a reliable fallback for waking the display.

Trajectory-based prewake is explicitly optional and should not be required for the core system to work.
