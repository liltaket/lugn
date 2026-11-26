//! Grouping faces into people. This module is the seam between the brain (which
//! gathers faces and the household's decisions and publishes the proposals) and
//! the clustering itself. See `docs/PHOTO-BRAIN.md` (`GET /photo-brain/v1/people`)
//! and `README.md` next to this file for the algorithm.

use std::collections::{BTreeMap, HashMap, HashSet};

use rayon::prelude::*;

mod calibrate;
mod link;
mod vector;

#[cfg(test)]
mod tests;

pub use calibrate::{
    AnchoredScores, CalibrationReport, ClusterScores, Distribution, calibrate, calibrate_with,
};
pub use link::MAX_LINK_FACES;

use vector::{add_scaled, dot, normalized};

/// `<pictureId>.<index>`.
pub type FaceId = String;
/// `p12`: a person the household's side (BrunoCAM) knows.
pub type PersonId = String;

/// One face as the grouping sees it.
#[derive(Debug, Clone)]
pub struct FaceRec {
    pub id: FaceId,
    pub photo_id: String,
    /// Unit length.
    pub embedding: Vec<f32>,
    /// Detector confidence, 0-1.
    pub score: f32,
    /// 0 (profile) to 1 (straight on).
    pub front: f32,
    /// 0-100, usefulness for recognition.
    pub quality: f32,
    /// Shorter side of the face box in pixels of the analysed image.
    pub px: f32,
}

/// What the household has decided (from `GET /photo-brain/v1/people`).
#[derive(Debug, Clone, Default)]
pub struct Labels {
    pub confirmed: HashSet<PersonId>,
    pub hidden: HashSet<PersonId>,
    /// `Some(p)`: pinned to `p`. `None`: declared "not a person".
    pub decided: HashMap<FaceId, Option<PersonId>>,
    /// The automatic grouping's earlier choice, to keep people's ids stable.
    pub previous: HashMap<FaceId, PersonId>,
    /// People a face was moved away from; never proposed again for that face.
    pub not: HashMap<FaceId, Vec<PersonId>>,
}

/// Where a face ended up.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Assigned {
    /// An existing person.
    Person(PersonId),
    /// A new group of faces that agree; the same number on every member.
    Cluster(u32),
}

/// Tunable thresholds; the defaults are for the face model in use and are
/// calibrated against the household's own decisions (see the README).
#[derive(Debug, Clone, PartialEq)]
pub struct Thresholds {
    /// Cosine similarity to a person's centroid needed to join.
    pub join: f32,
    /// Similarity needed to keep an earlier automatic place.
    pub keep: f32,
    /// Average cosine similarity for faces to form a new group together.
    pub link: f32,
    /// The best person must beat the second best by this much to be chosen.
    pub margin: f32,
    pub seed_min_score: f32,
    pub seed_min_front: f32,
    pub seed_min_px: f32,
    /// Faces below this `quality` (blurry, tiny, turned away) never start a
    /// person; they can still join one.
    pub seed_min_quality: f32,
}

impl Thresholds {
    /// Starting values for a face recogniser, from `lugn-photo-brain calibrate`
    /// on one household's 41 pinned faces (11 people, 2026-11-23): each is the
    /// calibration's proposal nudged towards caution (the sample is small, and
    /// the proposal is fitted on it). Unknown models get the SFace values.
    /// `[faces]` in the config overrides any of them.
    pub fn for_model(face_model: &str) -> Self {
        let tuned = |join, keep, link| Self {
            join,
            keep,
            link,
            ..Self::default()
        };
        let id = face_model.to_ascii_lowercase();
        if id.contains("buffalo") || id.contains("w600k") {
            // same-person p5 0.34, different-person p95 0.14: a wide gap.
            tuned(0.25, 0.22, 0.25)
        } else if id.contains("auraface") || id.contains("glintr100") {
            // same-person p5 0.18, different-person p95 0.18: no gap, so stricter
            // than the 1 % proposal (0.275 / 0.249 / 0.217).
            tuned(0.30, 0.27, 0.25)
        } else {
            // SFace; proposal 0.382 / 0.337 / 0.333.
            tuned(0.39, 0.33, 0.35)
        }
    }

