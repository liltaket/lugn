//! What the models say about one picture. This is the seam between the
//! inference module (`infer/`, which produces it) and the clustering/publishing
//! side (which consumes it). Nothing here depends on ONNX or on image decoding.

use std::path::Path;

/// Which models produced an analysis. Stored with every result; a different
/// value means the result must be recomputed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ModelIds {
    /// Image embedding model, e.g. `siglip2-base-patch16-224`.
    pub embed: String,
    /// Face detector, e.g. `yunet-2023mar` or `scrfd-10g`.
    pub detector: String,
    /// Face recogniser, e.g. `sface-2021dec` or `arcface-r50`.
    pub face: String,
    /// Length of one face embedding.
    pub face_dim: usize,
    /// Length of one picture embedding.
    pub embed_dim: usize,
}

/// One face found in a picture. Coordinates are fractions of the upright picture.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FaceObservation {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// Detector confidence, 0-1.
    pub score: f32,
    /// How frontal the head is, 0 (profile) to 1 (straight on), from the
    /// landmarks and independent of how the head is rolled.
    pub front: f32,
    /// Usefulness of this face for recognition, 0-100 (size, sharpness, pose).
    pub quality: f32,
    /// Unit-length embedding of `ModelIds::face_dim` values.
    pub embedding: Vec<f32>,
}

/// Cheap whole-picture measurements.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PictureQuality {
    /// Sharpness 0-100 (variance of the Laplacian on a normalised thumbnail,
    /// mapped so that a blurry shot is low and a crisp one high).
    pub sharp: f32,
    /// 0 = bright, 100 = black.
    pub dark: f32,
}

/// Everything the models say about one picture.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PictureAnalysis {
    /// Unit-length image embedding of `ModelIds::embed_dim` values, in the same
    /// space as the scene text vectors (`data/photo-scenes.json`).
    pub embedding: Vec<f32>,
    pub faces: Vec<FaceObservation>,
    pub quality: PictureQuality,
}

/// The one thing the rest of the program needs from the models.
pub trait PictureAnalyzer {
    fn model_ids(&self) -> &ModelIds;

    /// Decodes the file (HEIC or JPEG, EXIF orientation applied) and analyses it.
    fn analyse(&mut self, path: &Path) -> anyhow::Result<PictureAnalysis>;
}
