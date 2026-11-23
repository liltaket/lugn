//! Shared by the examples: argument parsing, peak RSS and the scene file.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use base64::Engine;
use photo_brain::infer::InferConfig;

pub struct Args {
    pub config: InferConfig,
    pub files: Vec<PathBuf>,
    pub dump: Option<PathBuf>,
    pub scenes: Option<PathBuf>,
}

/// `<models-dir> [--threads N] [--embed KEY] [--face KEY] [--long-edge PX]
/// [--min-score S] [--dump-embeddings FILE] [--scenes FILE] <file>…`
pub fn parse_args(usage: &str) -> Result<Args> {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        bail!("usage: {usage}")
    };
    let mut config = InferConfig::new(Path::new(&dir), 8);
    let mut files = Vec::new();
    let (mut dump, mut scenes) = (None, None);
    while let Some(arg) = args.next() {
        let mut value = || args.next().with_context(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--threads" => config.threads = value()?.parse()?,
            "--embed" => config.embed = Some(value()?),
            "--face" => config.face = Some(value()?),
            "--long-edge" => config.detector_long_edge = value()?.parse()?,
            "--min-score" => config.min_face_score = value()?.parse()?,
            "--dump-embeddings" => dump = Some(PathBuf::from(value()?)),
            "--scenes" => scenes = Some(PathBuf::from(value()?)),
            flag if flag.starts_with("--") => bail!("unknown option {flag}; usage: {usage}"),
            _ => files.push(PathBuf::from(arg)),
        }
    }
    Ok(Args {
        config,
        files,
        dump,
        scenes,
    })
}

/// Peak resident set size of this process, in MB (`VmHWM`).
pub fn peak_rss_mb() -> f64 {
    status_kb("VmHWM:") / 1024.0
}
pub fn rss_mb() -> f64 {
    status_kb("VmRSS:") / 1024.0
}
fn status_kb(key: &str) -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with(key))
                .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
        })
        .unwrap_or(0.0)
}

pub struct Scenes {
    pub kind: String,
    pub scale: f32,
    pub bias: f32,
    pub keys: Vec<String>,
    pub vectors: Vec<Vec<f32>>,
}

/// Reads a schema-2 scene file (`encoding: "f16"` or `"int8"` with `quant`).
pub fn load_scenes(path: &Path) -> Result<Scenes> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let dim = v["dim"].as_u64().context("dim")? as usize;
    let encoding = v["encoding"].as_str().unwrap_or("int8");
    let quant = v["quant"].as_f64().unwrap_or(1.0) as f32;
    let mut keys = Vec::new();
    let mut vectors = Vec::new();
    for scene in v["scenes"].as_array().context("scenes")? {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(scene["vector"].as_str().context("vector")?)?;
        let vector: Vec<f32> = match encoding {
            "f16" => bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| f16_to_f32(u16::from_le_bytes([b[0], b[1]])))
                .collect(),
            _ => bytes.iter().map(|&b| b as i8 as f32 / quant).collect(),
        };
        if vector.len() != dim {
            bail!("scene vector of {} values, dim {dim}", vector.len());
        }
        keys.push(scene["key"].as_str().unwrap_or("?").to_string());
        vectors.push(photo_brain::infer::normalised(&vector));
    }
    Ok(Scenes {
        kind: v["kind"].as_str().unwrap_or("softmax").to_string(),
        scale: v["scale"].as_f64().unwrap_or(100.0) as f32,
        bias: v["bias"].as_f64().unwrap_or(0.0) as f32,
        keys,
        vectors,
    })
}

impl Scenes {
    /// Best `n` scenes with their probabilities.
    pub fn top(&self, embedding: &[f32], n: usize) -> Vec<(String, f32)> {
        let logits: Vec<f32> = self
            .vectors
            .iter()
            .map(|v| self.scale * photo_brain::infer::cosine(v, embedding) + self.bias)
            .collect();
        let probs: Vec<f32> = if self.kind == "sigmoid" {
            logits.iter().map(|l| 1.0 / (1.0 + (-l).exp())).collect()
        } else {
            let top = logits.iter().cloned().fold(f32::MIN, f32::max);
            let e: Vec<f32> = logits.iter().map(|l| (l - top).exp()).collect();
            let sum: f32 = e.iter().sum();
            e.iter().map(|x| x / sum).collect()
        };
        let mut ranked: Vec<(String, f32)> = self.keys.iter().cloned().zip(probs).collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
        ranked.truncate(n);
        ranked
    }
}

pub fn f16_to_f32(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = ((h >> 10) & 0x1f) as i32;
    let frac = (h & 0x3ff) as f32;
    match exp {
        0 => sign * frac * 2f32.powi(-24),
        31 => sign * f32::INFINITY,
        _ => sign * (1.0 + frac / 1024.0) * 2f32.powi(exp - 15),
    }
}
