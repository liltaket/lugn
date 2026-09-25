# Future intelligence

The long-term goal is more ambitious than ordinary presence automation:

> Lugn should eventually infer which room state or scene the user is likely to want from sensors, context, and learned behavior.

The current system does not yet have enough trustworthy context to make this a requirement.

## Design now, implement later

The first versions should expose clean extension points such as:

- ContextProvider
- IntentProvider
- SuggestionProvider
- SceneDecisionProvider

Initial implementations can be ordinary deterministic rules.

Future providers can use:

- richer sensors
- probabilistic models
- Jev-like typed decision systems
- small local models
- LLMs
- personal schedule/context agents

## Possible future context

Useful structured observations may include:

- time of day
- day of week
- person count
- last reliable room position
- movement direction when reliable
- PC activity
- locked/unlocked
- fullscreen/game/media state
- current music source/preset
- currently selected scene
- manual adjustments after a scene
- duration of selected scene
- which control surface was used
- ambient/environmental measurements
- future calendar/wake/home-arrival context

Collect information because it is useful for product behavior and diagnostics, not merely because a future model might consume it.

## Scene inference progression

Do not jump directly to autonomous scene selection.

A safer progression:

### 1. Suggest

    "You seem to be playing. Use Gaming scene?"

### 2. Learn repeated preferences

    "You usually choose Gaming in this context."

### 3. Ask for opt-in

    "Automatically switch to Gaming next time?"

### 4. Automatic selection

Apply automatically, while keeping correction immediate and respected.

The manual override / ownership system remains underneath all intelligence.

## Personal context integration

A future separate personal context system may know things such as:

- expected wake time
- when the user is likely to arrive home
- first calendar event
- travel time
- tomorrow's schedule

Lugn should consume narrow typed facts rather than requiring the room engine itself to understand a person's full calendar or life.

Example:

    expected_wake_time = 07:40
    valid_until = ...
    confidence = ...

Good Morning can then schedule relative to that value.

## Voice and natural language

A future voice/NLU layer may interpret:

    "Make it cozy but a little brighter at the desk."

into ordinary capability calls:

    activate Cozy
    increase desk brightness

The second action naturally becomes an override on top of the scene.

The natural-language system is a client of Lugn, not an alternative automation engine.

## Small decision models

Typed probabilistic models are especially interesting for bounded decisions such as:

- is the user likely approaching the desk?
- should a Gaming suggestion be shown?
- which of a small set of scenes is most likely?
- is a sensor transition likely genuine?

They should return structured decisions/confidence, after which deterministic code applies thresholds and actions.

## Non-negotiable principle

> Intelligence can propose or choose intent. The deterministic engine still owns execution, validation, ownership, continuity, retries, and physical convergence.
