//! Native D-Bus observations. Subscriptions precede snapshots; only unavailable
//! APIs and disconnected buses use retry timers. No playback-position polling.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    time::Duration,
};

use anyhow::{Context, Result};
use futures_util::{
    StreamExt,
    stream::{self, select_all},
};
use tokio::{sync::mpsc::Sender, time::Instant};
use zbus::zvariant::OwnedValue;
use zbus::{Connection, MatchRule, Message, MessageStream, connection::Builder, message::Type};

use crate::state::{Event, Media};

const DBUS: &str = "org.freedesktop.DBus";
const DBUS_PATH: &str = "/org/freedesktop/DBus";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const SCREEN: &str = "org.freedesktop.ScreenSaver";
const SCREEN_PATH: &str = "/ScreenSaver";
const MPRIS: &str = "org.mpris.MediaPlayer2";
const MPRIS_PREFIX: &str = "org.mpris.MediaPlayer2.";
const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const NETWORK: &str = "org.freedesktop.NetworkManager";
const NETWORK_PATH: &str = "/org/freedesktop/NetworkManager";
const METHOD_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_RETRY: Duration = Duration::from_secs(60);
const MAX_PLAYERS: usize = 64;
const MAX_TEXT: usize = 512;
const MAX_ARTISTS: usize = 64;
const MAX_MEDIA_BYTES: usize = 96 * 1024;

type Properties = HashMap<String, OwnedValue>;
type PropertyChange = (String, Properties, Vec<String>);

pub async fn session(tx: Sender<Event>) {
    // Slow or broken media players must never delay screen-lock observations.
    tokio::join!(lock_collector(tx.clone()), media_collector(tx));
}

async fn media_collector(tx: Sender<Event>) {
    let mut output = SessionOutput { tx, media: None };
    let mut retry = Duration::from_secs(1);
    loop {
        if output.players(None).await.is_err() {
            return;
        }
        let started = Instant::now();
        if let Err(error) = session_connected(&mut output).await {
            if output.tx.is_closed() {
                return;
            }
            eprintln!("Session D-Bus observation unavailable: {error:#}");
        }
        if output.players(None).await.is_err() {
            return;
        }
        if started.elapsed() >= MAX_RETRY {
            retry = Duration::from_secs(1);
        }
        if !retry_delay(&output.tx, retry).await {
            return;
        }
        retry = (retry * 2).min(MAX_RETRY);
    }
}

async fn lock_collector(tx: Sender<Event>) {
    let mut last = None;
    let mut retry = Duration::from_secs(1);
    loop {
        if emit_lock(&tx, &mut last, None).await.is_err() {
            return;
        }
        let started = Instant::now();
        if let Err(error) = lock_connected(&tx, &mut last).await {
            if tx.is_closed() {
                return;
            }
            eprintln!("Screen-lock observation unavailable: {error:#}");
        }
        if emit_lock(&tx, &mut last, None).await.is_err() {
            return;
        }
        if started.elapsed() >= MAX_RETRY {
            retry = Duration::from_secs(1);
        }
        if !retry_delay(&tx, retry).await {
            return;
        }
        retry = (retry * 2).min(MAX_RETRY);
    }
}

async fn emit_lock(
    tx: &Sender<Event>,
    last: &mut Option<Option<bool>>,
    value: Option<bool>,
) -> Result<()> {
    if *last != Some(value) {
        tx.send(Event::Lock(value))
            .await
            .context("observation receiver closed")?;
        *last = Some(value);
    }
    Ok(())
}

async fn read_lock(
    connection: &Connection,
    service_owner: &mut Option<String>,
) -> Result<Option<bool>> {
    *service_owner = owner(connection, SCREEN).await?;
    let Some(owner) = service_owner.as_deref() else {
        return Ok(None);
    };
    let reply = connection
        .call_method(Some(owner), SCREEN_PATH, Some(SCREEN), "GetActive", &())
        .await?;
    Ok(Some(reply.body().deserialize()?))
}

