# Routines and suggestions

## Routines are orchestration

A routine should compose existing capabilities rather than implementing device protocols itself.

Examples:

- Good Morning
- Good Night
- future arrival routine
- future leave-home routine

A routine may contain:

- scene changes
- lighting fades
- music preset/source changes
- music fades
- delays
- conditions
- display/computer actions
- prompts
- cancellation points

## Good Night

Possible behavior, entirely configurable:

- activate Sleep / evening scene;
- dim selected lights gradually;
- lower music volume;
- keep music for a configurable period;
- fade music out;
- optionally request computer display off;
- preserve or clear selected continuity state according to explicit policy.

## Good Morning

Possible behavior:

- begin gradual light increase before target wake time;
- start quiet music;
- transition to morning/day scene;
- optionally surface a snooze control on the bedside Hub.

## Scheduling

Routines should support at least:

- fixed time
- weekday-specific time
- manual start
- button-triggered start
- future dynamic/context-provided time

Long-term example:

    external personal context:
      expected_wake_time = 07:40

    Good Morning:
      start lighting at wake_time - 20 min

The routine engine does not need to know why wake time is 07:40.

## Configuration

Routines must be:

- easy to create in code/config;
- editable in the UI;
- schema validated;
- persistent;
- creatable through typed tools so an authorized future agent can configure them safely.

The engine should not require hand-written Python for normal routines.

## Cancellation

Delayed future actions must be cancellable.

Examples:

- Good Night was started accidentally;
- user explicitly starts another scene;
- automation is disabled;
- routine context becomes invalid.

Stale steps must not execute minutes later merely because they were queued previously.

## Suggestions

Suggestions are contextual prompts, not autonomous decisions.

Example:

    game/fullscreen detected
    + room occupied
    + Gaming scene not active

    -> Desk Hub:
       "You seem to be playing. Use Gaming scene?"
       [No] [Gaming]

"No" can suppress the same suggestion until the related game/activity session ends.

## Suggestion principles

- suggestions should be rare;
- do not repeat the same prompt aggressively;
- choose the most relevant display;
- remember "no" for the current context;
- never require suggestions for core automation to work.

A future progression can be:

1. suggestion;
2. repeated learned suggestion;
3. explicit opt-in to automatic behavior;
4. automatic behavior with easy correction.

The first implementation should keep suggestion producers minimal.
