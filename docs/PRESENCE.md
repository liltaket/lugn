# Presence and room continuity

Presence answers "is the room active now?"

Continuity answers "should the room still remember what was happening before the absence?"

These must be separate concepts.

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

Person count can be known or unknown independently from occupancy.

A simpler sensor should not be forced to pretend it can count people.

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

Sensor tracking loss must not cause:

- clearing overrides
- starting a new room session
- unwanted Spotify autostart on rediscovery
- shutting down a monitor while someone is watching or playing

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

    possible entry -> immediate minimal useful lighting
    confirmed entry -> normal room state
    no confirmation -> revert prelight according to policy

Prelight must not:

- start music
- increment person count
- clear manual overrides
- pretend occupancy is confirmed

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
