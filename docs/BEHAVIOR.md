# Behavior model

This document defines the central behavior model shared by lighting, music, computer control, routines, and future modules.

## Separate state signals in the current runtime

Room occupancy from STL27L and home/away from Home Assistant are independent.
The room can be empty while the resident is home, or still appear occupied
after Home Assistant reports away. Home status is read from the configured
`person.*` or `device_tracker.*` entity; `device_tracker.lustigkurre` is the
example default.

Confirmed away suppresses automatic room activation and music policy, and
pauses playing music. It does not suppress confirmed-empty shutoff. It also
does not disable explicit dashboard requests. Unknown home status is distinct
from confirmed away and currently does not gate automation.

## Four pieces of state

For a controllable property, Lugn should be able to distinguish:

### Observed state

What the device currently reports.

Example:

    desk_light.brightness observed = 47

### Baseline desired state

What the currently active scene, routine, or automation wants.

Example:

    Cozy wants desk_light.brightness = 30

### Pending command

What Lugn has recently requested and is still expecting to observe.

Example:

    set brightness to 30
    sent 120 ms ago

### Override / ownership

An intentional external change that should temporarily supersede the baseline.

Example:

    desk_light.brightness override = 47

The effective desired state then becomes 47 for that property while the rest of Cozy can remain intact.

## Property-level ownership

Ownership should be as narrow as practical.

Changing a light's brightness does not need to surrender its color temperature.

Example:

    desk_light.power       -> scene
    desk_light.brightness  -> user override
    desk_light.color_temp  -> scene

Likewise for music:

    playback -> automation
    volume baseline -> user
    volume offset   -> automation
    source   -> automation

The most recent volume changer and automatic-policy status are separate facts.
A user volume change becomes the new baseline; when the room is occupied and
the resident is not away, Lugn can still apply the daily and person offsets to
that baseline. The dashboard reports who last changed the volume separately
from whether automatic adjustment is active and what target it calculates.

This avoids coarse global "passive mode" flags.

## External changes

An external change can come from anywhere:

- physical button
- vendor Bluetooth app
- Home Assistant
- another controller
- web UI
- voice assistant
- future agent
- device-local control

If the observed change cannot reasonably be attributed to a pending Lugn command, it may become an override.

The system should not assume that only its own UI counts as manual control.

## Attribution must be conservative

False manual overrides are worse than slightly delayed recognition in many cases.

Before classifying an observation as external, check:

- pending command matches
- expected range / tolerance
- timing window
- command trajectory
- device quantization or rounding
- known adapter context / command IDs where available

Do not classify unavailable/unknown state as a manual change.

## Scene behavior

A selected scene defines a baseline desired state.

When a scene is selected:

1. increment scene revision;
2. clear relevant old lighting overrides;
3. calculate desired values;
4. send commands;
5. observe feedback;
6. retry devices that did not converge;
7. mark persistent failures as degraded/unreachable.

A new scene selection is an explicit instruction and therefore takes control again.

"Reapply scene" performs the same reset/convergence for the current scene.

The default convergence window is expected to be around one minute, but it must be configurable.

## Immediate off, remembered context

When the room becomes confirmed empty:

- lights may turn off immediately;
- music may pause immediately;
- physical output can therefore become inactive immediately.

This **does not imply that logical state is deleted**.

Shortly returning can restore:

- current scene
- per-property lighting overrides
- music source/preset
- manual volume
- other continuity-sensitive state

Only expiry/reset policy determines when those memories are cleared.

## Room sessions

The normal state API exposes `session`, initially `null`. A confirmed occupied
sample starts an `active` room session with a UUID, `startedAt` and
`lastActiveAt`. Further occupied samples update `lastActiveAt` without changing
the ID. Confirmed empty suspends the session, recording `suspendedAt` and an
absolute `expiresAt`. Returning strictly before that deadline resumes the same
session; reaching the deadline ends it, and the next confirmed entry starts a
new ID. Repeated empty samples do not extend the deadline.

The shared visit window defaults to 20 minutes and can be set independently
with the engine's `roomSessionContinuityMs` option (1 ms to 24 hours). Unknown
presence neither creates nor suspends a session and does not renew or cancel a
confirmed absence deadline. An active session therefore survives an unknown
gap; a previously suspended session can still expire during that gap. Home/away,
prelight and explicit device actions do not create room sessions.

Sessions provide a common visit reference, not a common reset policy. Lighting's
`presence.continuityExpiresAt` and music's 20-minute resume window still track
their own confirmed-empty transition and may expire before or after the shared
session. Session end alone does not clear scenes, overrides, manual music Pause,
volume baselines or source selection. Presence and lighting-continuity decisions
include the session ID so their separate policies can be inspected together.
`session.started`, `session.suspended`, `session.resumed` and `session.ended`
diagnostics contain lifecycle timestamps; state-stream updates include the
`session` domain, including timer-driven expiry.

Sessions are process-local. Restart is an explicit new visit boundary: startup
state has no session, and only fresh confirmed occupancy starts a new UUID.
The lighting intent store can restore domain intent and its absolute continuity
deadline, but never restores a session, sensor presence or device observations.
An ended session remains visible until the next entry for diagnostics; disposal
cancels its timer without manufacturing a physical exit.

## Decay policies

Different state should be allowed different reset policies.

Examples:

- lighting override: scene change or absence timeout
- current scene: potentially much longer-lived
- manual music volume: absence timeout or explicit reset
- manual music source: potentially longer-lived than volume
- suppressed suggestion: until related activity/session ends

Exact durations are intentionally not frozen yet.

Each remembered state should be able to carry something conceptually like:

    created_at
    last_relevant_at
    reset_policy

The initial implementation can still use simple timeouts.

## Command cancellation

Disabling an automation must invalidate already queued work where possible.

That includes:

- future fade steps
- retries
- delayed source changes
- stale routine actions

Commands that have already physically left the process cannot always be recalled, so later reconciliation is still required.

## Principle

> Lugn should aggressively converge after an explicit intent such as scene selection, but become conservative after the user changes an individual property.
