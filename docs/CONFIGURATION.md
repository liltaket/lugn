# Configuration and persistence

## Goals

Configuration should be:

- human-editable through the web UI;
- representable as validated structured data;
- easy for developers to understand;
- safe for authorized agents to modify through tools;
- versioned and migratable;
- persistent across restart.

Avoid burying ordinary user behavior in hardcoded application logic.

## Configuration domains

Likely configuration areas include:

- devices and semantic IDs
- adapters
- scenes
- room presence behavior
- continuity / decay policies
- music presets
- source switching
- volume schedule
- routines
- BILRESA bindings
- Hub roles
- DashCast behavior
- environment sensors
- convergence/retry policies
- diagnostics settings

## UI and structured representation

The UI and configuration files/API should represent the same underlying schema.

This allows:

- ordinary users to configure visually;
- advanced users to inspect/export structured configuration;
- future agents to create/update configuration through typed tools.

## Persistence principle

> A process restart should, as far as practical, not change the room's behavior.

Persist at least:

- configuration
- device registry
- scenes
- routines
- button bindings
- Hub/display configuration
- current logical scene
- relevant overrides
- continuity timestamps/state
- scheduling settings
- suggestion preferences/suppression where appropriate

## Physical commands after restart

Do not blindly resume stale pending commands from before a crash/restart.

On startup:

1. restore durable logical state;
2. invalidate or carefully classify old pending physical commands;
3. obtain fresh observations;
4. reconcile desired state with reality.

## History and diagnostics

It is useful to retain enough structured history to answer:

- what event arrived?
- what state did Lugn believe?
- what decision was made?
- what command was sent?
- what feedback arrived?
- was it attributed to that command?
- did the target converge?
- why was an override created?
- how long did the fast path take?

History should serve debugging first. Future models may later use selected structured context, but logging should not exist solely "for AI."

## Database

A simple embedded store such as SQLite is a strong initial candidate because it supports:

- one local deployment
- low operational complexity
- transactional persistence
- easy inspection and backup

The concrete choice is not permanently locked yet.

## Time

Use:

- one explicit configured timezone;
- timezone-aware persisted timestamps;
- an injectable/testable clock in core logic.

Schedules and continuity timers must be deterministic in tests.

## Migrations

Configuration/state schema changes require versioned migrations.

Do not silently interpret old configuration under a new meaning.
