//! Measuring the face model against the household's own decisions, and
//! proposing thresholds from them.

use std::collections::{BTreeMap, HashMap};
use std::fmt;

use rayon::prelude::*;

use super::vector::dot;
use super::{Assigned, FaceId, FaceRec, Labels, PersonId, Thresholds, cluster, prepare};

/// The false-merge rate the proposed thresholds aim for.
pub const FALSE_MERGE_TARGET: f64 = 0.01;

/// Summary of a set of cosine similarities.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Distribution {
    pub count: u64,
    pub mean: f32,
    pub p5: f32,
    pub p50: f32,
    pub p95: f32,
}

/// How a grouping compares with the truth (faces it left open count as alone).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ClusterScores {
    /// Of the face pairs the grouping put together, the share that are one person.
    pub pair_precision: f32,
    /// Of the face pairs that are one person, the share the grouping put together.
    pub pair_recall: f32,
    pub pair_f: f32,
    pub bcubed_precision: f32,
    pub bcubed_recall: f32,
    pub bcubed_f: f32,
    /// Share of the faces the grouping placed at all.
    pub placed: f32,
    /// Distinct places (people and new groups) it used.
    pub groups: usize,
}

/// Every other face of each person (in id order) pinned, the rest proposed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AnchoredScores {
    pub held_out: usize,
    /// Proposed as their own person.
    pub correct: usize,
    /// Proposed as somebody else (a false merge).
    pub wrong: usize,
    /// Put in a new group instead.
    pub new_group: usize,
    /// Left without a proposal.
    pub open: usize,
}

#[derive(Debug, Clone)]
pub struct CalibrationReport {
    /// Truth faces with a usable embedding, and the people they show.
    pub faces: usize,
    pub people: usize,
    /// Face pairs of the same person, and of different people.
    pub same: Distribution,
    pub different: Distribution,
    /// A face against its own person's centroid without it (people with two or
    /// more faces), and against the most similar other person's centroid.
    pub own_centroid: Distribution,
    pub best_other_centroid: Distribution,
    pub current: Thresholds,
    pub current_unanchored: ClusterScores,
    pub current_anchored: AnchoredScores,
    /// `None` when the truth has fewer than two people (nothing to separate).
    pub proposed: Option<Thresholds>,
    pub proposed_unanchored: Option<ClusterScores>,
    pub proposed_anchored: Option<AnchoredScores>,
}

/// [`calibrate_with`] against the default thresholds.
pub fn calibrate(faces: &[FaceRec], truth: &HashMap<FaceId, PersonId>) -> CalibrationReport {
    calibrate_with(faces, truth, &Thresholds::default())
}

