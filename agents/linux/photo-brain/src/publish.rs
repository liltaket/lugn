//! Builds the intel bundle for the whole library and hands it to Lugn.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};

use crate::analysis::ModelIds;
use crate::bundle::{self, BrainInfo, BrainModels, Bundle, Face, Home, PhotoIntel, Quality};
use crate::client::SUBTYPE_SCREENSHOT;
use crate::cluster::scenes::{DOCUMENT_KEYS, Kind, Vocabulary};
use crate::cluster::{self, LatLon, Picture, pairs::PairStats};
use crate::config::SceneConfig;
use crate::people::{Assigned, FaceId, FaceRec};
use crate::places::{Places, country_name};
use crate::store::{Entry, fnv1a64};

pub struct BuildInput<'a> {
    /// The listed pictures (only these are published), with analyses by `models`.
    pub entries: &'a [Entry],
    pub models: &'a ModelIds,
    /// Only when it belongs to `models` (see `Vocabulary::matches_model`).
    pub vocabulary: Option<&'a Vocabulary>,
    pub scenes: SceneConfig,
    pub places: Option<&'a Places>,
    pub options: cluster::Options,
    pub proposals: &'a HashMap<FaceId, Assigned>,
    pub now: i64,
}

fn percent(value: f32) -> u8 {
    if value.is_finite() {
        value.round().clamp(0.0, 100.0) as u8
    } else {
        0
    }
}

/// 0-100, or -1 when unknown.
fn component(value: Option<f32>) -> i32 {
    value.map_or(-1, |v| (v * 100.0).round().clamp(0.0, 100.0) as i32)
}

/// Rounded so the bundle does not change from float noise.
fn round3(value: f32) -> f32 {
    (value * 1000.0).round() / 1000.0
}

/// Shorter side of a face box in pixels of the analysed picture (0 when the
/// picture's size is unknown).
pub fn face_px(face_w: f32, face_h: f32, width: Option<u32>, height: Option<u32>) -> f32 {
    match (width, height) {
        (Some(w), Some(h)) => (face_w * w as f32).min(face_h * h as f32).max(0.0),
        _ => 0.0,
    }
}

/// Every analysed face, named `<pictureId>.<index>`.
pub fn face_records(entries: &[Entry]) -> Vec<FaceRec> {
    let mut faces = Vec::new();
    for entry in entries {
        let Some(stored) = &entry.analysis else {
            continue;
        };
        let width = stored.width.or(entry.meta.width);
        let height = stored.height.or(entry.meta.height);
        for (k, face) in stored.analysis.faces.iter().enumerate() {
            faces.push(FaceRec {
                id: format!("{}.{k}", entry.id),
                photo_id: entry.id.clone(),
                embedding: face.embedding.clone(),
                score: face.score,
                front: face.front,
                quality: face.quality,
                px: face_px(face.w, face.h, width, height),
            });
        }
    }
    faces
}

/// `q.junk`.
pub fn junk(
    subtype: Option<u32>,
    scene: &[(String, f32)],
    faces: usize,
    document_p: f32,
) -> Option<String> {
    if subtype.is_some_and(|s| s & SUBTYPE_SCREENSHOT != 0) {
        return Some("screenshot".into());
    }
    let document = scene
        .iter()
        .any(|(key, p)| DOCUMENT_KEYS.contains(&key.as_str()) && *p >= document_p);
    (faces == 0 && document).then(|| "document".into())
}

