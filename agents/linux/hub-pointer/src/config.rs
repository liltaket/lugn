use std::{
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use crate::gate::Policy;

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
    #[serde(default = "default_hub_width_px")]
    hub_width_px: u32,
    #[serde(default = "default_entry_slack_px")]
    entry_slack_px: u32,
    #[serde(default = "default_entry_push_px")]
    entry_push_px: u32,
    #[serde(default = "default_entry_timeout_ms")]
    entry_timeout_ms: u64,
    #[serde(default = "default_gain")]
    gain: f64,
    #[serde(default = "default_log_latency")]
    log_latency: bool,
    #[serde(default = "default_suppress_effects")]
    suppress_effects: Vec<String>,
    #[serde(default = "default_game_app_ids")]
    game_app_ids: Vec<String>,
    #[serde(default = "default_fullscreen_ok_app_ids")]
    fullscreen_ok_app_ids: Vec<String>,
    #[serde(default = "default_exit_on_key")]
    exit_on_key: bool,
}

fn default_listen() -> String {
    "0.0.0.0:8791".into()
}
fn default_hub_width_px() -> u32 {
    560
}
fn default_entry_slack_px() -> u32 {
    60
}
fn default_entry_push_px() -> u32 {
    40
}
fn default_entry_timeout_ms() -> u64 {
    350
}
fn default_gain() -> f64 {
    2.0
}
fn default_log_latency() -> bool {
    true
}
fn default_exit_on_key() -> bool {
    true
}
fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}
fn default_suppress_effects() -> Vec<String> {
    strings(&["shakecursor"])
}
fn default_game_app_ids() -> Vec<String> {
    strings(&[
        "gamescope",
        "lutris",
        "heroic",
        "net.lutris.Lutris",
        "com.heroicgameslauncher.hgl",
        "steam_proton",
        "minecraft-launcher",
        "retroarch",
        "org.libretro.RetroArch",
    ])
}
fn default_fullscreen_ok_app_ids() -> Vec<String> {
    strings(&[
        "zen",
        "zen-browser",
        "app.zen_browser.zen",
        "firefox",
        "firefox_firefox",
        "org.mozilla.firefox",
        "chromium",
        "google-chrome",
        "brave-browser",
        "com.brave.Browser",
        "vivaldi-stable",
        "mpv",
        "vlc",
        "org.videolan.VLC",
        "celluloid",
        "io.github.celluloid_player.Celluloid",
        "org.kde.haruna",
        "kodi",
        "plex",
        "com.github.iwalton3.jellyfin-media-player",
        "org.jellyfin.JellyfinDesktop",
        "freetube",
        "io.freetubeapp.FreeTube",
    ])
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub listen: SocketAddr,
    pub token: String,
    pub allowed_origins: Vec<String>,
    pub hub_width_px: u32,
    pub entry_slack_px: u32,
    pub entry_push_px: u32,
    pub entry_timeout: Duration,
    pub gain: f64,
    pub log_latency: bool,
    pub suppress_effects: Vec<String>,
    pub gate: Policy,
    /// A key press on the desktop keyboard ends a capture.
    pub exit_on_key: bool,
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
        if !(1..=100_000).contains(&raw.hub_width_px) {
            bail!("`hub_width_px` must be in 1..=100000");
        }
        if raw.entry_slack_px > 100_000 {
            bail!("`entry_slack_px` must be at most 100000");
        }
        if !(1..=10_000).contains(&raw.entry_push_px) {
            bail!("`entry_push_px` must be in 1..=10000");
        }
        if !(1..=10_000).contains(&raw.entry_timeout_ms) {
            bail!("`entry_timeout_ms` must be in 1..=10000");
        }
        let suppress_effects = raw
            .suppress_effects
            .iter()
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty())
            .collect();
        let allowed_origins = raw
            .allowed_origins
            .iter()
            .map(|o| normalize_origin(o))
            .collect();
        Ok(Self {
            listen,
            token,
            allowed_origins,
            hub_width_px: raw.hub_width_px,
            entry_slack_px: raw.entry_slack_px,
            entry_push_px: raw.entry_push_px,
            entry_timeout: Duration::from_millis(raw.entry_timeout_ms),
            gain: raw.gain,
            log_latency: raw.log_latency,
            suppress_effects,
            gate: Policy::new(&raw.game_app_ids, &raw.fullscreen_ok_app_ids),
            exit_on_key: raw.exit_on_key,
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
        assert_eq!(cfg.hub_width_px, 560);
        assert_eq!(cfg.entry_slack_px, 60);
        assert_eq!(cfg.entry_push_px, 40);
        assert_eq!(cfg.entry_timeout, Duration::from_millis(350));
        assert_eq!(cfg.gain, 2.0);
        assert!(cfg.log_latency);
        assert_eq!(cfg.suppress_effects, ["shakecursor"]);
        assert!(cfg.exit_on_key);
        // Lists are kept normalized for case-insensitive matching.
        assert!(
            cfg.gate
                .game_app_ids
                .contains(&"net.lutris.lutris".to_string())
        );
        assert!(cfg.gate.fullscreen_ok_app_ids.contains(&"zen".to_string()));
        assert!(
            cfg.gate
                .fullscreen_ok_app_ids
                .contains(&"io.freetubeapp.freetube".to_string())
        );
    }

    #[test]
    fn full_config_parses() {
        let cfg = Config::parse(
            r#"
            listen = "127.0.0.1:9000"
            token = "file"
            allowed_origins = ["http://192.168.10.132:8788/", "HTTP://Example.org"]
            hub_width_px = 600
            entry_slack_px = 0
            entry_push_px = 25
            entry_timeout_ms = 500
            gain = 1.5
            log_latency = false
            suppress_effects = []
            game_app_ids = ["MyGame"]
            fullscreen_ok_app_ids = ["Foo.desktop"]
            exit_on_key = false
            "#,
            None,
        )
        .unwrap();
        assert_eq!(cfg.listen, "127.0.0.1:9000".parse().unwrap());
        assert_eq!(
            cfg.allowed_origins,
            ["http://192.168.10.132:8788", "http://example.org"]
        );
        assert_eq!(cfg.hub_width_px, 600);
        assert_eq!(cfg.entry_slack_px, 0);
        assert_eq!(cfg.entry_push_px, 25);
        assert_eq!(cfg.entry_timeout, Duration::from_millis(500));
        assert_eq!(cfg.gain, 1.5);
        assert!(!cfg.log_latency);
        assert!(cfg.suppress_effects.is_empty());
        assert_eq!(cfg.gate.game_app_ids, ["mygame"]);
        assert_eq!(cfg.gate.fullscreen_ok_app_ids, ["foo"]);
        assert!(!cfg.exit_on_key);
    }

    #[test]
    fn example_config_parses() {
        let cfg = Config::parse(include_str!("../config.example.toml"), None).unwrap();
        assert_eq!(cfg.hub_width_px, 560);
        assert_eq!(cfg.entry_slack_px, 60);
        assert_eq!(cfg.entry_push_px, 40);
        assert_eq!(cfg.entry_timeout, Duration::from_millis(350));
        assert_eq!(cfg.gain, 2.0);
        assert_eq!(cfg.suppress_effects, ["shakecursor"]);
        assert!(cfg.exit_on_key);
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
        assert!(Config::parse("token = \"a\"\nhub_width_px = 0", None).is_err());
        assert!(Config::parse("token = \"a\"\nentry_push_px = 0", None).is_err());
        assert!(Config::parse("token = \"a\"\nentry_timeout_ms = 0", None).is_err());
        assert!(Config::parse("token = \"a\"\nentry_timeout_ms = 60000", None).is_err());
        // Replaced by hub_width_px; unknown keys are rejected.
        assert!(Config::parse("token = \"a\"\nzone_height = 420", None).is_err());
    }
}
