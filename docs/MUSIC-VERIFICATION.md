# Music ownership verification

This records implemented software behavior and its evidence. No physical WiiM,
Nest Hub, BILRESA, sensor or production instance was operated for this work.
The device protocol below is pending; passing simulations is not field evidence.

## Ownership and reset contract

| Event                                             | Volume authority and continuity                                                                                                                                                                                | Playback intent                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Dashboard/HA/physical volume intent               | Claims manual ownership of the exact destination, independent of the calculated baseline/offsets. Automatic direct commands and fade steps are blocked.                                                        | Does not release explicit Pause.                                                                                    |
| Repeated occupied/person-count events             | Retains manual ownership; periodic daily/person offsets remain calculations only.                                                                                                                              | Does not create a new entry.                                                                                        |
| Confirmed empty                                   | Starts one absolute 20-minute manual-volume deadline. Repeated empty events do not renew it.                                                                                                                   | Pauses for safety and retains the original short-return context window.                                             |
| Unknown without prior confirmed absence           | Starts no absence/reset deadline; suppresses periodic volume activity.                                                                                                                                         | Starts/resumes nothing.                                                                                             |
| Unknown after confirmed empty                     | Preserves the original absolute deadline; uncertainty does not renew or cancel it.                                                                                                                             | Preserves the original resume window; uncertainty is not a fresh visit.                                             |
| Occupied before expiry                            | Cancels the absence countdown and retains manual volume.                                                                                                                                                       | May resume the prior context on a fresh eligible entry; Pause, away and quiet hours still gate it.                  |
| Exact expiry (`now >= expiresAt`)                 | Releases temporary manual volume ownership without sending a command. Automatic policy may regain authority when occupancy and its gates are eligible.                                                         | The old resume context expires; a new eligible entry may choose the default preset. Explicit Pause does not expire. |
| HA away/home/unknown                              | Away suppresses automatic volume. Home/unknown alone never creates a confirmed absence or renews its clock.                                                                                                    | Away pauses and blocks positive automation. Home/unknown is not a fresh room entry.                                 |
| Explicit disable then enable of volume automation | Disable suppresses/cancels future automatic work; dedicated explicit enable releases the temporary manual volume hold. Repeated enable while already enabled does not.                                         | Independent of Pause and entry policy.                                                                              |
| BILRESA temporary all-off restore                 | Restores its prior enable setting while preserving valid manual volume ownership.                                                                                                                              | Existing playback safety remains independent.                                                                       |
| Human fade                                        | Owns volume and blocks competing automatic work. Cancellation stops future steps; an already dispatched service cannot be recalled. Finishing cannot recreate an expired or explicitly surrendered hold.       | Independent of playback holds.                                                                                      |
| Process restart                                   | Restores completed logical snapshots, original deadlines and exact human destinations before fresh observations. Replays no positive commands or fades. Unknown startup observations do not prove convergence. | Restores original Pause age and resume deadline; the first Playing seed/recovery report cannot prove physical Play. |

Daily offsets and the 23:00–06:00 automatic-start gate use Europe/Stockholm wall
time at minute resolution. The daily curve follows skipped/repeated hours at
DST. Absence windows use absolute elapsed milliseconds, so a 20-minute window
does not gain or lose an hour at DST. Opening the 06:00 gate does not start
music in an already occupied room: playback still requires a fresh eligible
entry. Volume policy can operate at night when it owns volume; manual controls
remain available during quiet hours and away.

## Deterministic evidence

The numbered rows correspond to the requested ownership/dashboard/reliability
problems. All tests use synthetic events or transports. API acceptance, reported
state, logical durability and physical sound are separate evidence.

