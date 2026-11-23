//! Inference: decodes a picture, runs the ONNX models and produces a
//! [`PictureAnalysis`]. See `src/infer/README.md` for models, licences,
//! numbers and known weaknesses.

pub mod align;
pub mod decode;
pub mod detect;
pub mod imageops;
pub mod manifest;
pub mod models;
pub mod quality;

#[cfg(test)]
mod it;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use image::RgbImage;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::TensorRef;

use crate::analysis::{FaceObservation, ModelIds, PictureAnalysis, PictureAnalyzer};
use align::Similarity;
use align::{CROP, aligned_crop, eye_angle, face_quality, frontalness, rotated_square, sample};
use detect::{Detection, Level, Pass, Point, padded, plan, suppress};
use imageops::{Filter, fit_long_edge, resize_rgb};
use manifest::{ChannelOrder, EmbedModel, FaceModel, Manifest, Resize, path_in};

/// Landmark refinement: side of the view around a face (times the box),
/// its size in pixels, the turns tried, and the score a view must reach.
const REFINE_CONTEXT: f32 = 2.0;
const REFINE: usize = 192;
const REFINE_ANGLES: [i32; 7] = [0, -30, 30, -60, 60, -90, 90];
const REFINE_MIN_SCORE: f32 = 0.5;
/// Below this roll (radians, 10°) a face counts as upright.
const UPRIGHT: f32 = 0.1745;

/// Everything the analyser can be told. `InferConfig::new` gives the defaults.
#[derive(Debug, Clone)]
pub struct InferConfig {
    pub models_dir: PathBuf,
    /// Threads per model run (`intra_op_num_threads`).
    pub threads: usize,
    /// `libonnxruntime.so` to load. Default: `ORT_DYLIB_PATH` if set, else the
    /// manifest's `[runtime] file` (`<models_dir>/../lib/…`).
    pub onnxruntime_lib: Option<PathBuf>,
    /// Override `[use]` from the manifest.
    pub embed: Option<String>,
    pub face: Option<String>,
    /// Long edge of the main face-detection pass (smaller passes at 640 and
    /// 320 px catch big faces).
    pub detector_long_edge: u32,
    /// Faces below this detector score are dropped.
    pub min_face_score: f32,
    /// IoU above which the weaker of two boxes is dropped.
    pub nms_iou: f32,
    /// Faces whose box's short side is under this many pixels of the original
    /// picture are dropped (no recognition is possible).
    pub min_face_px: f32,
    /// At most this many faces per picture (the biggest).
    pub max_faces: usize,
}

impl InferConfig {
    pub fn new(models_dir: &Path, threads: usize) -> InferConfig {
        InferConfig {
            models_dir: models_dir.to_path_buf(),
            threads: threads.clamp(1, 64),
            onnxruntime_lib: None,
            embed: None,
            face: None,
            detector_long_edge: 1600,
            min_face_score: 0.65,
            nms_iou: 0.4,
            min_face_px: 20.0,
            max_faces: 32,
        }
    }
}

/// Opens the models in `models_dir` with the defaults.
pub fn open(models_dir: &Path, threads: usize) -> Result<Box<dyn PictureAnalyzer>> {
    Ok(Box::new(Analyzer::open_with(&InferConfig::new(
        models_dir, threads,
    ))?))
}

pub fn open_with(config: &InferConfig) -> Result<Box<dyn PictureAnalyzer>> {
    Ok(Box::new(Analyzer::open_with(config)?))
}

/// Time spent per stage of the last [`Analyzer::analyse_picture`] call.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct Timings {
    pub decode: Duration,
    pub quality: Duration,
    pub embed: Duration,
    pub detect: Duration,
    pub recognise: Duration,
}

pub struct Analyzer {
    ids: ModelIds,
    config: InferConfig,
    embed_model: EmbedModel,
    face_model: FaceModel,
    embedder: Session,
    embed_output: String,
    detector: Session,
    recogniser: Session,
    _env: ort::environment::Environment,
    pub last: Timings,
    /// Width and height of the last upright picture.
    pub last_size: (u32, u32),
}

type Loaded = std::result::Result<(PathBuf, ort::environment::Environment), String>;
static RUNTIME: OnceLock<Loaded> = OnceLock::new();

