# Lugn 2.0 delivery contract

## Destination and operating boundary

Deliver reviewed draft PRs for a calm, usable Hub and web experience, reusable routines,
conservative computer context and accurate artwork. No merge or deployment is authorized.
All development uses simulated adapters, fake clocks and loopback previews. Never contact
production Home Assistant/MQTT/device endpoints, actuate devices, restart production or
enable automation in deployed configuration. Every new automatic behavior defaults off.

Baseline: fceced7, including merged #65, #66 and #73. Existing open PRs concern small
security/accessibility/performance changes; preserve the authentication boundaries and
avoid duplicating them. Issue #18 is background: deterministic suggestions are in scope,
preference learning and automatic promotion are not.

## Architecture and ownership

Reuse CapabilityRegistry, LugnEngine ownership/holds, Clock/FakeClock, authenticated
HTTP/display routes, SSE and atomic sidecar persistence. Keep optional orchestration
outside the lighting fast path. Keep requested actions distinct from device confirmation.

- C owns new core/routines.ts, application/routines.ts, runtime/routine-store.ts,
  focused tests, and necessary hooks in application/lugn-engine.ts and capabilities.ts.
- D owns new core/intelligence.ts, application/computer-intelligence.ts,
  runtime/intelligence-settings-store.ts and focused tests. No edits to existing engine,
  capabilities, runtime composition, HTTP servers or frontends.
- E owns artwork contracts/resolution, HA music metadata extraction and schema additions,
  artwork tests, and artwork-specific display-server support. No frontend edits.
- A owns src/ui/display.html, display.css, display.js and Hub UI tests/fixture assets.
- B owns web/index.html, styles.css, app.js and web UI tests.
- Lead owns runtime composition/config, shared HTTP integration, simulated preview harness,
  integration tests, documentation, final integration/review and draft PR publication.

Workers commit in independent worktrees; they do not merge, deploy or publish PRs.
The lead integrates commits and publishes a small dependency stack after review.

## Shared presentation and API contract

Existing room state is authoritative and remains compatible. New presentation fields are
additive, top-level fields of /ui/api/overview and display-api/state/SSE snapshots.
Clients tolerate absent fields during staged rollout. Existing controls remain available.

### Routines

`routines: {version:1, generation:string, definitions:RoutineDefinition[], runs:RoutineRun[], next:RoutineOccurrence[]}`.
Definition: `{id,name,kind:'good_night'|'good_morning'|'custom',enabled,schedule:null|{time:'HH:mm',weekdays:number[]},steps:RoutineStep[]}`.
Weekdays use ISO 1=Monday through 7=Sunday. Schedule timezone is fixed Europe/Stockholm.
Step union keyed by `type`:

- scene: `{type:'scene',sceneId}`
- light: `{type:'light',targets:string[],brightness:number,durationMs:number}` (0 means off)
- volume: `{type:'volume',target,volume:number,durationMs:number}` (volume 0..1)
- playback: `{type:'playback',target,state:'playing'|'paused'}`
- source: `{type:'source',target,source}`
- preset: `{type:'preset',target,preset:'spotify_dj'|'optical'}`
- delay: `{type:'delay',durationMs}`
- condition: `{type:'condition',condition:'occupied'|'home'|'music_idle',target?:string}` (false stops)
  Run: `{id,routineId,status:'running'|'completed'|'cancelled'|'failed',stepIndex,startedAt,updatedAt,reason:string|null}`.
  Occurrence: `{routineId,at:number}`. Empty arrays are valid. Templates are disabled.

Authenticated web routes (POST uses existing CSRF/session checks):