    /// The thresholds with the config's overrides applied.
    pub fn with_overrides(
        mut self,
        join: Option<f32>,
        keep: Option<f32>,
        link: Option<f32>,
        margin: Option<f32>,
    ) -> Self {
        self.join = join.unwrap_or(self.join);
        self.keep = keep.unwrap_or(self.keep);
        self.link = link.unwrap_or(self.link);
        self.margin = margin.unwrap_or(self.margin);
        self
    }
}

impl Default for Thresholds {
    fn default() -> Self {
        // SFace-like starting values; the face model's calibration replaces them.
        Self {
            join: 0.40,
            keep: 0.30,
            link: 0.38,
            margin: 0.04,
            seed_min_score: 0.75,
            seed_min_front: 0.30,
            seed_min_px: 40.0,
            seed_min_quality: 30.0,
        }
    }
}

impl Thresholds {
    /// Similarity to a confirmed person's pinned faces that an automatic member
    /// needs before it may shape that person's centroid: a quarter of the way
    /// from `join` to a perfect match.
    pub fn confident(&self) -> f32 {
        self.join + 0.25 * (1.0 - self.join)
    }
}

/// How much a face shapes a centroid: clear, frontal faces count more.
pub fn face_weight(face: &FaceRec) -> f32 {
    let score = face.score.clamp(0.0, 1.0);
    let front = face.front.clamp(0.0, 1.0);
    0.4 + 0.6 * score * (0.5 + 0.5 * front)
}

/// Whether a face is clear enough to start a new person.
pub fn is_seed(face: &FaceRec, thresholds: &Thresholds) -> bool {
    face.score >= thresholds.seed_min_score
        && face.front >= thresholds.seed_min_front
        && face.px >= thresholds.seed_min_px
        && face.quality >= thresholds.seed_min_quality
}

/// What a face is offered: an existing person (index into the people list) or
/// a new group, by its number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum Label {
    Person(usize),
    Cluster(u32),
}

/// A centroid as an unnormalised weighted sum, so a member's own contribution
/// can be left out when that member is scored ("leave one out").
struct Centre {
    label: Label,
    sum: Vec<f32>,
    norm2: f32,
}

impl Centre {
    fn new(label: Label, sum: Vec<f32>) -> Option<Self> {
        let norm2 = dot(&sum, &sum);
        (norm2.is_finite() && norm2 > 1e-12).then_some(Self { label, sum, norm2 })
    }

    /// Cosine similarity of unit `e` to this centroid; with `own` (the weight
    /// `e` itself was added with) to the centroid without `e`.
    fn similarity(&self, e: &[f32], own: Option<f32>) -> Option<f32> {
        let d = dot(e, &self.sum);
        match own {
            None => Some(d / self.norm2.sqrt()),
            Some(w) => {
                let rest = self.norm2 - 2.0 * w * d + w * w;
                (rest > 1e-6).then(|| (d - w) / rest.sqrt())
            }
        }
    }
}

/// The faces the grouping works on: valid embeddings, sorted by id.
struct Prepared<'a> {
    faces: Vec<&'a FaceRec>,
    dim: usize,
    /// Unit embeddings, `dim` values per face.
    emb: Vec<f32>,
    photo: Vec<u32>,
    weight: Vec<f32>,
}

impl Prepared<'_> {
    fn e(&self, i: usize) -> &[f32] {
        &self.emb[i * self.dim..(i + 1) * self.dim]
    }
}

/// Faces sorted by id, duplicates dropped, embeddings re-normalised; faces
/// whose embedding is unusable (wrong length, zero, not finite) are dropped.
fn prepare(faces: &[FaceRec]) -> Prepared<'_> {
    let mut sorted: Vec<&FaceRec> = faces.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    sorted.dedup_by(|a, b| a.id == b.id);
    // The embedding length most faces have (ties to the shorter).
    let mut lengths: BTreeMap<usize, usize> = BTreeMap::new();
    for f in &sorted {
        if !f.embedding.is_empty() {
            *lengths.entry(f.embedding.len()).or_default() += 1;
        }
    }
    let dim = lengths
        .iter()
        .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
        .map_or(0, |(len, _)| *len);
    let mut photos: HashMap<&str, u32> = HashMap::new();
    let mut out = Prepared {
        faces: Vec::new(),
        dim,
        emb: Vec::new(),
        photo: Vec::new(),
        weight: Vec::new(),
    };
    for f in sorted {
        if f.embedding.len() != dim || dim == 0 {
            continue;
        }
        let Some(unit) = normalized(&f.embedding) else {
            continue;
        };
        let next = photos.len() as u32;
        out.photo
            .push(*photos.entry(f.photo_id.as_str()).or_insert(next));
        out.emb.extend(unit);
        out.weight.push(face_weight(f));
        out.faces.push(f);
    }
    out
}

