# Godnatt and the next morning

The Bed Hub has a separate, larger Släck button and a compact evening/morning
row. Släck uses the existing `scene.all_off` intent; it is no longer a preset tile.
The music column, its controls and saved volume settings are unchanged.

Godnatt opens a wake-time question. Confirmation starts a 15-minute light fade
and saves one of three choices for the next morning:

- **Automatic:** start a gentle 20-minute transition to 40% white at the chosen time.
- **Show button:** present God morgon for one hour without changing devices.
- **No morning:** only run the evening fade.

Before 06:00, a still-future time refers to the coming morning on the current
Stockholm date. Otherwise it refers to the following date. Spring DST gaps are
rejected; an autumn repeated time uses the first instant. The time is when the
light transition **starts**, rather than the time it reaches full brightness.

Music is unchecked by default. When selected, God morgon may resume the player's
already selected source through the existing play capability. It never selects a
source, adjusts volume, changes Auto/Manual authority, or rewrites volume settings.
Presence, home/away, quiet hours and explicit Pause remain authoritative, including
for a manually pressed morning button. A blocked or failed optional music action
adds a run warning and allows the lighting transition to continue.

Targets come from configured accent lights in Mysljus (or Vardagsljus if absent).
Ceiling lights that are off in that scene are not added. Missing status or offline
lights are skipped and reported. The plan retains its explicit target scope;
newly online devices are never silently added. White intent is included with
positive fade increments, so Party RGB does not leak into morning lighting.

Closing the question does not save or start anything. Confirmation uses the
routine document generation and an idempotency key. A persisted retry receipt
prevents an acknowledged or lost-response request from starting twice, including
after restart. The plan badge edits or removes the one-off morning. Manual scene
changes cancel active fades and snoozed continuations; a separately confirmed
next-morning plan remains until explicitly removed.

## Persistence and scheduling

The existing atomic `.routines.json` sidecar stores two owned definitions,
`bedtime-night` and `bedtime-morning`, plus bounded request receipts. Existing
custom routines are preserved; legacy disabled templates stay disabled. The new
flow runs through RoutineService and typed capabilities rather than a parallel
scheduler or device transport. No wake plan is created by installation, startup
or simply opening the Hub.

Only future plans survive restart. Consumed one-off occurrences are marked before
execution, so restart and a backward clock correction cannot repeat them. Late
starts are skipped; active fades and snoozes do not resume after restart. Button
windows are transient and never replay on restart. Owned definitions are edited
through the Hub flow; the generic routine editor rejects their replacement.

The authenticated Hub POST `/display-api/bedtime` forwards to
`routines/bedtime`; the authenticated web API can use `/ui/api/routines/bedtime`.
The request includes `action`, `expectedGeneration` and `requestId`. Start/plan
also include `wakeTime`, `mode` and the explicit optional `music` boolean. Clear
removes the plan; morning starts manually without inventing a future wake.

Older builds do not understand the added routine fields. Test deployments retain
an old-sidecar backup and a rollback helper. Restore that routine sidecar when
rolling back; preserve config, scenes, camera and volume preferences separately.

## Verification boundaries

All automated behavior tests use fake clocks and simulated adapters, including
DST, persistence conflicts, retries, restart, manual intervention, optional music
policy and unavailable lights. Browser checks use isolated local fixtures and a
simulated room runtime. Deployment checks read health, state, served assets and
preference hashes; they do not run a real bedtime/wake sequence or start music.

Simulated Hub screenshots (1024 × 600): [Bed](lugn-2/screenshots/bedtime/bed.png),
[wake question with music explicitly selected](lugn-2/screenshots/bedtime/wake-music.png),
and [Desk](lugn-2/screenshots/bedtime/desk.png). Music starts unchecked.
