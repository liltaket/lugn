//! Downloads the model files named in `models.toml`, checking each against its
//! pinned SHA-256. Files already present with the right hash are kept; a file
//! is written to `<name>.part` and renamed only when its hash matches.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

use super::manifest::{Download, Manifest, path_in};

/// Which entries to fetch.
#[derive(Debug, Clone)]
pub enum Which {
    /// The runtime and every entry marked `default = true` (never the
    /// non-commercial ones).
    Default,
    /// The runtime and the models in `[use]`.
    InUse,
    /// Exactly these keys (`"runtime"` for the ONNX Runtime library).
    Only(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Kept,
    Downloaded,
}

/// Makes sure the chosen files are in `models_dir` (and the runtime in its
/// sibling `lib/`). Returns each key with what happened.
pub fn ensure(models_dir: &Path, which: &Which) -> Result<Vec<(String, Outcome)>> {
    let manifest = Manifest::load(models_dir)?;
    ensure_with(&manifest, models_dir, which, &mut |line| {
        eprintln!("{line}")
    })
}

pub fn ensure_with(
    manifest: &Manifest,
    models_dir: &Path,
    which: &Which,
    log: &mut dyn FnMut(&str),
) -> Result<Vec<(String, Outcome)>> {
    let wanted: Vec<(String, &Download)> = match which {
        Which::Default => manifest
            .downloads()
            .into_iter()
            .filter(|(key, d)| key == "runtime" || d.default)
            .collect(),
        Which::InUse => manifest
            .downloads()
            .into_iter()
            .filter(|(key, _)| {
                key == "runtime"
                    || *key == manifest.chosen.embed
                    || *key == manifest.chosen.detector
                    || *key == manifest.chosen.face
            })
            .collect(),
        Which::Only(keys) => {
            let all = manifest.downloads();
            let mut out = Vec::new();
            for key in keys {
                match all.iter().find(|(k, _)| k == key) {
                    Some((k, d)) => out.push((k.clone(), *d)),
                    None => bail!("models.toml has no entry {key:?}"),
                }
            }
            out
        }
    };
    let mut done = Vec::new();
    for (key, download) in wanted {
        let outcome = fetch_one(models_dir, &key, download, log)?;
        done.push((key, outcome));
    }
    Ok(done)
}

fn pinned(hash: &str) -> Option<&str> {
    (hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hash)
}

fn fetch_one(
    models_dir: &Path,
    key: &str,
    download: &Download,
    log: &mut dyn FnMut(&str),
) -> Result<Outcome> {
    let target = path_in(models_dir, &download.file);
    if target.is_file() {
        let actual = sha256_file(&target)?;
        match pinned(&download.sha256) {
            Some(expected) if expected == actual => {
                log(&format!("{key}: present ({})", target.display()));
                return Ok(Outcome::Kept);
            }
            None => {
                log(&format!(
                    "{key}: present but not pinned; pin sha256 = \"{actual}\", bytes = {}",
                    fs::metadata(&target)?.len()
                ));
                return Ok(Outcome::Kept);
            }
            Some(_) => log(&format!("{key}: wrong checksum, downloading again")),
        }
    }
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).with_context(|| dir.display().to_string())?;
    }
    log(&format!(
        "{key}: downloading {} ({})",
        download.url,
        if download.license.is_empty() {
            "licence not stated"
        } else {
            &download.license
        }
    ));
    let part = with_suffix(&target, ".part");
    let result = match &download.member {
        None => {
            let actual = http_to_file(&download.url, &part)?;
            check(key, "file", pinned(&download.sha256), &actual, log)?;
            Ok(())
        }
        Some(member) => {
            let archive = with_suffix(&target, ".archive.part");
            let archive_hash = http_to_file(&download.url, &archive)?;
            let checked = check(
                key,
                "archive",
                download.archive_sha256.as_deref().and_then(pinned),
                &archive_hash,
                log,
            )
            .and_then(|()| extract_member(&archive, member, &part))
            .and_then(|actual| check(key, "file", pinned(&download.sha256), &actual, log));
            let _ = fs::remove_file(&archive);
            checked
        }
    };
    if let Err(error) = result {
        let _ = fs::remove_file(&part);
        return Err(error);
    }
    fs::rename(&part, &target).with_context(|| target.display().to_string())?;
    Ok(Outcome::Downloaded)
}

fn check(
    key: &str,
    what: &str,
    expected: Option<&str>,
    actual: &str,
    log: &mut dyn FnMut(&str),
) -> Result<()> {
    match expected {
        Some(expected) if expected == actual => Ok(()),
        Some(expected) => bail!(
            "{key}: {what} checksum mismatch (expected {expected}, got {actual}); not installed"
        ),
        None => {
            log(&format!(
                "{key}: {what} not pinned yet; pin sha256 = \"{actual}\" in models.toml"
            ));
            Ok(())
        }
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// Streams `url` into `path`, returning the hex SHA-256 of what was written.
fn http_to_file(url: &str, path: &Path) -> Result<String> {
    let response = ureq::get(url)
        .header("User-Agent", "lugn-photo-brain")
        .call()
        .with_context(|| format!("GET {url}"))?;
    let mut reader = response.into_body().into_reader();
    let mut file = File::create(path).with_context(|| path.display().to_string())?;
    let hash = copy_hashing(&mut reader, &mut file).with_context(|| format!("GET {url}"))?;
    file.sync_all()?;
    Ok(hash)
}

fn copy_hashing(reader: &mut dyn Read, writer: &mut dyn Write) -> io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        writer.write_all(&buffer[..n])?;
    }
    Ok(hex(&hasher.finalize()))
}

fn extract_member(archive: &Path, member: &str, out: &Path) -> Result<String> {
    let file = File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file).context("not a zip archive")?;
    // Archives sometimes nest everything under a top folder; match the tail.
    let name = (0..zip.len())
        .filter_map(|i| zip.name_for_index(i).map(str::to_string))
        .find(|name| name == member || name.ends_with(&format!("/{member}")))
        .with_context(|| format!("{member} is not in the archive"))?;
    let mut entry = zip.by_name(&name)?;
    let mut file = File::create(out).with_context(|| out.display().to_string())?;
    let hash = copy_hashing(&mut entry, &mut file)?;
    file.sync_all()?;
    Ok(hash)
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).with_context(|| path.display().to_string())?;
    copy_hashing(&mut file, &mut io::sink()).with_context(|| path.display().to_string())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_while_copying() {
        let mut out = Vec::new();
        let hash = copy_hashing(&mut &b"abc"[..], &mut out).unwrap();
        assert_eq!(out, b"abc");
        assert_eq!(
            hash,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn default_set_never_includes_non_commercial_models() {
        let manifest = Manifest::parse(super::super::manifest::DEFAULT_MANIFEST).unwrap();
        let keys: Vec<String> = manifest
            .downloads()
            .into_iter()
            .filter(|(key, d)| key == "runtime" || d.default)
            .map(|(key, _)| key)
            .collect();
        assert!(keys.contains(&"siglip2-so400m-patch16-384-int8".to_string()));
        assert!(keys.contains(&"auraface-v1-glintr100".to_string()));
        assert!(!keys.iter().any(|k| k.starts_with("buffalo")));
    }
}
