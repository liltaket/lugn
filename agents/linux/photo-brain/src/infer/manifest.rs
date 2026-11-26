//! `models.toml`: which model files exist, where they come from, and how each
//! one wants its input. The copy compiled in (`src/infer/models.toml`) is the
//! default; `<models_dir>/models.toml` overrides it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

pub const DEFAULT_MANIFEST: &str = include_str!("models.toml");

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    #[serde(rename = "use")]
    pub chosen: Chosen,
    pub runtime: Download,
    #[serde(default)]
    pub embed: BTreeMap<String, EmbedModel>,
    #[serde(default)]
    pub detector: BTreeMap<String, DetectorModel>,
    #[serde(default)]
    pub face: BTreeMap<String, FaceModel>,
}

/// The models in use, by key.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Chosen {
    pub embed: String,
    pub detector: String,
    pub face: String,
}

/// Where a file comes from. `url` is the file itself, or a zip archive when
/// `member` is set (then `archive_sha256` pins the archive and `sha256` the
/// extracted file).
#[derive(Debug, Clone, Deserialize)]
pub struct Download {
    pub file: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub member: Option<String>,
    #[serde(default)]
    pub archive_sha256: Option<String>,
    /// Part of the default download set.
    #[serde(default)]
    pub default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Resize {
    /// Stretch to the square, ignoring the aspect ratio (SigLIP).
    Squash,
    /// Scale the shorter side to the square and cut the middle (CLIP).
    Crop,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EmbedModel {
    #[serde(flatten)]
    pub download: Download,
    /// Square input side in pixels.
    pub size: u32,
    pub resize: Resize,
    pub mean: [f32; 3],
    pub std: [f32; 3],
    pub dim: usize,
    /// Output tensor holding the embedding; the first output when absent.
    #[serde(default)]
    pub output: Option<String>,
    /// Scene vocabulary built from the matching text tower (`data/<scenes>`).
    #[serde(default)]
    pub scenes: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DetectorModel {
    #[serde(flatten)]
    pub download: Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelOrder {
    Rgb,
    Bgr,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FaceModel {
    #[serde(flatten)]
    pub download: Download,
    pub order: ChannelOrder,
    /// Input value = (pixel 0-255 - mean) / std.
    pub mean: f32,
    pub std: f32,
    pub dim: usize,
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Manifest> {
        let manifest: Manifest = toml::from_str(text).context("models.toml")?;
        manifest.check()?;
        Ok(manifest)
    }

    /// `<models_dir>/models.toml` when present, the compiled-in default otherwise.
    pub fn load(models_dir: &Path) -> Result<Manifest> {
        let path = models_dir.join("models.toml");
        match std::fs::read_to_string(&path) {
            Ok(text) => Self::parse(&text).with_context(|| path.display().to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Self::parse(DEFAULT_MANIFEST)
            }
            Err(error) => Err(error).with_context(|| path.display().to_string()),
        }
    }

    pub fn check(&self) -> Result<()> {
        if !self.embed.contains_key(&self.chosen.embed) {
            bail!(
                "[use] embed = {:?} has no [embed.…] entry",
                self.chosen.embed
            );
        }
        if !self.detector.contains_key(&self.chosen.detector) {
            bail!(
                "[use] detector = {:?} has no [detector.…] entry",
                self.chosen.detector
            );
        }
        if !self.face.contains_key(&self.chosen.face) {
            bail!("[use] face = {:?} has no [face.…] entry", self.chosen.face);
        }
        for (key, model) in &self.embed {
            if model.size == 0 || model.dim == 0 || model.std.contains(&0.0) {
                bail!("[embed.{key}]: size, dim and std must be non-zero");
            }
        }
        for (key, model) in &self.face {
            if model.dim == 0 || model.std == 0.0 {
                bail!("[face.{key}]: dim and std must be non-zero");
            }
        }
        Ok(())
    }

    pub fn embed_model(&self) -> &EmbedModel {
        &self.embed[&self.chosen.embed]
    }
    pub fn detector_model(&self) -> &DetectorModel {
        &self.detector[&self.chosen.detector]
    }
    pub fn face_model(&self) -> &FaceModel {
        &self.face[&self.chosen.face]
    }

    /// Every downloadable entry, as `(key, download)`; the runtime is `"runtime"`.
    pub fn downloads(&self) -> Vec<(String, &Download)> {
        let mut out = vec![("runtime".to_string(), &self.runtime)];
        out.extend(self.embed.iter().map(|(k, m)| (k.clone(), &m.download)));
        out.extend(self.detector.iter().map(|(k, m)| (k.clone(), &m.download)));
        out.extend(self.face.iter().map(|(k, m)| (k.clone(), &m.download)));
        out
    }
}

/// `file` resolved against the models directory.
pub fn path_in(models_dir: &Path, file: &str) -> PathBuf {
    models_dir.join(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_manifest_parses_and_pins_every_default_file() {
        let manifest = Manifest::parse(DEFAULT_MANIFEST).unwrap();
        assert_eq!(manifest.embed_model().dim, 1152);
        assert_eq!(manifest.embed_model().resize, Resize::Squash);
        for (key, download) in manifest.downloads() {
            if key == "runtime" || download.default {
                assert_eq!(download.sha256.len(), 64, "{key} is not pinned");
                assert!(download.bytes > 0, "{key} has no size");
            }
        }
        assert!(!manifest.face["buffalo_l-w600k-r50"].download.default);
    }

    #[test]
    fn unknown_choice_is_refused() {
        let text = DEFAULT_MANIFEST.replace(
            "face = \"auraface-v1-glintr100\"",
            "face = \"no-such-model\"",
        );
        assert!(Manifest::parse(&text).is_err());
    }
}
