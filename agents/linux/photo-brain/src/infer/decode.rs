//! Decoding a picture file into an upright 8-bit RGB image.
//!
//! Orientation is applied exactly once:
//! - HEIC/HEIF: libheif applies the container's `irot`/`imir`/`clap`
//!   transformations while decoding (its default). The EXIF orientation tag in
//!   an iPhone HEIC describes the same rotation and must NOT be applied again
//!   (HEIF spec, ISO/IEC 23008-12 §6.5.10 note; libheif documents the same).
//! - JPEG/PNG: the decoded pixels are stored unrotated; the EXIF orientation
//!   tag is applied here.

use std::path::Path;

use anyhow::{Context, Result, bail};
use image::{DynamicImage, ImageDecoder, ImageReader, RgbImage};

/// The upright picture.
pub struct Picture {
    pub rgb: RgbImage,
}

impl Picture {
    pub fn width(&self) -> u32 {
        self.rgb.width()
    }
    pub fn height(&self) -> u32 {
        self.rgb.height()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Heif,
    Other,
}

/// HEIF family by its `ftyp` box (`heic`, `heix`, `mif1`, …).
pub fn sniff(head: &[u8]) -> Format {
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        let brand = &head[8..12];
        const HEIF: [&[u8; 4]; 9] = [
            b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1", b"avif",
        ];
        if HEIF.iter().any(|b| &b[..] == brand) {
            return Format::Heif;
        }
    }
    Format::Other
}

pub fn decode_file(path: &Path) -> Result<Picture> {
    let bytes = std::fs::read(path).with_context(|| path.display().to_string())?;
    decode_bytes(&bytes).with_context(|| path.display().to_string())
}

pub fn decode_bytes(bytes: &[u8]) -> Result<Picture> {
    match sniff(bytes) {
        Format::Heif => decode_heif(bytes),
        Format::Other => decode_image(bytes),
    }
}

fn decode_image(bytes: &[u8]) -> Result<Picture> {
    let reader = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .context("reading the picture")?;
    let mut decoder = reader
        .into_decoder()
        .context("unsupported picture format")?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut picture = DynamicImage::from_decoder(decoder).context("decoding the picture")?;
    picture.apply_orientation(orientation);
    Ok(Picture {
        rgb: picture.into_rgb8(),
    })
}

