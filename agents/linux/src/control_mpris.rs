//! Targeted MPRIS ownership. D-Bus has no compare-and-swap Pause/Play operation:
//! these guards narrow, but cannot eliminate, a user action between check/call.
//! Raw transitions are consumed during every await; snapshots never restore a
//! revoked lease. Private metadata (including URLs) is never published or logged.
use crate::control::{
    self, Ack, Action, Command, Context, Delivery, Lease, Outcome, Player, Reason,
};
use futures_util::{StreamExt, stream::select_all};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    future::Future,
    io::{self, Write},
    pin::Pin,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};
use zbus::zvariant::{ObjectPath, OwnedValue};
use zbus::{Connection, MatchRule, Message, MessageStream, connection::Builder, message::Type};

const BUS: &str = "org.freedesktop.DBus";
const BUS_PATH: &str = "/org/freedesktop/DBus";
const PATH: &str = "/org/mpris/MediaPlayer2";
const IFACE: &str = "org.mpris.MediaPlayer2.Player";
const PROPS: &str = "org.freedesktop.DBus.Properties";
const PREFIX: &str = "org.mpris.MediaPlayer2.";
const REQUIRED: &[&str] = &[
    "Metadata",
    "PlaybackStatus",
    "CanPause",
    "CanPlay",
    "CanControl",
];
const CALL_LIMIT: Duration = Duration::from_secs(3);
const MAX_PLAYERS: usize = 64;
const MAX_METADATA: usize = 64 * 1024;
const MAX_IDENTITY: usize = 4096;
type Properties = HashMap<String, OwnedValue>;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

struct Limited(Vec<u8>);
impl Write for Limited {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_METADATA {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "metadata limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn usable_track(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTITY
        && value.trim() == value
        && !value.chars().any(char::is_control)
        && value != "/"
        && value != "/org/mpris/MediaPlayer2/TrackList/NoTrack"
}

fn absolute_media_url(value: &str) -> bool {
    if value.len() > MAX_IDENTITY || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Some((scheme, rest)) = value.split_once(':') else {
        return false;
    };
    if !scheme
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        || !scheme
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"+.-".contains(&c))
        || rest.trim_matches('/').is_empty()
    {
        return false;
    }
    // HTTP URLs need an authority; file and opaque media URIs such as
    // spotify:track:... may use their respective absolute forms.
    if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") {
        let Some(authority) = rest.strip_prefix("//") else {
            return false;
        };
        return !authority
            .split(['/', '?', '#'])
            .next()
            .unwrap_or_default()
            .is_empty();
    }
    true
}

fn fingerprint(value: &OwnedValue) -> Option<Vec<u8>> {
    // Serialize with a bounded writer before cloning/decoding anything. Sorting
    // JSON dictionaries canonicalizes arbitrary D-Bus dictionary entry order.
    let mut encoded = Limited(Vec::new());
    serde_json::to_writer(&mut encoded, value).ok()?;
    let map: Properties = value.try_clone().ok()?.try_into().ok()?;
    // Several real players (including Spotify) export trackid as a string
    // rather than the specified object-path variant. A declared stable id or
    // absolute media URL is required; titles/artists alone cannot authorize.
    let track = map.get("mpris:trackid").and_then(|value| {
        <&ObjectPath<'_>>::try_from(value)
            .ok()
            .map(|path| path.as_str())
            .or_else(|| <&str>::try_from(value).ok())
    });
    let url = map
        .get("xesam:url")
        .and_then(|value| <&str>::try_from(value).ok());
    if !track.is_some_and(usable_track) && !url.is_some_and(absolute_media_url) {
        return None;
    }
    let canonical: serde_json::Value = serde_json::from_slice(&encoded.0).ok()?;
    let result = serde_json::to_vec(&canonical).ok()?;
    (result.len() <= MAX_METADATA).then_some(result)
}

