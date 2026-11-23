//! Synthetic people: a few identity directions in 512 dimensions, every face
//! its identity plus noise, the noise set by how clear the face is.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use super::vector::{dot, normalized};
use super::*;

const DIM: usize = 512;

/// splitmix64: deterministic, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn uniform(&mut self) -> f32 {
        ((self.next() >> 40) as f32 + 0.5) / (1u64 << 24) as f32
    }
    fn gauss(&mut self) -> f32 {
        let (u, v) = (self.uniform(), self.uniform());
        (-2.0 * u.ln()).sqrt() * (std::f32::consts::TAU * v).cos()
    }
    fn unit(&mut self) -> Vec<f32> {
        let v: Vec<f32> = (0..DIM).map(|_| self.gauss()).collect();
        normalized(&v).unwrap()
    }
    /// A unit vector exactly `c` similar to unit `centre`.
    fn near(&mut self, centre: &[f32], c: f32) -> Vec<f32> {
        let mut noise = self.unit();
        let d = dot(&noise, centre);
        for (x, y) in noise.iter_mut().zip(centre) {
            *x -= d * y;
        }
        let noise = normalized(&noise).unwrap();
        let s = (1.0 - c * c).max(0.0).sqrt();
        centre
            .iter()
            .zip(&noise)
            .map(|(a, b)| c * a + s * b)
            .collect()
    }
    /// An identity `corr` similar to `other` (a look-alike).
    fn like(&mut self, other: &[f32], corr: f32) -> Vec<f32> {
        self.near(other, corr)
    }
}

#[derive(Clone, Copy)]
enum Clarity {
    /// A seed: sharp, frontal, big.
    Clear,
    /// Still a seed, but noisier.
    Medium,
    /// Blurry or small: can join a person, never starts one.
    Noisy,
}

fn face(id: &str, photo: &str, embedding: Vec<f32>, clarity: Clarity) -> FaceRec {
    let (score, front, quality, px) = match clarity {
        Clarity::Clear => (0.95, 0.9, 80.0, 120.0),
        Clarity::Medium => (0.85, 0.6, 50.0, 70.0),
        Clarity::Noisy => (0.6, 0.2, 15.0, 25.0),
    };
    FaceRec {
        id: id.to_string(),
        photo_id: photo.to_string(),
        embedding,
        score,
        front,
        quality,
        px,
    }
}

/// How similar a face of each clarity is to its identity.
fn closeness(clarity: Clarity) -> f32 {
    match clarity {
        Clarity::Clear => 0.85,
        Clarity::Medium => 0.68,
        Clarity::Noisy => 0.55,
    }
}

/// `count` faces of `identity`, each in its own picture `<tag>-<k>`.
fn person_faces(
    rng: &mut Rng,
    tag: &str,
    identity: &[f32],
    plan: &[(Clarity, usize)],
) -> Vec<FaceRec> {
    let mut out = Vec::new();
    for &(clarity, count) in plan {
        for _ in 0..count {
            let k = out.len();
            let photo = format!("{tag}-{k:03}");
            out.push(face(
                &format!("{photo}.0"),
                &photo,
                rng.near(identity, closeness(clarity)),
                clarity,
            ));
        }
    }
    out
}

/// Faces grouped by where they ended up.
fn groups(result: &HashMap<FaceId, Assigned>) -> HashMap<Assigned, HashSet<FaceId>> {
    let mut out: HashMap<Assigned, HashSet<FaceId>> = HashMap::new();
    for (face, a) in result {
        out.entry(a.clone()).or_default().insert(face.clone());
    }
    out
}

fn tag_of(face: &str) -> &str {
    face.split('-').next().unwrap()
}

/// No place holds faces of two planted identities (tags before the `-`).
fn assert_no_false_merges(result: &HashMap<FaceId, Assigned>) {
    for (place, members) in groups(result) {
        let tags: HashSet<&str> = members.iter().map(|f| tag_of(f)).collect();
        assert_eq!(tags.len(), 1, "{place:?} mixes {tags:?}");
    }
}

