# Integrations

Integrations are adapters. They should not define core room behavior.

## Home Assistant

Home Assistant remains an important device and integration surface.

Expected uses include:

- controlling/observing lights
- exposing room state
- connecting existing entities
- bridging integrations that already work well in HA

Core decisions should live in Lugn rather than being duplicated in a large set of Home Assistant automations.

## STL27L / presence sensor

Expected normalized outputs may include:

- occupied / confirmed empty / unknown
- person count
- pre-entry signal
- last reliable position
- optional trajectory/direction
- health/heartbeat
- session/sequence identity where available

Trajectory should be treated as experimental context, not a core dependency.

## WiiM

Important capabilities:

- playback
- volume
- fades
- source
- presets
- observed state

Presets should be first-class because they provide convenient preconfigured playback choices.

Optical source switching for computer use is useful, subject to ownership/continuity rules.

## HASS.Agent / Windows

The initial plan is to use HASS.Agent or an equivalent existing Windows bridge rather than immediately creating a custom Windows agent.

Useful initial context:

- online / heartbeat
- locked / unlocked
- idle/activity
- fullscreen state
- media playing / now playing
- game/activity classification where practical
- display-off command

Avoid collecting every possible PC metric merely because it exists.

A custom Windows agent remains a future option if existing tooling becomes a limitation.

## Monitor state

The monitor may not provide reliable direct on/off feedback.

A future optional smart plug used **for power measurement** can provide physical evidence of:

- active
- standby
- uncertain

The relay does not need to be used for normal automation.

Thresholds must be calibrated from real measurements and should account for transient behavior.

Automatic monitor wake is not MVP-critical.

Automatic monitor off must be conservative and must never rely only on a momentary LiDAR tracking loss.

Potential inhibit signals:

- recent mouse/keyboard activity
- active game
- fullscreen media
- PC usage state
- presence not confidently empty

## IKEA BILRESA

BILRESA remotes are input devices, not lighting-specific code.

Conceptually:

    button event
      -> configurable binding
      -> capability/tool call

Bindings may be context-sensitive, but should remain predictable.

A bedside remote can reasonably map the same stable button to:

- Good Night during evening context
- Good Morning during morning context
- a normal scene outside those contexts

The second remote can live near a desk or another useful control point.

Basic music control does not need to consume BILRESA buttons when a dedicated WiiM remote already exists.

## Nest Hubs / DashCast

Two display roles are expected:

- bedside
- main desk

DashCast management should keep the Lugn dashboard available while yielding to deliberate user casting.

## Environmental sensors

Temperature, humidity and air-quality sensors are intentionally non-critical.

The architecture and UI should make them easy to add without coupling them to the core presence/lighting/music engine.

Optional air purifier control can later be a small separate module with thresholds, hysteresis, missing-data behavior, and manual override.
