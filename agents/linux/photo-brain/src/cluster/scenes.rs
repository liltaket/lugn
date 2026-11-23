//! Scene classification against the text vectors in `data/photo-scenes.json`.
//!
//! Two kinds of vocabulary:
//! - `softmax` (CLIP-like, and every file without `kind`): logits are
//!   `scale × cosine` and one softmax runs over the whole vocabulary. A file
//!   without `kind` is the original CLIP file, whose `scale` is the int8
//!   quantisation of the vectors; its logit scale is CLIP's 100.
//! - `sigmoid` (SigLIP-like): trained with a per-label sigmoid, but reported as
//!   a softmax over the logits (the raw sigmoid is tiny even when right).
//!
//! Either way a label whose raw cosine is below the kind's floor is not
//! reported, and the best three are returned. Labels with `sv: null` are sink
//! categories: they compete and are reported, but have no display name.

use anyhow::{Context, Result, bail};
use base64::Engine;

use super::score::dot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Softmax,
    Sigmoid,
}

#[derive(Debug, Clone)]
pub struct Vocabulary {
    /// The embedding model the text vectors belong to.
    pub model: String,
    pub kind: Kind,
    pub dim: usize,
    pub logit_scale: f32,
    pub bias: f32,
    /// The `ModelIds::embed` values the file says it fits; empty for old files.
    pub embed_ids: Vec<String>,
    pub keys: Vec<String>,
    /// Swedish display name; `None` for a sink category.
    pub names: Vec<Option<String>>,
    /// `keys.len() × dim`, each row unit length.
    vectors: Vec<f32>,
}

/// The keys that make a picture junk (`q.junk = "document"`).
pub const DOCUMENT_KEYS: [&str; 3] = ["screen", "document", "receipt"];

#[derive(serde::Deserialize)]
struct File {
    #[serde(default)]
    model: String,
    #[serde(default)]
    kind: Option<String>,
    dim: usize,
    #[serde(default)]
    scale: Option<f32>,
    #[serde(default)]
    bias: Option<f32>,
    /// `f16` (little-endian halves), `int8` (any scale) or absent (int8, or f32).
    #[serde(default)]
    encoding: Option<String>,
    /// The `ModelIds::embed` values this file fits (schema 2).
    #[serde(default, rename = "embedIds")]
    embed_ids: Vec<String>,
    scenes: Vec<Scene>,
}

#[derive(serde::Deserialize)]
struct Scene {
    key: String,
    #[serde(default)]
    sv: Option<String>,
    vector: String,
}

/// IEEE 754 half precision to single.
fn f16_to_f32(bits: u16) -> f32 {
    let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = i32::from((bits >> 10) & 0x1f);
    let frac = f32::from(bits & 0x03ff);
    match exp {
        0 => sign * frac * 2f32.powi(-24),
        31 => {
            if frac == 0.0 {
                sign * f32::INFINITY
            } else {
                f32::NAN
            }
        }
        _ => sign * (1.0 + frac / 1024.0) * 2f32.powi(exp - 15),
    }
}

/// CLIP's logit scale.
const CLIP_LOGIT_SCALE: f32 = 100.0;

