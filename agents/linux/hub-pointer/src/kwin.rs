//! KWin over the session bus, all of it off the capture path:
//!
//! - a read-only observer script that reports the active window (for the
//!   game gate) and whether the cursor is near the entry corner (warm-up);
//! - unloading KWin effects (shake-to-find) while the pointer is on the Hub,
//!   and loading them back afterwards.
//!
//! Every call runs on a spawned task and failures only log. Without the
//! script the gate stays open and nothing warms up.

use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use tokio::sync::{mpsc, oneshot};
use zbus::{Connection, message::Header};

use crate::{capture::Zone, gate, log};

pub const SERVICE: &str = "org.lugn.HubPointer";
pub const PLUGIN: &str = "lugn-hub-pointer-observer";
const PATH: &str = "/org/lugn/HubPointer";
const SCRIPT: &str = include_str!("../kwin/observe.js");
const CALL_TIMEOUT: Duration = Duration::from_secs(2);
/// unloadScript deletes asynchronously; loadScript answers -1 until it is gone.
const LOAD_RETRIES: u32 = 8;
const LOAD_RETRY_DELAY: Duration = Duration::from_millis(250);
/// The approach area reaches this far past the entry corner to the right...
const APPROACH_EXTRA_X: i32 = 200;
/// ...and this far up from the monitor's bottom edge.
const APPROACH_HEIGHT: i32 = 220;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KwinEvent {
    /// The active window changed (or one of its watched properties did).
    Window(Option<gate::Window>),
    /// The cursor entered (`true`) or left the approach area.
    Approach(bool),
}

/// Cursor area, in desktop logical px, that counts as about to enter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Approach {
    pub max_x: i32,
    pub min_y: i32,
}

/// `reach` is the entry corner's width (Hub width plus slack).
pub fn approach_for(zone: Zone, reach: u32) -> Approach {
    Approach {
        max_x: zone.x.saturating_add_unsigned(reach) + APPROACH_EXTRA_X,
        min_y: zone.bottom() - APPROACH_HEIGHT,
    }
}

pub fn render_script(service: &str, approach: Approach) -> String {
    SCRIPT
        .replace("@SERVICE@", service)
        .replace("@APPROACH_MAX_X@", &approach.max_x.to_string())
        .replace("@APPROACH_MIN_Y@", &approach.min_y.to_string())
}

fn bounded(s: &str) -> String {
    s.chars()
        .scan(0, |size, c| {
            *size += c.len_utf8();
            (*size <= 256).then_some(c)
        })
        .collect()
}

struct Bridge {
    tx: mpsc::Sender<KwinEvent>,
}

/// Only KWin itself may report: the caller must be the owner of
/// `org.kde.KWin`.
async fn require_kwin(header: &Header<'_>, connection: &Connection) -> zbus::fdo::Result<()> {
    let reply = connection
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "GetNameOwner",
            &("org.kde.KWin",),
        )
        .await?;
    let owner: String = reply.body().deserialize()?;
    if header.sender().map(|s| s.as_str()) != Some(owner.as_str()) {
        return Err(zbus::fdo::Error::AccessDenied(
            "only KWin may report to the hub pointer".into(),
        ));
    }
    Ok(())
}

#[zbus::interface(name = "org.lugn.HubPointer")]
impl Bridge {
    #[zbus(name = "ObserveWindow")]
    async fn observe_window(
        &self,
        present: bool,
        desktop_file: &str,
        resource_class: &str,
        fullscreen: bool,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
    ) -> zbus::fdo::Result<()> {
        require_kwin(&header, connection).await?;
        let window = present.then(|| gate::Window {
            resource_class: bounded(resource_class),
            desktop_file: bounded(desktop_file),
            fullscreen,
        });
        self.forward(KwinEvent::Window(window)).await
    }

    #[zbus(name = "ObserveApproach")]
    async fn observe_approach(
        &self,
        inside: bool,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
    ) -> zbus::fdo::Result<()> {
        require_kwin(&header, connection).await?;
        self.forward(KwinEvent::Approach(inside)).await
    }
}

