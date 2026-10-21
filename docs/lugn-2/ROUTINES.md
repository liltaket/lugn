# Routine orchestration (Workstream C)

This service implements the routine wire shapes in `DELIVERY.md`. `routine-api.ts`
composes it with authenticated web/Hub actions and SSE projection. Definitions
live in the private `.routines.json` sidecar beside the configured state path;
missing files seed disabled templates in memory. All implementation evidence uses
simulated adapters, mock computer playback and fake clocks. No deployed behavior
is enabled.

## Composition

Load the store **before** constructing the service. Supply configured semantic
light/music targets when generating optional templates:

```ts
const store = new RoutineStore(
  routineSidecarPath,
  createRoutineTemplates({ lightTargets, musicTarget }),
  onWarning,
);
await store.load();
const routines = new RoutineService(clock, {
  engine,
  capabilities: capabilityRegistry,
  store,
  // Optional light command spacing, 250–30,000 ms; default 1,000 ms.
  fadeIntervalMs: 1_000,
  onChange: (snapshot) => publishPresentation({ routines: snapshot }),
});
```

- `routines.snapshot()` returns the exact version/generation/definitions/runs/next
  envelope. Returned objects are detached from internal state.
- `await store.save(definition, expectedGeneration)` and
  `await store.delete(id, expectedGeneration)` validate and atomically persist
  definitions, return the definition document and notify the service. A changed
  or deleted active definition cancels its run; unrelated edits preserve runs
  and snoozes. Store generation conflicts throw `RoutineError(409,
'routines_changed')`.
- `routines.action({id,action,requestId?,minutes?}, authenticatedProvenance)`
  synchronously returns a snapshot. The lead must derive provenance from the
  authenticated UI/Hub role, never from untrusted request fields. Start requires
  an enabled definition and human provenance. Requests are validated with
  `RoutineActionSchema`.
- `routines.preview(definition)` is pure and returns the contract timeline;
  no commands, writes or subscriptions occur. Timings describe requests,
  never device confirmation.
- `routines.subscribe(listener)` returns an unsubscribe function. `onChange`
  and subscribers receive state changes for SSE projection; initial state comes
  from `snapshot()`. Subscriber failures do not alter orchestration.
- Dispose routines before the engine at shutdown. Service disposal clears its
  heartbeat/waits, cancels owned native fades and invalidates queued scoped
  computer work. Engine disposal clears adapter/controller timers as usual.

Map Zod validation errors to HTTP 400, and `RoutineError.status`/`.code` to
existing authenticated API error handling. The service does not implement
sessions, CSRF, listener configuration or routes.

## Behavior and boundaries

Definitions are limited to 50, with 32 steps each, 32 light targets per light
step and six hours of declared sequence duration. Individual light fades and
waits are at most one hour; volume fades reuse the native 1–120 second capability
(or duration zero for an immediate volume request). Dispatch is bounded to 15
seconds. At most eight disjoint runs execute concurrently; an overlapping start
cancels prior work for the same routine or affected targets. The snapshot retains
100 recent runs.

Runs capture deep copies of referenced scene definitions together with their target
scope. Editing or deleting a referenced scene immediately cancels the run, including
while waiting before a scene step or during activation publication. Restoring an old
definition cannot revive cancelled work. Unrelated scene edits leave runs alone;
new scene targets never bypass manual intervention or overlap checks.

Both supplied templates are disabled and unscheduled. Good Morning requires
home/occupied conditions and fades from reported off/brightness toward 40%; it
has no initial bright scene or music start. Good Night gradually turns configured
lights off and optionally composes native music fade/pause. Users must explicitly
save an enabled definition before either manual or scheduled start.

Light fades interpolate from observed state, treating reported off as zero rather
than remembered brightness. They wait before the first increment, space commands
according to the configured interval and avoid duplicate rounded brightness levels
on long fades. Unknown brightness/unavailability fails safely. A zero brightness
endpoint requests off. Duration zero explicitly requests the endpoint immediately.
Music fades reuse native bounded feedback/settling behavior and complete before
advancing the sequence. A false condition stops the run.

A manual start retains authenticated human lighting/playback intent. Volume steps
always use a routine actor, so they cannot seize a human volume hold, replace a
human fade, hand back volume authority or enable automatic volume policy.
Scheduled source/preset/play steps recheck existing occupied/home/quiet-hours/Pause
policy at the final guarded dispatch. They never use a human actor or release a
human Pause. A scheduled run loses eligibility when occupancy is no longer
confirmed or home becomes explicitly away.

