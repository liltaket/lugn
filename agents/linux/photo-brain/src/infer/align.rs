//! Face geometry: the 5-point similarity alignment to the ArcFace template,
//! the aligned 112 x 112 crop, how frontal a face is, and its quality score.

use anyhow::Result;
use image::RgbImage;

use super::detect::Point;
use super::imageops::{Filter, laplacian_variance, resize_rgb};

pub const CROP: usize = 112;

/// The five points of an upright 112 x 112 ArcFace crop (InsightFace's
/// `arcface_dst`): right eye, left eye, nose, right and left mouth corner.
pub const TEMPLATE: [Point; 5] = [
    Point {
        x: 38.2946,
        y: 51.6963,
    },
    Point {
        x: 73.5318,
        y: 51.5014,
    },
    Point {
        x: 56.0252,
        y: 71.7366,
    },
    Point {
        x: 41.5493,
        y: 92.3655,
    },
    Point {
        x: 70.7299,
        y: 92.2041,
    },
];

/// x' = a·x − b·y + tx, y' = b·x + a·y + ty (scale, rotation, shift).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Similarity {
    pub a: f32,
    pub b: f32,
    pub tx: f32,
    pub ty: f32,
}

impl Similarity {
    pub fn apply(&self, p: Point) -> Point {
        Point {
            x: self.a * p.x - self.b * p.y + self.tx,
            y: self.b * p.x + self.a * p.y + self.ty,
        }
    }
    pub fn invert(&self, p: Point) -> Point {
        let s = self.a * self.a + self.b * self.b;
        let dx = p.x - self.tx;
        let dy = p.y - self.ty;
        Point {
            x: (self.a * dx + self.b * dy) / s,
            y: (-self.b * dx + self.a * dy) / s,
        }
    }
    pub fn scale(&self) -> f32 {
        (self.a * self.a + self.b * self.b).sqrt()
    }
}

/// Least-squares similarity transform mapping `from` onto `to` (Umeyama 1991
/// restricted to 2-D rotation + uniform scale, no reflection).
pub fn fit_similarity(from: &[Point], to: &[Point]) -> Similarity {
    let n = from.len().min(to.len()) as f64;
    let mean = |pts: &[Point]| {
        let (sx, sy) = pts.iter().fold((0.0f64, 0.0f64), |(x, y), p| {
            (x + p.x as f64, y + p.y as f64)
        });
        (sx / n, sy / n)
    };
    let (fx, fy) = mean(from);
    let (tx, ty) = mean(to);
    let (mut num_a, mut num_b, mut den) = (0.0f64, 0.0f64, 0.0f64);
    for (p, q) in from.iter().zip(to) {
        let (px, py) = (p.x as f64 - fx, p.y as f64 - fy);
        let (qx, qy) = (q.x as f64 - tx, q.y as f64 - ty);
        num_a += px * qx + py * qy;
        num_b += px * qy - py * qx;
        den += px * px + py * py;
    }
    if den == 0.0 {
        return Similarity {
            a: 1.0,
            b: 0.0,
            tx: 0.0,
            ty: 0.0,
        };
    }
    let a = num_a / den;
    let b = num_b / den;
    Similarity {
        a: a as f32,
        b: b as f32,
        tx: (tx - (a * fx - b * fy)) as f32,
        ty: (ty - (b * fx + a * fy)) as f32,
    }
}

/// An aligned crop: interleaved RGB, 112 x 112, values 0-255.
pub struct Crop {
    pub rgb: Vec<f32>,
}

impl Crop {
    /// Variance of the Laplacian of the crop's luminance.
    pub fn sharpness(&self) -> f64 {
        let gray: Vec<f32> = self
            .rgb
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2])
            .collect();
        laplacian_variance(&gray, CROP, CROP)
    }

    /// Planar NCHW input for a recogniser: (value − mean) / std, in `order`.
    pub fn tensor(&self, bgr: bool, mean: f32, std: f32) -> Vec<f32> {
        let plane = CROP * CROP;
        let mut out = vec![0.0f32; 3 * plane];
        for (i, p) in self.rgb.as_chunks::<3>().0.iter().enumerate() {
            for c in 0..3 {
                let source = if bgr { 2 - c } else { c };
                out[c * plane + i] = (p[source] - mean) / std;
            }
        }
        out
    }
}

