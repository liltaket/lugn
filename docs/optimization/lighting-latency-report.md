# Lighting latency: MQTT event to Home Assistant command

Branch `opt/lighting-latency` (T1, offline work 2026-11-09). Nothing was
deployed, restarted or sent to real lamps. Live systems were only read
(configuration, entity states, HA history/logbook, one `/state` GET, pings and
short `nice`-ed CPU microbenchmarks).

## Summary

- **Real evidence (measured, read-only HA logbook, 10 days):** after the room
  became empty, the first lamp switched off a median **1.5 s** (P95 2.1 s) after
  HA saw `person_count` reach 0, and the lamps' off times spread over 0.65 s.
  Entry via preview lit the first lamp ~0.32 s after HA saw the outer beam.
- **Diagnosis (simulated, calibrated):** Lugn runs on a Raspberry Pi 3B. The
  calibrated simulator attributes almost all of that delay to Lugn's own
  synchronous CPU work before any HA request reached the network: each dispatch published a state update that
  deep-cloned the command ledger once per stream listener, and the UI SSE
  serialization ran before REST requests were written. With a CPU scale of 12
  the simulator reproduces the real per-lamp exit medians within ±8 % and the
  entry medians of three of five lamps within ±11 %.
- **Changes kept (commits on this branch):** presence fast path dispatches every
  lamp before publishing; one lazily-cloned state update for all listeners;
  light services as `call_service` on the already authenticated HA WebSocket
  (REST fallback); and a bounded retry for an off that fails while the room
  must stay dark (a pre-existing gap that left lamps lit in an empty room).
- **Result (simulated, Pi 3B scale 12, training workloads, all fast-path
  events):** decision → first HA command P50/P95/P99
  **1104/1750/2431 ms → 1.4/6.8/461 ms**; arrival → first lamp (modeled)
  **1255/2023/2862 ms → 51/456/1747 ms**; HA service calls −7 %, no-op lamp
  commands −32 %. On held-out workloads with unseen latency profiles and fault
  mixes the pattern holds, and settled checkpoints with a lamp lit in an
  empty room fall from 1 to 0 (of 200). These are simulator results, not a
  guarantee of live latency.
- **Placement:** see [Placement: brunocam or putte](#placement-brunocam-or-putte).

## Evidence classes

Kept strictly apart throughout this report:

| class                      | what                                                                                            | where                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| measured (live, read-only) | HA logbook/history timestamps, live config, pings, CPU microbenchmark, one live `/state` timing | sections "Real evidence", "Placement" |
| automated tests            | vitest regression tests (deterministic, FakeClock)                                              | "Correctness"                         |
| simulation                 | production engine and adapters against simulated MQTT/HA (`bench/lighting-sim`)                 | "Results", "Experiments"              |
| model / estimate           | latency distributions per integration, CPU scale factors, physical lamp response                | marked "modeled"                      |

No hardware, robot or field test was performed. Physical lamp response is
never observed; it is a modeled quantity.

## Real evidence

Read-only HA 2026.10.3 history and logbook for the nine mapped lights and the
doorway sensors (`sensor.bruno_doorway_lidar_bruno_door_counter_person_count`,
`binary_sensor..._outer_beam_blocked`), 10 days to 2026-11-09, same HA clock
for sensor and lamp state. Lugn's commands are identified by their HA user
context. HA records state _reports_; for `govee_light_local` and Yeelight
those follow the service call closely, for Tuya (Cleverio) they come from the
cloud.

| measured on HA's clock                              |   n |     P50 |     P95 |     P99 |
| --------------------------------------------------- | --: | ------: | ------: | ------: |
| `person_count` → 0, first lamp off                  |  82 | 1503 ms | 2131 ms | 2521 ms |
| off spread across lamps in one exit                 |  82 |  653 ms |  783 ms |  834 ms |
| first `outer_beam_blocked`, first lamp on (entries) |  79 |  322 ms | 3444 ms | 7328 ms |

Per lamp (P50, ms) after count → 0: H6022 1503, H612F 1553, Yeelight 1647,
H600D 1686, Cleverio 2108. After beam blocked: H6022 322, H612F 339, Yeelight
372, H600D 562, Cleverio 1013.

Live context (read 2026-11-09): Lugn on BrunoCAM, Raspberry Pi 3B, 905 MB RAM,
Node 22, Wi-Fi only (`wlan0`); `doorway-intelligence` uses ~92 % of one core
on the same Pi; `vcgencmd get_throttled` = `0x60000` (frequency capping and
throttling have occurred since boot); Lugn RSS 140 MB. HA and the MQTT broker
run on 192.168.10.40 (Raspberry Pi MAC prefix). The live default scene is the
saved `scene.everyday_light` preset, so prelight lights six lamps
(Cleverio, H6022, H612F, Yeelight front, H600D, WLED), not only
`prelight.targets`.

One live fast-path timing was available after T2's restart (`presence-1`,
cold start): callback → decision 23 ms, → first dispatch 49 ms (n = 1, not
used statistically).

