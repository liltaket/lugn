//! Fast WiiM Optical switching.
//!
//! When the computer plays real, sustained audio and the WiiM is not playing its
//! own music, the agent switches the WiiM to its Optical input directly over the
//! WiiM HTTP API. Nothing goes through MQTT or Lugn, so the switch happens within
//! roughly the confirmation window plus one LAN round trip.
//!
//! Audibility comes from the samples of the sink monitor (level only: samples are
//! reduced to a loudness decision per 20 ms frame and never stored, logged or sent
//! anywhere). A short notification sound is rejected by requiring a sustained run
//! that is mostly loud.

use std::{process::Stdio, sync::Arc, time::Duration};

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
    process::Command,
    sync::watch,
    time::{Instant, timeout},
};
use tokio_rustls::TlsConnector;

/// 48 kHz stereo s16le matches the sink, so nothing is resampled, and it makes
/// pw-record's fixed 4096-byte output blocks arrive every ~21 ms. A low-rate mono
/// capture would delay every block by a quarter of a second.
const SAMPLE_RATE: u32 = 48000;
const CHANNELS: usize = 2;
const FRAME_MS: u32 = 20;
const FRAME_BYTES: usize = (SAMPLE_RATE * FRAME_MS / 1000) as usize * CHANNELS * 2;
/// A frame counts as sound at -55 dBFS RMS (32768 * 10^(-55/20)).
const LOUD_RMS: f64 = 58.0;
/// Silence tolerated inside a run (speech and music have gaps) before it ends.
const GAP_MS: u32 = 200;
/// Silence that ends a confirmed run.
const RELEASE_MS: u32 = 1500;
/// Share of frames in a run that must be loud, so a few clicks never count.
const MIN_LOUD_PERCENT: u32 = 60;
/// A suspended sink delivers no data; treat that much waiting as silence.
const DEAD_AIR_MS: u64 = 400;

const WIIM_MODE_OPTICAL: &str = "43";
const REQUEST_TIMEOUT: Duration = Duration::from_millis(2500);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// Re-check a busy WiiM this often while the computer keeps playing.
const BUSY_RECHECK: Duration = Duration::from_secs(2);
/// A status read this fresh may decide a switch without another round trip.
const STATUS_MAX_AGE: Duration = Duration::from_secs(3);
const RETRY_AFTER_ERROR: Duration = Duration::from_secs(3);
const VERIFY_ATTEMPTS: u32 = 6;
/// Failed switches per run of sound before the agent leaves the WiiM alone.
const MAX_SWITCH_FAILURES: u32 = 3;
const VERIFY_DELAY: Duration = Duration::from_millis(400);

pub struct Settings {
    pub host: String,
    pub sink: Option<String>,
    pub min_audible_ms: u32,
}

pub async fn run(settings: Settings) {
    let (activity_tx, activity) = watch::channel(Activity::Silent);
    let wiim = match Wiim::new(&settings.host) {
        Ok(wiim) => wiim,
        Err(error) => {
            eprintln!("Optical switching disabled: {error:#}");
            return;
        }
    };
    tokio::spawn(capture_forever(
        settings.sink,
        settings.min_audible_ms,
        activity_tx,
    ));
    switch_forever(wiim, activity).await;
}

// ---------------------------------------------------------------------------
// Audibility detection
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activity {
    Silent,
    /// Sound has started but is not yet long and dense enough to count.
    Sounding,
    /// Sustained, mostly loud audio.
    Confirmed,
}

/// Pure state machine over a sample clock: every frame advances time, so tests
/// and live capture behave identically and no wall clock is involved.
pub struct Detector {
    min_ms: u32,
    clock: u64,
    run_start: Option<u64>,
    frames: u32,
    loud_frames: u32,
    last_loud: u64,
    state: Activity,
}

impl Detector {
    pub fn new(min_ms: u32) -> Self {
        Self {
            min_ms,
            clock: 0,
            run_start: None,
            frames: 0,
            loud_frames: 0,
            last_loud: 0,
            state: Activity::Silent,
        }
    }

    /// Advances by `ms` of audio that was `loud` or quiet. Returns the new state
    /// when it changed.
    pub fn advance(&mut self, ms: u32, loud: bool) -> Option<Activity> {
        self.clock += u64::from(ms);
        if loud {
            if self.run_start.is_none() {
                self.run_start = Some(self.clock - u64::from(ms));
                self.frames = 0;
                self.loud_frames = 0;
            }
            self.frames += 1;
            self.loud_frames += 1;
            self.last_loud = self.clock;
        } else if self.run_start.is_some() {
            self.frames += 1;
        }
        let next = match self.run_start {
            None => Activity::Silent,
            Some(start) => {
                let limit = if self.state == Activity::Confirmed {
                    RELEASE_MS
                } else {
                    GAP_MS
                };
                if self.clock - self.last_loud > u64::from(limit) {
                    self.run_start = None;
                    Activity::Silent
                } else if self.state == Activity::Confirmed
                    || (self.last_loud - start >= u64::from(self.min_ms)
                        && self.loud_frames * 100 >= self.frames * MIN_LOUD_PERCENT)
                {
                    Activity::Confirmed
                } else {
                    Activity::Sounding
                }
            }
        };
        (next != std::mem::replace(&mut self.state, next)).then_some(next)
    }
}

