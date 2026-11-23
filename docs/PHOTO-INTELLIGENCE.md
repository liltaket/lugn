# Photo intelligence

The Hubs' **Foto** page shows pictures in groups that belong together (same
outing, same place, same people, similar look) and names each group. The
pictures are analysed on Kuffe by the photo brain ([PHOTO-BRAIN.md](PHOTO-BRAIN.md)),
never on BrunoCAM, never on a Hub and never while a picture is on screen.
Without its results, or with `photoFrame.intelligence.enabled` set to `false`,
the page keeps working and groups by time and place alone.

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

## Who does what

Lugn on BrunoCAM lists the album, keeps the small display copies, keeps the
household's decisions about people and serves the Hubs. It never runs a model and
never compares faces. The photo brain on Kuffe (`lugn-photo-brain`) downloads the
full-size pictures, runs the models (scenes, quality, faces), proposes who each
face is, and finds candidate neighbours, near-duplicates, events and trips. The
two talk over three bearer-token routes on Lugn's loopback API; the contract, the
bundle format and the reasons for the split are in
[PHOTO-BRAIN.md](PHOTO-BRAIN.md).

- `PhotoLibrary` (`photo-library.ts`) keeps up to `maxPhotos` pictures (5000 by
  default). A refresh with many new pictures writes its index every 25 pictures
  and shows them at once, so a restart or a failure keeps what is done; unused
  files are only removed after a full pass. It serves the album to Kuffe with
  full-precision coordinates and fresh download links (the listing is read again
  when it is older than five minutes); the Hubs keep getting rounded positions.
- `IntelStore` (`photo-intel/intel-store.ts`) checks the bundle field by field
  (schema 1, length and count limits, picture ids) and keeps it in `intel.json`
  (mode 0600) next to the pictures. A damaged file is ignored until Kuffe sends
  a new one.
- `PeopleStore` (`photo-intel/people.ts`) maps Kuffe's proposals to people (see
  below). `PhotoInsight` (`photo-intel/insight.ts`) turns both into the short
  list per picture a Hub reads.

When Kuffe is away, Lugn keeps serving the last bundle. Pictures without a result
yet (new ones, or all of them before the first bundle) are grouped by time and
place alone. With `photoFrame.intelligence.enabled` set to `false` the bundle is
not used (and the photo brain routes are closed), and every picture is grouped by
time and place.

## Grouping

For a picture Kuffe has seen, its candidates (about 48, each with a score 0–100
computed without people) are adjusted by who is in both pictures, as decided on
this machine (`shared ≥ 1`: raised; only different known people: lowered; see
the formula in [PHOTO-BRAIN.md](PHOTO-BRAIN.md)), and the best fourteen with a
score of at least 0.3 become its neighbours (`nb`). Candidates that left the
library are dropped. A screenshot, a document, or a picture too blurred
(sharpness < 8) or too dark (> 95) is marked `skip: 1`: no other picture lists it
as a neighbour and it gets no neighbours of its own. (A Hub that does not know
`skip` yet may still start a group from it.) Near-duplicates (`du`, burst shots)
come from Kuffe and are never shown together. The scene is the top scene when
Kuffe is at least 45 % sure. Trips are Kuffe's.

For a picture Kuffe has not seen, `photo-intel/grouping.ts` compares it with the
60 pictures nearest to it in time (never with all), on:

- **time**: 1 within half an hour, 0.85 at 3 h, 0.6 at 8 h, 0.35 at a day and a
  half, 0.15 at a week, 0 after a month (linear in log time);
- **place**: 1 within 300 m, 0.85 at 3 km, 0.6 at 15 km, 0.3 at 60 km, ~0 at 200 km;
- far apart in time (> 2 weeks), or far away (> 150 km) at a different time,
  cuts the score hard.

Trips for these pictures are found as runs of sessions away from home (> 80 km;
home = `photoFrame.intelligence.home`, else Kuffe's, else where a quarter of the
located pictures are) spanning two days or another country. The listing's `ai`
is true once any picture has a result from Kuffe.

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

## Legibility

The name, the clock and the music widget get a radial shade in their corner,
as dark as the picture there needs. `photo-frame.ts` measures the brightness
(0–99) of each picture's upper right, lower right and lower left corner once
when it is imported (older cached pictures are measured from the copy on disk,
without a download) and lists it as `lu`. See [UI.md](UI.md) for how a slide
uses it.

## The people panel

`/ui/` → Inställningar → **Foton** (Lugn's control panel, not a Hub): every
person the faces form, with a name field, "Det här är en person" (confirm),
merge, hide, and a tap on any face opens its picture to move it to another
person, a new person, or "not a person". The panel's API is under
`/ui/api/photo-people` and has the same session, same-origin and CSRF rules as the
rest of the panel. Face crops are cut here from the cached picture with the box
Kuffe sent; no face embedding ever leaves Kuffe.

Who a face is, in order: what the household decided for it; else Kuffe's
proposal. A proposal of a known person (`p3`) is followed if that person still
exists. A new group (`n7`, the same number on several faces) becomes the person
most of its faces were before, unless a larger group took that person already;
otherwise a new person, but only for two faces or more. A face is never given
automatically to a person it was moved away from. People nobody named or
confirmed, and who have no faces left, are dropped. Everything is mapped again
when a bundle arrives and after every decision. Kuffe reads the decisions
(`GET /photo-brain/v1/people`) and anchors its grouping on them.

Decisions are kept in `people.json` (mode 0600, the same file format as before
the photo brain). Each new decision also keeps the face's box, so a decision
follows its face when Kuffe numbers the faces of a picture differently from the
old on-device analysis or from an earlier model: it moves to the face in the same
picture whose box overlaps by half or more, and is kept unused while no face
matches. Decisions made before boxes were kept take their boxes once from the
old `analysis.json`, if it is still there.

## Operations

- `photoFrame.intelligence`: `enabled` (default true) and `home`
  (`latitude`/`longitude`); an old `modelsDir` is accepted and ignored. See
  [CONFIGURATION.md](CONFIGURATION.md#photo-frame).
- The photo brain routes need Lugn's bearer token (`http.bearerTokenEnv`);
  without one they answer `503 photo_brain_requires_token`.
- Status: the panel's chip shows how many pictures Kuffe has analysed, "Väntar på
  Kuffe" before the first bundle, and when Kuffe was last heard from if that is
  more than six hours ago. `journalctl` has `photo brain: result for … pictures`
  lines.
- Files next to the pictures: `index.json`, `intel.json`, `people.json`. An
  `analysis.json` and a `photo-models` directory from the old on-device analysis
  are no longer used (only `analysis.json`'s face boxes are read once, see above)
  and can be deleted once the decisions have followed their faces.
