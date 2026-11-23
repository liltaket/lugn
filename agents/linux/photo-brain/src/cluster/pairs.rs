//! Pair scores, each picture's best candidates and its near-duplicates.
//!
//! Every row (one picture against all others) is independent, so rows run in
//! parallel. Within a row the cheap parts of every pair's score (time, place,
//! outing, trip) are computed first; with the look term assumed perfect that
//! gives an upper bound. Pairs are then visited best bound first and the
//! embedding dot product is only computed while the bound can still beat the
//! row's current `max_candidates`-th best, so most pairs never touch it. The
//! result is exactly what scoring every pair would give (tested).

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use rayon::prelude::*;

use super::events::Events;
use super::score::{distance_km, dot, place_score, time_score, visual_score};
use super::{Cand, LatLon, Picture};

pub const MIN_SCORE: f32 = 0.30;
pub const MAX_CANDIDATES: usize = 48;
const MAX_DUPLICATES: usize = 16;

const W_TIME: f32 = 0.3;
const W_PLACE: f32 = 0.2;
/// Both pictures at home: being at home says nothing about belonging together.
const W_PLACE_AT_HOME: f32 = 0.05;
const W_VISUAL: f32 = 0.3;
const AT_HOME_KM: f64 = 5.0;
/// Further apart than this (and not close in time) is not one group.
const FAR_KM: f64 = 150.0;
/// Without a time on both sides a pair cannot score more than this.
pub const UNTIMED_CAP: f32 = 0.55;
const SAME_EVENT_BONUS: f32 = 0.08;
const SAME_TRIP_BONUS: f32 = 0.08;
/// Same album import batch, used only when time or GPS is missing.
const SAME_BATCH_BONUS: f32 = 0.05;
const DUPLICATE_GAP_MS: i64 = 120_000;
const DUPLICATE_COSINE: f32 = 0.94;
/// Frames the album marks as one burst need less visual agreement.
const BURST_COSINE: f32 = 0.80;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PairStats {
    /// Ordered pairs looked at (each unordered pair twice, once per row).
    pub pairs: u64,
    /// Embedding dot products computed.
    pub dots: u64,
}

/// Everything about a pair except how alike the pictures look.
#[derive(Debug, Clone, Copy)]
struct Partial {
    sum: f32,
    weight: f32,
    delta: Option<i64>,
    far: bool,
    bonus: f32,
    untimed: bool,
    time: Option<f32>,
    place: Option<f32>,
}

impl Partial {
    /// The combined 0-1 score once the look term (if any) is known.
    fn finish(&self, visual: Option<f32>) -> f32 {
        let (mut sum, mut weight) = (self.sum, self.weight);
        if let Some(v) = visual {
            sum += W_VISUAL * v;
            weight += W_VISUAL;
        }
        let mut score = if weight > 0.0 { sum / weight } else { 0.0 };
        // Far apart in time and not alike: not a group, whatever else says.
        if self.delta.is_some_and(|d| d > 14 * 86_400_000) && visual.unwrap_or(0.0) < 0.6 {
            score *= 0.5;
        }
        if self.far && self.delta.is_none_or(|d| d > 6 * 3_600_000) {
            score *= 0.4;
        }
        score += self.bonus;
        if self.untimed {
            score = score.min(UNTIMED_CAP);
        }
        score.clamp(0.0, 1.0)
    }
}

pub struct Context<'a> {
    taken_at: Vec<Option<i64>>,
    gps: Vec<Option<LatLon>>,
    /// GPS, or borrowed from the picture's outing.
    location: Vec<Option<LatLon>>,
    at_home: Vec<bool>,
    /// In a trip or far from home.
    away: Vec<bool>,
    trip: &'a [Option<u32>],
    event: &'a [Option<u32>],
    batch: Vec<Option<u32>>,
    burst: Vec<bool>,
    embedding: Vec<Option<&'a [f32]>>,
}