impl Bridge {
    async fn forward(&self, event: KwinEvent) -> zbus::fdo::Result<()> {
        self.tx
            .send(event)
            .await
            .map_err(|_| zbus::fdo::Error::Failed("agent stopping".into()))
    }
}

pub struct Bus {
    pub conn: Connection,
    /// Whether we own `service`, which the script needs to reach us.
    pub named: bool,
}

/// Connects to the session bus, serves the bridge and asks for `service`.
/// A taken name only disables the script; effects still work.
pub async fn connect(service: &str, tx: mpsc::Sender<KwinEvent>) -> Result<Bus> {
    let conn = zbus::connection::Builder::session()
        .method_timeout(CALL_TIMEOUT)
        .serve_at(PATH, Bridge { tx })
        .build()
        .await
        .context("session bus")?;
    let named = match conn.request_name(service).await {
        Ok(()) => true,
        Err(e) => {
            log!("kwin: cannot own {service} ({e}); game gate and warm-up off");
            false
        }
    };
    Ok(Bus { conn, named })
}

async fn call<B, R>(conn: &Connection, path: &str, iface: &str, method: &str, body: &B) -> Result<R>
where
    B: serde::Serialize + zbus::DynamicType,
    R: for<'d> zbus::wire::DynamicDeserialize<'d>,
{
    let reply = conn
        .call_method(Some("org.kde.KWin"), path, Some(iface), method, body)
        .await
        .with_context(|| format!("{iface}.{method}"))?;
    Ok(reply.body().deserialize()?)
}

/// Loads and unloads the observer script on its own task.
pub struct Script {
    tx: mpsc::UnboundedSender<ScriptCmd>,
}

enum ScriptCmd {
    Load(Approach),
    Unload(oneshot::Sender<()>),
}

struct ScriptTask {
    conn: Connection,
    service: String,
    plugin: String,
    file: PathBuf,
    events: mpsc::Sender<KwinEvent>,
}

impl Script {
    pub fn spawn(
        conn: Connection,
        service: &str,
        plugin: &str,
        runtime_dir: &Path,
        events: mpsc::Sender<KwinEvent>,
    ) -> Self {
        let task = ScriptTask {
            conn,
            service: service.into(),
            plugin: plugin.into(),
            file: runtime_dir.join(format!("{plugin}.js")),
            events,
        };
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(task.run(rx));
        Self { tx }
    }

    /// (Re)loads the script for this approach area. Never waits.
    pub fn load(&self, approach: Approach) {
        let _ = self.tx.send(ScriptCmd::Load(approach));
    }

    /// Unloads the script and removes its file, waiting up to `limit`.
    pub async fn unload(&self, limit: Duration) {
        let (done, wait) = oneshot::channel();
        if self.tx.send(ScriptCmd::Unload(done)).is_ok() {
            let _ = tokio::time::timeout(limit, wait).await;
        }
    }
}

impl ScriptTask {
    async fn run(self, mut rx: mpsc::UnboundedReceiver<ScriptCmd>) {
        while let Some(cmd) = rx.recv().await {
            match cmd {
                ScriptCmd::Load(approach) => match self.load(approach).await {
                    Ok(id) => log!(
                        "kwin: observer script {id} running (approach x <= {} y >= {})",
                        approach.max_x,
                        approach.min_y
                    ),
                    Err(e) => {
                        log!("kwin: observer script failed: {e:#}; game gate open, no warm-up");
                        // Fail open: forget whatever the old script said.
                        let _ = self.events.send(KwinEvent::Window(None)).await;
                        let _ = self.events.send(KwinEvent::Approach(false)).await;
                    }
                },
                ScriptCmd::Unload(done) => {
                    match self.unload().await {
                        Ok(true) => log!("kwin: observer script unloaded"),
                        Ok(false) => {}
                        Err(e) => log!("kwin: unloading observer script: {e:#}"),
                    }
                    let _ = fs::remove_file(&self.file);
                    let _ = done.send(());
                    return;
                }
            }
        }
    }

