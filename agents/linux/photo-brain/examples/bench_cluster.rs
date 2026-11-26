//! Clustering benchmark on a synthetic library shaped like a family's:
//! `cargo run --release --example bench_cluster -- [pictures] [dim] [threads]`
//! (defaults 5000, 768, 4).

use std::time::Instant;

use photo_brain::cluster::{self, LatLon, Picture};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f64 {
        (self.next() % 1_000_000) as f64 / 1_000_000.0
    }
    fn vector(&mut self, dim: usize) -> Vec<f32> {
        let mut v: Vec<f32> = (0..dim).map(|_| self.unit() as f32 * 2.0 - 1.0).collect();
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter_mut().for_each(|x| *x /= n);
        v
    }
}

fn main() {
    let args: Vec<usize> = std::env::args()
        .skip(1)
        .filter_map(|a| a.parse().ok())
        .collect();
    let n = args.first().copied().unwrap_or(5000);
    let dim = args.get(1).copied().unwrap_or(768);
    let threads = args.get(2).copied().unwrap_or(4);
    let mut rng = Rng(0x5eed);
    let home = LatLon {
        lat: 59.33,
        lon: 18.06,
    };
    // Outings of 3-60 pictures over three years; 70 % at home, the rest
    // within 100 km, a few abroad. Each outing has its own look.
    let mut meta = Vec::new();
    let mut embeddings = Vec::new();
    let mut t = 1_700_000_000_000i64;
    while meta.len() < n {
        let size = 3 + (rng.next() % 58) as usize;
        let at = match rng.next() % 20 {
            0 => LatLon {
                lat: 48.0 + rng.unit() * 6.0,
                lon: 2.0 + rng.unit() * 20.0,
            },
            1..=5 => LatLon {
                lat: home.lat + (rng.unit() - 0.5),
                lon: home.lon + (rng.unit() - 0.5) * 2.0,
            },
            _ => home,
        };
        let centre = rng.vector(dim);
        for _ in 0..size.min(n - meta.len()) {
            t += (rng.next() % 600_000) as i64;
            let noise = rng.vector(dim);
            let mut e: Vec<f32> = centre
                .iter()
                .zip(&noise)
                .map(|(c, x)| c + 0.6 * x)
                .collect();
            let norm = e.iter().map(|x| x * x).sum::<f32>().sqrt();
            e.iter_mut().for_each(|x| *x /= norm);
            embeddings.push(e);
            let located = !rng.next().is_multiple_of(10);
            let timed = !rng.next().is_multiple_of(50);
            meta.push((
                timed.then_some(t),
                located.then_some(LatLon {
                    lat: at.lat + (rng.unit() - 0.5) * 0.01,
                    lon: at.lon + (rng.unit() - 0.5) * 0.01,
                }),
            ));
        }
        t += 3_600_000 * (4 + (rng.next() % 200) as i64);
    }
    let ids: Vec<String> = (0..n).map(|i| format!("p{i}")).collect();
    let pictures: Vec<Picture<'_>> = (0..n)
        .map(|i| Picture {
            id: &ids[i],
            taken_at: meta[i].0,
            utc_offset: None,
            location: meta[i].1,
            place: None,
            cc: None,
            embedding: Some(&embeddings[i]),
            burst: false,
            batch: None,
        })
        .collect();
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build()
        .unwrap();
    for run in 0..3 {
        let started = Instant::now();
        let result = pool.install(|| {
            cluster::cluster(&pictures, &cluster::Options::default(), &|cc| {
                cc.to_string()
            })
        });
        let elapsed = started.elapsed();
        let cands: usize = result.cand.iter().map(Vec::len).sum();
        println!(
            "run {run}: {n} pictures, dim {dim}, {threads} threads: {:.2} s; {} events, {} trips, {cands} candidates; {} of {} pairs ({:.1} %) needed a dot product",
            elapsed.as_secs_f64(),
            result.events.len(),
            result.trips.len(),
            result.stats.dots,
            result.stats.pairs,
            100.0 * result.stats.dots as f64 / result.stats.pairs as f64
        );
    }
}