impl<'a> Context<'a> {
    pub fn new(
        pictures: &'a [Picture<'a>],
        home: Option<LatLon>,
        trip: &'a [Option<u32>],
        events: &'a Events,
    ) -> Self {
        let dim = pictures.iter().find_map(|p| p.embedding).map(<[f32]>::len);
        let mut batches: HashMap<&str, u32> = HashMap::new();
        let batch = pictures
            .iter()
            .map(|p| {
                p.batch.map(|b| {
                    let next = batches.len() as u32;
                    *batches.entry(b).or_insert(next)
                })
            })
            .collect();
        let near = |at: Option<LatLon>, km: f64| match (at, home) {
            (Some(at), Some(home)) => distance_km(at, home) <= km,
            _ => false,
        };
        Self {
            taken_at: pictures.iter().map(|p| p.taken_at).collect(),
            gps: pictures.iter().map(|p| p.location).collect(),
            location: events.location.clone(),
            at_home: pictures
                .iter()
                .map(|p| near(p.location, AT_HOME_KM))
                .collect(),
            away: (0..pictures.len())
                .map(|i| {
                    trip[i].is_some()
                        || (home.is_some()
                            && events.location[i].is_some()
                            && !near(events.location[i], FAR_KM))
                })
                .collect(),
            trip,
            event: &events.event_of,
            batch,
            burst: pictures.iter().map(|p| p.burst).collect(),
            // A stray embedding of another length (another model) is ignored.
            embedding: pictures
                .iter()
                .map(|p| {
                    p.embedding
                        .filter(|e| Some(e.len()) == dim && !e.is_empty())
                })
                .collect(),
        }
    }

    fn len(&self) -> usize {
        self.taken_at.len()
    }

    fn partial(&self, i: usize, j: usize) -> Partial {
        // Always in the same order, so score(i, j) == score(j, i) bit for bit.
        let (a, b) = (i.min(j), i.max(j));
        let mut sum = 0.0;
        let mut weight = 0.0;
        let delta = match (self.taken_at[a], self.taken_at[b]) {
            (Some(x), Some(y)) => Some((x - y).abs()),
            _ => None,
        };
        let time = delta.map(time_score);
        if let Some(t) = time {
            sum += W_TIME * t;
            weight += W_TIME;
        }
        let place = match (self.gps[a], self.gps[b]) {
            (Some(x), Some(y)) => Some(place_score(distance_km(x, y))),
            _ => None,
        };
        if let Some(p) = place {
            let w = if self.at_home[a] && self.at_home[b] {
                W_PLACE_AT_HOME
            } else {
                W_PLACE
            };
            sum += w * p;
            weight += w;
        }
        let same_trip = self.trip[a].is_some() && self.trip[a] == self.trip[b];
        let far = match (self.location[a], self.location[b]) {
            (Some(x), Some(y)) => distance_km(x, y) > FAR_KM,
            // Nothing says where one of them was: the other being on a trip or
            // far from home still keeps them apart.
            (None, Some(_)) => self.away[b] && !same_trip,
            (Some(_), None) => self.away[a] && !same_trip,
            (None, None) => false,
        };
        let mut bonus = 0.0;
        if same_trip {
            bonus += SAME_TRIP_BONUS;
        }
        if self.event[a].is_some() && self.event[a] == self.event[b] {
            bonus += SAME_EVENT_BONUS;
        }
        let incomplete = delta.is_none() || self.gps[a].is_none() || self.gps[b].is_none();
        if incomplete && self.batch[a].is_some() && self.batch[a] == self.batch[b] {
            bonus += SAME_BATCH_BONUS;
        }
        Partial {
            sum,
            weight,
            delta,
            far,
            bonus,
            untimed: delta.is_none(),
            time,
            place,
        }
    }

    fn cosine(&self, i: usize, j: usize) -> Option<f32> {
        let (a, b) = (i.min(j), i.max(j));
        Some(dot(self.embedding[a]?, self.embedding[b]?))
    }

    fn both_embedded(&self, i: usize, j: usize) -> bool {
        self.embedding[i].is_some() && self.embedding[j].is_some()
    }

    fn is_duplicate(&self, i: usize, j: usize, cosine: Option<f32>) -> bool {
        cosine.is_some_and(|c| c >= DUPLICATE_COSINE)
            || (self.burst[i] && self.burst[j] && cosine.is_none_or(|c| c >= BURST_COSINE))
    }

    /// The exact score of a pair (for tests and diagnostics).
    pub fn score(&self, i: usize, j: usize) -> f32 {
        self.partial(i, j)
            .finish(self.cosine(i, j).map(visual_score))
    }

    fn row(&self, i: usize, min_score: f32, max: usize) -> (Vec<Cand>, Vec<u32>, PairStats) {
        let n = self.len();
        let mut stats = PairStats {
            pairs: n.saturating_sub(1) as u64,
            dots: 0,
        };
        let mut best = Best {
            heap: BinaryHeap::with_capacity(max + 1),
            max,
            min_score,
        };
        let mut duplicates = Vec::new();
        let mut rest: Vec<(f32, u32)> = Vec::new();
        for j in (0..n).filter(|&j| j != i) {
            let partial = self.partial(i, j);
            if partial.delta.is_some_and(|d| d <= DUPLICATE_GAP_MS) {
                // Close in time: always look, a duplicate must never be missed.
                let cosine = self.cosine(i, j);
                stats.dots += u64::from(cosine.is_some());
                if self.is_duplicate(i, j, cosine) {
                    duplicates.push(j as u32);
                } else {
                    best.offer(j, &partial, cosine.map(visual_score));
                }
                continue;
            }
            let bound = if self.both_embedded(i, j) {
                partial.finish(Some(1.0))
            } else {
                partial.finish(None)
            };
            if bound >= min_score {
                rest.push((bound, j as u32));
            }
        }
        rest.sort_unstable_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        for (bound, j) in rest {
            if best.full() && best.worst().is_some_and(|w| bound < w.score) {
                break;
            }
            let j = j as usize;
            let cosine = self.cosine(i, j);
            stats.dots += u64::from(cosine.is_some());
            best.offer(j, &self.partial(i, j), cosine.map(visual_score));
        }
        let mut list: Vec<Cand> = best.heap.into_iter().map(|w| w.0).collect();
        list.sort_by(order);
        duplicates.truncate(MAX_DUPLICATES);
        (list, duplicates, stats)
    }

    /// Every picture's best candidates (best first) and near-duplicates.
    pub fn candidates(
        &self,
        min_score: f32,
        max: usize,
    ) -> (Vec<Vec<Cand>>, Vec<Vec<u32>>, PairStats) {
        let rows: Vec<_> = (0..self.len())
            .into_par_iter()
            .map(|i| self.row(i, min_score, max))
            .collect();
        let mut stats = PairStats::default();
        let mut cand = Vec::with_capacity(rows.len());
        let mut du = Vec::with_capacity(rows.len());
        for (c, d, s) in rows {
            stats.pairs += s.pairs;
            stats.dots += s.dots;
            cand.push(c);
            du.push(d);
        }
        (cand, du, stats)
    }
}

