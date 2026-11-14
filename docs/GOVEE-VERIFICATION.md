# Govee effect verification — 14 November 2026

The current installed runtime, comparative measurements and saved-preset evidence
are recorded in [Govee performance and preset qualification](GOVEE-PERFORMANCE.md).
The sections below retain the earlier delivery and visual evidence separately.

## Initial LAN delivery

Both room strips and the table lamp now have Home Assistant effect selectors.
The separate `lugn-govee-effects.service` runs on BrunoCAM using the existing
protected Lugn environment, configuration and MQTT broker. It has no Govee
account credentials and no HTTP listener. It uses UDP 4002 on the existing LAN
address. Original Lugn releases and private deployment backups remain available.

## Installed controls

| Device           | Home Assistant selector            | Playable catalog variants |
| ---------------- | ---------------------------------- | ------------------------: |
| H612A strip      | `select.lugn_govee_strip_1_effect` |                       239 |
| H612F strip      | `select.lugn_govee_strip_2_effect` |                        77 |
| H6022 table lamp | `select.lugn_govee_table_effect`   |                        96 |

Each selector also includes **Lugn** (resume prior room intent) and **Extern
(okänd effekt)** (honest status after a companion-only restart). The latter is
not an effect command. Thus HA reports 241, 79 and 98 total options respectively.
The anonymous catalogs have 240, 78 and 96 entries; the strips' special code-zero
Sunrise entries are intentionally excluded from playback.

## Live evidence

All three selectors were invoked through authenticated Home Assistant
`select.select_option`, choosing Forest. Lugn handed off only the target lamp;
the companion transmitted its app-scene packet over LAN. Independent UDP queries
reported the target ON at 1% brightness. Other configured lamps remained OFF.
The handoff was ended using its generation ID, restoring prior room intent.
Power, master brightness and white temperature were checked again over LAN:

| Device | Before           | During effect command | Restored         |
| ------ | ---------------- | --------------------- | ---------------- |
| H612A  | OFF, 1%, 2700 K  | ON, 1%                | OFF, 1%, 2700 K  |
| H612F  | OFF, 54%, 2700 K | ON, 1%                | OFF, 54%, 2700 K |
| H6022  | OFF, 60%, 2700 K | ON, 1%                | OFF, 60%, 2700 K |

The final room snapshot was `scene.all_off`, all nine configured lamps OFF,
and no external-control leases. The existing H612A fönsterljus configuration
remains in place (always, brightness 55, sun elevation threshold 6); its policy
yields during an explicit effect and resumes after handback.

A separate broker-replay check stopped the companion, stored a retained Forest
command on its command topic, then restarted it. No external lease or lamp ON
occurred; all selectors remained Lugn and independent device queries remained
OFF. The retained test command was removed afterward. Offline catalog loading
was also verified with all network fetches deliberately failing: all three cached
catalogs still validated and produced the same playable counts.

These checks establish the installed command path, device power/brightness
feedback, target isolation, state restoration and rejection of retained command
replay. They do **not** establish visible Forest animation, scene fidelity or
support for every offered scene. Govee's `devStatus` has no active-scene field;
visual confirmation of those original Forest tests remains outstanding. No camera
footage was used.

## Subsequent user visual confirmation

During a later attended H612F demonstration, the selector was changed through
Rainbow B, Meteor shower and Aurora at approximately 30% brightness, leaving
Aurora selected. Asked whether different parts of the strip showed different
colors or movement, Bruno confirmed: "Ja, olika delar lyser eller rör sig".

This is user-reported visual evidence that the new H612F control path produces
segment animation. It does not identify which of the three scenes was observed
or establish exact fidelity for every scene. Visual confirmation for H612A and
H6022 remains outstanding.

## Software evidence

`npm run check` passed: formatting, ESLint, TypeScript, **111 suites / 1,800 tests**,
and both service-installer fixtures. `npm run build` passed. The Govee installer
fixture uses real systemd parsing, including paths with spaces, and substitutes
only service-manager actions so that it starts no local service.

Protocol tests match the upstream eight-frame Forest vector byte for byte and
cover H6022 transforms, bounds, anonymous fetches and distinct scene variants.
Engine tests cover stale transports, failed/ambiguous ON with physical OFF
compensation, generation-safe cleanup, exact manual-override restoration,
preserved OFF holds, window/daylight policy, confirmed exit and handback while
already empty. Bridge tests cover ownership checks and failure cleanup.
Independent reviews examined the protocol, bridge, ownership/recovery behavior
and window-specific handoff; concrete findings were repaired before final delivery.

