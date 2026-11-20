//! Minimal client for the WiiM (LinkPlay) HTTP API.
//!
//! The device serves `https://<host>/httpapi.asp?command=...` with a
//! self-signed certificate. Only two commands are ever sent: `getPlayerStatus`
//! and `setPlayerCmd:switchmode:optical`.

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use rustls::{
    DigitallySignedStruct, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{CryptoProvider, aws_lc_rs},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};
use tokio_rustls::TlsConnector;

/// `mode` value LinkPlay firmware reports while the Optical input is selected.
const WIIM_MODE_OPTICAL: &str = "43";
const REQUEST_TIMEOUT: Duration = Duration::from_millis(2500);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const VERIFY_ATTEMPTS: u32 = 6;
const VERIFY_DELAY: Duration = Duration::from_millis(400);

// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Already on Optical.
    AlreadyOptical,
    /// The WiiM is playing its own music (or loading it).
    Busy,
    /// Idle, paused or stopped on another source.
    Switch,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PlayerStatus {
    pub mode: String,
    pub status: String,
}

impl PlayerStatus {
    pub fn is_optical(&self) -> bool {
        self.mode == WIIM_MODE_OPTICAL
    }

    /// Playing, or loading something that is about to play.
    pub fn is_playing(&self) -> bool {
        matches!(self.status.as_str(), "play" | "load")
    }

    pub fn parse(body: &str) -> Result<Self> {
        let value: Value = serde_json::from_str(body).context("WiiM status is not JSON")?;
        let field = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
        Ok(Self {
            mode: field("mode").context("WiiM status has no mode")?,
            status: field("status").context("WiiM status has no status")?,
        })
    }

    pub fn decide(&self) -> Decision {
        if self.is_optical() {
            Decision::AlreadyOptical
        } else if self.is_playing() {
            Decision::Busy
        } else {
            Decision::Switch
        }
    }
}

// ---------------------------------------------------------------------------
// WiiM HTTP API
// ---------------------------------------------------------------------------

/// WiiM serves its API over HTTPS with a self-signed certificate on the LAN, so
/// the certificate chain cannot be validated. Handshake signatures are still
/// checked, and the agent only ever sends two fixed read/switch commands.
#[derive(Debug)]
struct LanDevice(Arc<CryptoProvider>);

impl ServerCertVerifier for LanDevice {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

pub struct Wiim {
    address: String,
    name: ServerName<'static>,
    connector: TlsConnector,
}

impl Wiim {
    pub fn new(host: &str) -> Result<Self> {
        let (name, port) = split_host(host)?;
        let provider = Arc::new(aws_lc_rs::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .context("TLS protocol versions")?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(LanDevice(provider)))
            .with_no_client_auth();
        Ok(Self {
            address: format!("{name}:{port}"),
            name: ServerName::try_from(name).context("invalid WiiM host")?,
            connector: TlsConnector::from(Arc::new(config)),
        })
    }

    pub async fn status(&self) -> Result<PlayerStatus> {
        PlayerStatus::parse(&self.get("getPlayerStatus").await?)
    }

    /// Switches and confirms that the WiiM reports Optical, because the command
    /// can be acknowledged without the input actually changing.
    pub async fn switch_to_optical(&self) -> Result<()> {
        let answer = self.get("setPlayerCmd:switchmode:optical").await?;
        ensure!(answer.trim() == "OK", "WiiM refused the switch");
        for _ in 0..VERIFY_ATTEMPTS {
            if self.status().await?.is_optical() {
                return Ok(());
            }
            tokio::time::sleep(VERIFY_DELAY).await;
        }
        bail!("WiiM did not report Optical after the switch");
    }

    async fn get(&self, command: &str) -> Result<String> {
        timeout(REQUEST_TIMEOUT, async {
            let tcp = TcpStream::connect(&self.address)
                .await
                .context("connect to WiiM")?;
            tcp.set_nodelay(true).ok();
            let mut tls = self
                .connector
                .connect(self.name.clone(), tcp)
                .await
                .context("TLS handshake with WiiM")?;
            // HTTP/1.0 so the reply is never chunked and ends at connection close.
            let request = format!(
                "GET /httpapi.asp?command={command} HTTP/1.0\r\nHost: {}\r\nConnection: close\r\n\r\n",
                self.address
            );
            tls.write_all(request.as_bytes()).await.context("send to WiiM")?;
            let mut response = Vec::new();
            // Devices often close without a TLS close_notify; the bytes read so
            // far are still the whole reply.
            let _ = (&mut tls)
                .take(MAX_RESPONSE_BYTES as u64)
                .read_to_end(&mut response)
                .await;
            parse_http_body(&response)
        })
        .await
        .context("WiiM request timed out")?
    }
}

/// Accepts `host`, `host:port`; hostnames and IPv4 only (no URLs or paths).
fn split_host(host: &str) -> Result<(String, u16)> {
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) => (name, port.parse::<u16>().context("invalid WiiM port")?),
        None => (host, 443),
    };
    ensure!(
        !name.is_empty()
            && name.len() <= 253
            && port > 0
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-'),
        "wiim_host must be a hostname or IPv4 address, optionally with :port"
    );
    Ok((name.to_owned(), port))
}

