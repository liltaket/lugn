# Computer observations and targeted playback

Lugn optionally consumes the Linux Desktop Agent MQTT v1 protocol. Configure
both services with the same broker, topic prefix and unique device ID. The
canonical wire schemas and fixtures are maintained with the Linux agent under
`agents/linux/protocol/` in the companion agent PR. Lugn's deterministic tests
include copies of its examples under `tests/fixtures/computer-mqtt/`.

## Configuration

Add `computers` to the existing `mqtt` configuration. Credentials still come
from `usernameEnv` and `passwordEnv`; all adapters share the MQTT subscriber.
Existing STL27L settings remain in the same `mqtt` object.

```json
{
  "computers": [
    {
      "deviceId": "desktop",
      "baseTopic": "lugn/computers",
      "maxAgeMs": 90000
    }
  ]
}
```

The default is an empty list, which disables computer integration. Device IDs
must be unique, 1–64 ASCII letters, digits, underscores or hyphens, starting
with a letter or digit. Prefixes must be concrete topics without MQTT wildcards.
`maxAgeMs` is 1000–300000 milliseconds, default 90000. Set it comfortably above
the agent heartbeat interval (default 30000 ms); for example, three intervals.
Lugn's existing MQTT presence subscription is unchanged.

Each computer subscribes at QoS 1 to:

- `{baseTopic}/{deviceId}/state`: complete, retained v1 JSON snapshots.
- `{baseTopic}/{deviceId}/availability`: retained v1 JSON online/offline, including Last Will.
- `{baseTopic}/{deviceId}/events`: non-retained v1 JSON `state_changed` notifications.

These observation subscriptions remain read-only. Targeted playback is a separate,
explicit opt-in extension described below.

## Liveness and recovery

The adapter validates device identity, version, UUID session, safe-integer
sequence/timestamp, nested fields and bounds before normalizing a snapshot.
Payloads are limited to 256 KiB, strings to 512 JavaScript code units, media
players/artists to 64, and audio application/role lists to 128. The Linux producer
uses equal or tighter UTF-8 byte and aggregate metadata bounds. Additional v1
fields are ignored; unsupported versions and malformed snapshots invalidate
current readings. Malformed event notifications are ignored.

Online requires all of the following:

- the broker connection is active;
- online availability matches the snapshot's process session;
- a live, non-retained snapshot has arrived since the last disconnect/offline;
- its source timestamp is younger than `maxAgeMs` and at most 5 seconds ahead;
- its sequence advances within that session.

Availability and state may arrive in either order. Retained availability is
accepted; retained state is only a cache and never establishes liveness. After
a broker reconnect, the dashboard can remain unknown until the next live
heartbeat. QoS duplicates and out-of-order state do not extend freshness.
Freshness expires using monotonic elapsed time, bounded by source timestamp age
at receipt, so wall-clock changes after receipt cannot prolong a snapshot.

Offline availability immediately clears readings. Broker loss, expired,
malformed or missing data produces unknown readings; none means unlocked,
inactive, silent or physically absent. A new online session replaces the old
session; delayed offline/state/events from recent retired sessions are ignored.
Deduplication and retired-session history are bounded to 64 sessions per device.
Events are validated and deduplicated separately, exposed as `lastEvent` with
source/receipt timestamps, and never change readings or refresh liveness.

## State and dashboard

`state.computer.devices[deviceId]` appears in existing state snapshots, HTTP
state endpoints, operational overview/SSE, and resumable `computer` stream
patches. Each observation contains availability, freshness/reason, timestamps,
session/sequence, desktop readings, advisory activity and the last live change
notification. Computer readings are ephemeral and are not restored as intent.

Readings include NetworkManager connectivity, lock state, idle state, active
application, fullscreen, PipeWire playback/application roles, and MPRIS player
metadata. `null` means unknown; `false` is an observed negative. `media: []`
means discovery succeeded and found no players, while `media: null` is unknown.
Network connectivity and MQTT agent availability are separate observations.
PipeWire running streams do not prove audible sound. The agent supplies idle
state, not elapsed idle seconds.