## Simulator and method

`bench/lighting-sim/` (see `bench/README.md`) runs the production
`LugnEngine`, `Stl27lMqttPresenceAdapter`, `PresenceEventIngress`,
`HomeAssistantLightingAdapter`, `WledCctController` and
`HomeAssistantWebSocketTransport` unmodified. Substituted are only the MQTT
subscriber (in-process FIFO broker with delivery delay, retained messages,
reordering, disconnects), `fetch` and the WebSocket factory (mock HA: REST
services with an undici-like keep-alive pool and cold connects, the WebSocket
API with auth, `state_changed` and `call_service`, a serialized HA event loop,
per-integration latency and faults, manual changes, dropped/delayed/stale
feedback, socket drops, a WLED JSON endpoint), plus the clock.

`SimClock` advances by the time Lugn's thread really runs plus skipped idle
time. It follows wall time for resolution but never runs more than 2 ms ahead
of main-thread CPU time (`process.threadCpuUsage()`), so the other threads'
benchmarks on the shared, heavily loaded machine (load 35–60) do not inflate
results. Measured time is multiplied by `--cpu-scale` to model a slower CPU.
Sensor messages and HA processing follow their own schedules while Lugn is
busy, so time queued behind Lugn's event loop is counted (`ingressQueueMs`).
Two display hubs are emulated as in `DisplayServer` (full-state SSE on
`setImmediate` and a 5 s heartbeat) plus four passive listeners.

