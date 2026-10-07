# Music

Lugn controls configured Home Assistant `media_player.*` entities through
explicit semantic targets such as `music.room`. It does not currently use a
direct WiiM network protocol. Available operations depend on the HA integration
behind the mapped entity.

## Dashboard controls

The custom room dashboard provides:

- **Spotify DJ** — play configured preset 1.
- **Optical** — play configured preset 4, useful for the optical input.
- Play/pause.
- Volume down/up in 5 percentage-point steps.

The capability API includes `music.getState`, `music.play`, `music.pause`,
`music.setVolume` (0..1), `music.fadeVolume`, `music.cancelFade`, and
`music.selectSource`. Fade requests use `{ target, volume, durationMs }`, with a
1 second to 2 minute duration. Source names must appear in the target's
configured `sources` allowlist; copy their exact spelling from the entity's
Home Assistant `source_list`. An empty allowlist disables source changes. The
bridge uses fixed media-player services documented by
[Home Assistant](https://www.home-assistant.io/integrations/media_player/).

The preset numbers can be changed under each `homeAssistant.music` mapping.
Each target can also have an allowlist of exact source names copied from its
Home Assistant `source_list`. The dashboard targets the first configured music
player and does not expose a source selector.

Preset requests use Home Assistant's `media_player.play_media` service with
`media_content_type: "music"` and the configured numeric preset ID. This is the
format used by Home Assistant's built-in WiiM integration to start a stored
preset.

These are explicit user actions. They remain available when HA reports the
resident away; the away gate controls automatic music actions.

### Volume fades

Fades require an available target and a volume observation no older than the
command feedback timeout. The controller interpolates bounded steps (at most
50, no faster than every 250 ms), sends each as a normal volume command, and
waits for that command to be confirmed by the existing ledger before sending
the next step. It stops if feedback leaves the expected segment, the target
becomes unavailable, a direct volume request supersedes it, or feedback times
out. A requested duration must allow at least 250 ms per 0.02 volume step (a
full-scale fade therefore needs at least 12.5 seconds). Cancelling stops future
steps; an already dispatched Home Assistant service call cannot be recalled.

The latest fade is exposed at `music.fades[target]` with its start, target,
nominal duration, expected/observed/last-issued volumes, status, settling end,
and a diagnostic reason when it stops early. A completed fade remains in a
2-second settling window before it is marked complete. That window tolerates
late observations around the target, but a move outside the 0.02 tolerance
marks the fade interrupted. An overall duration-plus-30-second deadline and
the existing per-command timeout keep a stalled fade bounded. These tolerances
are initial software defaults and need measurement against the real WiiM.

Volume matching allows a difference of 0.005 in Home Assistant's 0..1 scale.
An observation cached from before a request cannot confirm it, and a matching
observation only proves that HA reported the expected value. The volume policy
tracks authority separately from attribution: explicit/manual volume changes
claim temporary ownership and update the user baseline. Automatic policy actions
are attributed to Lugn only when they are allowed. See
[Volume policy](#volume-policy) for the distinction between active owner, last
changer, automatic adjustment, baseline and target.

## Automatic playback rules

1. A confirmed room-empty transition pauses each configured player and records
   whether it was playing so a short return can preserve continuity.
2. A confirmed room-entry transition from `confirmed_empty`, from 06:00 until 23:00
   Europe/Stockholm time, resumes the recent playing context when it is still
   within 20 minutes. Otherwise, if nothing is playing, it starts Spotify DJ
   preset 1.
3. From 23:00 until 06:00 (Europe/Stockholm), including after midnight, Lugn
   does not automatically start or resume playback. Reaching 06:00 alone
   does not start music; a new eligible entry is required.
4. A Home Assistant `away` observation immediately pauses currently playing
   music, prevents later presence-driven starts/resumes, and cancels automatic
   volume adjustments. Returning to `home` or `unknown` while the room is occupied
   restores eligible volume policy, but does not itself start music or clear a
   manual volume hold.
5. Home status `unknown` is not treated as away and therefore does not gate the
   room-presence policy. It is shown separately on the dashboard.

Manual play, pause and preset requests still work while away. A confirmed-empty
room continues to pause music regardless of home status.

An explicit user Pause cancels automatic resume eligibility immediately, even
if playback feedback is delayed or the room is already empty. Room re-entry
does not resume or start a preset until the user explicitly plays or starts a
preset again, or a genuinely newer physical Playing transition is observed.
Metadata-only Home Assistant updates keep the reported state visible but do not
cancel that Pause, including after command timeout or history pruning. Playback
transition ordering uses `last_changed`, rather than attribute-update time
`last_updated`. Physical pauses also cancel automatic resume eligibility.

## Volume policy

The automatic volume offset uses Europe/Stockholm local time and is applied
while the room is occupied and the resident is not confirmed away:

| Time              |   Daily offset from baseline |
| ----------------- | ---------------------------: |
| 00:00             |        −15 percentage points |
| 03:00             |       −7.5 percentage points |
| 06:00–22:00       |                     0 points |
| 23:00             |       −7.5 percentage points |
| Approaching 00:00 | falls linearly to −15 points |

The curve rises linearly from −15 points at midnight to baseline at 06:00, stays
at baseline through 22:00, then falls linearly back to −15 points at midnight.
When the STL27L snapshot count is greater than one, Lugn subtracts a further
10 points. An unknown count adds no person offset. These adjustments stack and
the automatic result is clamped to 5–80%.

Dashboard volume changes set a new user baseline after accounting for the
current automatic offset. Thus a manual `+` or `−` remains a five-point step
even when the daily curve is active.

Explicit volume requests from a dashboard/user, physical remote or Home Assistant,
and attributed external WiiM/HA volume changes claim **manual volume ownership**.
While that ownership is valid, no automatic volume command or fade step may run,
including minute ticks, person-count changes and evening/night offsets. Human
volume commands and fades remain available even when automation is disabled,
presence is unknown or HA reports away. Adapter rejection or missing confirmation
does not cancel the human hold or prove that the requested volume was reached.
The calculated automatic target remains inspectable as a counterfactual during
the hold; it is not a command to the player.

Ownership transitions are deterministic:

| Event                                                                                 | Volume ownership behavior                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Human volume request or attributed external change                                    | Manual ownership begins; newer intent replaces the baseline.                                                                                                                                                 |
| Human fade begins                                                                     | Manual ownership begins immediately; its destination is committed after successful settling, otherwise its actual terminal volume is used. Newer human intent takes precedence over a stale fade completion. |
| First confirmed-empty event in an absence                                             | Start one absolute 20-minute continuity deadline.                                                                                                                                                            |
| Repeated empty, empty → unknown → empty, or HA home/away                              | Preserve that deadline; do not extend it.                                                                                                                                                                    |
| Occupied before the deadline                                                          | Preserve manual ownership and volume; cancel the absence countdown.                                                                                                                                          |
| Exact deadline or later                                                               | Release the old manual hold. Send no volume command until room presence is occupied and HA is not away. Keep the baseline for the next eligible policy calculation.                                          |
| Unknown without a preceding confirmed absence                                         | Suspend automatic adjustments without starting a countdown or clearing manual intent.                                                                                                                        |
| Dedicated automatic-volume enable from disabled                                       | Deliberately hand volume back to automation; keep playback Pause independent.                                                                                                                                |
| BILRESA long-press all-off mode restore                                               | Restore the prior enable setting without surrendering a valid manual hold.                                                                                                                                   |
| New human intent after an absence deadline has expired, while still absent or unknown | Claim a fresh bounded 20-minute hold without renewing playback resume eligibility. Repeated empty observations do not extend the fresh hold.                                                                 |

Explicit Play, Pause and preset selection do not change volume ownership. The
manual Pause hold does not expire with the volume continuity window. Disabling
automation, confirmed empty/away, and room presence `unknown` cancel future
automatic fade steps; intentional human fades are still allowed. A human fade
crossing an absence deadline may finish intentionally, but its completion does
not recreate the expired hold. An already dispatched HA service call cannot be
recalled.

The backend volume snapshot exposes `activeOwner`, `lastIntentActor`, `policyEnabled`,
`policyActive`, a typed `activityReason`, and `manualHold` with provenance, creation
time, exact requested volume and optional expiry. `lastIntentActor` records the
latest authorized volume intent, not a claim that the player changed; acceptance
and confirmation remain separate in the command ledger. `effectiveTarget` is the
current owner's destination, while `target` remains the calculated automatic
target. Activity is false for valid manual ownership, disabled
policy, unknown/empty room presence, away status, active fades and unavailable
volume observations. Reads do not mutate the baseline or ownership. Legacy
`controller` and `automatic` fields remain for existing clients.

Dedicated enable clears a temporary hold but preserves an already active human
fade until its terminal state. Competing automatic volume requests are blocked
for that fade's lifetime; its completion does not recreate the surrendered hold.

The Hub volume panel distinguishes the player's current volume from Lugn's
calculated target. It reports who last changed the volume, whether automatic
adjustment is active, the user baseline, and the current daily adjustment. The
person adjustment includes the reported room count, such as `Personer (2):
−10 pp` or `Personer (1): 0 pp`. The dashboard also shows the room count beside
the clock; an unavailable count is shown as unknown instead of reusing a stale
value.

## State and command confirmation

The runtime observes playback, volume, source, title and availability from the
initial Home Assistant state query and later WebSocket updates. Service request
acceptance is separate from observed state:

- matching new playback, volume or source feedback can confirm a command;
- commands time out as unconfirmed when no matching observation arrives;
- preset selection is never reported as confirmed because the HA media-player
  state does not expose the selected WiiM preset;
- a successful HA response does not prove that sound is physically audible.

Home Assistant's REST service response does not give this adapter a causal
command context to match later media-player feedback exactly. An accepted
pause that times out remains eligible for matching paused feedback for up to
30 seconds, so delayed room-empty feedback does not look like a manual pause.
Within that bounded window, a separate external pause to the same state can be
indistinguishable; exact attribution requires a correlated Home Assistant
WebSocket service context.

Within the command feedback timeout, the first changed volume observation
matching an accepted, superseded volume request is attributed to that older
request without clearing a newer pending target. This attribution is consumed
once; subsequent physical changes, including a return to that level, remain
external. Without a causal HA context, an external change to that exact older
level can be indistinguishable from its first delayed feedback.

After newer human intent, the first changed observation matching an older
accepted or still in-flight **automatic** volume command is attributed to that command for up to
30 seconds from both the older command and the human intent, including commands
that have already confirmed or timed out. It updates reported volume but cannot
replace the manual baseline or interrupt a newer human fade. Attribution is
consumed once; metadata-only repeats keep ownership unchanged. Explicit command
correlation is honored for retained commands regardless of delay. Once records
are pruned, or outside the uncorrelated window, HA REST cannot distinguish delayed
feedback from a genuinely newer physical change to the same value. Such a change
can update the baseline but never releases a manual hold.

Each target must map to a distinct `media_player.*` entity. Preset IDs default
to Spotify DJ `1` and Optical `4`; exact source names are allowlisted per
target. The adapter uses fixed `media_player` services and does not accept an
arbitrary entity ID or service call from a dashboard request.

## Current limitations

- Music control depends on Home Assistant exposing and supporting the needed
  media-player service for the mapped device.
- Preset request confirmation is unavailable from the current HA observations.
- Direct WiiM transport is not implemented. Software fades use Home Assistant
  feedback, but their timing has not been measured against the connected WiiM.
- Automatic behavior is configured for the room-level policy; the dashboard
  does not provide a player/source selector or an automation settings editor.
- Music ownership and baselines are currently process-local; restart persistence
  is a separate follow-up. Restart does not restore a saved music hold.
- Physical WiiM timing, causal HA feedback attribution and fade trajectory
  tolerances remain unverified. On a test instance, change volume physically
  while occupied, cross 22:00/23:00/midnight/06:00, leave for less than 20 minutes,
  then leave beyond the exact 20-minute boundary. Verify the HA command log has
  no automatic volume commands during the hold, and that only eligible return
  reactivates policy. Also interrupt fades, disconnect/reconnect HA and delay
  service feedback; compare reported volume and command confirmation separately.