The operational dashboard shows a compact computer section only when configured,
with secondary details expandable. `Bedömd aktivitet` displays the agent's
classification separately from readings. It is advisory context, not physical
room occupancy, music-player intent or a requested automation. Computer observations never stand in for physical room presence. Observation-only
configuration does not change lighting, music or room sessions.

## Validation

`tests/computer-mqtt.test.ts` covers wire examples, observation transitions,
retained packets, duplicate/out-of-order deliveries, source age and expiry,
malformed payloads, session changes, broker reconnects and non-authoritative
events. Engine/stream and composed-runtime checks cover API delivery and
observation-only behavior. Hardware and real-broker interoperability should be
verified with the companion Linux agent before marking the Draft PR ready.

## Optical now playing on Nest dashboards

### Optional album art and Firefox thumbnails

Set `collect_artwork = true` in the Linux agent configuration and
`computerAudio.artwork: true` on the desired receiver mapping below. Both options
default off. This authorizes reading the selected players' artwork metadata;
Spotify image IDs are fetched from `https://i.scdn.co/image/` by the room service.
No titles, search queries, HA credentials or browser history go to that server.

Firefox's local MPRIS PNG thumbnail is resized on the desktop to a JPEG of at most
240 × 240 pixels / 24 KiB. Only Firefox's fixed, owned MPRIS cache directories
are readable; symlinks, other files and oversized images are rejected. The small
image travels over the existing private MQTT observation connection. Protect
broker access as for titles/artists. There is no external YouTube lookup.

The image follows the exact player selected for the Optical title, using the same
freshness, ambiguity and receiver-trust checks. Missing or unsupported artwork
uses the existing dashboard fallback. Other inputs retain their HA artwork.
Older agents and configurations remain compatible, and neither option starts
playback, switches input or changes room intent.

Map the receiver's actual computer input to a configured MQTT computer in
`homeAssistant.music`:

```json
{
  "music.room": {
    "entityId": "media_player.room",
    "sources": ["Spotify", "Optical In"],
    "computerAudio": {
      "deviceId": "kuffe",
      "source": "Optical In"
    }
  }
}
```

The source is an exact Home Assistant observed input name. A requested Optical
preset or the receiver's title `4` does not confirm that input. Both Nest roles
receive the same `computerNowPlaying` presentation context over polling and SSE.
When the receiver is playing the mapped input and both receiver and computer
observations are trustworthy, the Hub shows the selected computer title,
artist/channel without application names or repeated source labels. Titles are
shortened to 56 characters and artist/channel to 42. Spotify DJ and
other inputs retain their receiver metadata. Without playback control enabled, playback and volume controls
continue controlling the receiver; the media projection does not rewrite
physical observations or create automation intent.

Selection only considers fresh online computer media reported as `Playing`
with a useful title. It prefers a unique active application/DesktopEntry match,
then unique application-name audio corroboration, then the most recently
observed transition into Playing, then a meaningful title/artist/album change.
Equal candidates keep the prior winner when still eligible; otherwise the
screen says multiple media are playing. There is no intrinsic video/music
preference. After a known pause/idle transition, the browser retains the last
playing title for eight seconds, labelled as last played (or paused when the
receiver explicitly reports paused). Polling does not extend this deadline; new
playing media appears immediately. A fresh online producer’s temporary `media: null`
refresh uses that same deadline and last-played label. Offline/stale data, ambiguity, source changes,
and producer/server restarts clear the presentation cache immediately. A page
opened while already paused has no cached title. Physical observations and the
backend selector remain unchanged.

Heartbeats, first discovery and identity enrichment do not establish recency.
Fingerprints survive the producer's transient `media: null` refresh within a
healthy session; unknown data is hidden, and unchanged recovery is no new
track. Offline/stale data and new producer sessions rebase selection history.
Known player removal clears that player's history. These times describe changes
observed by Lugn, not actual playback-start time or transitions missed offline.

