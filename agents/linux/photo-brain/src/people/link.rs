//! Average-linkage agglomerative grouping with a cannot-link rule, in O(n²)
//! time and n²/2 f32 of memory.
//!
//! The similarity of two groups is the average cosine similarity over all their
//! face pairs (UPGMA). Two faces of the same picture are never the same person,
//! so their similarity is `-inf`; an average that includes `-inf` stays `-inf`,
//! which keeps any two groups holding faces of one picture apart forever.
//!
//! The merges are found with the nearest-neighbour chain: average linkage is
//! reducible (a merged group is never closer to a third than the closer of its
//! two parts), so merging reciprocal nearest neighbours gives the same groups
//! as always merging the globally best pair. A group whose best neighbour is
//! below the threshold can never merge again (any later neighbour is an average
//! of groups it is already below), so it is finished and leaves the search.

use rayon::prelude::*;

use super::vector::dot;

/// Most faces the dense matrix may hold: 8000 faces take 8000² / 2 × 4 bytes =
/// 128 MB. The caller passes at most this many.
pub const MAX_LINK_FACES: usize = 8000;

/// Upper-triangular (i < j) similarities, row after row.
struct Condensed {
    n: usize,
    offsets: Vec<usize>,
    values: Vec<f32>,
}

impl Condensed {
    #[inline]
    fn index(&self, a: usize, b: usize) -> usize {
        let (i, j) = if a < b { (a, b) } else { (b, a) };
        self.offsets[i] + (j - i - 1)
    }
    #[inline]
    fn get(&self, a: usize, b: usize) -> f32 {
        self.values[self.index(a, b)]
    }
    #[inline]
    fn set(&mut self, a: usize, b: usize, value: f32) {
        let index = self.index(a, b);
        self.values[index] = value;
    }
}

/// Pairwise cosine similarities of `n` unit vectors of `dim` values stored one
/// after the other in `embeddings`; `-inf` for two faces of the same `photo`.
fn similarities(embeddings: &[f32], dim: usize, photos: &[u32]) -> Condensed {
    let n = photos.len();
    let mut offsets = Vec::with_capacity(n);
    let mut total = 0usize;
    for i in 0..n {
        offsets.push(total);
        total += n - 1 - i;
    }
    let mut values = vec![0f32; total];
    let mut rows: Vec<&mut [f32]> = Vec::with_capacity(n);
    let mut rest: &mut [f32] = &mut values;
    for i in 0..n {
        let (row, tail) = rest.split_at_mut(n - 1 - i);
        rows.push(row);
        rest = tail;
    }
    rows.into_par_iter().enumerate().for_each(|(i, row)| {
        let a = &embeddings[i * dim..(i + 1) * dim];
        for (t, out) in row.iter_mut().enumerate() {
            let j = i + 1 + t;
            *out = if photos[i] == photos[j] {
                f32::NEG_INFINITY
            } else {
                dot(a, &embeddings[j * dim..(j + 1) * dim])
            };
        }
    });
    Condensed { n, offsets, values }
}