/// Cuts the aligned crop out of the upright picture.
pub fn aligned_crop(picture: &RgbImage, landmarks: &[Point; 5]) -> Result<Crop> {
    let forward = fit_similarity(landmarks, &TEMPLATE);
    Ok(Crop {
        rgb: sample(picture, &forward, CROP)?,
    })
}

/// The `size` x `size` image `forward` maps the picture onto (interleaved RGB,
/// 0-255, grey outside the picture). A region much bigger than the output is
/// first reduced with an antialiasing filter, so a 600 px face is not aliased
/// the way plain bilinear sampling would alias it.
pub fn sample(picture: &RgbImage, forward: &Similarity, size: usize) -> Result<Vec<f32>> {
    if forward.scale() >= 0.75 {
        return Ok(warp(picture, forward, size));
    }
    // Source region the output samples from.
    let n = size as f32;
    let corners =
        [(0.0, 0.0), (n, 0.0), (0.0, n), (n, n)].map(|(x, y)| forward.invert(Point { x, y }));
    let (w, h) = (picture.width() as f32, picture.height() as f32);
    let fold = |f: fn(&Point) -> f32, min: bool| {
        corners.iter().map(f).fold(
            if min { f32::MAX } else { f32::MIN },
            if min { f32::min } else { f32::max },
        )
    };
    let x0 = fold(|p| p.x, true).floor().max(0.0);
    let y0 = fold(|p| p.y, true).floor().max(0.0);
    let x1 = fold(|p| p.x, false).ceil().min(w);
    let y1 = fold(|p| p.y, false).ceil().min(h);
    if x1 - x0 < 2.0 || y1 - y0 < 2.0 {
        return Ok(warp(picture, forward, size));
    }
    let region = image::imageops::crop_imm(
        picture,
        x0 as u32,
        y0 as u32,
        (x1 - x0) as u32,
        (y1 - y0) as u32,
    )
    .to_image();
    // Reduce so the remaining warp scale is about 0.9.
    let factor = forward.scale() / 0.9;
    let rw = ((region.width() as f32 * factor).round() as u32).max(2);
    let rh = ((region.height() as f32 * factor).round() as u32).max(2);
    let reduced = resize_rgb(&region, rw, rh, Filter::Bilinear)?;
    let fx = rw as f32 / region.width() as f32;
    let fy = rh as f32 / region.height() as f32;
    // forward' = forward ∘ (reduced → picture), with reduced → picture:
    // p = q / f + offset (f ≈ fx ≈ fy).
    let f = (fx + fy) / 2.0;
    let shifted = Similarity {
        a: forward.a / f,
        b: forward.b / f,
        tx: forward.a * x0 - forward.b * y0 + forward.tx,
        ty: forward.b * x0 + forward.a * y0 + forward.ty,
    };
    Ok(warp(&reduced, &shifted, size))
}

/// Bilinear sampling of the `size` x `size` output; outside the picture is grey.
fn warp(picture: &RgbImage, forward: &Similarity, size: usize) -> Vec<f32> {
    let (width, height) = (picture.width() as i64, picture.height() as i64);
    let raw = picture.as_raw();
    let mut rgb = vec![128.0f32; size * size * 3];
    for y in 0..size {
        for x in 0..size {
            let s = forward.invert(Point {
                x: x as f32,
                y: y as f32,
            });
            if s.x < 0.0 || s.y < 0.0 || s.x > (width - 1) as f32 || s.y > (height - 1) as f32 {
                continue;
            }
            let x0 = s.x.floor() as i64;
            let y0 = s.y.floor() as i64;
            let x1 = (x0 + 1).min(width - 1);
            let y1 = (y0 + 1).min(height - 1);
            let fx = s.x - x0 as f32;
            let fy = s.y - y0 as f32;
            let at = |xx: i64, yy: i64, c: usize| raw[((yy * width + xx) * 3) as usize + c] as f32;
            for c in 0..3 {
                let top = at(x0, y0, c) * (1.0 - fx) + at(x1, y0, c) * fx;
                let bottom = at(x0, y1, c) * (1.0 - fx) + at(x1, y1, c) * fx;
                rgb[(y * size + x) * 3 + c] = top * (1.0 - fy) + bottom * fy;
            }
        }
    }
    rgb
}