    fn write_file(&self, text: &str) -> Result<()> {
        let _ = fs::remove_file(&self.file);
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&self.file)
            .with_context(|| format!("writing {}", self.file.display()))?;
        f.write_all(text.as_bytes())?;
        Ok(())
    }

    async fn unload(&self) -> Result<bool> {
        call(
            &self.conn,
            "/Scripting",
            "org.kde.kwin.Scripting",
            "unloadScript",
            &(self.plugin.as_str(),),
        )
        .await
    }

    async fn load(&self, approach: Approach) -> Result<i32> {
        self.write_file(&render_script(&self.service, approach))?;
        let file = self.file.to_str().context("runtime path is not UTF-8")?;
        // Drops a copy left by an earlier run or the previous approach area.
        self.unload().await?;
        let mut tries = 0;
        let id = loop {
            let id: i32 = call(
                &self.conn,
                "/Scripting",
                "org.kde.kwin.Scripting",
                "loadScript",
                &(file, self.plugin.as_str()),
            )
            .await?;
            if id >= 0 {
                break id;
            }
            tries += 1;
            if tries >= LOAD_RETRIES {
                bail!("KWin refused the script (already loaded?)");
            }
            tokio::time::sleep(LOAD_RETRY_DELAY).await;
        };
        let path = format!("/Scripting/Script{id}");
        call::<_, ()>(&self.conn, &path, "org.kde.kwin.Script", "run", &()).await?;
        Ok(id)
    }
}

/// Unloads KWin effects while the pointer is on the Hub. Commands are queued
/// and run in order on one task, so the capture path never waits.
pub struct Effects {
    tx: mpsc::UnboundedSender<EffectCmd>,
}

enum EffectCmd {
    Suppress,
    Restore,
    Shutdown(oneshot::Sender<()>),
}

impl Effects {
    pub fn spawn(conn: Connection, names: Vec<String>) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(effects_task(conn, names, rx));
        Self { tx }
    }

    /// Capture started: unload the configured effects that are loaded.
    pub fn suppress(&self) {
        let _ = self.tx.send(EffectCmd::Suppress);
    }

    /// Capture ended: load back what `suppress` unloaded.
    pub fn restore(&self) {
        let _ = self.tx.send(EffectCmd::Restore);
    }

    /// Restores and stops, waiting up to `limit`.
    pub async fn shutdown(&self, limit: Duration) {
        let (done, wait) = oneshot::channel();
        if self.tx.send(EffectCmd::Shutdown(done)).is_ok() {
            let _ = tokio::time::timeout(limit, wait).await;
        }
    }
}

const EFFECTS_PATH: &str = "/Effects";
const EFFECTS_IFACE: &str = "org.kde.kwin.Effects";

async fn effects_task(
    conn: Connection,
    names: Vec<String>,
    mut rx: mpsc::UnboundedReceiver<EffectCmd>,
) {
    // Only what we unloaded ourselves is ever loaded back, so an effect the
    // user turned off (or one a crashed run left unloaded) stays as it is.
    let mut unloaded: Vec<String> = Vec::new();
    while let Some(cmd) = rx.recv().await {
        match cmd {
            EffectCmd::Suppress => {
                for name in &names {
                    if unloaded.contains(name) {
                        continue;
                    }
                    let loaded: Result<bool> = call(
                        &conn,
                        EFFECTS_PATH,
                        EFFECTS_IFACE,
                        "isEffectLoaded",
                        &(name.as_str(),),
                    )
                    .await;
                    match loaded {
                        Ok(true) => {}
                        Ok(false) => continue,
                        Err(e) => {
                            log!("kwin: effect {name}: {e:#}");
                            continue;
                        }
                    }
                    let r: Result<()> = call(
                        &conn,
                        EFFECTS_PATH,
                        EFFECTS_IFACE,
                        "unloadEffect",
                        &(name.as_str(),),
                    )
                    .await;
                    match r {
                        Ok(()) => {
                            log!("kwin: effect {name} unloaded");
                            unloaded.push(name.clone());
                        }
                        Err(e) => log!("kwin: unloading effect {name}: {e:#}"),
                    }
                }
            }
            EffectCmd::Restore => restore(&conn, &mut unloaded).await,
            EffectCmd::Shutdown(done) => {
                restore(&conn, &mut unloaded).await;
                let _ = done.send(());
                return;
            }
        }
    }
}

