# Govee performance and preset qualification — 14 November 2026

## Installed result

Runtime source `317e10471c4ea74cc11d8f82cdeba8a149a16060` is installed at
`/home/bruno/lugn-govee-317e10471c4e`. Both user services use this immutable
release. It includes the independently implemented preset engine/editor/socket
client and preserves the concurrently deployed reviewed Lugn fixes from
`f803c5b6cd750b63af8e99f0266100640c37625d`. Protected configuration, credentials,
lighting intent and scene definitions remain outside the release.

The package SHA-256 is
`4e375e3f5438a0504435c3983af901550410fd227a96404aa0b09125430e1500`.
The optional preset socket is private, mode 0600, in the companion's private
state directory. There is no new network HTTP listener or Bluetooth transport.

Three presets are saved alongside the original presets:

- **Govee · Takring:** ceiling at 20%, 3000 K, ring ON/main OFF.
- **Govee · Takljus och ring:** ceiling at 60%, 4000 K, both zones ON.
- **Govee · Rörligt:** Aurora variants on the ceiling, both strips and table;
  ceiling main OFF/ring ON, at modest brightness.

The editor exposes exact catalog labels, compatible zone masks, RGB and model
Kelvin limits. The H600D also supports preset effects through the official API;
its ordinary desk control is still available. Existing window-light policy is
preserved and intentionally follows explicit scene changes even when omitted
from a partial scene.

## What changed

Matching LAN discovery replies resolve immediately instead of waiting for a fixed
1.2-second scan. Overlapping discovery is shared and identity refresh runs in the
background. Status requests remain distinct, validated and serialized per IP;
unreachable peers receive one discovery/status retry, never a blind scene retry.
Independent fixtures have separate write queues.

A selector selection grants only its target temporary ownership. With the live,
revocable activation grant, native power is sent only when fresh status says OFF,
and ON must be observed before uploading the effect. A corroborated, same-command
ON snapshot may be reused for less than 500 ms; manual/exit generation guards
still run before every physical write. Noncritical follow-up status reads are
debounced by 750 ms so they do not queue in front of the next effect.

Preset effects and ordinary color/OFF share per-target cancel/drain barriers.
Old queued work cannot follow a newer static command. Every delayed physical
step rechecks the current engine generation and illumination permission. The
ceiling mask enables requested zones before disabling unwanted ones, after all
baseline/effect writes. This avoids a transient whole-fixture OFF that would be
correctly interpreted as a human OFF. API acceptance cannot make a cloud sequence
atomic or retract work already accepted by the device.

Delivery state distinguishes UDP sent, cloud accepted, failure and requested
intent. Native fixture status has its original observation timestamp and is
separate from scene status. Empty cloud zone/scene feedback stays unknown.

## Matched effect delivery benchmark

Six alternating Forest/Aurora selections per fixture, from the same BrunoCAM
host and exclusive selector use. Timing starts at MQTT command publication and
ends at a fresh matching companion delivery diagnostic. This includes handoff,
guards and transport work; it **does not measure visible animation start**.

Baseline: main `f803c5b6…`, companion `f79b9d3f…`. Final: both services `317e1047…`.
The first setup-only run overlapped the other thread's restart and is excluded.
The original GU10 diagnostic lacked a requested label, so its first six harness
correlation failures are excluded and replaced by the explicitly recorded,
exclusive-use GU10 rerun. The real H612F delivery error remains in the baseline.

| Fixture       | Successful before → after | Median ms before → after | p95 ms before → after |
| ------------- | ------------------------: | -----------------------: | --------------------: |
| H612A strip   |                 6/6 → 6/6 |                384 → 287 |            1352 → 616 |
| H612F strip   |                 5/6 → 6/6 |                330 → 311 |             464 → 443 |
| H6022 table   |                 6/6 → 6/6 |                131 → 178 |             319 → 201 |
| H60A6 ceiling |                 6/6 → 6/6 |                237 → 190 |             544 → 293 |
| H600D GU10    |                 6/6 → 6/6 |                499 → 494 |            866 → 1029 |

Final delivery was **30/30**, compared with **29/30** valid baseline selections.
This short series cannot establish a long-term reliability rate or statistical
significance. H612A, H612F and ceiling medians improved. The table's median rose
while its slowest result improved. GU10 median was almost unchanged and its
slowest result worsened. No claim that every command or lamp became faster.
With six samples, nearest-rank p95 is the sample maximum.

The first optimized deployment (`99620e47…`) also delivered 30/30, but additional
status reads worsened the strips/table medians. That complete artifact is retained
as `effects-after-initial.json`; the final read deduplication directly addresses
that measured regression. No samples from an unsuccessful run were silently
removed from a summary.

## Comparable static command benchmark

3000/4000 K alternation, 12 trials per method. All methods start from a verified
ON condition outside timing. Each trial chooses a value different from its
pre-read. LAN fixtures use the same independent UDP `devStatus` readback for
**every** control method, allowing 50 K for mired rounding. ACK is a send callback
or service/API response, not proof of a physical change.