/// Picks a place from `sims` (candidate index, similarity), or none.
/// `previous` is the candidate the face had before, when it is among them.
fn choose(
    sims: &[(usize, f32)],
    previous: Option<usize>,
    thresholds: &Thresholds,
) -> Option<(usize, f32)> {
    let mut best: Option<(usize, f32)> = None;
    let mut second = f32::NEG_INFINITY;
    for &(c, s) in sims {
        match best {
            Some((bc, bs)) if s < bs || (s == bs && c > bc) => second = second.max(s),
            Some((_, bs)) => {
                second = second.max(bs);
                best = Some((c, s));
            }
            None => best = Some((c, s)),
        }
    }
    let (best_c, best_s) = best?;
    if let Some(p) = previous
        && let Some(&(_, ps)) = sims.iter().find(|(c, _)| *c == p)
        && ps >= thresholds.keep
        && best_s - ps <= thresholds.margin
    {
        return Some((p, ps));
    }
    (best_s >= thresholds.join && best_s - second >= thresholds.margin).then_some((best_c, best_s))
}

/// What every face brings to an assignment round, by face index.
#[derive(Clone, Copy)]
struct Rules<'a> {
    /// The centroid a face shaped, and with what weight (left out when it is scored).
    own: &'a [Option<(Label, f32)>],
    /// People the face was moved away from.
    blocked: &'a [Vec<Label>],
    /// Its earlier automatic place.
    previous: &'a [Option<Label>],
    thresholds: &'a Thresholds,
}

/// One assignment round: every face in `open` is offered the `centres`; faces
/// that would put two faces of one picture in the same place give way to the
/// most similar one, and nobody takes a place a picture already fills.
fn assign_round(
    data: &Prepared,
    open: &[usize],
    centres: &[Centre],
    rules: &Rules,
    occupied: &mut HashSet<(u32, Label)>,
) -> Vec<(usize, Label)> {
    let Rules {
        own,
        blocked,
        previous,
        thresholds,
    } = *rules;
    let proposals: Vec<(usize, Label, f32)> = open
        .par_iter()
        .filter_map(|&i| {
            let e = data.e(i);
            let mut sims = Vec::with_capacity(centres.len());
            let mut prev_at = None;
            for (c, centre) in centres.iter().enumerate() {
                if blocked[i].contains(&centre.label) {
                    continue;
                }
                let own_w = own[i].and_then(|(l, w)| (l == centre.label).then_some(w));
                if let Some(s) = centre.similarity(e, own_w) {
                    if previous[i] == Some(centre.label) {
                        prev_at = Some(c);
                    }
                    sims.push((c, s));
                }
            }
            choose(&sims, prev_at, thresholds).map(|(c, s)| (i, centres[c].label, s))
        })
        .collect();
    let mut proposals = proposals;
    proposals.sort_by(|a, b| {
        (data.photo[a.0], a.1)
            .cmp(&(data.photo[b.0], b.1))
            .then(b.2.total_cmp(&a.2))
            .then(a.0.cmp(&b.0))
    });
    let mut out = Vec::new();
    for (i, label, _) in proposals {
        if occupied.insert((data.photo[i], label)) {
            out.push((i, label));
        }
    }
    out
}

/// Proposes who every face is. Faces the function cannot place (too unclear,
/// ambiguous, or declared "not a person") are missing from the result. See the
/// README for the rules; the result depends only on the input, not its order.
pub fn cluster(
    faces: &[FaceRec],
    labels: &Labels,
    thresholds: &Thresholds,
) -> HashMap<FaceId, Assigned> {
    cluster_capped(faces, labels, thresholds, MAX_LINK_FACES)
}

