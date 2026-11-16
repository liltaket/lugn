# Paired-device API (v1)

This is the server contract for Lugn's native iOS app. The machine-readable
contract is [api/openapi.v1.yaml](api/openapi.v1.yaml), generated from the Zod
schemas in `src/core/device-api.ts` with `npm run api:generate`. A test fails
when the committed document is stale. This page describes behaviour the
schemas cannot express.

## Reachability and transport

- One separate listener, **off by default**, configured under `device` in
  `config.json` (see [OPERATIONS.md](OPERATIONS.md#paired-device-api-native-app)).
- It is reached over Tailscale or the LAN only. There is no WAN exposure and
  no port forward. The listener is plain HTTP; Tailscale provides transport
  encryption. On a LAN without Tailscale, traffic is not encrypted.
- The client must send a Host header that exactly matches one of the
  configured `allowedHosts` (`host:port`). Anything else returns `421`.
- The API is for native clients. Requests carrying an `Origin` header return
  `403 browser_origin_not_allowed`, no CORS headers are sent, and `OPTIONS`
  returns `405`. There are no cookies.
- All JSON responses carry `Cache-Control: no-store` and
  `X-Lugn-API-Version: 1`. Errors use `{ "error": "<code>" }`, with `issues`
  for validation failures and `retryAfterSeconds` for `429`.
- iOS App Transport Security: the app needs an ATS exception for plain HTTP to
  the configured host (for example `NSAllowsLocalNetworking` plus an exception
  domain for the MagicDNS name).

## Pairing and tokens

1. The operator creates a one-time pairing code in the authenticated control
   panel API (`POST /ui/api/devices/pairing`) or on the host's loopback API
   (`POST /devices/pairing`). The code looks like `7K3Q-M9TD`, is valid for
   five minutes (60–900 s configurable per code) and can carry a subset of
   scopes. At most four codes are outstanding; ten wrong guesses invalidate
   all of them.
2. The app calls `POST /api/v1/pair` with `{ code, name, platform: "ios",
appVersion? }`. Codes are case-insensitive and the dash is optional.
3. The response contains `deviceId` and `token`. **The token is shown once.**
   Store it in the Keychain. Lugn stores only its SHA-256 digest.
4. Send `Authorization: Bearer <token>` on every other request.
   `GET /api/v1/me` confirms the token and returns the server clock.

Tokens look like `lgn1.<deviceId>.<secret>` and are compared in constant time.
A `401` means the token is unknown or was revoked: discard it and ask the
user to pair again. Revocation also closes that device's live streams.

| Scope            | Grants                                       |
| ---------------- | -------------------------------------------- |
| `state:read`     | `GET /api/v1/state`, `GET /api/v1/events`    |
| `commands:write` | `POST /api/v1/commands`                      |
| `phone:ingest`   | `POST /api/v1/phone/observations` and config |

## Limits

| Budget (per device unless noted)    | Burst | Sustained |
| ----------------------------------- | ----- | --------- |
| Reads (`state`, `me`, config)       | 60    | 120/min   |
| Commands                            | 20    | 60/min    |
| Phone observation batches           | 30    | 60/min    |
| New event streams                   | 6     | 6/min     |
| Pairing attempts (per address)      | 5     | 5/min     |
| Failed authentication (per address) | 10    | 10/min    |

Exceeding a budget returns `429` with `Retry-After`. Request bodies are
limited per route (`x-lugn-max-bytes` in the OpenAPI document); larger bodies
return `413`. A body must be `application/json` (`415` otherwise).

## Provenance

The server derives provenance; the client cannot set it. A command from a
paired phone runs as a human actor `{ type: "user", id: "mobile:<deviceId>" }`
with `source: "lugn.mobile"`, so manual-override rules treat a phone tap like
any other explicit human action. Phone observations are never actor
commands; they are hints with their own provenance (see below).
