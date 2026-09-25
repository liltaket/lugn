# lugn

A local-first room intelligence engine for spaces that should simply understand what is happening and behave correctly.

Lugn is designed around a simple idea:

> Automation should help until a person makes an intentional change. Then it should respect that change instead of fighting it.

The long-term goal is a room that can increasingly understand context and infer what the user probably wants, while keeping the core deterministic, fast, inspectable, and usable without AI.

## Status

**Design / pre-implementation.**

This repository currently documents the behavior, architecture, interfaces, and MVP before implementation starts. The intention is to make the core contracts clear enough that implementation can proceed without repeatedly redesigning the system.

No runtime AI is planned for the first version.

## Core principles

- **Instant where latency matters.** Presence-triggered lighting gets a dedicated fast path.
- **Physical state and remembered state are separate.** Leaving the room can turn things off immediately without forgetting the previous scene, overrides, or media context.
- **Manual control wins.** Physical buttons, vendor apps, Home Assistant, the web UI, remotes, and other external controls should be respected.
- **Desired state is verified.** When a scene is selected, Lugn should actively converge devices toward that scene and retry unresponsive devices for a configurable period.
- **Context survives short absences.** A bathroom break should not behave like returning home hours later.
- **Deterministic core, pluggable intelligence.** Rules, voice assistants, small decision models, LLMs, and agents should all use the same typed capability layer.
- **Adapters, not hard dependencies.** Home Assistant, MQTT, WiiM, HASS.Agent, Matter devices, sensors, and future integrations connect through adapters.
- **Observable and debuggable.** The system should make it obvious what it believed, what it decided, what it commanded, and why.
- **Local-first and efficient.** The room must remain useful without a cloud model or external agent.

## Reference deployment

The initial deployment is expected to include a subset of:

- STL27L-based room presence / people counting
- Home Assistant
- smart lights and scenes
- WiiM audio
- two Nest Hub displays
- IKEA BILRESA remotes
- a Windows 11 PC through HASS.Agent or an equivalent adapter
- optional smart-plug power telemetry for monitor-state inference
- future environmental sensors

The architecture should remain general enough that none of these exact products are mandatory.

## High-level architecture

    sensors / devices / external systems
                  |
               adapters
                  |
        normalized state + events
                  |
          deterministic room engine
          /          |            \
     decisions   ownership     routines
          \          |            /
           command + convergence
                  |
            capability API
        /       /       \        \
      web      HA      inputs    future AI/voice

Future intelligence should sit above the same capability API used by the UI and ordinary automation. It must not become a parallel control system.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Behavior model](docs/BEHAVIOR.md)
- [Presence and continuity](docs/PRESENCE.md)
- [Lighting](docs/LIGHTING.md)
- [Music](docs/MUSIC.md)
- [Routines and suggestions](docs/ROUTINES.md)
- [Capability and tool API](docs/TOOLS.md)
- [UI, Nest Hubs and DashCast](docs/UI.md)
- [Integrations](docs/INTEGRATIONS.md)
- [Persistence and configuration](docs/CONFIGURATION.md)
- [MVP and implementation order](docs/MVP.md)
- [Future intelligence](docs/FUTURE.md)
- [Decisions and open questions](docs/DECISIONS.md)

## A useful mental model

Lugn separates three concepts that are often accidentally mixed together:

1. **Physical state** — what devices are doing right now.
2. **Logical state** — scene, source, desired values, overrides, routines, and other intent.
3. **Continuity** — whether the current visit is still considered the same room context after an absence.

Example:

- the last person leaves;
- lights turn off immediately;
- music pauses immediately;
- Cozy remains the logical scene;
- a manually adjusted desk light remains remembered;
- the current media choice remains remembered;
- if the person returns shortly, the room restores that effective state;
- after a sufficiently long confirmed absence, selected pieces of context expire according to policy.

In short:

> **Presence controls whether the room is active. Continuity controls what the room remembers.**

## License

License is not yet selected. Do not assume reuse terms until a LICENSE file is added.