async fn lock_connected(tx: &Sender<Event>, last: &mut Option<Option<bool>>) -> Result<()> {
    let connection = connect(false).await?;
    let owners = owner_stream(&connection).await?;
    let active = signal_stream(&connection, SCREEN, SCREEN_PATH, "ActiveChanged").await?;
    let mut signals = select_all(vec![owners, active]);
    let mut service_owner = None;
    let result = read_lock(&connection, &mut service_owner).await;
    let mut failed = result.is_err();
    emit_lock(tx, last, result.ok().flatten()).await?;
    let mut retry = Duration::from_secs(1);
    let mut deadline = Instant::now() + retry;
    loop {
        tokio::select! {
            _ = tx.closed() => return Ok(()),
            _ = tokio::time::sleep_until(deadline), if failed => {
                let result = read_lock(&connection, &mut service_owner).await;
                failed = result.is_err();
                emit_lock(tx, last, result.ok().flatten()).await?;
                retry = (retry * 2).min(MAX_RETRY);
                deadline = Instant::now() + retry;
            }
            message = signals.next() => {
                let message = message.context("screen-lock D-Bus signal stream closed")??;
                match message.header().member().map(|member| member.as_str()) {
                    Some("NameOwnerChanged") => {
                        let (name, _, _): (String, String, String) = message.body().deserialize()?;
                        if name != SCREEN { continue; }
                    }
                    Some("ActiveChanged") if message_sender(&message).as_deref() == service_owner.as_deref() => {}
                    _ => continue,
                }
                // Read current state so queued pre-snapshot events cannot
                // overwrite a more recent snapshot with their older values.
                let result = read_lock(&connection, &mut service_owner).await;
                let was_failed = failed;
                failed = result.is_err();
                emit_lock(tx, last, result.ok().flatten()).await?;
                if !failed { retry = Duration::from_secs(1); }
                else if !was_failed { deadline = Instant::now() + retry; }
            }
        }
    }
}

pub async fn network(tx: Sender<Event>) {
    let mut last = None;
    let mut retry = Duration::from_secs(1);
    loop {
        if emit_network(&tx, &mut last, None).await.is_err() {
            return;
        }
        let started = Instant::now();
        if let Err(error) = network_connected(&tx, &mut last).await {
            if tx.is_closed() {
                return;
            }
            eprintln!("NetworkManager observation unavailable: {error:#}");
        }
        if emit_network(&tx, &mut last, None).await.is_err() {
            return;
        }
        if started.elapsed() >= MAX_RETRY {
            retry = Duration::from_secs(1);
        }
        if !retry_delay(&tx, retry).await {
            return;
        }
        retry = (retry * 2).min(MAX_RETRY);
    }
}

async fn retry_delay(tx: &Sender<Event>, delay: Duration) -> bool {
    tokio::select! {
        _ = tx.closed() => false,
        _ = tokio::time::sleep(delay) => true,
    }
}

async fn connect(system: bool) -> Result<Connection> {
    let builder = if system {
        Builder::system()?
    } else {
        Builder::session()?
    };
    tokio::time::timeout(
        METHOD_TIMEOUT,
        builder
            .max_queued(64)
            .method_timeout(METHOD_TIMEOUT)
            .build(),
    )
    .await
    .context("D-Bus connection timeout")?
    .context("connect D-Bus")
}

async fn owner_stream(connection: &Connection) -> Result<MessageStream> {
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender(DBUS)?
        .path(DBUS_PATH)?
        .interface(DBUS)?
        .member("NameOwnerChanged")?
        .build();
    Ok(MessageStream::for_match_rule(rule, connection, Some(64)).await?)
}

async fn signal_stream(
    connection: &Connection,
    interface: &str,
    path: &str,
    member: &str,
) -> Result<MessageStream> {
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .interface(interface)?
        .path(path)?
        .member(member)?
        .build();
    Ok(MessageStream::for_match_rule(rule, connection, Some(64)).await?)
}

