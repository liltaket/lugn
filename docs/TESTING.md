# Testing strategy

Lugn's core behavior should be reproducible without physical devices.

For implemented music ownership, restart, clock and reconnect coverage, see
[Music verification](MUSIC-VERIFICATION.md). The scenarios below also describe
future capabilities; source-context ownership and durable routines are not
implemented guarantees.

## Deterministic domain tests

Use an injectable clock and simulated events.

Core scenarios:

### Scene and override

1. activate Cozy;
2. all simulated lights converge;
3. externally change desk brightness;
4. only desk brightness becomes overridden;
5. another scene-owned property remains controlled;
6. Reapply Cozy clears the relevant override and reconverges.

### Short absence

1. Cozy active with manual desk adjustment;
2. person leaves;
3. lights physically turn off immediately;
4. logical Cozy + desk override remain;
5. person returns before continuity expiry;
6. prior effective state is restored.

### Long absence

Same setup, first confirm the room empty, then advance the original continuity
deadline while presence becomes `unknown`. Verify remembered scene/overrides
are cleared and a state-stream update is published; an early occupied return
cancels expiry. Unknown presence alone must never start that deadline.

### Presence uncertainty

1. occupied;
2. sensor becomes unknown;
3. no destructive empty-room behavior occurs;
4. unknown alone does not start a continuity reset; an existing confirmed-absence
   deadline is not renewed or cancelled by uncertainty;
5. recovery does not create a false new visit.

### Device failure

1. activate scene;
2. device ignores commands;
3. retry with configured backoff;
4. stop aggressive retry after convergence timeout;
5. expose degraded/unreachable state;
6. device returns;
7. reconcile toward current effective desired state.

## Music tests

### Self-generated fade

1. observed volume 30;
2. request an automatic fade to 50 without an existing human hold;
3. feed back values along the expected trajectory with realistic delay/rounding;
4. verify no manual ownership is created from its own feedback. An explicit
   human fade intentionally claims manual volume ownership at request time.

### Manual interruption

1. fade 30 -> 50;
2. feed expected feedback;
3. inject a clear external move away from trajectory;
4. verify future fade steps are cancelled;
5. new volume is respected.

### Future source-context ownership

1. PC context requests Optical;
2. user chooses a preset;
3. verify PC automation does not immediately switch back;
4. advance continuity/reset policy;
5. verify behavior according to configured expiry.

### Quick return

1. media context active;
2. room becomes empty -> pause;
3. return quickly;
4. verify context resumes rather than starting unrelated default music.

## Future durable-routine tests

- delayed steps can be cancelled;
- restart restores durable routine state safely;
- old queued work does not execute after invalidation;
- dynamic time input is validated;
- manual scene/action can interact with routine ownership predictably.

## Input tests

BILRESA bindings should be testable as pure input events.

Contextual binding tests must verify that the same physical action remains predictable for each explicit context.

## DashCast tests

- dashboard starts when desired;
- dropped dashboard is restored;
- deliberate external cast causes Lugn to yield;
- Lugn does not repeatedly fight an active external cast;
- dashboard returns after the external session ends.

## Performance tests

Instrument at least:

- sensor receipt -> decision
- decision -> command dispatch
- command dispatch -> observed feedback
- scene selection -> full convergence

The fast lighting path should be benchmarked independently from database/UI workload.

## Hardware validation

Simulators prove logic, not device behavior.

Real hardware tests are still needed for:

- STL27L event timing and uncertainty
- light response/feedback latency
- WiiM volume feedback cadence
- WiiM fade tolerances
- source/preset behavior
- DashCast lifecycle
- BILRESA event behavior
- HASS.Agent state/action behavior
- optional monitor power thresholds

Document measured values rather than turning guesses into permanent constants.
