use std::{
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

pub const TOKEN_ENV: &str = "LUGN_HUB_POINTER_TOKEN";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default = "default_listen")]
    listen: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    allowed_origins: Vec<String>,
    #[serde(default = "default_zone_height")]
    zone_height: u32,
    #[serde(default = "default_gain")]
    gain: f64,
    #[serde(default = "default_log_latency")]
    log_latency: bool,
}

fn default_listen() -> String {
    "0.0.0.0:8791".into()
}
fn default_zone_height() -> u32 {
    420
}
fn default_gain() -> f64 {
    1.0
}
fn default_log_latency() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub listen: SocketAddr,
    pub token: String,
    pub allowed_origins: Vec<String>,
    pub zone_height: u32,
    pub gain: f64,
    pub log_latency: bool,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading config {}", path.display()))?;
        Self::parse(&text, env::var(TOKEN_ENV).ok())
            .with_context(|| format!("invalid config {}", path.display()))
    }

    /// `env_token` (from `LUGN_HUB_POINTER_TOKEN`) wins over the file.
    pub fn parse(text: &str, env_token: Option<String>) -> Result<Self> {
        let raw: RawConfig = toml::from_str(text)?;
        let token = env_token
            .filter(|t| !t.is_empty())
            .or(raw.token)
            .unwrap_or_default();
        if token.is_empty() {
            bail!("`token` is required (or set {TOKEN_ENV})");
        }
        let listen = raw
            .listen
            .parse()
            .with_context(|| format!("`listen` is not a socket address: {}", raw.listen))?;
        if !(raw.gain.is_finite() && raw.gain > 0.0 && raw.gain <= 20.0) {
            bail!("`gain` must be in (0, 20]");
        }
        if raw.zone_height == 0 {
            bail!("`zone_height` must be positive");
        }
        let allowed_origins = raw
            .allowed_origins
            .iter()
            .map(|o| normalize_origin(o))
            .collect();
        Ok(Self {
            listen,
            token,
            allowed_origins,
            zone_height: raw.zone_height,
            gain: raw.gain,
            log_latency: raw.log_latency,
        })
    }
}

/// Origins compare case-insensitively and without a trailing slash.
pub fn normalize_origin(origin: &str) -> String {
    origin.trim().trim_end_matches('/').to_ascii_lowercase()
}

pub fn default_path() -> PathBuf {
    let base = env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from(".config"));
    base.join("lugn-linux-agent").join("hub-pointer.toml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_apply() {
        let cfg = Config::parse(r#"token = "abc""#, None).unwrap();
        assert_eq!(cfg.listen, "0.0.0.0:8791".parse().unwrap());
        assert_eq!(cfg.token, "abc");
        assert!(cfg.allowed_origins.is_empty());
        assert_eq!(cfg.zone_height, 420);
        assert_eq!(cfg.gain, 1.0);
        assert!(cfg.log_latency);
    }

    #[test]
    fn full_config_parses() {
        let cfg = Config::parse(
            r#"
            listen = "127.0.0.1:9000"
            token = "file"
            allowed_origins = ["http://192.168.10.132:8788/", "HTTP://Example.org"]
            zone_height = 300
            gain = 1.5
            log_latency = false
            "#,
            None,
        )
        .unwrap();
        assert_eq!(cfg.listen, "127.0.0.1:9000".parse().unwrap());
        assert_eq!(
            cfg.allowed_origins,
            ["http://192.168.10.132:8788", "http://example.org"]
        );
        assert_eq!(cfg.zone_height, 300);
        assert_eq!(cfg.gain, 1.5);
        assert!(!cfg.log_latency);
    }

    #[test]
    fn env_token_wins_and_satisfies_requirement() {
        let cfg = Config::parse(r#"token = "file""#, Some("env".into())).unwrap();
        assert_eq!(cfg.token, "env");
        let cfg = Config::parse("", Some("env".into())).unwrap();
        assert_eq!(cfg.token, "env");
        // An empty env var does not override the file.
        let cfg = Config::parse(r#"token = "file""#, Some(String::new())).unwrap();
        assert_eq!(cfg.token, "file");
    }

    #[test]
    fn rejects_bad_configs() {
        assert!(Config::parse("", None).is_err());
        assert!(Config::parse(r#"token = """#, None).is_err());
        assert!(Config::parse("token = \"a\"\nbogus = 1", None).is_err());
        assert!(Config::parse("token = \"a\"\nlisten = \"nope\"", None).is_err());
        assert!(Config::parse("token = \"a\"\ngain = 0.0", None).is_err());
        assert!(Config::parse("token = \"a\"\ngain = -1.0", None).is_err());
        assert!(Config::parse("token = \"a\"\nzone_height = 0", None).is_err());
    }
}
