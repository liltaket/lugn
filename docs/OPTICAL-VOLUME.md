# Optical volume compensation

The Music settings editor provides an optional volume correction for a configured
Optical input. The initial suggested correction is **+7 percentage points** on the
player's volume scale. It can be adjusted from 0 to 20 points or switched off.
This is a calibration aid, rather than a measurement of physical loudness.

Each player has an explicit input mapping. For example:

```json
{
  "opticalOffsets": {
    "music.room": {
      "enabled": true,
      "source": "Optical In",
      "offset": 0.07
    }
  }
}
```

The source must match a source configured for that player. Existing installations
load with an empty mapping and retain their previous behavior. Choosing a source
or editing the amount only changes the editor draft; Enable and Save apply it.
The editor retains unsaved choices during live source and state updates.

## Volume intent

The correction is separate from the saved Auto baseline, daily curve, person
adjustment and selected Auto/Manual mode. A 30% neutral target becomes 37% on the
mapped Optical input and returns to 30% on Spotify. Repeated switches must not
accumulate corrections.

A manual adjustment on Optical is interpreted on the player's physical volume
scale, then stored with the correction removed. For example, choosing 42% on
Optical with a seven-point correction means a 35% neutral manual reference.
Changing to Spotify therefore produces 35%, while returning to Optical produces
42%. Genuine manual adjustments continue to take priority over pending work.

Auto targets include the correction before applying the existing configured
minimum and maximum. Manual targets retain their existing 0–100% bounds. Clipped
feedback must not replace the neutral reference. The feature sends existing typed
volume commands; it never starts playback or selects an input itself.

Optical compensation has its own enable switch and also works when daily volume
automation is disabled. Room presence, home/away, trustworthy feedback and active
user fades continue to restrict automated commands.

Source changes and the corresponding volume feedback are handled as source
compensation, rather than a new user volume reference. This includes the player's
native volume restoration during a source transition and delayed command echoes.
Only trustworthy, settled source observations permit compensation. Unknown or
unavailable state cannot trigger a guessed adjustment.

Native volume restoration without explicit provenance has a bounded two-second
source-transition window. Explicit user volume commands remain authoritative.
An exact match to a previously remembered input volume is recognized for up to
four seconds after a source transition.
An unknown volume change arriving after the two-second window is treated as
possible human intent; observations alone cannot reliably distinguish a late
restore from a volume change on the player's remote.

## Persistence and verification

Mappings use the existing atomic volume-settings store. The logical music intent
also preserves the neutral reference needed to avoid drift after restarting.
Older releases do not understand the added strict-schema fields. Before rolling
back, retain the failed release's files and restore compatible volume settings
and logical intent from the pre-upgrade backup. Keep unrelated settings intact.

Regression checks use simulated players and fake clocks. Screenshots show the
simulated editor: [desktop](images/optical-volume/desktop.png) and
[mobile](images/optical-volume/mobile.png). Real source switching, sound-level
matching and device-specific volume restoration require a physical listening
check; they are not established by simulation.
