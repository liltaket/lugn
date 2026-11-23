//! End to end: a mock Lugn (album, state, people, intel) that also plays
//! Apple's picture host, a deterministic fake analyser, and 300 pictures with
//! planted structure: three outings, a trip abroad with a day without GPS, a
//! burst, pictures without GPS or time, documents and a screenshot.

#[path = "../src/mockhttp.rs"]
mod mockhttp;

use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use mockhttp::{MockServer, Response};
use photo_brain::analysis::{
    FaceObservation, ModelIds, PictureAnalysis, PictureAnalyzer, PictureQuality,
};
use photo_brain::bundle::Bundle;
use photo_brain::client::DownloadRules;
use photo_brain::config::{Config, Token};
use photo_brain::service::{Brain, Published};
use serde_json::{Value, json};

const DIM: usize = 64;
/// Scene labels point along the first axes; picture content lives on the others.
const SCENE_KEYS: [(&str, Option<&str>); 6] = [
    ("beach", Some("Stranden")),
    ("forest", Some("Skogen")),
    ("screen", Some("Skärm")),
    ("document", None),
    ("city", Some("Staden")),
    ("dog", Some("Hund")),
];
const SCREEN_AXIS: usize = 2;
const H: i64 = 3_600_000;
const DAY: i64 = 24 * H;
/// 2026-04-01 00:00 UTC.
const T0: i64 = 1_775_001_600_000;

const HOME: (f64, f64) = (59.3293, 18.0686);
const LAKE: (f64, f64) = (59.60, 18.70);
const UPPSALA: (f64, f64) = (59.8586, 17.6389);
const SIGTUNA: (f64, f64) = (59.6174, 17.7236);
const KRAKOW: (f64, f64) = (50.0614, 19.9366);

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
}

fn normalise(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter_mut().for_each(|x| *x /= n);
}

/// A random unit vector on the content axes.
fn content(seed: u64) -> Vec<f32> {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut v: Vec<f32> = (0..DIM)
        .map(|k| {
            if k < SCENE_KEYS.len() {
                0.0
            } else {
                rng.unit() as f32 * 2.0 - 1.0
            }
        })
        .collect();
    normalise(&mut v);
    v
}

/// What the fake "file" says: which look it has and how many faces.
#[derive(Clone)]
struct Planted {
    id: String,
    group: String,
    /// Which look the fake analyser gives it.
    look: String,
    t: Option<i64>,
    at: Option<(f64, f64)>,
    burst: bool,
    subtype: u32,
    /// Spread around the group's look (0 = identical).
    sigma: f32,
    faces: usize,
}