/// Maps a square of side `side` source pixels centred on `centre`, rotated
/// by `angle` radians (the content turns by `angle`: positive is clockwise on
/// screen, since y points down), onto a `size` x `size` output.
pub fn rotated_square(centre: Point, side: f32, angle: f32, size: usize) -> Similarity {
    let s = size as f32 / side;
    let (sin, cos) = angle.sin_cos();
    let (a, b) = (s * cos, s * sin);
    let half = size as f32 / 2.0;
    Similarity {
        a,
        b,
        tx: half - (a * centre.x - b * centre.y),
        ty: half - (b * centre.x + a * centre.y),
    }
}

/// Angle of the eye axis (right eye → left eye), radians, y down.
pub fn eye_angle(landmarks: &[Point; 5]) -> f32 {
    (landmarks[1].y - landmarks[0].y).atan2(landmarks[1].x - landmarks[0].x)
}

/// How frontal a face is, 0 (profile) to 1 (straight on), independent of roll:
/// the nose's offset from the eyes' midpoint measured ALONG the eye axis, as a
/// fraction of the eye distance. A frontal face has the nose on the
/// perpendicular bisector of the eyes; turning the head slides it toward one
/// eye. Tilting the head (roll) rotates the whole pattern and changes nothing.
pub fn frontalness(landmarks: &[Point; 5]) -> f32 {
    let [right_eye, left_eye, nose, ..] = *landmarks;
    let ex = left_eye.x - right_eye.x;
    let ey = left_eye.y - right_eye.y;
    let span2 = ex * ex + ey * ey;
    if span2 < 1.0 {
        return 0.0;
    }
    let mx = (left_eye.x + right_eye.x) / 2.0;
    let my = (left_eye.y + right_eye.y) / 2.0;
    let offset = ((nose.x - mx) * ex + (nose.y - my) * ey) / span2;
    (1.0 - 2.2 * offset.abs()).clamp(0.0, 1.0)
}

