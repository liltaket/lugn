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
away, during lighting quiet hours (23:00–06:00), when the active scene requests
all configured lights off, or when a configured room light is already on. The
exact gate is reported in the runtime diagnostics.

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
