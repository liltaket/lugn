//! Fast WiiM Optical switching.
//!
//! When the computer plays real, sustained audio and the WiiM is not playing its
//! own music, the agent switches the WiiM to its Optical input directly over the
//! WiiM HTTP API (see `wiim.rs`). Nothing goes through MQTT or Lugn, so the
//! switch happens within roughly the confirmation window plus one LAN round trip.
//!
//! Audibility comes from the samples of the sink monitor (level only: samples are
//! reduced to a loudness decision per 20 ms frame and never stored, logged or sent
//! anywhere). A short notification sound is rejected by requiring a sustained run
//! that is mostly loud.
//!
//! Settings come from the agent's configuration file and, when Lugn publishes
//! them (OPTICAL v1), from the control panel. The WiiM is found with SSDP when no
//! address is set.

use std::{
    net::{Ipv4Addr, SocketAddr},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncReadExt,
    net::UdpSocket,
    process::Command,
    sync::watch,
    time::{Instant, timeout, timeout_at},
};

use crate::{
    control::now_ms,
    wiim::{Decision, PlayerStatus, Wiim, validate_lan_host},
};

/// 48 kHz stereo s16le matches the sink, so nothing is resampled, and it makes
/// pw-record's fixed 4096-byte output blocks arrive every ~21 ms. A low-rate mono
/// capture would delay every block by a quarter of a second.
const SAMPLE_RATE: u32 = 48000;
const CHANNELS: usize = 2;
const FRAME_MS: u32 = 20;
const FRAME_BYTES: usize = (SAMPLE_RATE * FRAME_MS / 1000) as usize * CHANNELS * 2;
/// Silence tolerated inside a run (speech and music have gaps) before it ends.
const GAP_MS: u32 = 200;
/// Share of frames in a run that must be loud, so a few clicks never count.
const MIN_LOUD_PERCENT: u32 = 60;
/// A suspended sink delivers no data; treat that much waiting as silence.
const DEAD_AIR_MS: u64 = 400;

/// Re-check a busy WiiM this often while the computer keeps playing.
const BUSY_RECHECK: Duration = Duration::from_secs(2);
/// A status read this fresh may decide a switch without another round trip.
const STATUS_MAX_AGE: Duration = Duration::from_secs(3);
const RETRY_AFTER_ERROR: Duration = Duration::from_secs(3);
/// Failed switches per run of sound before the agent leaves the WiiM alone.
const MAX_SWITCH_FAILURES: u32 = 3;
/// A discovered WiiM that fails this many reads in a row is looked up again.
const REDISCOVER_AFTER_FAILURES: u32 = 3;
const DISCOVERY_RETRY_MIN: Duration = Duration::from_secs(30);
const DISCOVERY_RETRY_MAX: Duration = Duration::from_secs(300);
const SSDP_ADDRESS: (&str, u16) = ("239.255.255.250", 1900);
const SSDP_LISTEN: Duration = Duration::from_millis(2500);
const MAX_CANDIDATES: usize = 16;

pub const MIN_AUDIBLE_MS: std::ops::RangeInclusive<u32> = 200..=5000;
pub const RELEASE_MS: std::ops::RangeInclusive<u32> = 500..=10_000;
pub const LEVEL_DB: std::ops::RangeInclusive<i32> = -80..=-20;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// What the optical switcher runs with.
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    /// `None`: look for a WiiM on the LAN.
    pub host: Option<String>,
    /// Exact PipeWire sink node name; `None` follows the default sink.
    pub sink: Option<String>,
    pub min_audible_ms: u32,
    /// Silence that ends a confirmed run of sound.
    pub release_ms: u32,
    /// Loudness above which a frame counts as sound, in dBFS.
    pub level_db: i32,
}