pub fn build(input: &BuildInput<'_>) -> (Bundle, PairStats) {
    let entries = input.entries;
    let places: Vec<Option<(String, Option<String>)>> = entries
        .iter()
        .map(|e| {
            let at = LatLon {
                lat: e.meta.lat?,
                lon: e.meta.lon?,
            };
            let (name, cc) = input.places?.nearest(at)?;
            Some((name.to_string(), cc.map(str::to_string)))
        })
        .collect();
    let pictures: Vec<Picture<'_>> = entries
        .iter()
        .zip(&places)
        .map(|(e, place)| Picture {
            id: &e.id,
            taken_at: e.meta.taken_at,
            utc_offset: e.meta.utc_offset,
            location: e
                .meta
                .lat
                .zip(e.meta.lon)
                .map(|(lat, lon)| LatLon { lat, lon }),
            place: place.as_ref().map(|p| p.0.as_str()),
            cc: place.as_ref().and_then(|p| p.1.as_deref()),
            embedding: e.analysis.as_ref().map(|a| a.analysis.embedding.as_slice()),
            burst: e.meta.details.burst.unwrap_or(false),
            batch: e.meta.details.batch.as_deref(),
        })
        .collect();
    let clustering = cluster::cluster(&pictures, &input.options, &country_name);
    let (min_cosine, document_p) = match input.vocabulary.map(|v| v.kind) {
        Some(Kind::Sigmoid) => (
            input.scenes.sigmoid_min_cosine,
            input.scenes.sigmoid_document_p,
        ),
        _ => (
            input.scenes.softmax_min_cosine,
            input.scenes.softmax_document_p,
        ),
    };

    let mut photos = BTreeMap::new();
    for (i, entry) in entries.iter().enumerate() {
        let Some(stored) = &entry.analysis else {
            continue;
        };
        let analysis = &stored.analysis;
        let scene: Vec<(String, f32)> = input
            .vocabulary
            .map(|v| v.classify(&analysis.embedding, min_cosine))
            .unwrap_or_default()
            .into_iter()
            .map(|(k, p)| (k, round3(p)))
            .collect();
        let faces = analysis
            .faces
            .iter()
            .enumerate()
            .map(|(k, f)| Face {
                x: round3(f.x),
                y: round3(f.y),
                w: round3(f.w),
                h: round3(f.h),
                score: round3(f.score),
                front: round3(f.front),
                q: percent(f.quality),
                p: input
                    .proposals
                    .get(&format!("{}.{k}", entry.id))
                    .map(|a| match a {
                        Assigned::Person(p) => p.clone(),
                        Assigned::Cluster(n) => format!("n{n}"),
                    }),
            })
            .collect::<Vec<_>>();
        let caption = entry
            .meta
            .details
            .caption
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty());
        photos.insert(
            entry.id.clone(),
            PhotoIntel {
                v: entry.version.clone(),
                q: Quality {
                    sharp: percent(analysis.quality.sharp),
                    dark: percent(analysis.quality.dark),
                    junk: junk(entry.meta.details.subtype, &scene, faces.len(), document_p),
                },
                scene,
                fav: entry.meta.details.favorite.unwrap_or(false).then_some(1),
                cap: caption.map(|c| c.chars().take(500).collect()),
                faces,
                trip: clustering.trip_of[i],
                event: clustering.event_of[i].map(|e| clustering.events[e as usize].id.clone()),
                cand: clustering.cand[i]
                    .iter()
                    .map(|c| {
                        (
                            entries[c.other as usize].id.clone(),
                            component(Some(c.score)),
                            component(c.time),
                            component(c.place),
                            component(c.look),
                        )
                    })
                    .collect(),
                du: clustering.du[i]
                    .iter()
                    .map(|&j| entries[j as usize].id.clone())
                    .collect(),
            },
        );
    }
    let bundle = Bundle {
        schema: bundle::SCHEMA,
        generated_at: input.now,
        brain: BrainInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            models: BrainModels {
                embed: input.models.embed.clone(),
                face: input.models.face.clone(),
                detector: input.models.detector.clone(),
            },
            face_dim: input.models.face_dim,
        },
        home: clustering.home.map(|h| Home {
            lat: h.lat,
            lon: h.lon,
        }),
        trips: clustering.trips,
        events: clustering.events,
        photos,
    };
    (bundle, clustering.stats)
}

/// What the bundle says, ignoring when it was made.
pub fn content_key(bundle: &Bundle) -> u64 {
    let mut copy = bundle.clone();
    copy.generated_at = 0;
    fnv1a64(&serde_json::to_vec(&copy).expect("bundle serialises"))
}

pub fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
    encoder.write_all(bytes).expect("writing to memory");
    encoder.finish().expect("writing to memory")
}

