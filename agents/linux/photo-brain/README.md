# lugn-photo-brain

Kuffe's photo brain. It keeps the shared album's full-size pictures on the big
disk, runs the models over them, does every pairwise and global calculation
(candidate neighbours, outings, trips, home, near-duplicates, scenes, face
grouping) and hands BrunoCAM one bundle. BrunoCAM never runs a model. The design
and the wire contract are in [docs/PHOTO-BRAIN.md](../../../docs/PHOTO-BRAIN.md).

It is a standalone crate next to `lugn-linux-agent` and `lugn-hub-pointer`, with
its own binary, lockfile and user unit.

```text
loop (run):
  GET  /photo-brain/v1/album      list (Kuffe never sees the album link)
  download what is new            Apple's short-lived links, re-list on 401/403/410
  analyse what is missing         PictureAnalyzer (src/infer/), one picture at a time
  GET  /photo-brain/v1/people     the household's decisions (cached when Lugn is away)
  people::cluster                 face proposals (src/people/)
  cluster + build the bundle      src/cluster/, src/publish.rs
  PUT  /photo-brain/v1/intel      gzip, only when the content changed
```

## Build and test

```sh
cd agents/linux/photo-brain
export CARGO_TARGET_DIR=$HOME/.cache/lugn-photo-brain-target   # keep builds out of the repo
nice cargo build --release
nice cargo test -- --test-threads=4
cargo clippy --all-targets -- -D warnings
nice cargo run --release --example bench_cluster -- 5000 768 4
```