PipeWire application names can corroborate some MPRIS players but cannot
reliably distinguish browser tabs. Global `audio.playing`/roles do not identify
the sounding player, and silent Playing video remains a candidate. The v1 feed
contains no reliable audible-loudness measurement; selection does not claim to
pick the loudest stream. If no reliable title exists, or either link is stale,
the Hub shows a generic idle/unknown Optical status instead of `4` or an old song.

## Optional Optical playback control

Set `homeAssistant.music["music.room"].computerAudio.playbackControl` to `true`
and enable `control_enabled = true` in the Linux agent's protected configuration.
Both default to off. Configure authenticated broker credentials and device-scoped
ACLs; Lugn uses its existing `mqtt.usernameEnv` / `passwordEnv` references. No
credentials, lease tokens or private broker payloads belong in logs or Git.

The additive CONTROL v1 contract is maintained in the agent's
`agents/linux/protocol/CONTROL.md` and `control-*.schema.json`. Lugn vendors its
examples under `tests/fixtures/computer-control/`. Observation v1 is unchanged.
The extra topics are `{baseTopic}/{deviceId}/control/state` (retained, read),
`control/command` (non-retained, write), and `control/ack` (non-retained, read),
all QoS 1. Commands have a 10-second delivery expiry and are never intentionally
retried. Retained state cannot authorize commands; both observation and control
feeds must be live, fresh and in the same session. A new broker connection nonce,
player instance or content identity invalidates old permission.

Only the **observed** configured Optical input selects this route. Volume and
input/preset commands still address the receiver. If a confirmed Optical input was
already paused/muted, a fresh return with already Playing desktop media or a
confirmed owned Resume opens the receiver input again. Explicit Play can also
restore that pass-through. Source/trust, policy and newer manual holds are
rechecked first; this never continuously overrides a physical receiver mute.
Playback requests, including
Nest Pause/Play, address the exact selected MPRIS player instead of muting Optical.
Unknown or unavailable desktop control blocks playback; it never falls back to
receiver Pause or starting a Spotify preset. Other observed inputs retain their
existing behavior.

The existing room-presence policy still determines exit/return timing, the
20-minute continuity window, quiet hours, home-away and explicit manual-pause
holds. On confirmed exit Lugn requests Pause for the selected Playing media.
If fresh computer status is still pending at that transition (including a
restored empty-room exit), Lugn keeps one deferred pause within the original
continuity deadline. Fresh Playing consumes it once; known Paused, return,
expiry or newer intent cancels it. It does not repeatedly pause new app starts
while the room stays empty or renew a restored continuity window.
Only a verified applied pause grants a short-lived lease. On return Lugn may
resume that exact player instance/content using the one-use lease; it cannot
start an arbitrary player or claim a pause the user already made. Nest Play is
available only for a pause owned by this Lugn process. Rapid returns wait for
pause confirmation and the matching lease report, with a bounded telemetry wait.

Stopping, externally restarting or replacing the media, losing the device or
broker, switching input, expiry, and agent/controller restarts revoke permission.
Leases are memory-only and are never reconstructed from retained state after a
restart. A lost or uncertain command result grants no new ownership or automatic
retry. The receiver's physical playback/source/title remain in
`state.music.devices`; separate command eligibility, effective desktop playback,
pending state and the last command appear in `state.music.computerPlayback` over
the existing state/API streams.

MPRIS has no atomic compare-and-resume operation or causal pause acknowledgement.
The agent pins the unique D-Bus owner, checks content and capabilities, observes
transitions and rechecks immediately before calling Pause/Play. A user action
racing the final check cannot be excluded, and an already-sent D-Bus method cannot
be retracted by a local timeout. This is guarded best effort; ambiguous outcomes
never establish ownership. No shell commands, volume control, computer power
control or generic D-Bus invocation is exposed.

### Previous, next and seek

On the computer input the Hub's previous, next and time bar address the selected
**playing** media, with the same identity checks, through the control actions
`previous`, `next` and `seek`. The agent offers each only where the player
reports `CanGoPrevious`, `CanGoNext` or `CanSeek`. They take and grant no pause
ownership and are not available while the media is paused. Applied means the
player accepted the call: MPRIS gives nothing to confirm, and many players treat
previous as "back to the start" first. They are never retried.

