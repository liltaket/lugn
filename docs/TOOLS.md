# Capability and tool API

Tool calling is an architectural primitive, not a later AI feature.

The same typed capabilities should be usable by:

- web UI
- Home Assistant
- physical input mappings
- routines
- scripts
- future voice assistants
- future Jev-like decision systems
- small LLMs
- larger agents
- MCP-like integrations

## Principle

Clients express intent.

The room engine owns:

- state
- permissions
- ownership
- continuity
- validation
- command attribution
- retries
- convergence

A future LLM should never need direct database access or device-protocol knowledge.

## Conceptual read tools

    room.get_state
    presence.get_state
    lighting.get_state
    music.get_state
    computer.get_state
    routines.list

## Conceptual action tools

    lighting.activate_scene
    lighting.reapply_scene
    lighting.set
    lighting.adjust

    music.play
    music.pause
    music.play_preset
    music.set_source
    music.set_volume
    music.fade_volume

    computer.display_off
    computer.display_wake
    computer.lock

    routine.start
    routine.stop
    routine.create
    routine.update

Names are illustrative; the concrete API should be designed before implementation.

## Typed schemas

Every tool should have:

- stable name
- human-readable description
- typed arguments
- typed result
- validation
- read/write classification
- idempotency semantics
- permission/risk metadata
- optional confirmation requirement

Define schemas once and reuse them for:

- TypeScript types
- runtime validation
- API documentation
- agent/tool schemas
- future OpenAPI/MCP surfaces where useful

## Actor / provenance metadata

Every action should carry provenance when known.

Conceptually:

    actor.type =
      user
      automation
      routine
      physical_remote
      home_assistant
      voice
      agent

    actor.id
    source
    request_id
    reason

This is useful for diagnostics and attribution without requiring behavior to depend on identity in every case.

## Semantic naming

Expose meaningful names rather than protocol identifiers.

Prefer:

    room.main_desk
    lighting.desk
    scene.cozy
    computer.main

over adapter-specific entity IDs.

Adapters may still map semantic IDs to Home Assistant, MQTT, Matter, or vendor IDs internally.

## Intelligence providers

The core should make room for optional interfaces such as:

- IntentProvider
- ContextProvider
- SuggestionProvider
- SceneDecisionProvider

Initial implementations can be deterministic rules.

Future implementations can use probabilistic models or LLMs without changing lighting/music/device execution.

## Safety / control rule

AI must not become a second control plane.

> Voice, models, agents, dashboards, buttons, and ordinary automation all use the same capability layer.

That is what ensures they inherit the same ownership, continuity, validation, and convergence behavior.