fn two_look_alikes(seed: u64) -> (Vec<FaceRec>, Vec<f32>, Vec<f32>) {
    let mut rng = Rng(seed);
    let a = rng.unit();
    let b = rng.like(&a, 0.3);
    let plan = [
        (Clarity::Clear, 10),
        (Clarity::Medium, 6),
        (Clarity::Noisy, 8),
    ];
    let mut faces = person_faces(&mut rng, "a", &a, &plan);
    faces.extend(person_faces(&mut rng, "b", &b, &plan));
    (faces, a, b)
}

// (a) Two people, clear and noisy faces: separated, noisy faces join.
#[test]
fn two_people_are_separated_and_noisy_faces_join_them() {
    for seed in 1..=5 {
        let (faces, _, _) = two_look_alikes(seed);
        let result = cluster(&faces, &Labels::default(), &Thresholds::default());
        assert_no_false_merges(&result);
        let places = groups(&result);
        assert_eq!(places.len(), 2, "seed {seed}: {places:?}");
        for tag in ["a", "b"] {
            // Every clear and medium face (the seeds) is in one group.
            let seeds: HashSet<&Assigned> = faces
                .iter()
                .filter(|f| tag_of(&f.id) == tag && f.quality >= 30.0)
                .map(|f| result.get(&f.id).expect("seed placed"))
                .collect();
            assert_eq!(seeds.len(), 1);
            assert!(matches!(seeds.iter().next().unwrap(), Assigned::Cluster(_)));
            // Noisy faces (never seeds) joined in the second pass.
            let noisy = faces
                .iter()
                .filter(|f| tag_of(&f.id) == tag && f.quality < 30.0)
                .filter(|f| result.contains_key(&f.id))
                .count();
            assert_eq!(noisy, 8, "seed {seed} tag {tag}");
        }
    }
}

// (b) Two faces of one picture are never the same person.
#[test]
fn faces_of_one_picture_never_share_a_place() {
    let mut rng = Rng(11);
    let a = rng.unit();
    let b = rng.like(&a, 0.6);
    // A and B always together, and look-alikes (pairs ~0.43 > link).
    let mut faces = Vec::new();
    for k in 0..8 {
        let photo = format!("ab-{k}");
        faces.push(face(
            &format!("{photo}.0"),
            &photo,
            rng.near(&a, 0.85),
            Clarity::Clear,
        ));
        faces.push(face(
            &format!("{photo}.1"),
            &photo,
            rng.near(&b, 0.85),
            Clarity::Clear,
        ));
    }
    let result = cluster(&faces, &Labels::default(), &Thresholds::default());
    for k in 0..8 {
        let x = result.get(&format!("ab-{k}.0"));
        let y = result.get(&format!("ab-{k}.1"));
        assert!(x.is_some() && y.is_some());
        assert_ne!(x, y, "picture {k}");
    }
    // Each person's faces still form a group.
    let a_places: HashSet<_> = (0..8).map(|k| &result[&format!("ab-{k}.0")]).collect();
    assert_eq!(a_places.len(), 1);

    // Anchored: two faces like the pinned person in one picture; the more
    // similar one gets the person, the other stays open.
    let mut faces = person_faces(&mut rng, "a", &a, &[(Clarity::Clear, 4)]);
    let mut labels = Labels::default();
    for f in &faces {
        labels.decided.insert(f.id.clone(), Some("p1".into()));
    }
    faces.push(face("x-0.0", "x-0", rng.near(&a, 0.8), Clarity::Clear));
    faces.push(face("x-0.1", "x-0", rng.near(&a, 0.6), Clarity::Clear));
    // A third face in a picture that also has a pinned face of p1.
    faces.push(face("a-000.9", "a-000", rng.near(&a, 0.8), Clarity::Clear));
    let result = cluster(&faces, &labels, &Thresholds::default());
    let p1 = Some(&Assigned::Person("p1".into()));
    assert_eq!(result.get("x-0.0"), p1);
    // The two that gave way are open: never p1, though they may start a new
    // group together (they agree with each other).
    assert_ne!(result.get("x-0.1"), p1);
    assert_ne!(result.get("a-000.9"), p1);
}