/// Best first: higher score, then lower index.
fn order(a: &Cand, b: &Cand) -> Ordering {
    b.score.total_cmp(&a.score).then(a.other.cmp(&b.other))
}

/// Max-heap whose top is the worst kept candidate.
struct Worst(Cand);
impl PartialEq for Worst {
    fn eq(&self, other: &Self) -> bool {
        order(&self.0, &other.0) == Ordering::Equal
    }
}
impl Eq for Worst {}
impl PartialOrd for Worst {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Worst {
    fn cmp(&self, other: &Self) -> Ordering {
        order(&self.0, &other.0)
    }
}

struct Best {
    heap: BinaryHeap<Worst>,
    max: usize,
    min_score: f32,
}

impl Best {
    fn full(&self) -> bool {
        self.heap.len() >= self.max
    }
    fn worst(&self) -> Option<&Cand> {
        self.heap.peek().map(|w| &w.0)
    }
    fn offer(&mut self, j: usize, partial: &Partial, look: Option<f32>) {
        let score = partial.finish(look);
        if score < self.min_score || self.max == 0 {
            return;
        }
        let cand = Cand {
            other: j as u32,
            score,
            time: partial.time,
            place: partial.place,
            look,
        };
        if self.full() {
            if self
                .worst()
                .is_some_and(|w| order(&cand, w) == Ordering::Less)
            {
                self.heap.pop();
            } else {
                return;
            }
        }
        self.heap.push(Worst(cand));
    }
}

#[cfg(test)]
mod tests {
    use super::super::events::find_events;
    use super::*;