async fn restore(conn: &Connection, unloaded: &mut Vec<String>) {
    for name in unloaded.drain(..) {
        let r: Result<bool> = call(
            conn,
            EFFECTS_PATH,
            EFFECTS_IFACE,
            "loadEffect",
            &(name.as_str(),),
        )
        .await;
        match r {
            Ok(true) => log!("kwin: effect {name} loaded back"),
            Ok(false) => log!("kwin: effect {name} did not load back"),
            Err(e) => log!("kwin: loading effect {name} back: {e:#}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: Zone = Zone {
        x: 0,
        y: 0,
        width: 3657,
        height: 1029,
    };

    #[test]
    fn approach_area_covers_the_corner() {
        assert_eq!(
            approach_for(MONITOR, 720),
            Approach {
                max_x: 920,
                min_y: 809
            }
        );
        let offset = Zone {
            x: -100,
            y: 50,
            ..MONITOR
        };
        assert_eq!(
            approach_for(offset, 720),
            Approach {
                max_x: 820,
                min_y: 859
            }
        );
    }

    #[test]
    fn script_is_templated() {
        let text = render_script(
            "org.example.Test",
            Approach {
                max_x: 920,
                min_y: -5,
            },
        );
        assert!(!text.contains('@'), "placeholder left in script");
        assert!(text.contains("var SERVICE = 'org.example.Test';"));
        assert!(text.contains("var APPROACH_MAX_X = Number('920');"));
        assert!(text.contains("var APPROACH_MIN_Y = Number('-5');"));
        assert!(text.contains("'ObserveWindow'"));
        assert!(text.contains("'ObserveApproach'"));
    }

    #[test]
    fn bounds_reported_strings() {
        assert_eq!(bounded("zen"), "zen");
        assert_eq!(bounded(&"é".repeat(200)).len(), 256);
    }

    /// Loads the real script into the running KWin under a test name and
    /// prints what it reports for `LUGN_KWIN_LIVE_SECS` seconds, then unloads
    /// it. Does not touch the InputCapture portal or the real service name.
    /// Run with: LUGN_KWIN_LIVE=1 cargo test live_kwin_script -- --ignored --nocapture
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "talks to the running KWin; set LUGN_KWIN_LIVE=1"]
    async fn live_kwin_script() {
        assert_eq!(std::env::var("LUGN_KWIN_LIVE").as_deref(), Ok("1"));
        let secs: u64 = std::env::var("LUGN_KWIN_LIVE_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(20);
        let service = "org.lugn.HubPointerLiveTest";
        let plugin = "lugn-hub-pointer-live-test";
        let (tx, mut rx) = mpsc::channel(64);
        let bus = connect(service, tx.clone()).await.unwrap();
        assert!(bus.named);
        let runtime = std::env::var_os("XDG_RUNTIME_DIR").unwrap();
        let script = Script::spawn(bus.conn.clone(), service, plugin, Path::new(&runtime), tx);
        script.load(approach_for(MONITOR, 720));
        // Read-only: the effects path's call shape, without unloading anything.
        let shake: bool = call(
            &bus.conn,
            EFFECTS_PATH,
            EFFECTS_IFACE,
            "isEffectLoaded",
            &("shakecursor",),
        )
        .await
        .unwrap();
        println!("shakecursor loaded: {shake}");

        // A caller that is not KWin is refused.
        let other = Connection::session().await.unwrap();
        let spoof = other
            .call_method(
                Some(service),
                PATH,
                Some("org.lugn.HubPointer"),
                "ObserveApproach",
                &(true,),
            )
            .await;
        println!("non-KWin caller: {spoof:?}");
        assert!(spoof.is_err());

        let end = tokio::time::Instant::now() + Duration::from_secs(secs);
        while let Ok(Some(event)) = tokio::time::timeout_at(end, rx.recv()).await {
            println!("{event:?}");
        }
        script.unload(Duration::from_secs(3)).await;
        let loaded: bool = call(
            &bus.conn,
            "/Scripting",
            "org.kde.kwin.Scripting",
            "isScriptLoaded",
            &(plugin,),
        )
        .await
        .unwrap();
        assert!(!loaded, "test script still loaded");
        assert!(!Path::new(&runtime).join(format!("{plugin}.js")).exists());
    }
}
