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
        "id": "entrance-motion",
        "name": "Rörelse vid entrén",
        "cameraId": "entrance",
        "kind": "state",
        "entityId": "binary_sensor.entrance_motion",
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
(configurable from 5 to 120). Manual camera buttons work independently of the
automatic switch. Preferences use atomic, mode-600 persistence in
`<statePath>.cameras.json`, with generation checks to avoid overwriting another
editor. Disabling previews or changing settings closes existing previews.

Triggers can also observe a configured `automation_triggered` event, or an exact
`media_player.play_media` service event (entity plus `mediaContentId`). These
observe existing activity and never invoke or modify that automation/service.
Do not guess a speaker or match all speaker activity when the existing signal
is unknown: use an explicitly configured motion edge instead.

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
