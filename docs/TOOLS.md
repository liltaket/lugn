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

### Implemented music capabilities

| Capability           | Input                                         |
| -------------------- | --------------------------------------------- |
| `music.getState`     | `{ target: "music.room" }`                    |
| `music.play`         | `{ target: "music.room" }`                    |
| `music.pause`        | `{ target: "music.room" }`                    |
| `music.setVolume`    | `{ target: "music.room", volume: 0.35 }`      |
| `music.selectSource` | `{ target: "music.room", source: "Optical" }` |

All reject unconfigured semantic targets and extra arguments. Volume uses HA's
0..1 scale; source must appear in that target's configured allowlist.
`music.getState` returns `{ device }`; actions return
`{ accepted: true, commandId, status }`. `accepted` means dispatch acceptance.
`room.getState` includes `music.devices` and `music.commands`, and the `music`
domain participates in revisioned state replay. See [Music](MUSIC.md) for
confirmation, timeout and per-property supersession semantics.

### Implemented switch capabilities

`switch.getState({ target: "switch.desk" })` reads one configured semantic
switch. `switch.set({ target: "switch.desk", state: true })` requests on;
`state: false` requests off. Both reject targets outside the configured switch
map. Additional arguments and arbitrary Home Assistant services are rejected.

An action returns `{ accepted: true, commandId, status }` after the adapter
accepts the request. `accepted` describes dispatch acceptance. The switch
command remains `pending` until matching state feedback arrives within
`switchFeedbackTimeoutMs` (10 seconds by default, configurable up to 60 seconds).
Feedback marks the command `confirmed`; timeout marks it `unconfirmed`.
Dispatch failure rejects the capability and records `failed`; a newer request
marks an earlier pending command `superseded`. There are no automatic retries.

`room.getState` includes `switches.devices` and `switches.commands`. Each device
keeps `observed` and `requested` separately, with independent provenance and
availability. A manual external change updates the observed value without
silently changing the earlier request or sending a restoring command. An
unknown or unavailable observation clears the current observed value to `null`.
Presence and lighting scenes never operate switches.

Home Assistant switch feedback has no Lugn command ID. Attribution therefore
uses a matching configured target/value within the bounded confirmation window.
A simultaneous external change to the same value can satisfy that match. A
confirmation proves Home Assistant reported the state; it does not prove a
physical device or attached load changed beyond Home Assistant's observation.

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
