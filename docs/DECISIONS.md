# Decisions and open questions

This document separates what has effectively been agreed from what still needs experimentation.

## Current decisions

### Phase 0 + Phase 1 implementation choices (2026-09)

- The current implementation is a dependency-light TypeScript local service with real Home Assistant and MQTT adapters; core decisions remain separate from network transports. The runtime has no database.
- Zod schemas define runtime-validated domain and capability contracts. TypeScript is strict, and Vitest runs deterministic unit scenarios with an injected clock.
- Semantic light identifiers use `lighting.<name>`. A scene's `lighting` map is its explicit baseline. Effective desired values are stored separately and each controlled property has its own scene ownership or external override.
- Selecting or reapplying a scene increments `sceneRevision`, clears lighting overrides, supersedes pending commands, and starts immediate reconciliation. Commands group the changed properties for one semantic light/controller.
- The command ledger retains individual records in memory for diagnostics. Feedback is attributable by command ID when available; otherwise the first slice conservatively matches pending target/property/value within a configurable attribution window (60 seconds by default). A mismatched observation becomes a property-scoped user override. No ledger data is persisted or replayed after restart.
- Convergence uses event feedback plus a cancellable timer for retries, with a configurable timeout. The initial implementation values are 2 seconds between retries, 60 seconds to degrade, and 20 minutes of confirmed-empty continuity; they are configuration defaults, not measured device behavior.
- State updates start from a full typed snapshot, then publish typed domain patches with monotonically increasing revisions and bounded history. A client whose revision has fallen out of history receives a full snapshot. The runtime keeps only the latest update, since its own clients are always sent whole state and each retained update holds a copy of the command ledger and diagnostics.
- Fast-path timing records preserve wall-clock timestamps and use a monotonic clock for elapsed time from local MQTT callback receipt through decision, first command dispatch, first attributable device feedback, and full convergence. Home Assistant feedback without a command ID can still be attributed by the command ledger. These are instrumentation points, not benchmark claims; sensor-to-process/network delay and physical lamp response still require live measurement.
- Home Assistant lighting commands and state events stay behind adapters: light services use the connected WebSocket with REST as the fallback, REST fetch and WebSocket creation are injected, semantic/entity mappings come from host configuration, and the event socket owns authentication, subscription, and bounded reconnects. Unknown or unavailable light states are not interpreted as off.
- Raw STL27L serial/perception processing stays outside Lugn. The existing sensor service exposes a normalized, non-retained MQTT preview state (`bruno/doorway/preview`, `ON`/`OFF`, QoS 0); Lugn consumes that event without routing presence through Home Assistant. Sensor health or retained recovery state is not inferred from this ephemeral topic.
- Prelight is a distinct temporary `presence.prelight` input, not occupancy. Hosts configure a small set of targets/values and a bounded maximum duration. Preview OFF alone does not prove a false positive: Lugn holds the preview until occupancy or the existing timeout, then restores known prior values. `occupied`, `confirmed_empty`, explicit scenes, and manual light changes take control of the overlay; an in-flight restore completes before newer intent is reconciled.
- Occupied can trigger scene reconciliation at any hour unless confirmed home-away policy suppresses it. Confirmed empty triggers physical off regardless of home status. Ordinary occupancy is not used to infer prelight.
- Home Assistant home/away is a separate fact from room occupancy. The configured `person.*` or `device_tracker.*` entity defaults to `device_tracker.lustigkurre`; confirmed away blocks automatic room activation and music policy, but leaves explicit dashboard actions available. Unknown home status is visible but is not treated as away.
- Confirmed empty overlays physical `power: false` commands without modifying baseline/effective intent or ownership. Occupancy reconciles the remembered effective values, before or after continuity expiry (a long absence never swaps in the default scene); unknown does not start or clear continuity.
- The runtime stores logical lighting intent and an optional independently validated music-intent section in a versioned, atomically replaced private JSON file. Music retains manual ownership, explicit Pause, enable/temporary restore settings and absolute absence/resume deadlines. Device observations, presence counts, fades and command history stay ephemeral; stale physical commands are never replayed. Version 2 accepts legacy lighting-only version 1 on read, but old binaries cannot read version 2. This is an incremental persistence boundary, not a commitment against moving to SQLite.
- Scene and continuity logic live in `LugnEngine` for the first slice, while schemas, clock, state stream, adapter, command ledger, and capability registry remain separately replaceable modules. As the domain grows, presence/lighting policies should be split out before this engine becomes a general service.

The detailed presence/continuity path is included in this implementation because the first implementation brief requires it, even though the original roadmap listed it as a later slice.

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
- confirmed-empty pauses music; eligible room entry may resume recent context or start Spotify DJ preset 1 between 06:00 and 23:00, but never automatically starts or resumes playback from 23:00 until 06:00 (Europe/Stockholm).
- automatic music volume follows the Stockholm daily curve and applies a further 10-point reduction when the room reports more than one person.

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
- The current runtime serves custom Bed/Desk Hub dashboards through DashCast and an optional Clerk-authenticated operational control panel; visual configuration editing remains future work.

### Hub rules (2026-11)

- What a Hub screen shows (which pages exist, which to bring up, brightness,
  labels) is decided by declarative rules in `display.rules`, evaluated **on the
  server** per Hub and sent as `hubPolicy`; the Hub only carries it out. One
  evaluation means every Hub reads a rule the same way and time-based conditions
  need no clock on a slow Hub. A Hub without rules gets today's payload.
- Conditions are three-valued. A test over an unknown fact is neither true nor
  false and a rule only applies when its condition is true, so unknown never acts
  as away, empty or idle (the same rule as presence and home status).
- `focus` is offered once per activation of a rule, named by a token, not held:
  a person who swipes away is not pulled back. Dimming is a black sheet over the
  page because a Cast receiver cannot dim its own panel.
- Pages are the unit a rule controls. Parts of a page react to free `tags`
  rather than each getting its own effect; an effect is added when several parts
  need the same thing.
- The presence chip is on every page but Hem and Info, not only when something
  changes: the sensor is wrong exactly when it would not raise an event, so it
  does not wait for one. The quiet count (to take 2 back to 1) is drawn only
  while the navbar is open, so the pictures and the clock stay clean. **Jag är
  här** / **Jag är kvar** come up on their own, navbar or not: if the sensor sees
  nobody and nobody corrects it, nobody is there to mind. One tap, the same
  `presence.setCountOne` as Hem.

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

Decided: the computer's Linux agent switches the WiiM to Optical itself, directly
over the WiiM HTTP API, when it hears sustained audible sound on the sink wired to
the WiiM and the WiiM is not playing its own music (paused, stopped or idle). It
is on by default and finds the WiiM on its own. A short sound such as a
notification never switches, an input the user chose on purpose is not fought
(one decision per run of sound), and the thresholds are tunable per computer in
the control panel. The slower, suggestion-first Optical flow in Lugn's
computer intelligence remains and is unchanged. Open: a WiiM that stays on
Optical after the computer goes quiet is not switched back.

### Presence trajectory

STL27L trajectory toward the desk may be useful, but room geometry may make it unreliable.

Do not design core behavior around it until tested.

### Monitor feedback

A power-monitoring smart plug is a promising way to infer active vs standby, but thresholds and transients must be measured.

Display sleep/wake now uses the kernel's per-connector DPMS state, reported by the Linux agent, as feedback, so a plug is not needed there. A metering plug remains an optional, read-only evidence source (`mqtt.computers[].display.powerSensor`) for the open-loop fallback; its thresholds are placeholders until measured.

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
