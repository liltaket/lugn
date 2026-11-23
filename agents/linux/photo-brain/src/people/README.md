# Grouping faces into people

`cluster(faces, labels, thresholds)` proposes who every face is: an existing
person (`Assigned::Person("p12")`), a new group of faces that agree
(`Assigned::Cluster(n)`, published as `"n<n>"`), or nothing (the face is too
unclear or too ambiguous to place). BrunoCAM turns proposals into people and its
household's decisions always override them (`docs/PHOTO-BRAIN.md`,
`GET /photo-brain/v1/people`).

It is a rewrite of `src/runtime/photo-intel/people.ts` with the same shape
(decisions win, anchored centroids, sticky earlier places, average-linkage new
groups from clear faces) and these fixes: two faces of one picture are never the
same person, earlier places and new places both need a margin, unclear faces can
join groups formed in the same run, tiny or blurry faces never start a person,
and the linkage is O(n²) instead of O(n³).

## The rules, in order

Faces are sorted by id first, and every tie is broken by index, so the result
depends only on the input (not its order, not thread timing).

0. **Decisions.** A face pinned to `p` (`decided[f] = Some(p)`) is `Person(p)`,
   always, even without a usable embedding. A face declared "not a person"
   (`None`) is never in the result and shapes nothing. `not[f]` lists people the
   face is never proposed to. Hidden people are treated like everyone else
   (BrunoCAM hides them; they still need their faces).

1. **Centroids of existing people.** A person is anyone the labels mention.
   Its centroid is the normalised weighted sum of
   - its pinned faces, weight 1, and
   - its earlier automatic members (`previous[f] = p`, not moved away from `p`),
     weight `0.4 + 0.6 × score × (0.5 + 0.5 × front)`, at most one per picture
     (the heaviest) and none from a picture where `p` already has a pinned face.

   A **confirmed** person is a trusted anchor: an earlier automatic member only
   counts if it is at least `thresholds.confident()` (= `join + 0.25 × (1 −
   join)`, 0.55 by default) similar to the pinned faces alone, so earlier
   mistakes cannot drag it.

   A member is scored against its person's centroid **without its own share**
   (leave one out), so a face cannot keep itself in place.

2. **Anchored assignment.** Every open face computes its similarity to every
   centroid it is not blocked from. Then:
   - **keep** its earlier person `q` if `sim(q) ≥ keep` and nobody beats `q` by
     more than `margin`;
   - else **join** the best person if `best ≥ join` and `best − second ≥ margin`;
   - else stay open.

   **Cannot-link:** within one picture each person takes at most one face. When
   several faces of a picture choose the same person, the most similar one wins
   and the others stay open; a person with a pinned face in that picture takes
   none.

3. **New groups.** Open faces that are clear enough (`score ≥ seed_min_score`,
   `front ≥ seed_min_front`, `px ≥ seed_min_px`, `quality ≥ seed_min_quality`)
   are grouped by average linkage (below) while the average similarity of two
   groups is at least `link`, never merging two groups that hold faces of one
   picture. Groups of two or more faces become new people; single faces stay
   open.

   **Ids:** a new group most of whose faces (strictly more than half) had the
   same earlier person `q` gets `Person(q)` back, if `q` has no faces in this
   result (nobody pinned or kept or joined it), no group member was moved away
   from `q`, and no stronger group claimed `q` (most votes wins, then the group
   with the lowest face id). Every other group is `Cluster(1)`, `Cluster(2)`, …
   numbered by its lowest face id.

4. **Second pass.** Every face still open (unclear faces, single seeds, the
   faces that gave way to a picture-mate) is offered the existing people and the
   new groups (centroids of their members by weight), with the same keep, join,
   margin and cannot-link rules. A face whose best candidate is already taken in
   its picture stays open (it is not moved to its second choice).

## Average linkage, fast