/// Compares same-person and different-person similarities among the faces the
/// household decided (`truth`), proposes thresholds that keep false merges at
/// or below 1 %, and scores the grouping with `current` and with the proposal.
///
/// The proposal: `link` is the lowest value that at most 1 % of different-person
/// face pairs reach; `join` the lowest that at most 1 % of faces reach against
/// their most similar wrong person's centroid; `keep` the lowest that at most
/// 1 % of (face, wrong person) pairs reach, never above `join`. The margin and
/// the seed limits are kept from `current`.
pub fn calibrate_with(
    faces: &[FaceRec],
    truth: &HashMap<FaceId, PersonId>,
    current: &Thresholds,
) -> CalibrationReport {
    let chosen: Vec<FaceRec> = faces
        .iter()
        .filter(|f| truth.contains_key(&f.id))
        .cloned()
        .collect();
    let data = prepare(&chosen);
    let n = data.faces.len();
    let mut names: Vec<&str> = data.faces.iter().map(|f| truth[&f.id].as_str()).collect();
    names.sort_unstable();
    names.dedup();
    let person_of: Vec<usize> = data
        .faces
        .iter()
        .map(|f| names.binary_search(&truth[&f.id].as_str()).expect("known"))
        .collect();
    let people = names.len();

    // Pair similarities, as histograms so memory stays small.
    let (same, different) = (0..n)
        .into_par_iter()
        .fold(
            || (Histogram::new(), Histogram::new()),
            |(mut same, mut diff), i| {
                for j in i + 1..n {
                    let s = dot(data.e(i), data.e(j));
                    if person_of[i] == person_of[j] {
                        same.add(s);
                    } else {
                        diff.add(s);
                    }
                }
                (same, diff)
            },
        )
        .reduce(
            || (Histogram::new(), Histogram::new()),
            |(mut a, mut b), (c, d)| {
                a.merge(&c);
                b.merge(&d);
                (a, b)
            },
        );

    // Centroids of every truth person, each face with weight 1.
    let dim = data.dim;
    let mut sums = vec![vec![0f32; dim]; people];
    let mut sizes = vec![0usize; people];
    for i in 0..n {
        super::vector::add_scaled(&mut sums[person_of[i]], data.e(i), 1.0);
        sizes[person_of[i]] += 1;
    }
    let norms: Vec<f32> = sums.iter().map(|s| dot(s, s)).collect();
    let mut own = Vec::new();
    let mut best_other = Vec::new();
    let mut every_other = Histogram::new();
    for (i, &p) in person_of.iter().enumerate() {
        let e = data.e(i);
        if sizes[p] >= 2 {
            let d = dot(e, &sums[p]);
            let rest = norms[p] - 2.0 * d + 1.0;
            if rest > 1e-6 {
                own.push((d - 1.0) / rest.sqrt());
            }
        }
        let mut best = f32::NEG_INFINITY;
        for q in 0..people {
            if q == p || norms[q] <= 1e-12 {
                continue;
            }
            let s = dot(e, &sums[q]) / norms[q].sqrt();
            every_other.add(s);
            best = best.max(s);
        }
        if best.is_finite() {
            best_other.push(best);
        }
    }

    let proposed = (people >= 2 && different.count > 0).then(|| {
        let join = lowest_rarely_reached(&mut best_other.clone(), FALSE_MERGE_TARGET);
        let keep = every_other
            .lowest_rarely_reached(FALSE_MERGE_TARGET)
            .min(join);
        let link = different.lowest_rarely_reached(FALSE_MERGE_TARGET);
        Thresholds {
            join,
            keep,
            link,
            ..current.clone()
        }
    });

    let score = |t: &Thresholds| {
        (
            unanchored(&chosen, truth, t),
            anchored(&chosen, truth, &data.faces, t),
        )
    };
    let (current_unanchored, current_anchored) = score(current);
    let (proposed_unanchored, proposed_anchored) = match &proposed {
        Some(t) => {
            let (u, a) = score(t);
            (Some(u), Some(a))
        }
        None => (None, None),
    };

    CalibrationReport {
        faces: n,
        people,
        same: same.distribution(),
        different: different.distribution(),
        own_centroid: distribution(&mut own),
        best_other_centroid: distribution(&mut best_other),
        current: current.clone(),
        current_unanchored,
        current_anchored,
        proposed,
        proposed_unanchored,
        proposed_anchored,
    }
}

/// The grouping with no decisions at all, against the truth.
fn unanchored(
    faces: &[FaceRec],
    truth: &HashMap<FaceId, PersonId>,
    thresholds: &Thresholds,
) -> ClusterScores {
    let result = cluster(faces, &Labels::default(), thresholds);
    let mut ids: Vec<&FaceId> = faces.iter().map(|f| &f.id).collect();
    ids.sort_unstable();
    ids.dedup();
    let truth_of: Vec<&str> = ids.iter().map(|id| truth[*id].as_str()).collect();
    let predicted: Vec<String> = ids
        .iter()
        .map(|id| match result.get(*id) {
            Some(Assigned::Person(p)) => format!("p:{p}"),
            Some(Assigned::Cluster(c)) => format!("n:{c}"),
            None => format!("alone:{id}"),
        })
        .collect();
    let placed = ids.iter().filter(|id| result.contains_key(**id)).count();
    let groups = {
        let mut g: Vec<&Assigned> = result.values().collect();
        g.sort_by_key(|a| format!("{a:?}"));
        g.dedup();
        g.len()
    };
    let mut scores = compare(&predicted, &truth_of);
    scores.placed = ratio(placed as f64, ids.len() as f64) as f32;
    scores.groups = groups;
    scores
}