fn decode_heif(bytes: &[u8]) -> Result<Picture> {
    use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};
    let lib = LibHeif::new();
    let context = HeifContext::read_from_bytes(bytes).context("reading the HEIF container")?;
    let handle = context
        .primary_image_handle()
        .context("the HEIF file has no primary picture")?;
    // `None` = libheif's defaults: transformations applied, so the result is
    // already upright.
    let image = lib
        .decode(&handle, ColorSpace::Rgb(RgbChroma::Rgb), None)
        .context("decoding the HEIF picture")?;
    let planes = image.planes();
    let Some(plane) = planes.interleaved else {
        bail!("libheif returned no interleaved RGB plane");
    };
    if plane.storage_bits_per_pixel != 24 {
        bail!(
            "unexpected HEIF pixel layout ({} bits per pixel)",
            plane.storage_bits_per_pixel
        );
    }
    let (width, height) = (plane.width, plane.height);
    let row = width as usize * 3;
    let mut rgb = Vec::with_capacity(row * height as usize);
    for y in 0..height as usize {
        rgb.extend_from_slice(&plane.data[y * plane.stride..y * plane.stride + row]);
    }
    let rgb = RgbImage::from_raw(width, height, rgb).context("HEIF plane size")?;
    Ok(Picture { rgb })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_heif_brands() {
        let mut head = [0u8; 12];
        head[4..8].copy_from_slice(b"ftyp");
        head[8..12].copy_from_slice(b"heic");
        assert_eq!(sniff(&head), Format::Heif);
        head[8..12].copy_from_slice(b"isom");
        assert_eq!(sniff(&head), Format::Other);
        assert_eq!(sniff(b"\xff\xd8\xff\xe0"), Format::Other);
    }

    /// A 3 x 2 JPEG-free check of the EXIF path: PNG carries no orientation,
    /// so the decode is the identity.
    #[test]
    fn png_decodes_unrotated() {
        let mut png = Vec::new();
        let image = RgbImage::from_fn(3, 2, |x, y| image::Rgb([x as u8 * 80, y as u8 * 200, 7]));
        image
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let picture = decode_bytes(&png).unwrap();
        assert_eq!((picture.width(), picture.height()), (3, 2));
        assert_eq!(picture.rgb.get_pixel(2, 1).0, [160, 200, 7]);
    }

    /// The picture as stored by a phone held upright: landscape 128 x 64 in
    /// the file, a red block in the stored top-left corner, blue elsewhere.
    /// Displayed with orientation 6 (rotate 90° clockwise) it is 64 x 128 with
    /// the red block at the top RIGHT.
    fn stored() -> RgbImage {
        RgbImage::from_fn(128, 64, |x, y| {
            if x < 40 && y < 24 {
                image::Rgb([230, 20, 20])
            } else {
                image::Rgb([20, 20, 230])
            }
        })
    }

    /// Checks the decoded picture is the stored one rotated exactly once.
    fn assert_upright_once(picture: &Picture) {
        assert_eq!(
            (picture.width(), picture.height()),
            (64, 128),
            "not rotated, or rotated twice"
        );
        let red = |x: u32, y: u32| {
            let p = picture.rgb.get_pixel(x, y).0;
            p[0] > 150 && p[2] < 100
        };
        assert!(red(54, 10), "red block not at the top right");
        assert!(!red(10, 10) && !red(54, 118) && !red(10, 118));
    }

    /// A minimal big-endian TIFF/EXIF block with Orientation = `value`.
    fn exif_orientation(value: u16) -> Vec<u8> {
        let mut tiff = b"MM\x00\x2a\x00\x00\x00\x08".to_vec();
        tiff.extend_from_slice(&1u16.to_be_bytes()); // one entry
        tiff.extend_from_slice(&0x0112u16.to_be_bytes()); // Orientation
        tiff.extend_from_slice(&3u16.to_be_bytes()); // SHORT
        tiff.extend_from_slice(&1u32.to_be_bytes());
        tiff.extend_from_slice(&value.to_be_bytes());
        tiff.extend_from_slice(&[0, 0]);
        tiff.extend_from_slice(&0u32.to_be_bytes()); // no next IFD
        tiff
    }

    #[test]
    fn jpeg_exif_orientation_is_applied_once() {
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
            .encode_image(&stored())
            .unwrap();
        // Insert an APP1 "Exif" segment right after SOI.
        let mut app1 = b"Exif\x00\x00".to_vec();
        app1.extend(exif_orientation(6));
        let mut file = jpeg[..2].to_vec();
        file.extend_from_slice(&[0xff, 0xe1]);
        file.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
        file.extend(app1);
        file.extend_from_slice(&jpeg[2..]);
        assert_upright_once(&decode_bytes(&file).unwrap());
        // Without the tag the stored layout comes back untouched.
        let plain = decode_bytes(&jpeg).unwrap();
        assert_eq!((plain.width(), plain.height()), (128, 64));
    }

    /// Like an iPhone HEIC: the rotation is in the container (`irot`, written
    /// by libheif from the encoding option) AND in the EXIF block. libheif
    /// applies `irot`; the EXIF tag must not rotate it a second time.
    #[test]
    fn heic_irot_is_applied_once_and_exif_ignored() {
        use libheif_rs::{
            Channel, ColorSpace, CompressionFormat, EncoderQuality, EncodingOptions, HeifContext,
            Image, ImageOrientation, LibHeif, RgbChroma,
        };
        let lib = LibHeif::new();
        let Ok(mut encoder) = lib.encoder_for_format(CompressionFormat::Hevc) else {
            eprintln!("SKIPPED: this libheif has no HEVC encoder (needs the x265 plugin)");
            return;
        };
        encoder.set_quality(EncoderQuality::Lossy(95)).unwrap();
        let source = stored();
        let mut image = Image::new(128, 64, ColorSpace::Rgb(RgbChroma::Rgb)).unwrap();
        image
            .create_plane(Channel::Interleaved, 128, 64, 8)
            .unwrap();
        {
            let planes = image.planes_mut();
            let plane = planes.interleaved.unwrap();
            for y in 0..64usize {
                plane.data[y * plane.stride..y * plane.stride + 128 * 3]
                    .copy_from_slice(&source.as_raw()[y * 128 * 3..(y + 1) * 128 * 3]);
            }
        }
        let mut options = EncodingOptions::new().unwrap();
        options.set_image_orientation(ImageOrientation::Rotate90Cw);
        let mut context = HeifContext::new().unwrap();
        let handle = context
            .encode_image(&image, &mut encoder, Some(options))
            .unwrap();
        context
            .add_exif_metadata(&handle, &exif_orientation(6))
            .unwrap();
        let bytes = context.write_to_bytes().unwrap();
        assert_eq!(sniff(&bytes), Format::Heif);
        assert_upright_once(&decode_bytes(&bytes).unwrap());
        // The rotation is really in the container: ignoring transformations
        // gives back the stored landscape layout.
        let reread = HeifContext::read_from_bytes(&bytes).unwrap();
        let mut raw_options = libheif_rs::DecodingOptions::new().unwrap();
        raw_options.set_ignore_transformations(true);
        let raw = lib
            .decode(
                &reread.primary_image_handle().unwrap(),
                ColorSpace::Rgb(RgbChroma::Rgb),
                Some(raw_options),
            )
            .unwrap();
        assert_eq!((raw.width(), raw.height()), (128, 64));
    }
}