fn frame_is_loud(frame: &[u8]) -> bool {
    let count = frame.len() / 2;
    if count == 0 {
        return false;
    }
    let sum: f64 = frame
        .chunks_exact(2)
        .map(|b| {
            let s = f64::from(i16::from_le_bytes([b[0], b[1]]));
            s * s
        })
        .sum();
    (sum / count as f64).sqrt() >= LOUD_RMS
}

async fn capture_forever(sink: Option<String>, min_ms: u32, tx: watch::Sender<Activity>) {
    let mut retry = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        let result = capture(sink.as_deref(), min_ms, &tx).await;
        tx.send_replace(Activity::Silent);
        if let Err(error) = result {
            eprintln!("Optical audio capture unavailable: {error:#}");
        }
        if started.elapsed() >= Duration::from_secs(30) {
            retry = Duration::from_secs(1);
        }
        tokio::time::sleep(retry).await;
        retry = (retry * 2).min(Duration::from_secs(30));
    }
}

async fn capture(sink: Option<&str>, min_ms: u32, tx: &watch::Sender<Activity>) -> Result<()> {
    let mut command = Command::new("pw-record");
    command.args(["-P", "{ stream.capture.sink=true }"]);
    if let Some(sink) = sink {
        command.args(["--target", sink]);
    }
    let mut child = command
        .args([
            "--raw",
            "--rate",
            &SAMPLE_RATE.to_string(),
            "--channels",
            &CHANNELS.to_string(),
            "--format",
            "s16",
            "--latency",
            "20ms",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("start pw-record")?;
    let mut stdout = child.stdout.take().context("pw-record stdout")?;
    let mut detector = Detector::new(min_ms);
    let mut pending: Vec<u8> = Vec::with_capacity(FRAME_BYTES * 4);
    let mut chunk = [0_u8; 4096];
    let result = async {
        loop {
            let read =
                match timeout(Duration::from_millis(DEAD_AIR_MS), stdout.read(&mut chunk)).await {
                    Ok(read) => read.context("read pw-record")?,
                    Err(_) => {
                        if let Some(state) = detector.advance(DEAD_AIR_MS as u32, false) {
                            tx.send_replace(state);
                        }
                        continue;
                    }
                };
            if read == 0 {
                bail!("pw-record closed its stream");
            }
            pending.extend_from_slice(&chunk[..read]);
            let whole = pending.len() / FRAME_BYTES * FRAME_BYTES;
            for frame in pending[..whole].chunks_exact(FRAME_BYTES) {
                if let Some(state) = detector.advance(FRAME_MS, frame_is_loud(frame)) {
                    tx.send_replace(state);
                }
            }
            pending.drain(..whole);
        }
    }
    .await;
    let _ = child.kill().await;
    result
}

// ---------------------------------------------------------------------------
// Switching policy
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
    pub fn parse(body: &str) -> Result<Self> {
        let value: Value = serde_json::from_str(body).context("WiiM status is not JSON")?;
        let field = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
        Ok(Self {
            mode: field("mode").context("WiiM status has no mode")?,
            status: field("status").context("WiiM status has no status")?,
        })
    }

    pub fn decide(&self) -> Decision {
        if self.mode == WIIM_MODE_OPTICAL {
            Decision::AlreadyOptical
        } else if matches!(self.status.as_str(), "play" | "load") {
            Decision::Busy
        } else {
            Decision::Switch
        }
    }
}

struct Cached {
    status: PlayerStatus,
    at: Instant,
}

async fn switch_forever(wiim: Wiim, mut activity: watch::Receiver<Activity>) {
    loop {
        if *activity.borrow_and_update() == Activity::Silent
            && activity.wait_for(|a| *a != Activity::Silent).await.is_err()
        {
            return;
        }
        let episode_start = Instant::now();
        // Sound has started: read the WiiM now so the confirmation only has to
        // send the switch.
        let mut cached = match wiim.status().await {
            Ok(status) => Some(Cached {
                status,
                at: Instant::now(),
            }),
            Err(_) => None,
        };
        if activity
            .wait_for(|a| *a != Activity::Sounding)
            .await
            .is_err()
        {
            return;
        }
        if *activity.borrow() == Activity::Silent {
            continue; // A short sound; never switch for it.
        }
        let mut failures = 0;
        'episode: loop {
            let status = match cached.take() {
                Some(c) if c.at.elapsed() < STATUS_MAX_AGE => Ok(c.status),
                _ => wiim.status().await,
            };
            let pause = match status.map(|s| s.decide()) {
                Ok(Decision::AlreadyOptical) => break 'episode,
                Ok(Decision::Busy) => BUSY_RECHECK,
                Ok(Decision::Switch) => match wiim.switch_to_optical().await {
                    Ok(()) => {
                        eprintln!(
                            "WiiM switched to Optical {} ms after the sound started",
                            episode_start.elapsed().as_millis()
                        );
                        break 'episode;
                    }
                    Err(error) => {
                        eprintln!("WiiM Optical switch failed: {error:#}");
                        failures += 1;
                        if failures >= MAX_SWITCH_FAILURES {
                            eprintln!("Giving up on Optical until the sound has stopped");
                            break 'episode;
                        }
                        RETRY_AFTER_ERROR
                    }
                },
                Err(error) => {
                    eprintln!("WiiM status unavailable: {error:#}");
                    RETRY_AFTER_ERROR
                }
            };
            // Keep trying only while the computer keeps playing.
            tokio::select! {
                changed = activity.wait_for(|a| *a == Activity::Silent) => {
                    if changed.is_err() { return; }
                    break 'episode;
                }
                _ = tokio::time::sleep(pause) => {}
            }
        }
        // One decision per run of sound: wait for it to end before reacting
        // again, so a deliberate source choice is never fought.
        if activity.wait_for(|a| *a == Activity::Silent).await.is_err() {
            return;
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
            if self.status().await?.mode == WIIM_MODE_OPTICAL {
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

pub fn validate_sink(sink: &str) -> Result<()> {
    ensure!(
        !sink.is_empty()
            && sink.len() <= 128
            && sink
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c)),
        "optical_audio_sink must be a PipeWire node name (letters, digits and . _ : -)"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(detector: &mut Detector, ms: u32, loud: bool) -> Vec<Activity> {
        (0..ms / FRAME_MS)
            .filter_map(|_| detector.advance(FRAME_MS, loud))
            .collect()
    }

    #[test]
    fn a_short_beep_never_confirms() {
        let mut d = Detector::new(400);
        let mut seen = feed(&mut d, 300, true);
        seen.extend(feed(&mut d, 2000, false));
        assert_eq!(seen, vec![Activity::Sounding, Activity::Silent]);
    }

    #[test]
    fn sustained_sound_confirms_at_the_minimum_duration() {
        let mut d = Detector::new(400);
        let seen = feed(&mut d, 380, true);
        assert_eq!(seen, vec![Activity::Sounding]);
        assert_eq!(d.advance(FRAME_MS, true), Some(Activity::Confirmed));
    }

    #[test]
    fn short_gaps_do_not_end_or_prevent_a_run() {
        let mut d = Detector::new(400);
        let mut seen = Vec::new();
        for _ in 0..4 {
            seen.extend(feed(&mut d, 140, true));
            seen.extend(feed(&mut d, 60, false));
        }
        assert_eq!(seen, vec![Activity::Sounding, Activity::Confirmed]);
        // Confirmed runs survive pauses shorter than the release time.
        assert!(feed(&mut d, 1000, false).is_empty());
        assert!(feed(&mut d, 100, true).is_empty());
    }

    #[test]
    fn sparse_clicks_do_not_confirm() {
        let mut d = Detector::new(400);
        let mut seen = Vec::new();
        for _ in 0..8 {
            seen.extend(feed(&mut d, 20, true));
            seen.extend(feed(&mut d, 80, false));
        }
        assert!(!seen.contains(&Activity::Confirmed));
    }

    #[test]
    fn a_confirmed_run_releases_after_silence() {
        let mut d = Detector::new(400);
        feed(&mut d, 500, true);
        assert!(feed(&mut d, 1400, false).is_empty());
        assert_eq!(feed(&mut d, 200, false), vec![Activity::Silent]);
    }

    #[test]
    fn dead_air_counts_as_silence() {
        let mut d = Detector::new(400);
        feed(&mut d, 500, true);
        let mut released = None;
        for _ in 0..7 {
            released = released.or(d.advance(DEAD_AIR_MS as u32, false));
        }
        assert_eq!(released, Some(Activity::Silent));
    }

    #[test]
    fn frame_loudness_uses_rms() {
        let loud: Vec<u8> = (0..FRAME_BYTES / 2)
            .flat_map(|_| 1000_i16.to_le_bytes())
            .collect();
        let quiet: Vec<u8> = (0..FRAME_BYTES / 2)
            .flat_map(|_| 20_i16.to_le_bytes())
            .collect();
        assert!(frame_is_loud(&loud));
        assert!(!frame_is_loud(&quiet));
        assert!(!frame_is_loud(&[0; FRAME_BYTES]));
    }

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
    fn validates_host_and_sink() {
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
        assert!(validate_sink("alsa_output.pci-0000_00_1f.3.iec958-stereo").is_ok());
        assert!(validate_sink("a b").is_err());
        assert!(validate_sink("").is_err());
    }
}