/// Loads ONNX Runtime once per process, with telemetry off.
fn init_runtime(lib: &Path) -> Result<ort::environment::Environment> {
    let loaded = RUNTIME.get_or_init(|| {
        // ONNX Runtime 1.31 on Linux ships a 1DS telemetry client
        // (`telemetry_1ds.cc`, posting to mobile.events.data.microsoft.com)
        // that reads ORT_DISABLE_TELEMETRY. Set it before the library loads;
        // DisableTelemetryEvents (`with_telemetry(false)`) is the API switch.
        if std::env::var_os("ORT_DISABLE_TELEMETRY").is_none() {
            // SAFETY: done once, before ONNX Runtime (the only other reader of
            // the environment in this process that could race) is loaded. The
            // service sets the variable in its unit as well.
            unsafe { std::env::set_var("ORT_DISABLE_TELEMETRY", "1") };
        }
        let result = (|| -> Result<ort::environment::Environment> {
            let builder = ort::init_from(lib)
                .map_err(|e| anyhow::anyhow!("loading {}: {e}", lib.display()))?;
            builder
                .with_name("lugn-photo-brain")
                .with_telemetry(false)
                .build()
                .map_err(|e| anyhow::anyhow!("starting ONNX Runtime: {e}"))
        })();
        result
            .map(|env| (lib.to_path_buf(), env))
            .map_err(|e| format!("{e:#}"))
    });
    match loaded {
        Ok((path, env)) if path == lib => Ok(env.clone()),
        Ok((path, _)) => bail!(
            "ONNX Runtime is already loaded from {}; cannot load {} as well",
            path.display(),
            lib.display()
        ),
        Err(error) => bail!("{error}"),
    }
}

fn runtime_path(config: &InferConfig, manifest: &Manifest) -> PathBuf {
    if let Some(path) = &config.onnxruntime_lib {
        return path.clone();
    }
    if let Some(path) = std::env::var_os("ORT_DYLIB_PATH") {
        return PathBuf::from(path);
    }
    path_in(&config.models_dir, &manifest.runtime.file)
}

fn session(env: &ort::environment::Environment, path: &Path, threads: usize) -> Result<Session> {
    if !path.is_file() {
        bail!(
            "{} is missing (run the `fetch` example or infer::models::ensure)",
            path.display()
        );
    }
    let build = || -> ort::Result<Session> {
        Session::builder(env)?
            .with_execution_providers([ort::ep::CPU::default()
                .with_arena_allocator(false)
                .build()])?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(threads)?
            .with_inter_threads(1)?
            .with_memory_pattern(false)?
            .with_intra_op_spinning(false)?
            .commit_from_file(path)
    };
    build().map_err(|e| anyhow::anyhow!("loading {}: {e}", path.display()))
}

fn ort_err(e: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("{e}")
}

impl Analyzer {
    pub fn open_with(config: &InferConfig) -> Result<Analyzer> {
        let mut manifest = Manifest::load(&config.models_dir)?;
        if let Some(embed) = &config.embed {
            manifest.chosen.embed = embed.clone();
        }
        if let Some(face) = &config.face {
            manifest.chosen.face = face.clone();
        }
        manifest.check()?;
        let env = init_runtime(&runtime_path(config, &manifest))?;
        let dir = &config.models_dir;
        let embed_model = manifest.embed_model().clone();
        let face_model = manifest.face_model().clone();
        let embedder = session(
            &env,
            &path_in(dir, &embed_model.download.file),
            config.threads,
        )?;
        let embed_output = match &embed_model.output {
            Some(name) => {
                if !embedder.outputs().iter().any(|o| o.name() == name) {
                    bail!("the embedding model has no output {name:?}");
                }
                name.clone()
            }
            None => embedder.outputs()[0].name().to_string(),
        };
        let detector = session(
            &env,
            &path_in(dir, &manifest.detector_model().download.file),
            config.threads,
        )?;
        let recogniser = session(
            &env,
            &path_in(dir, &face_model.download.file),
            config.threads,
        )?;
        let ids = ModelIds {
            embed: manifest.chosen.embed.clone(),
            detector: format!(
                "{}@{}px-s{:.2}",
                manifest.chosen.detector, config.detector_long_edge, config.min_face_score
            ),
            face: manifest.chosen.face.clone(),
            face_dim: face_model.dim,
            embed_dim: embed_model.dim,
        };
        Ok(Analyzer {
            ids,
            config: config.clone(),
            embed_model,
            face_model,
            embedder,
            embed_output,
            detector,
            recogniser,
            _env: env,
            last: Timings::default(),
            last_size: (0, 0),
        })
    }

