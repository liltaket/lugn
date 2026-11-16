# Govee Party and LED 2 rotation — 14 November 2026

Initial Party runtime `f5d50fde807a1be872a813f3c194f00b099a433d` was merged into `main`,
pushed and installed at `/home/bruno/lugn-govee-f5d50fde807a` on BrunoCAM. Both
user services used that release. All 367 installed source/build hashes matched the
qualified host build. The package SHA-256 is
`5de029573d36029d1445944b56d2fb405a2bb99f8212dc102e29a153c25bce64`.

## Saved Party configuration

The existing `scene.party` is updated through the validated preset store:

| Target        | Setting                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| LED 2 / H612F | Rainbow B → Meteor shower → Aurora → Colorful → Forest → Party; repeat, 30 seconds after each successful delivery |
| H612A strip   | Rainbow · A                                                                                                       |
| H6022 table   | Rainbow                                                                                                           |
| H60A6 ceiling | Rainbow Circle, main OFF/ring ON, 20%                                                                             |
| H600D GU10    | Party through the official API                                                                                    |

The other Party lamps retain their existing settings. The six previously saved
presets and deleted-preset list were preserved exactly. Definitions were saved
while the main service was stopped using an isolated simulated adapter; that
save issued no physical commands. Protected configuration and credentials stay
outside the immutable release, with rollback backups.

The editor's **Animationsloop** mode saves 2–16 unique catalog effects and a
15–3600-second interval. The live light panel shows the requested playlist and
last sent step separately from physical confirmation. See the [preset contract](GOVEE-PRESETS.md).

## Lifecycle and software evidence

The engine owns a timer per target. A new interval starts after delivery, with
no piled-up writes. Each step publishes a fresh control ID and sends only the
effect/mask through the common cancel/drain queue; it does not repeat the ordinary
power/brightness baseline. Mode-only steps require fresh native/cloud ON and
never issue global ON. OFF/unknown power, delivery failure, manual control,
external takeover, confirmed exit and disposal invalidate pending work. Normal
entry permission can resume saved intent; reconnect alone cannot start it.

`npm run check` passed **126 suites / 2052 tests**, including both installer
fixtures, and `npm run build` passed. Independent review of the rotation changes
found no blocker or should-fix; the lead reviewed the small settling follow-up
and verified its old/new regression. Focused tests cover wraparound, intervals after delivery, in-flight
cancellation, white/OFF takeover, exit/return, omitted-target partial scenes,
restart dormancy, unknown capabilities, persistence/CAS and editor validation.
An actual socket client/server test verifies engine rotation and white/OFF
barriers against fake device writes. These are software tests, not optical tests.

## Live observations and remaining limits

The first saved Party activation reported successful delivery for all five Govee
targets. LED 2 then changed to static 4000 K and remained in that requested mode
for 33 seconds. An independent native read reported ON, 4000 K and 34% after the
35% HA request, reflecting the existing brightness quantization.

The first subsequent OFF was confirmed, but the fixture reported ON about
14 seconds later. The loop and its control ID were already cleared; no new Lugn
lighting command or rotation step was recorded before that ON. The event was
before the next 30-second step. Its source remains unproven and is retained as
an anomaly rather than silently excluded.

Follow-up controls:

- A second OFF remained OFF through 19 independent native reads over 37 seconds.
- An isolated Rainbow B selection followed by OFF remained OFF through 20 native
  reads over 39 seconds. HA event logging showed only the requested OFF.
- A separate GU10 cloud Party command left LED 2 OFF through 17 native reads over
  33 seconds; that test did not reproduce cross-fixture activation.

A repeat on the initial rotation release failed its first cold activation with
a sanitized 502 delivery error. The device stayed OFF after compensation. A
separate native-only probe measured OFF at 102 ms and ON at 411 ms after a single
ON send. This exposes an early-read verification weakness: three immediately
answered reads with only 80 ms between them can finish before the device settles.
The follow-up waits 200 ms before each of three reads, still sends ON only once,
and rechecks permission after every wait. Warm/mode-only writes add no such delay.
The deterministic 410 ms regression test failed under the old timing and passes
under the new timing; cancellation during settling is also covered. The generic
502's exact internal cause and the earlier delayed ON remain unproven; this
timing repair is not presented as proof of their cause.

The follow-up completed a cold Party activation, 33 seconds of static 4000 K,
another Party activation, and 33 seconds of manual OFF without the loop taking
control back. The ceiling was switched to static 4000 K and the table via static
RGB to 3000 K, then all five Govee targets returned to accepted Party delivery.
The full requested sequence completed as sent transport steps:
Rainbow B → Meteor shower → Aurora → Colorful → Forest → Party → Rainbow B.
The live proof verified fresh step IDs, saved order, successful delivery and no
new ordinary LED 2 lighting commands during rotation. The proof process exited;
at that handback Party was left active with no external selector leases. Both
services remained active with zero automatic restarts. The later room-OFF
request below supersedes that temporary active state.