struct OwnedLease {
    wire: Lease,
    deadline: Instant,
}
struct Record {
    owner: String,
    wire: Player,
    metadata: Option<Vec<u8>>,
    can_control: Option<bool>,
    can_pause: Option<bool>,
    can_play: Option<bool>,
    generation: u64,
    lease: Option<OwnedLease>,
}
impl Record {
    fn new(name: String, owner: String) -> Self {
        Self {
            owner,
            wire: Player {
                player: name,
                player_instance_id: id(),
                content_id: None,
                playback_status: None,
                can_pause: false,
                can_play: false,
                pause_lease: None,
            },
            metadata: None,
            can_control: None,
            can_pause: None,
            can_play: None,
            generation: 0,
            lease: None,
        }
    }
    fn revoke(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.lease = None;
        self.wire.pause_lease = None;
    }
    fn capabilities(&mut self) {
        let known = self.metadata.is_some() && self.can_control == Some(true);
        self.wire.can_pause = known && self.can_pause == Some(true);
        self.wire.can_play = known && self.can_play == Some(true);
    }
    fn unknown(&mut self) {
        self.revoke();
        self.metadata = None;
        self.wire.content_id = None;
        self.wire.playback_status = None;
        self.can_control = None;
        self.can_pause = None;
        self.can_play = None;
        self.capabilities();
    }
    fn expire(&mut self) {
        if self.lease.as_ref().is_some_and(|lease| {
            Instant::now() >= lease.deadline || control::now_ms() >= lease.wire.expires_at_ms
        }) {
            self.revoke();
        }
    }
}
struct Expected {
    name: String,
    instance: String,
    action: Action,
    observed: bool,
}
struct DispatchGuard {
    name: String,
    instance: String,
    content: String,
    owner: String,
    generation: u64,
    action: Action,
    command_expiry: u64,
    lease_deadline: Option<Instant>,
    lease_wall_expiry: Option<u64>,
}
struct Actor {
    connection: Connection,
    signals: Pin<Box<dyn futures_util::Stream<Item = Result<Message, zbus::Error>> + Send>>,
    players: BTreeMap<String, Record>,
    pending: BTreeSet<String>,
    expected: Option<Expected>,
    failed: bool,
    states: watch::Sender<Vec<Player>>,
}
impl Actor {
    fn publish(&mut self) {
        for record in self.players.values_mut() {
            record.expire();
        }
        let value: Vec<_> = self
            .players
            .values()
            .map(|record| record.wire.clone())
            .collect();
        if *self.states.borrow() != value {
            self.states.send_replace(value);
        }
    }
    fn properties(
        &mut self,
        name: &str,
        properties: Properties,
        invalidated: Vec<String>,
        raw: bool,
    ) {
        let Some(record) = self.players.get_mut(name) else {
            return;
        };
        if invalidated
            .iter()
            .any(|name| REQUIRED.contains(&name.as_str()))
        {
            record.unknown();
            self.pending.insert(name.to_owned());
            return;
        }
        if let Some(value) = properties.get("Metadata") {
            let metadata = fingerprint(value);
            if metadata != record.metadata {
                record.revoke();
                record.metadata = metadata;
                record.wire.content_id = record.metadata.as_ref().map(|_| id());
            } else if metadata.is_none() {
                record.revoke();
            }
        }
        for (key, field) in [
            ("CanControl", &mut record.can_control),
            ("CanPause", &mut record.can_pause),
            ("CanPlay", &mut record.can_play),
        ] {
            if let Some(value) = properties.get(key) {
                let value = bool::try_from(value).ok();
                if *field != value || value.is_none() {
                    record.generation = record.generation.wrapping_add(1);
                    record.lease = None;
                    record.wire.pause_lease = None;
                }
                *field = value;
            }
        }
        if let Some(value) = properties.get("PlaybackStatus") {
            let status = <&str>::try_from(value)
                .ok()
                .filter(|value| matches!(*value, "Playing" | "Paused" | "Stopped"))
                .map(str::to_owned);
            let expected = self.expected.as_mut().filter(|expected| {
                expected.name == name && expected.instance == record.wire.player_instance_id
            });
            let target = expected.as_ref().map(|expected| match expected.action {
                Action::Pause => "Paused",
                Action::Resume => "Playing",
            });
            let from = expected.as_ref().map(|expected| match expected.action {
                Action::Pause => "Playing",
                Action::Resume => "Paused",
            });
            let allowed = expected.as_ref().is_some_and(|expected| !expected.observed)
                && status.as_deref() == target
                && (record.wire.playback_status.as_deref() == from
                    || record.wire.playback_status.as_deref() == target);
            if allowed {
                if raw {
                    if let Some(expected) = expected {
                        expected.observed = true;
                    }
                }
            } else if status != record.wire.playback_status || status.is_none() {
                record.revoke();
            }
            // Even a repeated non-paused observation destroys owned pause state.
            if status.as_deref() != Some("Paused") && record.lease.is_some() {
                record.revoke();
            }
            record.wire.playback_status = status;
        }
        record.capabilities();
    }
    fn signal(&mut self, message: Message) -> Result<(), Reason> {
        if message.data().len() > 256 * 1024 {
            return Err(Reason::Unavailable);
        }
        let header = message.header();
        match header.member().map(|name| name.as_str()) {
            Some("NameOwnerChanged") => {
                let (name, _old, new): (String, String, String) = message
                    .body()
                    .deserialize()
                    .map_err(|_| Reason::Unavailable)?;
                if name.starts_with(PREFIX) {
                    self.players.remove(&name);
                    if !new.is_empty() && self.pending.len() < MAX_PLAYERS {
                        self.pending.insert(name);
                    } else {
                        self.pending.remove(&name);
                    }
                }
            }
            Some("PropertiesChanged") => {
                let sender = header.sender().map(|name| name.as_str());
                let names: Vec<_> = self
                    .players
                    .iter()
                    .filter(|(_, record)| Some(record.owner.as_str()) == sender)
                    .map(|(name, _)| name.clone())
                    .collect();
                if names.is_empty() {
                    return Ok(());
                }
                let (interface, values, invalidated): (String, Properties, Vec<String>) = message
                    .body()
                    .deserialize()
                    .map_err(|_| Reason::Unavailable)?;
                if interface != IFACE {
                    return Ok(());
                }
                // One unique owner can expose several well-known aliases.
                for name in names {
                    let values = values
                        .iter()
                        .map(|(key, value)| {
                            Ok((
                                key.clone(),
                                value.try_clone().map_err(|_| Reason::Unavailable)?,
                            ))
                        })
                        .collect::<Result<Properties, Reason>>()?;
                    self.properties(&name, values, invalidated.clone(), true);
                }
            }
            Some("Seeked") => {
                for record in self.players.values_mut().filter(|record| {
                    Some(record.owner.as_str()) == header.sender().map(|name| name.as_str())
                }) {
                    record.revoke();
                }
            }
            _ => {}
        }
        self.publish();
        Ok(())
    }
    async fn wait<T>(
        &mut self,
        future: impl Future<Output = Result<T, zbus::Error>>,
        deadline: Instant,
    ) -> Result<T, Reason> {
        tokio::pin!(future);
        let deadline = deadline.min(Instant::now() + CALL_LIMIT);
        loop {
            if Instant::now() >= deadline {
                self.failed = true;
                return Err(Reason::Timeout);
            }
            tokio::select! { biased;
                message = self.signals.next() => {
                    match message {
                        Some(Ok(message)) => if let Err(reason) = self.signal(message) { self.failed = true; return Err(reason); },
                        _ => { self.failed = true; return Err(Reason::Unavailable); }
                    }
                }
                _ = tokio::time::sleep_until(deadline.into()) => { self.failed = true; return Err(Reason::Timeout); }
                result = &mut future => return result.map_err(|_| { self.failed = true; Reason::Unavailable }),
            }
        }
    }
    fn dispatch_valid(&self, guard: &DispatchGuard, polled: bool) -> Result<(), Reason> {
        if control::now_ms() >= guard.command_expiry {
            return Err(Reason::Expired);
        }
        let record = self.players.get(&guard.name).ok_or(Reason::PlayerChanged)?;
        if record.owner != guard.owner || record.wire.player_instance_id != guard.instance {
            return Err(Reason::PlayerChanged);
        }
        if record.wire.content_id.as_deref() != Some(guard.content.as_str()) {
            return Err(Reason::ContentChanged);
        }
        if record.generation != guard.generation {
            return Err(Reason::Unconfirmed);
        }
        if guard
            .lease_deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
            || guard
                .lease_wall_expiry
                .is_some_and(|expiry| control::now_ms() >= expiry)
        {
            return Err(Reason::LeaseExpired);
        }
        let (before, after, capable) = match guard.action {
            Action::Pause => ("Playing", "Paused", record.wire.can_pause),
            Action::Resume => ("Paused", "Playing", record.wire.can_play),
        };
        if !capable {
            return Err(Reason::NotCapable);
        }
        let own_transition = polled
            && self
                .expected
                .as_ref()
                .is_some_and(|expected| expected.observed);
        if record.wire.playback_status.as_deref() != Some(before)
            && !(own_transition && record.wire.playback_status.as_deref() == Some(after))
        {
            return Err(Reason::Unconfirmed);
        }
        Ok(())
    }
    async fn wait_action<T>(
        &mut self,
        future: impl Future<Output = Result<T, zbus::Error>>,
        deadline: Instant,
        guard: DispatchGuard,
    ) -> Result<T, Reason> {
        tokio::pin!(future);
        let polled = AtomicBool::new(false);
        let mut dispatch = std::future::poll_fn(|cx| {
            polled.store(true, Ordering::Relaxed);
            future.as_mut().poll(cx)
        });
        let deadline = deadline.min(Instant::now() + CALL_LIMIT);
        loop {
            if Instant::now() >= deadline {
                self.failed = true;
                return Err(Reason::Timeout);
            }
            // call_method is lazy. In particular a ready revocation signal must
            // prevent its FIRST poll, rather than dispatching after revocation.
            self.dispatch_valid(&guard, polled.load(Ordering::Relaxed))?;
            tokio::select! { biased;
                message = self.signals.next() => match message {
                    Some(Ok(message)) => if let Err(reason) = self.signal(message) { self.failed = true; return Err(reason); },
                    _ => { self.failed = true; return Err(Reason::Unavailable); }
                },
                _ = tokio::time::sleep_until(deadline.into()) => { self.failed = true; return Err(Reason::Timeout); }
                result = &mut dispatch => return result.map_err(|_| { self.failed = true; Reason::Unavailable }),
            }
        }
    }
    async fn owner(&mut self, name: &str, deadline: Instant) -> Result<String, Reason> {
        let connection = self.connection.clone();
        let name = name.to_owned();
        let reply = self
            .wait(
                async move {
                    connection
                        .call_method(Some(BUS), BUS_PATH, Some(BUS), "GetNameOwner", &(name,))
                        .await
                },
                deadline,
            )
            .await?;
        reply.body().deserialize().map_err(|_| Reason::Unavailable)
    }
    async fn snapshot(&mut self, name: &str, owner: &str, deadline: Instant) -> Result<(), Reason> {
        let connection = self.connection.clone();
        let unique = owner.to_owned();
        let reply = self
            .wait(
                async move {
                    connection
                        .call_method(
                            Some(unique.as_str()),
                            PATH,
                            Some(PROPS),
                            "GetAll",
                            &(IFACE,),
                        )
                        .await
                },
                deadline,
            )
            .await?;
        if reply.data().len() > 256 * 1024 {
            if let Some(record) = self.players.get_mut(name) {
                record.unknown();
            }
            self.failed = true;
            return Err(Reason::Unavailable);
        }
        let properties: Properties = reply.body().deserialize().map_err(|_| {
            self.failed = true;
            Reason::Unavailable
        })?;
        if !REQUIRED.iter().all(|key| properties.contains_key(*key)) {
            if let Some(record) = self.players.get_mut(name) {
                record.unknown();
            }
            self.failed = true;
            return Err(Reason::Unavailable);
        }
        if self
            .players
            .get(name)
            .is_some_and(|record| record.owner == owner)
        {
            self.properties(name, properties, Vec::new(), false);
        }
        self.publish();
        Ok(())
    }
    async fn discover(&mut self, name: String) {
        if self.players.len() >= MAX_PLAYERS && !self.players.contains_key(&name) {
            return;
        }
        let deadline = Instant::now() + CALL_LIMIT;
        let Ok(owner) = self.owner(&name, deadline).await else {
            return;
        };
        if !self
            .players
            .get(&name)
            .is_some_and(|record| record.owner == owner)
        {
            self.players
                .insert(name.clone(), Record::new(name.clone(), owner.clone()));
        }
        if self
            .snapshot(&name, &owner, Instant::now() + CALL_LIMIT)
            .await
            .is_err()
        {
            if let Some(record) = self.players.get_mut(&name) {
                record.unknown();
            }
        }
        self.publish();
    }
    fn target(&self, command: &Command) -> Result<&Record, Reason> {
        let record = self
            .players
            .get(&command.player)
            .ok_or(Reason::UnknownPlayer)?;
        if record.wire.player_instance_id != command.player_instance_id {
            return Err(Reason::PlayerChanged);
        }
        if record.wire.content_id.as_deref() != Some(command.content_id.as_str()) {
            return Err(Reason::ContentChanged);
        }
        Ok(record)
    }
    async fn execute(
        &mut self,
        delivery: &Delivery,
        clock: &mut Clock,
    ) -> Result<(Reason, Option<Lease>), (Outcome, Reason)> {
        let command = &delivery.command;
        let deadline = delivery.deadline().min(
            Instant::now()
                + Duration::from_millis(command.expires_at_ms.saturating_sub(clock.now())),
        );
        let reject = |reason| (Outcome::Rejected, reason);
        let uncertain = |reason| {
            (
                Outcome::Uncertain,
                if reason == Reason::Unavailable {
                    Reason::Unconfirmed
                } else {
                    reason
                },
            )
        };
        let record = self.target(command).map_err(reject)?;
        let owner = record.owner.clone();
        let generation = record.generation;
        if command.action == Action::Resume {
            let lease = record
                .lease
                .as_ref()
                .ok_or_else(|| reject(Reason::NotOwner))?;
            if lease.wire.pause_command_id
                != command.pause_command_id.as_deref().unwrap_or_default()
                || lease.wire.resume_token != command.resume_token.as_deref().unwrap_or_default()
            {
                return Err(reject(Reason::NotOwner));
            }
            if Instant::now() >= lease.deadline || control::now_ms() >= lease.wire.expires_at_ms {
                return Err(reject(Reason::LeaseExpired));
            }
        }
        if self
            .owner(&command.player, deadline)
            .await
            .map_err(reject)?
            != owner
        {
            return Err(reject(Reason::PlayerChanged));
        }
        self.snapshot(&command.player, &owner, deadline)
            .await
            .map_err(reject)?;
        let record = self.target(command).map_err(reject)?;
        if record.generation != generation {
            return Err(reject(Reason::Unconfirmed));
        }
        match command.action {
            Action::Pause => {
                if record.wire.playback_status.as_deref() != Some("Playing") {
                    return Err(reject(Reason::NotPlaying));
                }
                if !record.wire.can_pause {
                    return Err(reject(Reason::NotCapable));
                }
            }
            Action::Resume => {
                if record.wire.playback_status.as_deref() != Some("Paused") {
                    return Err(reject(Reason::NotPaused));
                }
                if !record.wire.can_play {
                    return Err(reject(Reason::NotCapable));
                }
                let lease = record
                    .lease
                    .as_ref()
                    .ok_or_else(|| reject(Reason::NotOwner))?;
                if Instant::now() >= lease.deadline || control::now_ms() >= lease.wire.expires_at_ms
                {
                    return Err(reject(Reason::LeaseExpired));
                }
            }
        }
        command
            .validate(
                &Context {
                    device_id: command.device_id.clone(),
                    session_id: command.session_id.clone(),
                    connection_id: command.connection_id.clone(),
                },
                clock.now(),
            )
            .map_err(reject)?;
        if Instant::now() >= deadline {
            return Err(reject(Reason::Expired));
        }
        let record = self.target(command).map_err(reject)?;
        let guard = DispatchGuard {
            name: command.player.clone(),
            instance: command.player_instance_id.clone(),
            content: command.content_id.clone(),
            owner: owner.clone(),
            generation,
            action: command.action,
            command_expiry: command.expires_at_ms,
            lease_deadline: if command.action == Action::Resume {
                record.lease.as_ref().map(|lease| lease.deadline)
            } else {
                None
            },
            lease_wall_expiry: if command.action == Action::Resume {
                record.lease.as_ref().map(|lease| lease.wire.expires_at_ms)
            } else {
                None
            },
        };
        // Consume ownership before issuing Play. Cancellation cannot make a
        // second resume attempt legal, even when the method's outcome is lost.
        if let Some(record) = self.players.get_mut(&command.player) {
            record.lease = None;
            record.wire.pause_lease = None;
        }
        self.expected = Some(Expected {
            name: command.player.clone(),
            instance: command.player_instance_id.clone(),
            action: command.action,
            observed: false,
        });
        let connection = self.connection.clone();
        let unique = owner.clone();
        let method = match command.action {
            Action::Pause => "Pause",
            Action::Resume => "Play",
        };
        let result = self
            .wait_action(
                async move {
                    connection
                        .call_method(Some(unique.as_str()), PATH, Some(IFACE), method, &())
                        .await
                },
                deadline,
                guard,
            )
            .await;
        if let Err(reason) = result {
            self.expected = None;
            return Err(uncertain(reason));
        }
        if self
            .owner(&command.player, deadline)
            .await
            .map_err(uncertain)?
            != owner
        {
            self.expected = None;
            return Err(uncertain(Reason::PlayerChanged));
        }
        self.snapshot(&command.player, &owner, deadline)
            .await
            .map_err(uncertain)?;
        let observed = self
            .expected
            .take()
            .is_some_and(|expected| expected.observed);
        let record = self.target(command).map_err(uncertain)?;
        let target = match command.action {
            Action::Pause => "Paused",
            Action::Resume => "Playing",
        };
        if record.generation != generation
            || record.wire.playback_status.as_deref() != Some(target)
            || !observed
        {
            return Err(uncertain(Reason::Unconfirmed));
        }
        if Instant::now() >= deadline || clock.now() >= command.expires_at_ms {
            return Err(uncertain(Reason::Timeout));
        }
        if command.action == Action::Pause {
            if !record.wire.can_play || !record.wire.can_pause {
                return Err(uncertain(Reason::NotCapable));
            }
            let ttl = command.lease_ttl_ms.unwrap_or(1_200_000);
            let lease = Lease {
                pause_command_id: command.command_id.clone(),
                resume_token: id(),
                expires_at_ms: control::now_ms().saturating_add(ttl),
            };
            let record = self.players.get_mut(&command.player).unwrap();
            record.lease = Some(OwnedLease {
                wire: lease.clone(),
                deadline: Instant::now() + Duration::from_millis(ttl),
            });
            record.wire.pause_lease = Some(lease.clone());
            self.publish();
            Ok((Reason::Paused, Some(lease)))
        } else {
            self.publish();
            Ok((Reason::Resumed, None))
        }
    }
}

