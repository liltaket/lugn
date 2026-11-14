# Govee effect verification — 14 November 2026

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

Live expansion command tests and physical feedback are recorded separately from
this pre-deployment software qualification. Existing user visual confirmation
above applies only to H612F.

App scene editing/speed controls, DIY uploads, music modes, AI and DreamView are
outside the installed bridge. See [operation and rollback](GOVEE-EFFECTS.md).
