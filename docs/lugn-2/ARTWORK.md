# Workstream E: local Home Assistant artwork

This slice supplies a server-only HA metadata store, an optional artwork provider,
and authenticated Hub/web image delivery. Runtime composition shares the provider
between both surfaces. It introduces no automation or external metadata lookup;
construction performs no network contact. All development evidence uses fake HA,
FakeClock and loopback HTTP.

## Integration API

`src/core/artwork.ts` defines the shared `ArtworkMap` shape from DELIVERY.md and
`ArtworkProvider`:

```ts
snapshot(state: RoomState, pathPrefix: string): ArtworkMap;
read(token: string, state: RoomState): Promise<ArtworkAsset | null>;
subscribe?(listener: () => void): () => void;
```

`HomeAssistantMusicAdapter.artworkMetadata(target)` returns a defensive copy of
`HomeAssistantArtworkMetadata | null`. This is **server-only** metadata. Never
include it in public state, API responses or logs: HA image paths can carry access
tokens and media content IDs can be private URLs. Only optional `artist` and
`album` fields enter `MusicObservationValues`; missing values remain omitted to
preserve existing fixtures. Accepted startup/event states update the private
store before emitting ordinary feedback. Stale events are ignored; pure
`readStatus()` verification does not change this store. Missing/unavailable data
clears old metadata.

Instantiate the service from existing trusted config, passing the adapter getter:

```ts
const artwork = new HomeAssistantArtworkService(
  {
    baseUrl: configuredHaBaseUrl,
    token: configuredHaToken,
    entities: semanticTargetToHaEntityId,
    metadataProvider: (target) => haMusic.artworkMetadata(target),
    observationTrusted: (target) => currentHaObservationTrusted(target),
    excludedSources: semanticTargetToComputerInputSourceArray,
  },
  fetch, // Inject a fake transport in tests. Construction never calls it.
  clock,
);
```

`entities` maps each semantic target directly to its `media_player.*` entity ID,
not to the full music configuration object. `excludedSources` should contain
configured computer audio inputs (for example Optical In) so a receiver's stale
album art cannot be presented as computer media artwork. `observationTrusted`
defaults to true; compose it with current subscription/per-target reconciliation
trust, or filter untrusted devices before **both** snapshot and read. Metadata
must also match the current room state's source/title/artist/album.

Pass `artworkProvider: artwork` to `LugnDisplayServer`. It adds top-level `artwork`
to polling and SSE, and serves only issued 32-character tokens at
`/k/<hub-secret>/display-api/artwork/<token>`. It applies the existing secret-path,
Host and Origin validation; rejects cross-site fetches and query parameters;
and serves image bytes with safe MIME, nosniff, same-origin resource policy and
no-store. No artwork provider produces `{artwork:{}}`, preserving staged rollout.
Resolution notifications trigger a fresh SSE snapshot without changing engine
state or room revisions. Server shutdown unsubscribes its SSE consumers; runtime
composition owns `artwork.dispose()` to cancel pending work and clear memory.

For the lead-owned authenticated web endpoint, use
`snapshot(state, '/ui/api/artwork/')` and `read(token, currentState)` with the
existing web authentication and Host/Origin policy. Return 404 for null; otherwise
send `asset.body` with `asset.contentType`, `Content-Length`,
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and
`Cross-Origin-Resource-Policy: same-origin`. Subscribe for web SSE invalidation.
Neither method accepts a client URL. Do not expose private HA metadata alongside
this projection. Keep provider instances shared between Hub/web listeners so
upstream fetches and memory limits are shared too.

## Resolution and bounds

A snapshot schedules background work and returns immediately. While a valid
candidate is pending or failed it projects `{url:null,status:'unavailable',
source:'home_assistant'}`. A missing/ineligible picture projects
`{url:null,status:'missing',source:null}`. Only successfully cached image bytes
produce `available` and a same-origin URL. Clients use their fixed-size fallback
for both null URL cases. Image requests themselves never initiate network I/O.

The upstream is fixed to the configured HA base URL, including any fixed pathname
prefix. Both canonical `/api/...` pictures and pictures including that exact
configured prefix resolve under the fixed prefix. Allowed canonical forms are:

