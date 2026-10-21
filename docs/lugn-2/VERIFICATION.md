# Lugn 2.0 integration evidence

This delivery is developed against `fceced7` (#65, #66 and #73 included), with
shared interfaces and ownership in [DELIVERY.md](DELIVERY.md).

## Baseline

- `npm run check`: 70 test files, 1,027 tests passed, plus the installer fixture.
- `npm run build`: passed.
- Development runtime: Node 24.10.0.
- The restricted sandbox could not create loopback test sockets. The successful
  run permitted local listeners; adapters and transport dependencies remained fakes.
- New HTTP transport checks: 8 tests across the existing and new HTTP suites passed.

## Safety boundary

No production Home Assistant/MQTT/device endpoint is used by development harnesses.
No deployment, production restart, merge, Cast launch, computer-control message,
physical source change, lighting or music command is part of this delivery's evidence.
A simulator establishes software behavior, never physical device response or audibility.

## Local integration preview

After building, `node scripts/preview-room.mjs` constructs the real engine, capability
registry, routine service, computer advisory service and authenticated HTTP/display
servers with simulated adapters. It does not load `config.json`, environment credentials,
runtime/main or network device transports. It binds only to development loopback ports
4206 and 4207 by default, writes temporary state beneath the OS temporary directory,
and removes that state on normal termination. Its enabled **manual** Good Night example
exists only in the temporary simulation; no scheduled behavior is enabled.

The isolated Hub fixture additionally covers morning/running/legacy, missing artwork,
many presets and network failure scenarios. Screenshots are simulation evidence.

## Deliberate scope limits

- Computer Optical routing remains suggestion-first. The current v1 desktop observations
  have no reliable mute/loudness evidence. Even a saved automatic preference cannot grant
  automatic switching authority with this feed; an explicit acceptance is required.
- Initial contextual suggestions use deterministic configured activity mappings. They do
  not implement preference learning or automatically promote suggestions into rules (#18).
- Album artwork uses Home Assistant metadata and a constrained same-origin proxy. MPRIS
  image transport and external metadata lookup are deferred. No track metadata is sent to
  an external lookup provider.
- Scheduled actions and active routines are not replayed after restart. Definitions are
  persistent; runtime execution and ephemeral suggestion history are not durable jobs.
- Triggers are manual or fixed weekday/time schedules. Context conditions can stop a
  sequence; arbitrary context-trigger authoring and preference learning are deferred.
- Real Nest Hub performance, DashCast lifecycle, HA/WiiM feedback cadence, physical light
  fades, computer protocol interoperability and sound remain untested in this assignment.

## Final combined validation

`npm run check` passed after all integration and review repairs: **83 files / 1,291 tests**,
plus the systemd installer fixture. This includes formatting, lint and TypeScript checks.
`npm run build` passed. A preceding attempt exhausted temporary disk space; after removing
only this assignment's disposable download cache/archive and completed reviewer dependency
copy, the complete rerun passed. No environment failure is counted as test success.

The focused fake-clock suites cover Stockholm DST gaps/folds, midnight and quiet hours,
forward/backward clock jumps, restart/overdue avoidance, duplicate triggers, overlapping
runs, manual interventions, scene edits during a delayed routine, guard invalidation
during publication/retry, cancelled desktop work and persistent manual volume ownership.
Computer suites cover idle versus Spotify-playing WiiM observations, retained/stale/offline
data, notification/ambiguous audio, rapid activity changes, explicit source/Pause holds,
context dismissal, cooldowns and settings-publication races. Artwork suites exercise
track changes, missing/incorrect/slow content, trust expiry, allowlisting and bounded cache.
Mocked Hub/web tests cover reconnect/offline, pending/error states and editor concurrency.

Real browser interactions against `preview-room.mjs` verified:

- Starting Good Night from the Hub, then selecting Fokus cancels remaining routine work.
- Previewing the editable scene/dim timeline leaves simulated command counts unchanged.
- Saving a definition persists through the actual authenticated API; cancelling a running
  definition succeeds using its definition ID.
- Intelligence settings roundtrip 1,500 ms stability and 1,000 / 1,001 ms cooldowns through
  native HTML form validity and the actual backend, with both automations disabled.
- A disabled routine with volume ⅓ and a 1,500 ms fade remains valid in the native form;
  a name-only edit saves through the actual API with both step values preserved.
- The 390 × 844 web viewport has no horizontal overflow and six 48 px navigation targets.
- The 1,024 × 600 morning Hub has no page overflow and shows the explicit scheduled wake
  occurrence with snooze/skip while retaining manual scene and music controls.

Screenshots are genuine browser captures of simulated data, never device screenshots:

- [Bed](../../tests/fixtures/hub/screenshots/bed-1024x600.png),
  [Desk](../../tests/fixtures/hub/screenshots/desk-1024x600.png),
  [Desk Max](../../tests/fixtures/hub/screenshots/desk-1280x800.png),
  [offline artwork fallback](../../tests/fixtures/hub/screenshots/offline-art-error-1024x600.png)
- [Running routine](screenshots/hub-running-1024x600.png),
  [morning schedule](screenshots/hub-morning-1024x600.png)
- [Desktop overview](screenshots/overview-desktop.png),
  [mobile overview](screenshots/overview-mobile.png),
  [routine editor and safe preview](screenshots/routine-preview-desktop.png)

## Independent review and integration checklist

First-round artwork, backend and UX reviews were performed in independent worktrees.
The following identified defects have regression fixes: artwork projection typing,
retaining the original lighting invocation guard across reentrant publication and retry,
invalidating active runs when referenced scene definitions change, guarded scheduled
desktop Pause authorization, intelligence evidence reset at atomic settings publication,
web cancellation IDs and millisecond settings form roundtrips. Snooze/skip deliberately
apply to any known scheduled occurrence; only explicit morning context produces the
primary morning card. No wake state is inferred.

Round two independently confirmed those repairs (460 canonical tests across 22 focused
suites plus six selective race checks, typecheck and build). It withdrew the snooze/skip
objection against the documented general occurrence contract. Four additional findings
were repaired: stalled Hub Start blocking Cancel, fractional routine values failing
native validation, manual scenes cancelling unrelated targets, and the standalone web
fixture retaining the old cancellation ID.

Each unpublished stack layer separately passed typecheck, build and focused tests:

| Layer                  | Focused tests       |
| ---------------------- | ------------------- |
| Artwork/API foundation | 57 across 3 suites  |
| Hub presentation       | 138 across 4 suites |
| Routine runtime        | 143 across 5 suites |
| Computer intelligence  | 80 across 3 suites  |
| Web editors            | 25 across 2 suites  |

Round three independently verified all four final repairs: **222 tests across five
focused suites passed**. Reverting the implementations in an isolated temporary copy
reproduced seven expected failures covering those defects. It found no unresolved code
blockers or should-fix findings and approved draft publication, subject to the lead's
passing combined check. Documentation corrects the definition-ID cancellation contract.

The reconstructed five-layer stack has exactly the same integrated source tree as the
reviewed branch, with each fix placed in its owning layer. Final code passed the combined
1,291-test check and build; the subsequent documentation/screenshots pass formatting and
whitespace checks. No Linux agent code/protocol changed, so Rust tests were not rerun.

No physical tests, production connections, deployment or merge occurred.