// (c) Pinned faces stay put and pull similar faces; `not` is honoured.
#[test]
fn pinned_faces_win_and_moved_faces_stay_away() {
    let mut rng = Rng(21);
    let a = rng.unit();
    let b = rng.like(&a, 0.2);
    let mut faces = person_faces(
        &mut rng,
        "a",
        &a,
        &[(Clarity::Clear, 3), (Clarity::Noisy, 6)],
    );
    let mut labels = Labels::default();
    for f in faces.iter().take(3) {
        labels.decided.insert(f.id.clone(), Some("p1".into()));
    }
    // A face that looks like B but was pinned to p1: stays p1.
    faces.push(face("odd-0.0", "odd-0", rng.near(&b, 0.85), Clarity::Clear));
    labels.decided.insert("odd-0.0".into(), Some("p1".into()));
    // A face like A pinned to p2: stays p2.
    faces.push(face(
        "twin-0.0",
        "twin-0",
        rng.near(&a, 0.85),
        Clarity::Clear,
    ));
    labels.decided.insert("twin-0.0".into(), Some("p2".into()));
    // An A face moved away from p1: never proposed p1 again.
    faces.push(face(
        "moved-0.0",
        "moved-0",
        rng.near(&a, 0.85),
        Clarity::Clear,
    ));
    labels.not.insert("moved-0.0".into(), vec!["p1".into()]);
    // "Not a person": never in the result.
    faces.push(face(
        "none-0.0",
        "none-0",
        rng.near(&a, 0.85),
        Clarity::Clear,
    ));
    labels.decided.insert("none-0.0".into(), None);

    let result = cluster(&faces, &labels, &Thresholds::default());
    assert_eq!(result["odd-0.0"], Assigned::Person("p1".into()));
    assert_eq!(result["twin-0.0"], Assigned::Person("p2".into()));
    assert_ne!(
        result.get("moved-0.0"),
        Some(&Assigned::Person("p1".into()))
    );
    assert!(!result.contains_key("none-0.0"));

    // The noisy A faces are pulled to p1 by its pinned faces (without the
    // look-alike p2, which would make them ambiguous).
    let mut labels2 = labels.clone();
    labels2.decided.remove("twin-0.0");
    let faces2: Vec<FaceRec> = faces
        .iter()
        .filter(|f| f.id != "twin-0.0")
        .cloned()
        .collect();
    let result = cluster(&faces2, &labels2, &Thresholds::default());
    for f in &faces[3..9] {
        assert_eq!(
            result.get(&f.id),
            Some(&Assigned::Person("p1".into())),
            "{}",
            f.id
        );
    }
}

