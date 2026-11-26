//! Small image operations: resizing (SIMD, antialiased like PIL), luminance
//! and the Laplacian.

use anyhow::{Context, Result};
use fast_image_resize::{FilterType, ResizeAlg, ResizeOptions, Resizer};
use image::{GrayImage, RgbImage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    /// Triangle filter widened by the scale factor: PIL's `BILINEAR`, which is
    /// what Hugging Face image processors use with `resample = 2`.
    Bilinear,
    /// Area average (best for big reductions of the detector input).
    Box,
}

/// Resizes to exactly `width` x `height` (aspect ratio not kept).
pub fn resize_rgb(src: &RgbImage, width: u32, height: u32, filter: Filter) -> Result<RgbImage> {
    if src.width() == width && src.height() == height {
        return Ok(src.clone());
    }
    let mut dst = RgbImage::new(width.max(1), height.max(1));
    let alg = match filter {
        Filter::Bilinear => ResizeAlg::Convolution(FilterType::Bilinear),
        Filter::Box => ResizeAlg::Convolution(FilterType::Box),
    };
    Resizer::new()
        .resize(src, &mut dst, &ResizeOptions::new().resize_alg(alg))
        .context("resizing")?;
    Ok(dst)
}

pub fn resize_gray(src: &GrayImage, width: u32, height: u32) -> Result<GrayImage> {
    if src.width() == width && src.height() == height {
        return Ok(src.clone());
    }
    let mut dst = GrayImage::new(width.max(1), height.max(1));
    Resizer::new()
        .resize(
            src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Box)),
        )
        .context("resizing")?;
    Ok(dst)
}

/// Size with the long edge scaled to `long_edge` (never enlarged).
pub fn fit_long_edge(width: u32, height: u32, long_edge: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= long_edge || long == 0 {
        return (width, height);
    }
    let scale = long_edge as f64 / long as f64;
    (
        ((width as f64 * scale).round() as u32).max(1),
        ((height as f64 * scale).round() as u32).max(1),
    )
}

/// Rec. 601 luma, 0-255.
pub fn luma(rgb: &RgbImage) -> GrayImage {
    GrayImage::from_fn(rgb.width(), rgb.height(), |x, y| {
        let [r, g, b] = rgb.get_pixel(x, y).0;
        let y = (299 * r as u32 + 587 * g as u32 + 114 * b as u32 + 500) / 1000;
        image::Luma([y as u8])
    })
}

/// Variance of the 4-neighbour Laplacian over the interior pixels, on 0-255
/// values (OpenCV's `Laplacian(ksize=1).var()`).
pub fn laplacian_variance(values: &[f32], width: usize, height: usize) -> f64 {
    if width < 3 || height < 3 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut sum2 = 0.0f64;
    let mut n = 0usize;
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let i = y * width + x;
            let l = values[i - 1] + values[i + 1] + values[i - width] + values[i + width]
                - 4.0 * values[i];
            let l = l as f64;
            sum += l;
            sum2 += l * l;
            n += 1;
        }
    }
    let mean = sum / n as f64;
    (sum2 / n as f64 - mean * mean).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_edge_fit_keeps_aspect_and_never_enlarges() {
        assert_eq!(fit_long_edge(4032, 3024, 1600), (1600, 1200));
        assert_eq!(fit_long_edge(3024, 4032, 768), (576, 768));
        assert_eq!(fit_long_edge(640, 480, 1600), (640, 480));
    }

    #[test]
    fn laplacian_of_flat_and_ramp_is_zero_and_of_checkerboard_is_large() {
        let flat = vec![100.0; 16 * 16];
        assert_eq!(laplacian_variance(&flat, 16, 16), 0.0);
        let ramp: Vec<f32> = (0..16 * 16).map(|i| (i % 16) as f32 * 10.0).collect();
        assert!(laplacian_variance(&ramp, 16, 16) < 1e-6);
        let checker: Vec<f32> = (0..16 * 16)
            .map(|i| {
                if (i % 16 + i / 16) % 2 == 0 {
                    0.0
                } else {
                    255.0
                }
            })
            .collect();
        // Each interior value is ±4 × 255 → variance (1020)².
        let v = laplacian_variance(&checker, 16, 16);
        assert!((v - 1020.0f64.powi(2)).abs() < 1.0, "{v}");
    }

    #[test]
    fn bilinear_resize_of_uniform_image_is_uniform() {
        let src = RgbImage::from_pixel(37, 23, image::Rgb([10, 128, 250]));
        let out = resize_rgb(&src, 16, 16, Filter::Bilinear).unwrap();
        assert!(out.pixels().all(|p| p.0 == [10, 128, 250]));
    }

    #[test]
    fn luma_weights() {
        let rgb = RgbImage::from_fn(3, 1, |x, _| match x {
            0 => image::Rgb([255, 0, 0]),
            1 => image::Rgb([0, 255, 0]),
            _ => image::Rgb([0, 0, 255]),
        });
        let l = luma(&rgb);
        assert_eq!(l.as_raw(), &vec![76, 150, 29]);
    }
}