Update Lugn before the agent. An updated agent reports the three capabilities in
its control state, which an older Lugn rejects as unknown fields; an updated
Lugn with an older agent keeps Play and Pause and leaves the new controls
disabled.

## Fast WiiM Optical switching

The Linux agent switches the WiiM to its Optical input by itself as soon as the
computer plays real, sustained sound and the WiiM is not playing its own music.
It is **on by default** for every configured computer: with no address the agent
finds the WiiM on the LAN. Lugn does not decide or switch anything; it holds the
settings, publishes them to the agent (retained, OPTICAL v1) and shows what the
agent reports. The mechanism, the WiiM HTTP API it uses and the audibility rules
are in `agents/linux/protocol/OPTICAL.md`.

The optional `opticalSwitch` entry of a computer in `mqtt.computers` sets the
defaults (all fields optional):

```json
{
  "deviceId": "kuffe",
  "opticalSwitch": {
    "enabled": true,
    "wiimHost": null,
    "audioSink": "alsa_output.pci-0000_00_1f.3.iec958-stereo",
    "minAudibleMs": 400,
    "releaseMs": 1500,
    "levelDb": -55
  }
}
```

`enabled: false` makes the agent leave the WiiM alone. `wiimHost` is a private
IPv4 address or `.local` name for when discovery finds none or several.
`audioSink` pins the capture to the sink wired to the WiiM so sound on other
outputs is ignored. `minAudibleMs` (200-5000) is how long sound must last before
the switch, so lower is faster; `releaseMs` (500-10000) is the silence that ends
a run of sound, after which the next sound is a new decision; `levelDb` (-80 to
-20) is how quiet a sound may be and still count.

The Datorer page has a **Datorljud till WiiM** section: the live status per
computer (what the agent is doing, which WiiM it found or was given and how,
what the WiiM is doing, the last switch and how long it took) and a form for all
of the above. What is saved there overrides the configured defaults, is
published to the agent at once and survives restarts
(`<state path>.optical-switch.json`). Saves are checked against the settings
generation like the display settings. The status says when the agent has not
received the saved settings yet or still uses its own file, which happens when
it has no MQTT credentials or the broker ACL lacks `optical/settings` (subscribe)
and `optical/state` (publish).

## Optional display sleep and wake

Lugn can put a computer's display to sleep when the room is empty and wake it
again on return, as the old Windows bridge did. It is off by default and is
configured per computer. It needs the Linux agent's `display_control_enabled`
option (see `agents/linux/protocol/DISPLAY.md`) and authenticated MQTT, exactly like
playback control. Lugn owns the policy; the agent runs one fixed
`kscreen-doctor --dpms off|on` (or `xset`) request and reports what the GPU is
doing.

```json
{
  "mqtt": {
    "usernameEnv": "LUGN_MQTT_USERNAME",
    "passwordEnv": "LUGN_MQTT_PASSWORD",
    "computers": [
      {
        "deviceId": "kuffe",
        "display": {
          "offAfterEmptyMs": 120000,
          "ensureOffWhenAway": true,
          "wakeOnEntry": true,
          "wakeInQuietHours": false,
          "quietWakeMaxAbsenceMs": 1200000,
          "inhibitOnActivity": true,
          "activeInhibitMaxMs": 1800000,
          "idleSleepAfterMs": 1800000,
          "ignoreIdleBlockers": ["T3 Code"]
        }
      }
    ]
  }
}
```

`"display": {}` enables everything with the defaults shown. `reassertOffMs` (default
15 minutes) and `powerSensor` are only for the open-loop fallback below.

### Feedback instead of guessing

A monitor reports nothing about itself, but the kernel reports the picture signal
per connector (`/sys/class/drm/card*-*/dpms`). The agent publishes it as
`power` (`on`, `off`, `partial`, `none`, `unknown`) and acknowledges a request as
`applied` only after that state followed. It is the GPU's view, not proof the panel
is dark, but it removes the need for a power-metering plug on this hardware. It
also catches what exit status misses: on the reference desktop two of the first
four requests exited 0 and changed nothing, and were reported `not_observed`
once verification existed.

