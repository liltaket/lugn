# Web workstream B

This slice builds on `e755506` and changes only the web assets, focused tests,
a standalone in-memory preview fixture and this document. No runtime composition,
configuration, adapters or shared contracts are changed.

## Experience

The responsive web panel has five tabs: Hem (`#oversikt`), Ljus (`#belysning`),
Musik, Rutiner and Inställningar (`#installningar`). Hem works like a home app:
the active scene, status chips for presence, lamps, music and connections, the
scene tiles, a compact player and the next known routine. Presets are edited on
Ljus, which also lists the individual lamps. Inställningar is a grouped list
leading to Musikautomatik, Intelligens, Kameror, Datorer, Anslutningar and
System, each its own hash page (`#musikautomatik`, `#intelligens`, `#kameror`,
`#datorer`, `#anslutningar`, `#system`). The list is a sticky sidebar on
desktop and its own page with a back link on phones; a row disappears when the
server has not enabled that part. Existing lighting preset
editing, music modes/settings, authentication and SSE ordering remain intact.
The navigation stays reachable while editing; section changes and live snapshots
retain local drafts. Native labels, visible focus, reduced motion, weekday
checkboxes and large controls support keyboard and touch use.

The panel is an ordinary, calm interface under one image: a WebGL aurora over
a mountain lake heads every page (most of the first screen on Hem, a strip on
other pages, the whole screen behind sign-in). Without WebGL, or when the first frame
renders slowly, a CSS night gradient or a single still frame stays instead, and
reduced motion keeps the frame still. Colours: page `#06090d`, raised surfaces
`#0d1319`, ink `#ecf0f2`, muted `#aab5be`, and mint `#8ff0c4` as the only accent.
Newsreader (serif headings) and Familjen Grotesk (controls and text), both OFL,
are served locally from `/ui/fonts/`. Desktop has a glass sidebar with the
navigation, live status and sign-out; phones and tablets get a top bar and a
bottom tab bar. Technical evidence stays behind disclosure.

Sign-in is a centred card under the logo on desktop and sits within thumb reach
on phones. The panel installs as an app: `/ui/manifest.webmanifest` (standalone,
start and scope `/ui/`), icons in `/ui/icons/` (192/512, maskable 512, Apple
touch 180, favicon 32 and the 128 px mark used in the page), iOS meta tags and
safe-area padding. `/ui/sw.js` never caches the panel or the API; it only
answers a failed navigation with `/ui/offline.html`. The icon art is a generated
image (aurora ribbon over a fell and lake) rendered to each size.

## Routine authoring

Create a routine or use the disabled God natt / God morgon templates. Edit its
name, kind, explicit enabled choice, Stockholm time and ISO weekdays. Add,
remove, reorder and edit scene, light, volume, playback, source, preset, delay
and condition steps with labeled controls. Brightness 0 means off; the UI converts
light/delay minutes and volume-fade seconds to milliseconds, and volume percentages to the contract's 0..1 scale.
For example: Mysljus, dim lights to 10% over ten minutes, then a second light
step at 0% over zero minutes. No JSON editing is needed.

The editor enforces at most 32 steps, light/delay durations of at most 60 minutes,
volume fades of 0 or 1–120 seconds, and at most six hours of declared duration.
Manual volume ownership may block volume steps; run status remains authoritative.

Preview posts only the draft to the pure timeline endpoint. Changing the draft
invalidates the displayed preview, and a late preview cannot replace a newer
one. Creating a draft or previewing never starts a run. Start is disabled for
persisted disabled definitions; enabling requires an explicit checkbox and save.
Snooze/skip appear only for server-projected occurrences. Active and historical
runs show authoritative server status and reason, separately from device reports.

## Intelligence

Both opt-ins remain as supplied by the backend and default disabled for new
settings. Optical exposes computer, player, exact source, allowed activities,
stability, cooldown and mode. Current v1 observations cannot establish audibility:
the automatic mode option is disabled, and visible text explains that Optical
requires a suggestion and explicit confirmation. Existing stored `mode: auto`
can still be displayed without implying automatic switching works.

