# Photo intelligence

The Hubs' **Foto** page shows pictures in groups that belong together (same
outing, same place, same people, similar look) and names each group. The
analysis behind it runs on the machine that runs Lugn, once per new or changed
picture, and never on a Hub and never while a picture is on screen. Without the
models or with `photoFrame.intelligence.enabled` set to `false` the page keeps
every earlier behaviour; grouping then uses time and place alone.

## What is read from the album

Beyond the picture, date and position the album stores, per picture, a property
list written by the phone. These fields are read (`icloud-shared-album.ts`,
`bplist.ts`) and kept next to the cached picture; only a few derived values ever
reach a Hub.

| Field                                                                         | Used for                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| capture time, time zone offset, position                                      | time and place scores, local dates, trips                                                               |
| nearest place and country (offline, `data/places.tsv`)                        | place names, country of a trip                                                                          |
| caption (`captionEnc`, `extendedDescEnc`)                                     | the name of a group when somebody wrote one (not present in the test album; covered by unit tests only) |
| favourite flag                                                                | favourites start groups a little more often                                                             |
| camera, lens (front, ultra-wide, wide, tele), ISO, exposure brightness, flash | stored, not yet scored                                                                                  |
| GPS altitude, compass heading, speed                                          | stored, not yet scored                                                                                  |
| number of faces the phone itself found                                        | stored, not yet scored                                                                                  |
| file name, import batch, keywords, burst flag, asset subtype                  | stored, not yet scored                                                                                  |

"Stored, not yet scored" fields are read and cached so they can be used without
another pass over the album; nothing claims they improve the grouping today.

## Models

All three are permissively licensed, so the same files can be used in a product.
`npm run photos:models` downloads them once, checks each against its SHA-256 and
installs them in `photoFrame.intelligence.modelsDir` (default: `photo-models`
next to the state file). They are not part of the repository.

| Job                    | Model                                         | Licence    | Size   |
| ---------------------- | --------------------------------------------- | ---------- | ------ |
| what a picture shows   | CLIP ViT-B/32 image tower, int8 (Xenova ONNX) | MIT        | 89 MB  |
| face boxes + landmarks | YuNet 2023 mar (OpenCV Zoo)                   | MIT        | 0.2 MB |
| who a face is          | SFace 2021 dec, int8 (OpenCV Zoo)             | Apache-2.0 | 9.9 MB |

Scene names (beach, forest, food, party, …) come from comparing a picture's
embedding with text embeddings of a fixed vocabulary. The text vectors are
computed once on a development machine (`scripts/build-photo-scenes.mjs`, input
`data/photo-scenes.source.json`) and shipped as `data/photo-scenes.json`, so the
text model, its tokenizer and any download are not needed at run time.

**Why not MobileCLIP2 and InsightFace?** Both were considered first. MobileCLIP2
is smaller and faster, and InsightFace's recognisers are stronger on hard faces,
but Apple's MobileCLIP2 weights are released "exclusively for Research Purposes"
and InsightFace's pretrained models for non-commercial research only. A
household product is not that, so they are not shipped. Any model with the same
inputs and outputs can replace a file of the same name; the scene vectors must
then be rebuilt for the new text tower.

## How it runs

- `PhotoLibrary` hands every cached picture to `PhotoInsight`. Pictures without
  a record go into a queue (`photo-intel/analyzer.ts`).
- One worker process at a time (`photo-intel/worker.ts`), started with
  `os.setPriority(19)`, a 128 MB heap limit, one ONNX thread, no memory arena, no weight packing and one malloc arena that trims (about 250 MB resident).
  It analyses one picture, rests 250 ms, and exits after 30 s without work.
  A picture that fails twice is skipped; three failures in a row pause the queue
  for ten minutes. A crash or a stuck picture (two minutes) only replaces the
  worker.
- Results are kept in `analysis.json` next to the pictures, keyed by the
  picture's id, which changes when the picture is edited. A new model version
  starts the cache again once. Nothing is analysed twice.
- Faces and their decisions are in `people.json` (mode 0600). Faces are not
  sent anywhere: the panel receives small crops and pictures through the signed
  in session only, and a Hub receives person ids and names, never faces.

Measured with one thread: 109 ms per picture on a 16-core development machine;
about 3.4 s per picture and 230 MB resident on the Raspberry Pi 3B that runs
Lugn (models load in 7 s), so 150 new pictures take about nine minutes at the
lowest priority while the sensor and the lights keep their share.