    /// Analyses an already decoded upright picture.
    pub fn analyse_picture(&mut self, picture: &RgbImage) -> Result<PictureAnalysis> {
        let t = Instant::now();
        let quality = quality::measure(picture)?;
        self.last.quality = t.elapsed();

        let t = Instant::now();
        let embedding = self.embed(picture)?;
        self.last.embed = t.elapsed();

        let t = Instant::now();
        let found = self.detect(picture)?;
        self.last.detect = t.elapsed();

        let t = Instant::now();
        let mut faces = Vec::with_capacity(found.len());
        let (w, h) = (picture.width() as f32, picture.height() as f32);
        for face in found {
            let x0 = face.x.max(0.0);
            let y0 = face.y.max(0.0);
            let x1 = (face.x + face.w).min(w);
            let y1 = (face.y + face.h).min(h);
            if x1 - x0 < 4.0 || y1 - y0 < 4.0 {
                continue;
            }
            let crop = aligned_crop(picture, &face.landmarks)?;
            let embedding = self.recognise(&crop)?;
            let front = frontalness(&face.landmarks);
            let short = (x1 - x0).min(y1 - y0);
            faces.push(FaceObservation {
                x: round4(x0 / w),
                y: round4(y0 / h),
                w: round4((x1 - x0) / w),
                h: round4((y1 - y0) / h),
                score: round4(face.score),
                front: round4(front),
                quality: (face_quality(short, crop.sharpness(), front, face.score) * 10.0).round()
                    / 10.0,
                embedding,
            });
        }
        self.last.recognise = t.elapsed();
        self.last_size = (picture.width(), picture.height());
        Ok(PictureAnalysis {
            embedding,
            faces,
            quality,
        })
    }

    /// The SigLIP input: squashed (or centre-cropped) to the square with the
    /// antialiased bilinear filter, rescaled to 0-1, then (x − mean) / std.
    pub fn embed_input(model: &EmbedModel, picture: &RgbImage) -> Result<Vec<f32>> {
        let size = model.size;
        let square = match model.resize {
            Resize::Squash => resize_rgb(picture, size, size, Filter::Bilinear)?,
            Resize::Crop => {
                let (w, h) = (picture.width(), picture.height());
                let side = w.min(h);
                let cropped =
                    image::imageops::crop_imm(picture, (w - side) / 2, (h - side) / 2, side, side)
                        .to_image();
                resize_rgb(&cropped, size, size, Filter::Bilinear)?
            }
        };
        Ok(planar_normalised(&square, model.mean, model.std))
    }

    fn embed(&mut self, picture: &RgbImage) -> Result<Vec<f32>> {
        let input = Self::embed_input(&self.embed_model, picture)?;
        let size = self.embed_model.size as usize;
        let name = self.embedder.inputs()[0].name().to_string();
        let tensor =
            TensorRef::from_array_view(([1usize, 3, size, size], &input[..])).map_err(ort_err)?;
        let outputs = self
            .embedder
            .run(ort::inputs![name => tensor])
            .map_err(ort_err)?;
        let (_, data) = outputs[self.embed_output.as_str()]
            .try_extract_tensor::<f32>()
            .map_err(ort_err)?;
        if data.len() != self.embed_model.dim {
            bail!(
                "embedding has {} values, models.toml says {}",
                data.len(),
                self.embed_model.dim
            );
        }
        Ok(normalised(data))
    }

    /// Multi-scale YuNet; boxes in the picture's pixels, best first by size.
    pub fn detect(&mut self, picture: &RgbImage) -> Result<Vec<Detection>> {
        let (w, h) = (picture.width(), picture.height());
        let mut all = Vec::new();
        let mut source = picture.clone();
        for Pass {
            long_edge,
            max_face,
            coarse,
        } in plan(w.max(h), self.config.detector_long_edge)
        {
            let (sw, sh) = fit_long_edge(w, h, long_edge);
            // Each pass reduces the previous one (cheaper than from full size).
            source = resize_rgb(&source, sw, sh, Filter::Bilinear)?;
            let min_score = if coarse {
                self.config.min_face_score.max(detect::COARSE_MIN_SCORE)
            } else {
                self.config.min_face_score
            };
            let found = self.detect_once(&source, min_score)?;
            let (fx, fy) = (w as f32 / sw as f32, h as f32 / sh as f32);
            all.extend(
                found
                    .into_iter()
                    .filter(|d| d.w.max(d.h) <= max_face)
                    .map(|d| d.scaled(fx, fy)),
            );
        }
        let mut kept = suppress(all, self.config.nms_iou, 0.8);
        kept.retain(|d| d.w.min(d.h) >= self.config.min_face_px);
        kept.sort_by(|a, b| {
            (b.w * b.h)
                .total_cmp(&(a.w * a.h))
                .then(a.x.total_cmp(&b.x))
                .then(a.y.total_cmp(&b.y))
        });
        kept.truncate(self.config.max_faces);
        kept.into_iter()
            .map(|face| self.refine(picture, face))
            .collect()
    }