async fn owner(connection: &Connection, name: &str) -> Result<Option<String>> {
    let reply = connection
        .call_method(Some(DBUS), DBUS_PATH, Some(DBUS), "GetNameOwner", &(name,))
        .await;
    match reply {
        Ok(reply) => Ok(Some(reply.body().deserialize::<String>()?)),
        Err(zbus::Error::MethodError(name, _, _))
            if name.as_str() == "org.freedesktop.DBus.Error.NameHasNoOwner" =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

async fn get_all(connection: &Connection, owner: &str, interface: &str) -> Result<Properties> {
    Ok(connection
        .call_method(
            Some(owner),
            MPRIS_PATH,
            Some(PROPERTIES),
            "GetAll",
            &(interface,),
        )
        .await?
        .body()
        .deserialize()?)
}

struct SessionOutput {
    tx: Sender<Event>,
    media: Option<Option<Vec<Media>>>,
}

impl SessionOutput {
    async fn players(&mut self, media: Option<Vec<Media>>) -> Result<()> {
        if self.media.as_ref() != Some(&media) {
            self.tx
                .send(Event::Media(media.clone()))
                .await
                .context("observation receiver closed")?;
            self.media = Some(media);
        }
        Ok(())
    }
}

#[derive(Default)]
struct SessionState {
    players: BTreeMap<String, PlayerState>,
}

struct PlayerState {
    owner: String,
    media: Option<Media>,
}

impl SessionState {
    async fn discover_players(
        &mut self,
        connection: &Connection,
        changed: Option<&str>,
    ) -> Result<()> {
        let reply = connection
            .call_method(Some(DBUS), DBUS_PATH, Some(DBUS), "ListNames", &())
            .await?;
        let mut names: Vec<String> = reply.body().deserialize()?;
        names.sort();
        let selected: BTreeSet<_> = names
            .into_iter()
            .filter(|name| name.starts_with(MPRIS_PREFIX))
            .take(MAX_PLAYERS)
            .collect();
        self.players.retain(|name, _| selected.contains(name));
        let refresh = selected
            .into_iter()
            .filter(|name| !self.players.contains_key(name) || changed == Some(name.as_str()))
            .collect();
        self.refresh_players(connection, refresh).await;
        Ok(())
    }

    async fn refresh_players(&mut self, connection: &Connection, names: Vec<String>) {
        let mut queries = stream::iter(names)
            .map(|name| async move {
                let player = query_player(connection, &name).await;
                (name, player)
            })
            .buffer_unordered(8);
        while let Some((name, player)) = queries.next().await {
            if let Some(player) = player {
                if self.players.contains_key(&name) || self.players.len() < MAX_PLAYERS {
                    self.players.insert(name, player);
                }
            } else {
                self.players.remove(&name);
            }
        }
    }

    fn failed(&self) -> bool {
        self.players.values().any(|player| player.media.is_none())
    }

    async fn publish(&self, output: &mut SessionOutput) -> Result<()> {
        let media: Option<Vec<_>> = self
            .players
            .values()
            .map(|player| player.media.clone())
            .collect();
        output.players(media.map(limit_media)).await
    }
}

async fn query_player(connection: &Connection, name: &str) -> Option<PlayerState> {
    let result = owner(connection, name).await;
    if matches!(result, Ok(None)) {
        return None;
    }
    let player_owner = result.ok().flatten().unwrap_or_default();
    let media = if player_owner.is_empty() {
        None
    } else {
        let result = async {
            let root = get_all(connection, &player_owner, MPRIS).await?;
            let player = get_all(connection, &player_owner, PLAYER).await?;
            let media = parse_media(name, root, player);
            // PlaybackStatus is required by MPRIS. Some services omit a
            // property whose getter failed while returning a successful GetAll.
            media
                .playback_status
                .as_ref()
                .context("MPRIS PlaybackStatus missing or invalid")?;
            Ok::<_, anyhow::Error>(media)
        }
        .await;
        result.ok()
    };
    Some(PlayerState {
        owner: player_owner,
        media,
    })
}

async fn session_connected(output: &mut SessionOutput) -> Result<()> {
    let connection = connect(false).await?;
    // Register every relevant signal before querying owners and initial state.
    let owners = owner_stream(&connection).await?;
    let properties =
        signal_stream(&connection, PROPERTIES, MPRIS_PATH, "PropertiesChanged").await?;
    let mut signals = select_all(vec![owners, properties]);
    let mut state = SessionState::default();
    state.discover_players(&connection, None).await?;
    state.publish(output).await?;
    let mut retry = Duration::from_secs(1);
    let mut deadline = Instant::now() + retry;
    loop {
        tokio::select! {
            _ = output.tx.closed() => return Ok(()),
            _ = tokio::time::sleep_until(deadline), if state.failed() => {
                let failed: Vec<_> = state.players.iter().filter(|(_, player)| player.media.is_none())
                    .map(|(name, _)| name.clone()).collect();
                state.refresh_players(&connection, failed).await;
                state.publish(output).await?;
                retry = (retry * 2).min(MAX_RETRY);
                deadline = Instant::now() + retry;
            }
            message = signals.next() => {
                let message = message.context("session D-Bus signal stream closed")??;
                let failed_before = state.failed();
                match message.header().member().map(|member| member.as_str()) {
                    Some("NameOwnerChanged") => {
                        let (name, _, _): (String, String, String) = message.body().deserialize()?;
                        if name.starts_with(MPRIS_PREFIX) {
                            output.players(None).await?;
                            state.discover_players(&connection, Some(&name)).await?;
                        } else { continue; }
                    }
                    Some("PropertiesChanged") => {
                        let names: Vec<_> = state.players.iter()
                            .filter(|(_, player)| Some(player.owner.as_str()) == message_sender(&message).as_deref())
                            .map(|(name, _)| name.clone()).collect();
                        if names.is_empty() { continue; }
                        let (interface, changed, invalidated): PropertyChange = message.body().deserialize()?;
                        if !relevant_media_change(&interface, &changed, &invalidated) { continue; }
                        output.players(None).await?;
                        state.refresh_players(&connection, names).await;
                    }
                    _ => continue,
                }
                state.publish(output).await?;
                if !state.failed() {
                    retry = Duration::from_secs(1);
                } else if !failed_before {
                    deadline = Instant::now() + retry;
                }
            }
        }
    }
}

fn message_sender(message: &Message) -> Option<String> {
    message
        .header()
        .sender()
        .map(|name| name.as_str().to_owned())
}

fn relevant_media_change(interface: &str, changed: &Properties, invalidated: &[String]) -> bool {
    let keys: &[&str] = match interface {
        MPRIS => &["Identity", "DesktopEntry"],
        PLAYER => &["PlaybackStatus", "Metadata"],
        _ => return false,
    };
    keys.iter()
        .any(|key| changed.contains_key(*key) || invalidated.iter().any(|name| name == key))
}

fn text(value: &str) -> String {
    let mut end = value.len().min(MAX_TEXT);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn string(properties: &Properties, key: &str) -> Option<String> {
    properties
        .get(key)
        .and_then(|value| <&str>::try_from(value).ok())
        .map(text)
}

fn parse_media(name: &str, root: Properties, mut player: Properties) -> Media {
    let status = string(&player, "PlaybackStatus")
        .filter(|status| matches!(status.as_str(), "Playing" | "Paused" | "Stopped"));
    let mut metadata: Properties = player
        .remove("Metadata")
        .and_then(|value| Properties::try_from(value).ok())
        .unwrap_or_default();
    let artists = metadata
        .remove("xesam:artist")
        .and_then(|value| Vec::<String>::try_from(value).ok())
        .map(|values| {
            values
                .into_iter()
                .take(MAX_ARTISTS)
                .map(|value| text(&value))
                .collect()
        });
    Media {
        player: text(name),
        identity: string(&root, "Identity"),
        desktop_entry: string(&root, "DesktopEntry"),
        playback_status: status,
        title: string(&metadata, "xesam:title"),
        artists,
        album: string(&metadata, "xesam:album"),
        content_type: string(&metadata, "xesam:contentType"),
    }
}

fn limit_media(media: Vec<Media>) -> Vec<Media> {
    let mut result = Vec::new();
    let mut bytes = 2; // enclosing JSON array
    for mut player in media.into_iter().take(MAX_PLAYERS) {
        let Ok(mut encoded) = serde_json::to_vec(&player) else {
            continue;
        };
        // Escape expansion can make 64 bounded artist strings exceed the wire
        // budget on their own. Preserve the player/status and trim that list.
        while bytes + encoded.len() + usize::from(!result.is_empty()) > MAX_MEDIA_BYTES {
            let Some(artists) = player.artists.as_mut() else {
                break;
            };
            if artists.pop().is_none() {
                break;
            }
            encoded = serde_json::to_vec(&player).unwrap();
        }
        let added = encoded.len() + usize::from(!result.is_empty());
        if bytes + added > MAX_MEDIA_BYTES {
            break;
        }
        bytes += added;
        result.push(player);
    }
    result
}

async fn emit_network(
    tx: &Sender<Event>,
    last: &mut Option<Option<bool>>,
    value: Option<bool>,
) -> Result<()> {
    if *last != Some(value) {
        tx.send(Event::Network(value))
            .await
            .context("observation receiver closed")?;
        *last = Some(value);
    }
    Ok(())
}

fn connectivity(value: u32) -> Option<bool> {
    match value {
        4 => Some(true),
        1..=3 => Some(false),
        _ => None,
    }
}

async fn read_connectivity(
    connection: &Connection,
    service_owner: &mut Option<String>,
) -> Result<Option<bool>> {
    *service_owner = owner(connection, NETWORK).await?;
    let Some(owner) = service_owner.as_deref() else {
        return Ok(None);
    };
    // Read the last known observation; CheckConnectivity would force a probe.
    let reply = connection
        .call_method(
            Some(owner),
            NETWORK_PATH,
            Some(PROPERTIES),
            "Get",
            &(NETWORK, "Connectivity"),
        )
        .await?;
    let value: OwnedValue = reply.body().deserialize()?;
    Ok(connectivity(u32::try_from(value)?))
}

async fn network_connected(tx: &Sender<Event>, last: &mut Option<Option<bool>>) -> Result<()> {
    let connection = connect(true).await?;
    let owners = owner_stream(&connection).await?;
    let properties =
        signal_stream(&connection, PROPERTIES, NETWORK_PATH, "PropertiesChanged").await?;
    let mut signals = select_all(vec![owners, properties]);
    let mut service_owner = None;
    let result = read_connectivity(&connection, &mut service_owner).await;
    let mut failed = result.is_err();
    emit_network(tx, last, result.ok().flatten()).await?;
    let mut retry = Duration::from_secs(1);
    let mut deadline = Instant::now() + retry;
    loop {
        tokio::select! {
            _ = tx.closed() => return Ok(()),
            _ = tokio::time::sleep_until(deadline), if failed => {
                let result = read_connectivity(&connection, &mut service_owner).await;
                failed = result.is_err();
                emit_network(tx, last, result.ok().flatten()).await?;
                retry = (retry * 2).min(MAX_RETRY);
                deadline = Instant::now() + retry;
            }
            message = signals.next() => {
                let message = message.context("system D-Bus signal stream closed")??;
                match message.header().member().map(|member| member.as_str()) {
                    Some("NameOwnerChanged") => {
                        let (name, _, _): (String, String, String) = message.body().deserialize()?;
                        if name != NETWORK { continue; }
                    }
                    Some("PropertiesChanged") if message_sender(&message).as_deref() == service_owner.as_deref() => {
                        let (interface, changed, invalidated): PropertyChange = message.body().deserialize()?;
                        if interface != NETWORK || (!changed.contains_key("Connectivity") && !invalidated.iter().any(|name| name == "Connectivity")) { continue; }
                    }
                    _ => continue,
                }
                let result = read_connectivity(&connection, &mut service_owner).await;
                let was_failed = failed;
                failed = result.is_err();
                emit_network(tx, last, result.ok().flatten()).await?;
                if !failed { retry = Duration::from_secs(1); }
                else if !was_failed { deadline = Instant::now() + retry; }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Observations;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering},
    };
    use zbus::zvariant::{Array, Str, Value};

    fn value(text: &str) -> OwnedValue {
        OwnedValue::from(Str::from(text))
    }

    #[test]
    fn network_connectivity_preserves_unknown() {
        assert_eq!(connectivity(0), None);
        for value in 1..=3 {
            assert_eq!(connectivity(value), Some(false));
        }
        assert_eq!(connectivity(4), Some(true));
        assert_eq!(connectivity(5), None);
    }

    #[test]
    fn metadata_only_uses_explicit_content_type_and_handles_optional_values() {
        let metadata: Properties = [
            ("xesam:title".into(), value("Movie title.mp4")),
            ("xesam:url".into(), value("file:///private/movie.mp4")),
            (
                "xesam:artist".into(),
                OwnedValue::try_from(Array::from(vec!["Artist"])).unwrap(),
            ),
        ]
        .into();
        let player: Properties = [
            ("PlaybackStatus".into(), value("Playing")),
            (
                "Metadata".into(),
                OwnedValue::try_from(Value::from(metadata)).unwrap(),
            ),
        ]
        .into();
        let media = parse_media("org.mpris.MediaPlayer2.example", Properties::new(), player);
        assert_eq!(media.title.as_deref(), Some("Movie title.mp4"));
        assert_eq!(media.artists, Some(vec!["Artist".into()]));
        assert_eq!(media.playback_status.as_deref(), Some("Playing"));
        assert_eq!(media.content_type, None);
        assert_eq!(media.identity, None);
    }

    #[test]
    fn bounds_utf8_text_artists_and_serialized_collection() {
        let long = "å".repeat(400);
        assert_eq!(text(&long).len(), MAX_TEXT);
        let artists = vec![long.clone(); MAX_ARTISTS + 2];
        let metadata: Properties = [
            ("xesam:contentType".into(), value("audio/flac")),
            (
                "xesam:artist".into(),
                OwnedValue::try_from(Array::from(artists)).unwrap(),
            ),
        ]
        .into();
        let player: Properties = [(
            "Metadata".into(),
            OwnedValue::try_from(Value::from(metadata)).unwrap(),
        )]
        .into();
        let media = parse_media("example", Properties::new(), player);
        assert_eq!(media.artists.as_ref().unwrap().len(), MAX_ARTISTS);
        assert_eq!(media.content_type.as_deref(), Some("audio/flac"));
        let limited = limit_media(vec![media; MAX_PLAYERS]);
        assert!(!limited.is_empty());
        assert!(limited.len() < MAX_PLAYERS);
        assert!(serde_json::to_vec(&limited).unwrap().len() <= MAX_MEDIA_BYTES);
        let escaped = Media {
            player: "example".into(),
            playback_status: Some("Playing".into()),
            artists: Some(vec!["\u{0001}".repeat(MAX_TEXT); MAX_ARTISTS]),
            ..Default::default()
        };
        let escaped = limit_media(vec![escaped]);
        assert_eq!(escaped.len(), 1);
        assert_eq!(escaped[0].playback_status.as_deref(), Some("Playing"));
        assert!(serde_json::to_vec(&escaped).unwrap().len() <= MAX_MEDIA_BYTES);
    }

    #[test]
    fn ignores_position_and_refreshes_invalidated_metadata() {
        let properties: Properties = [("Position".into(), OwnedValue::from(100_i64))].into();
        assert!(!relevant_media_change(PLAYER, &properties, &[]));
        assert!(relevant_media_change(
            PLAYER,
            &properties,
            &["Metadata".into()]
        ));
        assert!(!relevant_media_change(
            "other.interface",
            &Properties::new(),
            &["Metadata".into()]
        ));
    }

    struct FakeScreen(Arc<AtomicBool>);

    #[zbus::interface(name = "org.freedesktop.ScreenSaver")]
    impl FakeScreen {
        fn get_active(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct FakeRoot;

    #[zbus::interface(name = "org.mpris.MediaPlayer2")]
    impl FakeRoot {
        #[zbus(property)]
        fn identity(&self) -> &str {
            "Isolated fixture"
        }
        #[zbus(property)]
        fn desktop_entry(&self) -> &str {
            "lugn-fixture"
        }
    }

    struct FakePlayer {
        status: Arc<AtomicU8>,
        failures: Arc<AtomicU32>,
        slow_once: Arc<AtomicBool>,
        entered: Arc<tokio::sync::Notify>,
    }

    #[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
    impl FakePlayer {
        #[zbus(property)]
        async fn playback_status(&self) -> zbus::fdo::Result<&str> {
            if self.slow_once.swap(false, Ordering::SeqCst) {
                self.entered.notify_one();
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            if self.failures.swap(0, Ordering::SeqCst) > 0 {
                return Err(zbus::fdo::Error::Failed("fixture transient failure".into()));
            }
            Ok(if self.status.load(Ordering::SeqCst) == 0 {
                "Playing"
            } else {
                "Paused"
            })
        }
        #[zbus(property)]
        fn metadata(&self) -> Properties {
            [
                ("xesam:title".into(), value("Fixture song")),
                ("xesam:contentType".into(), value("audio/flac")),
            ]
            .into()
        }
    }

    struct FakeNetwork(Arc<AtomicU32>);

    #[zbus::interface(name = "org.freedesktop.NetworkManager")]
    impl FakeNetwork {
        #[zbus(property)]
        fn connectivity(&self) -> u32 {
            self.0.load(Ordering::SeqCst)
        }
    }

    async fn until(
        rx: &mut tokio::sync::mpsc::Receiver<Event>,
        observations: &mut Observations,
        predicate: impl Fn(&Observations) -> bool,
    ) {
        tokio::time::timeout(Duration::from_secs(8), async {
            while !predicate(observations) {
                observations.apply(rx.recv().await.expect("collector stopped"));
            }
        })
        .await
        .expect("expected D-Bus observation did not arrive");
    }

    async fn changed(
        connection: &Connection,
        path: &str,
        interface: &str,
        key: &str,
        value: OwnedValue,
    ) {
        let properties: Properties = [(key.to_owned(), value)].into();
        connection
            .emit_signal(
                None::<&str>,
                path,
                PROPERTIES,
                "PropertiesChanged",
                &(interface, properties, Vec::<String>::new()),
            )
            .await
            .unwrap();
    }

    /// Run only on a private bus, with the system address deliberately pointed
    /// at that same isolated daemon. No KDE or NetworkManager names on the host
    /// are acquired, released, or otherwise changed.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires isolated dbus-run-session and LUGN_TEST_DBUS=1"]
    async fn dbus_lifecycle() {
        assert_eq!(std::env::var("LUGN_TEST_DBUS").as_deref(), Ok("1"));
        let session_address = std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap();
        assert_eq!(
            std::env::var("DBUS_SYSTEM_BUS_ADDRESS").unwrap(),
            session_address
        );
        const NAME: &str = "org.mpris.MediaPlayer2.lugn_fixture";
        let locked = Arc::new(AtomicBool::new(false));
        let status = Arc::new(AtomicU8::new(0));
        let failures = Arc::new(AtomicU32::new(0));
        let slow_once = Arc::new(AtomicBool::new(false));
        let entered = Arc::new(tokio::sync::Notify::new());
        let online = Arc::new(AtomicU32::new(4));
        let fixture = Builder::session()
            .unwrap()
            .name(SCREEN)
            .unwrap()
            .name(NAME)
            .unwrap()
            .name(NETWORK)
            .unwrap()
            .serve_at(SCREEN_PATH, FakeScreen(locked.clone()))
            .unwrap()
            .serve_at(MPRIS_PATH, FakeRoot)
            .unwrap()
            .serve_at(
                MPRIS_PATH,
                FakePlayer {
                    status: status.clone(),
                    failures: failures.clone(),
                    slow_once: slow_once.clone(),
                    entered: entered.clone(),
                },
            )
            .unwrap()
            .serve_at(NETWORK_PATH, FakeNetwork(online.clone()))
            .unwrap()
            .build()
            .await
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let session_task = tokio::spawn(session(tx.clone()));
        let network_task = tokio::spawn(network(tx));
        let mut observations = Observations::default();
        until(&mut rx, &mut observations, |state| {
            state.locked == Some(false)
                && state.network_online == Some(true)
                && state.media.as_ref().is_some_and(|players| {
                    players.len() == 1 && players[0].playback_status.as_deref() == Some("Playing")
                })
        })
        .await;
        assert_eq!(
            observations.media.as_ref().unwrap()[0]
                .content_type
                .as_deref(),
            Some("audio/flac")
        );

        locked.store(true, Ordering::SeqCst);
        fixture
            .emit_signal(None::<&str>, SCREEN_PATH, SCREEN, "ActiveChanged", &(true,))
            .await
            .unwrap();
        until(&mut rx, &mut observations, |state| {
            state.locked == Some(true)
        })
        .await;

        slow_once.store(true, Ordering::SeqCst);
        changed(
            &fixture,
            MPRIS_PATH,
            PLAYER,
            "Metadata",
            OwnedValue::from(0_u32),
        )
        .await;
        tokio::time::timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        locked.store(false, Ordering::SeqCst);
        fixture
            .emit_signal(
                None::<&str>,
                SCREEN_PATH,
                SCREEN,
                "ActiveChanged",
                &(false,),
            )
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_millis(500),
            until(&mut rx, &mut observations, |state| {
                state.locked == Some(false)
            }),
        )
        .await
        .expect("slow media query blocked lock observation");
        until(&mut rx, &mut observations, |state| {
            state.media.as_ref().is_some_and(|players| {
                players.len() == 1 && players[0].playback_status.as_deref() == Some("Playing")
            })
        })
        .await;

        status.store(1, Ordering::SeqCst);
        failures.store(1, Ordering::SeqCst);
        changed(
            &fixture,
            MPRIS_PATH,
            PLAYER,
            "PlaybackStatus",
            value("Paused"),
        )
        .await;
        until(&mut rx, &mut observations, |state| state.media.is_none()).await;
        // The failing GetAll must recover from its retry timer even though the
        // healthy fixture emits no further signal after the one above.
        until(&mut rx, &mut observations, |state| {
            state.media.as_ref().is_some_and(|players| {
                players.len() == 1 && players[0].playback_status.as_deref() == Some("Paused")
            })
        })
        .await;

        fixture.release_name(NAME).await.unwrap();
        until(&mut rx, &mut observations, |state| {
            state.media.as_ref().is_some_and(Vec::is_empty)
        })
        .await;
        fixture.request_name(NAME).await.unwrap();
        until(&mut rx, &mut observations, |state| {
            state
                .media
                .as_ref()
                .is_some_and(|players| players.len() == 1 && players[0].player == NAME)
        })
        .await;

        fixture.release_name(SCREEN).await.unwrap();
        until(&mut rx, &mut observations, |state| state.locked.is_none()).await;
        fixture.request_name(SCREEN).await.unwrap();
        until(&mut rx, &mut observations, |state| {
            state.locked == Some(false)
        })
        .await;

        online.store(2, Ordering::SeqCst);
        changed(
            &fixture,
            NETWORK_PATH,
            NETWORK,
            "Connectivity",
            OwnedValue::from(2_u32),
        )
        .await;
        until(&mut rx, &mut observations, |state| {
            state.network_online == Some(false)
        })
        .await;
        fixture.release_name(NETWORK).await.unwrap();
        until(&mut rx, &mut observations, |state| {
            state.network_online.is_none()
        })
        .await;
        online.store(4, Ordering::SeqCst);
        fixture.request_name(NETWORK).await.unwrap();
        until(&mut rx, &mut observations, |state| {
            state.network_online == Some(true)
        })
        .await;

        session_task.abort();
        network_task.abort();
        let _ = session_task.await;
        let _ = network_task.await;
    }
}