fn parse_http_body(response: &[u8]) -> Result<String> {
    let split = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .context("WiiM reply has no HTTP header")?;
    let head = std::str::from_utf8(&response[..split]).context("WiiM header is not text")?;
    let status_line = head.lines().next().unwrap_or_default();
    ensure!(
        status_line.split_whitespace().nth(1) == Some("200"),
        "WiiM answered an HTTP error"
    );
    String::from_utf8(response[split + 4..].to_vec()).context("WiiM body is not text")
}

pub fn validate_host(host: &str) -> Result<()> {
    split_host(host).map(drop)
}

/// A host Lugn may hand to the agent over MQTT: a private or link-local IPv4
/// address, or a `.local` name, so a message can never point the agent at the
/// internet. Configuration in the agent's own file may use any host.
pub fn validate_lan_host(host: &str) -> Result<()> {
    let (name, _) = split_host(host)?;
    let lan = match name.parse::<std::net::Ipv4Addr>() {
        Ok(ip) => ip.is_private() || ip.is_link_local(),
        Err(_) => name.len() > 6 && name.ends_with(".local"),
    };
    ensure!(
        lan,
        "wiim_host must be a private IPv4 address or a .local name"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wiim_music_blocks_but_paused_or_idle_switches() {
        let status = |mode: &str, status: &str| PlayerStatus {
            mode: mode.into(),
            status: status.into(),
        };
        assert_eq!(status("43", "play").decide(), Decision::AlreadyOptical);
        assert_eq!(status("43", "stop").decide(), Decision::AlreadyOptical);
        assert_eq!(status("31", "play").decide(), Decision::Busy);
        assert_eq!(status("10", "load").decide(), Decision::Busy);
        assert_eq!(status("31", "pause").decide(), Decision::Switch);
        assert_eq!(status("0", "stop").decide(), Decision::Switch);
        assert_eq!(status("41", "none").decide(), Decision::Switch);
    }

    #[test]
    fn parses_player_status_json() {
        let body = r#"{"type":"0","ch":"0","mode":"31","status":"pause","vol":"40"}"#;
        assert_eq!(
            PlayerStatus::parse(body).unwrap(),
            PlayerStatus {
                mode: "31".into(),
                status: "pause".into()
            }
        );
        assert!(PlayerStatus::parse("OK").is_err());
        assert!(PlayerStatus::parse(r#"{"mode":"31"}"#).is_err());
    }

    #[test]
    fn parses_http_replies() {
        assert_eq!(
            parse_http_body(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK").unwrap(),
            "OK"
        );
        assert!(parse_http_body(b"HTTP/1.1 404 Not Found\r\n\r\nno").is_err());
        assert!(parse_http_body(b"garbage").is_err());
    }

    #[test]
    fn validates_hosts() {
        assert_eq!(
            split_host("192.168.1.50").unwrap(),
            ("192.168.1.50".into(), 443)
        );
        assert_eq!(
            split_host("wiim.local:8443").unwrap(),
            ("wiim.local".into(), 8443)
        );
        for bad in ["", "http://x", "a/b", "x y", "host:0", "host:abc", "a@b"] {
            assert!(validate_host(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn hosts_from_mqtt_must_be_on_the_lan() {
        for good in [
            "192.168.10.194",
            "10.0.0.5:443",
            "172.16.1.1",
            "169.254.3.4",
            "wiim.local",
        ] {
            assert!(validate_lan_host(good).is_ok(), "{good}");
        }
        for bad in [
            "8.8.8.8",
            "93.184.216.34:443",
            "example.com",
            "127.0.0.1",
            ".local",
            "172.32.0.1",
        ] {
            assert!(validate_lan_host(bad).is_err(), "{bad}");
        }
    }

    /// Read-only check against a real device:
    /// `LUGN_WIIM_HOST=192.168.1.50 cargo test --locked live_status -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "needs a real WiiM on the network"]
    async fn live_status() {
        let host = std::env::var("LUGN_WIIM_HOST").expect("set LUGN_WIIM_HOST");
        let status = Wiim::new(&host).unwrap().status().await.unwrap();
        println!(
            "mode={} status={} -> {:?}",
            status.mode,
            status.status,
            status.decide()
        );
    }
}