| Request                                       | Implemented evidence                                                                                                                                                                                                        | Remaining qualification                                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Genuine manual volume ownership            | `music-volume-ownership.test.ts`: user, physical-remote and HA actors; guarded direct/fade commands.                                                                                                                        | Physical feedback attribution is inferred without causal HA context.                                                                              |
| 2–3. Short/long absence                       | Ownership and restart suites preserve one original deadline, test `expiresAt - 1` and exact expiry, and require eligible occupancy before automatic volume.                                                                 | Real sensor/transport timing is unmeasured.                                                                                                       |
| 4. Deterministic transitions                  | Ownership/restart/control suites cover repeated events, unknown, home/away, timers, toggles, competing requests and active fades.                                                                                           | In-flight HA requests cannot be recalled.                                                                                                         |
| 5. Independent Pause                          | `music-pause-feedback`, `music-pause-continuity`, `music-intent-restart` and Hub tests preserve explicit Pause and independently release it with Play/preset.                                                               | Uncorrelated playback changes cannot prove every physical cause.                                                                                  |
| 6. Away → unknown scheduler                   | Ownership suite observes actual subsequent periodic volume work after the gate opens.                                                                                                                                       | Home unknown intentionally follows the existing non-away policy.                                                                                  |
| 7. Stale/delayed feedback                     | Ownership and volume-feedback suites cover retained correlated commands, bounded uncorrelated matches, repeated metadata and overlapping fade targets.                                                                      | Matching uncorrelated feedback beyond the bounded window or after ledger pruning can remain ambiguous; manual ownership still persists.           |
| 8. Separate authority/change/enabled/activity | Policy-transparency, Hub and display-stream tests verify four separate facts and stale connection handling.                                                                                                                 | Last reported changer may be a labelled match or unknown.                                                                                         |
| 9. Truthful reasons/countdown                 | Typed reasons, server-time countdown and pure reads are tested; local expiry never releases authority.                                                                                                                      | Bounded history records evaluated transitions, not every wall-clock instant.                                                                      |
| 10. Separate volume values                    | Hub tests distinguish observation, pending request, baseline, two offsets, calculated automatic target and effective owner target.                                                                                          | A calculated target does not prove a sent request or convergence.                                                                                 |
| 11. Playback/quiet/commands                   | Backend eligibility shares dispatch's predicate; Hub tests cover failed Pause recovery and outstanding volume after newer playback confirmation.                                                                            | Preset feedback cannot confirm the selected preset.                                                                                               |
| 12. Bed/Desk relevance                        | Hub rendering and authenticated role-provenance tests cover priorities, real DOM order, missing capabilities, spoofing and shared room state.                                                                               | Browser checks cover 800×480/1024×600, five/six scenes and paired seven/eight scenes; larger custom sets and physical Cast rendering are pending. |
| 13. Structured reasons/history                | `music.getPolicy` exposes typed volume/playback reasons and bounded 128-entry music history; Hub displays the newest eight per selected player.                                                                             | Issue #14's lighting/prelight history remains unresolved; extend their decision boundaries with typed context in a separate change.               |
| 14. Expiry boundaries                         | Ownership/restart/clock suites check short returns and exact expiry, including both DST transitions.                                                                                                                        | Bench measurements require timestamped confirmed presence, not a guessed stopwatch event.                                                         |
| 15. No held-volume drift                      | Clock/ownership suites run occupied manual holds through 23:00, midnight, 06:00, person-count changes and DST.                                                                                                              | Raw device volume may still change from physical intent or an already dispatched request; this is distinct from new automatic commands.           |
| 16. Disconnect/reconnect/restart              | Sensor/websocket suites and `music-ha-recovery.test.ts` compose transport re-authentication, retired-socket isolation, HA reseeding, unknown presence and original deadlines; restart/store/runtime suites cover hydration. | Sudden power loss and real connection timing remain unverified.                                                                                   |
| 17. Failure/fade/physical changes             | Control, fade-deadline, feedback and ownership suites cover rejection, absent/delayed reports, interruption and synthetic external WiiM-style moves.                                                                        | Physical cadence, rounding and fade tolerance require device measurements.                                                                        |
| 18. Night and DST                             | `music-clock-reliability.test.ts` checks actual positive entry dispatch and offsets immediately before/at 23:00 and 06:00, midnight, and skipped/repeated Stockholm hours.                                                  | Actual device behavior at those transitions remains pending.                                                                                      |
| 19. Documentation agreement                   | MUSIC, BEHAVIOR, PRESENCE, UI, operations/restart docs and this contract distinguish holds, confirmed absence, explicit reset and observation. Preset docs now match `wiim.play_preset`.                                    | Testing strategy labels source-context ownership and durable routines as future work.                                                             |
| 20. Physical protocol                         | The following steps specify observations and acceptance checks without operating production.                                                                                                                                | Every physical step remains unperformed.                                                                                                          |

The composed prelight runtime test freezes only `Date` at a known daytime
instant; sockets, asynchronous I/O and timers remain real. Its daytime brightness
expectation no longer depends on the developer's quiet-hours window. Music clock
tests use an injected `FakeClock`; they do not change the machine or device clock.

## Pending physical-device protocol

