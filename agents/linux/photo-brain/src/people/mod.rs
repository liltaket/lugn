//! Grouping faces into people. This module is the seam between the brain (which
//! gathers faces and the household's decisions and publishes the proposals) and
//! the clustering itself. See `docs/PHOTO-BRAIN.md` (`GET /photo-brain/v1/people`).

use std::collections::{HashMap, HashSet};

/// `<pictureId>.<index>`.
pub type FaceId = String;
/// `p12`: a person the household's side (BrunoCAM) knows.
pub type PersonId = String;

/// One face as the grouping sees it.
#[derive(Debug, Clone)]
pub struct FaceRec {
    pub id: FaceId,
    pub photo_id: String,
    /// Unit length.
    pub embedding: Vec<f32>,
    /// Detector confidence, 0-1.
    pub score: f32,
    /// 0 (profile) to 1 (straight on).
    pub front: f32,
    /// 0-100, usefulness for recognition.
    pub quality: f32,
    /// Shorter side of the face box in pixels of the analysed image.
    pub px: f32,
}

/// What the household has decided (from `GET /photo-brain/v1/people`).
#[derive(Debug, Clone, Default)]
pub struct Labels {
    pub confirmed: HashSet<PersonId>,
    pub hidden: HashSet<PersonId>,
    /// `Some(p)`: pinned to `p`. `None`: declared "not a person".
    pub decided: HashMap<FaceId, Option<PersonId>>,
    /// The automatic grouping's earlier choice, to keep people's ids stable.
    pub previous: HashMap<FaceId, PersonId>,
    /// People a face was moved away from; never proposed again for that face.
    pub not: HashMap<FaceId, Vec<PersonId>>,
}

/// Where a face ended up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Assigned {
    /// An existing person.
    Person(PersonId),
    /// A new group of faces that agree; the same number on every member.
    Cluster(u32),
}

/// Tunable thresholds; the defaults are for the face model in use and are
/// calibrated against the household's own decisions (see the README).
#[derive(Debug, Clone)]
pub struct Thresholds {
    /// Cosine similarity to a person's centroid needed to join.
    pub join: f32,
    /// Similarity needed to keep an earlier automatic place.
    pub keep: f32,
    /// Average cosine similarity for faces to form a new group together.
    pub link: f32,
    /// The best person must beat the second best by this much to be chosen.
    pub margin: f32,
    pub seed_min_score: f32,
    pub seed_min_front: f32,
    pub seed_min_px: f32,
}

impl Default for Thresholds {
    fn default() -> Self {
        // SFace-like starting values; the face model's calibration replaces them.
        Self {
            join: 0.40,
            keep: 0.30,
            link: 0.38,
            margin: 0.04,
            seed_min_score: 0.75,
            seed_min_front: 0.30,
            seed_min_px: 40.0,
        }
    }
}

/// Proposes who every face is. Faces the function cannot place are missing from
/// the result. Not implemented yet: returns no proposals.
pub fn cluster(
    _faces: &[FaceRec],
    _labels: &Labels,
    _thresholds: &Thresholds,
) -> HashMap<FaceId, Assigned> {
    HashMap::new()
}
