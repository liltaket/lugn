//! Optional, observation-only MPRIS artwork. No HTTP or arbitrary file fetches.
use crate::state::Artwork;
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageReader, Limits, codecs::jpeg::JpegEncoder};
use std::{
    fs::{File, OpenOptions},
    io::{Cursor, Read},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
    },
    path::Path,
};

const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_JPEG: usize = 24 * 1024;

pub async fn collect(
    player: &str,
    identity: Option<&str>,
    desktop_entry: Option<&str>,
    art_url: Option<String>,
) -> Option<Artwork> {
    let url = art_url?;
    if let Some(id) = spotify_id(&url) {
        return Some(Artwork::Spotify { id: id.to_owned() });
    }
    // Only Firefox's own ephemeral MPRIS thumbnail cache is readable.
    if !firefox_player(player, identity, desktop_entry) {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    tokio::task::spawn_blocking(move || firefox_image(Path::new(&home), &url))
        .await
        .ok()
        .flatten()
}

fn firefox_player(player: &str, identity: Option<&str>, desktop_entry: Option<&str>) -> bool {
    (player.starts_with("org.mpris.MediaPlayer2.firefox.")
        || player == "org.mpris.MediaPlayer2.firefox")
        && matches!(identity, Some("Firefox") | Some("Mozilla firefox_firefox"))
        && matches!(desktop_entry, Some("firefox") | Some("firefox_firefox"))
}

fn spotify_id(url: &str) -> Option<&str> {
    let id = url.strip_prefix("https://i.scdn.co/image/")?;
    (id.len() == 40
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
    .then_some(id)
}

fn owned_regular(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_file() && metadata.uid() == unsafe { libc::geteuid() }
}

fn firefox_image(home: &Path, url: &str) -> Option<Artwork> {
    let path = url.strip_prefix("file://")?;
    let mut selected = None;
    for components in [
        vec![".mozilla", "firefox", "firefox-mpris"],
        vec![
            "snap",
            "firefox",
            "common",
            ".mozilla",
            "firefox",
            "firefox-mpris",
        ],
    ] {
        let cache = components
            .iter()
            .fold(home.to_path_buf(), |path, part| path.join(part));
        if let Some(name) = path.strip_prefix(&format!("{}/", cache.to_str()?)) {
            let stem = name.strip_suffix(".png")?;
            let (first, second) = stem.split_once('_')?;
            if first.is_empty()
                || second.is_empty()
                || !first.bytes().all(|c| c.is_ascii_digit())
                || !second.bytes().all(|c| c.is_ascii_digit())
                || name.len() > 128
            {
                return None;
            }
            selected = Some((components, name));
            break;
        }
    }
    let (components, name) = selected?;
    // Open every component without following symlinks, including the cache file.
    // Directory-relative descriptors close the parent-symlink replacement race.
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(home)
        .ok()?;
    if directory.metadata().ok()?.uid() != unsafe { libc::geteuid() } {
        return None;
    }
    for component in components {
        directory = open_child(&directory, component, true)?;
        if directory.metadata().ok()?.uid() != unsafe { libc::geteuid() } {
            return None;
        }
    }
    let file = open_child(&directory, name, false)?;
    let metadata = file.metadata().ok()?;
    if !owned_regular(&metadata) || metadata.len() > MAX_FILE {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_FILE + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_FILE {
        return None;
    }
    encode_png(bytes)
}

fn open_child(parent: &File, name: &str, directory: bool) -> Option<File> {
    let name = std::ffi::CString::new(Path::new(name).as_os_str().as_bytes()).ok()?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return None;
    }
    Some(unsafe { File::from_raw_fd(fd) })
}

fn encode_png(bytes: Vec<u8>) -> Option<Artwork> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().ok()?.thumbnail(240, 240).to_rgb8();
    for quality in [80, 65, 45, 25] {
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, quality)
            .encode_image(&image)
            .ok()?;
        if jpeg.len() <= MAX_JPEG {
            return Some(Artwork::Inline {
                data: STANDARD.encode(jpeg),
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    fn fixture(home: &Path) -> std::path::PathBuf {
        let path = home.join(".mozilla/firefox/firefox-mpris/123_1.png");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        image::RgbImage::from_pixel(800, 400, image::Rgb([20, 40, 70]))
            .save(&path)
            .unwrap();
        path
    }
    #[test]
    fn spotify_is_exact_and_never_accepts_other_urls() {
        let id = "a".repeat(40);
        let url = format!("https://i.scdn.co/image/{id}");
        assert_eq!(spotify_id(&url), Some(id.as_str()));
        for url in [
            format!("{url}?x=1"),
            format!("{url}#x"),
            format!("{url}/"),
            url.to_uppercase(),
            format!("https://i.scdn.co.evil/image/{id}"),
            format!("http://i.scdn.co/image/{id}"),
        ] {
            assert_eq!(spotify_id(&url), None);
        }
    }
    #[test]
    fn only_fixed_owned_regular_cache_files_are_encoded() {
        let home = tempfile::tempdir().unwrap();
        let path = fixture(home.path());
        let url = format!("file://{}", path.display());
        let Some(Artwork::Inline { data }) = firefox_image(home.path(), &url) else {
            panic!("expected thumbnail")
        };
        assert!(data.len() <= 32768);
        let decoded = image::load_from_memory(&STANDARD.decode(data).unwrap()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (240, 120));
        for url in [
            format!("{url}?x"),
            format!(
                "file://{}/.mozilla/firefox/firefox-mpris/../123_1.png",
                home.path().display()
            ),
            "file:///etc/passwd".into(),
        ] {
            assert!(firefox_image(home.path(), &url).is_none());
        }
        std::fs::remove_file(&path).unwrap();
        symlink("/etc/passwd", &path).unwrap();
        assert!(firefox_image(home.path(), &format!("file://{}", path.display())).is_none());
        std::fs::remove_file(&path).unwrap();
        File::create(&path).unwrap().set_len(MAX_FILE + 1).unwrap();
        assert!(firefox_image(home.path(), &format!("file://{}", path.display())).is_none());
    }
    #[test]
    fn symlinked_cache_parent_and_oversized_image_are_rejected() {
        let home = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let path = fixture(other.path());
        symlink(other.path().join(".mozilla"), home.path().join(".mozilla")).unwrap();
        let url = format!(
            "file://{}/.mozilla/firefox/firefox-mpris/123_1.png",
            home.path().display()
        );
        assert!(firefox_image(home.path(), &url).is_none());
        // PNG dimensions are checked before allocation/decode.
        image::RgbImage::new(4097, 1).save(&path).unwrap();
        assert!(firefox_image(other.path(), &format!("file://{}", path.display())).is_none());
        assert!(encode_png(vec![0; 100]).is_none());
    }
    #[test]
    fn accepts_only_verified_native_and_snap_firefox_identities() {
        assert!(firefox_player(
            "org.mpris.MediaPlayer2.firefox.instance_1_6134",
            Some("Mozilla firefox_firefox"),
            Some("firefox_firefox")
        ));
        assert!(firefox_player(
            "org.mpris.MediaPlayer2.firefox.instance",
            Some("Firefox"),
            Some("firefox")
        ));
        assert!(!firefox_player(
            "org.mpris.MediaPlayer2.firefoxevasion",
            Some("Firefox"),
            Some("firefox")
        ));
        assert!(!firefox_player(
            "org.mpris.MediaPlayer2.firefox.instance",
            Some("Firefox"),
            Some("other")
        ));
    }

    #[tokio::test]
    async fn unrelated_players_cannot_read_firefox_cache() {
        let url = Some("file:///home/example/.mozilla/firefox/firefox-mpris/1_2.png".into());
        assert!(
            collect(
                "org.mpris.MediaPlayer2.evil",
                Some("Firefox"),
                Some("firefox"),
                url.clone()
            )
            .await
            .is_none()
        );
        assert!(
            collect(
                "org.mpris.MediaPlayer2.firefox.instance",
                Some("Unknown"),
                Some("firefox"),
                url
            )
            .await
            .is_none()
        );
    }
}