fn library() -> Vec<Planted> {
    let mut rng = Rng(42);
    let mut out = Vec::new();
    fn add(
        out: &mut Vec<Planted>,
        group: &str,
        t: Option<i64>,
        at: Option<(f64, f64)>,
        sigma: f32,
    ) -> usize {
        let id = format!("{group}-{:03}", out.len());
        // The pictures without a time look like the lake outing.
        let look = if group == "untimed" { "lake" } else { group };
        out.push(Planted {
            id,
            group: group.into(),
            look: look.into(),
            t,
            at,
            burst: false,
            subtype: 0,
            sigma,
            faces: 0,
        });
        out.len() - 1
    }
    let jitter = |rng: &mut Rng, (lat, lon): (f64, f64)| {
        (
            lat + (rng.unit() - 0.5) * 0.01,
            lon + (rng.unit() - 0.5) * 0.02,
        )
    };
    // Outing A: 40 pictures by a lake 50 km from home, day 60, 10:00-14:00.
    for k in 0..40 {
        let at = jitter(&mut rng, LAKE);
        add(
            &mut out,
            "lake",
            Some(T0 + 60 * DAY + 8 * H + k * 6 * 60_000),
            Some(at),
            0.5,
        );
    }
    // Outing B: 40 pictures in Uppsala, day 90; five without GPS, two with faces.
    for k in 0..40 {
        let at = (k % 8 != 3).then(|| jitter(&mut rng, UPPSALA));
        let i = add(
            &mut out,
            "uppsala",
            Some(T0 + 90 * DAY + 9 * H + k * 5 * 60_000),
            at,
            0.5,
        );
        if k < 2 {
            out[i].faces = 1;
        }
    }
    // Outing C: 30 pictures in Sigtuna, day 120.
    for k in 0..30 {
        let at = jitter(&mut rng, SIGTUNA);
        add(
            &mut out,
            "sigtuna",
            Some(T0 + 120 * DAY + 11 * H + k * 7 * 60_000),
            Some(at),
            0.5,
        );
    }
    // A trip to Kraków, days 150-154, 10 pictures a day; day 152 without GPS.
    for d in 0..5 {
        for k in 0..10 {
            let at = (d != 2).then(|| jitter(&mut rng, KRAKOW));
            add(
                &mut out,
                "krakow",
                Some(T0 + (150 + d) * DAY + 8 * H + k * 40 * 60_000),
                at,
                0.5,
            );
        }
    }
    // A burst at home, day 180: five frames in eight seconds.
    for k in 0..5 {
        let i = add(
            &mut out,
            "burst",
            Some(T0 + 180 * DAY + 15 * H + k * 2000),
            Some(HOME),
            0.03,
        );
        out[i].burst = true;
    }
    // Five lake-looking pictures without a time (two without GPS either).
    for k in 0..5 {
        add(&mut out, "untimed", None, (k < 3).then_some(LAKE), 0.5);
    }
    // Three documents and a screenshot at home.
    for k in 0..3 {
        add(
            &mut out,
            "document",
            Some(T0 + (200 + k) * DAY + 12 * H),
            Some(HOME),
            0.25,
        );
    }
    let i = add(
        &mut out,
        "screenshot",
        Some(T0 + 205 * DAY + 20 * H),
        Some(HOME),
        0.5,
    );
    out[i].subtype = 4;
    // Everyday life at home on other days, until 300 pictures.
    let busy: [i64; 9] = [60, 90, 120, 150, 151, 152, 153, 154, 180];
    let mut day = 0;
    while out.len() < 300 {
        day += 1;
        let d = day % 240;
        if busy.iter().any(|b| (d - b).abs() <= 1) {
            continue;
        }
        let at = jitter(&mut rng, HOME);
        let i = add(
            &mut out,
            "home",
            Some(T0 + d * DAY + (7 + (day % 12)) * H),
            Some(at),
            0.0,
        );
        // Every home picture looks different.
        out[i].look = format!("home{i}");
    }
    out
}

struct Fake {
    ids: ModelIds,
    calls: Arc<AtomicUsize>,
}

impl PictureAnalyzer for Fake {
    fn model_ids(&self) -> &ModelIds {
        &self.ids
    }

    fn analyse(&mut self, path: &Path) -> anyhow::Result<PictureAnalysis> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        let text = std::fs::read_to_string(path)?;
        let spec: Value = serde_json::from_str(&text)?;
        let group = spec["look"].as_str().unwrap();
        let sigma = spec["sigma"].as_f64().unwrap() as f32;
        let seed = spec["seed"].as_u64().unwrap();
        let mut centre = if group == "document" {
            let mut v = vec![0.0; DIM];
            v[SCREEN_AXIS] = 1.0;
            v
        } else {
            content(photo_brain::store::fnv1a64(group.as_bytes()))
        };
        let noise = content(seed);
        for (c, n) in centre.iter_mut().zip(&noise) {
            *c += sigma * n;
        }
        normalise(&mut centre);
        let faces = (0..spec["faces"].as_u64().unwrap())
            .map(|_| FaceObservation {
                x: 0.4,
                y: 0.3,
                w: 0.1,
                h: 0.1,
                score: 0.95,
                front: 0.9,
                quality: 80.0,
                embedding: {
                    let mut e = content(7)[..self.ids.face_dim].to_vec();
                    e[0] = 1.0;
                    normalise(&mut e);
                    e
                },
            })
            .collect();
        Ok(PictureAnalysis {
            embedding: centre,
            faces,
            quality: PictureQuality {
                sharp: 70.0,
                dark: 10.0,
            },
        })
    }

    fn decodes_heic(&self) -> bool {
        true
    }
}

#[derive(Default)]
struct Lugn {
    generation: u64,
    album_calls: usize,
    puts: Vec<Vec<u8>>,
    people_calls: usize,
    people_down: bool,
    intel_at: Option<i64>,
    /// Ids left out of the listing.
    hidden: Vec<String>,
}

fn scenes_file() -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    let scenes: Vec<Value> = SCENE_KEYS
        .iter()
        .enumerate()
        .map(|(k, (key, sv))| {
            let mut v = vec![0u8; DIM];
            v[k] = 100;
            json!({"key": key, "sv": sv, "vector": b64.encode(v)})
        })
        .collect();
    json!({"model": "Xenova/clip-vit-base-patch32", "dim": DIM, "scale": 508, "scenes": scenes})
        .to_string()
}

