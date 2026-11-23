# Photo brain (Kuffe)

The photo frame's intelligence moves off BrunoCAM's Raspberry Pi 3B to Kuffe, the
desktop. A Rust program, `lugn-photo-brain` (`agents/linux/photo-brain`, next to the
Linux agent and the Hub pointer bridge), keeps the album's full-size pictures on a
big disk, runs stronger models over them and does every pairwise and global
calculation. BrunoCAM only keeps the small display copies, the household's
decisions about who is who, and serves the Hubs. It never runs a model and never
compares faces.

Without Kuffe nothing breaks: BrunoCAM keeps serving the last result it received
(`intel.json`), and pictures that have no result yet are grouped by time and place
alone, exactly as `photoFrame.intelligence.enabled = false` behaves today.

## Why a separate program

`lugn-linux-agent` is an observation and control publisher with no sockets of its
own, a single-threaded runtime and a session-bound lifetime. A model run takes
gigabytes and minutes; it must never be able to starve or take down display power
and music control. So the brain is a sibling crate with its own binary, unit and
lockfile, the same pattern as `hub-pointer`.

## Data flow

```text
iCloud shared album ──► BrunoCAM (Lugn) ──GET /photo-brain/v1/album──► Kuffe (photo-brain)
                          ▲  display copies (sharp)                      │ downloads, stores originals,
                          │                                              │ analyses, clusters
                          └────────────PUT /photo-brain/v1/intel─────────┘
```

- BrunoCAM is the only machine that holds the album link and talks to Apple's
  listing. Kuffe never sees the link.
- Kuffe reaches BrunoCAM through the existing encrypted tunnel
  (`lugn-brunocam-tunnel.service`, Kuffe `127.0.0.1:18787` → BrunoCAM's loopback
  Lugn API) with the same bearer token as other machine clients.
- Kuffe downloads pictures from the short-lived Apple URLs in the listing. Links
  last about 15 minutes: Kuffe re-lists when a download is refused.

## Lugn API (BrunoCAM, bearer token, loopback listener)

### `GET /photo-brain/v1/album`

```json
{
  "schema": 1,
  "title": "…",
  "listedAt": 1763900000000,
  "photos": [
    {
      "id": "Abc…",
      "version": "fingerprint of the picture; changes when it is edited",
      "takenAt": 1763800000000,
      "utcOffsetSeconds": 3600,
      "latitude": 59.1,
      "longitude": 18.0,
      "width": 1536,
      "height": 2048,
      "details": { "…": "AlbumPhotoDetails as today" },
      "renditions": [
        { "kind": "jpeg", "url": "https://…", "width": 1536, "height": 2048 },
        {
          "kind": "original",
          "url": "https://…",
          "width": 3024,
          "height": 4032,
          "type": "public.heic"
        }
      ]
    }
  ]
}
```

`id` is Lugn's own picture id (24 base64url characters, a hash of the album's record
and its `version`), the same id the Hubs and the people panel use. It changes when
the picture is edited, so an id never needs a separate version check. `version` is
informational. All stills in the album, newest first, no cap. `original` is present when Apple
offers it (HEIC for iPhone pictures). `jpeg` is Apple's 1536 × 2048 rendition.
Videos are not listed. Coordinates are full precision here (the Hub listing keeps
its coarser rounding).

### `PUT /photo-brain/v1/intel`

Body: the bundle below, JSON, optionally `Content-Encoding: gzip`, up to 64 MB
inflated. Replaced atomically; the Hubs see it at their next listing.
Response `{ "accepted": <photos>, "unknown": <ids not in the album> }`.

### `GET /photo-brain/v1/state`

`{ "revision": "…", "intelAt": <ms|null>, "pictures": <n>, "analysed": <n> }`: what
Lugn currently holds, so Kuffe can see which pictures lack a result.

### `GET /photo-brain/v1/people`

The household's decisions, so Kuffe's face grouping can anchor on them. Faces are
named `<pictureId>.<index>` (the index is the face's position in that picture's
`faces` array in the bundle, so the order Kuffe publishes never changes for a
given picture version).

```json
{
  "schema": 1,
  "people": [
    { "id": "p3", "name": "Anna", "confirmed": true, "hidden": false }
  ],
  "decided": { "<faceId>": "p3", "<faceId2>": null },
  "previous": { "<faceId>": "p3" },
  "not": { "<faceId>": ["p5"] }
}
```

