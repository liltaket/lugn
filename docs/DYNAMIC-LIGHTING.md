# Dynamic lighting: Musik and Dynamisk

Two room presets follow live context instead of holding one fixed look. Both are
ordinary scenes with a `dynamic` marker. The scene's own lamp values stay its
**fallback look**, and the room returns to that look whenever there is nothing
to follow.

| Preset   | `dynamic`  | Follows                                                                   |
| -------- | ---------- | ------------------------------------------------------------------------- |
| Musik    | `music`    | The artwork of the track that is playing.                                 |
| Dynamisk | `adaptive` | The computer (full screen, idle, locked), the room and the music colours. |

Musik replaces the former Party preset. While nothing plays it shows its own
scene definition, so give it the animations you want for that case in the preset
editor (the editor keeps the `dynamic` marker). A saved `scene.party` is turned
into `scene.music` ("Musik") when the preset file is loaded and is written back
under the new id on the next ordinary save, with its lamps and Govee rotation
intact. If a saved `scene.music` already exists, both are left as they are.

Dynamisk is **exploratory**. Its rules are deliberately small and every
decision carries a reason, so they can be tested and tuned against real use
before they grow.

## Configuration

The modes need to know what each lamp is for. Roles are configured, never
guessed from names. Without `dynamicLighting` the two presets behave like any
other static scene.

```json
"dynamicLighting": {
  "targets": {
    "lighting.ceiling": "main",
    "lighting.desk": "desk",
    "lighting.govee_strip_1": "accent",
    "lighting.govee_strip_2": "accent",
    "lighting.monitor_backlight": "backlight"
  },
  "computerDeviceId": "desktop"
}
```

| Role        | Meaning                                         |
| ----------- | ----------------------------------------------- |
| `main`      | The large white light, normally the ceiling.    |
| `desk`      | Task light by the computer.                     |
| `accent`    | Colour-capable lamps that may follow the music. |
| `backlight` | Bias light behind the monitor.                  |

Optional tuning (defaults shown):

| Key                   | Default  | Meaning                                                 |
| --------------------- | -------- | ------------------------------------------------------- |
| `computerDeviceId`    | only one | Computer in `mqtt.computers` whose activity is used.    |
| `idleAfterMs`         | `300000` | Idle time before the desk counts as empty (30 s–1 h).   |
| `settleMs`            | `4000`   | How long a new situation must hold before lamps follow. |
| `cinemaBrightness`    | `6`      | Accent brightness during full-screen video or games.    |
| `musicBrightness`     | `70`     | Accent brightness when the music colours lead.          |
| `minChangeIntervalMs` | `5000`   | Shortest spacing between two commands to one lamp.      |

Every target must also be a mapped light in `homeAssistant.entities`, and
`computerDeviceId` must be listed in `mqtt.computers`.

## Musik

1. A music player reports `playing` on a trusted observation.
2. Lugn takes the artwork the dashboards already show for that track (Home
   Assistant, or the computer's Spotify/inline artwork). It makes no new
   network request.
3. JPEG and PNG artwork is decoded and reduced to up to three vivid,
   well-separated colours (hue buckets weighted by saturation and brightness;
   saturation is raised and value set to full, because lamp brightness is set
   separately). Monochrome, near-black and undecodable artwork, and WebP/GIF,
   give no colours.
4. `accent` lamps, in a stable order, take those colours at `musicBrightness`.
   With a one-colour cover, the next lamps get neighbouring hues. Other lamps
   keep the scene's values.
5. A new track recolours the lamps. Changes below a visible difference are not
   sent again.
6. When playback stops, or the track has no usable colours, the scene is
   reapplied once and the lamps return to its definition, including any Govee
   animation.

## Dynamisk

The computer's observed state (the same Linux desktop agent used elsewhere)
selects one situation:

| Situation | When                                                                                                                   | `main`      | `desk`      | `backlight` | `accent`                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | ----------- | ----------- | ----------- | ------------------------------------------------- |
| `cinema`  | Full screen **and** video or game activity, not locked.                                                                | off         | off         | low, 6500 K | `cinemaBrightness`, warm, or dimmed music colours |
| `desk`    | The computer is in use; video or a game is playing in a window (even with no input); idle for less than `idleAfterMs`. | 60%, 4000 K | 80%, 4000 K | 35%, 6500 K | 30% warm, or music colours at up to 35%           |
| `lounge`  | Locked, or idle for `idleAfterMs` or more, while the room is occupied.                                                 | off         | off         | off         | 35% warm, or music colours at up to 55%           |
| `unknown` | No fresh computer observation, or it reports neither idle nor lock state.                                              | scene's own | scene's own | scene's own | scene's own                                       |

Video and games count as someone at the desk however long the keyboard has been
quiet. Time since last input comes from the agent's idle flag: Lugn counts from
when it first saw the computer idle, so a Lugn restart restarts that clock.

A new situation must hold for `settleMs` before lamps follow it, so a quick
alt-tab or a one-second full-screen flash does not change the room. Leaving
the room empty is never fought: while Lugn does not see the room as occupied,
or Home Assistant reports away, the room engine owns the lamps and this mode
does nothing.

**Not used yet:** where in the room you are. Room presence from the STL27L
sensor says only whether the room is occupied and by how many people. A nearby
position (at the desk or on the sofa) would need the finer network and
placement work that is not in place, so the computer's activity stands in for it.

## Safety and manual control

- Every change is an ordinary automatic lighting command through the room
  engine, with the actor `lugn.dynamic`. Holds, away/empty rules and external
  control (a Govee app effect selected on purpose) still apply and win.
- A lamp adjusted by hand is left alone until a scene is selected again.
  Selecting Musik or Dynamisk again starts them afresh.
- Choosing any other scene stops the mode at once.
- Commands to one lamp are spaced by `minChangeIntervalMs`, and white
  temperatures are sent per lamp so one lamp's white never retunes the others.
- Each change of decision is logged once as
  `[lugn] dynamic lighting (adaptive): cinema — fullscreen_media`.

## Evidence

Behavior is covered by deterministic tests against the real room engine with
simulated lamps, a simulated computer and a fake artwork source: situation
classification, per-role plans, settle and hysteresis, hand override, scene
reselection, release to the scene, artwork decoding and the Party migration.
These are software tests. No lamp has yet been observed following artwork or
dimming for a film, and the thresholds above are starting values.

## Where to explore next

- Brightness curve by time of day and daylight.
- Per-situation values in configuration or the preset editor.
- Presence position, once a finer-grained location signal exists.
- Palette smoothing for fast track changes, and a settings panel with a live
  explanation of the current decision.