// (d) Hidden people still get proposals; a confirmed person's centroid is not
// dragged by earlier automatic mistakes.
#[test]
fn hidden_people_get_proposals_and_confirmed_people_resist_drift() {
    let mut rng = Rng(31);
    let a = rng.unit();
    let b = rng.like(&a, 0.2);
    let mut faces = person_faces(
        &mut rng,
        "a",
        &a,
        &[(Clarity::Clear, 4), (Clarity::Medium, 4)],
    );
    let bfaces = person_faces(&mut rng, "b", &b, &[(Clarity::Clear, 10)]);
    let mut labels = Labels::default();
    for f in faces.iter().take(4) {
        labels.decided.insert(f.id.clone(), Some("p1".into()));
    }
    labels.hidden.insert("p1".into());
    let result = cluster(&faces, &labels, &Thresholds::default());
    for f in &faces[4..] {
        assert_eq!(
            result[&f.id],
            Assigned::Person("p1".into()),
            "hidden still proposed"
        );
    }

    // An earlier mistake: ten B faces were automatically put in p1.
    for f in &bfaces {
        labels.previous.insert(f.id.clone(), "p1".into());
    }
    faces.extend(bfaces.iter().cloned());
    labels.confirmed.insert("p1".into());
    let result = cluster(&faces, &labels, &Thresholds::default());
    for f in &faces[4..8] {
        assert_eq!(result[&f.id], Assigned::Person("p1".into()));
    }
    // B leaves p1 and becomes its own new group (p1 is taken, so no id reuse).
    let b_places: HashSet<_> = bfaces.iter().map(|f| result.get(&f.id)).collect();
    assert_eq!(b_places.len(), 1, "{b_places:?}");
    assert!(matches!(
        b_places.into_iter().next().unwrap(),
        Some(Assigned::Cluster(_))
    ));

    // Unconfirmed, the same mistake keeps its grip (the old behaviour), which
    // is why confirmation matters.
    labels.confirmed.clear();
    let result = cluster(&faces, &labels, &Thresholds::default());
    assert!(
        bfaces
            .iter()
            .any(|f| result.get(&f.id) == Some(&Assigned::Person("p1".into())))
    );
}

// (e) Stability: same ids when run twice, and once the result is `previous`.
#[test]
fn ids_stay_stable_across_runs() {
    let (faces, _, _) = two_look_alikes(41);
    let first = cluster(&faces, &Labels::default(), &Thresholds::default());
    assert_eq!(
        first,
        cluster(&faces, &Labels::default(), &Thresholds::default())
    );
    // BrunoCAM turns n1, n2 into people p7, p8 and remembers them.
    let mut labels = Labels::default();
    for (face, a) in &first {
        let Assigned::Cluster(n) = a else {
            panic!("{a:?}")
        };
        labels.previous.insert(face.clone(), format!("p{}", n + 6));
    }
    let second = cluster(&faces, &labels, &Thresholds::default());
    for (face, a) in &first {
        let Assigned::Cluster(n) = a else {
            unreachable!()
        };
        assert_eq!(
            second.get(face),
            Some(&Assigned::Person(format!("p{}", n + 6)))
        );
    }
    assert_eq!(second, cluster(&faces, &labels, &Thresholds::default()));
}

// A new group whose faces were mostly an earlier person who now has no faces
// gets that person's id back; a taken id is not reused.
#[test]
fn new_groups_keep_the_earlier_persons_id() {
    let mut rng = Rng(45);
    let a = rng.unit();
    let faces = person_faces(&mut rng, "a", &a, &[(Clarity::Clear, 6)]);
    let mut labels = Labels::default();
    for f in faces.iter().take(4) {
        labels.previous.insert(f.id.clone(), "p4".into());
    }
    // Thresholds so strict that no existing person holds anyone (as after a
    // recalibration): the faces regroup, and 4 of 6 were p4.
    let t = Thresholds {
        join: 1.5,
        keep: 1.5,
        ..Thresholds::default()
    };
    let result = cluster(&faces, &labels, &t);
    for f in &faces {
        assert_eq!(result[&f.id], Assigned::Person("p4".into()), "{}", f.id);
    }
    // A face that moved away from p4 in the group: the id is not reused.
    let mut moved = labels.clone();
    moved.not.insert(faces[5].id.clone(), vec!["p4".into()]);
    let result = cluster(&faces, &moved, &t);
    assert!(matches!(result[&faces[0].id], Assigned::Cluster(1)));
    // p4 pinned on somebody else: taken, so the group is a new one.
    let mut all = faces.clone();
    all.push(face("q-0.0", "q-0", rng.near(&a, 0.0), Clarity::Clear));
    labels.decided.insert("q-0.0".into(), Some("p4".into()));
    let result = cluster(&all, &labels, &t);
    assert_eq!(result["q-0.0"], Assigned::Person("p4".into()));
    for f in &faces {
        assert_eq!(result[&f.id], Assigned::Cluster(1), "{}", f.id);
    }
}

