# Govee Party and LED 2 rotation — 14 November 2026

Runtime source `f5d50fde807a1be872a813f3c194f00b099a433d` is merged into `main`,
pushed and installed at `/home/bruno/lugn-govee-f5d50fde807a` on BrunoCAM. Both
user services use that release. All 367 installed source/build hashes match the
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
