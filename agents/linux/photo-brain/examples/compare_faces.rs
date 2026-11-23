//! Best cosine similarity between any face in picture A and any face in
//! picture B, with the recogniser in use (or `--face KEY`).
//!
//!   compare_faces <models-dir> [--face KEY] <a> <b>

mod common;

use photo_brain::analysis::PictureAnalyzer;
use photo_brain::infer::{Analyzer, cosine};
use serde_json::json;

fn main() -> anyhow::Result<()> {
    let args = common::parse_args("compare_faces <models-dir> [--face KEY] <a> <b>")?;
    let [a, b] = args.files.as_slice() else {
        anyhow::bail!("give exactly two pictures");
    };
    let mut analyzer = Analyzer::open_with(&args.config)?;
    let fa = analyzer.analyse(a)?.faces;
    let fb = analyzer.analyse(b)?.faces;
    let mut best: Option<(f32, usize, usize)> = None;
    for (i, x) in fa.iter().enumerate() {
        for (j, y) in fb.iter().enumerate() {
            let s = cosine(&x.embedding, &y.embedding);
            if best.is_none_or(|(bs, _, _)| s > bs) {
                best = Some((s, i, j));
            }
        }
    }
    println!(
        "{}",
        json!({
            "face": analyzer.model_ids().face,
            "facesA": fa.len(),
            "facesB": fb.len(),
            "best": best.map(|(s, i, j)| json!({ "cosine": (s * 1e4).round() / 1e4, "a": i, "b": j,
                "qa": fa[i].quality, "qb": fb[j].quality })),
        })
    );
    Ok(())
}