Bruno is away and cannot observe these animations. Prior ring-only/both-zone
visual confirmations still apply, but visible animation fidelity on the ceiling
and table remains unconfirmed. Delivery, device-reported state and requested
`activeEffect` are distinct evidence. No Bluetooth transport is used.

Private raw evidence is retained under
`/home/bruno/.cache/kuffe-agent/govee-performance/`, including the original
anomaly, isolated controls, complete proof, service/manifest checks and test logs.
Earlier comparative timings remain in [Govee performance](GOVEE-PERFORMANCE.md).

## Follow-up: room left OFF

Bruno subsequently requested that the room be left dark after testing. Two more
LED 2 steps, Aurora → Colorful → Forest, delivered in saved order without new
ordinary LED 2 lighting commands. Lugn then selected `scene.all_off`.

All nine configured room lights remained observed and desired OFF for 45 seconds,
past the next possible 30-second rotation tick. No Govee intent/control ID or
external selector lease remained active. Separate HA entity reads reported all
nine OFF, and direct native LAN reads confirmed both strips, the table lamp and
the ceiling OFF. The saved Party definition and playlist remain available for
later explicit activation; the final room state is Allt av.

The private follow-up evidence is `room-off-proof.json` and
`room-off-native.json` in the artifact directory above.

## Follow-up: GU10 still blinking in Focus

After returning home, Bruno selected Focus and observed the H600D still flashing
RGB. Lugn and its Matter entity both reported ON, 100%, 4000 K, with no Govee
animation intent or external lease. A direct, guarded Govee API temperature
command at 4000 K stopped the effect; Bruno confirmed steady white.

