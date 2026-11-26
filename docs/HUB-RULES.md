# Hub rules

Hub rules decide what each Hub screen shows from the situation: which pages
exist, which one to bring up, how bright the screen is, and which labels the
page can react to. They are configuration, not code, and a Hub without rules
behaves exactly as before.

Examples of what they express:

- while away, show only the clock, dimmed, and take the cameras off the screen;
- for the first 15 minutes after coming home, bring up the photos;
- show one page on the bed Hub and another on the desk Hub;
- when someone is at the computer (by the computer agent's own rules), bring up
  the cameras on the desk Hub;
- when several people are in the room, label the screen `crowded`;
- at night, on the bed Hub, dim the screen and drop the pages that glare;
- bring up Musik when music starts, unless someone is in the middle of something;
- show the greeting page (Godmorgon, Godnatt, Välkommen hem, the dimmed night
  sheet) in its moment, wearing the day's skin (Christmas, a birthday);
- let the computer page in only while someone is at the computer.

## The model

```text
facts → conditions → matched rules → effects → one policy per Hub
```

- **Facts** are what is true now, for one Hub: home or away, the room's people,
  whether each computer is in use, the Stockholm time and weekday, and which
  Hub it is.
- A **condition** is a JSON tree of `all` / `any` / `not` over leaf tests.
- A **rule** is `when` (a condition) and `then` (effects), with a `priority`,
  an optional Hub selector and an optional `holdMinutes`.
- The **server** evaluates the rules for each Hub on every state it sends to
  it (a change, or the five-second heartbeat). The Hub (`hub-policy.js`) only
  carries the result out, so a rule means the same on every Hub and time
  boundaries such as “the first 15 minutes” need no clock on the Hub.

The code is in `src/core/hub-rules.ts` (schema, conditions, resolution; no I/O)
and `src/application/hub-policy.ts` (facts from the room state, and the
remembered activations). Everything is tested by writing the facts down; see
`tests/hub-rules.test.ts`.

## Configuration

Rules live under `display.rules` in the JSON configuration:

```json
"display": {
  "hubs": [ ... ],
  "rules": [
    {
      "id": "away-calm",
      "description": "Away: only the clock, dimmed",
      "when": { "home": "away" },
      "then": { "only": ["clock"], "dim": 0.5, "tags": ["away"] }
    },
    {
      "id": "welcome-home",
      "when": { "arrived": { "withinMinutes": 15 } },
      "then": { "focus": { "page": "foto", "returnTo": "home" } }
    },
    {
      "id": "desk-cameras",
      "hubs": { "role": "desk" },
      "when": { "computer": { "is": "active" } },
      "then": { "focus": { "page": "kameror" } }
    },
    {
      "id": "bed-night",
      "hubs": { "role": "bed" },
      "when": { "time": { "from": "22:30", "to": "06:30" } },
      "then": { "dim": 0.25, "tags": ["night"], "hide": ["info", "kameror"] }
    }
  ]
}
```

`npm run config:check` validates the rules. A malformed rule, an unknown key,
a typo in a page name or two rules with the same `id` are errors, not silently
ignored. Rules apply from the next state each Hub receives after a restart.

### Rule

| Key           | Meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `id`          | Unique, lower-case (`a-z0-9_-`).                                                        |
| `description` | Free text for people.                                                                   |
| `enabled`     | `true` by default; `false` keeps a rule written down without applying it.               |
| `priority`    | −100…100, default 0. Higher applies later and wins single-valued effects.               |
| `hubs`        | `{ "id": "bed" }` and/or `{ "role": "desk" }`: only these Hubs. Sugar for a `hub` test. |
| `when`        | A condition.                                                                            |
| `then`        | Effects (at least one).                                                                 |
| `holdMinutes` | Once true, the rule stays applied this long after its condition stops being true.       |
| `switch`      | `film` or `away`: the settings page can switch the rule off.                            |

### Conditions

A condition object has exactly one key.

| Condition                                                                | True when                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ "all": [c, …] }` / `{ "any": [c, …] }` / `{ "not": c }`               | The usual.                                                                                                                                                                                             |
| `{ "home": "home" \| "away" \| "unknown" }`                              | Home Assistant's status for the resident ([Presence](PRESENCE.md#home-and-room-presence)).                                                                                                             |
| `{ "arrived": { "withinMinutes": 15 } }`                                 | Home, and the resident came home (`away` then `home`) less than that many minutes ago. A first observation after a restart is not an arrival.                                                          |
| `{ "room": "occupied" \| "empty" \| "unknown" }`                         | The room sensor's state. An exit that Lugn is still waiting on counts as occupied.                                                                                                                     |
| `{ "people": { "atLeast": 2, "atMost": 4 } }`                            | The sensor's person count is in range (at least one bound). Empty counts as 0.                                                                                                                         |
| `{ "computer": { "device": "desktop", "is": "active" } }`                | A computer's agent says `active`, `idle`, `locked` or `offline`. `device` is optional: without it, any computer. Only a fresh, online reading counts.                                                  |
| `{ "lights": "on" \| "off" }`                                            | Some lamp is on / every known lamp is off. Unknown when no lamp reports.                                                                                                                               |
| `{ "lightsOnFor": { "atLeastMinutes": 15 } }`                            | A lamp was first turned on since 06:00 today at least that long ago; one left on overnight does not count. False if none has been. `not` of it gives "until 15 minutes after".                         |
| `{ "music": "playing" \| "quiet" }`                                      | Some music device is playing / none is. Unknown when none reports.                                                                                                                                     |
| `{ "watching": true }`                                                   | A computer that reports (online and fresh) plays video or audio in full screen, unlocked: a film, a video or a game.                                                                                   |
| `{ "air": "stuffy" }`                                                    | The room's CO₂ has been at or over the level set on the settings page for ten minutes, until it is 200 ppm under it. Unknown when the reading is over 30 minutes old; never while the reminder is off. |
| `{ "time": { "from": "22:30", "to": "06:30", "days": ["fri", "sat"] } }` | The Stockholm wall clock is in the window (`from` is included, `to` is not; past midnight is fine). `days` names the day the window **starts** on.                                                     |
| `{ "hub": { "id": "bed", "role": "bed" } }`                              | This is that Hub.                                                                                                                                                                                      |

#### Unknown is not false

A fact can be unknown: the sensor is silent, Home Assistant has not answered,
the computer's reading is stale. A test over an unknown fact is neither true
nor false (three-valued logic), and **a rule only applies when its condition is
true**. So `{ "home": "away" }` does not apply while home status is unknown, and
neither does `{ "not": { "home": "home" } }`, which is also unknown. Say
`{ "home": "unknown" }` to act on not knowing. This is the same rule the rest of
Lugn follows: unknown never behaves as away, empty or idle.
`all` is false if any part is false, else unknown if any part is unknown;
`any` is true if any part is true, else unknown if any part is unknown.

### Effects

| Effect                                            | Does                                                                                                                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"focus": { "page": "foto", "returnTo": "home" }` | Brings the page up when the rule **starts** to apply. Once, not held: someone who swipes away is left alone until the rule starts again. `returnTo` is where it goes when the rule ends, if the Hub is still on that page. |
| `"only": ["clock", "music"]`                      | The pager contains only these pages.                                                                                                                                                                                       |
| `"hide": ["kameror"]`                             | These pages cannot be reached (swiping skips them, the navbar has no button to them).                                                                                                                                      |
| `"dim": 0.4`                                      | Brightness, 1 = unchanged, 0.05 at the least. A Hub cannot dim its own panel, so a black sheet is faded over the page.                                                                                                     |
| `"show": ["dator"]`                               | Lets a conditional page into the pager (see below).                                                                                                                                                                        |
| `"scene": "godnatt"`                              | The greeting page: lets it in, brings it up once when the rule starts (`returnTo` Hem) and tells it which scene it is: `godmorgon`, `godnatt`, `hem` or `natt`. `natt` also locks the Hub to it. See below.                |
| `"tags": ["night"]`                               | Free labels on `<html>` as `data-hub-tags="night"`, for CSS (`[data-hub-tags~='night'] …`) and scripts. Lower-case, digits and `-`.                                                                                        |