UI/BILRESA commands and attributed external light, playback, volume or source
changes cancel affected active routines. Unrelated targets continue. The engine
exposes generic `subscribeInterventions`, optional capability execution guards,
`cancelExecution` and automatic playback eligibility hooks. Guards survive native
publication/preparation awaits and prevent cancelled scope transport/retries.
Queued computer playback is invalidated on cancellation/timeouts. Fade cleanup
checks the native fade ID to preserve newer human replacements. Existing accepted
commands cannot be recalled. Lighting property/scene batches retain their original
revision and invocation guard through publications, transport completion and retry
authorization. A newer scene cannot replace the scope guard of already captured
values. Reapply and relative brightness capabilities forward the same guard to
their underlying lighting operations. Native source feedback may invalidate selector
recovery; a selector already accepted by the adapter may advance without claiming
preset confirmation.

Source attribution remains conservative: explicit command correlation or a recent
matching source request may attribute feedback. Uncorrelated preset feedback is
recognized only for canonical Spotify/Optical Playing observations, once within
the existing feedback window. Arbitrary source transitions cancel rather than
assuming preset success; Pause is always handled as an independent human intent
unless the existing playback controller attributes its own explicit Pause.

## Scheduling and restart

The schedule timezone is always Europe/Stockholm, with ISO weekdays 1–7. The next
occurrence is strictly in the future. A nonexistent spring DST time is skipped;
a repeated autumn time uses its first instant once. No active run, snooze, pending
step, device observation or occurrence queue is persisted. Restart loads only
validated definitions and computes the next future occurrence; it never replays
an overdue wake sequence.

A one-second heartbeat compares wall and monotonic clocks. Wall clock drift over
one second cancels active runs and recomputes future schedules. A wall-time high
water mark prevents backward corrections from replaying an occurrence. Steps and
fade increments that resume more than one second late fail instead of catching up.
The same guard is checked before a delayed step can beat the heartbeat. Clock
corrections intentionally favor skipping work over replaying it.

Skip/snooze operate on the routine's active scheduled occurrence, otherwise its
known next occurrence. They fail if neither exists. Snooze defaults to ten minutes
and accepts 1–120; it retains scheduled provenance and all automatic gates. A
manual run without a schedule does not invent a wake occurrence.

`requestId` deduplication is scoped to the current service lifetime, including
synchronous publication reentry. A repeated ID/action/actor returns current state
without rerunning an action; reuse with a different action/actor returns 409.
Up to 1,024 IDs are retained without silent eviction; further new keyed requests
return 429. Omit an ID for an uncached explicit action. The definition sidecar does
not persist action receipts; clients must not automatically replay action POSTs
across a runtime restart. This is the only integration caveat to the shared
contract; no wire schema changes were needed.

The versioned sidecar uses exclusive 0600 temporary files, fsync, rename and
best-effort directory fsync. It enforces the same 1 MiB byte bound on save/load,
rejects stale generations, serializes edits and refuses writes after corrupt or
symlink input. One runtime owns each sidecar; cross-process edits are unsupported.

## Deterministic evidence

`tests/routines.test.ts` and `tests/routine-store.test.ts` exercise disabled
startup, pure preview, bounded validation, light/music sequencing, native fade
confirmation and ownership, cancellation, BILRESA/UI/external intervention,
source/preset attribution, optimistic persistence, restart, duplicates/concurrent
starts, enable/disable/delete, snooze/skip, night/day/Pause/home/presence gates,
wall clock changes, stale microtask continuations, Stockholm DST gap/fold,
publication/acquisition races, stalled dispatch and queued mock computer sends.
Every fixture disposes the service and engine and asserts no fake timers remain.

Final workstream validation: `npm test` passed 1,090 tests across 72 files, plus
its temporary systemd installer fixture; 63 tests are in the two focused routine
files. `npm run build`, `npm run typecheck`, `npm run lint`, focused Prettier checks
and `git diff --check` passed. The full suite required the sandbox's loopback socket
permission; an initial restricted run was stopped after socket-related fixture
failures. No physical, deployed or external-service behavior was validated.

Follow-up backend review repair: retained the two isolated reviewer repros as normal
regression tests and observed both fail before the repair. The final targeted runs
passed 368 distinct tests across 21 suites, including 76 focused routine/store tests
(the focused pair ran in both groups). Tests additionally cover replacement scenes
during scene/command/retry publication, multi-target batches, referenced scene
edit/delete/restore, concurrent scope expansion, unrelated edits and guard forwarding
through reapply/relative brightness. Typecheck, build, lint, formatting and diff
checks passed. This repair leaves computer playback policy/guard forwarding to the
lead's separate finding-3 change; runtime/API integration is unchanged.