## Grouping

`photo-intel/grouping.ts` scores every pair of pictures 0–1:

- **time**: 1 within half an hour, 0.85 at 3 h, 0.6 at 8 h, 0.35 at a day and a
  half, 0.15 at a week, 0 after a month (linear in log time);
- **place**: 1 within 300 m, 0.85 at 3 km, 0.6 at 15 km, 0.3 at 60 km, ~0 at 200 km;
- **people**: shared people raise the score, disjoint known people lower it;
- **look**: CLIP cosine, 0.5 (unrelated) to 0.85 (same scene);
- missing information is skipped, not counted as a mismatch; far apart in both
  time (> 2 weeks) and look without a shared person, or far away (> 150 km) at
  a different time, cuts the score hard.

Each picture gets its fourteen best neighbours (score ≥ 0.3) and a list of
near-duplicates (burst shots, never shown together). Trips are found as runs of
sessions away from home (> 80 km; home = where a quarter of the located pictures
are, or `photoFrame.intelligence.home`) spanning two days or another country.

On a Hub, `buildGroup` (`photos-page.js`) picks a seed among pictures not yet
shown this round (favourites a bit more often), then adds four to six
neighbours at random, weighted by how well they fit **everyone** already in the
group and by how long since they were shown, with pairs shown together recently
penalised. A candidate that does not fit the group on average is never added,
so a group may end early rather than mix unrelated pictures. `planGroup` splits
it over slides (five pictures: 2 + 3 or 3 + 2; six: 3 + 3 or 2 + 2 + 2; never a
lone portrait). Groups are not stored; each round draws them again.

## Naming a group

Every group is named in the same place (lower right) with the same three parts:
a small word for the kind of name, the name, and a line below with the time or
the company. The first rule that fits wins:

| Kind  | When                                                | Example                        |
| ----- | --------------------------------------------------- | ------------------------------ |
| MINNE | half the pictures share a caption from Photos       | Midsommar hos mormor           |
| RESA  | at least 80 % belong to one trip                    | Lesko · 11–14 september        |
| PLATS | one scene and one place (a place-bound scene)       | Stranden i Marstrand · 14 juli |
| TEMA  | one scene (food, party, …), place in the line below | Maten · Rom · 14 juli          |
| PLATS | one place                                           | Tullinge · november            |
| MED   | named people are in most pictures                   | Anna och Erik                  |
| DAG   | one day                                             | 20 november                    |
| MÅNAD | one month                                           | November 2026                  |
| ÅR    | one year                                            | 2025                           |

Named people are added to the line below ("· med Anna och Erik") whenever they
are in at least half of the group. A scene counts only when the model is at
least 45 % sure for the picture and 60 % of the group agrees. When nothing is
honest to say, no name is shown. Dots under the name show which slide of the
group is on screen.

## The people panel

`/ui/` → Inställningar → **Foton** (Lugn's control panel, not a Hub): every
person the faces form, with a name field, "Det här är en person" (confirm),
merge, hide, and a tap on any face opens its picture to move it to another
person, a new person, or "not a person". The panel's API is under
`/ui/api/photo-people` and has the same session, same-origin and CSRF rules as the
rest of the panel. Decisions made there are kept and never overridden: the
automatic grouping only fills in what nobody decided and keeps its own earlier
choices stable.

Faces are grouped by SFace cosine similarity: a face joins a person when it is at
least 0.40 similar to that person's average (0.30 to keep an earlier place), and
new people start from clear, front-facing faces that agree on average at 0.38.
These thresholds were set on one household's pictures; the panel is how they are
corrected.

## Operations

- `photoFrame.intelligence`: `enabled` (default true), `modelsDir`, `home`
  (`latitude`/`longitude`). See [CONFIGURATION.md](CONFIGURATION.md#photo-frame).
- Install: `npm ci` (the ONNX runtime is an optional dependency; if it cannot be
  installed the frame works as before), then `npm run photos:models`. On a
  machine with a CPU only, set `ONNXRUNTIME_NODE_INSTALL=skip` while installing
  to avoid the optional GPU downloads.
- Status: the panel's chip shows analysed pictures, and `journalctl` has
  `photo analysis: one picture took … ms` lines.