fn listing(pictures: &[Planted], base: &str, state: &Lugn) -> String {
    let photos: Vec<Value> = pictures
        .iter()
        .filter(|p| !state.hidden.contains(&p.id))
        .map(|p| {
            let url = |kind: &str| format!("{base}/img/{}/{kind}?g={}", p.id, state.generation);
            // Half the pictures have a HEIC original, the rest only the JPEG.
            let mut renditions = vec![json!({"kind": "jpeg", "url": url("jpeg"), "width": 1536, "height": 2048})];
            if p.id.len() % 2 == 0 {
                renditions.push(json!({"kind": "original", "url": url("original"), "width": 4032, "height": 3024, "type": "public.heic"}));
            }
            json!({
                "id": p.id,
                "version": "v1",
                "takenAt": p.t,
                "utcOffsetSeconds": if p.group == "krakow" || p.id.ends_with('7') { Value::Null } else { json!(7200) },
                "latitude": p.at.map(|a| a.0),
                "longitude": p.at.map(|a| a.1),
                "width": 1536,
                "height": 2048,
                "details": {"subtype": p.subtype, "burst": p.burst, "batch": if p.group == "untimed" { "import-1" } else { "import-0" },
                            "favorite": p.id.ends_with("00"), "caption": null, "keywords": []},
                "renditions": renditions,
            })
        })
        .collect();
    json!({"schema": 1, "title": "Test", "listedAt": 1, "photos": photos}).to_string()
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .unwrap();
    out
}