Segments: **ingress queue** (MQTT arrival at Lugn's host → callback),
**event → decision** (engine instrumentation), **decision → first/last HA
command on the wire** (first command per lamp; Cleverio's deliberate triple
off and later retries count as calls, not as later "last lamp" sends),
**arrival → modeled physical response** (HA receipt + modeled device time).

### CPU scale (Pi 3B ≈ 12)

Identical microbenchmark (clone and JSON of a Lugn-like state with 256
commands), measured: i7-10700K/Node 26 (harness host) clone 1.8 ms, stringify
0.29 ms; Pi 3B/Node 22 16.7 ms and 6.8 ms (9–23×); putte i5-6600K/Node 22
2.0 ms and 0.86 ms. Lugn's mix is dominated by cloning plus display
serialization, giving ~12 for the Pi. Validation against the real evidence
above (baseline, training workloads):

| per-lamp median, ms (sim scale 12 / real) |       H6022 |       H612F |    Yeelight |       H600D |    Cleverio |
| ----------------------------------------- | ----------: | ----------: | ----------: | ----------: | ----------: |
| count → 0, lamp off                       | 1623 / 1503 | 1629 / 1553 | 1702 / 1647 | 1599 / 1686 | 2253 / 2108 |
| beam/preview, lamp on                     |   299 / 322 |   300 / 339 |   363 / 372 |   304 / 562 |  874 / 1013 |

Scale 1 gives ~150 ms instead of 1.5 s, so the delay is CPU-bound, not
network-bound. H600D's later real entry time (~240 ms after H6022) is not
reproduced: HA-side serialization is not well modeled.

### Workloads

Seeded, reproducible timelines (`generateWorkload`), 100 episodes each, with
2 s sensor heartbeats, gaps of 15–150 s or 21–45 min (beyond the 20 min
continuity window), day and night (quiet hours suppress prelight).

- **Training:** seeds 101 and 102, ordinary mix (entries with and without
  preview, false previews, bounces, second person, preview storms, sensor
  flaps, manual overrides, scene changes, a few WebSocket drops, REST errors,
  reordering, feedback stalls), profile `brunocam-fitted`.
- **Held-out test:** seeds 201 and 202, fault-heavy mix (more storms, bounces,
  WebSocket drops, broker reconnects, REST errors, out-of-order MQTT/HA,
  feedback stalls), with profiles not used while tuning: `unseen-slow-ha`
  (slower HA host, 2–2.5× integration latency, errors and hangs, 20 % Tuya
  feedback loss) and `unseen-wifi-jitter` (heavy-tailed LAN delay).

Latency samples are keyed by (seed, entity, n-th command to that entity), so a
candidate that sends fewer commands does not shift other samples. Remaining
nondeterminism comes from real CPU time; P99 values move by roughly ±15 %
between repeated runs.

### Reproduce

```sh
npm ci
# Current harness against any commits; identical seeded workloads:
bench/run-commits.sh bench/results baseline=3ce45cf best=79adff7 -- \
  --set all --episodes 100 --cpu-scale 12
npx tsc -p tsconfig.bench.json
node dist-bench/bench/compare-results.js --runs=train \
  bench/results/baseline.json bench/results/best.json
# Placement profiles: --profile placement-brunocam --cpu-scale 12
#                     --profile placement-putte    --cpu-scale 2
```

## Results: baseline vs best candidate

Baseline `3ce45cf` (same engine as the live release before T2's prelight
fixes) against `79adff7`, both at Pi 3B scale 12. All numbers are simulated.

#### Training workloads (seeds 101/102, profile brunocam-fitted)

**prelight (preview ON)** (n = 135 / 135 events)

| segment                         | baseline P50 / P95 / P99 ms | best P50 / P95 / P99 ms |
| ------------------------------- | --------------------------: | ----------------------: |
| arrival → MQTT callback (queue) |             0.1 / 0.1 / 1.4 |         0.1 / 0.2 / 0.8 |
| callback → decision             |            1.2 / 2.5 / 13.0 |         1.2 / 2.1 / 4.6 |
| decision → first HA command     |             276 / 377 / 533 |         1.4 / 2.8 / 7.4 |
| decision → last lamp's command  |             284 / 525 / 570 |        84.4 / 333 / 364 |
| arrival → last lamp's command   |             285 / 525 / 571 |        85.9 / 334 / 365 |
| arrival → first lamp (modeled)  |             307 / 421 / 544 |      50.2 / 83.4 / 99.0 |
| arrival → last lamp (modeled)   |           936 / 2664 / 4795 |       708 / 2053 / 2953 |

**entry (occupied)** (n = 276 / 253 events)

| segment                         | baseline P50 / P95 / P99 ms | best P50 / P95 / P99 ms |
| ------------------------------- | --------------------------: | ----------------------: |
| arrival → MQTT callback (queue) |           0.1 / 1566 / 8096 |         0.1 / 5.5 / 165 |
| callback → decision             |           66.4 / 81.9 / 132 |         1.4 / 2.5 / 5.7 |
| decision → first HA command     |          1081 / 1443 / 2533 |         1.8 / 346 / 533 |
| decision → last lamp's command  |          1125 / 2229 / 4291 |       85.0 / 646 / 1289 |
| arrival → last lamp's command   |          1244 / 3562 / 5628 |       86.0 / 648 / 1289 |
| arrival → first lamp (modeled)  |          1247 / 2270 / 3237 |      57.3 / 1491 / 4556 |
| arrival → last lamp (modeled)   |          1873 / 3771 / 6255 |       622 / 1962 / 4722 |

**exit (confirmed_empty)** (n = 212 / 212 events)

| segment                         | baseline P50 / P95 / P99 ms | best P50 / P95 / P99 ms |
| ------------------------------- | --------------------------: | ----------------------: |
| arrival → MQTT callback (queue) |            0.0 / 1.1 / 1545 |        0.1 / 0.2 / 10.6 |
| callback → decision             |           66.7 / 87.2 / 129 |         1.2 / 2.2 / 7.7 |
| decision → first HA command     |          1501 / 1893 / 2457 |        1.2 / 4.3 / 12.1 |
| decision → last lamp's command  |          1520 / 1893 / 2457 |        91.5 / 478 / 556 |
| arrival → last lamp's command   |          1591 / 2247 / 3167 |        93.3 / 479 / 585 |
| arrival → first lamp (modeled)  |          1624 / 2133 / 2862 |       48.6 / 85.7 / 109 |
| arrival → last lamp (modeled)   |          2223 / 3665 / 4066 |       657 / 2320 / 3145 |

Commands:

| metric                                               | baseline |    best |
| ---------------------------------------------------- | -------: | ------: |
| HA service calls                                     |     3666 |    3414 |
| lamp commands                                        |     3197 |    2948 |
| of which no-op in HA                                 |      785 |     536 |
| over REST                                            |     3197 |       6 |
| over WebSocket                                       |        0 |    2942 |
| failed/unanswered calls                              |       31 |       6 |
| settled checkpoints with a lamp lit in an empty room |  0 / 200 | 0 / 200 |

#### Held-out workloads (seeds 201/202, unseen profiles unseen-slow-ha / unseen-wifi-jitter, fault-heavy mix)

**prelight (preview ON)** (n = 141 / 141 events)

| segment                         | baseline P50 / P95 / P99 ms | best P50 / P95 / P99 ms |
| ------------------------------- | --------------------------: | ----------------------: |
| arrival → MQTT callback (queue) |             0.1 / 0.1 / 1.0 |         0.1 / 0.2 / 0.9 |
| callback → decision             |             1.0 / 1.6 / 3.2 |         1.1 / 1.7 / 2.5 |
| decision → first HA command     |             250 / 419 / 587 |         1.2 / 2.5 / 5.4 |
| decision → last lamp's command  |            313 / 795 / 1324 |         102 / 346 / 564 |
| arrival → last lamp's command   |            315 / 796 / 1324 |         104 / 346 / 564 |
| arrival → first lamp (modeled)  |             311 / 532 / 653 |        89.1 / 161 / 199 |
| arrival → last lamp (modeled)   |          1393 / 3169 / 4451 |       941 / 2560 / 3420 |

**entry (occupied)** (n = 258 / 244 events)

| segment                         | baseline P50 / P95 / P99 ms | best P50 / P95 / P99 ms |
| ------------------------------- | --------------------------: | ----------------------: |
| arrival → MQTT callback (queue) |           0.1 / 1157 / 6843 |        0.1 / 25.1 / 409 |
| callback → decision             |           60.0 / 73.6 / 121 |         1.3 / 2.2 / 4.8 |
| decision → first HA command     |           818 / 1285 / 2082 |         1.7 / 385 / 654 |
| decision → last lamp's command  |           981 / 2217 / 3250 |       87.0 / 749 / 1309 |
| arrival → last lamp's command   |          1153 / 2959 / 4572 |       90.5 / 990 / 1311 |
| arrival → first lamp (modeled)  |          1080 / 2256 / 3712 |       117 / 1374 / 3275 |
| arrival → last lamp (modeled)   |          1967 / 4335 / 5986 |       862 / 2709 / 4191 |

**exit (confirmed_empty)** (n = 212 / 212 events)

| segment                         | baseline P50 / P95 / P99 ms | best P50 / P95 / P99 ms |
| ------------------------------- | --------------------------: | ----------------------: |
| arrival → MQTT callback (queue) |             0.1 / 0.2 / 491 |        0.1 / 0.2 / 78.0 |
| callback → decision             |           61.2 / 80.1 / 115 |         1.3 / 1.9 / 5.1 |
| decision → first HA command     |          1333 / 1961 / 2464 |        1.3 / 3.6 / 11.2 |
| decision → last lamp's command  |          1450 / 2235 / 2584 |         101 / 488 / 577 |
| arrival → last lamp's command   |          1513 / 2418 / 3187 |         110 / 489 / 579 |
| arrival → first lamp (modeled)  |          1443 / 2204 / 2778 |        84.2 / 165 / 228 |
| arrival → last lamp (modeled)   |          2377 / 4304 / 4958 |       907 / 3294 / 5751 |

Commands:

| metric                                               | baseline |    best |
| ---------------------------------------------------- | -------: | ------: |
| HA service calls                                     |     3809 |    3608 |
| lamp commands                                        |     3342 |    3146 |
| of which no-op in HA                                 |      929 |     737 |
| over REST                                            |     3342 |      17 |
| over WebSocket                                       |        0 |    3129 |
| failed/unanswered calls                              |       92 |      56 |
| settled checkpoints with a lamp lit in an empty room |  1 / 200 | 0 / 200 |

Notes on reading the tables:

- _Decision → first HA command_ is the pure software path and falls from
  about a second to ~1.4 ms.
- _Last lamp's command_ is dominated by WLED, whose adapter deliberately
  reads state before every write (two HTTP round trips), and on entry by the
  prelight → occupancy handoff re-send after its grace period.
- _Last lamp (modeled)_ is dominated by the Tuya cloud Cleverio and is mostly
  outside Lugn's control.
- Entry P95 for decision → first command (~300–370 ms) is the handoff
  re-send of lamps whose prelight feedback is still missing; it is T2's
  prelight semantics and was not changed.

## Experiments (hill climbing)

All variants with the same harness and workloads (training and test pooled,
Pi scale 12). Each kept change was verified against the full test suite.

| variant                              | decision → first command | arrival → last lamp's command | arrival → first lamp (modeled) |    ingress queue | HA calls | lit in empty room |
| ------------------------------------ | -----------------------: | ----------------------------: | -----------------------------: | ---------------: | -------: | ----------------: |
| baseline (3ce45cf)                   |        967 / 1720 / 2426 |            1242 / 2289 / 4099 |             1179 / 2017 / 2862 | 0.1 / 798 / 6003 |     7475 |           1 / 400 |
| C1 batching (239c706)                |         273 / 488 / 1362 |             315 / 1563 / 3125 |              329 / 1343 / 2733 | 0.1 / 731 / 6048 |     7426 |           0 / 400 |
| C1b shared clone (3daabf5)           |          125 / 216 / 583 |              144 / 521 / 1503 |               168 / 645 / 2208 |  0.1 / 8.7 / 238 |     7078 |           0 / 400 |
| C2 WebSocket (10d77c8)               |         1.4 / 11.1 / 411 |              129 / 840 / 1175 |              67.8 / 444 / 1504 |  0.1 / 6.9 / 279 |     7026 |           1 / 400 |
| C4 lazy patch (4494169)              |         1.4 / 11.7 / 537 |             95.1 / 567 / 1123 |              68.2 / 515 / 1764 | 0.1 / 0.8 / 90.9 |     7019 |           1 / 400 |
| C4 over REST (ablation)              |         95.1 / 164 / 489 |              111 / 410 / 1080 |               136 / 527 / 1605 |  0.1 / 0.3 / 122 |     7060 |           0 / 400 |
| C4 + grouping (rejected)             |        29.1 / 79.9 / 559 |              92.1 / 440 / 731 |               105 / 608 / 1545 |  0.1 / 0.3 / 126 |     5092 |           1 / 400 |
| best: C4 + dark-room retry (79adff7) |          1.4 / 8.3 / 509 |             92.0 / 530 / 1013 |              67.9 / 488 / 1694 |  0.1 / 0.4 / 148 |     7022 |           0 / 400 |

| #   | experiment                                                                                                                      | outcome                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | instrumentation and simulator                                                                                                   | profiling: 72 % of CPU in `structuredClone` from `StateEventStream.publish` (one deep clone per listener per publication), called inside every dispatch                                                    |
| 1   | batch publications in `reconcileScene`                                                                                          | **rejected**: breaks the documented veto where a subscriber reacting to a command publication can cancel it before transport (`routines.test.ts`); scene/routine paths keep that point                     |
| 1'  | batch the synchronous prefix of `handlePresence` (as prelight already did); batched `publish()` defers bookkeeping to the flush | **kept** (`239c706`)                                                                                                                                                                                       |
| 2   | one clone shared by all stream listeners                                                                                        | **kept** (`3daabf5`)                                                                                                                                                                                       |
| 3   | light services over the HA WebSocket, REST fallback                                                                             | **kept** (`10d77c8`): frames are written synchronously, so they leave before the publication flush; no per-light REST request or cold TCP connect                                                          |
| 4   | clone the delivered patch only when a listener reads it                                                                         | **kept** (`4494169`)                                                                                                                                                                                       |
| 5   | group identical same-tick commands into one `call_service` with an entity list                                                  | **rejected**: −28 % HA calls but the grouped frame can only leave after the batch flush, so the first command got slower (P50 1.4 → 29 ms) and failures become coarser                                     |
| 6   | REST-only ablation of the kept engine changes                                                                                   | shows the WebSocket's share: decision → first command P50 95 ms over REST vs 1.4 ms                                                                                                                        |
| 7   | correctness: settled-checkpoint oracle                                                                                          | found lamps left lit in a confirmed-empty room in baseline and candidates (prelight restore off failing on an HA error was never retried)                                                                  |
| 8   | bounded confirmed-empty retry for any off while the room must stay dark                                                         | **kept** (`150c12a`, `79adff7`)                                                                                                                                                                            |
| –   | cache display serialization per state revision                                                                                  | **not implemented**: would change what a heartbeat shows for unpublished in-place state changes; display/UI is outside this chain. Measured potential below                                                |
| –   | skip WLED read-before-write                                                                                                     | **not implemented**: the read guards against writing a missing/changed segment (device safety rule)                                                                                                        |
| –   | deduplication beyond today's observed-state check                                                                               | **not needed/unsafe**: remaining no-ops are Cleverio's deliberate triple off, confirmed-empty retries and the prelight handoff re-send (T2). The engine already skips properties that match observed state |

Measurement fixes made along the way (they affect earlier exploratory numbers
only): simulated WLED reported the wrong capability bits and silently dropped
WLED from every scene; HA processing and sensor publishing were first delayed
by Lugn's own CPU; wall-clock time was inflated by other threads' load; thread
CPU time alone was too coarse. All final numbers use the corrected harness.

### CPU scale sensitivity

| variant                   | decision → first command | arrival → last lamp's command | arrival → first lamp (modeled) |      ingress queue | HA calls | lit in empty room |
| ------------------------- | -----------------------: | ----------------------------: | -----------------------------: | -----------------: | -------: | ----------------: |
| baseline scale 1 (i7)     |         89.8 / 159 / 426 |              131 / 288 / 1066 |               151 / 472 / 1516 |    0.0 / 0.0 / 0.4 |     7056 |           1 / 400 |
| best scale 1 (i7)         |          0.1 / 0.5 / 421 |              27.0 / 146 / 566 |              49.0 / 467 / 1641 |    0.0 / 0.0 / 0.2 |     7024 |           0 / 400 |
| baseline scale 12 (Pi 3B) |        967 / 1720 / 2426 |            1242 / 2289 / 4099 |             1179 / 2017 / 2862 |   0.1 / 798 / 6003 |     7475 |           1 / 400 |
| best scale 12 (Pi 3B)     |          1.4 / 8.3 / 509 |             92.0 / 530 / 1013 |              67.9 / 488 / 1694 |    0.1 / 0.4 / 148 |     7022 |           0 / 400 |
| baseline scale 20         |       1338 / 2981 / 4606 |            2144 / 4909 / 9943 |             1992 / 4096 / 6585 | 0.1 / 7530 / 11274 |     7736 |           4 / 400 |
| best scale 20             |         2.4 / 14.9 / 360 |              141 / 759 / 1187 |              71.6 / 651 / 1706 |   0.1 / 52.7 / 383 |     7055 |           0 / 400 |

### UI serialization (not changed)

With the kept changes, the two hubs' full-state serialization is the largest
remaining CPU consumer (~45 % of Lugn's simulated CPU, mostly the 5 s
heartbeat). In a 25-episode training run at scale 12, removing it lowered the
entry ingress-queue P95 from ~460 ms to ~0 ms. Caching the serialized state per
revision or throttling bursts would recover this but changes UI semantics;
recommended as a separate, UI-owned change.

## Correctness and safety

- Full suite (`npm run check` components: prettier, eslint, `tsc`, vitest
  1682 tests, install-user-service shell test) passes on the final commit.
  `bedtime-routines … 09:30 morning` can time out under heavy parallel load;
  it fails the same way on unmodified `3ce45cf` and passes alone.
- New regression tests (`tests/lighting-fast-path.test.ts`, also passing on
  baseline except the new retry case): manual override restored after a
  short absence; entry lighting sent to never-observed lamps; physical off
  sent despite a stale "off" while an on-command is unconfirmed; retry when
  feedback never arrives; away mode suppresses entry lighting on the batched
  path; a failed prelight-restore off (with remembered values) is retried
  while the room stays empty. `lugn-engine.test.ts` checks that entry and
  confirmed-empty dispatch every lamp before the first publication and that
  the update stream still replays to the engine state. WebSocket transport and
  adapter tests cover synchronous `call_service`, result ids, timeouts, socket
  loss/stop (delivery unknown, never repeated over REST), REST fallback, HA
  error-code mapping and Cleverio's bounded repeats.
- Differential check: settled checkpoints (lamp states, presence, scene,
  overrides) agree with baseline on all 200 training checkpoints. On the 200
  held-out checkpoints the only difference is episode 97 of `test-201`, where
  the baseline leaves the Cleverio lit in a confirmed-empty room and the best
  candidate does not.
- One deliberate semantic change: in the presence fast path a stream
  subscriber can no longer veto a command before transport by reacting to
  its publication (prelight already worked this way). Entry publications now
  merge presence/session with the dispatched commands (≤ 6 domains); the
  partial-patch test bound was raised from 5 to 6.

## Placement: brunocam or putte

Decision support only; nothing was moved. Lugn runs on **brunocam** today; the
STL27L service (`doorway-intelligence`, USB serial) stays there in both
options. The measured facts below were read on 2026-11-09 with pings,
`/proc`, `ps`, service listings and the CPU microbenchmark above; no
configuration was changed.

### What was found

|                                                    | brunocam (today)                                                                                                                                      | putte (candidate)                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| hardware (measured)                                | Raspberry Pi 3B, 4× Cortex-A53, 905 MB RAM                                                                                                            | Intel i5-6600K, 4 cores, 15 GB RAM                                                           |
| network (measured)                                 | **Wi-Fi only** (`wlan0`, 192.168.10.132)                                                                                                              | wired, same LAN                                                                              |
| RTT to HA + MQTT broker (192.168.10.40), 200 pings | P50 4.19 / P95 8.88 / P99 12.4 ms                                                                                                                     | P50 0.26 / P95 0.33 / P99 0.80 ms                                                            |
| RTT brunocam ↔ putte                               | P50 4.3 / P95 10.0 / P99 13.8 ms                                                                                                                      |                                                                                              |
| load (measured snapshot)                           | `doorway-intelligence` ~92 % of one core; Lugn ~8 %, RSS 140 MB; throttling flag `0x60000` (capping/throttling occurred since boot); 612 MB available | load ~2.3 of 4 cores (busy multi-service host); 6.6 GB available, **swap 3.6 / 4 GB in use** |
| clone / JSON microbenchmark, Node 22               | 16.7 / 6.8 ms                                                                                                                                         | 2.0 / 0.86 ms (≈ 8× faster)                                                                  |

HA and the Mosquitto broker both run on 192.168.10.40 (Raspberry Pi MAC
prefix), not on putte. All traffic stays on the LAN; neither placement needs
Tailscale at runtime (inventory uses Tailscale only for SSH), provided Lugn
is configured with LAN addresses.

Hops: the sensor publishes to the broker over brunocam's Wi-Fi in both
cases. With Lugn on brunocam, broker → Lugn and Lugn ↔ HA also cross Wi-Fi;
on putte both become wired. Removing one Wi-Fi one-way hop on the MQTT leg
saves about 2.2 ms at P50 and ~4–5 ms at P95/P99 (RTT/2, measured); this is
not included in the "arrival" columns below, which start at the host.

### Simulated latency for both placements

Placement profiles use the measured RTTs (`placement-brunocam`,
`placement-putte`); CPU scale 12 for the Pi and 2 for putte (from the
microbenchmark; putte is also loaded and swapping, which is not modeled).
Training and held-out workloads pooled, 400 episodes each.

| variant                         | event                  | arrival → first command | arrival → last lamp's command | arrival → first lamp (modeled) | arrival → last lamp (modeled) |
| ------------------------------- | ---------------------- | ----------------------: | ----------------------------: | -----------------------------: | ----------------------------: |
| baseline on brunocam (scale 12) | prelight (preview ON)  |         256 / 348 / 569 |               271 / 547 / 788 |                291 / 389 / 588 |             878 / 2220 / 3959 |
| baseline on brunocam (scale 12) | entry (occupied)       |      1052 / 1962 / 3291 |            1097 / 2384 / 3931 |             1126 / 2188 / 3978 |            1672 / 3524 / 4227 |
| baseline on brunocam (scale 12) | exit (confirmed_empty) |      1410 / 2067 / 3028 |            1423 / 2070 / 3029 |             1437 / 2160 / 3190 |            2136 / 3794 / 5069 |
| baseline on putte (scale 2)     | prelight (preview ON)  |      42.0 / 59.1 / 98.5 |              60.8 / 169 / 219 |               82.9 / 123 / 150 |             709 / 2450 / 4095 |
| baseline on putte (scale 2)     | entry (occupied)       |         178 / 372 / 604 |              204 / 674 / 1280 |              229 / 1141 / 1661 |             757 / 2010 / 2672 |
| baseline on putte (scale 2)     | exit (confirmed_empty) |         237 / 305 / 468 |               269 / 461 / 545 |                279 / 344 / 502 |             893 / 2256 / 3078 |
| best on brunocam (scale 12)     | prelight (preview ON)  |        2.3 / 7.7 / 15.3 |              81.4 / 326 / 498 |             51.0 / 79.9 / 92.2 |             687 / 2256 / 3137 |
| best on brunocam (scale 12)     | entry (occupied)       |         3.2 / 355 / 581 |             85.9 / 672 / 1298 |             63.8 / 1146 / 1762 |             590 / 1908 / 4067 |
| best on brunocam (scale 12)     | exit (confirmed_empty) |        2.5 / 6.2 / 23.8 |              92.6 / 515 / 593 |              49.9 / 87.8 / 128 |             659 / 2100 / 3218 |
| best on putte (scale 2)         | prelight (preview ON)  |         0.4 / 0.9 / 1.7 |             30.3 / 71.1 / 123 |             42.5 / 65.8 / 89.1 |             654 / 2095 / 3134 |
| best on putte (scale 2)         | entry (occupied)       |         0.5 / 327 / 593 |              45.4 / 525 / 991 |             54.4 / 1005 / 1761 |             521 / 1900 / 3760 |
| best on putte (scale 2)         | exit (confirmed_empty) |         0.4 / 0.9 / 2.2 |             41.5 / 89.3 / 118 |              42.9 / 74.5 / 125 |             654 / 2037 / 3212 |

All four runs ended with zero settled checkpoints with a lamp lit in an empty
room.

### Reliability and functions tied to brunocam

- **Shared fate today:** Lugn already depends on the Wi-Fi link and on
  192.168.10.40 for both MQTT and HA. If brunocam fails, the sensor and Lugn
  fail together. On putte, a putte outage disables automatic lighting even
  while the sensor works; manual control through HA stays available. Putte is
  a busy multi-service host (11 days uptime at reading; brunocam 31 days).
- **Swap on putte:** with most of swap in use, an idle Lugn process could be
  partly paged out; the first event after a quiet period would then pay page
  faults. Not modeled; would need a memory reservation or swap tuning.
- **Presence-count correction** (`presenceControl.baseUrl`) points to
  `http://127.0.0.1:8080` on brunocam. The doorway API listens on
  `0.0.0.0:8080`, so putte could reach it at 192.168.10.132:8080, but that
  makes the unauthenticated control API a cross-host dependency.
- **Nest Hub displays:** the hubs load `publicUrl`
  `http://192.168.10.132:8788`; Lugn casts DashCast to the hubs
  (192.168.10.102, .166) over the LAN. Works from putte after changing
  `publicUrl` and re-casting; hub address checks use the hubs' IPs.
- **Desktop UI:** the `lugn-lan-proxy` Caddy user service on brunocam
  terminates TLS on 192.168.10.132:8443 with Caddy's internal CA and forwards
  to Lugn's loopback API; `http.trustedOrigins` is
  `https://brunocam.local:8443`. A move needs a new proxy on putte, new
  trusted origins (and Clerk origins) and clients that trust a new CA.
- **Linux agent (`agents/linux`, on kuffe):** MQTT only; unaffected.
- **Deployment:** Lugn uses systemd user releases on brunocam; putte services
  use Docker Compose (`deploy-putte`). A move needs a new deployment path,
  state migration (`statePath`, scene presets) and a rollback plan.

### Recommendation

1. **Deploy the software changes first and keep Lugn on brunocam.** In the
   simulation they remove nearly all of Lugn's own delay on the Pi
   (exit: arrival → first command P50 1410 → 2.5 ms; first lamp modeled
   1437 → 50 ms). The ARCHITECTURE.md targets for event → dispatch
   (P50 < 20, P95 < 50, P99 < 100 ms) are then met on brunocam for prelight and
   exit; the entry P95 is the prelight handoff re-send (T2), the same on putte.
2. **With the changes, putte gains little:** a few ms on the first command
   and first lamp (exit first lamp P50 50 → 43 ms), more on the last lamp's
   command (WLED's two round trips over Wi-Fi: P95 515 → 89 ms), and nothing on
   the last physical lamp, which is the Tuya cloud. It adds a failure domain,
   swap risk and migration of the display, desktop proxy and count correction.
3. **Without the changes, moving would be the large win** (baseline exit
   arrival → first command P50 1410 → 237 ms), because the old code is
   CPU-bound on the Pi.
4. **Cheaper network fix:** wiring brunocam to Ethernet would bring the
   measured 4–12 ms Wi-Fi RTTs (and their jitter) closer to putte's for both
   Lugn and the sensor, without moving anything. Not measured.
5. **Revisit** after a live measurement with the deployed changes (same HA
   logbook method as above). Move only if Lugn still shows CPU-bound delay or
   if `doorway-intelligence` needs the Pi's CPU.

Measured: hardware, network, RTTs, load, microbenchmark, configuration and
dependencies. Estimated: all P50/P95/P99 placement latencies (simulation with
measured RTTs and microbenchmark-derived CPU scales), the effect of swap and
of wiring brunocam.

## Remaining risks

- Simulated latencies depend on modeled HA/integration behavior. HA-side
  serialization, the Tuya cloud and the doorway sensor's own timing are
  assumptions; only medians were fitted.
- `call_service` over the WebSocket has not been exercised against the real
  HA. Error codes follow HA's WebSocket API; verify on an authorized test
  instance before relying on it.
- The handoff re-send after prelight (T2) and WLED's read-before-write
  dominate the last lamp's command.
- Display serialization remains the largest CPU consumer on the Pi.
- No physical lamp latency was measured; doing so needs a controlled live test.