`decided`: a face a person pinned to somebody (`"p3"`) or declared "not a person"
(`null`). `previous`: the automatic grouping's earlier choice, kept so people keep
their ids. `not`: people a face was moved away from.

## The intel bundle (schema 1)

One document for the whole library. A picture's entry is valid for the `version` it
was computed from; Lugn ignores an entry whose `version` differs from the cached
picture.

```jsonc
{
  "schema": 1,
  "generatedAt": 1763900000000,
  "brain": {
    "version": "0.1.0",
    "models": { "embed": "siglip2-…", "face": "…", "detector": "…" },
    "faceDim": 512,
  },
  "home": { "lat": 59.2, "lon": 18.0 }, // or null
  "trips": [
    { "title": "Lesko", "from": "2026-09-11", "to": "2026-09-14", "cc": "PL" },
  ],
  "events": [
    { "id": "e12", "from": 1763800000000, "to": 1763810000000, "count": 14 },
  ],
  "photos": {
    "<pictureId>": {
      "v": "<picture version>",
      "scene": [
        ["beach", 0.71],
        ["sea", 0.12],
        ["sunset", 0.05],
      ], // top 3, probabilities
      "q": { "sharp": 80, "dark": 3, "junk": null }, // 0-100; junk: "screenshot" | "document" | null
      "fav": 1, // optional, from the album
      "cap": "…", // optional, from the album
      "faces": [
        {
          "x": 0.1,
          "y": 0.2,
          "w": 0.1,
          "h": 0.1,
          "score": 0.93,
          "front": 0.8,
          "q": 70,
          "p": "p3",
        },
      ],
      "trip": 0, // index into trips, optional
      "event": "e12", // optional
      "cand": [["<otherId>", 74, 90, 60, 71]], // [id, base, time, place, look]
      "du": ["<otherId>"], // near-duplicates (bursts)
    },
  },
}
```

A face's `p` is Kuffe's proposal for who it is: `"p3"` an existing person (anchored on
the household's decisions), `"n7"` a new group of faces that agree (the same `n7` on
several faces), or absent when the face is too unclear to place. Lugn gives each new
group a stable person id (remembering which earlier person most of its faces had) and
always lets the household's decisions override a proposal. **No face embedding ever
leaves Kuffe.** Face crops for the people panel are cut on BrunoCAM from the display
copies with the box.

`cand` is each picture's best candidates (about 48, score ≥ 30, best first). The
numbers are 0-100; `time`, `place` and `look` are -1 when unknown. `base` is the
combined score **without** people, computed by Kuffe. Lugn raises or lowers it
with who is in the pictures, because who is who is decided on BrunoCAM (the people
panel):

```text
people known in both pictures:
  shared ≥ 1  → score = min(1, base + 0.08 + 0.12 × shared / union)
  none shared → score = base × 0.8
otherwise     → score = base
```

and keeps the best 14 as the `nb` list a Hub already reads. So neither the
O(n²) pair scoring nor the faces' embeddings ever have to be computed on the Pi,
and a picture's neighbours stay sensible when Kuffe is away.

## Where each job runs

| Job                                                                        | Where                      |
| -------------------------------------------------------------------------- | -------------------------- |
| list the album, display copies (1024 / 640 px) and corner shade            | BrunoCAM                   |
| full-size originals (HEIC or JPEG)                                         | Kuffe's disk (`store_dir`) |
| face detection, face embeddings, scene probabilities, quality, duplicates  | Kuffe                      |
| candidate neighbours, events, trips, home                                  | Kuffe                      |
| face grouping into people (anchored on the household's decisions)          | Kuffe                      |
| the household's decisions (names, confirmations, moves), stable person ids | BrunoCAM                   |
| re-ranking candidates by people, choosing groups, naming                   | BrunoCAM / the Hub         |

## Kuffe

- Unit `lugn-photo-brain.service` (user, `WantedBy=default.target`, no graphical
  session needed), `Nice=15`, `IOSchedulingClass=idle`, a memory ceiling, restart
  on failure. Config `~/.config/lugn-photo-brain/config.toml` (mode 0600); the
  bearer token in `~/.config/lugn-photo-brain/environment`.
- `store_dir`: originals, on the big disk (`/run/media/bruno/Filmer/lugn-photos`,
  NTFS, automounted). The program must never create `store_dir` itself when the
  mount is missing; it waits and retries.
- `db_dir`: its own index, embeddings and the bundle (small; on the SSD).
- Disk use stays bounded: a few MB per original, and the program reports free space
  and stops downloading below a floor.