`link::average_linkage` implements UPGMA with the nearest-neighbour chain: the
similarity of two groups is the mean over all their face pairs, updated on a
merge as `(|A|·s(A,C) + |B|·s(B,C)) / (|A| + |B|)`. Same-picture pairs are
`-inf`, and an average with `-inf` stays `-inf`, so the cannot-link survives
every merge. Average linkage is reducible, so merging reciprocal nearest
neighbours gives exactly the groups of the greedy "merge the best pair"
algorithm (a unit test checks this against the O(n³) reference), and a group
whose best neighbour is below `link` is final (any later neighbour is an average
of groups it is already below) and leaves the search. Work is O(n²); the matrix
is filled in parallel with rayon.

**Memory:** the matrix is dense, upper triangle only, f32: n²/2 × 4 bytes, so
72 MB for 6000 seed faces and 128 MB for the cap of `MAX_LINK_FACES = 8000`.
When more open faces qualify as seeds, the 8000 heaviest (clearest, most
frontal) are linked and the rest can only join in the second pass. The rest of
the run is O(faces × people × dim) and small.

**Speed** (release build on Kuffe, 16 threads, shared with other jobs, all
faces 512-dimensional; `cargo test --release -- --ignored --nocapture bench_`):

| input | time |
| --- | --- |
| 6000 seed faces, 120 people | 0.26 s (0.44 s with 4 threads) |
| 8000 seed faces (the cap), 160 people | 0.47 s |
| 25 500 faces: 6000 seeds of 1500 people, 19 500 unclear faces, 50 pinned people | 0.46 s |

The thread count follows rayon (`RAYON_NUM_THREADS`); the service runs niced.

## Thresholds

| field | default | meaning |
| --- | --- | --- |
| `join` | 0.40 | similarity to a person's centroid needed to join it |
| `keep` | 0.30 | similarity needed to keep an earlier automatic place |
| `link` | 0.38 | average similarity for faces to form a new group |
| `margin` | 0.04 | the chosen person must beat the runner-up by this much (and an earlier place may trail the best by at most this much) |
| `seed_min_score` | 0.75 | detector confidence needed to start a person |
| `seed_min_front` | 0.30 | frontalness needed to start a person |
| `seed_min_px` | 40 | shorter face box side, analysed pixels, to start a person |
| `seed_min_quality` | 30 | face quality (0-100) needed to start a person |

The defaults are the TypeScript (SFace) values and only a starting point: the
face model on Kuffe is different, so they must be calibrated.

## Calibration

`calibrate(faces, truth)` (or `calibrate_with(…, &current)`) takes the
household's decided faces as ground truth (`face → person`) and returns a
`CalibrationReport` (it implements `Display` for a tool to print):

- cosine similarity distributions (count, mean, p5, p50, p95) of same-person and
  different-person face pairs, of each face against its own person's centroid
  (leave one out) and against the most similar other person's centroid;
- **proposed thresholds** for a false-merge rate of at most 1 %:
  `link` = the lowest value at most 1 % of different-person pairs reach;
  `join` = the lowest value at most 1 % of faces reach against their most
  similar wrong person's centroid; `keep` = the lowest value at most 1 % of
  (face, wrong person) pairs reach, never above `join`. `margin` and the seed
  limits are kept. `None` when the truth has fewer than two people.
- for the current and the proposed thresholds:
  - **no decisions**: `cluster` on the truth faces with empty labels, scored
    with pairwise precision / recall / F and B-cubed precision / recall / F (a
    face left open counts as a group of its own), plus the share placed;
  - **half decided**: every other face of each person (by id) pinned, the rest
    proposed, counted as right person / wrong person / new group / open.

Pair similarities are kept in 4000-bin histograms (rounding 0.0005, always
upwards for the proposals), so memory stays small for thousands of faces; the
pair loop is O(n²) and parallel.

## Not done here

- No tool prints the report for the real album yet.
- The cannot-link loser is not offered its second choice; it stays open.
- A face counts as one sample whatever its burst: near-duplicates of one moment
  weigh like separate pictures in centroids and in linkage.