Run this only in an explicitly authorized isolated bench instance with its own
state file and mapped test devices. Do not deploy these branches or change
production configuration as part of verification. Record Lugn/HA versions,
entity integration, timezone, clock synchronization, event timestamps, command
IDs/statuses, policy snapshots, actual reported values and physically audible
behavior. Inspect HA service calls as well as Hub Details; matching a service
response alone does not establish convergence.

1. While confirmed occupied, choose different volumes with the WiiM physical
   control, HA and each Hub. Verify manual ownership for every path, correct
   reported changer/matching qualification, and no new automatic `volume_set`
   calls through person-count changes or minute ticks. Verify Play/Pause intent
   remains independent.
2. Confirm empty, then return before 20 minutes. Compare the original deadline,
   destination and reported volume; the return must cancel the countdown without
   surrendering ownership. Repeat with a return at/after the deadline. Expiry
   itself sends no volume; eligible occupancy may hand volume back to Lugn.
   Software already checks the millisecond boundary; bench timestamps measure
   sensor/transport latency around it.
3. Replace occupied sensor reports with unknown/offline data without an empty
   event. No absence deadline or autostart should appear. Repeat after confirmed
   empty: the original deadline must keep its time, including across repeated
   empty, unknown and HA home/away events. A HA reconnect must not manufacture a
   fresh room entry.
4. Explicitly Pause while the device still reports Playing, including an HA
   service failure. Verify no automatic Play/preset on subsequent entries.
   Recover availability and reconnect HA; the first Playing seed must not erase
   Pause. Explicit Play/preset releases playback intent while a manual volume
   hold stays active. Check physical Play only after a known observation baseline.
5. Start a human fade, interrupt it physically, disconnect the device, reject a
   service and withhold/delay feedback. Future steps must stop as specified;
   accepted, confirmed, interrupted, failed and unconfirmed states must remain
   distinct. Measure feedback cadence/rounding against the 0.005 command and
   0.02 fade tolerances before changing those constants.
6. Delay older automatic volume feedback past a newer human destination, repeat
   cached reports and reproduce the same-target fade ambiguity. Verify no manual
   hold is released and no false completion is claimed. Without causal HA
   context, capture ambiguous matches explicitly rather than assigning certainty.
7. Observe 22:00, 23:00, midnight and 06:00 while held, and separately after
   handback. Manual ownership must prevent automatic volume drift. Fresh entries
   during 23–06 must send no positive Play/preset; explicit human Play remains
   allowed. An already occupied room must not start just because 06:00 arrived.
   DST's clock jumps are covered in simulation; a real DST observation remains
   pending and must not alter production clocks.
8. Gracefully restart the bench process during a short absence, after expiry,
   under Pause, during a human fade and during BILRESA temporary all-off. Confirm
   saved intent/deadlines survive without replaying a fade or positive command.
   Test abrupt termination/power loss separately and record whether the last
   snapshot had completed; do not mistake request acceptance for a durable write.
9. On both physical Hubs, verify one-touch priorities, role provenance, all-off,
   both presets, Play/Pause and volume; check Details/Back, lost connection,
   missing sensors/player, and five/six/eight-scene fit. Check Cast recovery
   separately from an HTTP fetch or successful Cast launch response.

## Unresolved work and next actions

- **Physical timing and causation:** no device, sound, sensor, Cast or power-loss
  measurements were performed. Run the isolated protocol above and attach
  timestamped results before making device-level reliability claims.
- **Abrupt-write durability:** the existing 150 ms debounce/in-flight write can
  lose the latest intent on abrupt termination. Graceful shutdown flushes, and
  completed atomic snapshots survive restart. A stronger per-request durability
  acknowledgment or journal needs a separate design/change; service acceptance
  currently does not acknowledge persistence.
- **Uncorrelated HA feedback:** causal command context is unavailable from the
  REST dispatch path. Preserve conservative ownership and qualified attribution;
  investigate integration-provided causal context before widening match windows.
- **Decision history breadth:** music reasons/history implement part of issue
  #14. Lighting/prelight history remains an explicit follow-up; the music ring
  resets on process restart and is not an audit log.
- **Large scene configurations:** more than eight custom scenes require their
  own viewport validation or a separate pagination design. No unsupported Sleep
  or PC capability is invented.
- **State-file rollback:** music installations write a version-2 envelope; older
  binaries reject it. Plan state backup/rollback conversion separately before
  deploying or rolling back. No production state/configuration was changed here.
