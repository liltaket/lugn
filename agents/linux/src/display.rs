//! Opt-in display power requests (DISPLAY v1). Observation v1 and CONTROL v1
//! are unchanged.
//!
//! The agent is an idempotent actuator: Lugn decides when the display should
//! sleep or wake. It also reports what the GPU is doing, read from the kernel's
//! per-connector `dpms` state, and only acknowledges a request as `applied`
//! once that state reached the target. That is the GPU's view of the picture
//! signal, not proof that the panel is dark (a monitor can show its own "no
//! signal" message or sleep by itself); where the kernel offers no such state
//! the reading is `unknown` and `applied` falls back to "the command exited 0".
use crate::{
    blockers::Blocker,
    control::{Context, now_ms, uuid_valid},
    idle::InputIdle,
};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};

/// Upper bound for one backend invocation. Longer is reported as uncertain.
const EXEC_TIMEOUT: Duration = Duration::from_secs(5);
/// How long after a successful command the kernel state may take to follow.
/// Observed latency is 0.5-1.5 s.
pub const VERIFY_WINDOW: Duration = Duration::from_secs(3);
const VERIFY_STEP: Duration = Duration::from_millis(100);
/// Baseline sampling of the kernel state; sysfs offers no change notification.
const POLL: Duration = Duration::from_secs(2);
const CACHE_CAPACITY: usize = 64;
const MAX_OUTPUTS: usize = 16;
const DRM_ROOT: &str = "/sys/class/drm";

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
    /// The command exited 0 but the kernel state did not follow in time.
    NotObserved,
    /// The command ran but no connected output exists to put to sleep or wake.
    NoOutput,
}

/// The GPU's picture-signal state. `none`: connectors exist but none is
/// connected (for example a monitor that dropped off the bus). `unknown`: the
/// kernel offers no readable state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Power {
    On,
    Off,
    Partial,
    #[serde(rename = "none")]
    Absent,
    #[default]
    Unknown,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutputState {
    pub connector: String,
    /// `on`, `off` or `unknown` for one connector.
    pub power: Power,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Reading {
    pub power: Power,
    pub outputs: Vec<OutputState>,
}

/// Reads every connected connector's `dpms` under a DRM sysfs root. `Standby`
/// and `Suspend` count as off. Writeback and disconnected connectors are skipped.
pub fn read_drm(root: &Path) -> Reading {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Reading::default();
    };
    let mut outputs = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(connector) = name
            .strip_prefix("card")
            .and_then(|rest| rest.split_once('-'))
            .map(|(_, connector)| connector.to_string())
        else {
            continue;
        };
        let valid = !connector.is_empty()
            && connector.len() <= 64
            && connector
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        let path = entry.path();
        let connected = std::fs::read_to_string(path.join("status"))
            .is_ok_and(|status| status.trim() == "connected");
        if !valid || connector.starts_with("Writeback") || !connected {
            continue;
        }
        let power = match std::fs::read_to_string(path.join("dpms")) {
            Ok(value) if value.trim() == "On" => Power::On,
            Ok(value) if matches!(value.trim(), "Off" | "Standby" | "Suspend") => Power::Off,
            _ => Power::Unknown,
        };
        outputs.push(OutputState { connector, power });
        if outputs.len() >= MAX_OUTPUTS {
            break;
        }
    }
    outputs.sort_by(|a, b| a.connector.cmp(&b.connector));
    let power = if outputs.is_empty() {
        Power::Absent
    } else if outputs.iter().any(|o| o.power == Power::Unknown) {
        Power::Unknown
    } else if outputs.iter().all(|o| o.power == Power::On) {
        Power::On
    } else if outputs.iter().all(|o| o.power == Power::Off) {
        Power::Off
    } else {
        Power::Partial
    };
    Reading { power, outputs }
}

/// Reads the display state. Replaceable so tests never touch real hardware.
pub type Observer = Arc<dyn Fn() -> Reading + Send + Sync>;
pub fn drm_observer() -> Observer {
    Arc::new(|| read_drm(Path::new(DRM_ROOT)))
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
/// this connection executed; `power`/`outputs` are the GPU's picture-signal
/// state, not an observation of the panel itself.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct Status {
    pub last_command: Option<LastCommand>,
    pub power: Power,
    pub outputs: Vec<OutputState>,
    /// When `power` last changed while this process was watching.
    pub power_changed_at_ms: Option<u64>,
    /// No keyboard/pointer input for the configured time, ignoring idle
    /// inhibitors; `None` when the compositor cannot report it.
    pub input_idle: Option<bool>,
    /// Estimated time of the last input while `input_idle` is true.
    pub input_idle_since_ms: Option<u64>,
    /// What PowerDevil reports as holding the machine awake; `None` when it
    /// cannot be read (unknown, not "nothing").
    pub idle_blockers: Option<Vec<Blocker>>,
}