/// Pairwise and B-cubed precision and recall of `predicted` against `truth`.
fn compare(predicted: &[String], truth: &[&str]) -> ClusterScores {
    let mut cells: HashMap<(&str, &str), u64> = HashMap::new();
    let mut by_pred: HashMap<&str, u64> = HashMap::new();
    let mut by_truth: HashMap<&str, u64> = HashMap::new();
    for (p, t) in predicted.iter().zip(truth) {
        *cells.entry((p.as_str(), t)).or_default() += 1;
        *by_pred.entry(p.as_str()).or_default() += 1;
        *by_truth.entry(t).or_default() += 1;
    }
    let pairs = |k: u64| (k * k.saturating_sub(1) / 2) as f64;
    let together: f64 = cells.values().map(|&k| pairs(k)).sum();
    let predicted_pairs: f64 = by_pred.values().map(|&k| pairs(k)).sum();
    let truth_pairs: f64 = by_truth.values().map(|&k| pairs(k)).sum();
    let pair_precision = if predicted_pairs == 0.0 {
        1.0
    } else {
        together / predicted_pairs
    };
    let pair_recall = if truth_pairs == 0.0 {
        1.0
    } else {
        together / truth_pairs
    };
    let n = predicted.len() as f64;
    let (mut bp, mut br) = (0.0, 0.0);
    for (&(p, t), &k) in &cells {
        let k = k as f64;
        bp += k * k / by_pred[p] as f64;
        br += k * k / by_truth[t] as f64;
    }
    let (bp, br) = if n == 0.0 {
        (1.0, 1.0)
    } else {
        (bp / n, br / n)
    };
    ClusterScores {
        pair_precision: pair_precision as f32,
        pair_recall: pair_recall as f32,
        pair_f: harmonic(pair_precision, pair_recall) as f32,
        bcubed_precision: bp as f32,
        bcubed_recall: br as f32,
        bcubed_f: harmonic(bp, br) as f32,
        placed: 0.0,
        groups: 0,
    }
}

/// Every other face of each person pinned, the rest proposed.
fn anchored(
    faces: &[FaceRec],
    truth: &HashMap<FaceId, PersonId>,
    sorted: &[&FaceRec],
    thresholds: &Thresholds,
) -> AnchoredScores {
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
    let mut labels = Labels::default();
    let mut held = Vec::new();
    for f in sorted {
        let p = truth[&f.id].as_str();
        let k = seen.entry(p).or_default();
        if k.is_multiple_of(2) {
            labels.decided.insert(f.id.clone(), Some(p.to_string()));
        } else {
            held.push((f.id.clone(), p));
        }
        *k += 1;
    }
    let result = cluster(faces, &labels, thresholds);
    let mut scores = AnchoredScores {
        held_out: held.len(),
        ..AnchoredScores::default()
    };
    for (id, p) in held {
        match result.get(&id) {
            Some(Assigned::Person(q)) if q == p => scores.correct += 1,
            Some(Assigned::Person(_)) => scores.wrong += 1,
            Some(Assigned::Cluster(_)) => scores.new_group += 1,
            None => scores.open += 1,
        }
    }
    scores
}

fn harmonic(a: f64, b: f64) -> f64 {
    if a + b == 0.0 {
        0.0
    } else {
        2.0 * a * b / (a + b)
    }
}

fn ratio(a: f64, b: f64) -> f64 {
    if b == 0.0 { 0.0 } else { a / b }
}

/// The lowest threshold that at most `rate` of `values` reach (`>=`).
fn lowest_rarely_reached(values: &mut [f32], rate: f64) -> f32 {
    if values.is_empty() {
        return 1.0;
    }
    values.sort_unstable_by(|a, b| b.total_cmp(a));
    let allowed = (rate * values.len() as f64).floor() as usize;
    if allowed >= values.len() {
        return -1.0;
    }
    // Just above the first value that would be one too many.
    values[allowed].next_up()
}

fn distribution(values: &mut [f32]) -> Distribution {
    if values.is_empty() {
        return Distribution::default();
    }
    values.sort_unstable_by(f32::total_cmp);
    let at = |q: f64| values[((values.len() - 1) as f64 * q).round() as usize];
    Distribution {
        count: values.len() as u64,
        mean: (values.iter().map(|&v| v as f64).sum::<f64>() / values.len() as f64) as f32,
        p5: at(0.05),
        p50: at(0.5),
        p95: at(0.95),
    }
}

const BINS: usize = 4000;

/// Cosine similarities in `BINS` bins over [-1, 1].
#[derive(Clone)]
struct Histogram {
    counts: Vec<u64>,
    count: u64,
    sum: f64,
}

