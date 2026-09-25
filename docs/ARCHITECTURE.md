# Architecture

## Direction

Lugn should start as a **modular monolith**: one locally deployed service with strong module boundaries, not a collection of microservices.

The system should be simple to run, fast enough that room interactions feel immediate, easy to inspect when behavior is wrong, and structured so that new adapters or intelligence providers do not require changes throughout the core.

A provisional implementation direction is TypeScript for backend and web-facing schemas, a local persistent database such as SQLite, a TypeScript web frontend, and realtime updates over WebSocket or SSE. These are working choices rather than irreversible commitments.

## Layers

### 1. Observation and adapters

Adapters translate external systems into normalized observations and commands.

Examples:

- STL27L presence adapter
- Home Assistant adapter
- MQTT adapter
- lighting adapters
- WiiM adapter
- HASS.Agent / Windows adapter
- BILRESA / Matter input adapter
- Nest Hub / DashCast adapter
- environmental sensor adapters

Adapters own protocol-specific behavior. Core domains should not know whether a light is controlled by Home Assistant, Matter, Zigbee, or something else.

### 2. State and events

The engine keeps normalized state and consumes explicit events.

State examples:

- room occupancy
- person count
- current scene
- observed light state
- desired light state
- current music source / preset
- playback state
- PC state
- routine state

Event examples:

- person entered
- last person left
- presence became unknown
- scene selected
- external brightness changed
- button pressed
- game started
- routine started

State and events should be serializable and inspectable.

### 3. Decision layer

Core decisions should be expressible as:

    previous state
    + event
    + configuration
    + time
    + ownership / continuity
    -> new state
    + desired actions

The decision layer should not require network access, Home Assistant, or a database to be unit tested.

### 4. Execution and convergence

Execution turns desired actions into device commands.

It owns:

- command ledger
- pending commands
- feedback attribution
- retries
- convergence
- cancellation
- stale-command invalidation
- timeouts
- degraded/unreachable status

An action is not considered successful merely because a command was sent.

### 5. Capability / tool layer

All meaningful actions are exposed through a typed capability layer.

The web app, Home Assistant, BILRESA inputs, routines, voice assistants, LLMs, scripts, and future agents should call the same capabilities rather than implementing their own device logic.

### 6. Interaction layer

Interaction clients include:

- web app
- Nest Hub dashboards
- Home Assistant
- physical remotes
- future voice systems
- future agents

They should express intent; the engine handles ownership, state, retries, and device behavior.

### 7. Optional intelligence / context

Future intelligence is deliberately downstream of the deterministic core.

Possible providers:

- simple rules
- probabilistic decision models
- Jev-like typed decision systems
- small local models
- LLMs
- personal schedule/context agents
- voice/NLU systems

The first implementation should not depend on any of these.

## Fast path vs normal path

Lighting on room entry is latency-sensitive and should not wait for slow bookkeeping.

### Fast path

    sensor event
      -> normalize
      -> prelight / presence decision
      -> lighting command dispatch

Do not block this path on:

- persistence
- Clerk
- dashboard updates
- cloud requests
- AI
- history writes
- full scene reconciliation

A useful software latency target to measure later is approximately:

- P50 below 20 ms
- P95 below 50 ms
- P99 below 100 ms

These targets refer to sensor-event receipt -> command dispatch, not physical lamp response.

### Normal path

After the immediate command:

- persist state
- update dashboards
- run convergence
- write diagnostics
- update history
- notify other modules

This gives both speed and reliability.

## Suggested module boundaries

    room_engine/
      domain/
        presence/
        lighting/
        music/
        computer/
        routines/
        suggestions/

      application/
        events/
        continuity/
        ownership/
        scenes/

      execution/
        command_ledger/
        convergence/
        retries/

      adapters/
        home_assistant/
        mqtt/
        wiim/
        sensors/
        computer/
        inputs/
        displays/

      storage/
        config/
        state/
        history/

      api/
        http/
        realtime/
        tools/

    web/
      room/
      routines/
      settings/
      diagnostics/

This is conceptual structure, not a requirement to create these folders before code exists.

## Reliability principle

A restart should change as little user-visible behavior as possible.

Persistent logical state should survive, while stale physical commands should generally not be blindly replayed. On startup, the engine should reconcile persisted intent with freshly observed device state.
