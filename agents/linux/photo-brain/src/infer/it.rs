//! End-to-end check with the real models on public-domain pictures.
//!
//! Runs only when `LUGN_PHOTO_BRAIN_MODELS` names a models directory (see the
//! README; `cargo run --release --example fetch -- <dir>` fills one). The
//! pictures are downloaded into a temporary directory at test time and removed
//! afterwards; nothing is committed. Without models or network the test
//! prints why it was skipped and passes.
//!
//!   LUGN_PHOTO_BRAIN_MODELS=~/.local/share/lugn-photo-brain/models \
//!     cargo test --release infer::it -- --nocapture
//!
//! `LUGN_PHOTO_BRAIN_EMBED` / `LUGN_PHOTO_BRAIN_FACE` pick other `models.toml`
//! entries (e.g. `siglip2-base-patch16-384-int8` for a faster run).

use std::path::{Path, PathBuf};

use super::{Analyzer, InferConfig, cosine};
use crate::analysis::{PictureAnalysis, PictureAnalyzer};

/// (file name, URL). All public domain: NASA (Eileen Collins, via
/// scikit-image's data) and official White House portraits on Wikimedia Commons.
const SAMPLES: [(&str, &str); 4] = [
    (
        "astronaut.png",
        "https://raw.githubusercontent.com/scikit-image/scikit-image/v0.19.3/skimage/data/astronaut.png",
    ),
    (
        "obama.jpg",
        "https://upload.wikimedia.org/wikipedia/commons/8/8d/President_Barack_Obama.jpg",
    ),
    (
        "obama_family.jpg",
        "https://upload.wikimedia.org/wikipedia/commons/5/5d/Barack_Obama_family_portrait_2011.jpg",
    ),
    (
        "biden.jpg",
        "https://upload.wikimedia.org/wikipedia/commons/6/68/Joe_Biden_presidential_portrait.jpg",
    ),
];

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Downloads the samples, or copies them from `LUGN_PHOTO_BRAIN_SAMPLES`
/// when that directory already holds them (Wikimedia rate-limits repeated
/// anonymous downloads with HTTP 429).
fn download(dir: &Path) -> Result<(), String> {
    let cache = std::env::var_os("LUGN_PHOTO_BRAIN_SAMPLES").map(PathBuf::from);
    for (name, url) in SAMPLES {
        if let Some(cached) = cache.as_ref().map(|c| c.join(name)).filter(|p| p.is_file()) {
            std::fs::copy(cached, dir.join(name)).map_err(|e| e.to_string())?;
            continue;
        }
        let mut attempt = 0;
        let response = loop {
            attempt += 1;
            match ureq::get(url)
                .header(
                    "User-Agent",
                    "lugn-photo-brain-tests/0.1 (integration test)",
                )
                .call()
            {
                Ok(response) => break response,
                Err(ureq::Error::StatusCode(429)) if attempt < 4 => {
                    std::thread::sleep(std::time::Duration::from_secs(5 * attempt));
                }
                Err(e) => return Err(format!("{url}: {e}")),
            }
        };
        let bytes = response
            .into_body()
            .with_config()
            .limit(64 << 20)
            .read_to_vec()
            .map_err(|e| format!("{url}: {e}"))?;
        std::fs::write(dir.join(name), bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn analyse(analyzer: &mut Analyzer, dir: &Path, name: &str) -> PictureAnalysis {
    analyzer
        .analyse(&dir.join(name))
        .unwrap_or_else(|e| panic!("{name}: {e:#}"))
}

#[test]
fn real_models_on_public_domain_pictures() {
    let Some(models) = std::env::var_os("LUGN_PHOTO_BRAIN_MODELS") else {
        eprintln!("SKIPPED: set LUGN_PHOTO_BRAIN_MODELS to a models directory to run this test");
        return;
    };
    let mut config = InferConfig::new(Path::new(&models), 8);
    config.embed = std::env::var("LUGN_PHOTO_BRAIN_EMBED").ok();
    config.face = std::env::var("LUGN_PHOTO_BRAIN_FACE").ok();
    let mut analyzer = match Analyzer::open_with(&config) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("SKIPPED: models not usable ({e:#}); run the fetch example first");
            return;
        }
    };
    let dir =
        TempDir(std::env::temp_dir().join(format!("lugn-photo-brain-it-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    if let Err(e) = download(&dir.0) {
        eprintln!("SKIPPED: could not download the sample pictures ({e})");
        return;
    }
    let ids = analyzer.model_ids().clone();

    // One frontal face, where it is, with a unit-length embedding.
    let astronaut = analyse(&mut analyzer, &dir.0, "astronaut.png");
    assert_eq!(astronaut.embedding.len(), ids.embed_dim);
    assert!((cosine(&astronaut.embedding, &astronaut.embedding) - 1.0).abs() < 1e-4);
    assert_eq!(astronaut.faces.len(), 1, "{:?}", astronaut.faces);
    let face = &astronaut.faces[0];
    let (cx, cy) = (face.x + face.w / 2.0, face.y + face.h / 2.0);
    assert!(
        (0.38..0.50).contains(&cx) && (0.15..0.30).contains(&cy),
        "{face:?}"
    );
    assert!(
        face.score > 0.85 && face.front > 0.8 && face.quality > 40.0,
        "{face:?}"
    );
    assert_eq!(face.embedding.len(), ids.face_dim);
    assert!(astronaut.quality.sharp > 50.0 && astronaut.quality.dark < 20.0);

    // The same face rolled (a tilted head, or the camera held askew): still
    // found, and the aligned crop removes the roll, so the embedding barely
    // changes and `front` does not move.
    let upright = super::decode::decode_file(&dir.0.join("astronaut.png"))
        .unwrap()
        .rgb;
    for degrees in [-30.0f32, 30.0, 90.0] {
        let rolled = rotate(&upright, degrees);
        let rolled = analyzer.analyse_picture(&rolled).unwrap();
        let Some(found) = rolled.faces.first() else {
            panic!("no face at {degrees}°");
        };
        let same = cosine(&found.embedding, &face.embedding);
        eprintln!(
            "{}: roll {degrees}° → cosine {same:.3}, front {:.2} (upright {:.2})",
            ids.face, found.front, face.front
        );
        if degrees.abs() <= 30.0 {
            assert_eq!(rolled.faces.len(), 1, "{:?}", rolled.faces);
            assert!(same > 0.75, "rolled face embedding drifted: cosine {same}");
            assert!((found.front - face.front).abs() < 0.15);
        }
    }

    // Same person in two pictures beats a different person.
    let obama = analyse(&mut analyzer, &dir.0, "obama.jpg");
    let family = analyse(&mut analyzer, &dir.0, "obama_family.jpg");
    let biden = analyse(&mut analyzer, &dir.0, "biden.jpg");
    assert_eq!(obama.faces.len(), 1);
    assert_eq!(biden.faces.len(), 1);
    assert_eq!(family.faces.len(), 4, "the family portrait has four faces");
    let (best, at) = family
        .faces
        .iter()
        .enumerate()
        .map(|(i, f)| (cosine(&f.embedding, &obama.faces[0].embedding), i))
        .fold((f32::MIN, 0), |a, b| if b.0 > a.0 { b } else { a });
    let barack = &family.faces[at];
    assert!(
        (0.55..0.70).contains(&(barack.x + barack.w / 2.0)),
        "best match is not Barack Obama: {barack:?}"
    );
    let impostor = cosine(&biden.faces[0].embedding, &obama.faces[0].embedding);
    eprintln!(
        "{}: same person {best:.3}, different person {impostor:.3}",
        ids.face
    );
    assert!(
        best > impostor + 0.15,
        "same {best} vs different {impostor}"
    );
}

/// Rotates about the centre by `degrees` (counter-clockwise), same size,
/// bilinear, black outside.
fn rotate(src: &image::RgbImage, degrees: f32) -> image::RgbImage {
    let (w, h) = (src.width() as f32, src.height() as f32);
    let (s, c) = degrees.to_radians().sin_cos();
    image::RgbImage::from_fn(src.width(), src.height(), |x, y| {
        let (dx, dy) = (x as f32 - w / 2.0, y as f32 - h / 2.0);
        let sx = c * dx - s * dy + w / 2.0;
        let sy = s * dx + c * dy + h / 2.0;
        if sx < 0.0 || sy < 0.0 || sx >= w - 1.0 || sy >= h - 1.0 {
            return image::Rgb([0, 0, 0]);
        }
        let (x0, y0) = (sx.floor() as u32, sy.floor() as u32);
        let (fx, fy) = (sx - x0 as f32, sy - y0 as f32);
        let p = |xx: u32, yy: u32, ch: usize| src.get_pixel(xx, yy).0[ch] as f32;
        image::Rgb(std::array::from_fn(|ch| {
            let top = p(x0, y0, ch) * (1.0 - fx) + p(x0 + 1, y0, ch) * fx;
            let bottom = p(x0, y0 + 1, ch) * (1.0 - fx) + p(x0 + 1, y0 + 1, ch) * fx;
            (top * (1.0 - fy) + bottom * fy).round() as u8
        }))
    })
}
