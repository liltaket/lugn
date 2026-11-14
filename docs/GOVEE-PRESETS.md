# Govee in Lugn presets

Presets can combine ordinary static lamps with Govee app animations and ceiling
power masks. The installed companion supplies exact playable effect labels and
model capabilities; the editor never invents scene names or zone capabilities.
Saving a preset changes its definition only. Activate it to change the lamps.

## Configuration and compatibility

Opt in in the **main Lugn configuration**, using an explicit absolute path:

```json
{
  "govee": {
    "socketPath": "/home/bruno/.local/state/lugn-govee/control.sock"
  }
}
```

This requires the companion's preset-control Unix socket API. An older companion
without that API leaves effects unavailable; ordinary local OFF remains possible.
Capability loading has a two-second deadline, does not block startup indefinitely,
and retries every 30 seconds. Existing presets without `govee` remain valid.
Saved preset files retain version 1: the new optional field is additive. Applied
lighting snapshots persist intent, never session control IDs or delivery status.
External HA selector leases still preserve the prior durable room intent/holds.

The web preset editor offers white Kelvin, static RGB, a catalog animation and,
where supported, main/ring selection. Brightness and color apply to the whole
fixture. The H60A6 advertises separate zone power only; no independent zone RGB or
brightness is implied. Its captured Govee capability is **2700–6500 K**. Lugn clamps
its desired and dispatched Kelvin to that range, avoiding Matter's erroneous
15 K minimum. Small readback differences such as 2702 K for 2700 K remain normal
mired rounding under the existing lighting-feedback tolerance.

## Example definitions

Use labels from the current `/capabilities` response. These examples use the
verified installation's semantic IDs and catalog labels; include all desired
room lamps in real presets. Omitted targets retain their existing intent.

```json
[
  {
    "id": "scene.ring_aurora",
    "name": "Norrsken i ringen",
    "lighting": {
      "lighting.govee_ceiling": { "power": true, "brightness": 20 },
      "lighting.govee_strip_2": { "power": true, "brightness": 25 },
      "lighting.govee_table": { "power": true, "brightness": 15 }
    },
    "govee": {
      "lighting.govee_ceiling": {
        "effect": "Aurora",
        "zones": { "main": false, "ring": true }
      },
      "lighting.govee_strip_2": { "effect": "Forest" },
      "lighting.govee_table": { "effect": "Forest" }
    }
  },
  {
    "id": "scene.ceiling_white",
    "name": "Huvudljus och ring",
    "lighting": {
      "lighting.govee_ceiling": {
        "power": true,
        "brightness": 60,
        "colorTemperature": 4000
      }
    },
    "govee": {
      "lighting.govee_ceiling": { "zones": { "main": true, "ring": true } }
    }
  },
  {
    "id": "scene.static_color",
    "name": "Fast färg",
    "lighting": {
      "lighting.govee_ceiling": {
        "power": true,
        "brightness": 30,
        "rgb": [80, 30, 200]
      }
    }
  }
]
```

A Govee entry requires a corresponding included lamp with `power:true`. An effect
or rotation cannot be mixed with static RGB/Kelvin. Both zones OFF is represented by ordinary
whole-fixture `power:false`, without a Govee entry. Unknown effects or unsupported
zone masks fail validation before any effect write. Definitions remain readable
through a companion outage; activating unavailable effects fails explicitly.

## Effect rotations

Choose **Animationsloop** in the editor to select 2–16 distinct catalog effects
and an interval of 15–3600 whole seconds. For example:

```json
{
  "lighting.govee_strip_2": {
    "rotation": {
      "effects": [
        "Rainbow B",
        "Meteor shower",
        "Aurora",
        "Colorful",
        "Forest",
        "Party"
      ],
      "intervalSeconds": 30
    }
  }
}
```

This is an entry in a scene's `govee` map; include the powered lamp in `lighting`.
The engine owns one timer per target. The interval begins after successful
delivery, so slow writes never accumulate timer jobs. Steps wrap in saved order.
Only the definition persists; the current index, timer and control ID do not.
Restore waits for normal occupancy/explicit permission and starts at the first
effect. Each step gets a new live ID and reports requested `activeEffect` and
transport status, without claiming physical animation feedback.

