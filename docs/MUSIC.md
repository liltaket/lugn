# Music

Music should be helpful and contextual without fighting direct WiiM control.

## Implemented Home Assistant bridge

The local runtime can map multiple semantic `music.*` targets to explicitly
configured Home Assistant `media_player.*` entities. This supports a WiiM when
its Home Assistant integration exposes the required services and attributes.
Direct WiiM transport remains pending.

The implemented capabilities are `music.getState`, `music.play`, `music.pause`,
`music.setVolume` (0..1), and `music.selectSource`. Source names must appear in
the target's configured `sources` allowlist; copy their exact spelling from the
entity's Home Assistant `source_list`. An empty allowlist disables source changes.
The bridge uses the fixed media player services documented by
[Home Assistant](https://www.home-assistant.io/integrations/media_player/).

Observed playback, volume, source, media title and availability remain separate
from requested values. The initial REST snapshot and later WebSocket events
provide observations. Each request records its provenance and status. HTTP
acceptance leaves it `pending`; a new matching HA observation within 10 seconds
marks it `confirmed`; timeout marks it `unconfirmed`; dispatch failure records
`failed`. Newer requests supersede pending requests for the same target and
property. Independent playback, volume and source requests can coexist.

Volume matching allows a difference of 0.005 in HA's 0..1 scale. Cached observations
from before a request cannot confirm it. Matching only proves HA reported the
expected state; an external action to the same value can also satisfy it. The
observation keeps its HA provenance, and no volume change creates manual ownership.
There are no retries, presets, fades, presence-driven playback or source automation
in this bridge. The design sections below describe future behavior.

## First-class concepts

The model should distinguish at least:

- playback
- volume
- source
- preset / playback choice

These can have different ownership.

Example:

    playback = automation
    volume   = user
    source   = automation

A user volume change should not necessarily disable pause-on-empty.

## Presets are important

WiiM presets are a useful first-class behavior because they can represent ready-to-play choices without Lugn having to directly source and construct playback every time.

Possible conceptual capabilities:

- play preset
- resume
- play
- pause
- set volume
- fade volume
- set source

Presets may point to things such as playlists or Spotify DJ, allowing varied playback without the room engine understanding the streaming service in detail.

## Optical / computer integration

Automatic switch to Optical when the computer is being used is valuable.

It must still respect explicit user choices.

Example:

    PC activity starts
    -> automation chooses Optical

    user later selects a WiiM preset
    -> source/preset becomes externally owned
    -> PC automation must not immediately switch back to Optical

The exact reset/continuity policy for source ownership remains to be refined.

## Autostart

Music start should be event-driven rather than repeatedly polling "is music absent?"

Typical rules:

- first confirmed person entering may start/resume music;
- last confirmed person leaving pauses immediately;
- count changes such as 1 -> 2 do not create a new music session;
- an allowed-time window can prevent late-night autostart;
- crossing the end of that window should not stop already-playing music.

Process restart or sensor reconnection must not look like a new room entry.

## Continuity

Short absence:

- pause immediately on exit;
- keep preset/source/volume context;
- restore or resume on quick return when appropriate.

Long absence:

- selected music context can expire;
- next visit may use normal autostart policy again.

This prevents cases such as returning from a short bathroom break and having Spotify start over whatever computer media the user was just watching.

## Fades must remain

Volume fading is a desired feature.

The attribution system must understand a fade as a trajectory rather than a single target.

Conceptually, for a fade:

    start = 30
    target = 50
    duration = 8 s
    tolerance ≈ +/- 2
    settling window = configurable

During the fade:

- values reasonably on the expected path are treated as self-generated feedback;
- small quantization/timing differences are tolerated;
- a strong move away from the expected trajectory may be interpreted as external/manual control;
- before later fade steps, the engine should check whether the observed state still supports continuing.

After the fade, a short settling period allows delayed device feedback without falsely creating an override.

Exact tolerances and timing must be measured against real WiiM behavior rather than assumed permanently.

## Command attribution

The system should prefer, in order:

1. explicit source/context IDs where an adapter provides them;
2. matching against pending commands;
3. expected trajectory and timing;
4. tolerance for rounding/quantization.

There is an unavoidable ambiguous case when a person manually selects exactly the value the automation was already about to choose. Without provenance from the device, perfect attribution is impossible.

Design priority:

> Avoid false manual overrides caused by Lugn's own commands, while still respecting clearly external changes.

## Manual pause

A manual pause should not be immediately undone by presence automation.

The exact lifetime of playback ownership should be governed by continuity/reset policy rather than a single global passive flag.