Runtime `92c0b0c86256db726524eaa8f05e33437c5d3cc0`, merged/pushed to main and
installed at `/home/bruno/lugn-govee-92c0b0c86256`, adds that color-mode reset to
ordinary H600D commands. Static preset selection forces the reset even when
Matter already claims all requested values. It works without remembered effect
history, while OFF, exit, new commands and genuine external takeover revoke
queued old resets. Only white/RGB is sent through the official API; ordinary OFF
remains local. See the [static-color contract](GOVEE-PRESETS.md#h600d-static-color-after-an-app-effect).

The version passes 127 suites / 2061 tests, lint, formatting, TypeScript, both
installer fixtures and build. Real socket tests model the Matter/vendor mismatch
and cover OFF/exit/manual RGB preemption; the cached-white regression fails
without the explicit reset. Independent review found an external-takeover race,
which was repaired and regression tested before deployment.

Focus was reapplied in production with the requested values unchanged and no
animation intent. An unchanged Matter value may produce no fresh state event;
the ordinary lighting ledger can remain unconfirmed despite accepted vendor
delivery. This is not relabelled as fresh hardware confirmation. The user's
visual confirmation applies to the direct 4000 K reset. Focus remains selected;
the earlier request to leave the empty room OFF no longer describes this later
occupied-room session.

## Follow-up: outward-facing animation during absence

Runtime `8840c447afd19c902530c22e5631729abb89718c` extends the existing window
policy to Govee app effects and rotations. The live window target is H612A /
`lighting.govee_strip_1`: this is the strip actually ON in Vardagsljus when Bruno
reported that his “LED 2 ute” was lit. Earlier LED 2 labels in this document refer
to the separate H612F loop; the production window target was not moved.

The window keeps its configured 55% brightness, `always` presence mode and sun
threshold of 6 degrees. All presets use that policy, including effects, while
Allt av, sleep and manual OFF retain priority. Other room fixtures still switch
OFF on confirmed exit. Window animation also survives room continuity expiry;
restart restores only the permitted window mode before room entry.

The saved Party definition now has 15-second intervals on both strips:

- H612A window: Rainbow · B → Meteor shower → Aurora · A → Universe · B →
  Forest → Rainbow · A → repeat.
- H612F: Rainbow B → Meteor shower → Aurora → Colorful → Forest → Party → repeat.

Other Party modes/baselines and all six other saved presets are preserved.
The change passed `npm run check` (127 suites / 2071 tests, both installer
fixtures), build and independent read-only review. A strengthened exit test
also proves a previously lit ordinary lamp turns OFF while the window continues.
Dawn, pending-step cancellation, home/room restrictions, continuity expiry,
daylight restart and default room entry have deterministic coverage.

Both services run `/home/bruno/lugn-govee-8840c447afd1`. All 367 installed
source/build hashes match the qualified build; archive SHA-256:
`f99ded17807c0b71cd63e139dcd355222f888604dacc0bc716530c1f930ceee7`.
A live Party activation accepted all five Govee modes. A real main-service
restart then replayed actual `confirmed_empty` / home `away` state: only the
window remained ON, and its complete six-effect sequence plus wrap delivered
with fresh control IDs and no repeated ordinary lighting commands. The other
eight room lamps stayed OFF. This verifies transport and reported power;
Bruno was away, so this is not a new visual confirmation of animation fidelity.

The final explicit `scene.all_off` then held all nine configured lights OFF for
45 seconds with no effect/control ID or external lease. Individual HA reads
reported all nine OFF; independent native discovery/status reads confirmed
H612A, H612F, H6022 and H60A6 OFF. Both services remained active with zero
automatic restarts. The final room state is Allt av, as Bruno requested after
leaving home again. Private evidence: `window-live-proof.log`,
`window-effects-live-proof.json`, `window-final-native-off.json` and
`active-lugn-manifest-8840c447afd1.json` in the artifact directory above.

## Follow-up: ceiling main light flash and ring white

Bruno reported that ring-only modes often lit the large ceiling main light
first, then left only the ring, and that the ring did not follow the white
temperature. The ordinary HA/Matter ON reached the H60A6 before the cloud mask,
so a restored main light stayed visible for one or more cloud round trips.

Commit `64c02b9` stages a main-only/ring-only mask disable-first while the
fixture reports OFF, before the HA baseline. The final mask then also disables
first. The platform ceiling is opted into `staticColor`, so zones-only white
presets send their Kelvin through the API before the toggles; effects keep their
own colors. See the [preset contract](GOVEE-PRESETS.md).

`npm run check` passed **127 suites / 2079 tests**, and `npm run build` passed.
This machine lacks `rg`, which the Govee installer fixture requires; that
fixture passed with an `rg -c` shim. The release is installed at
`/home/bruno/lugn-govee-64c02b9` from an archive with SHA-256
`d8c4c73fa9b9ebdd6912d66877a1c2694374703e99e05c808418e13d5d0c4734`. The only
protected-configuration change adds `"staticColor": true` to the platform
ceiling, with backups in `deploy-backups/govee-64c02b9`. Both services are
active with zero restarts. The companion reports ceiling zones, LAN effects and
static white.

Bruno chose not to observe an attended test. Software evidence covers only
ordering and payloads. Whether the H60A6 keeps a dark-staged mask through
Matter ON, and whether API Kelvin reaches the ring, remain unobserved.

### Second iteration: native ON wait, zone restore and Vardagsljus ring

Bruno then reported that the main light still flashed when the ring turned
on, and that Focus left the main light dark after a ring-only preset. His test
log showed staging ran from a confirmed OFF. A live probe from Matter OFF (main
OFF, then ring ON through the API) saw HA report ON about 1.6 s after the API
accepted the request. Thus a cloud toggle powers the dark fixture, but its
acceptance precedes delivery; the following local Matter ON could arrive
first. The Focus result shows that the fixture keeps its zone mask through
Matter OFF/ON.

Commit `c4d8baa` waits up to 4 s for that native ON report before the
baseline. After a partial mask, the next ordinary white reset also enables both
zones, as does the first one after startup or a handoff. At Bruno's request,
Vardagsljus now lights the ceiling ring only at 55 %/2700 K. The other preset
lamps and the six other presets are unchanged, and the offline save issued no
physical commands.

`npm run check` passed **127 suites / 2083 tests**, including both installer
fixtures (the Govee one again with the `rg` shim), and `npm run build` passed.
The archive SHA-256 is
`41dc85676ce512815d969d9f57421af357caf779ea8018a790e1fe7ccc00adb0`; both
services run `/home/bruno/lugn-govee-c4d8baa` with zero restarts. Reapplying
Vardagsljus from OFF reported `sent` with the ceiling ON at 55 %/2702 K.
Whether the main light stayed dark, and the ring color, await Bruno's
observation.

### Third iteration: attended toggle-order series

Bruno then reported that the ring lit alone, then the whole fixture lit, then
the main light switched off. The API white now appeared to steer the ring.
An attended probe series under an explicit external handoff isolated the
trigger.

| Step | Sequence from Matter OFF unless noted                                     | Observed by Bruno |
| ---- | ------------------------------------------------------------------------- | ----------------- |
| 1    | API main OFF, ring ON → native ON → immediate Matter 55 %/2700 K          | ring, then whole  |
| 2    | Lit fixture: API main OFF → 6 s → Matter 40 %/3000 K                      | ring only         |
| 3    | As 1, 2 s wait, Matter, then API 2700 K                                   | main lit          |
| 4    | Lit fixture: API main OFF → 6 s → API 3000 K only                         | ring only         |
| 5    | As 3 with a 6 s wait                                                      | main lit          |
| 6    | As 1, then API main OFF once lit → 1.5 s → Matter → API 2700 K            | ring only         |
| 7    | As 6, but with ring ON after each main OFF, plus a final main OFF/ring ON | flash             |

A zone OFF is ignored while dark, and a ring ON while lit relights the main
light. Commits `5a42c45` (repeat once lit) and `df32766` (OFF last) both still
flashed through Lugn. Commit `ae193a9` repeats only the unwanted OFF after
native ON and sends no later toggle. For a lit fixture it sends only the
changed toggles based on the mask Lugn last delivered. It matches step 6, the
only sequence Bruno saw without a flash.

`npm run check` passed **127 suites / 2085 tests** (the Govee installer fixture
again with the `rg` shim), and `npm run build` passed. Both services run
`/home/bruno/lugn-govee-ae193a9` (archive SHA-256
`7033cc6123c45e2ec832ace40a3e332d77b0d04150f99332496432c600c999ed`) with zero
restarts. A Lugn activation of Vardagsljus from OFF reported `sent` with the
ceiling ON at 55 %/2702 K. Bruno was not in the room and did not observe it.
The `ae193a9` sequence through Lugn, effect presets with a ring-only mask, and
Focus after a ring preset remain visually unverified.

### Fourth iteration: dim power-up and parallel zone restore

The next morning Bruno reported that the whole fixture still flashed when the
ring came on from OFF. He also reported that the main light was slow to return
when going from Vardagsljus to Focus. Lugn's ledger showed the flash case was
Focus → OFF → Vardagsljus 1.3 s later. The fixture lights with its stored
mask, so it came back with the main light at Focus brightness until the cloud
main OFF arrived. In step 6 of the attended series the stored mask was
presumably already ring-only.

Commit `80a06c1` skips staging when Lugn's last delivered mask already matches.
Otherwise it lights the fixture at 1 % through HA and masks it once natively
ON. The Focus restore toggles are sent alongside the HA baseline, and the
static white follows the toggles.

`npm run check` passed **127 suites / 2088 tests** (the Govee installer fixture
again with the `rg` shim), and `npm run build` passed. Both services run
`/home/bruno/lugn-govee-80a06c1` (archive SHA-256
`5ade9d102187f1bfaf586ed38126ee1d41844c012eac8e270a50c59f4b090d6b`) with zero
restarts. The restart cleared the in-memory mask, so the first ring-only ON
from OFF uses the dim path. No physical test was run, and Bruno's observation
is pending.

### Fifth iteration: cloud ring ON into the stored mask

Bruno then reported a whole-fixture flash every time the ring came on from OFF,
while the end state was reliable. The ledger showed only one such transition
after `80a06c1`: Vardagsljus (lit) → OFF → Vardagsljus at 11:59:42. It took the
matching-stored-mask path, which sent a Matter ON, then the safety main OFF and
the API white. In attended steps 4 and 6, an API white never relit the main
light. The Matter ON from dark is therefore the likely trigger, which also fits
the "ring, then whole" result of step 1.

The next commit powers a matching stored mask with the ring's cloud ON. This
is step 6 without the ignored dark OFF. At Bruno's suggestion, an unchanged
static white is also skipped.

`npm run check` passed **127 suites / 2089 tests** (the Govee installer fixture
again with the `rg` shim), and `npm run build` passed. Both services run
`/home/bruno/lugn-govee-6d50dbf` (archive SHA-256
`14b45a1b6eec26b6e599701aef240f40d3f18552defd9439fd01dbd8526c1f7e`) with zero
restarts. The restart cleared the in-memory mask and white again, so the first
ring-only ON from OFF uses the 1 % path. No physical test was run, and Bruno's
observation is pending.

### Sixth iteration: always light dimly

With `6d50dbf`, Bruno saw the ring light first, then the whole fixture, and
then the main light switch off. The ledger shows Vardagsljus from OFF at
12:15:51 on the cloud ring ON path, with HA ON at 12:15:52.2. Nothing else was
sent before the main OFF. The fixture itself therefore relights the main light
after a cloud ring ON from dark, and a ring-only stored mask does not help. The
next commit always lights the fixture at 1 % through HA, then sends the main
OFF once natively ON, so the unavoidable main light is barely visible.

`npm run check` passed **127 suites / 2089 tests** (the Govee installer fixture
again with the `rg` shim), and `npm run build` passed. Both services run
`/home/bruno/lugn-govee-221c985` (archive SHA-256
`c41c8226d26353e1c2e24e98a27dcf53f5e809c9185c6361d1ec75d50f36e70f`) with zero
restarts. No physical test was run, and Bruno's observation is pending.