    /// YuNet's landmarks follow the face's box but hardly its roll: on a head
    /// tilted 30° the eyes come back almost level, and the "aligned" crop
    /// stays tilted. So each face is looked at again in a small square around
    /// it, turned by a few angles; the best-scoring turn, corrected once more
    /// by the eye angle found there, shows the face upright, where the
    /// landmarks are accurate. They are mapped back to the picture.
    fn refine(&mut self, picture: &RgbImage, face: Detection) -> Result<Detection> {
        let centre = Point {
            x: face.x + face.w / 2.0,
            y: face.y + face.h / 2.0,
        };
        let side = face.w.max(face.h) * REFINE_CONTEXT;
        let mut best: Option<(f32, Similarity, Detection)> = None;
        let mut seen = Vec::new();
        for degrees in REFINE_ANGLES {
            let forward = rotated_square(centre, side, (degrees as f32).to_radians(), REFINE);
            let found = self.detect_centre(picture, &forward)?;
            seen.push((degrees, found.as_ref().map(|d| d.score)));
            if let Some(found) = found
                && best
                    .as_ref()
                    .is_none_or(|(score, _, _)| found.score > *score)
            {
                best = Some((found.score, forward, found));
            }
        }
        let Some((_, forward, found)) = best else {
            return Ok(face);
        };
        let back = |d: &Detection, f: &Similarity| d.landmarks.map(|p| f.invert(p));
        let angle = forward.b.atan2(forward.a) - eye_angle(&found.landmarks);
        // Upright already: the first pass's landmarks, found at a higher
        // resolution, are the better ones.
        if angle.abs() < UPRIGHT {
            return Ok(face);
        }
        let mut landmarks = back(&found, &forward);
        // Second look with the residual roll removed.
        let middle = Point {
            x: landmarks.iter().map(|p| p.x).sum::<f32>() / 5.0,
            y: landmarks.iter().map(|p| p.y).sum::<f32>() / 5.0,
        };
        let upright = rotated_square(middle, side, angle, REFINE);
        if let Some(again) = self.detect_centre(picture, &upright)? {
            landmarks = back(&again, &upright);
        }
        if std::env::var_os("LUGN_PHOTO_BRAIN_DEBUG").is_some() {
            eprintln!(
                "refine at ({:.0}, {:.0}): scores by angle {seen:?}, roll {:.0}°",
                centre.x,
                centre.y,
                -angle.to_degrees()
            );
        }
        Ok(Detection { landmarks, ..face })
    }

    /// The face nearest the middle of the `forward` view, if YuNet finds one.
    fn detect_centre(
        &mut self,
        picture: &RgbImage,
        forward: &Similarity,
    ) -> Result<Option<Detection>> {
        let rgb = sample(picture, forward, REFINE)?;
        let pixels: Vec<u8> = rgb
            .iter()
            .map(|v| v.round().clamp(0.0, 255.0) as u8)
            .collect();
        let view =
            RgbImage::from_raw(REFINE as u32, REFINE as u32, pixels).context("refinement view")?;
        let middle = REFINE as f32 / 2.0;
        Ok(self
            .detect_once(&view, REFINE_MIN_SCORE)?
            .into_iter()
            .filter(|d| {
                let (cx, cy) = (d.x + d.w / 2.0, d.y + d.h / 2.0);
                (cx - middle).abs() < middle / 2.0
                    && (cy - middle).abs() < middle / 2.0
                    && d.w.max(d.h) > middle / 3.0
            })
            .max_by(|a, b| a.score.total_cmp(&b.score)))
    }