/// Inputs the agent watches for the display state besides the kernel.
#[derive(Clone)]
pub struct Feeds {
    pub input_idle: watch::Receiver<InputIdle>,
    pub blockers: watch::Receiver<Option<Vec<Blocker>>>,
}
impl Feeds {
    /// No feed ever reports anything.
    #[cfg(test)]
    pub fn none() -> Self {
        Self {
            input_idle: watch::channel(InputIdle::default()).1,
            blockers: watch::channel(None).1,
        }
    }
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
    pub power: Power,
    pub outputs: Vec<OutputState>,
    pub power_changed_at_ms: Option<u64>,
    pub input_idle: Option<bool>,
    pub input_idle_since_ms: Option<u64>,
    pub idle_blockers: Option<Vec<Blocker>>,
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

pub fn spawn(context: Context, backend: Option<Backend>, feeds: Feeds) -> Runtime {
    spawn_with(
        context,
        backend,
        backend.map(process_executor),
        drm_observer(),
        feeds,
        VERIFY_WINDOW,
    )
}
pub fn spawn_with(
    context: Context,
    backend: Option<Backend>,
    executor: Option<Executor>,
    observer: Observer,
    feeds: Feeds,
    verify_window: Duration,
) -> Runtime {
    let (commands, rx) = mpsc::channel(8);
    let initial = observer();
    let (status_tx, status) = watch::channel(Status {
        last_command: None,
        power: initial.power,
        outputs: initial.outputs,
        power_changed_at_ms: None,
        input_idle: feeds.input_idle.borrow().idle,
        input_idle_since_ms: feeds.input_idle.borrow().since_ms,
        idle_blockers: feeds.blockers.borrow().clone(),
    });
    let (ack_tx, acks) = mpsc::channel(32);
    let task = tokio::spawn(run(
        context,
        executor,
        Actor {
            observer,
            verify_window,
        },
        rx,
        status_tx,
        ack_tx,
        feeds,
    ));
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
struct Actor {
    observer: Observer,
    verify_window: Duration,
}
impl Actor {
    /// Samples the kernel state and publishes any change.
    fn observe(&self, status: &watch::Sender<Status>) -> Reading {
        let reading = (self.observer)();
        status.send_if_modified(|s| {
            let mut changed = false;
            if s.power != reading.power {
                s.power = reading.power;
                s.power_changed_at_ms = Some(now_ms());
                changed = true;
            }
            if s.outputs != reading.outputs {
                s.outputs = reading.outputs.clone();
                changed = true;
            }
            changed
        });
        reading
    }

    /// Waits for the kernel state to follow a command that exited 0.
    async fn verify(&self, action: Action, status: &watch::Sender<Status>) -> Verdict {
        let target = match action {
            Action::Off => Power::Off,
            Action::On => Power::On,
        };
        let mut reading = self.observe(status);
        if reading.power == Power::Unknown {
            return Verdict::Unobservable;
        }
        let end = Instant::now() + self.verify_window;
        loop {
            if reading.power == target {
                return Verdict::Reached;
            }
            if reading.power == Power::Absent {
                return Verdict::NoOutput;
            }
            if Instant::now() >= end {
                return Verdict::NotObserved;
            }
            tokio::time::sleep(VERIFY_STEP).await;
            reading = self.observe(status);
        }
    }
}
enum Verdict {
    Reached,
    /// The kernel offers no readable state; the exit code is all there is.
    Unobservable,
    NoOutput,
    NotObserved,
}

async fn run(
    context: Context,
    executor: Option<Executor>,
    actor: Actor,
    mut commands: mpsc::Receiver<Delivery>,
    status: watch::Sender<Status>,
    acks: mpsc::Sender<Ack>,
    feeds: Feeds,
) {
    let Feeds {
        input_idle: mut input_feed,
        blockers: mut blockers_feed,
    } = feeds;
    let mut cache: HashMap<String, Cached> = HashMap::new();
    let mut ticker = tokio::time::interval(POLL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut input_open = true;
    let mut blockers_open = true;
    loop {
        let delivery = tokio::select! {
            delivery = commands.recv() => match delivery {
                Some(delivery) => delivery,
                None => return,
            },
            _ = ticker.tick() => {
                actor.observe(&status);
                continue;
            }
            changed = input_feed.changed(), if input_open => {
                if changed.is_err() {
                    input_open = false;
                } else {
                    let value = *input_feed.borrow_and_update();
                    status.send_if_modified(|s| {
                        let changed =
                            s.input_idle != value.idle || s.input_idle_since_ms != value.since_ms;
                        s.input_idle = value.idle;
                        s.input_idle_since_ms = value.since_ms;
                        changed
                    });
                }
                continue;
            }
            changed = blockers_feed.changed(), if blockers_open => {
                if changed.is_err() {
                    blockers_open = false;
                } else {
                    let value = blockers_feed.borrow_and_update().clone();
                    status.send_if_modified(|s| {
                        let changed = s.idle_blockers != value;
                        s.idle_blockers = value;
                        changed
                    });
                }
                continue;
            }
        };
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
                    let work = async {
                        executor(command.action).await?;
                        Ok::<_, Reason>(actor.verify(command.action, &status).await)
                    };
                    let result = tokio::time::timeout_at(
                        tokio::time::Instant::from_std(delivery.deadline()),
                        work,
                    )
                    .await
                    .unwrap_or(Err(Reason::Timeout));
                    let done = match command.action {
                        Action::Off => Reason::DisplayOff,
                        Action::On => Reason::DisplayOn,
                    };
                    match result {
                        Ok(Verdict::Reached | Verdict::Unobservable) => {
                            ack(&context, command, Outcome::Applied, done)
                        }
                        Ok(Verdict::NoOutput) => {
                            ack(&context, command, Outcome::Rejected, Reason::NoOutput)
                        }
                        Ok(Verdict::NotObserved) => {
                            ack(&context, command, Outcome::Uncertain, Reason::NotObserved)
                        }
                        Err(Reason::Timeout) => {
                            ack(&context, command, Outcome::Uncertain, Reason::Timeout)
                        }
                        Err(reason) => ack(&context, command, Outcome::Rejected, reason),
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
            let last = LastCommand {
                command_id: ack.command_id.clone(),
                action: ack.action,
                outcome: ack.outcome,
                reason: ack.reason,
                timestamp_ms: ack.timestamp_ms,
            };
            status.send_modify(|s| s.last_command = Some(last));
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
