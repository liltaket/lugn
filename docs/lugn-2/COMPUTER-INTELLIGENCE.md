# Computer intelligence (Workstream D)

The standalone policy service is composed by `computer-intelligence-runtime.ts`
and `intelligence-api.ts`, with authenticated web/Hub actions and SSE projection.
The existing computer protocol is unchanged. Settings are persisted in the
private `.intelligence.json` sidecar beside the configured state path.

## Safety and policy

Both Optical and scene suggestions default **disabled**. No constructor,
observation, timer or settings save invokes a capability. Only an explicit,
revalidated human suggestion acceptance invokes one of:

- `lighting.activateScene({sceneId})`
- `music.selectSource({target,source})`

There are no volume changes, desktop playback commands, scene automation or
switch-back commands. A successful callback means a request was accepted; it
never changes or confirms observed receiver state in this service.

**Optical remains suggestion-first even with `mode: 'auto'`.** The unchanged
Linux observation v1 protocol has no mute, gain or audible-sample evidence.
PipeWire `playing` alone is insufficient. `automaticAllowed` is always false;
`state: 'permitted'` means a suggestion is permitted, never automatic execution.
The decision reason is `suggestion_only_no_audibility` when all suggestion gates
pass. A future automatic policy requires a separately reviewed evidence contract.

Optical suggestions require:

- An exact existing target → `{deviceId,source}` `computerAudio` mapping and an
  explicitly selected device/target/source in settings. No name discovery.
- Fresh trusted online, non-retained `reason: 'live'` computer snapshots with
  nonfuture observed/received times, increasing sequence and time in one session.
  Repeated reads/duplicates do not extend monotonic freshness. Invalid evidence
  clears temporal context. A restart or stale recovery is a baseline, not a start.
- A known paused/stopped MPRIS player transitioning to Playing. Exactly one player
  may be playing, with a nonempty title, explicit `audio/*` or `video/*` content
  type matching the activity classification, matching focused application and
  matching PipeWire application, and explicit unlocked/non-idle desktop state.
  Identity matching trims/case-folds and removes `.desktop`; no title heuristics.
- The same corroborated player and activity throughout the stability interval
  (default 10 seconds). A replacement player cannot inherit elapsed stability.
- Occupied room, explicit home status, permitted playback policy and quiet-hours
  policy, no explicit Pause or manual-source hold, and a fresh trusted available
  receiver reporting Idle or Paused with the configured source allowlisted.
  Playing Spotify or any other Playing receiver blocks the suggestion. Unknown,
  Off and pending receiver requests block it too. Provider uncertainty must fail
  closed. Engine playback holds independently block it.

Manual source changes away from Optical, Pause/source holds, observed Optical,
accept/reject/dismiss and expiry consume the current context. A brief stop cannot
rearm it: at least five seconds of known stopped media and a new start transition
are needed, plus cooldown (default five minutes). A continuously playing context
gets at most one suggestion. Expired or dismissed suggestions are not recreated
by heartbeats. No automatic commands are possible even if a provider is wrong.

Scene suggestions use only configured activity → available scene mappings after
a fresh activity transition stable for five seconds, with occupied/home,
non-quiet, trusted context and no lighting hold. They never activate on startup,
never activate automatically and revalidate mapping, scene availability, context,
policy and expiry on accept. Rate limiting applies globally per suggestion kind
across configured computers; no preferences or suppression survive restart.

## Integration API

Import directly from:

- `src/core/intelligence.ts`: shared settings/suggestion schemas and types,
  `defaultIntelligenceSettings()`, `IntelligenceError(status, code)`.
- `src/runtime/intelligence-settings-store.ts`: `IntelligenceSettingsStore`.
- `src/application/computer-intelligence.ts`: `ComputerIntelligence`,
  `ComputerIntelligenceService`, `IntelligenceCapabilities`, `IntelligenceTrust`.

Composition order (illustrative names; the lead supplies the real providers):

```ts
const store = new IntelligenceSettingsStore(sidecarPath, onWarning);
await store.load();
const intelligence = new ComputerIntelligence({
  clock,
  settingsStore: store,
  computerDeviceIds: configuredComputerIds,
  computerAudio: explicitComputerAudioRoutes,
  getState: () => engine.state,
  getTrust: (deviceId, target) => currentTrustAndPolicy(deviceId, target),
  availableSceneIds: () => [...engine.scenes.keys()],
  capabilities: registry,
  onChange: (snapshot) => publishIntelligence(snapshot),
});
```

`CapabilityRegistry` satisfies the two-method typed capability seam. It is also
possible to inject a mocked callback object for simulations. `getTrust` returns
`{computerTrusted,receiverTrusted,playbackAllowed,quietHours,manualPause,manualSourceHold}`.
It must read current authoritative input trust/engine policy, including the
Stockholm 23:00–06:00 quiet-hours gate and all manual source ownership. `target`
is null for computer/scene freshness checks. Unknown trust/permission means
false; unknown quiet-hours/hold state means blocked. Do not use playback
`entryEligible` alone as permission: that describes a future room-entry event.

