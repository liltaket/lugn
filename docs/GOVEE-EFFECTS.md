# Local Govee app effects

The optional Govee companion exposes app scene variants as Home Assistant MQTT
select entities. It uses the existing MQTT credentials and Lugn machine API.
The LAN devices need no Govee account credentials. The optional official
Govee API path needs an API key supplied through a protected environment file;
it does not need the account password. No Bluetooth transport is used by this
companion. Existing integrations remain available; normal whole-fixture power
and room OFF continue locally through Lugn's configured HA entities.

In Home Assistant choose an option on `select.lugn_govee_strip_1_effect`,
`select.lugn_govee_strip_2_effect`, `select.lugn_govee_table_effect`,
`select.lugn_govee_ceiling_effect` or `select.lugn_govee_gu10_effect`.
The two strips, table lamp and ceiling use LAN scene packets. The GU10 uses
Govee's official Wi-Fi/cloud scene API.
Select **Lugn** to restore the lamp's prior room lighting and manual overrides.
Ordinary explicit Lugn lighting controls and scene selections also take control
back. Effects selected directly in the Govee app are outside this handoff.

The selector reports the requested effect after UDP transmission. Its diagnostic
sensor reports `udp_sent`; this is not confirmation that the firmware displayed
the animation. `devStatus` reports power, brightness, color and temperature but
not the active scene. After a companion-only restart an existing handoff appears
as **Extern (okänd effekt)** until a new choice is made. This is a status option,
not an effect to play.

## Ceiling main light and outer ring

The ceiling's main light and ring have separate official API toggle capabilities.
The following Home Assistant buttons address only the named part; they never
substitute the fixture's global power command:

- `button.lugn_govee_ceiling_main_on` / `button.lugn_govee_ceiling_main_off`
- `button.lugn_govee_ceiling_ring_on` / `button.lugn_govee_ceiling_ring_off`

These buttons remain usable when Govee returns an empty per-zone state. Separate
zone light entities are unavailable until the API reports valid zone feedback;
they do not pretend to know whether a command reached the physical LEDs.
The API currently advertises no per-zone RGB or brightness capability for this
H60A6, so the new zone controls expose on/off only. The existing whole-lamp
brightness/color controls remain available. App animations are fixture scenes;
independent ring-only animation with a separately fixed main color is not promised.

Lugn's ordinary ceiling mapping uses its existing Matter entity. Room-wide OFF
therefore remains local and switches off the whole fixture, including the ring.
A zone command first obtains a handoff with `activate:false`, which prevents
Lugn from globally switching on both parts before the zone command is sent.
A later explicit Lugn scene or the **Lugn** effect option resumes normal room
control. Failure recovery restores the original room intent; it cannot replay
an earlier device animation.

## Scope

The tested LAN catalog encoder supports H612A, H612F, H6022 and H60A6.
H600D uses the official platform API in this installation. Actual LAN
support and LAN Control must also be available on each device; a catalog entry
alone does not establish device support. The bridge discovers devices by their
configured Govee identifiers and SKU, rather than assuming a fixed lamp IP.
It binds UDP 4002 on its configured LAN address and sends on 4001/4003.
Set an explicit `broadcastAddress` when multicast discovery misses a device;
subnet broadcast finds this H60A6 where multicast alone did not.
Run it on a host separate from any integration already using that reply port.

The anonymous Govee endpoint supplies model scene definitions once at startup.
Validated definitions are cached; an existing cache allows offline startup and
subsequent LAN scene choices use only LAN traffic. GU10 scenes and ceiling-zone
API toggles require an internet connection and a valid Govee API key. App variants are separate choices.
The special Sunrise scene with code zero is excluded. Unsupported packet formats
are excluded rather than sent speculatively.

This does not expose app scene editors, effect speed controls, custom DIY
uploads, music synchronization, finger sketch, AI generation or DreamView.
Those features require separate protocol support. Govee firmware can silently
ignore a correctly encoded scene, so physical results still need observation.

## Interaction with room control