// (f) A stranger just below `join` stays open; just above, it joins.
#[test]
fn a_stranger_just_below_join_stays_open() {
    let mut rng = Rng(51);
    let a = rng.unit();
    let t = Thresholds::default();
    let mut faces = Vec::new();
    let mut labels = Labels::default();
    for k in 0..3 {
        let photo = format!("a-{k}");
        faces.push(face(
            &format!("{photo}.0"),
            &photo,
            a.clone(),
            Clarity::Clear,
        ));
        labels
            .decided
            .insert(format!("{photo}.0"), Some("p1".into()));
    }
    faces.push(face(
        "s-0.0",
        "s-0",
        rng.near(&a, t.join - 0.01),
        Clarity::Clear,
    ));
    faces.push(face(
        "s-1.0",
        "s-1",
        rng.near(&a, t.join + 0.01),
        Clarity::Clear,
    ));
    let result = cluster(&faces, &labels, &t);
    assert_eq!(result.get("s-0.0"), None);
    assert_eq!(result.get("s-1.0"), Some(&Assigned::Person("p1".into())));
}

// New places need a margin; an earlier place is kept only when nobody clearly
// beats it.
#[test]
fn margins_decide_between_close_people() {
    let mut rng = Rng(61);
    let u1 = rng.unit();
    let u2 = rng.near(&u1, 0.0);
    let t = Thresholds::default();
    let mut faces = Vec::new();
    let mut labels = Labels::default();
    for (p, u) in [("p1", &u1), ("p2", &u2)] {
        for k in 0..3 {
            let photo = format!("{p}-{k}");
            faces.push(face(
                &format!("{photo}.0"),
                &photo,
                u.clone(),
                Clarity::Clear,
            ));
            labels.decided.insert(format!("{photo}.0"), Some(p.into()));
        }
    }
    // e = x u1 + y u2 + rest, orthogonal rest.
    let mix = |rng: &mut Rng, x: f32, y: f32| -> Vec<f32> {
        let mut r = rng.unit();
        for u in [&u1, &u2] {
            let d = dot(&r, u);
            for (a, b) in r.iter_mut().zip(u.iter()) {
                *a -= d * b;
            }
        }
        let r = normalized(&r).unwrap();
        let s = (1.0 - x * x - y * y).sqrt();
        (0..DIM).map(|i| x * u1[i] + y * u2[i] + s * r[i]).collect()
    };
    // One probe at a time, so a probe with an earlier place does not shape
    // the centroid the next probe sees (its own share is left out anyway).
    // (similarity to p1, to p2, earlier place, expected)
    let probes = [
        (0.60, 0.58, None, None),             // ambiguous: open
        (0.60, 0.30, None, Some("p1")),       // clearly p1
        (0.37, 0.35, Some("p2"), Some("p2")), // p2 still fine, p1 only slightly better: kept
        (0.60, 0.35, Some("p2"), Some("p1")), // p1 far better: moves
        (0.45, 0.25, Some("p2"), Some("p1")), // p2 below keep: moves
    ];
    for (k, (x, y, earlier, expected)) in probes.into_iter().enumerate() {
        let mut faces = faces.clone();
        let mut labels = labels.clone();
        faces.push(face(
            "probe-0.0",
            "probe-0",
            mix(&mut rng, x, y),
            Clarity::Noisy,
        ));
        if let Some(p) = earlier {
            labels.previous.insert("probe-0.0".into(), p.into());
        }
        let result = cluster(&faces, &labels, &t);
        assert_eq!(
            result.get("probe-0.0"),
            expected.map(|p| Assigned::Person(p.into())).as_ref(),
            "probe {k}"
        );
    }
}

