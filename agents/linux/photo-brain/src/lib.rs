//! Kuffe's photo brain. See `docs/PHOTO-BRAIN.md` for the whole design.
//!
//! Module ownership (so two people can work in parallel without conflicts):
//! - `bundle`, `analysis`: the contract; change only together with the doc.
//! - `people/`: grouping faces into people (anchored on the household's decisions).
//! - `infer/`: decoding, preprocessing and the ONNX models (turns one picture
//!   into a [`analysis::PictureAnalysis`]).
//! - everything else (client, store, clustering, publishing, service): the brain.

pub mod analysis;
pub mod bundle;
pub mod infer;
pub mod people;