struct Cached {
    command: Command,
    ack: Option<Ack>,
}
// Runtime-local logical wall time advances at least as fast as Instant and
// never moves backwards. Once an id retires, its original command remains
// expired even when a duplicate is received after a real wall-clock rollback.
struct Clock {
    anchor_ms: u64,
    anchor: Instant,
    last_ms: u64,
}
impl Default for Clock {
    fn default() -> Self {
        let now = control::now_ms();
        Self {
            anchor_ms: now,
            anchor: Instant::now(),
            last_ms: now,
        }
    }
}
impl Clock {
    fn tick(&mut self, wall_ms: u64, mono: Instant) -> u64 {
        let elapsed = mono
            .saturating_duration_since(self.anchor)
            .as_millis()
            .min(u64::MAX as u128) as u64;
        self.last_ms = self
            .last_ms
            .max(wall_ms)
            .max(self.anchor_ms.saturating_add(elapsed));
        self.last_ms
    }
    fn now(&mut self) -> u64 {
        self.tick(control::now_ms(), Instant::now())
    }
}
#[derive(Default)]
struct Cache {
    entries: BTreeMap<String, Cached>,
    clock: Clock,
}
impl Cache {
    fn reserve(&mut self, context: &Context, delivery: &Delivery) -> Result<Option<Ack>, Reason> {
        let now = self.clock.now();
        self.reserve_at(context, delivery, now)
    }
    fn reserve_at(
        &mut self,
        context: &Context,
        delivery: &Delivery,
        now: u64,
    ) -> Result<Option<Ack>, Reason> {
        self.entries
            .retain(|_, entry| entry.command.expires_at_ms > now);
        if delivery.retained {
            return Err(Reason::Retained);
        }
        if let Some(entry) = self.entries.get(&delivery.command.command_id) {
            if entry.command != delivery.command {
                return Err(Reason::IdConflict);
            }
            return entry.ack.clone().map(Some).ok_or(Reason::Busy);
        }
        delivery.command.validate(context, now)?;
        if Instant::now() >= delivery.deadline() {
            return Err(Reason::Expired);
        }
        if self.entries.len() >= 256 {
            return Err(Reason::Busy);
        }
        self.entries.insert(
            delivery.command.command_id.clone(),
            Cached {
                command: delivery.command.clone(),
                ack: None,
            },
        );
        Ok(None)
    }
    fn finish(&mut self, ack: Ack) -> Ack {
        if let Some(entry) = self.entries.get_mut(&ack.command_id) {
            entry.ack = Some(ack.clone());
        }
        ack
    }
}
async fn connected(states: watch::Sender<Vec<Player>>) -> Result<Actor, zbus::Error> {
    let connection = Builder::session()?
        .max_queued(64)
        .method_timeout(CALL_LIMIT)
        .build()
        .await?;
    let rules = [
        MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(BUS)?
            .path(BUS_PATH)?
            .interface(BUS)?
            .member("NameOwnerChanged")?
            .build(),
        MatchRule::builder()
            .msg_type(Type::Signal)
            .path(PATH)?
            .interface(PROPS)?
            .member("PropertiesChanged")?
            .build(),
        MatchRule::builder()
            .msg_type(Type::Signal)
            .path(PATH)?
            .interface(IFACE)?
            .member("Seeked")?
            .build(),
    ];
    let mut streams = Vec::new();
    for rule in rules {
        streams.push(MessageStream::for_match_rule(rule, &connection, Some(64)).await?);
    }
    let mut actor = Actor {
        connection,
        signals: Box::pin(select_all(streams)),
        players: BTreeMap::new(),
        pending: BTreeSet::new(),
        expected: None,
        failed: false,
        states,
    };
    let connection = actor.connection.clone();
    let reply = actor
        .wait(
            async move {
                connection
                    .call_method(Some(BUS), BUS_PATH, Some(BUS), "ListNames", &())
                    .await
            },
            Instant::now() + CALL_LIMIT,
        )
        .await
        .map_err(|_| zbus::Error::Failure("discovery unavailable".into()))?;
    let mut names: Vec<String> = reply.body().deserialize()?;
    names.sort();
    actor.pending.extend(
        names
            .into_iter()
            .filter(|name| name.starts_with(PREFIX))
            .take(MAX_PLAYERS),
    );
    Ok(actor)
}

