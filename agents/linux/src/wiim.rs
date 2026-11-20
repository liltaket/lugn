//! Minimal client for the WiiM (LinkPlay) HTTP API.
//!
//! The device serves `https://<host>/httpapi.asp?command=...` with a
//! self-signed certificate. Only two commands are ever sent: `getPlayerStatus`
//! and `setPlayerCmd:switchmode:optical`.
//!
//! Requests reuse one HTTP/1.1 keep-alive TLS connection while active (the
//! device keeps idle sockets open for more than 5 s and closes them before
//! 10 s), so the switch sent after an audio-start prefetch avoids a fresh
//! ~60 ms TLS handshake.

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
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::Mutex,
    time::{Instant, timeout},
};
use tokio_rustls::{TlsConnector, client::TlsStream};

/// `mode` value LinkPlay firmware reports while the Optical input is selected.
const WIIM_MODE_OPTICAL: &str = "43";
const REQUEST_TIMEOUT: Duration = Duration::from_millis(2500);
/// WiiM Amp Ultra keeps idle HTTP/1.1 sockets open past 5 s and closes them
/// before 10 s; 4 s covers both the prefetch-to-switch window and the 2 s busy
/// recheck without routinely hitting a half-closed socket.
const KEEPALIVE_MAX_IDLE: Duration = Duration::from_secs(4);
const MAX_HEADER_BYTES: usize = 8 * 1024;
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

struct Pooled {
    stream: TlsStream<TcpStream>,
    last_used: Instant,
}

pub struct Wiim {
    address: String,
    name: ServerName<'static>,
    connector: TlsConnector,
    conn: Mutex<Option<Pooled>>,
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
            conn: Mutex::new(None),
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

    async fn connect(&self) -> Result<TlsStream<TcpStream>> {
        let tcp = TcpStream::connect(&self.address)
            .await
            .context("connect to WiiM")?;
        tcp.set_nodelay(true).ok();
        self.connector
            .connect(self.name.clone(), tcp)
            .await
            .context("TLS handshake with WiiM")
    }

    async fn get(&self, command: &str) -> Result<String> {
        timeout(REQUEST_TIMEOUT, async {
            let mut guard = self.conn.lock().await;
            if let Some(mut pooled) = guard.take()
                && pooled.last_used.elapsed() < KEEPALIVE_MAX_IDLE
            {
                match exchange(&mut pooled.stream, &self.address, command).await {
                    Ok(reply) => {
                        if reply.keep_alive {
                            pooled.last_used = Instant::now();
                            *guard = Some(pooled);
                        }
                        return Ok(reply.body);
                    }
                    // The device may have closed an idle keep-alive socket;
                    // both commands are idempotent, so retry once on a fresh
                    // connection, but never retry an explicit HTTP error.
                    Err(ExchangeError::Transport(_)) => {}
                    Err(ExchangeError::Protocol(error)) => return Err(error),
                }
            }
            let mut stream = self.connect().await?;
            let reply = exchange(&mut stream, &self.address, command)
                .await
                .map_err(ExchangeError::into_anyhow)?;
            if reply.keep_alive {
                *guard = Some(Pooled {
                    stream,
                    last_used: Instant::now(),
                });
            }
            Ok(reply.body)
        })
        .await
        .context("WiiM request timed out")?
    }
}

struct HttpReply {
    body: String,
    keep_alive: bool,
}

enum ExchangeError {
    Transport(anyhow::Error),
    Protocol(anyhow::Error),
}

impl ExchangeError {
    fn into_anyhow(self) -> anyhow::Error {
        match self {
            Self::Transport(error) | Self::Protocol(error) => error,
        }
    }
}

