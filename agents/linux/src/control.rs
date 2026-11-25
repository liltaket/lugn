//! Additive, opt-in targeted media control. Observation v1 remains unchanged.
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, watch};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Pause,
    Resume,
    Next,
    Previous,
    Seek,
}
impl Action {
    /// One-off track and position actions: they take and grant no ownership.
    pub fn is_transport(self) -> bool {
        matches!(self, Self::Next | Self::Previous | Self::Seek)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Applied,
    Rejected,
    Uncertain,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Paused,
    Resumed,
    Skipped,
    Sought,
    Disabled,
    Retained,
    Expired,
    InvalidCommand,
    WrongSession,
    WrongConnection,
    UnknownPlayer,
    PlayerChanged,
    ContentChanged,
    NotPlaying,
    NotPaused,
    NotCapable,
    NotOwner,
    LeaseExpired,
    IdConflict,
    Busy,
    Unavailable,
    Timeout,
    Unconfirmed,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub schema_version: u8,
    pub device_id: String,
    pub session_id: String,
    pub connection_id: String,
    pub command_id: String,
    pub action: Action,
    pub player: String,
    pub player_instance_id: String,
    pub content_id: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub pause_command_id: Option<String>,
    pub resume_token: Option<String>,
    pub lease_ttl_ms: Option<u64>,
    /// Only a seek carries it; every other command omits the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_ms: Option<u64>,
}
/// Longest position a seek may ask for (a week).
const MAX_POSITION_MS: u64 = 604_800_000;
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lease {
    pub pause_command_id: String,
    pub resume_token: String,
    pub expires_at_ms: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Player {
    pub player: String,
    pub player_instance_id: String,
    pub content_id: Option<String>,
    pub playback_status: Option<String>,
    pub can_pause: bool,
    pub can_play: bool,
    pub can_go_next: bool,
    pub can_go_previous: bool,
    pub can_seek: bool,
    pub pause_lease: Option<Lease>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ack {
    pub schema_version: u8,
    pub device_id: String,
    pub session_id: String,
    pub connection_id: String,
    pub command_id: String,
    pub action: Action,
    pub player: String,
    pub player_instance_id: String,
    pub content_id: String,
    pub timestamp_ms: u64,
    pub outcome: Outcome,
    pub reason: Reason,
    pub resume_token: Option<String>,
    pub lease_expires_at_ms: Option<u64>,
}
#[derive(Serialize, Deserialize)]
pub struct State {
    pub schema_version: u8,
    pub device_id: String,
    pub session_id: String,
    pub connection_id: String,
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub heartbeat_interval_ms: u64,
    pub players: Vec<Player>,
}
#[derive(Clone)]
pub struct Context {
    pub device_id: String,
    pub session_id: String,
    pub connection_id: String,
}
pub struct Delivery {
    pub command: Command,
    pub retained: bool,
    pub received_at: Instant,
    pub received_at_ms: u64,
}
impl Delivery {
    pub fn new(command: Command, retained: bool) -> Self {
        Self {
            command,
            retained,
            received_at: Instant::now(),
            received_at_ms: now_ms(),
        }
    }
    pub fn deadline(&self) -> Instant {
        self.received_at
            + Duration::from_millis(
                self.command
                    .expires_at_ms
                    .saturating_sub(self.received_at_ms)
                    .min(15_000),
            )
    }
}
pub struct Runtime {
    pub commands: mpsc::Sender<Delivery>,
    pub states: watch::Receiver<Vec<Player>>,
    pub acks: mpsc::Receiver<Ack>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub fn spawn(context: Context) -> Runtime {
    let (commands, rx) = mpsc::channel(16);
    let (tx, states) = watch::channel(Vec::new());
    let (ack_tx, acks) = mpsc::channel(32);
    let task = tokio::spawn(crate::control_mpris::run(context, rx, tx, ack_tx));
    Runtime {
        commands,
        states,
        acks,
        task,
    }
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|t| t.as_millis().min(9_007_199_254_740_991) as u64)
        .unwrap_or(0)
}
pub fn uuid_valid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
impl Command {
    pub fn validate(&self, context: &Context, now: u64) -> Result<(), Reason> {
        if self.schema_version != 1
            || self.device_id != context.device_id
            || ![
                &self.session_id,
                &self.connection_id,
                &self.command_id,
                &self.player_instance_id,
                &self.content_id,
            ]
            .iter()
            .all(|s| uuid_valid(s))
            || self.player.len() > 255
            || !self.player.starts_with("org.mpris.MediaPlayer2.")
            || zbus::names::WellKnownName::try_from(self.player.as_str()).is_err()
            || self.issued_at_ms > 9_007_199_254_740_991
            || self.expires_at_ms > 9_007_199_254_740_991
        {
            return Err(Reason::InvalidCommand);
        }
        if self.session_id != context.session_id {
            return Err(Reason::WrongSession);
        }
        if self.connection_id != context.connection_id {
            return Err(Reason::WrongConnection);
        }
        if self.expires_at_ms <= self.issued_at_ms
            || self.expires_at_ms - self.issued_at_ms > 15_000
            || self.issued_at_ms > now.saturating_add(2_000)
        {
            return Err(Reason::InvalidCommand);
        }
        if self.expires_at_ms <= now {
            return Err(Reason::Expired);
        }
        let unowned = self.pause_command_id.is_none()
            && self.resume_token.is_none()
            && self.lease_ttl_ms.is_none();
        match self.action {
            Action::Next | Action::Previous if unowned && self.position_ms.is_none() => Ok(()),
            Action::Seek if unowned && self.position_ms.is_some_and(|ms| ms <= MAX_POSITION_MS) => {
                Ok(())
            }
            Action::Pause
                if self.position_ms.is_none()
                    && self.pause_command_id.is_none()
                    && self.resume_token.is_none()
                    && self
                        .lease_ttl_ms
                        .is_some_and(|ms| (1_000..=3_600_000).contains(&ms)) =>
            {
                Ok(())
            }
            Action::Resume
                if self.position_ms.is_none()
                    && self.lease_ttl_ms.is_none()
                    && self.pause_command_id.as_deref().is_some_and(uuid_valid)
                    && self.resume_token.as_deref().is_some_and(uuid_valid) =>
            {
                Ok(())
            }
            _ => Err(Reason::InvalidCommand),
        }
    }
}
impl Context {
    pub fn ack(&self, command: &Command, outcome: Outcome, reason: Reason) -> Ack {
        Ack {
            schema_version: 1,
            device_id: self.device_id.clone(),
            session_id: self.session_id.clone(),
            connection_id: self.connection_id.clone(),
            command_id: command.command_id.clone(),
            action: command.action,
            player: command.player.clone(),
            player_instance_id: command.player_instance_id.clone(),
            content_id: command.content_id.clone(),
            timestamp_ms: now_ms(),
            outcome,
            reason,
            resume_token: None,
            lease_expires_at_ms: None,
        }
    }
}

/// Malformed/oversized envelopes are dropped rather than reflected to MQTT.
pub fn parse(payload: &[u8]) -> Option<Command> {
    if payload.len() > 8192 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let object = value.as_object()?;
    let fields = 14 + usize::from(object.get("position_ms").is_some_and(|v| !v.is_null()));
    if object.len() != fields
        || ![
            "schema_version",
            "device_id",
            "session_id",
            "connection_id",
            "command_id",
            "action",
            "player",
            "player_instance_id",
            "content_id",
            "issued_at_ms",
            "expires_at_ms",
            "pause_command_id",
            "resume_token",
            "lease_ttl_ms",
        ]
        .iter()
        .all(|key| object.contains_key(*key))
    {
        return None;
    }
    let command: Command = serde_json::from_value(value).ok()?;
    if command.schema_version != 1
        || !uuid_valid(&command.command_id)
        || command.player.len() > 255
        || !command.player.starts_with("org.mpris.MediaPlayer2.")
        || zbus::names::WellKnownName::try_from(command.player.as_str()).is_err()
        || !uuid_valid(&command.player_instance_id)
        || !uuid_valid(&command.content_id)
        || !uuid_valid(&command.session_id)
        || !uuid_valid(&command.connection_id)
        || command.device_id.len() > 64
    {
        return None;
    }
    Some(command)
}
#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