/// OPTICAL v1 settings message from Lugn (`optical/settings`, retained).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Remote {
    schema_version: u8,
    device_id: String,
    generation: String,
    enabled: bool,
    wiim_host: Option<String>,
    audio_sink: Option<String>,
    min_audible_ms: u32,
    release_ms: u32,
    level_db: i32,
}

impl Remote {
    /// Returns the message only when every field is in range and the host is on
    /// the LAN; anything else is ignored whole.
    pub fn parse(device_id: &str, payload: &[u8]) -> Option<Self> {
        if payload.len() > 4096 {
            return None;
        }
        let remote: Self = serde_json::from_slice(payload).ok()?;
        let valid = remote.schema_version == 1
            && remote.device_id == device_id
            && !remote.generation.is_empty()
            && remote.generation.len() <= 36
            && remote
                .generation
                .bytes()
                .all(|c| c.is_ascii_hexdigit() || c == b'-')
            && MIN_AUDIBLE_MS.contains(&remote.min_audible_ms)
            && RELEASE_MS.contains(&remote.release_ms)
            && LEVEL_DB.contains(&remote.level_db)
            && remote
                .wiim_host
                .as_deref()
                .is_none_or(|host| validate_lan_host(host).is_ok())
            && remote
                .audio_sink
                .as_deref()
                .is_none_or(|sink| validate_sink(sink).is_ok());
        valid.then_some(remote)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostSource {
    Config,
    Lugn,
    Discovered,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingsSource {
    Config,
    Lugn,
}

struct Effective {
    settings: Settings,
    host_source: Option<HostSource>,
    source: SettingsSource,
    generation: Option<String>,
}

/// Lugn's message replaces every tunable; a host left empty there falls back to
/// the one in the agent's file, then to discovery.
fn effective(base: &Settings, remote: Option<&Remote>) -> Effective {
    let Some(remote) = remote else {
        return Effective {
            settings: base.clone(),
            host_source: base.host.as_ref().map(|_| HostSource::Config),
            source: SettingsSource::Config,
            generation: None,
        };
    };
    let (host, host_source) = match (&remote.wiim_host, &base.host) {
        (Some(host), _) => (Some(host.clone()), Some(HostSource::Lugn)),
        (None, Some(host)) => (Some(host.clone()), Some(HostSource::Config)),
        (None, None) => (None, None),
    };
    Effective {
        settings: Settings {
            enabled: remote.enabled,
            host,
            sink: remote.audio_sink.clone().or_else(|| base.sink.clone()),
            min_audible_ms: remote.min_audible_ms,
            release_ms: remote.release_ms,
            level_db: remote.level_db,
        },
        host_source,
        source: SettingsSource::Lugn,
        generation: Some(remote.generation.clone()),
    }
}

// ---------------------------------------------------------------------------
// Status (published as OPTICAL v1 `optical/state`)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Disabled,
    /// No address yet; looking for a WiiM.
    Searching,
    Idle,
    /// Sustained sound is playing.
    Sound,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capture {
    Off,
    Ok,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct WiimReading {
    pub reachable: bool,
    pub optical: Option<bool>,
    pub playing: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SwitchOutcome {
    Switched,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct LastSwitch {
    pub outcome: SwitchOutcome,
    pub timestamp_ms: u64,
    /// From the start of the sound to the confirmed switch; 0 for a failure.
    pub latency_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Status {
    pub phase: Phase,
    pub capture: Capture,
    pub host: Option<String>,
    pub host_source: Option<HostSource>,
    pub wiim: Option<WiimReading>,
    /// LinkPlay devices found by the last search, at most eight.
    pub discovered: Vec<String>,
    pub last_switch: Option<LastSwitch>,
    pub settings_source: SettingsSource,
    pub settings_generation: Option<String>,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            phase: Phase::Disabled,
            capture: Capture::Off,
            host: None,
            host_source: None,
            wiim: None,
            discovered: Vec::new(),
            last_switch: None,
            settings_source: SettingsSource::Config,
            settings_generation: None,
        }
    }
}

fn set(status: &watch::Sender<Status>, change: impl FnOnce(&mut Status)) {
    status.send_if_modified(|current| {
        let before = current.clone();
        change(current);
        *current != before
    });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Handle {
    remote: Arc<watch::Sender<Option<Remote>>>,
    pub status: watch::Receiver<Status>,
}

/// OPTICAL v1 `optical/state` message.
#[derive(Serialize)]
pub struct State {
    pub schema_version: u8,
    pub device_id: String,
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub heartbeat_interval_ms: u64,
    #[serde(flatten)]
    pub status: Status,
}

impl Handle {
    /// Applies a validated settings message from Lugn; an identical one (for
    /// example a retained redelivery after reconnecting) changes nothing.
    pub fn apply_remote(&self, remote: Remote) {
        self.remote.send_if_modified(|current| {
            if current.as_ref() == Some(&remote) {
                return false;
            }
            *current = Some(remote);
            true
        });
    }
}

pub fn spawn(base: Settings) -> Handle {
    let (remote_tx, remote_rx) = watch::channel(None);
    let (status_tx, status_rx) = watch::channel(Status::default());
    tokio::spawn(manage(base, remote_rx, status_tx));
    Handle {
        remote: Arc::new(remote_tx),
        status: status_rx,
    }
}

async fn manage(
    base: Settings,
    mut remote: watch::Receiver<Option<Remote>>,
    status: watch::Sender<Status>,
) {
    loop {
        let current = remote.borrow_and_update().clone();
        let effective = effective(&base, current.as_ref());
        set(&status, |s| {
            s.settings_source = effective.source;
            s.settings_generation = effective.generation.clone();
        });
        tokio::select! {
            _ = run_enabled(&effective, &status) => {}
            changed = remote.changed() => {
                if changed.is_err() { return; }
                continue;
            }
        }
        // Disabled or unusable: nothing to do until the settings change.
        if remote.changed().await.is_err() {
            return;
        }
    }
}

/// Runs until the settings change (the caller drops it) or returns at once when
/// disabled or unusable.
async fn run_enabled(effective: &Effective, status: &watch::Sender<Status>) {
    let settings = &effective.settings;
    if !settings.enabled {
        set(status, |s| {
            s.phase = Phase::Disabled;
            s.capture = Capture::Off;
            s.host = None;
            s.host_source = None;
            s.wiim = None;
        });
        return;
    }
    loop {
        let (host, source) = match (&settings.host, effective.host_source) {
            (Some(host), Some(source)) => (host.clone(), source),
            _ => (discover(status).await, HostSource::Discovered),
        };
        set(status, |s| {
            s.phase = Phase::Idle;
            s.host = Some(host.clone());
            s.host_source = Some(source);
            s.wiim = None;
        });
        match session(settings, &host, source == HostSource::Discovered, status).await {
            End::Invalid => {
                eprintln!("Optical switching has no usable WiiM address");
                set(status, |s| {
                    s.phase = Phase::Disabled;
                    s.capture = Capture::Off;
                });
                return;
            }
            End::Rediscover => {
                eprintln!("WiiM stopped answering; searching again");
            }
        }
    }
}

enum End {
    Invalid,
    Rediscover,
}

async fn session(
    settings: &Settings,
    host: &str,
    discovered: bool,
    status: &watch::Sender<Status>,
) -> End {
    let wiim = match Wiim::new(host) {
        Ok(wiim) => wiim,
        Err(_) => return End::Invalid,
    };
    let (activity_tx, activity) = watch::channel(Activity::Silent);
    tokio::select! {
        _ = capture_forever(settings, activity_tx, status) => unreachable!("capture never ends"),
        end = switch_forever(&wiim, activity, status, discovered) => end,
    }
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
    release_ms: u32,
    clock: u64,
    run_start: Option<u64>,
    frames: u32,
    loud_frames: u32,
    last_loud: u64,
    state: Activity,
}

impl Detector {
    pub fn new(min_ms: u32, release_ms: u32) -> Self {
        Self {
            min_ms,
            release_ms,
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
                    self.release_ms
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

/// RMS amplitude (of 32768) equal to `level_db` dBFS.
fn threshold(level_db: i32) -> f64 {
    32768.0 * 10_f64.powf(f64::from(level_db) / 20.0)
}

fn frame_is_loud(frame: &[u8], threshold: f64) -> bool {
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
    (sum / count as f64).sqrt() >= threshold
}

async fn capture_forever(
    settings: &Settings,
    tx: watch::Sender<Activity>,
    status: &watch::Sender<Status>,
) {
    let mut retry = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        let result = capture(settings, &tx, status).await;
        tx.send_replace(Activity::Silent);
        set(status, |s| {
            s.capture = Capture::Unavailable;
            s.phase = Phase::Idle;
        });
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

async fn capture(
    settings: &Settings,
    tx: &watch::Sender<Activity>,
    status: &watch::Sender<Status>,
) -> Result<()> {
    let mut command = Command::new("pw-record");
    command.args(["-P", "{ stream.capture.sink=true }"]);
    if let Some(sink) = &settings.sink {
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
            "10ms",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("start pw-record")?;
    let mut stdout = child.stdout.take().context("pw-record stdout")?;
    let mut detector = Detector::new(settings.min_audible_ms, settings.release_ms);
    let level = threshold(settings.level_db);
    let mut pending: Vec<u8> = Vec::with_capacity(FRAME_BYTES * 4);
    let mut chunk = [0_u8; 4096];
    let publish = |state: Activity| {
        tx.send_replace(state);
        set(status, |s| {
            s.phase = if state == Activity::Confirmed {
                Phase::Sound
            } else {
                Phase::Idle
            };
        });
    };
    let result = async {
        loop {
            let read =
                match timeout(Duration::from_millis(DEAD_AIR_MS), stdout.read(&mut chunk)).await {
                    Ok(read) => read.context("read pw-record")?,
                    Err(_) => {
                        if let Some(state) = detector.advance(DEAD_AIR_MS as u32, false) {
                            publish(state);
                        }
                        continue;
                    }
                };
            if read == 0 {
                bail!("pw-record closed its stream");
            }
            set(status, |s| s.capture = Capture::Ok);
            pending.extend_from_slice(&chunk[..read]);
            let whole = pending.len() / FRAME_BYTES * FRAME_BYTES;
            for frame in pending[..whole].chunks_exact(FRAME_BYTES) {
                if let Some(state) = detector.advance(FRAME_MS, frame_is_loud(frame, level)) {
                    publish(state);
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
// Switching
// ---------------------------------------------------------------------------

struct Cached {
    status: PlayerStatus,
    at: Instant,
}

/// Reads the WiiM and records what was seen. Counts consecutive failures so a
/// discovered device that moved can be looked up again.
async fn read_wiim(
    wiim: &Wiim,
    status: &watch::Sender<Status>,
    failures: &mut u32,
) -> Result<PlayerStatus> {
    match wiim.status().await {
        Ok(player) => {
            *failures = 0;
            set(status, |s| {
                s.wiim = Some(WiimReading {
                    reachable: true,
                    optical: Some(player.is_optical()),
                    playing: Some(player.is_playing()),
                })
            });
            Ok(player)
        }
        Err(error) => {
            *failures += 1;
            set(status, |s| {
                s.wiim = Some(WiimReading {
                    reachable: false,
                    optical: None,
                    playing: None,
                })
            });
            Err(error)
        }
    }
}

async fn switch_forever(
    wiim: &Wiim,
    mut activity: watch::Receiver<Activity>,
    status: &watch::Sender<Status>,
    rediscover: bool,
) -> End {
    let mut read_failures = 0;
    loop {
        if *activity.borrow_and_update() == Activity::Silent
            && activity.wait_for(|a| *a != Activity::Silent).await.is_err()
        {
            return End::Invalid;
        }
        let episode_start = Instant::now();
        // Sound has started: read the WiiM now so the confirmation only has to
        // send the switch.
        let mut cached = read_wiim(wiim, status, &mut read_failures)
            .await
            .ok()
            .map(|status| Cached {
                status,
                at: Instant::now(),
            });
        if activity
            .wait_for(|a| *a != Activity::Sounding)
            .await
            .is_err()
        {
            return End::Invalid;
        }
        if *activity.borrow() == Activity::Silent {
            continue; // A short sound; never switch for it.
        }
        let mut failures = 0;
        'episode: loop {
            if rediscover && read_failures >= REDISCOVER_AFTER_FAILURES {
                return End::Rediscover;
            }
            let player = match cached.take() {
                Some(c) if c.at.elapsed() < STATUS_MAX_AGE => Ok(c.status),
                _ => read_wiim(wiim, status, &mut read_failures).await,
            };
            let pause = match player.map(|p| p.decide()) {
                Ok(Decision::AlreadyOptical) => break 'episode,
                Ok(Decision::Busy) => BUSY_RECHECK,
                Ok(Decision::Switch) => match wiim.switch_to_optical().await {
                    Ok(()) => {
                        let latency_ms = episode_start.elapsed().as_millis() as u64;
                        eprintln!(
                            "WiiM switched to Optical {latency_ms} ms after the sound started"
                        );
                        set(status, |s| {
                            s.wiim = Some(WiimReading {
                                reachable: true,
                                optical: Some(true),
                                playing: s.wiim.and_then(|w| w.playing),
                            });
                            s.last_switch = Some(LastSwitch {
                                outcome: SwitchOutcome::Switched,
                                timestamp_ms: now_ms(),
                                latency_ms,
                            });
                        });
                        break 'episode;
                    }
                    Err(error) => {
                        eprintln!("WiiM Optical switch failed: {error:#}");
                        set(status, |s| {
                            s.last_switch = Some(LastSwitch {
                                outcome: SwitchOutcome::Failed,
                                timestamp_ms: now_ms(),
                                latency_ms: 0,
                            });
                        });
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
                    if changed.is_err() { return End::Invalid; }
                    break 'episode;
                }
                _ = tokio::time::sleep(pause) => {}
            }
        }
        // One decision per run of sound: wait for it to end before reacting
        // again, so a deliberate source choice is never fought.
        if activity.wait_for(|a| *a == Activity::Silent).await.is_err() {
            return End::Invalid;
        }
    }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// Finds the one WiiM on the LAN, retrying with a growing delay while there is
/// none or several. Several devices are reported in the status and left for the
/// user to choose.
async fn discover(status: &watch::Sender<Status>) -> String {
    set(status, |s| {
        s.phase = Phase::Searching;
        s.host = None;
        s.host_source = None;
        s.wiim = None;
    });
    let mut delay = DISCOVERY_RETRY_MIN;
    let mut reported = Vec::new();
    loop {
        let found = find_wiims().await;
        set(status, |s| {
            s.discovered = found.iter().take(8).cloned().collect()
        });
        match found.as_slice() {
            [only] => {
                eprintln!("Found the WiiM automatically");
                return only.clone();
            }
            [] => {}
            _ if reported != found => {
                eprintln!("Several WiiM devices found; set the address in the settings");
                reported = found;
            }
            _ => {}
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(DISCOVERY_RETRY_MAX);
    }
}

/// SSDP search for media renderers on the LAN, each confirmed by asking for its
/// WiiM player status. Only private IPv4 senders are considered.
async fn find_wiims() -> Vec<String> {
    let candidates = ssdp_candidates().await;
    let probes = candidates.iter().map(|ip| async move {
        let ok = match Wiim::new(ip) {
            Ok(wiim) => wiim.status().await.is_ok(),
            Err(_) => false,
        };
        ok.then(|| ip.clone())
    });
    let mut found: Vec<String> = futures_util::future::join_all(probes)
        .await
        .into_iter()
        .flatten()
        .collect();
    found.sort();
    found
}

async fn ssdp_candidates() -> Vec<String> {
    let Ok(socket) = UdpSocket::bind(("0.0.0.0", 0)).await else {
        return Vec::new();
    };
    let request = format!(
        "M-SEARCH * HTTP/1.1\r\nHOST: {}:{}\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n",
        SSDP_ADDRESS.0, SSDP_ADDRESS.1
    );
    for _ in 0..2 {
        let _ = socket.send_to(request.as_bytes(), SSDP_ADDRESS).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let deadline = Instant::now() + SSDP_LISTEN;
    let mut found: Vec<String> = Vec::new();
    let mut buffer = [0_u8; 2048];
    while let Ok(Ok((_, from))) = timeout_at(deadline, socket.recv_from(&mut buffer)).await {
        if let Some(ip) = lan_sender(from) {
            if !found.contains(&ip) && found.len() < MAX_CANDIDATES {
                found.push(ip);
            }
        }
    }
    found
}

fn lan_sender(from: SocketAddr) -> Option<String> {
    match from {
        SocketAddr::V4(v4) => {
            let ip: &Ipv4Addr = v4.ip();
            (ip.is_private() || ip.is_link_local()).then(|| ip.to_string())
        }
        SocketAddr::V6(_) => None,
    }
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

    const MIN: u32 = 400;
    const RELEASE: u32 = 1500;

    fn detector() -> Detector {
        Detector::new(MIN, RELEASE)
    }

    fn feed(detector: &mut Detector, ms: u32, loud: bool) -> Vec<Activity> {
        (0..ms / FRAME_MS)
            .filter_map(|_| detector.advance(FRAME_MS, loud))
            .collect()
    }

    fn base() -> Settings {
        Settings {
            enabled: true,
            host: None,
            sink: None,
            min_audible_ms: MIN,
            release_ms: RELEASE,
            level_db: -55,
        }
    }

    #[test]
    fn a_short_beep_never_confirms() {
        let mut d = detector();
        let mut seen = feed(&mut d, 300, true);
        seen.extend(feed(&mut d, 2000, false));
        assert_eq!(seen, vec![Activity::Sounding, Activity::Silent]);
    }

    #[test]
    fn sustained_sound_confirms_at_the_minimum_duration() {
        let mut d = detector();
        let seen = feed(&mut d, 380, true);
        assert_eq!(seen, vec![Activity::Sounding]);
        assert_eq!(d.advance(FRAME_MS, true), Some(Activity::Confirmed));
    }

    #[test]
    fn a_shorter_minimum_confirms_sooner() {
        let mut d = Detector::new(200, RELEASE);
        assert_eq!(feed(&mut d, 180, true), vec![Activity::Sounding]);
        assert_eq!(d.advance(FRAME_MS, true), Some(Activity::Confirmed));
    }

    #[test]
    fn short_gaps_do_not_end_or_prevent_a_run() {
        let mut d = detector();
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
        let mut d = detector();
        let mut seen = Vec::new();
        for _ in 0..8 {
            seen.extend(feed(&mut d, 20, true));
            seen.extend(feed(&mut d, 80, false));
        }
        assert!(!seen.contains(&Activity::Confirmed));
    }

    #[test]
    fn a_confirmed_run_releases_after_the_release_time() {
        let mut d = detector();
        feed(&mut d, 500, true);
        assert!(feed(&mut d, 1400, false).is_empty());
        assert_eq!(feed(&mut d, 200, false), vec![Activity::Silent]);
        let mut quick = Detector::new(MIN, 500);
        feed(&mut quick, 500, true);
        assert_eq!(feed(&mut quick, 600, false), vec![Activity::Silent]);
    }

    #[test]
    fn dead_air_counts_as_silence() {
        let mut d = detector();
        feed(&mut d, 500, true);
        let mut released = None;
        for _ in 0..7 {
            released = released.or(d.advance(DEAD_AIR_MS as u32, false));
        }
        assert_eq!(released, Some(Activity::Silent));
    }

    #[test]
    fn frame_loudness_uses_rms_and_the_threshold() {
        let loud: Vec<u8> = (0..FRAME_BYTES / 2)
            .flat_map(|_| 1000_i16.to_le_bytes())
            .collect();
        let quiet: Vec<u8> = (0..FRAME_BYTES / 2)
            .flat_map(|_| 20_i16.to_le_bytes())
            .collect();
        let level = threshold(-55);
        assert!((level - 58.3).abs() < 0.1);
        assert!(frame_is_loud(&loud, level));
        assert!(!frame_is_loud(&quiet, level));
        assert!(!frame_is_loud(&[0; FRAME_BYTES], level));
        // A more sensitive threshold hears the quiet frame, a stricter one not the loud.
        assert!(frame_is_loud(&quiet, threshold(-70)));
        assert!(!frame_is_loud(&loud, threshold(-20)));
    }

    fn message(extra: &str) -> Vec<u8> {
        format!(
            r#"{{"schema_version":1,"device_id":"desktop","generation":"11111111-2222-3333-4444-555555555555","enabled":true,"wiim_host":null,"audio_sink":null,"min_audible_ms":300,"release_ms":1200,"level_db":-60{extra}}}"#
        )
        .into_bytes()
    }

    #[test]
    fn parses_the_published_examples() {
        let settings = Remote::parse(
            "desktop",
            include_bytes!("../protocol/optical-settings.example.json"),
        )
        .expect("settings example");
        assert!(settings.enabled);
        let state: serde_json::Value =
            serde_json::from_slice(include_bytes!("../protocol/optical-state.example.json"))
                .unwrap();
        let produced = serde_json::to_value(Status {
            phase: Phase::Sound,
            capture: Capture::Ok,
            host: Some("192.168.10.194".into()),
            host_source: Some(HostSource::Discovered),
            wiim: Some(WiimReading {
                reachable: true,
                optical: Some(true),
                playing: Some(false),
            }),
            discovered: vec!["192.168.10.194".into()],
            last_switch: Some(LastSwitch {
                outcome: SwitchOutcome::Switched,
                timestamp_ms: 1_795_000_000_000,
                latency_ms: 412,
            }),
            settings_source: SettingsSource::Lugn,
            settings_generation: Some("0b0e5f4c-41d5-4fd6-8f77-2f7a9a8c3a10".into()),
        })
        .unwrap();
        for (key, value) in produced.as_object().unwrap() {
            assert_eq!(state.get(key), Some(value), "{key}");
        }
    }

    #[test]
    fn remote_settings_are_validated_whole() {
        assert!(Remote::parse("desktop", &message("")).is_some());
        assert!(Remote::parse("other", &message("")).is_none());
        let with = |field: &str, bad: &str| {
            String::from_utf8(message(""))
                .unwrap()
                .replace(field, bad)
                .into_bytes()
        };
        for bad in [
            with(r#""min_audible_ms":300"#, r#""min_audible_ms":50"#),
            with(r#""min_audible_ms":300"#, r#""min_audible_ms":9000"#),
            with(r#""release_ms":1200"#, r#""release_ms":100"#),
            with(r#""level_db":-60"#, r#""level_db":-10"#),
            with(r#""level_db":-60"#, r#""level_db":-90"#),
            with(r#""wiim_host":null"#, r#""wiim_host":"8.8.8.8""#),
            with(r#""wiim_host":null"#, r#""wiim_host":"192.168.1.5/x""#),
            with(r#""audio_sink":null"#, r#""audio_sink":"a b""#),
            with(r#""schema_version":1"#, r#""schema_version":2"#),
            with(
                r#""generation":"11111111-2222-3333-4444-555555555555""#,
                r#""generation":"x y""#,
            ),
            message(r#","extra":1"#),
            b"not json".to_vec(),
        ] {
            assert!(Remote::parse("desktop", &bad).is_none());
        }
        let host = with(r#""wiim_host":null"#, r#""wiim_host":"192.168.10.194""#);
        assert!(Remote::parse("desktop", &host).is_some());
    }

    #[test]
    fn lugn_settings_override_the_file_and_fall_back_for_the_host() {
        let none = effective(&base(), None);
        assert_eq!(none.source, SettingsSource::Config);
        assert_eq!(none.host_source, None);
        let remote = Remote::parse("desktop", &message("")).unwrap();
        let eff = effective(&base(), Some(&remote));
        assert_eq!(eff.source, SettingsSource::Lugn);
        assert_eq!(eff.settings.min_audible_ms, 300);
        assert_eq!(eff.settings.release_ms, 1200);
        assert_eq!(eff.settings.level_db, -60);
        assert_eq!(eff.host_source, None);
        let mut file = base();
        file.host = Some("192.168.1.9".into());
        file.sink = Some("alsa_output.x".into());
        let eff = effective(&file, Some(&remote));
        assert_eq!(eff.settings.host.as_deref(), Some("192.168.1.9"));
        assert_eq!(eff.host_source, Some(HostSource::Config));
        assert_eq!(eff.settings.sink.as_deref(), Some("alsa_output.x"));
        let chosen = String::from_utf8(message(""))
            .unwrap()
            .replace(r#""wiim_host":null"#, r#""wiim_host":"10.0.0.7""#)
            .into_bytes();
        let eff = effective(&file, Remote::parse("desktop", &chosen).as_ref());
        assert_eq!(eff.settings.host.as_deref(), Some("10.0.0.7"));
        assert_eq!(eff.host_source, Some(HostSource::Lugn));
    }

    #[test]
    fn only_lan_senders_are_candidates() {
        let addr = |s: &str| s.parse::<SocketAddr>().unwrap();
        assert_eq!(
            lan_sender(addr("192.168.10.194:1900")).as_deref(),
            Some("192.168.10.194")
        );
        assert_eq!(
            lan_sender(addr("10.1.2.3:1900")).as_deref(),
            Some("10.1.2.3")
        );
        assert_eq!(lan_sender(addr("8.8.8.8:1900")), None);
        assert_eq!(lan_sender(addr("[fe80::1]:1900")), None);
    }

    #[test]
    fn validates_sinks() {
        assert!(validate_sink("alsa_output.pci-0000_00_1f.3.iec958-stereo").is_ok());
        assert!(validate_sink("a b").is_err());
        assert!(validate_sink("").is_err());
    }

    #[tokio::test]
    async fn a_disabled_switcher_reports_it_and_wakes_on_new_settings() {
        let mut disabled = base();
        disabled.enabled = false;
        let handle = spawn(disabled);
        let mut status = handle.status.clone();
        tokio::time::timeout(Duration::from_secs(2), async {
            while status.borrow().phase != Phase::Disabled
                || status.borrow().settings_source != SettingsSource::Config
            {
                status.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        // Stays disabled, so the test never searches the network.
        let off = String::from_utf8(message(""))
            .unwrap()
            .replace(r#""enabled":true"#, r#""enabled":false"#)
            .into_bytes();
        handle.apply_remote(Remote::parse("desktop", &off).unwrap());
        tokio::time::timeout(Duration::from_secs(2), async {
            while status.borrow().settings_source != SettingsSource::Lugn {
                status.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(
            status.borrow().settings_generation.as_deref(),
            Some("11111111-2222-3333-4444-555555555555")
        );
    }
}