- `/api/media_player_proxy/media_player.<mapped_entity>`
- `/api/image_proxy/image.<entity>`

An optional single `?token=` containing only ASCII letters, digits, `_` and `-`
(up to 256 characters) is allowed. All absolute URLs, encoding, traversal,
backslashes, unexpected queries, fragments, other HA endpoints and mismatched
media-player entities are rejected. Redirects are never followed. The HA bearer
credential is added only to the fixed upstream request and no transport errors
or credentials are logged. Configured base URLs retain the existing HTTP(S),
no-userinfo/query/fragment restrictions and support fixed path prefixes.

Defaults, configurable through `HomeAssistantArtworkOptions`:

- 64 cache entries, 8 MiB cached bytes, 2 MiB per image, two concurrent fetches.
- Three-second deadline covers headers **and** streamed body, using injected Clock.
- Five-minute positive TTL, 30-second negative TTL, using monotonic elapsed time.
- Only JPEG, PNG, WebP and GIF; MIME and initial signature must agree. SVG and HTML
  are rejected. Both declared and actual streamed sizes are bounded.

Track identity includes source, title, artist, album, media content ID, picture
path and the adapter's private metadata generation. Volume-only observations
retain identity. A → B → A changes generation even if no intermediate snapshot
was requested, preventing reuse of artwork fetched through HA's mutable
media-player endpoint during a different track. Old tokens fail against current
metadata/state, expiry or eviction; stale in-flight completion is discarded.
Byte pressure temporarily drops the least recently used image to a negative
entry so resolution notifications cannot create a refetch loop. If current
players exceed configured entry capacity, only the first capacity-sized set is
admitted; others retain a fallback. In-flight buffers are additionally bounded
by concurrency times the per-image limit. Read results defensively copy bytes.

## Computer artwork follow-up

The optional v1 `media.artwork` extension carries a strict Spotify image ID or a
bounded inline JPEG, never an arbitrary URL/path. Both the Linux agent's
`collect_artwork` and the receiver mapping's `computerAudio.artwork` must be
explicitly enabled. Spotify CDN requests use a fixed HTTPS host/path, no bearer
credentials, no redirects and the same cache/time/size limits as HA images.
Firefox thumbnails come from a tightly restricted local cache and are resized
by the agent. No external metadata search or YouTube API is used.

The runtime shares one `ComputerNowPlayingSelector` between artwork and Hub
presentation. Only the selected fresh online player on the observed mapped
Optical input can supply an image; unavailable/ambiguous/stale observations and
untrusted receiver reports revoke its token. Spotify IDs and inline bytes are
immutable image identities, so old in-flight images cannot replace a newer
track's image. Both providers share cache budgets and authenticated opaque image
routes. See [computer opt-ins and privacy](../COMPUTER.md).

## Deliberate limitations

HA integrations supplying
absolute remote artwork, `/local/` files, camera proxies, unsupported MIME or
non-allowlisted image paths receive a harmless fallback. No metadata lookup is
performed to guess an image.

Correct matching is limited to HA's reported metadata: identical track metadata
with no changing content ID/picture cannot reveal a track change. The provider
cannot prove HA itself supplied the right image. Real HA/network/device behavior,
physical displays and browser rendering require separate live validation.

## Validation

Focused tests cover optional schema compatibility, private metadata, missing and
unavailable artwork, source/track changes, late completion, generation changes,
URL/SSRF injection, fixed prefixes, redirects, MIME/signature, declared/streamed
size, headers/body timeouts, positive/negative expiry, entry/byte eviction,
concurrency, pressure retry loops, disposal, authenticated image access, SSE
notifications and controls while an upstream image is stalled. Validation results on Node 24.10.0:

- `npx vitest run`: 72 test files, 1,080 tests passed, including all existing suites
  and 53 focused artwork/Hub checks.
- `npm run typecheck`, `npm run lint`, and `npm run build`: passed.
- Prettier check for all changed files and `git diff --check`: passed.

Loopback server tests required socket access outside the filesystem sandbox;
they never contacted HA or devices. The installer shell fixture and physical,
production, browser-rendering and deployment checks were not run.