// Tiny or blurry faces never start a person, but can join one.
#[test]
fn unclear_faces_never_start_a_person() {
    let mut rng = Rng(71);
    let a = rng.unit();
    let mut faces = Vec::new();
    for k in 0..6 {
        let photo = format!("t-{k}");
        let mut f = face(
            &format!("{photo}.0"),
            &photo,
            rng.near(&a, 0.85),
            Clarity::Clear,
        );
        if k % 2 == 0 {
            f.px = 20.0; // tiny
        } else {
            f.quality = 10.0; // blurry
        }
        faces.push(f);
    }
    let result = cluster(&faces, &Labels::default(), &Thresholds::default());
    assert!(result.is_empty(), "{result:?}");
    faces.extend(person_faces(&mut rng, "c", &a, &[(Clarity::Clear, 3)]));
    let result = cluster(&faces, &Labels::default(), &Thresholds::default());
    assert_eq!(groups(&result).len(), 1);
    assert_eq!(result.len(), 9);
}

// (g) The result does not depend on the order of the input.
#[test]
fn result_is_deterministic_and_order_independent() {
    let (mut faces, _, _) = two_look_alikes(81);
    let mut rng = Rng(82);
    let c = rng.unit();
    faces.extend(person_faces(
        &mut rng,
        "c",
        &c,
        &[(Clarity::Clear, 5), (Clarity::Noisy, 5)],
    ));
    let labels = Labels {
        previous: faces
            .iter()
            .take(5)
            .map(|f| (f.id.clone(), "p3".into()))
            .collect(),
        ..Labels::default()
    };
    let t = Thresholds::default();
    let first = cluster(&faces, &labels, &t);
    for round in 0..5 {
        // Fisher-Yates with the deterministic generator.
        for i in (1..faces.len()).rev() {
            let j = (rng.next() % (i as u64 + 1)) as usize;
            faces.swap(i, j);
        }
        assert_eq!(cluster(&faces, &labels, &t), first, "round {round}");
    }
}

// More seeds than the matrix holds: the clearest start people, the others
// still join them.
#[test]
fn seeds_beyond_the_cap_still_join() {
    let mut rng = Rng(95);
    let a = rng.unit();
    let b = rng.unit();
    let mut faces = person_faces(
        &mut rng,
        "a",
        &a,
        &[(Clarity::Clear, 4), (Clarity::Medium, 6)],
    );
    faces.extend(person_faces(
        &mut rng,
        "b",
        &b,
        &[(Clarity::Clear, 4), (Clarity::Medium, 6)],
    ));
    let result = super::cluster_capped(&faces, &Labels::default(), &Thresholds::default(), 8);
    assert_eq!(result.len(), 20);
    assert_no_false_merges(&result);
    assert_eq!(groups(&result).len(), 2);
}

/// `people` identities × `per` faces (clear, medium and noisy mixed).
fn crowd(seed: u64, people: usize, per: usize) -> Vec<FaceRec> {
    let mut rng = Rng(seed);
    let mut faces = Vec::with_capacity(people * per);
    for p in 0..people {
        let identity = rng.unit();
        let plan = [
            (Clarity::Clear, per / 2),
            (Clarity::Medium, per / 4),
            (Clarity::Noisy, per - per / 2 - per / 4),
        ];
        faces.extend(person_faces(
            &mut rng,
            &format!("x{p:04}"),
            &identity,
            &plan,
        ));
    }
    faces
}

// (h) 3000 faces stay fast (a relaxed bound; debug builds are slow).
#[test]
fn three_thousand_faces_are_fast_enough() {
    let faces = crowd(91, 60, 50);
    let started = Instant::now();
    let result = cluster(&faces, &Labels::default(), &Thresholds::default());
    let took = started.elapsed();
    assert!(took.as_secs() < 120, "took {took:?}");
    assert_no_false_merges(&result);
    assert_eq!(groups(&result).len(), 60);
}

