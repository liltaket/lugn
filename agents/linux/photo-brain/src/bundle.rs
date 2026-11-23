//! The intel bundle BrunoCAM receives (schema 1). See `docs/PHOTO-BRAIN.md`.
//! Keep this file and the document in step.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const SCHEMA: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Bundle {
    pub schema: u32,
    #[serde(rename = "generatedAt")]
    pub generated_at: i64,
    pub brain: BrainInfo,
    pub home: Option<Home>,
    pub trips: Vec<Trip>,
    pub events: Vec<Event>,
    pub photos: BTreeMap<String, PhotoIntel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BrainInfo {
    pub version: String,
    pub models: BrainModels,
    #[serde(rename = "faceDim")]
    pub face_dim: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BrainModels {
    pub embed: String,
    pub face: String,
    pub detector: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Home {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Trip {
    pub title: String,
    /// Local dates `YYYY-MM-DD`.
    pub from: String,
    pub to: String,
    pub cc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub id: String,
    /// Capture time, ms since the epoch.
    pub from: i64,
    pub to: i64,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PhotoIntel {
    /// The picture version this entry was computed from.
    pub v: String,
    /// Best three scenes with probabilities, best first.
    pub scene: Vec<(String, f32)>,
    pub q: Quality,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fav: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap: Option<String>,
    pub faces: Vec<Face>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trip: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    /// `[id, base, time, place, look]`, best first; -1 means unknown.
    pub cand: Vec<(String, i32, i32, i32, i32)>,
    pub du: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Quality {
    pub sharp: u8,
    pub dark: u8,
    /// `"screenshot"`, `"document"` or none.
    pub junk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Face {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub score: f32,
    pub front: f32,
    pub q: u8,
    /// Base64 of little-endian f32 values, `faceDim` of them, unit length.
    pub e: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minimal_bundle_round_trips() {
        let json = r#"{"schema":1,"generatedAt":1,"brain":{"version":"0.1.0",
            "models":{"embed":"e","face":"f","detector":"d"},"faceDim":4},
            "home":null,"trips":[],"events":[],"photos":{"a":{"v":"1","scene":[["beach",0.5]],
            "q":{"sharp":80,"dark":3,"junk":null},"faces":[],"cand":[["b",74,90,60,71]],"du":[]}}}"#;
        let bundle: Bundle = serde_json::from_str(json).unwrap();
        assert_eq!(bundle.photos["a"].cand[0].1, 74);
        let again: Bundle =
            serde_json::from_str(&serde_json::to_string(&bundle).unwrap()).unwrap();
        assert_eq!(bundle, again);
    }
}