pub async fn run(
    context: Context,
    mut commands: mpsc::Receiver<Delivery>,
    states: watch::Sender<Vec<Player>>,
    acks: mpsc::Sender<Ack>,
) {
    let mut cache = Cache::default();
    let mut retry = Duration::from_secs(1);
    loop {
        states.send_replace(Vec::new());
        let connection =
            tokio::time::timeout(Duration::from_secs(12), connected(states.clone())).await;
        if let Ok(Ok(mut actor)) = connection {
            let connected_at = Instant::now();
            loop {
                if actor.failed {
                    break;
                }
                actor.publish();
                if let Some(name) = actor.pending.pop_first() {
                    actor.discover(name).await;
                    continue;
                }
                let next_expiry = actor
                    .players
                    .values()
                    .filter_map(|record| record.lease.as_ref().map(|lease| lease.deadline))
                    .min();
                tokio::select! { biased;
                    message = actor.signals.next() => match message { Some(Ok(message)) => if actor.signal(message).is_err() { break; }, _ => break },
                    delivery = commands.recv() => {
                        let Some(delivery) = delivery else { return; };
                        let ack = match cache.reserve(&context, &delivery) {
                            Ok(Some(ack)) => ack,
                            Err(reason) => context.ack(&delivery.command, Outcome::Rejected, reason),
                            Ok(None) => {
                                let result = actor.execute(&delivery, &mut cache.clock).await;
                                actor.expected = None;
                                if matches!(result, Err((Outcome::Uncertain, _))) || actor.failed {
                                    if let Some(record) = actor.players.get_mut(&delivery.command.player) { record.revoke(); }
                                }
                                let ack = match result {
                                    Ok((reason, lease)) => {
                                        let mut ack = context.ack(&delivery.command, Outcome::Applied, reason);
                                        if let Some(lease) = lease { ack.resume_token = Some(lease.resume_token); ack.lease_expires_at_ms = Some(lease.expires_at_ms); } ack
                                    }
                                    Err((outcome, reason)) => context.ack(&delivery.command, outcome, reason),
                                };
                                actor.publish(); cache.finish(ack)
                            }
                        };
                        let _ = acks.try_send(ack);
                    }
                    _ = async { if let Some(deadline) = next_expiry { tokio::time::sleep_until(deadline.into()).await } else { std::future::pending::<()>().await } } => {}
                }
            }
            if connected_at.elapsed() >= Duration::from_secs(60) {
                retry = Duration::from_secs(1);
            }
        }
        states.send_replace(Vec::new());
        let deadline = tokio::time::Instant::now() + retry;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => break,
                delivery = commands.recv() => {
                    let Some(delivery) = delivery else { return; };
                    let ack = match cache.reserve(&context, &delivery) {
                        Ok(Some(ack)) => ack,
                        Err(reason) => context.ack(&delivery.command, Outcome::Rejected, reason),
                        Ok(None) => cache.finish(context.ack(&delivery.command, Outcome::Rejected, Reason::Unavailable)),
                    };
                    let _ = acks.try_send(ack);
                }
            }
        }
        retry = (retry * 2).min(Duration::from_secs(60));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
    };
    use zbus::zvariant::Str;
    fn value(text: &str) -> OwnedValue {
        Str::from(text).into()
    }
    fn metadata(track: &str) -> OwnedValue {
        let map: Properties = [
            (
                "mpris:trackid".into(),
                OwnedValue::from(ObjectPath::try_from(track).unwrap()),
            ),
            ("xesam:url".into(), value("file:///private/never-publish")),
        ]
        .into();
        zbus::zvariant::Value::from(map).try_into().unwrap()
    }
    fn context() -> Context {
        Context {
            device_id: "fixture".into(),
            session_id: id(),
            connection_id: id(),
        }
    }
    pub(super) fn command(context: &Context, player: &Player, action: Action) -> Command {
        let now = control::now_ms();
        Command {
            schema_version: 1,
            device_id: context.device_id.clone(),
            session_id: context.session_id.clone(),
            connection_id: context.connection_id.clone(),
            command_id: id(),
            action,
            player: player.player.clone(),
            player_instance_id: player.player_instance_id.clone(),
            content_id: player.content_id.clone().unwrap(),
            issued_at_ms: now,
            expires_at_ms: now + 10_000,
            pause_command_id: None,
            resume_token: None,
            lease_ttl_ms: Some(10_000),
        }
    }
    pub(super) fn resume(
        context: &Context,
        player: &Player,
        pause: &Command,
        ack: &Ack,
    ) -> Command {
        let mut command = command(context, player, Action::Resume);
        command.lease_ttl_ms = None;
        command.pause_command_id = Some(pause.command_id.clone());
        command.resume_token = ack.resume_token.clone();
        command
    }
    fn public() -> Player {
        Player {
            player: "org.mpris.MediaPlayer2.fixture".into(),
            player_instance_id: id(),
            content_id: Some(id()),
            playback_status: Some("Playing".into()),
            can_pause: true,
            can_play: true,
            pause_lease: None,
        }
    }

    #[test]
    fn full_metadata_fingerprint_requires_a_bounded_strong_identifier() {
        assert!(fingerprint(&metadata("/track/A")).is_some());
        // The helper has an absolute URL: it can identify content even when
        // the declared id is NoTrack. NoTrack alone is tested separately below.
        assert!(fingerprint(&metadata("/org/mpris/MediaPlayer2/TrackList/NoTrack")).is_some());
        for track in [
            value("spotify:track:fixture_A"),
            value("/track/A"),
            OwnedValue::from(ObjectPath::try_from("/track/A").unwrap()),
        ] {
            let properties: Properties = [("mpris:trackid".into(), track)].into();
            assert!(
                fingerprint(&zbus::zvariant::Value::from(properties).try_into().unwrap()).is_some()
            );
        }
        for track in [
            None,
            Some(OwnedValue::from(7_u32)),
            Some(value("")),
            Some(value("/org/mpris/MediaPlayer2/TrackList/NoTrack")),
            Some(OwnedValue::from(
                ObjectPath::try_from("/org/mpris/MediaPlayer2/TrackList/NoTrack").unwrap(),
            )),
            Some(value(&"x".repeat(MAX_IDENTITY + 1))),
        ] {
            let mut properties: Properties =
                [("xesam:title".into(), value("A title is insufficient"))].into();
            if let Some(track) = track {
                properties.insert("mpris:trackid".into(), track);
            }
            let copy: Properties = properties
                .iter()
                .map(|(key, value)| (key.clone(), value.try_clone().unwrap()))
                .collect();
            let without_url: OwnedValue = zbus::zvariant::Value::from(copy).try_into().unwrap();
            assert!(fingerprint(&without_url).is_none());
            properties.insert("xesam:url".into(), value("spotify:track:fixture_A"));
            assert!(
                fingerprint(&zbus::zvariant::Value::from(properties).try_into().unwrap()).is_some()
            );
        }
        let huge: Properties = [
            (
                "mpris:trackid".into(),
                OwnedValue::from(ObjectPath::try_from("/track/A").unwrap()),
            ),
            ("xesam:url".into(), value(&"x".repeat(MAX_METADATA))),
        ]
        .into();
        assert!(fingerprint(&zbus::zvariant::Value::from(huge).try_into().unwrap()).is_none());
        assert!(fingerprint(&metadata("/track/A")) != fingerprint(&metadata("/track/B")));
    }

    #[test]
    fn absolute_url_identity_rejects_relative_empty_and_control_values() {
        for url in [
            "https://open.spotify.com/track/fixture",
            "file:///tmp/media.flac",
            "spotify:track:fixture",
        ] {
            assert!(absolute_media_url(url));
        }
        for url in [
            "",
            "relative/file.mp3",
            "//example/track",
            "https://",
            "https:/example/track",
            "https://example/a b",
            "spotify:track:\nfixture",
            ":track",
            "1bad:track",
            "file:///",
        ] {
            assert!(!absolute_media_url(url));
        }
        assert!(!absolute_media_url(&format!(
            "https://example/{}",
            "x".repeat(MAX_IDENTITY)
        )));
        assert!(fingerprint(&OwnedValue::from(7_u32)).is_none());
    }

    #[test]
    fn cache_reserves_before_await_replays_exact_ack_and_never_evicts_live_entries() {
        let context = context();
        let player = public();
        let mut cache = Cache::default();
        let command = command(&context, &player, Action::Pause);
        let delivery = Delivery::new(command.clone(), false);
        assert!(matches!(cache.reserve(&context, &delivery), Ok(None)));
        assert!(matches!(
            cache.reserve(&context, &delivery),
            Err(Reason::Busy)
        ));
        let ack = context.ack(&command, Outcome::Applied, Reason::Paused);
        cache.finish(ack.clone());
        assert!(matches!(cache.reserve(&context, &delivery), Ok(Some(cached)) if cached == ack));
        let mut conflict = command.clone();
        conflict.content_id = id();
        assert!(matches!(
            cache.reserve(&context, &Delivery::new(conflict, false)),
            Err(Reason::IdConflict)
        ));
        for _ in 1..256 {
            let next = self::command(&context, &player, Action::Pause);
            assert!(matches!(
                cache.reserve(&context, &Delivery::new(next, false)),
                Ok(None)
            ));
        }
        assert!(matches!(
            cache.reserve(
                &context,
                &Delivery::new(self::command(&context, &player, Action::Pause), false)
            ),
            Err(Reason::Busy)
        ));
        assert!(matches!(
            cache.reserve(&context, &Delivery::new(command, true)),
            Err(Reason::Retained)
        ));
    }

    #[test]
    fn monotonic_delivery_and_lease_deadlines_do_not_follow_wall_clock_backwards() {
        let context = context();
        let mut delivery = Delivery::new(command(&context, &public(), Action::Pause), false);
        delivery.received_at = Instant::now() - Duration::from_secs(20);
        assert!(matches!(
            Cache::default().reserve(&context, &delivery),
            Err(Reason::Expired)
        ));
        let mut record = Record::new("org.mpris.MediaPlayer2.fixture".into(), ":1.1".into());
        let wire = Lease {
            pause_command_id: id(),
            resume_token: id(),
            expires_at_ms: control::now_ms() + 10_000,
        };
        record.wire.pause_lease = Some(wire.clone());
        record.lease = Some(OwnedLease {
            wire,
            deadline: Instant::now() - Duration::from_millis(1),
        });
        record.expire();
        assert!(record.lease.is_none());
        assert!(record.wire.pause_lease.is_none());
    }

    #[test]
    fn cache_retirement_cannot_reauthorize_a_replay_after_clock_rollback() {
        let context = context();
        let player = public();
        let mono = Instant::now();
        let wall = control::now_ms();
        let mut cache = Cache {
            entries: BTreeMap::new(),
            clock: Clock {
                anchor_ms: wall,
                anchor: mono,
                last_ms: wall,
            },
        };
        let command = command(&context, &player, Action::Pause);
        let delivery = Delivery::new(command.clone(), false);
        let now = cache.clock.tick(wall, mono);
        assert!(matches!(
            cache.reserve_at(&context, &delivery, now),
            Ok(None)
        ));
        let ack = context.ack(&command, Outcome::Applied, Reason::Paused);
        cache.finish(ack.clone());
        let now = cache
            .clock
            .tick(wall.saturating_sub(1500), mono + Duration::from_secs(2));
        assert!(
            matches!(cache.reserve_at(&context, &Delivery::new(command.clone(), false), now), Ok(Some(cached)) if cached == ack)
        );
        let now = cache
            .clock
            .tick(wall.saturating_sub(1500), mono + Duration::from_secs(12));
        assert!(matches!(
            cache.reserve_at(&context, &Delivery::new(command, false), now),
            Err(Reason::Expired)
        ));
        assert!(cache.entries.is_empty());
    }

    #[derive(Default)]
    pub(super) struct Fixture {
        status: AtomicU8,
        track: AtomicU8,
        pub(super) identity_mode: AtomicU8,
        pub(super) pauses: AtomicUsize,
        pub(super) plays: AtomicUsize,
        pause_race: AtomicBool,
        slow_snapshot: AtomicBool,
        slow_pause: AtomicBool,
        entered: tokio::sync::Notify,
    }
    fn status(fixture: &Fixture) -> &'static str {
        match fixture.status.load(Ordering::SeqCst) {
            0 => "Playing",
            1 => "Paused",
            _ => "Stopped",
        }
    }
    fn fixture_metadata(fixture: &Fixture) -> Properties {
        let a = fixture.track.load(Ordering::SeqCst) == 0;
        match fixture.identity_mode.load(Ordering::SeqCst) {
            1 => [
                (
                    "mpris:trackid".into(),
                    value(if a { "/track/A" } else { "/track/B" }),
                ),
                (
                    "xesam:url".into(),
                    value("https://open.spotify.com/track/fixture"),
                ),
            ]
            .into(),
            2 => [(
                "xesam:url".into(),
                value(if a {
                    "spotify:track:fixture_A"
                } else {
                    "spotify:track:fixture_B"
                }),
            )]
            .into(),
            3 => [("xesam:title".into(), value("A title is insufficient"))].into(),
            _ => Properties::try_from(metadata(if a { "/track/A" } else { "/track/B" })).unwrap(),
        }
    }
    async fn changed(connection: &Connection, key: &str, value: OwnedValue) {
        let properties: Properties = [(key.to_owned(), value)].into();
        connection
            .emit_signal(
                None::<&str>,
                PATH,
                PROPS,
                "PropertiesChanged",
                &(IFACE, properties, Vec::<String>::new()),
            )
            .await
            .unwrap();
    }
    async fn set_status(connection: &Connection, fixture: &Fixture, new: u8) {
        fixture.status.store(new, Ordering::SeqCst);
        changed(connection, "PlaybackStatus", value(status(fixture))).await;
    }
    pub(super) struct Fake(pub(super) Arc<Fixture>);
    #[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
    impl Fake {
        async fn pause(&self, #[zbus(connection)] connection: &Connection) {
            self.0.pauses.fetch_add(1, Ordering::SeqCst);
            if self.0.slow_pause.swap(false, Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_secs(4)).await;
            }
            set_status(connection, &self.0, 1).await;
            if self.0.pause_race.swap(false, Ordering::SeqCst) {
                set_status(connection, &self.0, 0).await;
                set_status(connection, &self.0, 1).await;
            }
        }
        async fn play(&self, #[zbus(connection)] connection: &Connection) {
            self.0.plays.fetch_add(1, Ordering::SeqCst);
            set_status(connection, &self.0, 0).await;
        }
        #[zbus(property)]
        async fn playback_status(&self) -> &str {
            if self.0.slow_snapshot.swap(false, Ordering::SeqCst) {
                self.0.entered.notify_one();
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
            status(&self.0)
        }
        #[zbus(property)]
        fn can_pause(&self) -> bool {
            true
        }
        #[zbus(property)]
        fn can_play(&self) -> bool {
            true
        }
        #[zbus(property)]
        fn can_control(&self) -> bool {
            true
        }
        #[zbus(property)]
        fn metadata(&self) -> Properties {
            fixture_metadata(&self.0)
        }
    }
    async fn state(runtime: &mut control::Runtime, predicate: impl Fn(&Player) -> bool) -> Player {
        tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                if let Some(player) = runtime
                    .states
                    .borrow()
                    .iter()
                    .find(|player| {
                        player.player == "org.mpris.MediaPlayer2.control_fixture"
                            && predicate(player)
                    })
                    .cloned()
                {
                    return player;
                }
                runtime.states.changed().await.unwrap();
            }
        })
        .await
        .expect("expected control player state")
    }
    async fn send(runtime: &mut control::Runtime, command: Command) -> Ack {
        runtime
            .commands
            .send(Delivery::new(command, false))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(6), runtime.acks.recv())
            .await
            .unwrap()
            .unwrap()
    }
    async fn pause_owned(
        runtime: &mut control::Runtime,
        context: &Context,
    ) -> (Player, Command, Ack) {
        let player = state(runtime, |player| {
            player.playback_status.as_deref() == Some("Playing") && player.can_pause
        })
        .await;
        let command = command(context, &player, Action::Pause);
        let ack = send(runtime, command.clone()).await;
        assert!(
            ack.outcome == Outcome::Applied && ack.reason == Reason::Paused,
            "pause rejected: {:?}",
            ack.reason
        );
        let player = state(runtime, |player| player.pause_lease.is_some()).await;
        (player, command, ack)
    }

    /// Private bus only. This test owns only its fixture name and never contacts
    /// or controls a real desktop player.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires isolated dbus-run-session and LUGN_TEST_DBUS=1"]
    async fn dbus_lifecycle_control() {
        assert_eq!(std::env::var("LUGN_TEST_DBUS").as_deref(), Ok("1"));
        assert_eq!(
            std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap(),
            std::env::var("DBUS_SYSTEM_BUS_ADDRESS").unwrap()
        );
        const NAME: &str = "org.mpris.MediaPlayer2.control_fixture";
        let fixture = Arc::new(Fixture::default());
        let bus = Builder::session()
            .unwrap()
            .name(NAME)
            .unwrap()
            .serve_at(PATH, Fake(fixture.clone()))
            .unwrap()
            .build()
            .await
            .unwrap();
        // A queued revocation must prevent even the first poll of a lazy
        // method future. Inject a ready raw signal and count future polls.
        let (states, _) = watch::channel(Vec::new());
        let mut actor = connected(states).await.unwrap();
        actor.discover(NAME.to_owned()).await;
        let record = actor.players.get(NAME).unwrap();
        let guard = DispatchGuard {
            name: NAME.into(),
            instance: record.wire.player_instance_id.clone(),
            content: record.wire.content_id.clone().unwrap(),
            owner: record.owner.clone(),
            generation: record.generation,
            action: Action::Pause,
            command_expiry: control::now_ms() + 10_000,
            lease_deadline: None,
            lease_wall_expiry: None,
        };
        let seek = Message::signal(PATH, IFACE, "Seeked")
            .unwrap()
            .sender(record.owner.as_str())
            .unwrap()
            .build(&(1_i64,))
            .unwrap();
        actor.signals = Box::pin(
            futures_util::stream::iter(vec![Ok(seek)]).chain(futures_util::stream::pending()),
        );
        let polls = Cell::new(0);
        let result = actor
            .wait_action(
                async {
                    polls.set(polls.get() + 1);
                    Ok::<_, zbus::Error>(())
                },
                Instant::now() + CALL_LIMIT,
                guard,
            )
            .await;
        assert!(result.is_err());
        assert_eq!(polls.get(), 0);
        let irrelevant = Message::signal(BUS_PATH, BUS, "NameOwnerChanged")
            .unwrap()
            .sender(BUS)
            .unwrap()
            .build(&(":1.unrelated", "", ""))
            .unwrap();
        actor.signals = Box::pin(futures_util::stream::repeat_with(move || {
            Ok(irrelevant.clone())
        }));
        assert!(matches!(
            actor
                .wait(
                    std::future::pending::<Result<(), zbus::Error>>(),
                    Instant::now() + Duration::from_millis(2)
                )
                .await,
            Err(Reason::Timeout)
        ));
        drop(actor);
        let context = context();
        let mut runtime = control::spawn(context.clone());
        let (player, pause, ack) = pause_owned(&mut runtime, &context).await;
        let duplicate = send(&mut runtime, pause.clone()).await;
        assert!(ack == duplicate);
        assert_eq!(fixture.pauses.load(Ordering::SeqCst), 1);
        let mut conflict = pause.clone();
        conflict.content_id = id();
        assert!(send(&mut runtime, conflict).await.reason == Reason::IdConflict);
        let resume = resume(&context, &player, &pause, &ack);
        let resumed = send(&mut runtime, resume.clone()).await;
        assert!(resumed.outcome == Outcome::Applied && resumed.reason == Reason::Resumed);
        assert!(send(&mut runtime, resume).await == resumed);
        assert_eq!(fixture.plays.load(Ordering::SeqCst), 1);

        set_status(&bus, &fixture, 1).await;
        let player = state(&mut runtime, |player| {
            player.playback_status.as_deref() == Some("Paused")
        })
        .await;
        assert!(
            send(&mut runtime, command(&context, &player, Action::Pause))
                .await
                .reason
                == Reason::NotPlaying
        );
        assert!(player.pause_lease.is_none());

        // A transient raw Playing->Paused during a GetAll cannot be erased by
        // the final Playing snapshot and authorize a pause command.
        set_status(&bus, &fixture, 0).await;
        let player = state(&mut runtime, |player| {
            player.playback_status.as_deref() == Some("Playing")
        })
        .await;
        fixture.slow_snapshot.store(true, Ordering::SeqCst);
        runtime
            .commands
            .send(Delivery::new(
                command(&context, &player, Action::Pause),
                false,
            ))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), fixture.entered.notified())
            .await
            .unwrap();
        set_status(&bus, &fixture, 1).await;
        set_status(&bus, &fixture, 0).await;
        let rejected = tokio::time::timeout(Duration::from_secs(3), runtime.acks.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(rejected.outcome == Outcome::Rejected);
        assert_eq!(fixture.pauses.load(Ordering::SeqCst), 1);

        let (player, pause, ack) = pause_owned(&mut runtime, &context).await;
        set_status(&bus, &fixture, 0).await;
        set_status(&bus, &fixture, 1).await;
        state(&mut runtime, |player| {
            player.playback_status.as_deref() == Some("Paused") && player.pause_lease.is_none()
        })
        .await;
        assert!(
            send(&mut runtime, self::resume(&context, &player, &pause, &ack))
                .await
                .reason
                == Reason::NotOwner
        );

        set_status(&bus, &fixture, 0).await;
        let (player, pause, ack) = pause_owned(&mut runtime, &context).await;
        bus.emit_signal(None::<&str>, PATH, IFACE, "Seeked", &(10_i64,))
            .await
            .unwrap();
        state(&mut runtime, |player| player.pause_lease.is_none()).await;
        assert!(
            send(&mut runtime, self::resume(&context, &player, &pause, &ack))
                .await
                .reason
                == Reason::NotOwner
        );

        set_status(&bus, &fixture, 0).await;
        let (player, pause, ack) = pause_owned(&mut runtime, &context).await;
        set_status(&bus, &fixture, 2).await;
        state(&mut runtime, |player| {
            player.playback_status.as_deref() == Some("Stopped")
        })
        .await;
        assert!(
            send(&mut runtime, self::resume(&context, &player, &pause, &ack))
                .await
                .outcome
                == Outcome::Rejected
        );

        set_status(&bus, &fixture, 0).await;
        let (old, pause, ack) = pause_owned(&mut runtime, &context).await;
        fixture.track.store(1, Ordering::SeqCst);
        changed(&bus, "Metadata", metadata("/track/B")).await;
        let b = state(&mut runtime, |player| player.content_id != old.content_id).await;
        fixture.track.store(0, Ordering::SeqCst);
        changed(&bus, "Metadata", metadata("/track/A")).await;
        let new = state(&mut runtime, |player| {
            player.content_id != old.content_id
                && player.content_id != b.content_id
                && player.pause_lease.is_none()
        })
        .await;
        assert!(new.content_id != old.content_id);
        assert!(
            send(&mut runtime, self::resume(&context, &old, &pause, &ack))
                .await
                .reason
                == Reason::ContentChanged
        );

        // Manual transitions inside the Pause call itself must not grant a lease.
        set_status(&bus, &fixture, 0).await;
        let player = state(&mut runtime, |player| {
            player.playback_status.as_deref() == Some("Playing")
        })
        .await;
        fixture.pause_race.store(true, Ordering::SeqCst);
        let race = send(&mut runtime, command(&context, &player, Action::Pause)).await;
        assert!(race.outcome == Outcome::Uncertain && race.resume_token.is_none());
        state(&mut runtime, |player| player.pause_lease.is_none()).await;

        set_status(&bus, &fixture, 0).await;
        let player = state(&mut runtime, |player| {
            player.playback_status.as_deref() == Some("Playing")
        })
        .await;
        let mut expires = command(&context, &player, Action::Pause);
        expires.lease_ttl_ms = Some(1000);
        let expires_ack = send(&mut runtime, expires.clone()).await;
        assert!(expires_ack.outcome == Outcome::Applied);
        state(&mut runtime, |player| player.pause_lease.is_some()).await;
        state(&mut runtime, |player| player.pause_lease.is_none()).await;
        assert!(
            send(
                &mut runtime,
                self::resume(&context, &player, &expires, &expires_ack)
            )
            .await
            .outcome
                == Outcome::Rejected
        );

        let old_instance = player.player_instance_id;
        bus.release_name(NAME).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while runtime
                .states
                .borrow()
                .iter()
                .any(|player| player.player == NAME)
            {
                runtime.states.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        bus.request_name(NAME).await.unwrap();
        let new = state(&mut runtime, |player| player.content_id.is_some()).await;
        assert!(new.player_instance_id != old_instance && new.pause_lease.is_none());
        drop(runtime);
        let mut next_context = context.clone();
        next_context.connection_id = id();
        let mut next = control::spawn(next_context.clone());
        let current = state(&mut next, |player| player.content_id.is_some()).await;
        assert!(
            current.player_instance_id != new.player_instance_id && current.pause_lease.is_none()
        );
        assert!(send(&mut next, expires.clone()).await.reason == Reason::WrongConnection);

        // The method reaches the fixture, then outlives the caller's timeout.
        // Its eventual Paused signal must never manufacture resume ownership.
        set_status(&bus, &fixture, 0).await;
        let player = state(&mut next, |player| {
            player.playback_status.as_deref() == Some("Playing")
        })
        .await;
        let pause_calls = fixture.pauses.load(Ordering::SeqCst);
        let play_calls = fixture.plays.load(Ordering::SeqCst);
        fixture.slow_pause.store(true, Ordering::SeqCst);
        let timed_pause = command(&next_context, &player, Action::Pause);
        let uncertain = send(&mut next, timed_pause.clone()).await;
        assert!(uncertain.outcome == Outcome::Uncertain);
        assert!(matches!(
            uncertain.reason,
            Reason::Timeout | Reason::Unconfirmed
        ));
        assert!(uncertain.resume_token.is_none() && uncertain.lease_expires_at_ms.is_none());
        assert_eq!(fixture.pauses.load(Ordering::SeqCst), pause_calls + 1);
        assert!(send(&mut next, timed_pause.clone()).await == uncertain);
        let late_paused = state(&mut next, |player| {
            player.playback_status.as_deref() == Some("Paused") && player.pause_lease.is_none()
        })
        .await;
        // Even an older genuine token, retargeted to the current player and
        // MQTT epoch, cannot claim this late pause.
        let unauthorized = self::resume(&next_context, &late_paused, &expires, &expires_ack);
        assert!(send(&mut next, unauthorized).await.reason == Reason::NotOwner);
        assert!(send(&mut next, timed_pause).await == uncertain);
        assert_eq!(fixture.pauses.load(Ordering::SeqCst), pause_calls + 1);
        assert_eq!(fixture.plays.load(Ordering::SeqCst), play_calls);

        // URL fallback has the same observed-generation guarantees as trackid:
        // URL A->B->A never resurrects the original content id or owned pause.
        fixture.identity_mode.store(2, Ordering::SeqCst);
        fixture.track.store(0, Ordering::SeqCst);
        changed(
            &bus,
            "Metadata",
            zbus::zvariant::Value::from(fixture_metadata(&fixture))
                .try_into()
                .unwrap(),
        )
        .await;
        state(&mut next, |player| {
            player.content_id.is_some() && player.content_id != late_paused.content_id
        })
        .await;
        set_status(&bus, &fixture, 0).await;
        let (url_a, _, _) = pause_owned(&mut next, &next_context).await;
        fixture.track.store(1, Ordering::SeqCst);
        changed(
            &bus,
            "Metadata",
            zbus::zvariant::Value::from(fixture_metadata(&fixture))
                .try_into()
                .unwrap(),
        )
        .await;
        let url_b = state(&mut next, |player| {
            player.content_id != url_a.content_id && player.pause_lease.is_none()
        })
        .await;
        fixture.track.store(0, Ordering::SeqCst);
        changed(
            &bus,
            "Metadata",
            zbus::zvariant::Value::from(fixture_metadata(&fixture))
                .try_into()
                .unwrap(),
        )
        .await;
        state(&mut next, |player| {
            player.content_id != url_a.content_id && player.content_id != url_b.content_id
        })
        .await;
        set_status(&bus, &fixture, 0).await;
        let (identified, owned_pause, owned_ack) = pause_owned(&mut next, &next_context).await;
        fixture.identity_mode.store(3, Ordering::SeqCst);
        changed(
            &bus,
            "Metadata",
            zbus::zvariant::Value::from(fixture_metadata(&fixture))
                .try_into()
                .unwrap(),
        )
        .await;
        state(&mut next, |player| {
            player.content_id.is_none()
                && !player.can_pause
                && !player.can_play
                && player.pause_lease.is_none()
        })
        .await;
        let revoked = self::resume(&next_context, &identified, &owned_pause, &owned_ack);
        assert!(send(&mut next, revoked).await.reason == Reason::ContentChanged);
        assert_eq!(fixture.plays.load(Ordering::SeqCst), play_calls);
    }
}