- GET /ui/api/routines returns snapshot above
- POST /ui/api/routines/save `{definition,expectedGeneration}`
- POST /ui/api/routines/delete `{id,expectedGeneration}`
- POST /ui/api/routines/action `{id,action:'start'|'cancel'|'snooze'|'skip',requestId?,minutes?}`
- POST /ui/api/routines/preview `{definition}` returns `{timeline:[{atMs,label}],durationMs,warnings:string[]}` without commands
  Hub: POST display-api/routine `{id,action,requestId?,minutes?}` with authenticated role provenance.
  Start is allowed only for enabled definitions; enabling is an explicit persisted choice.
  Snooze/skip relate to a known scheduled occurrence; no inferred wake/bed context.

### Computer intelligence

`intelligence: {settings:IntelligenceSettings,generation:string,suggestions:Suggestion[],optical:OpticalDecision[]}`.
Settings: `{version:1,optical:{enabled:false,mode:'suggest'|'auto',deviceId:string|null,target:string|null,source:string|null,stabilityMs:number,cooldownMs:number,allowedActivities:string[],respectManual:true},suggestions:{enabled:false,cooldownMs:number,sceneMappings:Record<string,string>}}`.
Suggestion: `{id,kind:'scene'|'optical',title,reason,deviceId,sceneId?:string,target?:string,source?:string,createdAt,expiresAt}`.
Only configured mappings may generate suggestions. Dismiss/reject suppress for current
context; accept revalidates availability and normal capability policy. No automatic scenes.
Optical decisions explain pending/suppressed/permitted state; PipeWire playing alone never
proves audibility. D may conservatively restrict auto mode if evidence is insufficient.

- POST /ui/api/intelligence/settings `{settings,expectedGeneration}`
- POST /ui/api/intelligence/suggestion `{id,action:'accept'|'reject'|'dismiss'}`
  Hub: POST display-api/suggestion with same body and role provenance.

### Artwork

`artwork: Record<semanticMusicTarget,{url:string|null,status:'available'|'missing'|'unavailable',source:'home_assistant'|null}>`.
Only same-origin, server-generated paths appear in the projection; no arbitrary URL fetch.
Prioritize HA's entity_picture. No external metadata lookup by default. Defer external
providers rather than shipping insecure or inaccurately matched artwork. E may safely
extend this contract with metadata fingerprints/cache keys. UI has a fixed-size fallback,
error handling, no layout shift and does not block controls on image load.

## Shared design direction

Operate mode: a quiet Swedish room instrument. Mineral charcoal #18201f, deep surface
#222d2a, readable ivory #edf1e7, muted sage #aebdb0, soft amber #e7bc78 and mist blue
#a4c7d2. Use a local system humanist sans (Segoe UI/Cantarell), tabular clock numerals,
left alignment, warm bedtime accents and cool desk accents. Maintain Bed/Desk hierarchy.
Hub: asymmetric light-control and now-playing composition, not a wall of identical cards.
Web: stable section navigation, overview first, advanced diagnostics behind disclosure.
Share color/type/spacing vocabulary; no new frontend framework or remote font dependency.
Visible focus, reduced motion, large touch targets, truthful pending/offline states.

## Integration acceptance checklist

- [x] Baseline check/build recorded (environment failures distinguished from code failures).
- [x] All five workstreams incorporated together and checked.
- [x] Manual intent cancels future routine work; cancellation/restart cannot replay actions.
- [x] Stockholm DST, clock jumps, duplicates and multiple triggers covered with fake clocks.
- [x] Automatic playback gates remain authoritative; no new automatic behavior defaults on.
- [x] Optical cannot interrupt Spotify, react to stale/retained data or loop on start/stop.
- [x] Suggestion accept revalidates; dismiss stays suppressed for the current context.
- [x] Artwork proxy uses a fixed trusted upstream; missing/failed artwork is harmless.
- [x] Web drafts survive live updates; persistence is atomic and rejects stale generations.
- [x] Simulated Hub (1024x600), desktop and mobile interaction/screenshots reviewed.
- [x] Existing presets/BILRESA/sessions/fades/volume modes regression suites pass.
- [x] Independent review findings resolved; draft PR bodies match actual evidence.
- [x] No physical tests, real device commands, production connections or deployment performed.