/// Usefulness for recognition, 0-100:
/// `100 × size × (0.35 + 0.65·sharp) × (0.3 + 0.7·front) × (0.5 + 0.5·conf)`
/// - size: short side of the box in the original picture's pixels, 24 px → 0,
///   112 px (the recogniser's own resolution) or more → 1, linear between;
/// - sharp: Laplacian variance `v` of the aligned crop, `log10(v)` from 1.3
///   (v = 20, mush) → 0 to 2.7 (v = 500, crisp) → 1;
/// - front: [`frontalness`];
/// - conf: detector score, 0.5 → 0 to 1.0 → 1.
pub fn face_quality(short_side_px: f32, crop_laplacian_var: f64, front: f32, score: f32) -> f32 {
    let size = ((short_side_px - 24.0) / (112.0 - 24.0)).clamp(0.0, 1.0);
    let sharp = if crop_laplacian_var > 0.0 {
        ((crop_laplacian_var.log10() - 1.3) / 1.4).clamp(0.0, 1.0) as f32
    } else {
        0.0
    };
    let conf = ((score - 0.5) / 0.5).clamp(0.0, 1.0);
    100.0 * size * (0.35 + 0.65 * sharp) * (0.3 + 0.7 * front.clamp(0.0, 1.0)) * (0.5 + 0.5 * conf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32, tol: f32) -> bool {
        (a - b).abs() <= tol
    }

    /// Landmarks made by a known similarity from the template are mapped back
    /// onto it exactly.
    #[test]
    fn recovers_a_known_transform() {
        let (scale, angle, shift) = (3.7f32, 0.6f32, Point { x: 812.0, y: -40.0 });
        let truth = Similarity {
            a: scale * angle.cos(),
            b: scale * angle.sin(),
            tx: shift.x,
            ty: shift.y,
        };
        let landmarks = TEMPLATE.map(|p| truth.apply(p));
        let fitted = fit_similarity(&landmarks, &TEMPLATE);
        assert!(close(fitted.scale(), 1.0 / scale, 1e-4));
        for (p, q) in landmarks.iter().zip(TEMPLATE) {
            let mapped = fitted.apply(*p);
            assert!(
                close(mapped.x, q.x, 1e-2) && close(mapped.y, q.y, 1e-2),
                "{mapped:?} {q:?}"
            );
        }
        let back = fitted.invert(fitted.apply(Point { x: 5.0, y: 9.0 }));
        assert!(close(back.x, 5.0, 1e-3) && close(back.y, 9.0, 1e-3));
    }

    /// A picture that IS the template (marked pixels at the landmarks) crops to
    /// itself; a 4× bigger, rotated copy crops to the same picture.
    #[test]
    fn crop_of_scaled_rotated_face_matches() {
        let face = RgbImage::from_fn(CROP as u32, CROP as u32, |x, y| {
            let v = ((x as f32 / 9.0).sin() * 60.0 + (y as f32 / 13.0).cos() * 60.0 + 128.0) as u8;
            image::Rgb([v, 255 - v, (x * 2) as u8])
        });
        let identity = aligned_crop(&face, &TEMPLATE).unwrap();
        let direct: Vec<f32> = face.as_raw().iter().map(|&v| v as f32).collect();
        let err: f32 = identity
            .rgb
            .iter()
            .zip(&direct)
            .map(|(a, b)| (a - b).abs())
            .sum::<f32>()
            / direct.len() as f32;
        assert!(err < 0.5, "identity crop error {err}");

        // 4× larger and rotated 90°: big = rot90(scale4(face)).
        let scaled =
            image::imageops::resize(&face, 448, 448, image::imageops::FilterType::Triangle);
        let rotated = image::imageops::rotate90(&scaled);
        // rotate90 maps (x, y) → (H − 1 − y, x) in a 448 x 448 image.
        let landmarks = TEMPLATE.map(|p| {
            let (sx, sy) = (p.x * 4.0 + 1.5, p.y * 4.0 + 1.5);
            Point {
                x: 447.0 - sy,
                y: sx,
            }
        });
        let crop = aligned_crop(&rotated, &landmarks).unwrap();
        // Compare the interior (edges see the grey border).
        let mut err = 0.0f32;
        let mut n = 0;
        for y in 8..CROP - 8 {
            for x in 8..CROP - 8 {
                for c in 0..3 {
                    err +=
                        (crop.rgb[(y * CROP + x) * 3 + c] - direct[(y * CROP + x) * 3 + c]).abs();
                    n += 1;
                }
            }
        }
        let err = err / n as f32;
        assert!(err < 6.0, "rotated crop error {err}");
    }

    #[test]
    fn frontalness_ignores_roll() {
        let upright = TEMPLATE;
        let f0 = frontalness(&upright);
        assert!(f0 > 0.9, "{f0}");
        // Same face rolled by 40°: the raw-x version of this measure would drop.
        let roll = Similarity {
            a: 0.766,
            b: 0.643,
            tx: 10.0,
            ty: 3.0,
        };
        let rolled = upright.map(|p| roll.apply(p));
        assert!(close(frontalness(&rolled), f0, 1e-3));
        // Nose slid toward one eye (a turned head) → lower, also when rolled.
        let mut turned = upright;
        turned[2].x += 14.0;
        let ft = frontalness(&turned);
        assert!(ft < 0.25, "{ft}");
        assert!(close(frontalness(&turned.map(|p| roll.apply(p))), ft, 1e-3));
    }

    #[test]
    fn tensor_layout_and_normalisation() {
        let mut rgb = vec![0.0f32; CROP * CROP * 3];
        rgb[0] = 255.0; // pixel 0 red
        let crop = Crop { rgb };
        let t = crop.tensor(false, 127.5, 127.5);
        assert_eq!(t[0], 1.0);
        assert_eq!(t[CROP * CROP], -1.0);
        let t = crop.tensor(true, 0.0, 1.0);
        assert_eq!(t[2 * CROP * CROP], 255.0);
        assert_eq!(t[0], 0.0);
    }

    #[test]
    fn quality_rises_with_size_sharpness_and_pose() {
        let small = face_quality(30.0, 300.0, 0.9, 0.9);
        let big = face_quality(150.0, 300.0, 0.9, 0.9);
        let blurred = face_quality(150.0, 15.0, 0.9, 0.9);
        let profile = face_quality(150.0, 300.0, 0.0, 0.9);
        assert!(big > small && big > blurred && big > profile);
        assert_eq!(face_quality(20.0, 300.0, 1.0, 1.0), 0.0);
        assert!(face_quality(200.0, 1e4, 1.0, 1.0) > 99.0);
    }
}