The agent also reports `input_idle`: no keyboard or pointer input for two minutes,
**ignoring idle inhibitors**. The ordinary `idle` observation honors inhibitors, so a
playing video or a busy tool keeps it `false` and it cannot tell a person from an
inhibitor.

### Policy with feedback

- **Sleep.** Once presence is `confirmed_empty` (or Home Assistant says `away`) and
  has stayed so for `offAfterEmptyMs`, Lugn requests `off`, but only while the
  display is observed `on` (or `partial`). A display already dark, or a monitor not
  on the bus, gets nothing. There are no blind repeats.
- **Never while someone types.** Recent real input (`input_idle: false`) holds sleep
  for as long as it lasts, however the presence sensor sees the room. A game or
  video (`gaming`/`video` activity) holds it for at most `activeInhibitMaxMs`
  after the room emptied, so a looping clip cannot keep an empty room lit forever.
  `inhibitOnActivity: false` disables both.
- **Few, spaced retries.** A request that changed nothing (`not_observed`) is
  retried after 30 s and 1 min, then Lugn stops and reports `problem: off_failed`
  until the room is occupied and empty again. After an applied sleep the next
  request waits at least ten minutes, which also covers the agent's state lagging
  its acknowledgment, and at most four applied sleeps are sent per empty period
  (`problem: keeps_waking`). A display that wakes by itself (a bump, or a
  presence miss) is therefore left alone for ten minutes rather than fought.
- **Tracking loss is not absence.** `unknown` presence sends nothing, and it does
  not restart the empty wait.
- **Wake.** When presence is confirmed `occupied` again (or you are home again),
  Lugn sends `on` **once** (at most three attempts if it changed nothing), but
  only if it put the display to sleep _because the room emptied or you were away_.
  A display that went dark for **inactivity** (or any other reason) is not woken
  by Lugn, not even when you leave the room and come back; the keyboard or mouse
  wakes it. It does not wake a display that is already on, is skipped in quiet
  hours (23:00–06:00 Stockholm, like music) unless `wakeInQuietHours` is set or
  the absence was short (the room was empty, or you were away, at most
  `quietWakeMaxAbsenceMs`, 20 minutes by default; 0 turns this off), and
  reports `problem: wake_unavailable` when no monitor is on the bus. After a
  restart of Lugn nothing remembers why the display went dark: if the room is
  empty then and the agent's last request was a sleep, it is taken to be the
  presence rule (inactivity sleep only happens with someone in the room); with the
  room occupied it is left alone.
- **Waiting, not queueing.** A request is only sent while the computer observation
  and the display state are live, fresh and from the same session.

### When nobody is home

Home Assistant reporting `away` counts as an empty room, with one difference:
with `ensureOffWhenAway` (default on) Lugn keeps making sure the display is off
for as long as you are away. A display that lights up again (a bump, the monitor
re-announcing itself) is put back to sleep after an hour, with no cap on how many
times, and a request that changed nothing backs off to an hourly try instead of
giving up. Recent input at the computer still holds it (someone is there), and
returning home wakes it as for any return. Switch it off to treat `away` exactly
like an empty room, with the limits above.

### Sleep after inactivity

Independently of presence, Lugn puts the display to sleep after
`idleSleepAfterMs` (default 30 minutes, `null` turns it off, minimum 5 minutes)
without keyboard or pointer input, with the room occupied or not. Any input wakes
the display as usual (KWin does that), and a fresh stretch of inactivity then
starts. It needs the agent's display feedback; without it nothing is sent.

It has to be certain that nobody is watching, so it asks for _positive_ evidence:

- **Music never holds it.** Nothing about media players is used. A player that
  claims to be "Playing" (a remote-controlled app, Spotify Connect to a receiver,
  playback on another device) is irrelevant; only the signals below count.
- **Video holds it**: a PowerDevil blocker whose reason mentions video (browsers
  raise "Playing video" while a video plays), the computer's activity classified
  as `video` or `gaming`, or a full-screen window with a player that is `Playing`
  while sound runs _on this computer_ (all three are needed: browsers keep silent
  running streams for their tabs, and a remote-controlled player says nothing
  about this screen).