Scene mappings are edited as activity/scene rows. Only the backend generates
suggestions or decides whether an action is permitted. Accept/reject/dismiss
post the suggestion ID; the UI does not infer room, bedtime, audibility or
eligibility. Server Optical decisions and evidence are available under disclosure.

## API integration

The authoritative extension fields are read from overview/SSE snapshots.
Absent fields produce an unavailable state without hiding existing controls.
All writes retain same-origin credentials and the current `X-Lugn-CSRF` token.

| Route                                  | Body / result                                                   |
| -------------------------------------- | --------------------------------------------------------------- |
| `POST /ui/api/routines/save`           | `{definition, expectedGeneration}` → direct `RoutineSnapshot`   |
| `POST /ui/api/routines/delete`         | `{id, expectedGeneration}` → direct `RoutineSnapshot`           |
| `POST /ui/api/routines/preview`        | `{definition}` → `{timeline,durationMs,warnings}`               |
| `POST /ui/api/routines/action`         | `{id,action,requestId,minutes?}` → direct `RoutineSnapshot`     |
| `POST /ui/api/intelligence/settings`   | `{settings,expectedGeneration}` → direct `IntelligenceSnapshot` |
| `POST /ui/api/intelligence/suggestion` | `{id,action}` → direct `IntelligenceSnapshot`                   |

Start/cancel/snooze/skip all use the definition ID. Snooze
requests ten minutes. The fixture also serves `GET /ui/api/routines` for inspection.

Drafts retain the generation they were opened against, even through newer live
snapshots. A conflict refreshes authoritative status while retaining the draft
and its concurrency token. Discard/reopen or explicitly fetching saved intelligence
settings starts from the latest version. Failed requests retain inputs; pending
writes block duplicates. Timeouts report an unknown outcome rather than a failed
or confirmed device action. Successful mutation responses are consumed directly;
a snapshot arriving during a mutation is reconciled through the existing ordered
overview read instead of being overwritten by an older mutation response.

Artwork consumes the optional server projection only. Images must resolve to a
same-origin path; missing, malformed, external or failed images retain a fixed
72px fallback without blocking music controls.

## Safe preview and validation

Use Node 24 and `node scripts/preview-web.mjs` (optional port argument). Open
`http://127.0.0.1:8799/ui/`. This fixture binds only loopback, imports no runtime,
configuration or adapters, and changes only memory. Its one shared production
helper is the pure lighting feedback comparison, matching the script prefix
normally supplied by the HTTP server. Device/capability routes are absent and
cannot be forwarded. `POST /__fixture` with the fixture CSRF value can inject
snapshots, suggestions and runs for SSE and conflict checks. Nothing is persisted.

Validation performed:

- Production build and TypeScript check pass.
- ESLint passes for the changed JavaScript and focused test file.
- 56 tests pass across `web-routines-intelligence`, `music-settings-editor`,
  `music-dashboard-labels`, `computer-dashboard` and `web-preview-fixture`. Sixteen new handler/DOM tests
  cover all routine step types and ordering, exact save bodies, preview invalidation,
  generation conflicts, unavailable/session/network errors, disabled/stale states,
  navigation/draft retention, duplicate writes, delete, suggestion actions,
  intelligence validation/discard, invalid mapping drafts, duration/step limits and artwork failure.
  One HTTP fixture test separately verifies direct response contracts and simulated-only actions.
- T3 collaborative browser against the loopback fixture: disabled routine template
  preview/save, intelligence save with opt-ins still off, unsaved routine retention
  across navigation and SSE, and a real fixture 409 conflict retaining the draft.
  Desktop 1280px and mobile 390px were inspected; no horizontal overflow at 390px.
  The automatic Optical option is disabled and its limitation is visible.

This establishes frontend behavior against the shared mocked contract. Integrated
backend routes, backend policy correctness and real device confirmation remain
lead integration work. There were no production connections, physical tests,
deployments, restarts, pushes, merges or enabled deployed automations. Drafts are
held in memory across live updates/navigation; an unload guard protects them, but
they are not restored after a deliberate browser reload. The fixture is not an
emulator of backend automation scheduling, policy or physical device behavior.
