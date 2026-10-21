# Authorized live candidate test — 21 October 2026

After the isolated overnight delivery, the user explicitly authorized uploading,
test deployment and real room control. The initial no-actuation evidence in
[VERIFICATION.md](VERIFICATION.md) remains historical; the checks below are separate
live evidence. Permanent promotion and merging are still pending user review.

## Deployment

- Candidate `91335a4` was staged and built in its own immutable release on
  BrunoCAM, then replaced by reviewed artwork-fix candidate `7b2a9ca`.
- A runtime-only systemd override selects the candidate. The installed service
  definition and original `fceced7` release remain intact for rollback.
- A private copy of the saved lighting/music intent, presets and volume settings
  is used for this test. Original configuration and state are preserved. No
  credentials were copied into Git, browser URLs, screenshots or ordinary output.
- Exactly one room controller runs. The existing LAN proxy remains active.
- Read-only commissioning found all 10 configured HA entities, authenticated HA,
  connected MQTT and a fresh online presence feed. Candidate health is `ok` with
  both integrations connected and zero automatic service restarts.

## Live checks

- Both real Nest receivers received dashboard reload requests and maintain
  display connections. This establishes page/network activity; the user's visual
  review of the physical screens remains necessary.
- The actual Hub application was inspected against live backend data at
  1024 × 600 with no page overflow. Bed/Desk hierarchy and manual controls remain.
- WiiM volume changed from 36% to 31% and back to 36%. HA feedback confirmed both
  requests. Playback remained paused, source stayed unchanged and volume mode
  stayed manual. This is device-feedback evidence, not an audibility test.
- An available table lamp was commanded to 5% and HA reported it on at that
  brightness. It was returned to off, with confirmed feedback. Cleanup checked
  that the test still owned the change before restoring.
- Real HA artwork initially failed because the validator rejected HA's standard
  `token=…&cache=…` image URL. The reviewed fix accepts only a bounded safe cache
  value on the already permitted fixed HA proxy endpoint. Live artwork then
  became available and decoded successfully in the Hub browser.
- The usual HTTPS desktop URL loads the configured Clerk sign-in. An authenticated
  desktop editing session was not exercised by the agent; sign-in was not bypassed.
- Both routine templates, Optical suggestions and scene suggestions remain
  disabled. No scheduled routines, automatic Optical changes or scene automation
  were enabled. Music was not started and sources were not switched by these tests.

Two configured Govee lights currently report unavailable/degraded observations;
they were excluded from control testing. This was not established as a code regression.

## Software evidence and remaining work

The artwork fix passed independent read-only security/correctness review and
58 mocked artwork tests. Full checks passed **83 suites / 1,298 tests**, plus the
installer fixture, formatting, lint, typecheck and build. Existing SSRF, trust,
cache-bound and opaque-URL protections remain covered. The change is appended
normally to draft PR #84; no published stack history was rewritten.

Still unperformed: audible playback/source-switch testing, real scheduled wake
or bedtime sequences, authenticated desktop editor flows, a long hardware soak,
and user assessment of actual Hub rendering/performance. These remain distinct
from the deterministic simulated tests and the live checks above.

All five PRs remain drafts and unmerged. The candidate is left active for review;
its temporary service override is not a permanent release promotion. Original
rollback tooling and private backups remain on the service host.