/// `cargo test --release -- --ignored --nocapture bench_`
#[test]
#[ignore = "benchmark"]
fn bench_six_thousand_seeds() {
    // 120 people × 50 seeds; then the cap (8000) as 160 × 50.
    for people in [120, 160] {
        let mut rng = Rng(99);
        let mut faces = Vec::new();
        for p in 0..people {
            let identity = rng.unit();
            faces.extend(person_faces(
                &mut rng,
                &format!("y{p:04}"),
                &identity,
                &[(Clarity::Clear, 25), (Clarity::Medium, 25)],
            ));
        }
        let started = Instant::now();
        let result = cluster(&faces, &Labels::default(), &Thresholds::default());
        let took = started.elapsed();
        eprintln!(
            "{} seed faces of {DIM} dims: {took:?}, {} placed, {} groups",
            faces.len(),
            result.len(),
            groups(&result).len()
        );
        assert_no_false_merges(&result);
    }
}

/// A long tail: 1500 people with 4 seeds each (many small groups and lone
/// strangers), 20000 unclear faces joining them, 50 pinned people.
#[test]
#[ignore = "benchmark"]
fn bench_long_tail() {
    let mut rng = Rng(98);
    let mut faces = Vec::new();
    let mut labels = Labels::default();
    for p in 0..1500 {
        let identity = rng.unit();
        let plan = [(Clarity::Clear, 4), (Clarity::Noisy, 13)];
        let mine = person_faces(&mut rng, &format!("z{p:04}"), &identity, &plan);
        if p < 50 {
            for f in mine.iter().take(2) {
                labels.decided.insert(f.id.clone(), Some(format!("p{p}")));
            }
        }
        faces.extend(mine);
    }
    let started = Instant::now();
    let result = cluster(&faces, &labels, &Thresholds::default());
    let took = started.elapsed();
    eprintln!(
        "{} faces (6000 seeds, 1500 people): {took:?}, {} placed, {} groups",
        faces.len(),
        result.len(),
        groups(&result).len()
    );
    assert_no_false_merges(&result);
}

// The calibration finds the planted separation and proposes thresholds that
// keep false merges at or below 1 %.
#[test]
fn calibration_on_synthetic_people() {
    let faces = crowd(101, 8, 30);
    let truth: HashMap<FaceId, PersonId> = faces
        .iter()
        .map(|f| (f.id.clone(), format!("p{}", tag_of(&f.id))))
        .collect();
    let report = calibrate(&faces, &truth);
    eprintln!("{report}");
    assert_eq!((report.faces, report.people), (240, 8));
    assert!(report.same.mean > 0.3 && report.different.mean.abs() < 0.05);
    assert!(report.same.p50 > report.different.p95);
    let proposed = report.proposed.clone().expect("two people or more");
    // At most 1 % of different-person pairs reach the proposed link.
    let mut reached = 0u64;
    let mut total = 0u64;
    for i in 0..faces.len() {
        for j in i + 1..faces.len() {
            if truth[&faces[i].id] != truth[&faces[j].id] {
                total += 1;
                if dot(&faces[i].embedding, &faces[j].embedding) >= proposed.link {
                    reached += 1;
                }
            }
        }
    }
    assert!(reached as f64 <= 0.01 * total as f64, "{reached}/{total}");
    assert!(proposed.keep <= proposed.join);
    let u = report.proposed_unanchored.as_ref().unwrap();
    assert!(u.pair_precision >= 0.99, "{u}");
    assert!(report.current_unanchored.bcubed_f > 0.9);
    let a = report.proposed_anchored.as_ref().unwrap();
    assert_eq!(a.wrong, 0);
    assert!(a.correct * 10 >= a.held_out * 9, "{a}");

    // One person: nothing to separate, no proposal.
    let one: HashMap<FaceId, PersonId> = faces
        .iter()
        .filter(|f| tag_of(&f.id) == "x0000")
        .map(|f| (f.id.clone(), "p1".into()))
        .collect();
    assert!(calibrate(&faces, &one).proposed.is_none());
}
