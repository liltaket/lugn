# MVP

The first version should prove the core behavior and architecture, not every future idea.

## Explicit non-goal

**No runtime AI in the first implementation.**

No LLM, Jev-like decision model, learned scene selector, or personal scheduling agent is required for MVP.

The architecture should make those additions clean later.

## Must work very well

### Presence

- STL27L adapter or equivalent normalized input
- occupied / confirmed_empty / unknown
- person count where available
- prelight
- continuity state
- conservative behavior during sensor uncertainty

### Lighting

- very fast entry/prelight path
- immediate off on confirmed empty
- scenes
- per-property overrides
- external/manual changes
- scene convergence and retry
- configurable convergence timeout (initially around one minute)
- Reapply scene
- detailed timing/decision diagnostics

### Music

- WiiM integration
- presets
- source selection including Optical
- event-driven autostart/pause
- volume fades
- command attribution with fade trajectory/tolerance
- manual volume/source/playback ownership
- continuity across short absence

### Routines

- Good Morning
- Good Night
- schema-based routines
- scheduling
- cancellation
- UI configuration
- typed create/update tools for future agents

### Inputs

- two BILRESA remotes
- stable configurable bindings
- limited understandable context-sensitive bindings

### Displays

- Bed Hub role
- Desk Hub role
- DashCast dashboard management
- yield to deliberate external casting
- realtime dashboard updates

### Web

- daily room view
- scenes
- music
- routines
- configuration
- diagnostics
- Clerk for human web authentication

### Persistence

- logical state and config survive restart
- stale device commands are not blindly replayed

## Useful but non-blocking

Environmental sensors can be supported early if easy:

- temperature
- humidity
- CO2
- PM2.5 / air quality

The UI should have room for them, but core MVP completion must not depend on them.

## Defer until core is stable

- learned automatic scene selection
- Jev or other probabilistic decision systems
- LLM integration
- voice assistant
- Google Assistant integration
- personal calendar/context agent
- smart monitor pre-wake
- trajectory-based computer intent
- custom Windows agent
- sophisticated air purifier automation

## Suggested implementation slices

### Slice 1: deterministic lighting simulator

- fake presence sensor
- one simulated light
- one scene
- manual property override
- Reapply scene
- convergence/retry
- full diagnostic trace

This validates the core state/ownership model without hardware.

### Slice 2: real fast-path lighting

- STL27L input
- real light adapter
- prelight
- entry
- immediate empty/off
- latency instrumentation

### Slice 3: continuity

- leave room -> physical off
- return shortly -> restore logical scene/overrides
- longer absence -> expiry according to config

### Slice 4: WiiM

- preset/source
- playback
- fade
- command ledger
- manual override attribution
- continuity

### Slice 5: routines and inputs

- Good Morning / Good Night
- BILRESA bindings
- routine cancellation

### Slice 6: Hubs and web UI

- Clerk
- Bed/Desk roles
- realtime state
- DashCast lifecycle

## Key acceptance cases

- Entry light command is dispatched through the fast path without waiting for persistence/UI.
- Confirmed empty turns lights off immediately but retains logical scene/context.
- A quick return restores the previous effective lighting state.
- A scene selection takes control and converges all devices.
- A manual light change after scene application is respected for only the changed property where possible.
- Unreachable devices do not create false manual overrides.
- WiiM fade feedback does not falsely trigger manual ownership.
- A clear manual WiiM change can stop a fade and be respected.
- Manual source choice is not immediately overwritten by PC Optical automation.
- Sensor unknown does not behave like confirmed empty.
- Restart restores logical intent without replaying stale commands blindly.