Later steps skip ordinary power/brightness baseline writes and carry
`modeOnly:true` to the companion. LAN requires fresh native ON; the cloud path
requires a fresh valid ON state and omits global power ON. OFF, unknown power or
delivery failure stops rotation rather than reactivating the fixture or retrying
blindly. Accepted cloud work still cannot be retracted atomically. Reapply the
preset after resolving a failure.

Manual color/OFF, a new included scene, external selector takeover, confirmed
exit and shutdown invalidate pending steps. Omitted targets keep their current
rotation. After confirmed exit the intent may resume under the normal entry
permission, while an explicit manual OFF remains authoritative. This feature
requires the matching companion version supporting the mode-only restriction.

## Transitions and truthful status

The composite lighting adapter serializes each target across ordinary and Govee
writes: cancel/drain companion work, write baseline power/brightness/static mode,
then apply the effect and final mask. The companion enables desired ON zones
before disabling undesired zones. This prevents an intermediate whole-fixture
OFF during a main-only/ring-only transition from revoking its own generation.
Baseline changes and mask transitions may transiently light both ceiling zones;
final mask handling must follow all mode/brightness/effect writes. Cloud acceptance
does not prove atomic or simultaneous physical application.

`lighting.devices[target].govee` exposes requested `intent`, optional session
`controlId` and `status` (`pending`, `sent`, `failed`). The ID is published only
while illumination is permitted. `sent` is transport acceptance, **not physical
animation or zone confirmation**. Govee's API acknowledgement cannot retract or
prove ordering of already accepted firmware work. The barrier guarantees drain
and no further stale sends after acknowledgement, not hardware atomicity.

A new scene, ordinary manual control or confirmed exit invalidates the old
session ID before delayed writes continue. Ordinary controls reclaim static mode;
whole OFF remains the local Matter/HA path. Partial apply failures attempt local
OFF after drain when the same generation still owns the lamp. Failed requests are
visible through command diagnostics rather than silently counted as successful
scene activation. Reapply the preset after fixing an unavailable companion.

Effects yield to confirmed-empty OFF and return only through the existing
occupancy/explicit-control permissions. Restart restores intent but grants no
illumination merely because the socket reconnects. Prelight preserves its static
lamp behavior; animation/masked lamps wait for confirmed entry so a ring-only
preset cannot preview with an unintended main light. Window policy yields while
an explicit Govee mode owns the strip, and resumes with ordinary static control.

## IPC contract

HTTP over the protected Unix socket, with no network listener:

- `GET /capabilities` → `{targets: Record<target,{effects:string[],zones:boolean,colorTemperature?:{min,max}}>}`.
- `POST /apply` ← `{requestId,target,controlId,effect?,zones?,modeOnly?:true}` → matching IDs and `status:"sent"`, plus truthful delivery metadata. Mode-only requires an effect and never grants activation.
- `POST /cancel` ← `{target,controlId?}` → `{status:"drained"}`.

The server verifies the live optional engine ID, no external lease and powered
intent before each device write. Cancellation covers engine and legacy device
writes, excluding legacy HA lease-acquisition HTTP, which could otherwise wait
on itself. A client-side stale guard explicitly requests cancel/drain; closing a
socket alone does not retract an accepted cloud command.

This worktree does not select a production release or modify protected live
configuration. Integrate the matching companion gateway before a coordinated
cutover. Software tests, transport delivery and user-observed hardware behavior
must be reported separately.

## Validation of the preset implementation

The implementation passes `npm run check`: formatting, ESLint, TypeScript,
119 suites / 1,905 tests and both systemd installer fixtures. `npm run build`
passes. Focused tests cover the actual engine → Unix-socket client → gateway
path with fake device writes, rapid effect/white/effect transitions, cancellation
and OFF, missing-companion recovery, persistence and editor behavior. No live
lamp operation or new visual hardware qualification was performed in this
worktree. Production release selection and protected configuration are unchanged.

Authenticated ownership reads can use `/state?lightingOnly=1`, or
`/state?lightingOnly=1&lightingTarget=lighting.govee_ceiling`. The latter returns
only `{lighting:{devices:{[target]:device}}}`; unknown targets return 404 and
malformed/duplicate targets return 400. Ordinary `/state` remains unchanged.
