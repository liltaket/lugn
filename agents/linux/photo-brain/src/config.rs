//! `config.toml` (mode 0600). The bearer token comes only from the environment
//! (`LUGN_PHOTO_BRAIN_TOKEN`), never from this file, and is never logged.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;

pub const TOKEN_ENV: &str = "LUGN_PHOTO_BRAIN_TOKEN";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Lugn's API through the tunnel, e.g. `http://127.0.0.1:18787`.
    pub lugn_url: String,
    /// Full-size originals (the big disk). Never created when its mount is missing.
    pub store_dir: PathBuf,
    /// Index, embeddings, cached people labels and the last bundle (small; SSD).
    pub db_dir: PathBuf,
    /// The repository's `data/photo-scenes.json`.
    pub scenes_file: PathBuf,
    /// The repository's `data/places.tsv`; default: next to `scenes_file`.
    #[serde(default)]
    pub places_file: Option<PathBuf>,
    pub models_dir: PathBuf,
    #[serde(default = "default_threads")]
    pub threads: usize,
    #[serde(default = "default_poll_minutes")]
    pub poll_minutes: u64,
    /// Stop downloading below this much free space on `store_dir`.
    #[serde(default = "default_min_free_gb")]
    pub min_free_gb: f64,
    /// Overrides the home the pictures suggest.
    #[serde(default)]
    pub home: Option<HomeOverride>,
    /// Only the newest this many pictures of the album are kept and analysed.
    #[serde(default)]
    pub max_pictures: Option<usize>,
    /// Rest between two analysed pictures, so other jobs keep the CPU.
    #[serde(default = "default_pause_ms")]
    pub pause_ms: u64,
    /// How long an original that left the album stays on disk.
    #[serde(default = "default_gone_grace_days")]
    pub gone_grace_days: u64,
    #[serde(default)]
    pub scenes: SceneConfig,
    #[serde(default)]
    pub events: EventConfig,
    #[serde(default)]
    pub faces: FaceConfig,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HomeOverride {
    pub lat: f64,
    pub lon: f64,
}

/// Per vocabulary kind (see `cluster::scenes`): a label whose raw cosine is
/// below the floor is not reported; a screen/document/receipt label at or
/// above `*_document_p` (and no faces) makes the picture junk.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct SceneConfig {
    pub softmax_min_cosine: f32,
    pub sigmoid_min_cosine: f32,
    pub softmax_document_p: f32,
    pub sigmoid_document_p: f32,
}

impl Default for SceneConfig {
    fn default() -> Self {
        Self {
            // CLIP: matching image-text cosines sit around 0.25-0.33.
            softmax_min_cosine: 0.22,
            // SigLIP: cosines are smaller; with its bias p = 0.5 is near 0.1.
            sigmoid_min_cosine: 0.05,
            softmax_document_p: 0.6,
            sigmoid_document_p: 0.5,
        }
    }
}

