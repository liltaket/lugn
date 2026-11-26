//! Saves the aligned 112 x 112 face crops the recogniser sees, with the
//! detected landmarks, for eyeballing alignment problems.
//!
//!   crops <models-dir> [--roll DEGREES] <out-dir> <image>…

mod common;

use photo_brain::infer::align::{CROP, aligned_crop};
use photo_brain::infer::{Analyzer, decode};

fn main() -> anyhow::Result<()> {
    let args = common::parse_args("crops <models-dir> <out-dir> <image>…")?;
    let [out, files @ ..] = args.files.as_slice() else {
        anyhow::bail!("give an output directory and pictures");
    };
    std::fs::create_dir_all(out)?;
    let mut analyzer = Analyzer::open_with(&args.config)?;
    for file in files {
        let picture = decode::decode_file(file)?.rgb;
        let stem = file.file_stem().unwrap_or_default().to_string_lossy();
        for (i, face) in analyzer.detect(&picture)?.iter().enumerate() {
            let crop = aligned_crop(&picture, &face.landmarks)?;
            let pixels: Vec<u8> = crop
                .rgb
                .iter()
                .map(|v| v.round().clamp(0.0, 255.0) as u8)
                .collect();
            let image = image::RgbImage::from_raw(CROP as u32, CROP as u32, pixels).unwrap();
            image.save(out.join(format!("{stem}-{i}.png")))?;
            println!(
                "{stem}-{i}: score {:.2} landmarks {:?}",
                face.score,
                face.landmarks.map(|p| (p.x.round(), p.y.round()))
            );
        }
    }
    Ok(())
}