Pages are `home`, `halsning`, `music`, `foto`, `kameror`, `clock`, `dator`,
`info` and `installningar`. Two of them are **conditional** and are in the pager only when a rule lets
them in (`show`, or a `scene`): `halsning` (the greeting) and `dator` (the
computer's live numbers, for someone at the computer). `focus` also takes
`fromPages` (only take the Hub over from these pages) and `idleSeconds` (not
if the Hub was touched this recently); a chance that is missed is dropped, not
kept for later. If the Hub was taken to the page, it is taken back when the rule
ends, but only if nobody has touched it for 30 seconds or moved on since.

### Conflicts

Several rules often apply at once. They are applied in order of `priority`
(lowest first, configuration order within a priority) and combined the same way
every time:

- `hide` is a union and `only` an intersection: the stricter rule wins, and
  hiding beats showing.
- `dim` takes the darkest value; `tags` are a union.
- `focus`: the last rule that has one wins. A focus on a page the result hides is
  dropped.
- Rules that between them leave **no** page are ignored for pages (the Hub keeps
  every page); the Hub is never left blank.

### Activations, `focus` and hold

The server remembers, per Hub and rule, when the rule started to apply. That
start names one **activation**, and a `focus` carries a token made from it. A
Hub goes to the page when it sees a token it has not acted on. While the rule
goes on, the token is the same; when it ends and starts again, it is new.

`holdMinutes` keeps a rule applied after its condition stops being true, so a
flickering sensor (`people ≥ 2`, a computer that goes idle between keystrokes)
does not flicker the screen. A held rule keeps its activation.

A Hub loads the pages again when Lugn restarts (it sees a new instance), so a
new release reaches the Hubs without recasting them. A service restart forgets the activations and when a lamp was first turned on
today: a `focus` that is in force is offered once more to a Hub that connects
afterwards, and "15 minutes after the lamps" starts over from the restart.

## Dimming, the air reminder and the settings page

```json
{ "id": "away", "switch": "away", "priority": 40,
  "when": { "all": [{ "home": "away" }, { "not": { "room": "occupied" } }] },
  "then": { "dim": 0.05, "tags": ["away"] } },
{ "id": "film", "switch": "film", "holdMinutes": 1,
  "when": { "watching": true }, "then": { "dim": 0.55 } },
{ "id": "vadra", "when": { "air": "stuffy" }, "then": { "tags": ["vadra"] } }
```

A touch lifts a dimmed screen for half a minute; at `dim` 0.2 or darker the
first tap only wakes it. The `vadra` tag marks the CO₂ value on Hem and on the
clock page and changes the line under the greeting; other pages are left alone.

The **Inställningar** page (the last one) changes a few things from the room: the
wait before an empty room is switched off, when the computer's display sleeps,
the air reminder's level, the arrival sound, whether the cameras appear on
motion, and the two switchable rules. The server lists each setting with the
values it may take (`payload.settings`), a Hub posts one of them to
`display-api/setting`, and anything else is refused. Only settings whose feature
is configured are listed. The reminder level and the switches are kept in
`<lighting intent path>.hub-settings.json`; the others are saved where the
control panel saves them.

## Scenes and greeting days

The greeting page is one template with the date, the clock, a headline, one
line under it, up to three actions and the weather. The `scene` effect chooses
which scene it is in:

| Scene       | Meant for                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `godmorgon` | From 06:00 until 15 minutes after a lamp is first turned on after 06:00.                       |
| `godnatt`   | Bedtime on the bed Hub (22:30–02:30): the few controls you need and tomorrow's weather.        |
| `hem`       | The first 15 minutes after coming home.                                                        |
| `natt`      | Night with every lamp off: an almost black screen with a faint clock; the Hub is locked to it. |

Only one scene is shown. The rules decide by `priority`; the highest that
applies wins, so arriving home late gives Välkommen hem first and then
whatever the night says. Rank `natt` above `godnatt`, so the bed Hub dims as
soon as the lamps are off. A **skin** is added to `godmorgon` and `hem` on a greeting
day: Christmas, New Year's Eve and Day, Easter, Midsummer, All Saints', Lucia, a
birthday or a day of your own. They are computed from the calendar and
`display.greetings`, with no outside service:

```json
"display": {
  "greetings": {
    "birthdays": [{ "name": "Alva", "date": "1990-05-14" }],
    "days": [{ "title": "Flyttdagen", "date": "05-02" }]
  }
}
```

A birthday with a year shows the age. Open a Hub page with `#scene=godnatt`
(also `godmorgon`, `hem`, `natt`), `&skin=jul` (`nyar`, `midsommar`, `pask`,
`lucia`, `allahelgon`, `fodelsedag` with `&name=Alva&age=32`, `egen` with
`&title=…`) or `#show=dator` to look at a page without waiting for its rule; the
server's rules are then ignored on that page.

## Real data only

The greeting and computer pages draw only what Lugn actually knows: the weather
and sun from Home Assistant (`homeAssistant.weather`), the room's climate, the
lamps, the music, how long you were away, and, for the computer page, the
statistics the desktop publishes (`agents/linux/stats`). What has no data is
left out; nothing is filled in with example values.

## What the Hub does

`src/ui/hub-policy.js` applies `payload.hubPolicy` (absent when no rules are
configured):

- `pages` → `lugnPages.setAvailable`: the pages that are left out are taken out
  of the track, the others close up, the dots follow and a swipe goes straight
  to the next page. If the page on screen is left out, the first page that
  remains takes over. The pager does not rearrange pages under a finger and
  asks again a moment later.
- `focus` → goes to the page, once per token; waits for a swipe or a dialog to
  finish, and lets a person who is in the middle of something be (`fromPages`,
  `idleSeconds`).
- `scene` → handed to the greeting page (`lugnGreeting.setScene`).
- `dim` → fades the black sheet (`#hub-dim`) in over about a second, so a rule
  that starts at night comes on like dusk.
- `tags` → `data-hub-tags` on `<html>`.

Hiding `kameror` also removes the navbar's button to the cameras. Hem's own
camera shortcuts are not pages and stay; a page that should react to a rule
styles itself on a tag.

## Adding to it

The model is small on purpose, and each part grows in one place:

- **A new fact** (say, the sun's position or the next calendar event): add it to
  `HubFacts`, fill it in `hubFacts()` in `src/application/hub-policy.ts`, and
  add a leaf to `Condition` and to `evaluateCondition()` in
  `src/core/hub-rules.ts`. A fact that can be unknown returns `null`.
- **A new effect**: add it to `HubEffectsSchema` and `composeHubPolicy()`, say
  how it combines with itself, and carry it out in `hub-policy.js`.
- **A new page**: add its id to `HUB_PAGE_IDS` with its `<section data-page>` in
  `src/ui/display.html`.
- **Parts of a page** (a widget on Hem, the volume controls) are not pages. Let a
  rule set a tag and let the part react to `[data-hub-tags~='…']`; promote the
  idea to an effect only when several parts need the same thing.

Not built yet, on purpose: editing rules in the control panel, rules for what
the lights or music do (those stay in [Lighting](LIGHTING.md),
[Music](MUSIC.md) and [Routines](ROUTINES.md)).