- `snapshot()` returns a cloned `{settings,generation,suggestions,optical}`.
  A changed settings generation immediately discards old evidence, suggestions
  and decisions before projection, without evaluating sensors or dispatching.
- `observe()` reads current providers synchronously; call it on computer, receiver,
  presence, intent/hold, scene availability and trust/policy changes. Enabled
  features also use one Clock maintenance timer at one-second resolution for
  stability, expiry, cooldown and freshness. Every observation rebases evidence
  before evaluating a changed settings generation; a still-playing computer is
  a new baseline, not a transition carried over from disabled/older settings.
- `updateSettings(settings, expectedGeneration)` validates configuration and
  available mappings, awaits atomic persistence and returns the current snapshot.
  Generation changes rebase at publication, rather than at save completion: the
  store exposes the renamed document while directory sync is still pending.
  Completion (including failure after rename) reconciles the current repository
  generation. Older completions cannot reset newer evidence or reactivate older
  settings; disposed services never restart maintenance. It never issues a device
  request.
- `respondSuggestion(id, 'accept'|'reject'|'dismiss', invocation?)` returns a
  Promise of the snapshot. Accept requires authenticated human provenance with
  actor type `user` or `physical_remote`, and invokes normal capabilities with
  that provenance. The ID is consumed before dispatch, including callback failure.
  Callers must supply authentication, CSRF and role authorization at the route.
- `subscribe(callback)` returns an unsubscribe function; `onChange` is an initial
  subscriber. Notifications contain cloned snapshots and ignore observer errors.
- `dispose()` cancels maintenance and clears subscribers/contexts. No later timer
  or observation callback can publish or dispatch. New actions reject with 409.

Decision shape:
`{deviceId,target,source,state:'pending'|'suppressed'|'permitted',reason,evidence:string[],automaticAllowed:false,suggestionAllowed:boolean,stableSince:number|null,evaluatedAt:number}`.
`stableSince` and timestamps are epoch milliseconds; intervals use monotonic time.
Human-readable suggestion reasons explain evidence without claiming audibility.

Optional timing overrides for simulation: `maxObservationAgeMs` (default 90000,
range 1000–300000), `suggestionTtlMs` (default 60000, range 1000–300000).
Settings bound stability to 1000–300000 ms and cooldown to 1000–86400000 ms;
`respectManual` can only be true. Activity names remain strings in the shared
contract; only actual known classifications can match configured mappings.

## Persistence and errors

The versioned atomic sidecar is `{version:1,generation:<UUID>,settings}`. Call
`load()` before composing the service. Missing files use disabled defaults;
unreadable, invalid, oversized or symlink files use disabled defaults and block
saving rather than overwriting existing preferences. Writes are serialized,
private (0600), fsynced and renamed; directory fsync is attempted on POSIX.
Only settings persist, never observations, suggestions, device requests or holds.
Use one store instance as the runtime authority; cross-process writers are not
supported. Successful save acknowledges a completed rename, unlike the existing
engine's debounced intent persistence.

`IntelligenceError` exposes `status` and `code` for route adaptation: stale settings
and unavailable suggestions are 409; invalid mapping/scene/provenance/action is
400; failed/blocked persistence is 503. Schema failures are Zod errors (route 400).
A failed write leaves the prior in-memory settings/generation intact. Invalid
settings are rejected before saving; failed capability acceptance is consumed and
propagates the normal capability error to the caller.

## Validation boundary

All new tests use FakeClock, an adapter-free engine state fixture, mocked
capabilities or temporary local files. They cover receiver activity and holds,
freshness/ordering/retained/restart evidence, ambiguous/false audio, player
handoff, hysteresis/cooldown, away/unknown/quiet policy, context suppression,
expiry/accept revalidation, long stability/heartbeat sequences, subscription and
disposal, optimistic saves, restore and atomic-write failures. No private runtime
configuration, real endpoints, devices, deployment or physical validation is used.

Recorded host validation: 232 tests passed across the two new suites (69 tests)
and six existing computer suites (`computer-now-playing`, `computer-engine`,
`computer-playback-routing`, `computer-playback-controller`,
`computer-playback-mqtt`, `computer-mqtt`). `npm run typecheck`, `npm run build`,
and targeted ESLint/Prettier checks passed. Independent read-only review found a
player-handoff stability bug; it was fixed and both handoff regressions passed.
The full repository suite, HTTP/runtime integration, CI and physical behavior
were not validated by this workstream.

Follow-up generation-race validation: a deferred repository models the real
store's separate rename/publication and directory-sync completion boundaries.
The regression failed before the repair by emitting scene and Optical
suggestions from disabled-generation evidence during sync. Nine added cases
cover generation-coherent snapshots, pending-save evaluation, preserving new
evidence at delayed completion, concurrent/stale saves, newer disabled settings,
failure before/after publication and disposal. All 78 service/store tests,
`npm run typecheck`, `npm run build` and targeted ESLint/Prettier checks passed.
This follow-up changes no runtime/API wiring, scene-name callback or UI copy.