async fn exchange<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    host: &str,
    command: &str,
) -> std::result::Result<HttpReply, ExchangeError> {
    let request = format!(
        "GET /httpapi.asp?command={command} HTTP/1.1\r\nHost: {host}\r\nConnection: keep-alive\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .context("send to WiiM")
        .map_err(ExchangeError::Transport)?;
    stream
        .flush()
        .await
        .context("flush WiiM request")
        .map_err(ExchangeError::Transport)?;
    read_http_reply(stream).await
}

async fn read_http_reply<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> std::result::Result<HttpReply, ExchangeError> {
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0_u8; 1024];
    let split = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() >= MAX_HEADER_BYTES {
            return Err(ExchangeError::Protocol(anyhow::anyhow!(
                "WiiM HTTP header is too large"
            )));
        }
        let read = match reader.read(&mut chunk).await {
            Ok(0) => {
                return Err(ExchangeError::Transport(anyhow::anyhow!(
                    "WiiM closed connection before HTTP header"
                )));
            }
            Ok(n) => n,
            Err(error) => {
                return Err(ExchangeError::Transport(
                    anyhow::Error::new(error).context("read WiiM HTTP header"),
                ));
            }
        };
        buf.extend_from_slice(&chunk[..read]);
    };

    let head = std::str::from_utf8(&buf[..split])
        .context("WiiM header is not text")
        .map_err(ExchangeError::Protocol)?;
    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or_default();
    let mut parts = status_line.split_whitespace();
    let version = parts.next().unwrap_or_default();
    if parts.next() != Some("200") {
        return Err(ExchangeError::Protocol(anyhow::anyhow!(
            "WiiM answered an HTTP error"
        )));
    }

    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    let mut connection_close = false;
    let mut connection_keep_alive = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            let parsed = value
                .parse::<usize>()
                .context("invalid WiiM Content-Length")
                .map_err(ExchangeError::Protocol)?;
            if parsed > MAX_RESPONSE_BYTES {
                return Err(ExchangeError::Protocol(anyhow::anyhow!(
                    "WiiM response exceeds size limit"
                )));
            }
            content_length = Some(parsed);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            if value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("chunked"))
            {
                chunked = true;
            }
        } else if name.eq_ignore_ascii_case("connection") {
            for token in value.split(',') {
                let token = token.trim();
                if token.eq_ignore_ascii_case("close") {
                    connection_close = true;
                } else if token.eq_ignore_ascii_case("keep-alive") {
                    connection_keep_alive = true;
                }
            }
        }
    }

    let http11 = version.eq_ignore_ascii_case("HTTP/1.1");
    let mut rest = buf.split_off(split + 4);
    let (body_bytes, explicit_framing) = if chunked {
        (read_chunked_body(reader, &mut rest).await?, true)
    } else if let Some(len) = content_length {
        (read_exact_body(reader, rest, len).await?, true)
    } else {
        (read_eof_body(reader, rest).await?, false)
    };

    let body = String::from_utf8(body_bytes)
        .context("WiiM body is not text")
        .map_err(ExchangeError::Protocol)?;
    let keep_alive = explicit_framing && !connection_close && (http11 || connection_keep_alive);
    Ok(HttpReply { body, keep_alive })
}

async fn read_exact_body<R: AsyncRead + Unpin>(
    reader: &mut R,
    mut body: Vec<u8>,
    len: usize,
) -> std::result::Result<Vec<u8>, ExchangeError> {
    if body.len() > len {
        body.truncate(len);
        return Ok(body);
    }
    body.reserve(len.saturating_sub(body.len()));
    let mut chunk = [0_u8; 4096];
    while body.len() < len {
        let want = (len - body.len()).min(chunk.len());
        let read = reader
            .read(&mut chunk[..want])
            .await
            .context("read WiiM body")
            .map_err(ExchangeError::Transport)?;
        if read == 0 {
            return Err(ExchangeError::Transport(anyhow::anyhow!(
                "WiiM closed connection mid-body"
            )));
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Ok(body)
}

async fn read_chunked_body<R: AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
) -> std::result::Result<Vec<u8>, ExchangeError> {
    let mut out = Vec::new();
    let mut scratch = [0_u8; 1024];
    loop {
        let line_end = loop {
            if let Some(pos) = buf.windows(2).position(|w| w == b"\r\n") {
                break pos;
            }
            if buf.len() > MAX_HEADER_BYTES {
                return Err(ExchangeError::Protocol(anyhow::anyhow!(
                    "WiiM chunk header is too large"
                )));
            }
            let read = reader
                .read(&mut scratch)
                .await
                .context("read WiiM chunk size")
                .map_err(ExchangeError::Transport)?;
            if read == 0 {
                return Err(ExchangeError::Transport(anyhow::anyhow!(
                    "WiiM closed connection in chunked body"
                )));
            }
            buf.extend_from_slice(&scratch[..read]);
        };
        let size_line = std::str::from_utf8(&buf[..line_end])
            .context("WiiM chunk size is not text")
            .map_err(ExchangeError::Protocol)?;
        let size_hex = size_line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_hex, 16)
            .context("invalid WiiM chunk size")
            .map_err(ExchangeError::Protocol)?;
        buf.drain(..line_end + 2);
        if size == 0 {
            // Consume trailing CRLF (or empty trailer section ending in CRLFCRLF).
            while !buf.starts_with(b"\r\n")
                && buf.windows(4).position(|w| w == b"\r\n\r\n").is_none()
            {
                if buf.len() > MAX_HEADER_BYTES {
                    return Err(ExchangeError::Protocol(anyhow::anyhow!(
                        "WiiM chunk trailer is too large"
                    )));
                }
                let read = reader
                    .read(&mut scratch)
                    .await
                    .context("read WiiM chunk trailer")
                    .map_err(ExchangeError::Transport)?;
                if read == 0 {
                    break;
                }
                buf.extend_from_slice(&scratch[..read]);
            }
            return Ok(out);
        }
        if out.len().saturating_add(size) > MAX_RESPONSE_BYTES {
            return Err(ExchangeError::Protocol(anyhow::anyhow!(
                "WiiM chunked response exceeds size limit"
            )));
        }
        while buf.len() < size + 2 {
            let read = reader
                .read(&mut scratch)
                .await
                .context("read WiiM chunk data")
                .map_err(ExchangeError::Transport)?;
            if read == 0 {
                return Err(ExchangeError::Transport(anyhow::anyhow!(
                    "WiiM closed connection inside chunk"
                )));
            }
            buf.extend_from_slice(&scratch[..read]);
        }
        out.extend_from_slice(&buf[..size]);
        if &buf[size..size + 2] != b"\r\n" {
            return Err(ExchangeError::Protocol(anyhow::anyhow!(
                "invalid WiiM chunk delimiter"
            )));
        }
        buf.drain(..size + 2);
    }
}