#[cfg(test)]
mod composition_tests {
    use super::tests::{Fake, Fixture, command};
    use super::*;
    use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS};

    async fn packet(
        packets: &mut mpsc::Receiver<rumqttc::Publish>,
        topic: &str,
        predicate: impl Fn(&[u8]) -> bool,
    ) -> Vec<u8> {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let packet = packets
                    .recv()
                    .await
                    .expect("fixture controller disconnected");
                if packet.topic == topic && predicate(&packet.payload) {
                    return packet.payload.to_vec();
                }
            }
        })
        .await
        .expect("expected MQTT control packet")
    }

    /// Composition evidence: real local broker + MQTT actor + isolated fake
    /// MPRIS. These synthetic credentials are only for this anonymous fixture.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires private dbus-run-session, LUGN_TEST_DBUS=1 and Mosquitto"]
    async fn dbus_lifecycle_control_mqtt() {
        use std::sync::{Arc, atomic::Ordering};
        assert_eq!(std::env::var("LUGN_TEST_DBUS").as_deref(), Ok("1"));
        assert_eq!(
            std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap(),
            std::env::var("DBUS_SYSTEM_BUS_ADDRESS").unwrap()
        );
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let directory = tempfile::tempdir().unwrap();
        let broker_config = directory.path().join("mosquitto.conf");
        std::fs::write(
            &broker_config,
            format!("listener {port} 127.0.0.1\nallow_anonymous true\npersistence false\n"),
        )
        .unwrap();
        let mut broker = tokio::process::Command::new(
            std::env::var("LUGN_TEST_BROKER").unwrap_or_else(|_| "/usr/sbin/mosquitto".into()),
        )
        .arg("-c")
        .arg(&broker_config)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if tokio::net::TcpStream::connect(("127.0.0.1", port))
                    .await
                    .is_ok()
                {
                    break;
                }
                assert!(
                    broker.try_wait().unwrap().is_none(),
                    "fixture broker exited"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let fixture = Arc::new(Fixture::default());
        fixture.identity_mode.store(1, Ordering::SeqCst);
        let _bus = Builder::session()
            .unwrap()
            .name("org.mpris.MediaPlayer2.control_mqtt_fixture")
            .unwrap()
            .serve_at(PATH, Fake(fixture.clone()))
            .unwrap()
            .build()
            .await
            .unwrap();
        let config: crate::config::Config = toml::from_str(&format!("device_id='control_fixture'\nmqtt_host='127.0.0.1'\nmqtt_port={port}\nheartbeat_secs=5\ncontrol_enabled=true\nmqtt_username='fixture'\nmqtt_password='fixture'\ntopic_prefix='lugn-test-{}'", id())).unwrap();
        let state_topic = config.topic("control/state");
        let ack_topic = config.topic("control/ack");
        let command_topic = config.topic("control/command");
        let options = MqttOptions::new(format!("test-controller-{}", id()), "127.0.0.1", port);
        let (client, mut events) = AsyncClient::new(options, 32);
        let (published, mut packets) = mpsc::channel(64);
        let controller = tokio::spawn(async move {
            loop {
                match events.poll().await {
                    Ok(Event::Incoming(Packet::Publish(message))) => {
                        if published.send(message).await.is_err() {
                            return;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => return,
                }
            }
        });
        client
            .subscribe(config.topic("control/#"), QoS::AtLeastOnce)
            .await
            .unwrap();
        let (_observations, observations) = watch::channel(crate::state::Observations::default());
        let agent_config = config.clone();
        let agent_observations = observations.clone();
        let mut agent =
            tokio::spawn(async move { crate::mqtt::run(agent_config, agent_observations).await });
        let initial = packet(&mut packets, &state_topic, |body| {
            serde_json::from_slice::<control::State>(body).is_ok_and(|state| {
                state.players.iter().any(|player| {
                    player.player.ends_with("control_mqtt_fixture") && player.can_pause
                })
            })
        })
        .await;
        let state: control::State = serde_json::from_slice(&initial).unwrap();
        let context = Context {
            device_id: state.device_id,
            session_id: state.session_id,
            connection_id: state.connection_id,
        };
        let player = state
            .players
            .into_iter()
            .find(|player| player.player.ends_with("control_mqtt_fixture"))
            .unwrap();
        let pause = command(&context, &player, Action::Pause);
        client
            .publish(
                &command_topic,
                QoS::AtLeastOnce,
                false,
                serde_json::to_vec(&pause).unwrap(),
            )
            .await
            .unwrap();
        let ack = packet(&mut packets, &ack_topic, |body| {
            serde_json::from_slice::<Ack>(body).is_ok_and(|ack| ack.command_id == pause.command_id)
        })
        .await;
        let paused: Ack = serde_json::from_slice(&ack).unwrap();
        assert!(paused.outcome == Outcome::Applied && paused.reason == Reason::Paused);
        assert_eq!(fixture.pauses.load(Ordering::SeqCst), 1);
        client
            .publish(
                &command_topic,
                QoS::AtLeastOnce,
                false,
                serde_json::to_vec(&pause).unwrap(),
            )
            .await
            .unwrap();
        let duplicate = packet(&mut packets, &ack_topic, |body| {
            serde_json::from_slice::<Ack>(body).is_ok_and(|ack| ack.command_id == pause.command_id)
        })
        .await;
        assert!(serde_json::from_slice::<Ack>(&duplicate).unwrap() == paused);
        assert_eq!(fixture.pauses.load(Ordering::SeqCst), 1);
        let resume = super::tests::resume(&context, &player, &pause, &paused);
        client
            .publish(
                &command_topic,
                QoS::AtLeastOnce,
                false,
                serde_json::to_vec(&resume).unwrap(),
            )
            .await
            .unwrap();
        let resumed = packet(&mut packets, &ack_topic, |body| {
            serde_json::from_slice::<Ack>(body).is_ok_and(|ack| ack.command_id == resume.command_id)
        })
        .await;
        assert!(serde_json::from_slice::<Ack>(&resumed).unwrap().reason == Reason::Resumed);
        assert_eq!(fixture.plays.load(Ordering::SeqCst), 1);
        agent.abort();
        let _ = agent.await;
        // Store an old command while the agent is absent, then create a fresh
        // MQTT/control epoch. Retained delivery cannot operate the fixture.
        client
            .publish(
                &command_topic,
                QoS::AtLeastOnce,
                true,
                serde_json::to_vec(&pause).unwrap(),
            )
            .await
            .unwrap();
        // Seeing our own publication proves the broker processed its retained
        // value before the replacement agent subscribes.
        packet(&mut packets, &command_topic, |body| {
            serde_json::from_slice::<Command>(body)
                .is_ok_and(|command| command.command_id == pause.command_id)
        })
        .await;
        let agent_config = config.clone();
        agent = tokio::spawn(async move { crate::mqtt::run(agent_config, observations).await });
        packet(&mut packets, &state_topic, |body| {
            serde_json::from_slice::<control::State>(body).is_ok_and(|state| {
                state.connection_id != context.connection_id
                    && state.players.iter().any(|player| {
                        player.player.ends_with("control_mqtt_fixture") && player.can_pause
                    })
            })
        })
        .await;
        client
            .publish(
                &command_topic,
                QoS::AtLeastOnce,
                false,
                serde_json::to_vec(&resume).unwrap(),
            )
            .await
            .unwrap();
        let stale = packet(&mut packets, &ack_topic, |body| {
            serde_json::from_slice::<Ack>(body).is_ok_and(|ack| {
                ack.command_id == resume.command_id && ack.outcome == Outcome::Rejected
            })
        })
        .await;
        assert!(matches!(
            serde_json::from_slice::<Ack>(&stale).unwrap().reason,
            Reason::WrongSession | Reason::WrongConnection | Reason::Retained
        ));
        assert_eq!(fixture.pauses.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.plays.load(Ordering::SeqCst), 1);
        agent.abort();
        let _ = agent.await;
        controller.abort();
        let _ = controller.await;
        broker.kill().await.unwrap();
    }
}