/// Writes `bytes` to `path` through a temporary file (mode 0600).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .with_context(|| format!("write {}", tmp.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn junk_rules() {
        let doc = vec![("document".to_string(), 0.7), ("screen".to_string(), 0.1)];
        assert_eq!(
            junk(Some(4 | 8), &[], 2, 0.6).as_deref(),
            Some("screenshot")
        );
        assert_eq!(junk(Some(8), &doc, 0, 0.6).as_deref(), Some("document"));
        assert_eq!(junk(None, &doc, 1, 0.6), None);
        assert_eq!(junk(None, &doc, 0, 0.8), None);
        let receipt = vec![("beach".to_string(), 0.9), ("receipt".to_string(), 0.55)];
        assert_eq!(junk(None, &receipt, 0, 0.5).as_deref(), Some("document"));
    }

    #[test]
    fn components_and_px() {
        assert_eq!(component(None), -1);
        assert_eq!(component(Some(0.744)), 74);
        assert_eq!(face_px(0.1, 0.05, Some(3024), Some(4032)), 0.05 * 4032.0);
        assert_eq!(face_px(0.1, 0.05, None, Some(4032)), 0.0);
    }

    #[test]
    fn faces_carry_the_proposals_and_never_their_embeddings() {
        use crate::analysis::{FaceObservation, PictureAnalysis, PictureQuality};
        use crate::store::{PictureMeta, StoredAnalysis};
        let face = |x: f32| FaceObservation {
            x,
            y: 0.2,
            w: 0.1,
            h: 0.1,
            score: 0.9,
            front: 0.8,
            quality: 64.6,
            embedding: vec![0.6, 0.8],
        };
        let models = ModelIds {
            embed: "m".into(),
            detector: "d".into(),
            face: "f".into(),
            face_dim: 2,
            embed_dim: 3,
        };
        let entry = |id: &str, faces: Vec<FaceObservation>| Entry {
            id: id.into(),
            version: "v1".into(),
            meta: PictureMeta {
                taken_at: Some(1_700_000_000_000),
                ..Default::default()
            },
            analysis: Some(StoredAnalysis {
                version: "v1".into(),
                models: models.clone(),
                analysis: PictureAnalysis {
                    embedding: vec![1.0, 0.0, 0.0],
                    faces,
                    quality: PictureQuality {
                        sharp: 50.0,
                        dark: 5.0,
                    },
                },
                width: Some(1000),
                height: Some(2000),
                analysed_at: 1,
            }),
        };
        let entries = vec![
            entry("a", vec![face(0.1), face(0.5), face(0.7)]),
            entry("b", vec![]),
        ];
        let records = face_records(&entries);
        assert_eq!(
            records.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["a.0", "a.1", "a.2"]
        );
        assert_eq!(records[0].px, 100.0);
        let proposals: HashMap<FaceId, Assigned> = [
            ("a.0".to_string(), Assigned::Person("p3".into())),
            ("a.2".to_string(), Assigned::Cluster(7)),
        ]
        .into();
        let input = BuildInput {
            entries: &entries,
            models: &models,
            vocabulary: None,
            scenes: SceneConfig::default(),
            places: None,
            options: cluster::Options::default(),
            proposals: &proposals,
            now: 5,
        };
        let (bundle, _) = build(&input);
        let faces = &bundle.photos["a"].faces;
        let p: Vec<Option<&str>> = faces.iter().map(|f| f.p.as_deref()).collect();
        assert_eq!(p, vec![Some("p3"), None, Some("n7")]);
        assert_eq!(faces[0].q, 65);
        assert_eq!(bundle.brain.face_dim, 2);
        // Same moment, same look: a near-duplicate, not a candidate.
        assert_eq!(bundle.photos["a"].du, vec!["b".to_string()]);
        assert!(bundle.photos["a"].cand.is_empty());
        let json = serde_json::to_string(&bundle).unwrap();
        assert!(!json.contains("0.6") && !json.contains("\"e\""), "{json}");
        // generatedAt does not change the content key.
        let mut later = bundle.clone();
        later.generated_at = 99;
        assert_eq!(content_key(&bundle), content_key(&later));
    }

    #[test]
    fn gzip_round_trips() {
        use std::io::Read;
        let data = br#"{"schema":1}"#;
        let mut out = String::new();
        flate2::read::GzDecoder::new(&gzip(data)[..])
            .read_to_string(&mut out)
            .unwrap();
        assert_eq!(out.as_bytes(), data);
    }
}
