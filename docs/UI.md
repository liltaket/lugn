# UI, Nest Hubs and DashCast

## First operator panel

The initial web surface is a focused lighting panel. It shows current presence,
integration health, configured scenes, and every mapped light's availability,
desired values, reported values, and ownership. Operators can select or reapply
a scene, toggle a mapped light, and adjust its brightness when the adapter
reports that property. Command acceptance remains separate from device
feedback.

The panel uses a short-lived same-origin session created from the local API
bearer token. The token is not embedded in frontend assets or saved by the
browser. Keep the HTTP service on loopback and use an SSH tunnel for local
operation, or configure the exact TLS proxy origin in `http.trustedOrigins`.
The existing typed capabilities remain the only path to device commands.

This first panel is for observing and tuning configured lights. Editing Home
Assistant mappings and broader room systems remain future UI work.

## Web application

The web app is the primary human configuration surface.

Authentication for human web access should use **Clerk**.

Clerk is not intended to authenticate devices, Home Assistant, MQTT sensors, or machine adapters. Machine trust must remain separate from user login.

## Daily room view

The everyday view should prioritize:

- current scene
- occupancy / person count
- lighting controls
- actual WiiM volume
- playback
- current preset/source
- automation/ownership status
- active routine
- relevant computer state
- clear warnings when a sensor/device is unavailable

Internal model parameters and deep diagnostics should not dominate the daily screen.

## Explain ownership

The UI should be able to say things such as:

    Cozy active
    Desk light manually off

or:

    Volume 37% - manually selected

A detailed view may show:

    Cozy
    ✓ ceiling: scene
    ↳ desk: manual override (off)
    ✓ strip: scene

This is more understandable than exposing internal passive-mode flags.

## Two Nest Hub roles

The reference deployment has two useful display roles:

### Bed Hub

Prioritize:

- Good Night / Good Morning
- Sleep / Cozy
- routine status
- alarm/wake-related controls later
- concise music status
- relevant bedside prompts

### Desk Hub

Prioritize:

- Desk / Focus / Gaming / Movie scenes
- computer state
- music
- contextual suggestions
- room status

The same web application can render different priorities based on display identity/role.

## DashCast management

Lugn should actively manage the room dashboards on Nest Hubs through DashCast or an equivalent adapter.

Conceptual desired state:

    display: bed_hub
    role: bed
    desired_content: room_dashboard

    display: desk_hub
    role: desk
    desired_content: room_dashboard

The manager should be able to recover the dashboard when casting stops unexpectedly.

## Respect external casting

Dashboard ownership must not fight deliberate user casting.

If a user casts other content:

    external cast detected
      -> dashboard temporarily yields

When that external cast/session ends:

    dashboard manager may restore Lugn

The exact detection method depends on the available integration, but the behavioral contract is important.

## Contextual prompts

Prompts should appear on the relevant Hub and remain low-noise.

Example:

    "You seem to be playing. Use Gaming scene?"
    [No] [Gaming]

A negative response should suppress the same suggestion for the related session/context.

## Environment area

The UI should reserve a clean place for optional environmental data such as:

- temperature
- humidity
- CO2
- PM2.5
- general air quality

These sensors are not MVP-critical and the panel should gracefully hide missing values.

## Realtime updates

The UI should receive realtime state updates rather than relying on slow periodic full-state polling.

WebSocket or SSE are both reasonable implementation options.