    fn detect_once(&mut self, image: &RgbImage, min_score: f32) -> Result<Vec<Detection>> {
        let (w, h) = (image.width() as usize, image.height() as usize);
        let (pw, ph) = (padded(w as u32) as usize, padded(h as u32) as usize);
        // BGR, 0-255, picture at the top left of a black canvas.
        let plane = pw * ph;
        let mut input = vec![0.0f32; 3 * plane];
        for (i, p) in image.pixels().enumerate() {
            let (x, y) = (i % w, i / w);
            let to = y * pw + x;
            input[to] = p.0[2] as f32;
            input[plane + to] = p.0[1] as f32;
            input[2 * plane + to] = p.0[0] as f32;
        }
        let name = self.detector.inputs()[0].name().to_string();
        let tensor =
            TensorRef::from_array_view(([1usize, 3, ph, pw], &input[..])).map_err(ort_err)?;
        let outputs = self
            .detector
            .run(ort::inputs![name => tensor])
            .map_err(ort_err)?;
        let get = |name: String| -> Result<&[f32]> {
            let value = outputs
                .get(name.as_str())
                .with_context(|| format!("the detector has no output {name}"))?;
            Ok(value.try_extract_tensor::<f32>().map_err(ort_err)?.1)
        };
        let mut levels = Vec::with_capacity(3);
        for stride in detect::STRIDES {
            levels.push(Level {
                cls: get(format!("cls_{stride}"))?,
                obj: get(format!("obj_{stride}"))?,
                bbox: get(format!("bbox_{stride}"))?,
                kps: get(format!("kps_{stride}"))?,
            });
        }
        let levels: [Level<'_>; 3] = levels.try_into().map_err(|_| anyhow::anyhow!("levels"))?;
        Ok(detect::decode(&levels, pw, ph, min_score))
    }

    fn recognise(&mut self, crop: &align::Crop) -> Result<Vec<f32>> {
        let model = &self.face_model;
        let input = crop.tensor(model.order == ChannelOrder::Bgr, model.mean, model.std);
        let name = self.recogniser.inputs()[0].name().to_string();
        let tensor =
            TensorRef::from_array_view(([1usize, 3, CROP, CROP], &input[..])).map_err(ort_err)?;
        let outputs = self
            .recogniser
            .run(ort::inputs![name => tensor])
            .map_err(ort_err)?;
        let (_, data) = outputs[0].try_extract_tensor::<f32>().map_err(ort_err)?;
        if data.len() != model.dim {
            bail!(
                "face embedding has {} values, models.toml says {}",
                data.len(),
                model.dim
            );
        }
        Ok(normalised(data))
    }
}

impl PictureAnalyzer for Analyzer {
    fn model_ids(&self) -> &ModelIds {
        &self.ids
    }

    fn analyse(&mut self, path: &Path) -> Result<PictureAnalysis> {
        let t = Instant::now();
        let picture = decode::decode_file(path)?;
        self.last.decode = t.elapsed();
        self.analyse_picture(&picture.rgb)
    }
}

fn planar_normalised(image: &RgbImage, mean: [f32; 3], std: [f32; 3]) -> Vec<f32> {
    let plane = (image.width() * image.height()) as usize;
    let mut out = vec![0.0f32; 3 * plane];
    for (i, p) in image.pixels().enumerate() {
        for c in 0..3 {
            out[c * plane + i] = (p.0[c] as f32 / 255.0 - mean[c]) / std[c];
        }
    }
    out
}

pub fn normalised(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm = if norm > 0.0 { norm } else { 1.0 };
    v.iter().map(|x| x / norm).collect()
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn round4(v: f32) -> f32 {
    (v * 10000.0).round() / 10000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn siglip_preprocessing_is_squash_bilinear_and_half_mean_std() {
        let model = Manifest::parse(manifest::DEFAULT_MANIFEST)
            .unwrap()
            .embed_model()
            .clone();
        // A 2:1 picture, left half black, right half white.
        let picture = RgbImage::from_fn(800, 400, |x, _| {
            if x < 400 {
                image::Rgb([0, 0, 0])
            } else {
                image::Rgb([255, 255, 255])
            }
        });
        let input = Analyzer::embed_input(&model, &picture).unwrap();
        let size = model.size as usize;
        assert_eq!(input.len(), 3 * size * size);
        // Squashed, not cropped: the left edge is black (−1), the right white (+1),
        // and the boundary sits in the middle column.
        let at = |c: usize, x: usize, y: usize| input[c * size * size + y * size + x];
        assert_eq!(at(0, 0, 0), -1.0);
        assert_eq!(at(2, size - 1, size - 1), 1.0);
        assert!(at(1, size / 2 - 2, 10) < -0.9 && at(1, size / 2 + 1, 10) > 0.9);
    }

    #[test]
    fn normalised_has_unit_length() {
        let v = normalised(&[3.0, 4.0]);
        assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6);
        assert_eq!(normalised(&[0.0, 0.0]), vec![0.0, 0.0]);
    }
}
