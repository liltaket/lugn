//! Whole-picture sharpness and darkness.
//!
//! - `sharp`: variance of the Laplacian of the luminance, measured on a copy
//!   whose long edge is [`SHARP_LONG_EDGE`] px (so the number does not depend
//!   on the camera's resolution), mapped logarithmically:
//!   `sharp = 50 × (log10(var) − 1)`, clamped to 0-100. Variance 10 (very
//!   soft) → 0, 100 → 50, 1000 (crisp, detailed) → 100.
//! - `dark`: from the luminance median and 90th percentile,
//!   `b = (p50 + p90) / 2`, `dark = 100 × (128 − b) / 128` clamped to 0-100:
//!   an ordinary daylight picture is 0, a dim room about 30, a night shot 60-80,
//!   a black frame about 100.

use anyhow::Result;
use image::RgbImage;

use super::imageops::{fit_long_edge, laplacian_variance, luma, resize_gray};
use crate::analysis::PictureQuality;

pub const SHARP_LONG_EDGE: u32 = 768;

pub fn measure(rgb: &RgbImage) -> Result<PictureQuality> {
    let gray = luma(rgb);
    let (w, h) = fit_long_edge(gray.width(), gray.height(), SHARP_LONG_EDGE);
    let small = resize_gray(&gray, w, h)?;
    let values: Vec<f32> = small.as_raw().iter().map(|&v| v as f32).collect();
    let var = laplacian_variance(&values, w as usize, h as usize);
    Ok(PictureQuality {
        sharp: sharp_from_variance(var),
        dark: dark_from_luma(small.as_raw()),
    })
}

pub fn sharp_from_variance(var: f64) -> f32 {
    if var <= 0.0 {
        return 0.0;
    }
    (50.0 * (var.log10() - 1.0)).clamp(0.0, 100.0) as f32
}

pub fn dark_from_luma(values: &[u8]) -> f32 {
    if values.is_empty() {
        return 100.0;
    }
    let mut histogram = [0usize; 256];
    for &v in values {
        histogram[v as usize] += 1;
    }
    let percentile = |p: f64| -> f64 {
        let target = (p * values.len() as f64).ceil().max(1.0) as usize;
        let mut seen = 0;
        for (value, count) in histogram.iter().enumerate() {
            seen += count;
            if seen >= target {
                return value as f64;
            }
        }
        255.0
    };
    let b = (percentile(0.5) + percentile(0.9)) / 2.0;
    (100.0 * (128.0 - b) / 128.0).clamp(0.0, 100.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sharp_mapping() {
        assert_eq!(sharp_from_variance(0.0), 0.0);
        assert_eq!(sharp_from_variance(10.0), 0.0);
        assert!((sharp_from_variance(100.0) - 50.0).abs() < 1e-4);
        assert_eq!(sharp_from_variance(1e6), 100.0);
    }

    #[test]
    fn dark_mapping() {
        assert_eq!(dark_from_luma(&[0; 100]), 100.0);
        assert_eq!(dark_from_luma(&[200; 100]), 0.0);
        assert!((dark_from_luma(&[64; 100]) - 50.0).abs() < 1e-4);
    }

    /// Detail is sharper than the same detail blurred; flat is not sharp.
    #[test]
    fn blur_lowers_sharpness() {
        let detail = RgbImage::from_fn(1024, 768, |x, y| {
            let v = (((x / 3) ^ (y / 5)) % 7 * 36) as u8;
            image::Rgb([v, v, v])
        });
        let blurred = image::imageops::blur(&detail, 4.0);
        let flat = RgbImage::from_pixel(1024, 768, image::Rgb([90, 90, 90]));
        let s = measure(&detail).unwrap().sharp;
        let b = measure(&blurred).unwrap().sharp;
        let f = measure(&flat).unwrap().sharp;
        assert!(s > 80.0, "{s}");
        assert!(b < s - 30.0, "{b} vs {s}");
        assert_eq!(f, 0.0);
        assert!(measure(&flat).unwrap().dark > 25.0);
    }
}
