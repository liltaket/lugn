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

Initial known scene names may include:

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
- keep retrying with controlled backoff for a configurable convergence window;
- default convergence window is expected to be around one minute;
- surface devices that still fail as degraded/unreachable.

A later device recovery can trigger convergence toward the current effective desired state.

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