`lighting.beginExternalControl({target})` grants session-only external ownership
and returns a `controlId`. `activate:false` skips the global ON command when
the external controller will operate one zone itself. It drains older target transports, supersedes stale
commands, and switches on using power only. Automatic static color and brightness
reconciliation yields for that target. Other lamps keep their existing behavior.
The bridge checks the returned generation immediately before sending the scene.
Window lighting yields its sun/brightness policy for the duration of the handoff.
An unrelated human command can still occur between that check and UDP delivery;
the two processes do not offer an atomic transaction across the physical device.

Confirmed exit still switches off the lamp. The bridge does not replay an effect
on return, restart, broker reconnection or shutdown. An explicit human selection
can turn a lamp on while the room is already empty, matching normal Lugn controls.
An observed external whole-fixture OFF releases the handoff and saves an OFF
hold, so restarting cannot restore a stale ON intent. Ordinary confirmed-empty
OFF commands remain attributed to Lugn and preserve the logical handoff.
Direct HA or physical color changes do not release external ownership because
those observations cannot reliably distinguish an effect from a human change.
Use a Lugn control or the **Lugn** option to end the handoff explicitly.

`lighting.endExternalControl({target, expectedControlId?})` restores prior intent;
the optional ID protects failure cleanup from overwriting a newer selection.
On Lugn restart the pre-handoff intent and OFF holds are restored; external
ownership and device effects are not durable intent. Software tests cover target
isolation, stale delivery, exit boundaries and handoff failure recovery.

## Installation

Build Lugn, retain the installation's private config/environment/state, and copy
`config.govee-effects.example.json` to a private configuration file. Replace
example device identifiers with real scan responses. Match `cacheDirectory` to
`~/.local/state/lugn-govee`; the service grants write access only there.

A read-only probe validates catalogs and queries device status without MQTT
publication, Lugn capabilities or light-control commands:

```sh
node --env-file=/secure/lugn.env dist/runtime/govee-effects-bridge.js \
  /secure/lugn-config.json /secure/govee-effects.json --probe
```

Install the separate user service with explicit absolute paths:

```sh
deploy/install-govee-effects-service.sh /absolute/node /absolute/lugn-release \
  /secure/lugn-config.json /secure/lugn.env /secure/govee-effects.json \
  /secure/govee-platform.env
systemctl --user enable --now lugn-govee-effects.service
```

The sixth installer argument is optional for LAN-only installations. When the
bridge config contains `platform`, supply the separate protected environment file
with the key referenced by `platform.apiKeyEnv`; for example
`GOVEE_API_KEY_B64` using canonical base64url encoding. Never put the key in JSON,
MQTT payloads, URLs or repository files.

The installer does not start services or modify the existing Lugn unit, config,
credentials or state. The main Lugn runtime must include the external-control
capabilities before effect commands can work. MQTT discovery needs no HA restart.
Commands use clean sessions and are neither retained nor replayed after a lost
connection. The process has no HTTP listener.

To roll back, stop and disable `lugn-govee-effects.service`, restore the prior
Lugn release selection, and restart Lugn. Discovery entities remain unavailable
until removed through HA or their retained discovery topics are cleared.

## Sources

The independent encoder uses the documented packet format and Forest test vector
from [govee2mqtt](https://github.com/wez/govee2mqtt/blob/main/src/ble.rs), its
[LAN scene transport](https://github.com/wez/govee2mqtt/blob/main/src/lan_api.rs)
and [anonymous catalog access](https://github.com/wez/govee2mqtt/blob/main/src/undoc_api.rs).
H6022 parameter transforms follow
[AlgoClaw's decoded model parameters](https://github.com/AlgoClaw/Govee/blob/main/decoded/v1.2/model_specific_parameters.json).
Cloud capabilities and commands follow [Govee's official API](https://developer.govee.com/reference/control-you-devices).
Discovery follows [HA MQTT select](https://www.home-assistant.io/integrations/select.mqtt/).

For installed entities and validation evidence, see [live verification](GOVEE-VERIFICATION.md).