/// Groups the faces (unit `embeddings`, `dim` values each, `photos[i]` the
/// picture of face `i`) while the average similarity of two groups is at least
/// `threshold`. Returns every group (singletons too), each sorted, ordered by
/// their first member. Deterministic for a given input.
pub(crate) fn average_linkage(
    embeddings: &[f32],
    dim: usize,
    photos: &[u32],
    threshold: f32,
) -> Vec<Vec<usize>> {
    let n = photos.len();
    assert!(n <= MAX_LINK_FACES, "too many faces for the dense matrix");
    assert_eq!(embeddings.len(), n * dim);
    if n == 0 {
        return Vec::new();
    }
    let mut sims = similarities(embeddings, dim, photos);
    debug_assert_eq!(sims.n, n);
    let mut size = vec![1u32; n];
    let mut members: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
    // Groups still searching for a partner, in any order, with each one's slot.
    let mut active: Vec<usize> = (0..n).collect();
    let mut slot: Vec<usize> = (0..n).collect();
    let remove = |active: &mut Vec<usize>, slot: &mut Vec<usize>, x: usize| {
        let at = slot[x];
        let last = *active.last().expect("active is not empty");
        active.swap_remove(at);
        if last != x {
            slot[last] = at;
        }
        slot[x] = usize::MAX;
    };
    let mut done: Vec<usize> = Vec::new();
    let mut chain: Vec<usize> = Vec::new();

    while !active.is_empty() {
        if chain.is_empty() {
            // The lowest active index, for a deterministic start.
            chain.push(*active.iter().min().expect("active is not empty"));
        }
        let top = *chain.last().expect("chain is not empty");
        let previous = chain.len().checked_sub(2).map(|i| chain[i]);
        // Best neighbour: highest similarity, ties to the previous chain link
        // (so the chain cannot cycle), then to the lowest index.
        let mut best: Option<(f32, usize)> = previous.map(|p| (sims.get(top, p), p));
        for &k in &active {
            if k == top || Some(k) == previous {
                continue;
            }
            let s = sims.get(top, k);
            let better = match best {
                None => true,
                Some((bs, bk)) => s > bs || (s == bs && Some(bk) != previous && k < bk),
            };
            if better {
                best = Some((s, k));
            }
        }
        match best {
            Some((s, k)) if s >= threshold => {
                if Some(k) == previous {
                    chain.pop();
                    chain.pop();
                    let (a, b) = if top < k { (top, k) } else { (k, top) };
                    let (na, nb) = (size[a] as f32, size[b] as f32);
                    remove(&mut active, &mut slot, b);
                    for &c in &active {
                        if c == a {
                            continue;
                        }
                        let merged = (na * sims.get(a, c) + nb * sims.get(b, c)) / (na + nb);
                        sims.set(a, c, merged);
                    }
                    size[a] += size[b];
                    let moved = std::mem::take(&mut members[b]);
                    members[a].extend(moved);
                } else {
                    chain.push(k);
                }
            }
            _ => {
                // Nobody is close enough now, so nobody ever will be.
                chain.pop();
                remove(&mut active, &mut slot, top);
                done.push(top);
            }
        }
    }

    let mut groups: Vec<Vec<usize>> = done
        .into_iter()
        .map(|g| {
            let mut m = std::mem::take(&mut members[g]);
            m.sort_unstable();
            m
        })
        .collect();
    groups.sort_unstable_by_key(|g| g[0]);
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The plain O(n³) greedy version, as the TypeScript grouping did it.
    fn greedy(embeddings: &[f32], dim: usize, photos: &[u32], threshold: f32) -> Vec<Vec<usize>> {
        let n = photos.len();
        let sim = |i: usize, j: usize| {
            if photos[i] == photos[j] {
                f32::NEG_INFINITY
            } else {
                dot(
                    &embeddings[i * dim..(i + 1) * dim],
                    &embeddings[j * dim..(j + 1) * dim],
                )
            }
        };
        let mut groups: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
        loop {
            let mut best = (f32::NEG_INFINITY, 0, 0);
            for a in 0..groups.len() {
                for b in a + 1..groups.len() {
                    let mut total = 0f32;
                    for &i in &groups[a] {
                        for &j in &groups[b] {
                            total += sim(i, j);
                        }
                    }
                    let avg = total / (groups[a].len() * groups[b].len()) as f32;
                    if avg > best.0 {
                        best = (avg, a, b);
                    }
                }
            }
            if best.0 < threshold {
                break;
            }
            let moved = groups.remove(best.2);
            groups[best.1].extend(moved);
        }
        for g in &mut groups {
            g.sort_unstable();
        }
        groups.sort_unstable_by_key(|g| g[0]);
        groups
    }

    fn lcg(seed: &mut u64) -> f32 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((*seed >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }

    #[test]
    fn matches_the_greedy_reference_on_random_points() {
        let dim = 6;
        for round in 0..20u64 {
            let mut seed = round * 7919 + 1;
            let n = 30;
            let mut embeddings = Vec::new();
            for _ in 0..n {
                let v: Vec<f32> = (0..dim).map(|_| lcg(&mut seed)).collect();
                embeddings.extend(super::super::vector::normalized(&v).unwrap());
            }
            let photos: Vec<u32> = (0..n as u32)
                .map(|i| i / if round % 2 == 0 { 1 } else { 3 })
                .collect();
            for threshold in [0.2f32, 0.5, 0.8] {
                assert_eq!(
                    average_linkage(&embeddings, dim, &photos, threshold),
                    greedy(&embeddings, dim, &photos, threshold),
                    "round {round} threshold {threshold}"
                );
            }
        }
    }

    #[test]
    fn faces_of_one_picture_never_share_a_group() {
        // Four identical faces, two pictures with two faces each.
        let embeddings = [1.0f32, 0.0].repeat(4);
        let photos = [0, 0, 1, 1];
        let groups = average_linkage(&embeddings, 2, &photos, 0.1);
        for g in &groups {
            let mut seen: Vec<u32> = g.iter().map(|&i| photos[i]).collect();
            seen.dedup();
            assert_eq!(seen.len(), g.len());
        }
        assert_eq!(groups.len(), 2);
    }
}