- **Any other blocker holds it** unless its application is listed in
  `ignoreIdleBlockers`, because a video player can be an idle blocker with another
  reason. Blockers whose reason is "Playing audio" are music and never hold it.
  Application names are matched case-insensitively.
- **Unknown holds it**: unreadable blockers, a computer observation that is not
  live and fresh, or the compositor reporting an inhibitor (`idle: false` while
  input is idle) with nothing listed to explain it.
- **A display that lights up by itself** in the same stretch (a bump without
  input) is left alone for ten minutes, at most four times; a request that
  changed nothing is retried at 30 s and 1 min, then given up for that stretch.

Limits: a silent video that raises no blocker and is not full-screen, or a
blocker raised only through a Wayland idle-inhibit protocol while another listed
blocker is active, cannot be seen. Unknowns above are treated as "somebody may be
watching". The reason sleep is held is visible in `idleSleep.heldBy`.

### Open-loop fallback (no `power` reported)

On a system where the kernel offers no readable state (`power: unknown`, for
example some non-DRM setups) the policy does what it did before feedback existed:
one sleep request after the wait, repeated every `reassertOffMs` while the room
stays empty, with a capped hold for recent activity (`idle: false`) when the agent
cannot report `input_idle`, and failures retried with backoff. A wake is sent once
per return. In that mode only, an optional power-metering plug can serve as
evidence:

```json
{
  "powerSensor": {
    "entityId": "sensor.monitor_plug_power",
    "onAboveWatts": 15,
    "standbyBelowWatts": 3,
    "settleMs": 20000
  }
}
```

Lugn only **reads** the plug (a Home Assistant `sensor.*` in watts, also kW or mW)
and never switches its relay. Draw after a sleep request shortens the repeat to
about two minutes; standby backs it off to six hours and suppresses a first
request; after a wake, standby means it did not take (retry, at most three) and
draw means it did. A class change counts only after it held for `settleMs`.
Thresholds are placeholders: measure the monitor in use and in standby. The plug
is also reported in the status alongside the agent's reading, where it is the only
way to see a monitor that sleeps by itself while the GPU still sends a picture.

### Settings in the control panel

The Datorer page has a **Skärmstyrning** section: the live status per computer
(display on or off as reported, when it will sleep for inactivity or why it will
not, the last command) and a form for the settings. The `display` entry in the
runtime configuration decides that the feature exists for a computer and gives
the defaults; what is saved in the panel overrides them, is applied at once
without a restart and survives restarts (`<state path>.display-power.json`).
The form edits the master switch (off: nothing is sent), the wait for an empty
room, keeping the display off while away, sleep after inactivity and its time, whether
to wait while the computer is in use or plays video or a game and for how long,
which blockers to ignore, and waking on return (also at night). "Återställ
grundinställning" returns a computer to the configured values. Saves are
checked against the settings generation, so a change made elsewhere meanwhile is
reported as a conflict instead of being overwritten. Settings the panel does not
show (`reassertOffMs`, `powerSensor`) stay in the configuration.

### State

`state.computer.displays[deviceId]` (state, SSE and the `computer` stream patch)
shows `enabled` (the master switch), `control` (`available` only while a request could be sent), `desired`
(`off`/`on`/`null`), `inhibited` (`recent_input`, `recent_activity`,
`video_or_game`), `observed` (`power`, `inputIdle`, `changedAt`), `lastRequest`
(`applied`, `rejected`, `uncertain`, `failed`, with the agent's reason),
`problem`, `idleSleep` (`inactiveSince`, `dueAt`, `heldBy`: `video`, `game`,
`fullscreen_playback`, `other_blocker`, `unexplained_inhibitor`, `computer_unknown`,
`blockers_unknown`, `no_feedback`, `keeps_waking`, `off_failed`), `nextAttemptAt`
and any plug `evidence`. Status is not restored after a
restart: a restart starts a fresh empty wait.