## Expanded LAN/API delivery

The expanded implementation adds the H60A6 ceiling's 86 LAN scene variants and
63 official API scenes for the H600D GU10 identified as Brunos Skrivbord.
Broadcast discovery finds the H60A6 with LAN Control enabled. The API accepts the
installation's protected API key and returns all five physical fixtures; virtual
groups are filtered independently. No Govee account password is required and no
Bluetooth transport is installed or used by this companion.

Four API buttons address H60A6 main ON/OFF and outer-ring ON/OFF separately.
This device advertises separate power toggles but no separate zone brightness or
RGB controls. Its current API state contains empty zone values; therefore zone
light proxies remain unavailable until valid feedback exists, while explicit
buttons remain usable. API acceptance alone is not physical zone confirmation.
The ordinary ceiling mapping uses its existing Matter entity for whole-fixture
power and local room OFF.

The final expanded source passes formatting, ESLint, TypeScript, **113 suites /
1,850 tests**, both service-installer fixtures and the production build. An
independent review covered the expanded protocol and cloud bridge; findings in
virtual-device filtering, stale cloud power and handoff timeouts were repaired.
Pure encoder comparisons against the upstream implementation match all 86
H60A6 and 239 H612A playable variants, including app-specific parameter overrides.
These comparisons establish packet agreement, not observed firmware behavior.

The frozen runtime source is commit
`f79b9d3f0862be6e633a2ff9d376759ae761eda0`, installed at
`/home/bruno/lugn-govee-f79b9d3f0862`. All 347 installed `src`/`dist` file hashes
match the qualified host build. Both user services remain active with zero
automatic restarts; protected configuration, credentials and lighting state stay
outside the release. The source archive SHA-256 is
`3cb725c2faeeb7e78c6b829f0a840fe72d49d4f3356add60ce008f1cf37824ec`.

### Expanded live evidence

Home Assistant discovered five **Appanimation** selectors (241, 79, 98, 88 and
65 total options), plus four explicit ceiling zone buttons. The existing three
selector entity IDs were preserved. Ceiling zone light proxies remain honestly
unavailable because the platform returns empty zone states.

Authenticated HA selections sent Forest to all four LAN fixtures, and Aurora to
the ceiling. Fresh independent UDP reads reported the target ON at 10% brightness
and other configured fixtures OFF for each selection. All four were returned to
OFF. The first ceiling restoration check found its master level normalized to
1% after Matter OFF; the original 100%/4000 K setting was restored and independently
read back while OFF. The packet/status tests do not establish visible scene
fidelity because the LAN protocol has no active-scene feedback.

The room then entered its ordinary everyday-light scene. An OFF-only GU10 test
preflight cancelled before mutation; the attended rerun preserved the active
room scene. Forest and Aurora each produced a fresh `cloud_accepted` diagnostic,
with the GU10 independently reporting ON through Matter at approximately 10%.
Govee's scene state remained empty, so its selector correctly reported
**Extern (okänd effekt)** rather than presenting the requested scene as confirmed.
The GU10's original 48%/2700 K setting and ON room intent were restored, and
other room-light power states were unchanged.

Each ceiling main/ring ON/OFF button produced a fresh API acceptance diagnostic.
The attended two-stage test requested main ON/ring OFF and then main OFF/ring ON.
Bruno reported seeing the main light alone, an intermediate period with both
parts lit, then the ring alone, followed by OFF. This is user-reported visual
evidence of independent zone power control; it also shows delayed transitions
between separate cloud commands. It does not establish independent zone RGB,
brightness or animation editing. API zone readback remained empty throughout.
A final ring-ON test then invoked ordinary `lighting.set({power:false})` through
the existing Matter entity. Independent LAN feedback changed from ON at 10% to
OFF; this confirms the normal local OFF path also reaches a lit ring. Its master
level again normalized to 1% on Matter OFF, and was restored to the original
100% while the fixture remained OFF. No external-control leases remained and
other everyday room lighting was preserved.

App scene editing/speed controls, DIY uploads, music modes, AI and DreamView are
outside the installed bridge. See [operation and rollback](GOVEE-EFFECTS.md).
