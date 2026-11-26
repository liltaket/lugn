//! YuNet face detection: input layout, output decoding (the arithmetic of
//! OpenCV's `FaceDetectorYN`), non-maximum suppression and the multi-scale
//! plan. The model call itself lives in `mod.rs`; everything here is plain
//! numbers and tested as such.

/// A point in pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

/// One detection, in the pixels of the image it was found in (or, after
/// [`Detection::scaled`], of the original picture).
#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub score: f32,
    /// Right eye, left eye (the subject's; right eye is on the image's left),
    /// nose tip, right and left mouth corner.
    pub landmarks: [Point; 5],
}

impl Detection {
    pub fn scaled(&self, sx: f32, sy: f32) -> Detection {
        Detection {
            x: self.x * sx,
            y: self.y * sy,
            w: self.w * sx,
            h: self.h * sy,
            score: self.score,
            landmarks: self.landmarks.map(|p| Point {
                x: p.x * sx,
                y: p.y * sy,
            }),
        }
    }
    fn area(&self) -> f32 {
        self.w.max(0.0) * self.h.max(0.0)
    }
}

pub const STRIDES: [usize; 3] = [8, 16, 32];

/// Padded input size: YuNet's strides need multiples of 32.
pub fn padded(n: u32) -> u32 {
    n.div_ceil(32) * 32
}

/// The 12 output tensors for one stride level, as flat slices.
pub struct Level<'a> {
    pub cls: &'a [f32],
    pub obj: &'a [f32],
    pub bbox: &'a [f32],
    pub kps: &'a [f32],
}

/// Decodes the three stride levels of a `pad_w` x `pad_h` input.
pub fn decode(
    levels: &[Level<'_>; 3],
    pad_w: usize,
    pad_h: usize,
    min_score: f32,
) -> Vec<Detection> {
    let mut out = Vec::new();
    for (level, stride) in levels.iter().zip(STRIDES) {
        let cols = pad_w / stride;
        let rows = pad_h / stride;
        let count = rows * cols;
        if level.cls.len() < count
            || level.obj.len() < count
            || level.bbox.len() < count * 4
            || level.kps.len() < count * 10
        {
            continue;
        }
        let s = stride as f32;
        for row in 0..rows {
            for col in 0..cols {
                let i = row * cols + col;
                let score = (level.cls[i].clamp(0.0, 1.0) * level.obj[i].clamp(0.0, 1.0)).sqrt();
                if score < min_score {
                    continue;
                }
                let b = &level.bbox[i * 4..i * 4 + 4];
                let cx = (col as f32 + b[0]) * s;
                let cy = (row as f32 + b[1]) * s;
                let w = b[2].exp() * s;
                let h = b[3].exp() * s;
                let k = &level.kps[i * 10..i * 10 + 10];
                let landmarks = std::array::from_fn(|n| Point {
                    x: (k[n * 2] + col as f32) * s,
                    y: (k[n * 2 + 1] + row as f32) * s,
                });
                out.push(Detection {
                    x: cx - w / 2.0,
                    y: cy - h / 2.0,
                    w,
                    h,
                    score,
                    landmarks,
                });
            }
        }
    }
    out
}

fn overlap(a: &Detection, b: &Detection) -> f32 {
    let left = a.x.max(b.x);
    let top = a.y.max(b.y);
    let right = (a.x + a.w).min(b.x + b.w);
    let bottom = (a.y + a.h).min(b.y + b.h);
    (right - left).max(0.0) * (bottom - top).max(0.0)
}

pub fn iou(a: &Detection, b: &Detection) -> f32 {
    let inter = overlap(a, b);
    let union = a.area() + b.area() - inter;
    if union <= 0.0 { 0.0 } else { inter / union }
}

/// Greedy NMS by score: a box is dropped when its IoU with a kept box exceeds
/// `iou_threshold`, or when at least `contained` of its own area lies inside a
/// kept box (a face found again as a part of a bigger face at another scale).
pub fn suppress(mut faces: Vec<Detection>, iou_threshold: f32, contained: f32) -> Vec<Detection> {
    faces.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for face in faces {
        let clash = kept.iter().any(|other| {
            iou(&face, other) > iou_threshold
                || (face.area() > 0.0 && overlap(&face, other) / face.area() >= contained)
        });
        if !clash {
            kept.push(face);
        }
    }
    kept
}

/// One detector pass: the picture scaled so its long edge is `long_edge`, and
/// the largest face (in that pass's pixels) the pass is trusted with. YuNet is
/// trained on faces of about 10-300 px; bigger faces are left to a smaller
/// pass, which sees them in range (each pass keeps faces up to 160 px, half
/// of the trained maximum, where YuNet is reliable). The coarse passes only look for big faces,
/// which YuNet scores above 0.9 when real, so they need [`COARSE_MIN_SCORE`]:
/// at 320 px a helmet or a knee can reach 0.67.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pass {
    pub long_edge: u32,
    pub max_face: f32,
    pub coarse: bool,
}

pub const COARSE_MIN_SCORE: f32 = 0.8;

