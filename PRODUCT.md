# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Household members use the room dashboards from Nest Hub touchscreens. This is
inferred from the configured Hub roles and the user's request for quick,
glanceable room controls.

## Product Purpose

Lugn provides local-first room automation for lighting, presence, music and
indoor conditions. The custom Nest Hub dashboard lets a resident see the room
at a glance and quickly choose a lighting scene or music action.

## Operating Context

The room dashboard is a custom Lugn page launched through DashCast, separate
from Home Assistant's own dashboard. It is used at a distance on fixed-size
touchscreens, so primary actions and room conditions must fit in one viewport
without scrolling. Bed and desk Hub roles currently receive the same room
state, sensor snapshot, scenes and music policy; role-specific datasets must
not be implied by their labels.

## Capabilities and Constraints

- Large room-light scene controls, including an explicit all-off action.
- Local time and date, temperature, humidity, CO₂ and PM2.5 when configured.
- WiiM preset, playback and volume controls, including clear volume ownership
  and the calculated target.
- Dashboard controls remain touch-friendly and available independently from
  automatic home/away gates.
- Automatic music playback must not start or resume from 23:00 until 06:00 (Europe/Stockholm).
- Routine connection, Cast and refresh status should not consume dashboard
  space; actionable failures may be shown when needed.
- The dashboard must not scroll in either direction.

## Brand Commitments

- Keep the name Lugn for the system; do not spend dashboard space on a logo or
  wordmark.
- The Nest Hub dashboard uses a dark theme.

## Evidence on Hand

- Current UI and behavior: `src/ui/display.html`, `src/ui/display.css`,
  `src/ui/display.js`.
- Product behavior and integration constraints: `docs/UI.md`,
  `docs/BEHAVIOR.md`, `docs/MUSIC.md`, and `docs/PRESENCE.md`.

## Product Principles

- Make common room controls reachable with one clear touch.
- Present room conditions in a glanceable hierarchy.
- Keep observed values distinct from Lugn's volume target and controller.
- Preserve truthful states and actionable error recovery.

## Accessibility & Inclusion

Primary controls need large touch targets and readable contrast at a distance.
