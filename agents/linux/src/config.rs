use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub device_id: String,
    pub mqtt_host: String,
    #[serde(default = "port")]
    pub mqtt_port: u16,
    #[serde(default)]
    pub mqtt_tls: bool,
    pub mqtt_ca_file: Option<PathBuf>,
    pub mqtt_username: Option<String>,
    // Deliberately never Debug/Serialize configuration (contains credentials).
    pub mqtt_password: Option<String>,
    #[serde(default = "prefix")]
    pub topic_prefix: String,
    #[serde(default = "heartbeat")]
    pub heartbeat_secs: u64,
    #[serde(default = "idle")]
    pub idle_secs: u32,
    #[serde(default)]
    pub gaming_app_ids: Vec<String>,
    #[serde(default)]
    pub control_enabled: bool,
    #[serde(default)]
    pub video_app_ids: Vec<String>,
    #[serde(default)]
    pub music_app_ids: Vec<String>,
}
fn port() -> u16 {
    1883
}
fn prefix() -> String {
    "lugn/computers".into()
}
fn heartbeat() -> u64 {
    30
}
fn idle() -> u32 {
    300
}
impl Config {
    pub fn load(path: &std::path::Path) -> Result<Self> {
        let mut c: Self = toml::from_str(
            &std::fs::read_to_string(path).context("read configuration")?,
        )
        .map_err(|_| anyhow::anyhow!("invalid configuration TOML (check field names and types)"))?;
        if let Ok(password) = std::env::var("LUGN_MQTT_PASSWORD") {
            c.mqtt_password = Some(password);
        }
        c.validate()?;
        Ok(c)
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            self.device_id
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
                && self.device_id.len() <= 64
                && self
                    .device_id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)),
            "device_id must be 1–64 ASCII letters/digits/_/-, starting with a letter or digit"
        );
        ensure!(
            !self.mqtt_host.is_empty() && self.mqtt_port > 0,
            "MQTT host and port required"
        );
        ensure!(
            !self.topic_prefix.is_empty()
                && !self.topic_prefix.starts_with('/')
                && !self.topic_prefix.ends_with('/')
                && !self.topic_prefix.contains(['+', '#', '\0']),
            "invalid MQTT topic prefix"
        );
        ensure!(
            (5..=300).contains(&self.heartbeat_secs),
            "heartbeat_secs must be 5–300"
        );
        ensure!(
            (1..=86400).contains(&self.idle_secs),
            "idle_secs must be 1–86400"
        );
        ensure!(
            self.mqtt_username.is_some() || self.mqtt_password.is_none(),
            "MQTT password requires username"
        );
        ensure!(
            self.mqtt_tls || self.mqtt_ca_file.is_none(),
            "mqtt_ca_file requires mqtt_tls"
        );
        ensure!(
            !self.control_enabled
                || (self.mqtt_username.as_deref().is_some_and(|v| !v.is_empty())
                    && self.mqtt_password.as_deref().is_some_and(|v| !v.is_empty())),
            "control_enabled requires configured MQTT username and password"
        );
        Ok(())
    }
    pub fn topic(&self, leaf: &str) -> String {
        format!("{}/{}/{}", self.topic_prefix, self.device_id, leaf)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_is_opt_in_and_requires_credentials() {
        let mut c: Config = toml::from_str("device_id='desktop'\nmqtt_host='localhost'").unwrap();
        assert!(!c.control_enabled);
        c.control_enabled = true;
        assert!(c.validate().is_err());
        c.mqtt_username = Some("synthetic-user".into());
        assert!(c.validate().is_err());
        c.mqtt_password = Some("synthetic-password".into());
        assert!(c.validate().is_ok());
    }
    #[test]
    fn rejects_wildcards_and_invalid_intervals() {
        let mut c: Config = toml::from_str("device_id='desktop'\nmqtt_host='localhost'").unwrap();
        assert!(c.validate().is_ok());
        c.device_id = "+/cmd".into();
        assert!(c.validate().is_err());
        c.device_id = "desktop".into();
        c.heartbeat_secs = 0;
        assert!(c.validate().is_err());
    }
}
