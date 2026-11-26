//! Analyses pictures and prints one JSON line per picture: sizes, timings per
//! stage, quality, faces, and (with `--scenes`) the top scenes; then the peak RSS.
//!
//!   analyse <models-dir> [--threads 8] [--embed KEY] [--face KEY]
//!           [--long-edge 1600] [--min-score 0.65]
//!           [--dump-embeddings out.jsonl] [--scenes data/photo-scenes.json] <image>…

mod common;

use std::io::Write;
use std::time::Instant;

use photo_brain::analysis::PictureAnalyzer;
use photo_brain::infer::Analyzer;
use serde_json::json;

fn ms(d: std::time::Duration) -> f64 {
    (d.as_secs_f64() * 10000.0).round() / 10.0
}

fn main() -> anyhow::Result<()> {
    let args = common::parse_args("analyse <models-dir> [options] <image>…")?;
    let t = Instant::now();
    let mut analyzer = Analyzer::open_with(&args.config)?;
    eprintln!(
        "{}",
        json!({
            "models": analyzer.model_ids(),
            "loadMs": ms(t.elapsed()),
            "rssAfterLoadMb": common::rss_mb().round(),
        })
    );
    let scenes = args
        .scenes
        .as_deref()
        .map(common::load_scenes)
        .transpose()?;
    let mut dump = args
        .dump
        .as_deref()
        .map(std::fs::File::create)
        .transpose()?;
    for file in &args.files {
        let t = Instant::now();
        let result = analyzer.analyse(file);
        let total = t.elapsed();
        let analysis = match result {
            Ok(a) => a,
            Err(error) => {
                println!("{}", json!({ "file": file, "error": format!("{error:#}") }));
                continue;
            }
        };
        let l = analyzer.last;
        let faces: Vec<_> = analysis
            .faces
            .iter()
            .map(|f| {
                json!({ "x": f.x, "y": f.y, "w": f.w, "h": f.h, "score": f.score,
                        "front": f.front, "q": f.quality })
            })
            .collect();
        let mut line = json!({
            "file": file,
            "size": [analyzer.last_size.0, analyzer.last_size.1],
            "embedding": analysis.embedding.len(),
            "quality": analysis.quality,
            "faces": faces,
            "ms": { "decode": ms(l.decode), "quality": ms(l.quality), "embed": ms(l.embed),
                    "detect": ms(l.detect), "recognise": ms(l.recognise), "total": ms(total) },
        });
        if let Some(scenes) = &scenes {
            line["scenes"] = json!(scenes.top(&analysis.embedding, 5));
        }
        println!("{line}");
        if let Some(out) = dump.as_mut() {
            let faces: Vec<_> = analysis
                .faces
                .iter()
                .map(|f| {
                    json!({ "x": f.x, "y": f.y, "w": f.w, "h": f.h, "q": f.quality,
                                 "embedding": f.embedding })
                })
                .collect();
            writeln!(
                out,
                "{}",
                json!({ "file": file, "models": analyzer.model_ids(),
                        "embedding": analysis.embedding, "faces": faces })
            )?;
        }
    }
    eprintln!("{}", json!({ "peakRssMb": common::peak_rss_mb().round() }));
    Ok(())
}
