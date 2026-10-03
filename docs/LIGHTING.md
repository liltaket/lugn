# Lighting

Lighting is one of Lugn's most latency-sensitive and user-visible domains.

## Goals

- light should appear immediately when needed for entry/navigation;
- lights should turn off immediately when the room is confirmed empty;
- selected scenes should reliably reach their target state;
- manual adjustments should be respected;
- short absence should not destroy carefully adjusted state;
- the behavior must remain understandable and debuggable.

## Scenes

The runtime adds these room-wide presets for the configured light targets:

| Preset      | Current behavior                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Helt släckt | All configured lights off.                                                                         |
| Mysljus     | Accent lights at 12% and 2700 K; ceiling light off. WLED is 18%.                                   |
| Vardagsljus | Accent lights at 55% and 2700 K; ceiling light off. WLED is 61%.                                   |
| Filmkväll   | Accents at 6% and 2700 K; ceiling/front light/Cleverio bar off; monitor backlight on. WLED is 12%. |
| Fokus       | All configured lights on at 100% and 4000 K. WLED is 100%.                                         |

Map the WLED CCT white strip as a normal Home Assistant light, for example:

```json
"lighting.wled_cct": "light.wled_cct"
```

The built-in room presets include every configured light target, so the WLED
strip follows the same scene at 0% for Helt släckt, 18% for Mysljus, 61% for
Vardagsljus, 12% for Filmkväll, and 100% for Fokus. The WLED entity must expose
color-temperature support in Home Assistant for its scene color temperature to
be applied. When WLED is active in a scene, its configured brightness gets a
6-point increase, capped at 100%; if brightness is omitted, Lugn starts at
12%. Helt släckt is unchanged. For any scene with active lights and an
explicit color temperature, Lugn synchronizes every active light (power not
explicitly off) to the most common Kelvin value among active scene entries
(ties use the first value in scene order), clamped to the installed room's
common 2700–6500 K range. This keeps room CCT synchronized: an external
per-light color-temperature change is reconciled back to the shared value, and
an explicit color-temperature adjustment applies to every active light in the
current scene. Power and brightness overrides keep their existing behavior.
Custom scenes should specify their own WLED brightness and color temperature
when the strip should stay on.

The dashboard presents these presets as its primary controls. Other scenes
from configuration can still be exposed, but only the listed room presets
have these built-in room-wide definitions.

## Automatic entry policy

Automatic occupied-entry scene reconciliation is suppressed during quiet hours
(23:00–06:00) and when Home Assistant explicitly reports the resident away.
Unknown home status does not count as away. Manual dashboard scene/light
requests remain available while away. Confirmed-empty light-off remains active
regardless of home status.

If room entry was blocked by `away`, clearing that gate to `home` or `unknown`
reconciles the occupied room immediately. It does not wait for another count
change from the room sensor. Quiet-hours suppression still takes precedence.

Temporary prelight is suppressed when any configured light is already on, the
current scene requests every configured light off, quiet hours are active, or
the home-presence entity reports away. This prevents an entry hint from
turning on additional lights when the room already has a usable scene.

## Scene definitions

Configured scene names may include:

- Desk
- Cozy
- Movie
- Focus
- Clean
- Sleep

A scene should be data, not hardcoded control logic.

A scene primarily defines explicit per-device properties such as:

- power
- brightness
- color temperature
- color

Avoid making continuous adaptive-lighting mathematics a requirement for the first version.

## Scene application

When a scene is explicitly selected:

- clear relevant lighting overrides;
- create a new scene revision;
- dispatch commands immediately;
- verify observed state;
- retry devices that have not reached their target;
- retry unavailable devices at the normal retry interval instead of waiting
  until the convergence deadline;
- stop retries at the convergence deadline or after three total delivery
  attempts per light and scene revision;
- default convergence window is 60 seconds, with a 2-second retry interval;
- surface devices that still fail as degraded/unreachable.

A later device recovery starts a fresh bounded convergence attempt for that
device only. It must not clear another light's retry count or degraded status;
a new scene or confirmed room entry starts a fresh room-wide attempt.

Home Assistant `unknown` and `unavailable` light states invalidate the last
observed values and mark the device unavailable. A later valid state restores
availability and starts a fresh convergence attempt. Home Assistant feedback
does not include Lugn command IDs, so values matching a command superseded in
the last 10 seconds are treated as delayed feedback while a different current
scene value is desired; older or unrelated values can still become manual
overrides.

Turning a scene light on includes its effective brightness and color
temperature, even if those values were observed before the light switched off.
An off light's remembered attributes do not prove what its next turn-on will
restore.

While a current command is pending, mismatching Home Assistant feedback for
its requested properties is treated as intermediate device state rather than
a new manual override. This protection ends when the command is confirmed or
its feedback deadline expires. Explicit Lugn user adjustments remain effective
during convergence. External adjustments become overrides after convergence as
before; during a pending command, unidentified external changes to its requested
properties cannot be distinguished from partial device feedback. Home Assistant's
`context.user_id` is not sufficient to resolve this ambiguity, because its
[REST service calls](https://github.com/home-assistant/core/blob/dev/homeassistant/components/api/__init__.py)
also use the authenticated request's context. Partial
feedback from the final delivery attempt does not reset the retry budget;
complete feedback can still confirm that attempt and clear degraded status.

## Manual adjustment after scene application

Example:

    Cozy baseline:
      ceiling = on 60%
      desk    = on 30%
      strip   = warm

User turns desk light off externally.

Effective state becomes:

    ceiling = on 60%   [scene]
    desk    = off      [override]
    strip   = warm     [scene]

Lugn must not immediately "repair" the desk light back on.

If the user only changes desk brightness, power and color may remain scene-owned.

## Where manual control can come from

Manual/external behavior is not limited to Lugn's UI.

A change may come from:

- a physical button
- IKEA / vendor application
- Home Assistant
- a Bluetooth app
- another Matter controller
- a voice system
- a direct device interaction

If Lugn observes the resulting state and it cannot be attributed to a pending Lugn command, it can become an override.

An explicit user `power: true` command from the dashboard is allowed even while
presence is `confirmed_empty`. That light stays on until the user turns it off
or a new confirmed occupancy cycle begins. This exception does not infer room
occupancy and does not allow automatic presence-driven scenes to turn lights on
in an empty room. Brightness or color adjustments alone never turn a light on.

## Leaving the room

On confirmed empty:

    immediately turn physical lights off

But keep logical state:

    current scene
    per-property overrides
    continuity metadata

A short return restores the prior effective scene.

A long enough confirmed absence can expire selected overrides according to configuration.

## Fast path

Entry/prelight should have the shortest possible code path:

    normalized sensor event
      -> minimal decision
      -> lighting command dispatch

Persistence, dashboards, diagnostics, and complete scene reconciliation happen afterward.

## Prelight

Prelight should prioritize "I can see where I am going" rather than perfect scene fidelity.

It may use a small subset of critical lights with immediate transitions.

Once entry is confirmed, Lugn can apply the full effective scene.

## Measurement

Instrumentation should distinguish:

- sensor -> engine arrival
- decision time
- engine -> adapter dispatch
- device feedback latency
- full observed convergence

This makes perceived delay diagnosable instead of anecdotal.