async fn read_eof_body<R: AsyncRead + Unpin>(
    reader: &mut R,
    mut body: Vec<u8>,
) -> std::result::Result<Vec<u8>, ExchangeError> {
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(ExchangeError::Protocol(anyhow::anyhow!(
            "WiiM response exceeds size limit"
        )));
    }
    let remaining = MAX_RESPONSE_BYTES.saturating_sub(body.len());
    // Devices often close without a TLS close_notify; the bytes read so far
    // are still the whole reply.
    let _ = reader.take(remaining as u64).read_to_end(&mut body).await;
    Ok(body)
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

    #[tokio::test]
    async fn reuses_keep_alive_connection_across_multiple_http11_replies() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let server_task = tokio::spawn(async move {
            let mut req = [0_u8; 512];
            let n1 = server.read(&mut req).await.unwrap();
            assert!(
                std::str::from_utf8(&req[..n1])
                    .unwrap()
                    .contains("command=getPlayerStatus HTTP/1.1")
            );
            server
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 29\r\n\r\n{\"mode\":\"31\",\"status\":\"stop\"}",
                )
                .await
                .unwrap();
            let n2 = server.read(&mut req).await.unwrap();
            assert!(
                std::str::from_utf8(&req[..n2])
                    .unwrap()
                    .contains("command=setPlayerCmd:switchmode:optical HTTP/1.1")
            );
            server
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
                .await
                .unwrap();
        });

        let first = exchange(&mut client, "192.168.10.194:443", "getPlayerStatus")
            .await
            .map_err(ExchangeError::into_anyhow)
            .unwrap();
        assert!(first.keep_alive);
        assert_eq!(PlayerStatus::parse(&first.body).unwrap().mode, "31");

        let second = exchange(
            &mut client,
            "192.168.10.194:443",
            "setPlayerCmd:switchmode:optical",
        )
        .await
        .map_err(ExchangeError::into_anyhow)
        .unwrap();
        assert!(second.keep_alive);
        assert_eq!(second.body, "OK");
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn parses_chunked_and_connection_close_replies() {
        let mut chunked: &[u8] =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nOK\r\n0\r\n\r\n";
        let reply = read_http_reply(&mut chunked)
            .await
            .map_err(ExchangeError::into_anyhow)
            .unwrap();
        assert_eq!(reply.body, "OK");
        assert!(reply.keep_alive);

        let mut close_eof: &[u8] =
            b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nOK";
        let reply = read_http_reply(&mut close_eof)
            .await
            .map_err(ExchangeError::into_anyhow)
            .unwrap();
        assert_eq!(reply.body, "OK");
        assert!(!reply.keep_alive);

        let mut err_status: &[u8] = b"HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\nno";
        assert!(matches!(
            read_http_reply(&mut err_status).await,
            Err(ExchangeError::Protocol(_))
        ));

        let mut eof: &[u8] = b"";
        assert!(matches!(
            read_http_reply(&mut eof).await,
            Err(ExchangeError::Transport(_))
        ));
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
        let wiim = Wiim::new(&host).unwrap();
        let t0 = std::time::Instant::now();
        let status = wiim.status().await.unwrap();
        let cold_ms = t0.elapsed().as_millis();
        let t1 = std::time::Instant::now();
        let warm = wiim.status().await.unwrap();
        let warm_ms = t1.elapsed().as_millis();
        println!(
            "mode={} status={} -> {:?} (cold={cold_ms} ms, warm={warm_ms} ms)",
            status.mode,
            status.status,
            status.decide()
        );
        assert_eq!(status, warm);
    }

    /// Switches a real device to Optical and reads it back. Changes the input:
    /// `LUGN_WIIM_HOST=192.168.1.50 cargo test --locked live_switch -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "switches the input of a real WiiM"]
    async fn live_switch() {
        let host = std::env::var("LUGN_WIIM_HOST").expect("set LUGN_WIIM_HOST");
        let wiim = Wiim::new(&host).unwrap();
        let before = wiim.status().await.unwrap();
        println!("before: mode={} status={}", before.mode, before.status);
        let started = std::time::Instant::now();
        wiim.switch_to_optical().await.unwrap();
        println!(
            "switched and confirmed (warm keep-alive) in {} ms",
            started.elapsed().as_millis()
        );
        assert!(wiim.status().await.unwrap().is_optical());
    }
}