#[test]
fn the_whole_pipeline() {
    let pictures = Arc::new(library());
    assert_eq!(pictures.len(), 300);
    let state = Arc::new(Mutex::new(Lugn::default()));
    let base = Arc::new(Mutex::new(String::new()));
    let (p, s, b) = (pictures.clone(), state.clone(), base.clone());
    let server = MockServer::start(move |request| {
        let mut st = s.lock().unwrap();
        let authorised = request.header("authorization") == Some("Bearer secret-token");
        let path = request.path.split('?').next().unwrap_or_default();
        match (request.method.as_str(), path) {
            (_, p2) if p2.starts_with("/photo-brain/") && !authorised => Response::status(401),
            ("GET", "/photo-brain/v1/album") => {
                st.generation += 1;
                st.album_calls += 1;
                Response::json(&listing(&p, &b.lock().unwrap(), &st))
            }
            ("GET", "/photo-brain/v1/state") => Response::json(
                &json!({"revision": "r", "intelAt": st.intel_at, "pictures": 300, "analysed": 0})
                    .to_string(),
            ),
            ("GET", "/photo-brain/v1/people") => {
                st.people_calls += 1;
                if st.people_down {
                    return Response::status(503);
                }
                Response::json(
                    r#"{"schema":1,"people":[{"id":"p3","name":"Anna","confirmed":true,"hidden":false}],
                        "decided":{"uppsala-040.0":"p3"},"previous":{},"not":{}}"#,
                )
            }
            ("PUT", "/photo-brain/v1/intel") => {
                assert_eq!(request.header("content-encoding"), Some("gzip"));
                st.puts.push(request.body.clone());
                st.intel_at = Some(1);
                Response::json(r#"{"accepted":1,"unknown":[]}"#)
            }
            ("GET", img) if img.starts_with("/img/") => {
                let mut parts = img.trim_start_matches("/img/").split('/');
                let id = parts.next().unwrap();
                // This picture's first link has expired: only a re-listed one works.
                let generation: u64 = request.path.rsplit("g=").next().unwrap().parse().unwrap();
                if id == "lake-007" && generation == 1 {
                    return Response::status(410);
                }
                let Some(pic) = p.iter().find(|x| x.id == id) else {
                    return Response::status(404);
                };
                let seed = photo_brain::store::fnv1a64(id.as_bytes());
                let body = json!({"look": pic.look, "sigma": pic.sigma, "seed": seed, "faces": pic.faces, "kind": parts.next()});
                Response::bytes(body.to_string().into_bytes())
            }
            _ => Response::status(404),
        }
    });
    *base.lock().unwrap() = server.url();

    let dir = tempfile::tempdir().unwrap();
    let store_dir = dir.path().join("photos");
    std::fs::create_dir(&store_dir).unwrap();
    let scenes = dir.path().join("photo-scenes.json");
    std::fs::write(&scenes, scenes_file()).unwrap();
    std::fs::write(
        dir.path().join("places.tsv"),
        "Stockholm\t59.333\t18.065\tSE\nUppsala\t59.859\t17.639\tSE\nSigtuna\t59.617\t17.724\tSE\nNorrtälje\t59.758\t18.705\tSE\nKraków\t50.061\t19.937\tPL\n",
    )
    .unwrap();
    let config = Config::parse(&format!(
        r#"
        lugn_url = "{}"
        store_dir = "{}"
        db_dir = "{}"
        scenes_file = "{}"
        models_dir = "{}"
        threads = 4
        min_free_gb = 0
        pause_ms = 0
        "#,
        server.url(),
        store_dir.display(),
        dir.path().join("db").display(),
        scenes.display(),
        dir.path().join("models").display(),
    ))
    .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    let factory = Box::new(move || -> anyhow::Result<Box<dyn PictureAnalyzer>> {
        Ok(Box::new(Fake {
            ids: ModelIds {
                embed: "clip-vit-base-patch32".into(),
                detector: "fake-detector".into(),
                face: "fake-face".into(),
                face_dim: 8,
                embed_dim: DIM,
            },
            calls: c.clone(),
        }))
    });
    let rules = DownloadRules {
        https_only: false,
        host_suffixes: vec!["127.0.0.1".into()],
    };
    let stop = Arc::new(AtomicBool::new(false));
    let mut brain = Brain::new(
        config,
        Token::new("secret-token".into()).unwrap(),
        rules,
        factory,
        stop,
    )
    .unwrap();

    // ── First pass: everything ──
    let report = brain.cycle(None).unwrap();
    assert_eq!(report.listed, 300);
    assert_eq!(report.downloaded, 300, "{report:?}");
    assert_eq!(report.analysed, 300);
    assert!(report.trouble.is_none());
    assert!(
        matches!(report.published, Published::Sent { photos: 300, .. }),
        "{:?}",
        report.published
    );
    // The expired link made it list again.
    assert!(state.lock().unwrap().album_calls >= 2);
    // Originals are kept with the right extension.
    let heic = std::fs::read_dir(&store_dir)
        .unwrap()
        .flat_map(|d| std::fs::read_dir(d.unwrap().path()).unwrap())
        .filter(|f| {
            f.as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|e| e == "heic")
        })
        .count();
    assert!(heic > 0 && heic < 300, "{heic}");
    assert!(dir.path().join("db/people.json").exists());

    let body = gunzip(&state.lock().unwrap().puts[0]);
    let bundle: Bundle = serde_json::from_slice(&body).expect("the bundle deserialises");
    assert_eq!(bundle.schema, 1);
    assert_eq!(bundle.photos.len(), 300);
    assert_eq!(bundle.brain.face_dim, 8);
    let by_group =
        |g: &str| -> Vec<&Planted> { pictures.iter().filter(|p| p.group == g).collect() };

    // Home.
    let home = bundle.home.expect("a home");
    assert!(
        (home.lat - HOME.0).abs() < 0.02 && (home.lon - HOME.1).abs() < 0.03,
        "{home:?}"
    );

    // One trip, Kraków, all five days, including the day without GPS.
    assert_eq!(bundle.trips.len(), 1, "{:?}", bundle.trips);
    let trip = &bundle.trips[0];
    assert_eq!(
        (trip.title.as_str(), trip.cc.as_deref()),
        ("Kraków", Some("PL"))
    );
    assert_eq!(
        (trip.from.as_str(), trip.to.as_str()),
        ("2026-08-29", "2026-09-02")
    );
    for p in by_group("krakow") {
        assert_eq!(bundle.photos[&p.id].trip, Some(0), "{}", p.id);
    }
    assert!(
        by_group("lake")
            .iter()
            .all(|p| bundle.photos[&p.id].trip.is_none())
    );

    // Three outings, each one event with all its pictures.
    for (group, count) in [("lake", 40), ("uppsala", 40), ("sigtuna", 30)] {
        let events: Vec<_> = by_group(group)
            .iter()
            .map(|p| bundle.photos[&p.id].event.clone())
            .collect();
        let first = events[0].clone().expect("in an event");
        assert!(
            events.iter().all(|e| e.as_ref() == Some(&first)),
            "{group}: {events:?}"
        );
        let event = bundle.events.iter().find(|e| e.id == first).unwrap();
        assert_eq!(event.count, count, "{group}");
    }
    assert!(
        by_group("untimed")
            .iter()
            .all(|p| bundle.photos[&p.id].event.is_none())
    );

    // Candidates: an outing's own pictures come first.
    for (group, mates) in [("lake", 39), ("uppsala", 39), ("sigtuna", 29)] {
        for p in by_group(group) {
            let cand = &bundle.photos[&p.id].cand;
            assert!(cand.len() >= mates, "{} has {}", p.id, cand.len());
            let first: Vec<&str> = cand[..mates].iter().map(|c| c.0.as_str()).collect();
            assert!(
                first.iter().all(|id| id.starts_with(group)),
                "{}: {:?}",
                p.id,
                &cand[..mates]
            );
            assert!(cand.len() <= 48);
            assert!(cand.iter().all(|c| c.1 >= 30));
            assert!(cand.windows(2).all(|w| w[0].1 >= w[1].1));
        }
    }
    // Without a time a pair is capped at 55; the time component is unknown.
    for p in by_group("untimed") {
        let cand = &bundle.photos[&p.id].cand;
        assert!(!cand.is_empty());
        assert!(
            cand.iter().all(|c| c.1 <= 55 && c.2 == -1),
            "{}: {cand:?}",
            p.id
        );
    }
    // Every home picture looks different: being at home alone makes no group.
    let home_pairs = by_group("home")
        .iter()
        .flat_map(|p| {
            bundle
                .photos
                .get(&p.id)
                .into_iter()
                .flat_map(|i| i.cand.iter())
        })
        .filter(|c| c.0.starts_with("home") && c.1 >= 50)
        .count();
    assert_eq!(home_pairs, 0);

    // The burst: near-duplicates of each other, never candidates.
    let burst: Vec<String> = by_group("burst").iter().map(|p| p.id.clone()).collect();
    for id in &burst {
        let intel = &bundle.photos[id];
        let mut du = intel.du.clone();
        du.sort();
        let mut others: Vec<String> = burst.iter().filter(|b| *b != id).cloned().collect();
        others.sort();
        assert_eq!(du, others, "{id}");
        assert!(intel.cand.iter().all(|c| !burst.contains(&c.0)));
    }

    // Junk and scenes.
    for p in by_group("document") {
        let intel = &bundle.photos[&p.id];
        assert_eq!(
            intel.q.junk.as_deref(),
            Some("document"),
            "{:?}",
            intel.scene
        );
        assert_eq!(intel.scene[0].0, "screen");
    }
    let screenshot = &bundle.photos[&by_group("screenshot")[0].id];
    assert_eq!(screenshot.q.junk.as_deref(), Some("screenshot"));
    assert!(
        by_group("lake")
            .iter()
            .all(|p| bundle.photos[&p.id].q.junk.is_none())
    );
    assert_eq!(bundle.photos["lake-000"].q.sharp, 70);
    assert_eq!(bundle.photos["lake-000"].fav, Some(1));
    // Faces are published without their embeddings.
    assert_eq!(bundle.photos["uppsala-040"].faces.len(), 1);
    assert!(!String::from_utf8_lossy(&body).contains("\"e\":"));

    // ── Second pass: nothing changed, nothing sent, nothing re-analysed ──
    let before = calls.load(Ordering::Relaxed);
    let report = brain.cycle(None).unwrap();
    assert_eq!((report.downloaded, report.analysed), (0, 0));
    assert_eq!(report.published, Published::Unchanged);
    assert_eq!(calls.load(Ordering::Relaxed), before);
    assert_eq!(state.lock().unwrap().puts.len(), 1);

    // ── Third pass: a picture left the album and the people endpoint is down ──
    {
        let mut st = state.lock().unwrap();
        st.hidden.push("lake-005".into());
        st.people_down = true;
    }
    let report = brain.cycle(None).unwrap();
    assert!(
        matches!(report.published, Published::Sent { photos: 299, .. }),
        "{:?}",
        report.published
    );
    let st = state.lock().unwrap();
    let bundle: Bundle = serde_json::from_slice(&gunzip(st.puts.last().unwrap())).unwrap();
    assert!(!bundle.photos.contains_key("lake-005"));
    assert!(
        bundle
            .photos
            .values()
            .all(|i| i.cand.iter().all(|c| c.0 != "lake-005"))
    );
    assert!(st.people_calls >= 3);

    // Export writes the same picture set without the network.
    drop(st);
    let out = dir.path().join("bundle.json");
    assert_eq!(brain.export(&out).unwrap(), 299);
    let exported: Bundle = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
    let keys = |b: &Bundle| b.photos.keys().cloned().collect::<Vec<_>>();
    assert_eq!(keys(&exported), keys(&bundle));
}
