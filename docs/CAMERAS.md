# Event camera previews

Camera previews are an optional, local-first dashboard feature. Home Assistant
observations can temporarily show an allowed camera on Bed, Desk and/or `/ui/`.
The selected scene controls and music transport remain accessible. Closing a
preview suppresses automatic reopening on that screen for 60 seconds. An
automatic event never replaces an active manual preview.

## Configuration

Add an allowlist to the protected runtime configuration:

```json
{
  "cameraDashboard": {
    "cameras": [
      { "id": "entrance", "name": "Entré", "entityId": "camera.entrance" }
    ],
    "triggers": [
      {
        "id": "entrance-person",
        "name": "Person vid entrén",
        "cameraId": "entrance",
        "kind": "state",
        "entityId": "binary_sensor.entrance_person",
        "from": "off",
        "to": "on"
      }
    ]
  }
}
```

Everything starts disabled. In `/ui/` → Intelligence → camera settings, enable
previews, select cameras/screens and save. Automatic previews have a separate
switch and individual trigger selections. Duration defaults to 30 seconds
(configurable from 5 to 120). An active, enabled state detector for the same
camera can extend the view to twice that duration: **30 seconds normally, at most
60 seconds with continuing activity** with the defaults. If all relevant
detectors turn off before 30 seconds, the view closes at 30. If activity is still
present at 30, the extension is fixed through 60, even if the detector turns off
at 35. No event can push the maximum deadline further. Manual views use the same
rule. Only the configured detector categories participate; generic motion is
never inferred. Close always cancels immediately.

Manual camera buttons work independently of the
automatic switch. Preferences use atomic, mode-600 persistence in
`<statePath>.cameras.json`, with generation checks to avoid overwriting another
editor. Disabling previews or changing settings closes existing previews.

Triggers can also observe a configured `automation_triggered` event, or an exact
`media_player.play_media` service event (entity plus `mediaContentId`). These
observe existing activity and never invoke or modify that automation/service.
Do not guess a speaker or match all speaker activity when the existing signal
is unknown: use an explicitly configured motion edge instead.

## Prefer existing object detection

Use the camera's existing HA **person, animal or vehicle binary sensors** as
individual state triggers. Each enabled trigger is an independent alternative:
any fresh `off` → `on` edge may open its mapped camera. Enable only the categories
wanted in `/ui/`. Lugn does not classify images or require generic motion as a
second condition.

Generic motion also responds to foliage and lighting changes. Do not configure
it as a fallback for missing/unavailable object sensors: a missing classification
must not silently turn into all-motion triggering. A camera without supported
object sensors can remain available for manual viewing with no automatic trigger.

The [HA Reolink integration](https://www.home-assistant.io/integrations/reolink/)
exposes the camera's supported detection types. Support depends on the camera and
hardware; see [Reolink's smart detection support](https://support.reolink.com/articles/5114827897497-Which-Camera-Supports-Smart-Detection/).
Existing detector accuracy and sensitivity remain those of the camera/HA setup.
This setting does not change camera detection, recording, chimes or automations.

## Privacy and lifecycle

The browser receives display names, opaque active-view IDs and same-origin
image routes, never HA credentials, entity IDs or upstream image URLs. The
backend fetches only allowlisted HA camera endpoints, rejects redirects and
non-JPEG responses, limits bodies to 1 MiB, times out after four seconds and
shares a short memory cache across screens. No images are persisted. Requests
are limited to two upstream camera fetches at a time and require a currently
active view on the authenticated screen. UI actions require the existing
session, origin and CSRF protection; Hub paths retain their per-device secret.

The dashboard fetches refreshed JPEG previews, at most one request at a time,
about once per second. The last successful update time is shown; these are not
labelled as a live video stream. Closing, hiding, expiry or loss of dashboard
connection aborts browser work and clears the image. Missing/slow cameras do
not block room controls.

Fresh motion edges are accepted only after an authenticated HA subscription
and state reconciliation. Disconnect clears views and baselines. Stale,
duplicate and buffered reconnect events do not open a preview. Active views
are never restored after restart. This subsystem does not invoke lighting,
music, camera PTZ, speaker, doorbell or gate capabilities.

## Interface previews

These screenshots use simulated camera imagery and room state; they contain no
private camera images or credentials. Layouts were checked without horizontal
overflow or browser errors at Bed 1024×600, Desk 1280×800, desktop 1440×1000 and
mobile 390×844. The mobile image includes the expanded preference editor.

[Bed](images/cameras/bed.png) · [Desk](images/cameras/desk.png) ·
[Desktop](images/cameras/web-desktop.png) · [Mobile](images/cameras/web-mobile.png)
