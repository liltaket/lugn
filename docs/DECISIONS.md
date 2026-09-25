# Decisions and open questions

This document separates what has effectively been agreed from what still needs experimentation.

## Current decisions

### Product

- Lugn is a room intelligence engine, not merely a set of Home Assistant automations.
- The first implementation does not require runtime AI.
- Future automatic scene inference is a major long-term goal.
- The core must be designed for typed tools, voice, agents, and decision providers from the beginning.

### Presence

- occupied, confirmed_empty, and unknown are distinct.
- Unknown must not behave like empty.
- Lights can switch off immediately on confirmed empty.
- Music can pause immediately on confirmed empty.
- Logical context can survive the physical off/pause.
- Short absence should preserve room continuity.

### Lighting

- presence/prelight lighting latency is a top priority.
- lighting gets a dedicated fast path.
- scenes are desired-state baselines.
- scene selection clears relevant old lighting overrides.
- manual changes after scene selection are respected.
- overrides should be per-property where practical.
- scene application verifies observed state and retries.
- convergence should be configurable, with roughly one minute as the current default idea.
- Reapply Scene should take control again.

### Music

- WiiM presets remain first-class.
- fades remain.
- Optical switching for computer use is valuable.
- playback, volume, source, and preset should not be forced into one global passive mode.
- command attribution must account for fade trajectories and settling time.
- self-generated WiiM feedback must not create false passive/manual state.
- explicit user changes should be respected.

### Routines

- Good Morning and Good Night are first-class.
- routines should be declarative/schema-based.
- routines should be editable in UI and creatable through typed tools.
- future personal context can provide dynamic schedule values.

### Inputs / displays

- BILRESA buttons should map through configurable input -> capability bindings.
- limited contextual button behavior is acceptable if predictable.
- Bed Hub and Desk Hub are separate display roles.
- Lugn should manage DashCast lifecycle.
- deliberate external casting should temporarily override the dashboard.

### Computer

- computer integration remains important.
- use existing Windows integration such as HASS.Agent first.
- initially collect only useful context: online, lock, idle/activity, fullscreen/media/game context.
- monitor pre-wake is experimental and not required for MVP.
- monitor off must be conservative and protected from LiDAR tracking loss.

### Web/auth

- Clerk authenticates human web-app access.
- Clerk is not machine/device authentication.

### Persistence

- configuration and logical state should generally survive restart.
- stale pending physical commands should not be blindly replayed.

## Open questions

### Continuity / decay

Still needs real-world tuning:

- how long is a short absence?
- should lighting and music use different decay windows?
- how long should manual volume remain owned?
- how long should manual source/preset choice remain owned?
- which state survives overnight?
- should routines explicitly reset selected continuity state?

The data model must support independent reset policies even if MVP uses simple defaults.

### WiiM attribution

Needs hardware measurement:

- fade update frequency
- feedback delay
- useful tolerance
- settling duration
- source/preset feedback behavior

The current idea of approximately +/-2 volume tolerance is provisional.

### Optical automation

Explore exactly when PC activity should request Optical and when continuity/manual ownership should block it.

### Presence trajectory

STL27L trajectory toward the desk may be useful, but room geometry may make it unreliable.

Do not design core behavior around it until tested.

### Monitor feedback

A power-monitoring smart plug is a promising way to infer active vs standby, but thresholds and transients must be measured.

### Exact technical stack

Current working direction:

- TypeScript-oriented backend/schema layer
- TypeScript web UI
- local embedded persistence such as SQLite
- WebSocket or SSE realtime updates
- modular monolith
- in-process typed event bus

This remains subject to implementation review.

### License

- Lugn is licensed under PolyForm Small Business License 1.0.0.
- Uses outside those terms may be licensed separately by the project owner.
- The project is source-available rather than OSI open source.
