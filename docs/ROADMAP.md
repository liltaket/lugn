# Roadmap

This roadmap describes order, not calendar dates.

## Phase 0 - Freeze contracts

Before writing substantial device code:

- finalize normalized state/event shapes;
- finalize ownership/override semantics;
- finalize scene revision and convergence semantics;
- finalize command-ledger contract;
- define capability/tool schema conventions;
- define routine schema;
- define persistence boundaries.

The documents in this repository are the current input to that work.

## Phase 1 - Simulated core

Build the smallest possible vertical slice without physical hardware:

- simulated presence
- simulated light
- one scene
- one property override
- command ledger
- convergence/retry
- Reapply Scene
- continuity memory
- structured diagnostic trace

Goal: prove the state model before integration complexity arrives.

## Phase 2 - Fast real lighting

Connect real presence and lighting:

- STL27L or normalized equivalent
- prelight
- confirmed occupied
- confirmed empty
- immediate light off
- latency instrumentation
- scene restore after short absence

Goal: make entry lighting both fast and trustworthy.

## Phase 3 - Real scene engine

Expand lighting:

- multiple devices
- multiple properties
- external changes
- per-property overrides
- one-minute-ish configurable convergence
- device-unavailable handling
- persisted scenes and overrides
- configuration UI

Goal: Lugn can own a real room without fighting the user.

## Phase 4 - WiiM music

Add:

- presets
- playback
- source/Optical
- fades
- fade trajectory attribution
- continuity
- manual playback/volume/source ownership
- event-driven entry/exit behavior

Goal: music feels helpful rather than stubborn.

## Phase 5 - Routines and BILRESA

Add:

- Good Morning
- Good Night
- schedule UI
- declarative routine schema
- cancellation
- two BILRESA remotes
- stable/contextual bindings

Goal: useful daily interaction without AI.

## Phase 6 - Web and Nest Hubs

Add:

- Clerk-authenticated web app
- Bed Hub role
- Desk Hub role
- realtime state
- DashCast lifecycle management
- external-cast yielding
- diagnostics UI

Goal: the system is easy to live with and configure.

## Phase 7 - Optional environment / PC context

As useful:

- temperature/humidity/air quality
- HASS.Agent context
- fullscreen/media/game state
- prompts such as Gaming-scene suggestion
- optional monitor power telemetry

These features must not destabilize the core.

## Later - intelligence

Only after the deterministic system is excellent:

- smarter suggestions
- automatic scene inference
- typed probabilistic decision models
- voice
- LLM tool calling
- personal wake/home/calendar context
- opt-in learned automation

## Release philosophy

Prefer small vertical releases where behavior is testable end-to-end.

Do not wait for every planned integration before proving the central room model.