`tests/e2e.rs` runs the whole pipeline against an in-process mock of Lugn (which
also plays Apple's picture host) with a deterministic fake analyser and 300
pictures with planted structure: three outings, a trip abroad with a day
without GPS, a burst, pictures without GPS or time, documents and a screenshot.

## Install

```sh
nice cargo build --release
scripts/install.sh            # or: scripts/install.sh path/to/lugn-photo-brain
```

The installer copies the binary to `~/.local/bin`, creates
`~/.config/lugn-photo-brain/config.toml` (from `config.example.toml`) and
`environment` only if they are absent (both mode 0600), installs and enables
`lugn-photo-brain.service` and does **not** start it. Put the bearer token in
`environment` as `LUGN_PHOTO_BRAIN_TOKEN=...`; the program refuses a `token`
in `config.toml` and never logs it. Then `lugn-photo-brain status` and
`systemctl --user start lugn-photo-brain`.

The unit runs at `Nice=15` with `IOSchedulingClass=idle`, `MemoryMax=4G`,
`UMask=0077` and restarts on failure; Kuffe runs other heavy jobs.

## Commands

| Command                |                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`                  | the loop until SIGTERM. Analysis runs in 10-minute slices, each followed by a publish, so progress shows up during a long first run. Lugn or Apple unreachable: back off 30 s, doubling to 30 min. |
| `once`                 | one full pass (everything pending), then exit (non-zero if Apple was unreachable).                                                                                                                 |
| `status`               | counts, stored size, free space, last publish, and Lugn's view when the token is set.                                                                                                              |
| `export-bundle <file>` | the bundle the store would publish, without contacting Lugn (people decisions from the cache).                                                                                                     |

SIGTERM is honoured between pictures and inside downloads (checked every 64 KB).

## Configuration

See `config.example.toml`. `lugn_url` must be https unless it is the loopback
tunnel. Relative paths are relative to the config file; `~` is expanded.

`store_dir` is never created while its disk is missing: it is created only when
its parent directory is a mount point (`/run/media/bruno/Filmer` mounted). If
it lives on the system disk, create it by hand once. While it is missing the
brain logs once, does not download or analyse, and still publishes from what
it has analysed. Below `min_free_gb` free it stops downloading.

## Storage

- Originals: `store_dir/<first two characters>/<name>.<heic|jpg>`. `<name>` is
  the picture id when it is lower case, digits, `-` and `_`; otherwise the id
  lowercased (other characters as `_`) plus a 64-bit hash, so a case-insensitive
  disk (NTFS) can never mix two pictures up. Downloads go to `.part` and are
  renamed when complete.
- Index: `db_dir/index.sqlite3` (SQLite through `rusqlite`, bundled). One row
  per picture (version, listing metadata without URLs, file, failure counts)
  and one per analysis (embedding and face embeddings as little-endian f32
  blobs, face boxes, quality, model ids, analysed size, time). SQLite rather
  than JSON lines because every analysed picture is one small atomic, crash-safe
  update (WAL) instead of rewriting a 20-plus MB file, embeddings stay compact
  binary blobs, and "what needs downloading or analysing" is a join. The cost is
  one dependency that compiles SQLite's C source.
- `db_dir/intel.json.gz`: the last bundle sent; `db_dir/people.json`: the last
  people decisions Lugn gave.

A picture is downloaded again when its version changes, and analysed again when
its version or the model ids change. A picture that fails twice (download or
analysis) is skipped until its version (or, for analysis, the models) change.
When a picture leaves the album it is no longer published at once; its file and
rows are deleted after `gone_grace_days` (7), and it is reused if it comes back
before then. `max_pictures` keeps only the newest N.

## Clustering (`src/cluster/`)

Pure logic, ported from `src/runtime/photo-intel/grouping.ts`, with these
changes (each has a unit test):

- **No people term.** `base` is time, place and look; Lugn re-ranks with people
  (the formula is in the doc).
- **Home says little.** When both pictures are within 5 km of home the place
  weight drops from 0.2 to 0.05.
- **Missing time** caps a pair at 0.55. **Missing GPS** on one side: the
  picture borrows the location of the nearest-in-time located picture of its
  outing; with none, the other side being on a trip or over 150 km from home
  still applies the far-apart penalty (×0.4).
- Coordinates at full precision.
- **Home** is the place with pictures on the most distinct local days (not the
  most pictures), needing a quarter of all photographed days.
- **Trips**: a session without GPS between two away sessions joins the trip
  instead of splitting it; place and country shares count only pictures that
  have one; local dates use the picture's offset, else Europe/Stockholm (never
  UTC). Place names and countries come from the repository's `data/places.tsv`
  (nearest place within 30 km, like Lugn); trips not dominated by one place are
  named after the country in Swedish.
- **Outings (`events`)**: a new one after a 4 h pause or a jump over 25 km
  between located pictures; at least two pictures. Same outing +0.08, same trip
  +0.08, same import batch +0.05 when time or GPS is missing.
- **Near-duplicates**: within 2 minutes and cosine ≥ 0.94, or both marked as
  burst frames by the album and cosine ≥ 0.80. They are listed in `du` and never
  in `cand`.
- **Scenes**: softmax (CLIP-like) or sigmoid (SigLIP-like) vocabularies, a raw
  cosine floor per kind, top three; see the doc. Nothing assumes an embedding
  length.
- **`cand`**: the best 48 per picture with score ≥ 0.30, `[id, base, time,
place, look]` in 0-100, -1 when unknown.

Each row (one picture against all) runs in parallel on a rayon pool of
`threads`. Within a row the cheap terms give an upper bound (the look term
assumed perfect); pairs are visited best bound first and the embedding dot
product is only computed while the bound can still beat the row's 48th best.
Pairs within 2 minutes are always compared, so no duplicate is missed. A test
checks the pruned result against scoring every pair exactly.

**Benchmark** (`examples/bench_cluster.rs`, synthetic family library: outings
of 3-60 pictures over three years, 70 % at home, 10 % without GPS, 2 % without
time; Kuffe, release build, `nice`, other jobs running, load ≈ 6):

| pictures | dims | threads | time  | dot products  |
| -------- | ---- | ------- | ----- | ------------- |
| 5000     | 768  | 4       | 1.3 s | 54 % of pairs |
| 5000     | 512  | 1       | 4.7 s | 58 % of pairs |

The bound prunes about half the pairs on this library, not most: pairs at home
far apart in time can still reach 0.30 when they look alike, so their look has
to be checked. The dot products themselves are cheap, which is why 5000
pictures take about a second.

## People (`src/people/`)

Faces are named `<pictureId>.<index>` (position in the picture's analysis,
stable per picture version). The brain builds `people::FaceRec`s from the stored
analyses (`px` from the stored rendition's size), calls `people::cluster` with
Lugn's decisions before each publish (only again when faces or decisions
changed), and writes the result into each face's `p` (`"p3"` or `"n7"`). The
grouping itself is another module's job; today its stub proposes nothing.

## Module map

| Module               |                                                                        |
| -------------------- | ---------------------------------------------------------------------- |
| `analysis`, `bundle` | the contract (with docs/PHOTO-BRAIN.md)                                |
| `infer/`             | decoding and the ONNX models (a stub until the inference module lands) |
| `people/`            | grouping faces into people                                             |
| `config`             | `config.toml`, mode check, token from the environment                  |
| `client`             | Lugn's endpoints and Apple downloads (rustls)                          |
| `store`, `disk`      | originals, the SQLite index, mount and free-space checks               |
| `cluster/`           | home, trips, outings, pair scores, candidates, duplicates, scenes      |
| `places`             | nearest place and country from `data/places.tsv`                       |
| `localtime`          | local days with the picture's offset or Europe/Stockholm               |
| `publish`            | building, comparing and gzipping the bundle                            |
| `service`            | the loop                                                               |
