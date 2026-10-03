# Contributing

Lugn is under active implementation. The design documents remain the product contract; update them deliberately when a concrete implementation choice settles an open question.

Before implementing a subsystem, read the relevant documents in docs/ and preserve the behavioral contracts they describe.

## Design priorities

When tradeoffs appear, prefer:

1. predictable behavior over clever behavior;
2. low latency on genuinely latency-sensitive paths;
3. explicit state and typed interfaces;
4. observable decisions over hidden heuristics;
5. respecting manual control over aggressive automation;
6. simple local operation over unnecessary infrastructure;
7. reusable capabilities over one-off integration logic.

## Architecture rules

- Do not put device-protocol details in domain logic.
- Do not implement a second control plane for AI/voice.
- Do not treat unknown presence as empty.
- Do not equate physical off/pause with forgetting logical context.
- Do not mark device feedback as manual before checking pending commands.
- Do not make the lighting fast path wait on persistence or UI work.
- Do not add runtime AI as an MVP dependency.

## Changes to behavior

If implementation reveals that a documented contract is impractical, update the design document deliberately rather than silently changing behavior in code.

## Tests

Core decisions should be testable with simulated devices and events.

Hardware integration tests are valuable, but the state machine, ownership, continuity, routines, and convergence logic should not require physical hardware to test.
