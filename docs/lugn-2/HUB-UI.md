# Hub display implementation (workstream A)

The display uses the shared mineral palette, local humanist system fonts, warm
Bed and cool Desk accents. The fixed clock/climate rail sits above asymmetric
scene and music areas. The target CSS viewports are 1024×600 and 1280×800.
Primary controls do not scroll; music explanations and the routines/suggestions
pane scroll independently. Larger custom scene sets are paged (six per page
with contextual content, eight otherwise).

## Data and actions

Existing scene/music/volume/presence controls, role ordering, authenticated path,
SSE instance/revision rejection, polling fallback and pending command readback
are preserved. No client role, actor or source fields are added to requests.
The server remains responsible for authenticated provenance and all policies.

The client tolerates absent `routines`, `intelligence` and `artwork` projections.
It never creates a definition, enables automation, or sends commands on load.

- A running configured routine takes priority and has **Avbryt**. Its step and
  status come from the snapshot, not command acceptance.
- Bed offers an enabled `good_night` routine from 18:00–06:00 Stockholm time.
  Other configured routines remain accessible in **Rutiner & förslag**.
- Morning is shown only for an explicit enabled, scheduled `good_morning`
  occurrence in `routines.next`, or an actual running routine. The UI does not
  infer wake time from hour, presence or music. Snooze adds `minutes:10`; skip
  is available only for that known upcoming occurrence. Running routines offer
  cancellation; no unsupported active-alarm semantics are invented.
- `POST display-api/routine`: `{id:<definition id>,action:'start'|'cancel'|'snooze'|'skip',minutes?:10}`.
  Direct `RoutineSnapshot` responses are accepted; the subsequent state read
  remains authoritative for the whole room.
- Desk presents current, unexpired configured suggestions. Scene suggestions
  require a scene present in the snapshot; Optical suggestions require a real
  configured music target. The secondary pane contains all suggestions/reasons.
- `POST display-api/suggestion`: `{id,action:'accept'|'reject'|'dismiss'}`.
  There is no automatic acceptance, source switching or speculative PC control.
- Artwork consumes `artwork[musicTarget]`. Only same-origin absolute paths are
  loaded, including opaque token paths. The 100px (Hub) / 144px (Max) slot stays
  fixed while loading or on error, with a quiet musical fallback. Failed URLs
  are not retried every heartbeat; changed URLs are retried. Title, artist and
  source have separate lines, including Optical computer media.

The hub does not edit routines or enable settings; disabled templates explain
that activation belongs in the web panel. Server-provided suggestion titles,
reasons and routine names are rendered as text, preserving their supplied
language. English intelligence copy needs upstream localization during lead
integration rather than an unreliable client translation.

## Safe simulated preview

Run from the checkout, with Node 24 available:

```sh
export PATH=/tmp/node-v24.10.0-linux-x64/bin:$PATH
npm run build
node scripts/preview-hub.mjs 4178
```

Open **only** `http://127.0.0.1:4178/bed/` or `/desk/`. Other fixture paths:
`/morning/`, `/running/`, `/legacy/`, `/art-error/`, `/many/` (12 configured scenes).
Keep the trailing slash. The server binds only loopback, reads explicit static
assets and fixture JSON, imports only the pure lighting-feedback predicate from
`dist/core`, and has no runtime composition, adapters, private configuration,
production addresses or outgoing clients. All actions change in-memory sample
state. The fixture deliberately includes enabled definitions and a configured
suggestion to demonstrate existing user choices; it creates no automatic work.
Restarting this mock process resets samples.

Within that loopback preview's browser console:

```js
// Toggle simulated API/stream outage, then run again to restore.
await fetch('/__fixture/offline', { method: 'POST' }).then((r) => r.json());
// Inspect only the mock's captured request bodies.
await fetch('/__fixture/actions').then((r) => r.json());
```

The artwork is an original geometric SVG fixture, not an actual album cover.
No external images, fonts or metadata requests are needed.

## Validation evidence

- Initial baseline: 142 existing browser-logic tests and build passed. Nine
  stream tests initially hit sandbox `listen EPERM`; the unchanged stream suite
  passed after granting loopback socket permission.
- Final focused run: **164 tests passed** across `hub-context`, `hub-volume`,
  `music-dashboard-labels`, `computer-dashboard`, and `display-stream`.
- New mocked tests cover routine start/cancel, pending double taps and unchanged
  observed state, known occurrence snooze/skip, no inferred/disabled wake,
  suggestion accept/reject/dismiss/expiry/configuration, missing projections,
  artwork load/error/URL changes/external URL rejection, stream loss/reconnect,
  stable action DOM during pending work, scene pagination, failed requests and
  preserved all-off/Optical/volume/presence bodies. Full music notices remain in
  Details while compact main notices reserve room for controls.
- Typecheck, build, ESLint, scoped Prettier and `git diff --check` passed.
  Prettier needs `--parser html` for the standalone SVG; it cannot infer `.svg`.
- T3 collaborative preview checked Bed, Desk, scheduled morning, 12 scenes,
  music Details and artwork failure at 1024×600; Desk at 1280×800. Measured body
  scroll width/height equaled the viewport. All visible buttons were at least
  44px high and inside the viewport.
- Browser start/cancel sent the expected mock request bodies and returned the
  contextual strip to its idle state. Simulated outage disabled controls,
  changed observed labels to **Senast**, and preserved the layout. Restoring
  the mock restored **Nu** and enabled controls without replaying commands.
  Artwork 404 left the fixed 100×100 slot and music controls available.
- Only the in-place secondary music pane scrolled (615px content in a 384px
  pane); the room and music controls stayed visible.

Screenshots are in [the fixture directory](../../tests/fixtures/hub/screenshots):
[Bed](../../tests/fixtures/hub/screenshots/bed-1024x600.png),
[Desk](../../tests/fixtures/hub/screenshots/desk-1024x600.png),
[Hub Max](../../tests/fixtures/hub/screenshots/desk-1280x800.png), and
[offline/artwork failure](../../tests/fixtures/hub/screenshots/offline-art-error-1024x600.png).
Names record CSS viewport dimensions. T3 exports the 1024×600 views as
1280×750 PNGs; the Max PNG is 1280×800. Failure/Max captures were taken before
minor final copy/clamping refinements; Bed/Desk captures show the final layout.

No main runtime, production endpoint, physical device, Cast receiver or deployed
automation was touched. Backend route implementation, routine execution safety,
artwork proxy security and the combined workers' integration remain lead-owned;
these UI mocks do not establish those behaviors. Real hardware is untested.