/// [`cluster`] with at most `max_seeds` faces in the dense matrix.
fn cluster_capped(
    faces: &[FaceRec],
    labels: &Labels,
    thresholds: &Thresholds,
    max_seeds: usize,
) -> HashMap<FaceId, Assigned> {
    let max_seeds = max_seeds.min(MAX_LINK_FACES);
    let mut result: HashMap<FaceId, Assigned> = HashMap::new();

    // People the labels know of, sorted so their indices are deterministic.
    let mut known: Vec<&str> = labels
        .decided
        .values()
        .flatten()
        .chain(labels.previous.values())
        .chain(labels.confirmed.iter())
        .chain(labels.hidden.iter())
        .map(String::as_str)
        .collect();
    known.sort_unstable();
    known.dedup();
    let person_ix: HashMap<&str, usize> = known.iter().enumerate().map(|(i, p)| (*p, i)).collect();

    // Pinned faces are proposed as decided even without a usable embedding.
    for f in faces {
        if let Some(Some(p)) = labels.decided.get(&f.id) {
            result.insert(f.id.clone(), Assigned::Person(p.clone()));
        }
    }

    let data = prepare(faces);
    let n = data.faces.len();
    let dim = data.dim;

    #[derive(Clone, Copy, PartialEq)]
    enum State {
        Gone,
        Pinned(usize),
        Open,
    }
    let state: Vec<State> = data
        .faces
        .iter()
        .map(|f| match labels.decided.get(&f.id) {
            Some(None) => State::Gone,
            Some(Some(p)) => State::Pinned(person_ix[p.as_str()]),
            None => State::Open,
        })
        .collect();
    let blocked: Vec<Vec<Label>> = data
        .faces
        .iter()
        .map(|f| {
            labels.not.get(&f.id).map_or_else(Vec::new, |ps| {
                ps.iter()
                    .filter_map(|p| person_ix.get(p.as_str()).map(|&i| Label::Person(i)))
                    .collect()
            })
        })
        .collect();
    let previous_person: Vec<Option<usize>> = (0..n)
        .map(|i| {
            let p = labels.previous.get(&data.faces[i].id)?;
            let ix = person_ix[p.as_str()];
            (state[i] == State::Open && !blocked[i].contains(&Label::Person(ix))).then_some(ix)
        })
        .collect();

    // Places pictures already fill: (picture, label).
    let mut occupied: HashSet<(u32, Label)> = HashSet::new();
    let mut pinned_sum: Vec<Option<Vec<f32>>> = vec![None; known.len()];
    for i in 0..n {
        if let State::Pinned(p) = state[i] {
            occupied.insert((data.photo[i], Label::Person(p)));
            add_scaled(
                pinned_sum[p].get_or_insert_with(|| vec![0.0; dim]),
                data.e(i),
                1.0,
            );
        }
    }

    // 1. Centroids of existing people: pinned faces with weight 1, plus earlier
    // automatic members by their weight (at most one per picture). A confirmed
    // person's members must agree strongly with its pinned faces.
    let pinned_centre: Vec<Option<Vec<f32>>> = pinned_sum
        .iter()
        .map(|s| s.as_ref().and_then(|s| normalized(s)))
        .collect();
    let mut best_member: BTreeMap<(usize, u32), usize> = BTreeMap::new();
    for i in 0..n {
        let Some(p) = previous_person[i] else {
            continue;
        };
        if occupied.contains(&(data.photo[i], Label::Person(p))) {
            continue;
        }
        if labels.confirmed.contains(known[p])
            && let Some(c) = &pinned_centre[p]
            && dot(data.e(i), c) < thresholds.confident()
        {
            continue;
        }
        best_member
            .entry((p, data.photo[i]))
            .and_modify(|j| {
                if data.weight[i] > data.weight[*j] {
                    *j = i;
                }
            })
            .or_insert(i);
    }
    let mut sums = pinned_sum;
    let mut own: Vec<Option<(Label, f32)>> = vec![None; n];
    for (&(p, _), &i) in &best_member {
        add_scaled(
            sums[p].get_or_insert_with(|| vec![0.0; dim]),
            data.e(i),
            data.weight[i],
        );
        own[i] = Some((Label::Person(p), data.weight[i]));
    }
    let anchors: Vec<Centre> = sums
        .into_iter()
        .enumerate()
        .filter_map(|(p, s)| s.and_then(|s| Centre::new(Label::Person(p), s)))
        .collect();

    // 2. Open faces: keep an earlier place, else join the clearly best person.
    let previous: Vec<Option<Label>> = previous_person
        .iter()
        .map(|p| p.map(Label::Person))
        .collect();
    let open: Vec<usize> = (0..n).filter(|&i| state[i] == State::Open).collect();
    let mut placed: Vec<Option<Label>> = vec![None; n];
    let rules = Rules {
        own: &own,
        blocked: &blocked,
        previous: &previous,
        thresholds,
    };
    for (i, label) in assign_round(&data, &open, &anchors, &rules, &mut occupied) {
        placed[i] = Some(label);
    }

    // 3. Clear faces nobody took start new people, two or more at a time.
    let pool: Vec<usize> = open
        .iter()
        .copied()
        .filter(|&i| placed[i].is_none())
        .collect();
    let mut seeds: Vec<usize> = pool
        .iter()
        .copied()
        .filter(|&i| is_seed(data.faces[i], thresholds))
        .collect();
    if seeds.len() > max_seeds {
        // The clearest faces start people; the rest can still join them below.
        seeds.sort_by(|&a, &b| data.weight[b].total_cmp(&data.weight[a]).then(a.cmp(&b)));
        seeds.truncate(max_seeds);
        seeds.sort_unstable();
    }
    let mut seed_emb = Vec::with_capacity(seeds.len() * dim);
    for &i in &seeds {
        seed_emb.extend_from_slice(data.e(i));
    }
    let seed_photo: Vec<u32> = seeds.iter().map(|&i| data.photo[i]).collect();
    let groups: Vec<Vec<usize>> =
        link::average_linkage(&seed_emb, dim, &seed_photo, thresholds.link)
            .into_iter()
            .filter(|g| g.len() >= 2)
            .map(|g| g.into_iter().map(|k| seeds[k]).collect())
            .collect();

    // A group most of whose faces were one earlier person, who has no faces
    // now, keeps that person's id; the strongest claim wins.
    let used: HashSet<usize> = (0..n)
        .filter_map(|i| match (state[i], placed[i]) {
            (State::Pinned(p), _) | (_, Some(Label::Person(p))) => Some(p),
            _ => None,
        })
        .collect();
    let mut claims: Vec<(usize, usize, usize)> = Vec::new(); // (votes, group, person)
    for (g, members) in groups.iter().enumerate() {
        let mut votes: BTreeMap<usize, usize> = BTreeMap::new();
        for &i in members {
            if let Some(p) = previous_person[i] {
                *votes.entry(p).or_default() += 1;
            }
        }
        if let Some((&p, &count)) = votes.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
            && count * 2 > members.len()
            && !used.contains(&p)
            && members
                .iter()
                .all(|&i| !blocked[i].contains(&Label::Person(p)))
        {
            claims.push((count, g, p));
        }
    }
    claims.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut group_label: Vec<Option<Label>> = vec![None; groups.len()];
    let mut claimed: HashSet<usize> = HashSet::new();
    for (_, g, p) in claims {
        if group_label[g].is_none() && claimed.insert(p) {
            group_label[g] = Some(Label::Person(p));
        }
    }
    let mut next = 1u32;
    let group_label: Vec<Label> = group_label
        .into_iter()
        .map(|l| {
            l.unwrap_or_else(|| {
                next += 1;
                Label::Cluster(next - 1)
            })
        })
        .collect();
    for (members, &label) in groups.iter().zip(&group_label) {
        for &i in members {
            placed[i] = Some(label);
            occupied.insert((data.photo[i], label));
        }
    }

    // 4. Everyone still open may join the people just formed, under the same
    // rules; a person whose id a new group took is represented by that group.
    let mut centres: Vec<Centre> = anchors
        .into_iter()
        .filter(|c| !matches!(c.label, Label::Person(p) if claimed.contains(&p)))
        .collect();
    for (members, &label) in groups.iter().zip(&group_label) {
        let mut sum = vec![0.0; dim];
        for &i in members {
            add_scaled(&mut sum, data.e(i), data.weight[i]);
        }
        centres.extend(Centre::new(label, sum));
    }
    for o in &mut own {
        if matches!(o, Some((Label::Person(p), _)) if claimed.contains(p)) {
            *o = None;
        }
    }
    let rest: Vec<usize> = pool.into_iter().filter(|&i| placed[i].is_none()).collect();
    let rules = Rules {
        own: &own,
        blocked: &blocked,
        previous: &previous,
        thresholds,
    };
    for (i, label) in assign_round(&data, &rest, &centres, &rules, &mut occupied) {
        placed[i] = Some(label);
    }

    for (i, label) in placed.into_iter().enumerate() {
        let Some(label) = label else { continue };
        let assigned = match label {
            Label::Person(p) => Assigned::Person(known[p].to_string()),
            Label::Cluster(c) => Assigned::Cluster(c),
        };
        result.insert(data.faces[i].id.clone(), assigned);
    }
    result
}