/// Overrides of the face grouping's thresholds for the recogniser in use
/// (`Thresholds::for_model` holds the calibrated defaults).
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FaceConfig {
    pub join: Option<f32>,
    pub keep: Option<f32>,
    pub link: Option<f32>,
    pub margin: Option<f32>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct EventConfig {
    pub gap_hours: f64,
    pub km: f64,
}

impl Default for EventConfig {
    fn default() -> Self {
        Self {
            gap_hours: 4.0,
            km: 25.0,
        }
    }
}

fn default_threads() -> usize {
    4
}
fn default_poll_minutes() -> u64 {
    30
}
fn default_min_free_gb() -> f64 {
    20.0
}
fn default_pause_ms() -> u64 {
    200
}
fn default_gone_grace_days() -> u64 {
    7
}

/// `$XDG_CONFIG_HOME/lugn-photo-brain/config.toml`.
pub fn default_path() -> PathBuf {
    config_home().join("lugn-photo-brain/config.toml")
}

fn config_home() -> PathBuf {
    match std::env::var_os("XDG_CONFIG_HOME") {
        Some(dir) if Path::new(&dir).is_absolute() => PathBuf::from(dir),
        _ => home_dir().join(".config"),
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn expand(path: &Path) -> PathBuf {
    match path.strip_prefix("~") {
        Ok(rest) => home_dir().join(rest),
        Err(_) => path.to_path_buf(),
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let meta =
            std::fs::symlink_metadata(path).with_context(|| format!("read {}", path.display()))?;
        ensure!(
            meta.file_type().is_file(),
            "{} must be a regular file",
            path.display()
        );
        ensure!(
            meta.permissions().mode() & 0o077 == 0,
            "{} must not be readable by others (chmod 600)",
            path.display()
        );
        let text =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let mut config = Self::parse(&text)?;
        // Relative paths are relative to the config file.
        let base = path.parent().unwrap_or(Path::new("."));
        for p in [
            &mut config.store_dir,
            &mut config.db_dir,
            &mut config.scenes_file,
            &mut config.models_dir,
        ] {
            if p.is_relative() {
                *p = base.join(&*p);
            }
        }
        if let Some(p) = config.places_file.as_mut().filter(|p| p.is_relative()) {
            *p = base.join(&*p);
        }
        Ok(config)
    }

    pub fn parse(text: &str) -> Result<Self> {
        let mut config: Self = toml::from_str(text).map_err(|e| {
            // toml's message names the field; it never contains the token (it is not in the file).
            anyhow::anyhow!("invalid configuration: {}", e.message())
        })?;
        for p in [
            &mut config.store_dir,
            &mut config.db_dir,
            &mut config.scenes_file,
            &mut config.models_dir,
        ] {
            *p = expand(p);
        }
        if let Some(p) = config.places_file.as_mut() {
            *p = expand(p);
        }
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<()> {
        let url = reqwest::Url::parse(&self.lugn_url).context("lugn_url is not a URL")?;
        let loopback = matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        );
        match url.scheme() {
            "https" => {}
            "http" if loopback => {}
            "http" => bail!("lugn_url must be https unless it is the loopback tunnel"),
            other => bail!("lugn_url scheme {other:?} is not supported"),
        }
        ensure!(
            url.username().is_empty() && url.password().is_none(),
            "lugn_url must not carry credentials"
        );
        ensure!((1..=64).contains(&self.threads), "threads must be 1-64");
        ensure!(self.poll_minutes >= 1, "poll_minutes must be at least 1");
        ensure!(
            self.min_free_gb >= 0.0 && self.min_free_gb.is_finite(),
            "min_free_gb must be >= 0"
        );
        ensure!(
            self.max_pictures != Some(0),
            "max_pictures must be at least 1"
        );
        ensure!(self.pause_ms <= 60_000, "pause_ms must be at most 60000");
        ensure!(
            self.events.gap_hours > 0.0 && self.events.km > 0.0,
            "events.gap_hours and events.km must be > 0"
        );
        if let Some(home) = self.home {
            ensure!(
                (-90.0..=90.0).contains(&home.lat) && (-180.0..=180.0).contains(&home.lon),
                "home must be a valid latitude/longitude"
            );
        }
        Ok(())
    }

    pub fn places_path(&self) -> PathBuf {
        self.places_file
            .clone()
            .unwrap_or_else(|| self.scenes_file.with_file_name("places.tsv"))
    }
}

/// The bearer token for Lugn. Never put it in a log line or an error.
#[derive(Clone)]
pub struct Token(String);

impl Token {
    pub fn from_env() -> Result<Self> {
        match std::env::var(TOKEN_ENV) {
            Ok(t) if !t.trim().is_empty() => Self::new(t.trim().to_string()),
            _ => bail!("{TOKEN_ENV} is not set (put it in ~/.config/lugn-photo-brain/environment)"),
        }
    }

    pub fn new(value: String) -> Result<Self> {
        ensure!(
            value.bytes().all(|b| b.is_ascii_graphic()),
            "{TOKEN_ENV} must be printable ASCII without spaces"
        );
        Ok(Self(value))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(…)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"
        lugn_url = "http://127.0.0.1:18787"
        store_dir = "/run/media/bruno/Filmer/lugn-photos"
        db_dir = "~/.local/state/lugn-photo-brain"
        scenes_file = "/srv/lugn/data/photo-scenes.json"
        models_dir = "~/.local/share/lugn-photo-brain/models"
    "#;

    #[test]
    fn defaults_and_home_expansion() {
        let c = Config::parse(MINIMAL).unwrap();
        assert_eq!(c.threads, 4);
        assert_eq!(c.poll_minutes, 30);
        assert_eq!(c.scenes.softmax_min_cosine, 0.22);
        assert!(!c.db_dir.starts_with("~"));
        assert!(c.db_dir.ends_with(".local/state/lugn-photo-brain"));
        assert_eq!(c.places_path(), PathBuf::from("/srv/lugn/data/places.tsv"));
    }

    #[test]
    fn a_token_in_the_file_is_refused() {
        let text = format!("{MINIMAL}\ntoken = \"secret-value\"\n");
        let err = Config::parse(&text).unwrap_err().to_string();
        assert!(err.contains("token"), "{err}");
        assert!(!err.contains("secret-value"), "{err}");
    }

    #[test]
    fn plain_http_only_to_loopback() {
        let text = MINIMAL.replace("http://127.0.0.1:18787", "http://192.168.10.132:8788");
        assert!(Config::parse(&text).is_err());
        let text = MINIMAL.replace("http://127.0.0.1:18787", "https://brunocam.example:8788");
        assert!(Config::parse(&text).is_ok());
    }

    #[test]
    fn a_world_readable_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, MINIMAL).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            Config::load(&path)
                .unwrap_err()
                .to_string()
                .contains("chmod 600")
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(Config::load(&path).is_ok());
    }

    #[test]
    fn the_token_never_prints() {
        let t = Token::new("abc123".into()).unwrap();
        assert_eq!(format!("{t:?}"), "Token(…)");
        assert!(Token::new("has space".into()).is_err());
    }
}
