//! Opt-in display power requests (DISPLAY v1). Observation v1 and CONTROL v1
//! are unchanged.
//!
//! The agent is a dumb, idempotent actuator: Lugn decides when the display
//! should sleep or wake. There is deliberately no physical feedback. A request
//! the desktop accepted is reported as `applied`, which never proves that the
//! panel is dark: monitors can ignore the request or wake again on their own.
use crate::control::{Context, now_ms, uuid_valid};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};

/// Upper bound for one backend invocation. Longer is reported as uncertain.
const EXEC_TIMEOUT: Duration = Duration::from_secs(5);
const CACHE_CAPACITY: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Off,
    On,
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
    DisplayOff,
    DisplayOn,
    Retained,
    Expired,
    InvalidCommand,
    WrongSession,
    WrongConnection,
    IdConflict,
    Busy,
    Unavailable,
    Timeout,
    Failed,
}

/// How a display is put to sleep. Only fixed argument vectors are ever run;
/// no command text from configuration or from MQTT reaches a process.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendSetting {
    #[default]
    Auto,
    Kscreen,
    Xset,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
    Kscreen,
    Xset,
}
impl Backend {
    /// `kscreen-doctor --dpms` is the Plasma/Wayland path; Xwayland and plain
    /// X11 servers only offer `xset`.
    pub fn resolve(setting: BackendSetting, wayland: bool, x11: bool) -> Option<Self> {
        match setting {
            BackendSetting::Kscreen => Some(Self::Kscreen),
            BackendSetting::Xset => Some(Self::Xset),
            BackendSetting::Auto if wayland => Some(Self::Kscreen),
            BackendSetting::Auto if x11 => Some(Self::Xset),
            BackendSetting::Auto => None,
        }
    }
    pub fn detect(setting: BackendSetting) -> Option<Self> {
        let present = |name| std::env::var_os(name).is_some_and(|v| !v.is_empty());
        Self::resolve(setting, present("WAYLAND_DISPLAY"), present("DISPLAY"))
    }
    fn argv(self, action: Action) -> (&'static str, &'static [&'static str]) {
        match (self, action) {
            (Self::Kscreen, Action::Off) => ("kscreen-doctor", &["--dpms", "off"]),
            (Self::Kscreen, Action::On) => ("kscreen-doctor", &["--dpms", "on"]),
            (Self::Xset, Action::Off) => ("xset", &["dpms", "force", "off"]),
            (Self::Xset, Action::On) => ("xset", &["dpms", "force", "on"]),
        }
    }
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
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ack {
    pub schema_version: u8,
    pub device_id: String,
    pub session_id: String,
    pub connection_id: String,
    pub command_id: String,
    pub action: Action,
    pub timestamp_ms: u64,
    pub outcome: Outcome,
    pub reason: Reason,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastCommand {
    pub command_id: String,
    pub action: Action,
    pub outcome: Outcome,
    pub reason: Reason,
    pub timestamp_ms: u64,
}
/// What the actuator can say about itself. `last_command` is the last request
/// this connection executed, never an observation of the panel.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct Status {
    pub last_command: Option<LastCommand>,
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
    pub backend: Option<Backend>,
    pub last_command: Option<LastCommand>,
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
    fn deadline(&self) -> Instant {
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
    pub status: watch::Receiver<Status>,
    pub acks: mpsc::Receiver<Ack>,
    pub backend: Option<Backend>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Runs one backend invocation. Replaceable so tests never touch a screen.
pub type Executor = Arc<dyn Fn(Action) -> BoxFuture<'static, Result<(), Reason>> + Send + Sync>;

pub fn process_executor(backend: Backend) -> Executor {
    Arc::new(move |action| {
        Box::pin(async move {
            let (program, args) = backend.argv(action);
            run_program(program, args).await
        })
    })
}

async fn run_program(program: &str, args: &[&str]) -> Result<(), Reason> {
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| Reason::Unavailable)?;
    match tokio::time::timeout(EXEC_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(_) => Err(Reason::Failed),
        // Dropping the child kills it; whether the request landed first is
        // unknowable.
        Err(_) => Err(Reason::Timeout),
    }
}

pub fn spawn(context: Context, backend: Option<Backend>) -> Runtime {
    spawn_with(context, backend, backend.map(process_executor))
}
pub fn spawn_with(
    context: Context,
    backend: Option<Backend>,
    executor: Option<Executor>,
) -> Runtime {
    let (commands, rx) = mpsc::channel(8);
    let (status_tx, status) = watch::channel(Status::default());
    let (ack_tx, acks) = mpsc::channel(32);
    let task = tokio::spawn(run(context, executor, rx, status_tx, ack_tx));
    Runtime {
        commands,
        status,
        acks,
        backend,
        task,
    }
}

struct Cached {
    command: Command,
    ack: Ack,
    expires_at_ms: u64,
}

async fn run(
    context: Context,
    executor: Option<Executor>,
    mut commands: mpsc::Receiver<Delivery>,
    status: watch::Sender<Status>,
    acks: mpsc::Sender<Ack>,
) {
    let mut cache: HashMap<String, Cached> = HashMap::new();
    while let Some(delivery) = commands.recv().await {
        let now = now_ms();
        cache.retain(|_, entry| entry.expires_at_ms > now);
        let command = &delivery.command;
        let ack = if let Some(cached) = cache.get(&command.command_id) {
            // Redelivery never repeats the action.
            if cached.command == *command {
                cached.ack.clone()
            } else {
                ack(&context, command, Outcome::Rejected, Reason::IdConflict)
            }
        } else if let Err(reason) = delivery.validate(&context, now) {
            ack(&context, command, Outcome::Rejected, reason)
        } else if cache.len() >= CACHE_CAPACITY {
            ack(&context, command, Outcome::Rejected, Reason::Busy)
        } else {
            let ack = match &executor {
                None => ack(&context, command, Outcome::Rejected, Reason::Unavailable),
                Some(executor) => {
                    let result = tokio::time::timeout_at(
                        tokio::time::Instant::from_std(delivery.deadline()),
                        executor(command.action),
                    )
                    .await
                    .unwrap_or(Err(Reason::Timeout));
                    match (result, command.action) {
                        (Ok(()), Action::Off) => {
                            ack(&context, command, Outcome::Applied, Reason::DisplayOff)
                        }
                        (Ok(()), Action::On) => {
                            ack(&context, command, Outcome::Applied, Reason::DisplayOn)
                        }
                        (Err(Reason::Timeout), _) => {
                            ack(&context, command, Outcome::Uncertain, Reason::Timeout)
                        }
                        (Err(reason), _) => ack(&context, command, Outcome::Rejected, reason),
                    }
                }
            };
            cache.insert(
                command.command_id.clone(),
                Cached {
                    command: command.clone(),
                    ack: ack.clone(),
                    expires_at_ms: command.expires_at_ms,
                },
            );
            status.send_replace(Status {
                last_command: Some(LastCommand {
                    command_id: ack.command_id.clone(),
                    action: ack.action,
                    outcome: ack.outcome,
                    reason: ack.reason,
                    timestamp_ms: ack.timestamp_ms,
                }),
            });
            ack
        };
        if acks.send(ack).await.is_err() {
            return;
        }
    }
}

impl Delivery {
    fn validate(&self, context: &Context, now: u64) -> Result<(), Reason> {
        let command = &self.command;
        if command.schema_version != 1
            || command.device_id != context.device_id
            || ![
                &command.session_id,
                &command.connection_id,
                &command.command_id,
            ]
            .iter()
            .all(|s| uuid_valid(s))
            || command.issued_at_ms > 9_007_199_254_740_991
            || command.expires_at_ms > 9_007_199_254_740_991
        {
            return Err(Reason::InvalidCommand);
        }
        if command.session_id != context.session_id {
            return Err(Reason::WrongSession);
        }
        if command.connection_id != context.connection_id {
            return Err(Reason::WrongConnection);
        }
        if self.retained {
            return Err(Reason::Retained);
        }
        if command.expires_at_ms <= command.issued_at_ms
            || command.expires_at_ms - command.issued_at_ms > 15_000
            || command.issued_at_ms > now.saturating_add(2_000)
        {
            return Err(Reason::InvalidCommand);
        }
        if command.expires_at_ms <= now {
            return Err(Reason::Expired);
        }
        Ok(())
    }
}
fn ack(context: &Context, command: &Command, outcome: Outcome, reason: Reason) -> Ack {
    Ack {
        schema_version: 1,
        device_id: context.device_id.clone(),
        session_id: context.session_id.clone(),
        connection_id: context.connection_id.clone(),
        command_id: command.command_id.clone(),
        action: command.action,
        timestamp_ms: now_ms(),
        outcome,
        reason,
    }
}

/// Malformed/oversized envelopes are dropped rather than reflected to MQTT.
pub fn parse(payload: &[u8]) -> Option<Command> {
    if payload.len() > 4096 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let object = value.as_object()?;
    if object.len() != 8
        || ![
            "schema_version",
            "device_id",
            "session_id",
            "connection_id",
            "command_id",
            "action",
            "issued_at_ms",
            "expires_at_ms",
        ]
        .iter()
        .all(|key| object.contains_key(*key))
    {
        return None;
    }
    let command: Command = serde_json::from_value(value).ok()?;
    if command.schema_version != 1
        || command.device_id.len() > 64
        || !uuid_valid(&command.command_id)
        || !uuid_valid(&command.session_id)
        || !uuid_valid(&command.connection_id)
    {
        return None;
    }
    Some(command)
}
#[cfg(test)]
#[path = "display_tests.rs"]
mod tests;