The 120 ms polling interval contributes quantization: matching native status is
an upper bound on observing firmware-reported state, not an optical LED timestamp.
H600D results use HA software feedback instead and are not pooled with native
fixture readbacks. Brightness 10/11% exploratory runs exposed differing integer
rounding; those are retained separately and not used for the CCT comparison.

| Fixture       | Method       | Matching feedback | Median ACK ms | Median feedback ms | p95 feedback ms |
| ------------- | ------------ | ----------------: | ------------: | -----------------: | --------------: |
| H612A strip   | LAN          |             12/12 |             1 |                294 |             437 |
| H612A strip   | HA REST      |             12/12 |            29 |                364 |             410 |
| H612A strip   | HA WebSocket |             12/12 |            23 |                234 |             394 |
| H612A strip   | Govee API    |             12/12 |           189 |                838 |            1178 |
| H6022 table   | LAN          |             12/12 |             1 |                336 |             410 |
| H6022 table   | HA REST      |             12/12 |            19 |                338 |             366 |
| H6022 table   | HA WebSocket |             12/12 |            19 |                352 |             372 |
| H6022 table   | Govee API    |             12/12 |           186 |               1313 |            2489 |
| H60A6 ceiling | LAN          |             12/12 |             1 |                 27 |             127 |
| H60A6 ceiling | HA REST      |             12/12 |           186 |                198 |             231 |
| H60A6 ceiling | HA WebSocket |             12/12 |           180 |                193 |             242 |
| H60A6 ceiling | Govee API    |             12/12 |           176 |                313 |            1096 |
| H600D GU10    | HA REST      |             12/12 |           155 |                304 |             391 |
| H600D GU10    | HA WebSocket |             10/12 |           136 |                283 |             381 |
| H600D GU10    | Govee API    |              0/12 |           176 |                  — |               — |

H612F's baseline static phase failed its UDP preflight and produced no comparable
static trials. Subsequent exact-identity read-only checks succeeded with both old
and new transports from Kuffe; the original Pi-side failure cause is unproven.
Do not turn this into a measured before/after improvement. A same-host effects
rerun on the final release succeeded 6/6.

The H600D cloud API accepted all 12 CCT requests but HA did not reflect the
requested CCT before timeout. This is a cross-protocol feedback limitation;
it does not establish that the LEDs failed to change. HA WebSocket had 2/12
missing matching updates on this fixture. The report preserves both outcomes.

For H60A6, direct LAN CCT feedback was much faster than HA/Matter in this series.
The existing preset contract still uses the ordinary HA adapter for baseline
values and ledger feedback, then direct LAN for effects and the official API for
zone masks. The independent LAN benchmark is not a claim that all ordinary
Lugn static commands now bypass HA.

## Color temperature and ceiling limits

The model/API capability range is **2700–6500 K**. The preset client/editor clamp
per model, including synchronized temperature updates, rather than trusting an
incorrect Matter minimum. A requested 3000 K produced 3003 K in live ceiling
feedback, consistent with mired quantization. No colorimeter measurement or
physical color-temperature calibration was performed.

This H60A6 advertises separate main/ring toggles, without separate zone RGB or
brightness. Pure offline inspection found native zone frames, but LAN replay
from verified OFF did not activate them. Read-only native zone queries yielded
no usable response. Therefore zone control remains on the supported official
API; no Bluetooth fallback is used. Fixture scenes plus a final mask are
supported, not independent simultaneous animations/colors for each zone.

## Validation and evidence boundaries

`npm run check` passes **125 suites / 2008 tests**, formatting, lint, TypeScript
and both service-installer fixtures. `npm run build` passes. Independent reviews
covered shared cancellation/ownership and the final read/mask delta. The actual
engine → socket client → gateway → fake-device test covers effect/white/effect
and in-flight exit OFF. This is software integration evidence, not hardware
animation evidence.

An actual saved Takring activation traversed the production engine, private
socket and API; it reported `sent`, observed ceiling ON at 20%/3003 K and kept
its live generation. Bruno confirmed **only the ring** was lit. The next saved
Takljus och ring activation reported 60%/4000 K and Bruno confirmed **both parts**
were lit. Thus both saved presets have actual engine-to-device and user visual
evidence, including the ring-to-both transition. The moving preset is being
checked separately. Earlier H612F segment movement and the independent ceiling
API demonstration remain additional visual evidence. Exact scene fidelity is not
inferred from packet/API acceptance.

Benchmark cleanup restores settings while its expected lease is still owned,
then releases only that generation. A confirmed exit prevents further positive
writes. Matter OFF may normalize the stored ceiling brightness to 1%; restoration
markers do not claim to prevent firmware normalization. Protected originals are
backed up. The scene store's existing default normalization fills previously
absent 2700 K fields when saving new presets; original scene semantics and IDs
are preserved.

Raw measurement artifacts are private under
`/home/bruno/.cache/kuffe-agent/govee-performance/`; they include all failures and
separate the exploratory brightness runs, matched effect runs and static CCT
series. No credentials are included in this report. See [benchmark procedure](../bench/GOVEE.md)
and [preset contract](GOVEE-PRESETS.md).