/// Passes for a picture with long edge `long`: the main pass at `main` px (or
/// the picture's own size if smaller), then 640 and 320 for big faces.
pub fn plan(long: u32, main: u32) -> Vec<Pass> {
    const TRUSTED: f32 = 160.0;
    let mut edges = vec![long.min(main)];
    for edge in [640, 320] {
        if edge < *edges.last().unwrap() {
            edges.push(edge);
        }
    }
    let last = edges.len() - 1;
    edges
        .into_iter()
        .enumerate()
        .map(|(i, long_edge)| Pass {
            long_edge,
            max_face: if i == last { f32::INFINITY } else { TRUSTED },
            coarse: i > 0,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn det(x: f32, y: f32, w: f32, h: f32, score: f32) -> Detection {
        Detection {
            x,
            y,
            w,
            h,
            score,
            landmarks: [Point { x: 0.0, y: 0.0 }; 5],
        }
    }

    #[test]
    fn nms_keeps_best_of_overlapping_and_separate_boxes() {
        let faces = vec![
            det(0.0, 0.0, 10.0, 10.0, 0.8),
            det(1.0, 1.0, 10.0, 10.0, 0.9), // IoU 0.68 with the first
            det(50.0, 50.0, 10.0, 10.0, 0.7),
            det(6.0, 1.0, 10.0, 10.0, 0.75), // IoU 0.33 with the best: kept at 0.4
        ];
        let kept = suppress(faces, 0.4, 1.1);
        let scores: Vec<f32> = kept.iter().map(|d| d.score).collect();
        assert_eq!(scores, vec![0.9, 0.75, 0.7]);
    }

    #[test]
    fn nms_drops_a_box_inside_a_better_one() {
        let faces = vec![
            det(0.0, 0.0, 100.0, 100.0, 0.9),
            det(20.0, 20.0, 20.0, 20.0, 0.8),
        ];
        assert_eq!(suppress(faces.clone(), 0.4, 0.8).len(), 1);
        assert_eq!(suppress(faces, 0.4, 1.1).len(), 2);
    }

    #[test]
    fn decode_one_anchor() {
        // 64 x 32 input: stride 8 → 8 x 4 cells; put a face at cell (row 1, col 2).
        let (w, h) = (64usize, 32usize);
        let mk = |stride: usize| {
            let n = (w / stride) * (h / stride);
            (
                vec![0.0f32; n],
                vec![0.0f32; n],
                vec![0.0f32; n * 4],
                vec![0.0f32; n * 10],
            )
        };
        let (mut cls, mut obj, mut bbox, mut kps) = mk(8);
        let i = 8 + 2;
        cls[i] = 0.81;
        obj[i] = 1.0;
        bbox[i * 4..i * 4 + 4].copy_from_slice(&[0.5, 0.5, 0.0, (2.0f32).ln()]);
        for n in 0..5 {
            kps[i * 10 + n * 2] = 0.1 * n as f32;
            kps[i * 10 + n * 2 + 1] = 0.5;
        }
        let l16 = mk(16);
        let l32 = mk(32);
        let levels = [
            Level {
                cls: &cls,
                obj: &obj,
                bbox: &bbox,
                kps: &kps,
            },
            Level {
                cls: &l16.0,
                obj: &l16.1,
                bbox: &l16.2,
                kps: &l16.3,
            },
            Level {
                cls: &l32.0,
                obj: &l32.1,
                bbox: &l32.2,
                kps: &l32.3,
            },
        ];
        let found = decode(&levels, w, h, 0.5);
        assert_eq!(found.len(), 1);
        let d = &found[0];
        assert!((d.score - 0.9).abs() < 1e-6);
        // centre (2.5 × 8, 1.5 × 8) = (20, 12); w 8, h 16
        assert!((d.x - 16.0).abs() < 1e-4 && (d.y - 4.0).abs() < 1e-4);
        assert!((d.w - 8.0).abs() < 1e-4 && (d.h - 16.0).abs() < 1e-4);
        assert!((d.landmarks[3].x - (0.3 + 2.0) * 8.0).abs() < 1e-4);
        assert!((d.landmarks[3].y - 12.0).abs() < 1e-4);
        assert!(decode(&levels, w, h, 0.95).is_empty());
    }

    #[test]
    fn plan_scales() {
        assert_eq!(
            plan(4032, 1600),
            vec![
                Pass {
                    long_edge: 1600,
                    max_face: 160.0,
                    coarse: false
                },
                Pass {
                    long_edge: 640,
                    max_face: 160.0,
                    coarse: true
                },
                Pass {
                    long_edge: 320,
                    max_face: f32::INFINITY,
                    coarse: true
                },
            ]
        );
        assert_eq!(plan(500, 1600).len(), 2);
        assert_eq!(
            plan(300, 1600),
            vec![Pass {
                long_edge: 300,
                max_face: f32::INFINITY,
                coarse: false
            }]
        );
        assert_eq!(padded(1200), 1216);
        assert_eq!(padded(1600), 1600);
    }
}