impl Histogram {
    fn new() -> Self {
        Self {
            counts: vec![0; BINS],
            count: 0,
            sum: 0.0,
        }
    }
    fn bin(v: f32) -> usize {
        (((v.clamp(-1.0, 1.0) + 1.0) / 2.0 * BINS as f32) as usize).min(BINS - 1)
    }
    fn lower(bin: usize) -> f32 {
        bin as f32 / BINS as f32 * 2.0 - 1.0
    }
    fn add(&mut self, v: f32) {
        self.counts[Self::bin(v)] += 1;
        self.count += 1;
        self.sum += v as f64;
    }
    fn merge(&mut self, other: &Self) {
        for (a, b) in self.counts.iter_mut().zip(&other.counts) {
            *a += b;
        }
        self.count += other.count;
        self.sum += other.sum;
    }
    fn quantile(&self, q: f64) -> f32 {
        let target = (q * self.count.saturating_sub(1) as f64).round() as u64;
        let mut seen = 0;
        for (b, &c) in self.counts.iter().enumerate() {
            seen += c;
            if seen > target {
                return Self::lower(b) + 1.0 / BINS as f32;
            }
        }
        1.0
    }
    /// The lowest bin edge that at most `rate` of the values reach; the bins'
    /// width (0.0005) is the only rounding, always upwards.
    fn lowest_rarely_reached(&self, rate: f64) -> f32 {
        let allowed = (rate * self.count as f64).floor() as u64;
        let mut above = 0u64;
        for b in (0..BINS).rev() {
            if above + self.counts[b] > allowed {
                return Self::lower(b + 1);
            }
            above += self.counts[b];
        }
        -1.0
    }
    fn distribution(&self) -> Distribution {
        if self.count == 0 {
            return Distribution::default();
        }
        Distribution {
            count: self.count,
            mean: (self.sum / self.count as f64) as f32,
            p5: self.quantile(0.05),
            p50: self.quantile(0.5),
            p95: self.quantile(0.95),
        }
    }
}

impl fmt::Display for Distribution {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "n={:<9} mean {:.3}  p5 {:.3}  p50 {:.3}  p95 {:.3}",
            self.count, self.mean, self.p5, self.p50, self.p95
        )
    }
}

impl fmt::Display for ClusterScores {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "pairs P {:.3} R {:.3} F {:.3}; B-cubed P {:.3} R {:.3} F {:.3}; placed {:.0} %, {} groups",
            self.pair_precision,
            self.pair_recall,
            self.pair_f,
            self.bcubed_precision,
            self.bcubed_recall,
            self.bcubed_f,
            self.placed * 100.0,
            self.groups
        )
    }
}

impl fmt::Display for AnchoredScores {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} held out: {} right, {} wrong person, {} new group, {} open",
            self.held_out, self.correct, self.wrong, self.new_group, self.open
        )
    }
}

impl fmt::Display for CalibrationReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let t = |t: &Thresholds| {
            format!(
                "join {:.3}  keep {:.3}  link {:.3}  margin {:.3}",
                t.join, t.keep, t.link, t.margin
            )
        };
        writeln!(f, "{} decided faces, {} people", self.faces, self.people)?;
        writeln!(f, "same person pairs       {}", self.same)?;
        writeln!(f, "different people pairs  {}", self.different)?;
        writeln!(f, "face vs own centroid    {}", self.own_centroid)?;
        writeln!(f, "face vs best other      {}", self.best_other_centroid)?;
        writeln!(f, "current   {}", t(&self.current))?;
        writeln!(f, "  no decisions:  {}", self.current_unanchored)?;
        writeln!(f, "  half decided:  {}", self.current_anchored)?;
        match (
            &self.proposed,
            &self.proposed_unanchored,
            &self.proposed_anchored,
        ) {
            (Some(p), Some(u), Some(a)) => {
                writeln!(f, "proposed  {} (false merges <= 1 %)", t(p))?;
                writeln!(f, "  no decisions:  {u}")?;
                writeln!(f, "  half decided:  {a}")
            }
            _ => writeln!(f, "proposed  none (the truth needs two people or more)"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rarely_reached_allows_exactly_the_rate() {
        let mut values: Vec<f32> = (0..200).map(|i| i as f32 / 200.0).collect();
        let t = lowest_rarely_reached(&mut values, 0.01);
        let reached = values.iter().filter(|&&v| v >= t).count();
        assert_eq!(reached, 2);
        let mut h = Histogram::new();
        for i in 0..200 {
            h.add(i as f32 / 200.0);
        }
        let t = h.lowest_rarely_reached(0.01);
        assert!((0..200).filter(|&i| i as f32 / 200.0 >= t).count() <= 2);
        assert!((0..200).filter(|&i| i as f32 / 200.0 >= t - 0.006).count() > 2);
    }

    #[test]
    fn perfect_grouping_scores_one() {
        let predicted: Vec<String> = ["a", "a", "b", "b"].iter().map(|s| s.to_string()).collect();
        let truth = ["x", "x", "y", "y"];
        let s = compare(&predicted, &truth);
        assert_eq!(
            (s.pair_precision, s.pair_recall, s.bcubed_f),
            (1.0, 1.0, 1.0)
        );
        let merged: Vec<String> = ["a"; 4].iter().map(|s| s.to_string()).collect();
        let s = compare(&merged, &truth);
        assert!((s.pair_precision - 2.0 / 6.0).abs() < 1e-6);
        assert_eq!(s.pair_recall, 1.0);
        assert!((s.bcubed_precision - 0.5).abs() < 1e-6);
    }
}