    const H: i64 = 3_600_000;
    const DAY: i64 = 24 * H;
    const HOME: LatLon = LatLon {
        lat: 59.33,
        lon: 18.06,
    };
    const LAKE: LatLon = LatLon {
        lat: 59.60,
        lon: 18.70,
    };

    fn unit(seed: u64, dim: usize) -> Vec<f32> {
        let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut v: Vec<f32> = (0..dim)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (x % 2000) as f32 / 1000.0 - 1.0
            })
            .collect();
        let norm = v.iter().map(|a| a * a).sum::<f32>().sqrt();
        v.iter_mut().for_each(|a| *a /= norm);
        v
    }

    /// A unit vector with cosine `c` to `base` (`base` and `other` unit, roughly orthogonal).
    fn with_cosine(base: &[f32], other: &[f32], c: f32) -> Vec<f32> {
        let along = dot(base, other);
        let mut ortho: Vec<f32> = other.iter().zip(base).map(|(o, b)| o - along * b).collect();
        let norm = ortho.iter().map(|a| a * a).sum::<f32>().sqrt();
        ortho.iter_mut().for_each(|a| *a /= norm);
        let s = (1.0 - c * c).sqrt();
        base.iter()
            .zip(&ortho)
            .map(|(b, o)| c * b + s * o)
            .collect()
    }

    fn pic<'a>(t: Option<i64>, at: Option<LatLon>, e: Option<&'a [f32]>) -> Picture<'a> {
        Picture {
            id: "x",
            taken_at: t,
            utc_offset: Some(3600),
            location: at,
            embedding: e,
            ..Default::default()
        }
    }

    fn score_of(
        pictures: &[Picture<'_>],
        home: Option<LatLon>,
        trip: &[Option<u32>],
        i: usize,
        j: usize,
    ) -> f32 {
        let events = find_events(pictures, 4 * H, 25.0);
        Context::new(pictures, home, trip, &events).score(i, j)
    }

    #[test]
    fn being_at_home_says_little() {
        let a = unit(1, 64);
        let b = with_cosine(&a, &unit(2, 64), 0.7);
        let t0 = 1000 * DAY;
        let at_home = [
            pic(Some(t0), Some(HOME), Some(&a)),
            pic(Some(t0 + 10 * DAY), Some(HOME), Some(&b)),
        ];
        let at_lake = [
            pic(Some(t0), Some(LAKE), Some(&a)),
            pic(Some(t0 + 10 * DAY), Some(LAKE), Some(&b)),
        ];
        let none = [None, None];
        let home_score = score_of(&at_home, Some(HOME), &none, 0, 1);
        let lake_score = score_of(&at_lake, Some(HOME), &none, 0, 1);
        assert!(
            home_score + 0.1 < lake_score,
            "home {home_score} lake {lake_score}"
        );
    }

    #[test]
    fn a_pair_without_time_is_capped() {
        let a = unit(1, 64);
        let pictures = [
            pic(None, Some(LAKE), Some(&a)),
            pic(Some(1000 * DAY), Some(LAKE), Some(&a)),
        ];
        let s = score_of(&pictures, None, &[None, None], 0, 1);
        assert!((s - UNTIMED_CAP).abs() < 1e-6, "{s}");
    }

    #[test]
    fn no_gps_on_one_side_does_not_skip_the_distance_penalty() {
        let a = unit(1, 64);
        let b = with_cosine(&a, &unit(2, 64), 0.8);
        let krakow = LatLon {
            lat: 50.06,
            lon: 19.94,
        };
        let t0 = 1000 * DAY;
        // A picture at home without GPS, and a trip picture in Kraków two days later.
        let pictures = [
            pic(Some(t0), None, Some(&a)),
            pic(Some(t0 + 2 * DAY), Some(krakow), Some(&b)),
        ];
        let penalised = score_of(&pictures, Some(HOME), &[None, Some(0)], 0, 1);
        // The same pair when the second picture is at home.
        let pictures_home = [
            pic(Some(t0), None, Some(&a)),
            pic(Some(t0 + 2 * DAY), Some(HOME), Some(&b)),
        ];
        let plain = score_of(&pictures_home, Some(HOME), &[None, None], 0, 1);
        assert!(
            (penalised - plain * 0.4).abs() < 1e-5,
            "{penalised} vs {plain}"
        );
        // Both on the same trip: no penalty.
        let same_trip = score_of(&pictures, Some(HOME), &[Some(0), Some(0)], 0, 1);
        assert!(same_trip > plain, "{same_trip} {plain}");
    }

    #[test]
    fn same_outing_and_same_batch_lift_a_pair() {
        let a = unit(1, 64);
        let b = with_cosine(&a, &unit(2, 64), 0.6);
        let t0 = 1000 * DAY;
        let together = [
            pic(Some(t0), Some(LAKE), Some(&a)),
            pic(Some(t0 + 3 * H), Some(LAKE), Some(&b)),
        ];
        // Five hours apart: two outings.
        let apart = [
            pic(Some(t0), Some(LAKE), Some(&a)),
            pic(Some(t0 + 5 * H), Some(LAKE), Some(&b)),
        ];
        let s_together = score_of(&together, None, &[None, None], 0, 1);
        let s_apart = score_of(&apart, None, &[None, None], 0, 1);
        assert!(s_together - s_apart > 0.08, "{s_together} {s_apart}");

        // No GPS: the import batch hints at one moment.
        let mut unplaced = [
            pic(Some(t0), None, Some(&a)),
            pic(Some(t0 + 2 * DAY), None, Some(&b)),
        ];
        let without = score_of(&unplaced, None, &[None, None], 0, 1);
        unplaced[0].batch = Some("b1");
        unplaced[1].batch = Some("b1");
        let with = score_of(&unplaced, None, &[None, None], 0, 1);
        assert!(
            (with - without - SAME_BATCH_BONUS).abs() < 1e-6,
            "{with} {without}"
        );
        // A batch says nothing extra when time and GPS are both known.
        let mut full = together.clone();
        full[0].batch = Some("b1");
        full[1].batch = Some("b1");
        assert_eq!(score_of(&full, None, &[None, None], 0, 1), s_together);
    }

    #[test]
    fn duplicates_leave_the_candidates() {
        let a = unit(1, 64);
        let twin = with_cosine(&a, &unit(2, 64), 0.97);
        let burst = with_cosine(&a, &unit(3, 64), 0.85);
        let other = with_cosine(&a, &unit(4, 64), 0.7);
        let t0 = 1000 * DAY;
        let mut pictures = vec![
            pic(Some(t0), Some(LAKE), Some(&a)),
            pic(Some(t0 + 5_000), Some(LAKE), Some(&twin)),
            pic(Some(t0 + 9_000), Some(LAKE), Some(&burst)),
            pic(Some(t0 + 600_000), Some(LAKE), Some(&other)),
        ];
        let none = vec![None; 4];
        let events = find_events(&pictures, 4 * H, 25.0);
        let (cand, du, _) = Context::new(&pictures, None, &none, &events).candidates(MIN_SCORE, 48);
        assert_eq!(du[0], vec![1]);
        assert!(cand[0].iter().all(|c| c.other != 1));
        assert!(cand[0].iter().any(|c| c.other == 2));
        // The album's burst flag makes 0.85 a duplicate.
        pictures[0].burst = true;
        pictures[2].burst = true;
        let (cand, du, _) = Context::new(&pictures, None, &none, &events).candidates(MIN_SCORE, 48);
        assert_eq!(du[0], vec![1, 2]);
        assert_eq!(du[2], vec![0]);
        assert_eq!(cand[0].iter().map(|c| c.other).collect::<Vec<_>>(), vec![3]);
    }

    #[test]
    fn candidates_carry_their_components() {
        let a = unit(1, 64);
        let pictures = [
            pic(Some(0), Some(LAKE), Some(&a)),
            pic(Some(10 * 60_000), None, None),
        ];
        let events = find_events(&pictures, 4 * H, 25.0);
        let (cand, _, _) =
            Context::new(&pictures, None, &[None, None], &events).candidates(0.0, 48);
        let c = &cand[0][0];
        assert_eq!(c.time, Some(1.0));
        assert_eq!(c.place, None);
        assert_eq!(c.look, None);
    }

    /// The pruned search returns exactly what scoring every pair returns.
    #[test]
    fn pruning_changes_nothing() {
        let mut rng = 7u64;
        let mut next = move || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            rng
        };
        let centres: Vec<Vec<f32>> = (0..12).map(|k| unit(100 + k, 32)).collect();
        let mut embeddings = Vec::new();
        let mut meta = Vec::new();
        for k in 0..400u64 {
            let group = (next() % 12) as usize;
            let e = with_cosine(
                &centres[group],
                &unit(1000 + k, 32),
                0.6 + (next() % 35) as f32 / 100.0,
            );
            embeddings.push(e);
            let t = (next() % 5 != 0)
                .then(|| (group as i64) * 9 * DAY + (next() % (3 * DAY as u64)) as i64);
            let at = (next() % 4 != 0).then(|| LatLon {
                lat: 59.0 + group as f64 * 0.4 + (next() % 100) as f64 / 1000.0,
                lon: 18.0 + (next() % 100) as f64 / 1000.0,
            });
            meta.push((t, at, next() % 7 == 0));
        }
        let pictures: Vec<Picture<'_>> = embeddings
            .iter()
            .zip(&meta)
            .enumerate()
            .map(|(k, (e, (t, at, no_embedding)))| Picture {
                id: "x",
                taken_at: *t,
                location: *at,
                embedding: (!no_embedding).then_some(e.as_slice()),
                burst: k % 9 == 0,
                batch: Some(if k % 3 == 0 { "b1" } else { "b2" }),
                ..Default::default()
            })
            .collect();
        let trip: Vec<Option<u32>> = (0..pictures.len())
            .map(|k| (k % 11 == 0).then_some(0))
            .collect();
        let events = find_events(&pictures, 4 * H, 25.0);
        let context = Context::new(&pictures, Some(HOME), &trip, &events);
        for max in [5, 48] {
            let (cand, du, stats) = context.candidates(MIN_SCORE, max);
            assert!(stats.dots < stats.pairs);
            for i in 0..pictures.len() {
                let mut brute: Vec<Cand> = Vec::new();
                let mut brute_du = Vec::new();
                for j in (0..pictures.len()).filter(|&j| j != i) {
                    let partial = context.partial(i, j);
                    let cosine = context.cosine(i, j);
                    if partial.delta.is_some_and(|d| d <= DUPLICATE_GAP_MS)
                        && context.is_duplicate(i, j, cosine)
                    {
                        brute_du.push(j as u32);
                        continue;
                    }
                    let look = cosine.map(visual_score);
                    let score = partial.finish(look);
                    if score >= MIN_SCORE {
                        brute.push(Cand {
                            other: j as u32,
                            score,
                            time: partial.time,
                            place: partial.place,
                            look,
                        });
                    }
                }
                brute.sort_by(order);
                brute.truncate(max);
                assert_eq!(cand[i], brute, "row {i}");
                assert_eq!(du[i], brute_du, "row {i}");
            }
        }
        // Symmetric.
        assert_eq!(context.score(3, 17), context.score(17, 3));
    }
}