impl Vocabulary {
    pub fn parse(json: &str) -> Result<Self> {
        let file: File = serde_json::from_str(json).context("parse scene vocabulary")?;
        let (kind, logit_scale, bias) = match file.kind.as_deref() {
            None => (Kind::Softmax, CLIP_LOGIT_SCALE, 0.0),
            Some("softmax") => (Kind::Softmax, file.scale.unwrap_or(CLIP_LOGIT_SCALE), 0.0),
            Some("sigmoid") => (
                Kind::Sigmoid,
                file.scale.context("a sigmoid vocabulary needs scale")?,
                file.bias.context("a sigmoid vocabulary needs bias")?,
            ),
            Some(other) => bail!("unknown scene vocabulary kind {other:?}"),
        };
        if file.dim == 0 {
            bail!("scene vocabulary has dim 0");
        }
        let mut vocabulary = Self {
            model: file.model,
            kind,
            dim: file.dim,
            logit_scale,
            bias,
            embed_ids: file.embed_ids,
            keys: Vec::new(),
            names: Vec::new(),
            vectors: Vec::new(),
        };
        let b64 = base64::engine::general_purpose::STANDARD;
        for scene in file.scenes {
            let Ok(bytes) = b64.decode(scene.vector.as_bytes()) else {
                continue;
            };
            // f16 LE (schema 2), int8 (any quantisation scale: the vector is
            // normalised) or f32 LE.
            let mut v: Vec<f32> = if file.encoding.as_deref() == Some("f16")
                && bytes.len() == 2 * file.dim
            {
                bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| f16_to_f32(u16::from_le_bytes(*c)))
                    .collect()
            } else if bytes.len() == file.dim {
                bytes.iter().map(|&b| f32::from(b as i8)).collect()
            } else if bytes.len() == 4 * file.dim {
                bytes
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|c| f32::from_le_bytes(*c))
                    .collect()
            } else {
                continue;
            };
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            if !(norm > 0.0 && norm.is_finite()) {
                continue;
            }
            v.iter_mut().for_each(|x| *x /= norm);
            vocabulary.keys.push(scene.key);
            vocabulary.names.push(scene.sv);
            vocabulary.vectors.extend(v);
        }
        if vocabulary.keys.is_empty() {
            bail!("scene vocabulary has no usable vectors");
        }
        Ok(vocabulary)
    }

    /// Whether the text vectors belong to the embedding model `embed`. A file
    /// that lists the ids it fits (`embedIds`) must list this one; an older
    /// file matches when the last path segment of one name is contained in the
    /// other, ignoring case.
    pub fn matches_model(&self, embed: &str, embed_dim: usize) -> bool {
        if !self.embed_ids.is_empty() {
            return embed_dim == self.dim
                && self
                    .embed_ids
                    .iter()
                    .any(|id| id.eq_ignore_ascii_case(embed));
        }
        let tail = |s: &str| s.rsplit('/').next().unwrap_or(s).to_ascii_lowercase();
        let (a, b) = (tail(&self.model), tail(embed));
        embed_dim == self.dim
            && !a.is_empty()
            && !b.is_empty()
            && (a.contains(&b) || b.contains(&a))
    }

    /// The best three labels above the cosine floor, with probabilities.
    pub fn classify(&self, embedding: &[f32], min_cosine: f32) -> Vec<(String, f32)> {
        if embedding.len() != self.dim {
            return Vec::new();
        }
        let cosines: Vec<f32> = self
            .vectors
            .chunks_exact(self.dim)
            .map(|v| dot(v, embedding))
            .collect();
        let p: Vec<f32> = match self.kind {
            Kind::Softmax => {
                let logits: Vec<f32> = cosines.iter().map(|c| self.logit_scale * c).collect();
                let top = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                let odds: Vec<f32> = logits.iter().map(|l| (l - top).exp()).collect();
                let total: f32 = odds.iter().sum();
                odds.iter().map(|o| o / total).collect()
            }
            // SigLIP's own per-label sigmoid is small even when right (a clear
            // beach is about 0.01), so it is useless as a confidence. What is
            // reported is "which of these": a softmax over the logits (the
            // bias cancels). Whether it is any of them at all is the cosine
            // floor's job.
            Kind::Sigmoid => {
                let logits: Vec<f32> = cosines.iter().map(|c| self.logit_scale * c).collect();
                let top = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                let odds: Vec<f32> = logits.iter().map(|l| (l - top).exp()).collect();
                let total: f32 = odds.iter().sum();
                odds.iter().map(|o| o / total).collect()
            }
        };
        let mut ranked: Vec<usize> = (0..self.keys.len())
            .filter(|&i| cosines[i] >= min_cosine)
            .collect();
        ranked.sort_by(|&a, &b| p[b].total_cmp(&p[a]).then(a.cmp(&b)));
        ranked
            .into_iter()
            .take(3)
            .map(|i| (self.keys[i].clone(), p[i]))
            .collect()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A vocabulary file whose label `k` points along axis `k`.
    pub(crate) fn axis_file(keys: &[(&str, Option<&str>)], dim: usize, extra: &str) -> String {
        let b64 = base64::engine::general_purpose::STANDARD;
        let scenes: Vec<String> = keys
            .iter()
            .enumerate()
            .map(|(k, (key, sv))| {
                let mut v = vec![0i8; dim];
                v[k] = 100;
                let bytes: Vec<u8> = v.iter().map(|&x| x as u8).collect();
                let sv = sv.map_or("null".to_string(), |s| format!("\"{s}\""));
                format!(
                    r#"{{"key":"{key}","sv":{sv},"vector":"{}"}}"#,
                    b64.encode(bytes)
                )
            })
            .collect();
        format!(
            r#"{{"model":"Xenova/clip-vit-base-patch32","dim":{dim},"scale":508{extra},"scenes":[{}]}}"#,
            scenes.join(",")
        )
    }

    fn towards(dim: usize, weights: &[(usize, f32)]) -> Vec<f32> {
        let mut v = vec![0.0; dim];
        for &(k, w) in weights {
            v[k] = w;
        }
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter().map(|x| x / norm).collect()
    }

    #[test]
    fn the_legacy_file_is_softmax_with_clip_scale() {
        let file = axis_file(
            &[
                ("beach", Some("Stranden")),
                ("sea", Some("Havet")),
                ("object", None),
            ],
            8,
            "",
        );
        let v = Vocabulary::parse(&file).unwrap();
        assert_eq!(v.kind, Kind::Softmax);
        assert_eq!(v.logit_scale, 100.0);
        assert_eq!(v.names[2], None);
        let scene = v.classify(
            &towards(8, &[(0, 0.30), (1, 0.25), (2, 0.1), (5, 0.9)]),
            0.22,
        );
        // object's cosine is below the floor: not reported.
        assert_eq!(
            scene.iter().map(|s| s.0.as_str()).collect::<Vec<_>>(),
            vec!["beach", "sea"]
        );
        assert!(scene[0].1 > scene[1].1);
        assert!(v.matches_model("clip-vit-base-patch32", 8));
        assert!(!v.matches_model("siglip2-base-patch16-224", 8));
        assert!(!v.matches_model("clip-vit-base-patch32", 512));
    }

    #[test]
    fn nothing_above_the_floor_is_no_scene() {
        let file = axis_file(
            &[("beach", Some("Stranden")), ("sea", Some("Havet"))],
            8,
            "",
        );
        let v = Vocabulary::parse(&file).unwrap();
        assert!(
            v.classify(&towards(8, &[(0, 0.1), (5, 0.99)]), 0.22)
                .is_empty()
        );
    }

    #[test]
    fn a_sigmoid_file_reports_which_of_these_and_keeps_sinks() {
        let file = axis_file(
            &[
                ("beach", Some("Stranden")),
                ("sea", Some("Havet")),
                ("other", None),
                ("dog", Some("Hund")),
            ],
            8,
            r#","kind":"sigmoid","bias":-10.0"#,
        );
        // `scale` (508 here) is the logit scale for a file with `kind`.
        let mut v = Vocabulary::parse(&file).unwrap();
        assert_eq!(v.kind, Kind::Sigmoid);
        v.logit_scale = 100.0;
        let e = towards(8, &[(0, 0.15), (1, 0.12), (2, 0.14), (3, 0.01), (6, 0.97)]);
        let scene = v.classify(&e, 0.05);
        assert_eq!(
            scene.iter().map(|s| s.0.as_str()).collect::<Vec<_>>(),
            vec!["beach", "other", "sea"]
        );
        // A softmax over all labels: a share of one, not tiny sigmoid values.
        let sum: f32 = scene.iter().map(|s| s.1).sum();
        assert!(sum > 0.9 && sum <= 1.0 + 1e-5, "softmax shares: {sum}");
        assert!(scene[0].1 > scene[1].1 && scene[1].1 > scene[2].1);
    }

    #[test]
    fn half_floats_decode_and_embed_ids_decide_the_match() {
        // 1.0 = 0x3C00, 0.5 = 0x3800, 0 = 0, -2.0 = 0xC000, smallest subnormal.
        assert_eq!(f16_to_f32(0x3c00), 1.0);
        assert_eq!(f16_to_f32(0x3800), 0.5);
        assert_eq!(f16_to_f32(0x0000), 0.0);
        assert_eq!(f16_to_f32(0xc000), -2.0);
        assert_eq!(f16_to_f32(0x0001), 2f32.powi(-24));
        assert_eq!(f16_to_f32(0x7c00), f32::INFINITY);
        assert!(f16_to_f32(0x7e00).is_nan());

        let b64 = base64::engine::general_purpose::STANDARD;
        let half = |x: u16| x.to_le_bytes();
        // Two labels along axes 0 and 1 of a 2-dim space, as f16.
        let beach: Vec<u8> = [half(0x3c00), half(0)].concat();
        let sea: Vec<u8> = [half(0), half(0x3c00)].concat();
        let file = format!(
            r#"{{"schema":2,"model":"google/siglip2-x","embedIds":["siglip2-x-q4"],"dim":2,
               "kind":"sigmoid","scale":100.0,"bias":-10.0,"encoding":"f16",
               "scenes":[{{"key":"beach","sv":"Stranden","vector":"{}"}},
                         {{"key":"sea","sv":"Havet","vector":"{}"}}]}}"#,
            b64.encode(beach),
            b64.encode(sea)
        );
        let v = Vocabulary::parse(&file).unwrap();
        assert_eq!(v.keys, vec!["beach", "sea"]);
        assert_eq!(v.classify(&[1.0, 0.0], 0.05)[0].0, "beach");
        assert!(v.matches_model("SigLIP2-X-q4", 2));
        // Another model of the same dimension is not this vocabulary.
        assert!(!v.matches_model("siglip2-x-fp16", 2));
        assert!(!v.matches_model("siglip2-x-q4", 3));
    }

    #[test]
    fn a_sigmoid_file_needs_its_bias_and_f32_vectors_work() {
        let file = axis_file(&[("beach", Some("Stranden"))], 4, r#","kind":"sigmoid""#);
        assert!(Vocabulary::parse(&file).is_err());
        let b64 = base64::engine::general_purpose::STANDARD;
        let bytes: Vec<u8> = [0.0f32, 2.0, 0.0]
            .iter()
            .flat_map(|x| x.to_le_bytes())
            .collect();
        let json = format!(
            r#"{{"model":"m","kind":"softmax","scale":50,"dim":3,"scenes":[{{"key":"a","sv":"A","vector":"{}"}}]}}"#,
            b64.encode(bytes)
        );
        let v = Vocabulary::parse(&json).unwrap();
        assert_eq!(v.logit_scale, 50.0);
        assert_eq!(
            v.classify(&[0.0, 1.0, 0.0], 0.2),
            vec![("a".to_string(), 1.0)]
        );
    }

    #[test]
    fn the_repository_vocabulary_parses() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../data/photo-scenes.json"
        );
        let v = Vocabulary::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(v.keys.len() >= 20);
        assert!(v.keys.iter().any(|k| k == "screen"));
    }
}
