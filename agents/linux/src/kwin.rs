//! Loads only our bundled observation script into KWin. On agent restart an old
//! instance is unloaded, preventing duplicate callbacks. Nothing controls windows.
use crate::state::{Application, Event};
use anyhow::{Context, Result, ensure};
use futures_util::StreamExt;
use std::{io::Write, time::Duration};
use tokio::sync::mpsc::Sender;
use zbus::{Connection, MatchRule, MessageStream, Proxy, message::Type};
const NAME: &str = "org.lugn.LinuxAgent";
const PLUGIN: &str = "lugn-linux-agent-observer";
struct Bridge {
    tx: Sender<Event>,
}
#[zbus::interface(name = "org.lugn.LinuxAgent")]
impl Bridge {
    async fn observe_window(
        &self,
        present: bool,
        app_id: &str,
        resource_class: &str,
        fullscreen: bool,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(connection)] connection: &Connection,
    ) -> zbus::fdo::Result<()> {
        let bus = zbus::fdo::DBusProxy::new(connection).await?;
        let owner = bus
            .get_name_owner("org.kde.KWin".try_into().map_err(zbus::Error::from)?)
            .await?;
        if header.sender().map(|s| s.as_str()) != Some(owner.as_str()) {
            return Err(zbus::fdo::Error::AccessDenied(
                "only KWin observations accepted".into(),
            ));
        }
        fn bounded(s: &str) -> String {
            s.chars()
                .scan(0, |size, c| {
                    *size += c.len_utf8();
                    (*size <= 512).then_some(c)
                })
                .collect()
        }
        let app = present.then(|| Application {
            app_id: bounded(app_id),
            resource_class: bounded(resource_class),
            fullscreen,
        });
        self.tx
            .send(Event::Application(app))
            .await
            .map_err(|_| zbus::fdo::Error::Failed("agent stopping".into()))
    }
}
async fn load(connection: &Connection, file: &str) -> Result<()> {
    let scripting = Proxy::new(
        connection,
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting",
    )
    .await?;
    let _: bool = scripting.call("unloadScript", &(PLUGIN,)).await?;
    // unloadScript deletes asynchronously. If deferred deletion has not run yet,
    // loadScript returns -1 and the outer failure backoff retries.
    let id: i32 = scripting.call("loadScript", &(file, PLUGIN)).await?;
    ensure!(id >= 0, "KWin observer already loaded or refused");
    let path = format!("/Scripting/Script{id}");
    let script = Proxy::new(
        connection,
        "org.kde.KWin",
        path.as_str(),
        "org.kde.kwin.Script",
    )
    .await?;
    if script.call::<_, _, ()>("run", &()).await.is_err() {
        // Plasma 5 used /{id}; retry only this known interface difference.
        let path = format!("/{id}");
        Proxy::new(
            connection,
            "org.kde.KWin",
            path.as_str(),
            "org.kde.kwin.Script",
        )
        .await?
        .call::<_, _, ()>("run", &())
        .await?;
    }
    Ok(())
}
async fn monitor(tx: &Sender<Event>) -> Result<()> {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").context("XDG_RUNTIME_DIR missing")?;
    monitor_in(tx, std::path::Path::new(&runtime)).await
}

async fn monitor_in(tx: &Sender<Event>, runtime: &std::path::Path) -> Result<()> {
    let mut file = tempfile::Builder::new()
        .prefix("lugn-kwin-")
        .suffix(".js")
        .tempfile_in(runtime)?;
    file.write_all(include_bytes!("../kwin/observe.js"))?;
    let file_path = file.path().to_str().context("runtime path is not UTF-8")?;
    let connection = zbus::connection::Builder::session()?
        .method_timeout(Duration::from_secs(3))
        .name(NAME)?
        .serve_at("/org/lugn/LinuxAgent", Bridge { tx: tx.clone() })?
        .build()
        .await?;
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender("org.freedesktop.DBus")?
        .interface("org.freedesktop.DBus")?
        .member("NameOwnerChanged")?
        .add_arg("org.kde.KWin")?
        .build();
    let mut owners = MessageStream::for_match_rule(rule, &connection, Some(16)).await?;
    load(&connection, file_path).await?;
    while let Some(message) = owners.next().await {
        let message = message?;
        let (_, _, new): (String, String, String) = message.body().deserialize()?;
        tx.send(Event::Application(None)).await?;
        if !new.is_empty() {
            load(&connection, file_path).await?;
        }
    }
    anyhow::bail!("KWin bus disconnected")
}
pub async fn run(tx: Sender<Event>) {
    let mut retry = 1;
    loop {
        let start = tokio::time::Instant::now();
        if let Err(error) = monitor(&tx).await {
            eprintln!("KWin observer unavailable: {error}");
        }
        if tx.send(Event::Application(None)).await.is_err() {
            return;
        }
        if start.elapsed() > Duration::from_secs(60) {
            retry = 1;
        }
        tokio::time::sleep(Duration::from_secs(retry)).await;
        retry = (retry * 2).min(60);
    }
}

pub async fn cleanup() {
    let operation = async {
        let connection = zbus::connection::Builder::session()?
            .method_timeout(Duration::from_secs(2))
            .build()
            .await?;
        let scripting = Proxy::new(
            &connection,
            "org.kde.KWin",
            "/Scripting",
            "org.kde.kwin.Scripting",
        )
        .await?;
        scripting
            .call::<_, _, bool>("unloadScript", &(PLUGIN,))
            .await
    };
    let _ = tokio::time::timeout(Duration::from_secs(2), operation).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::Notify;

    #[derive(Default)]
    struct ScriptCalls {
        loaded: Mutex<Vec<String>>,
        unloaded: Mutex<Vec<String>>,
        runs: AtomicUsize,
        ready: Notify,
    }

    struct FakeScripting(Arc<ScriptCalls>);

    #[zbus::interface(name = "org.kde.kwin.Scripting")]
    impl FakeScripting {
        #[zbus(name = "loadScript")]
        fn load_script(&self, file: &str, plugin: &str) -> zbus::fdo::Result<i32> {
            if plugin != PLUGIN {
                return Err(zbus::fdo::Error::InvalidArgs("unexpected plugin".into()));
            }
            let source =
                std::fs::read(file).map_err(|error| zbus::fdo::Error::Failed(error.to_string()))?;
            if source != include_bytes!("../kwin/observe.js") {
                return Err(zbus::fdo::Error::Failed("unexpected script source".into()));
            }
            self.0.loaded.lock().unwrap().push(file.into());
            Ok(0)
        }

        #[zbus(name = "unloadScript")]
        fn unload_script(&self, plugin: &str) -> bool {
            self.0.unloaded.lock().unwrap().push(plugin.into());
            plugin == PLUGIN
        }
    }

    struct FakeScript(Arc<ScriptCalls>);

    #[zbus::interface(name = "org.kde.kwin.Script")]
    impl FakeScript {
        #[zbus(name = "run")]
        fn run(&self) {
            self.0.runs.fetch_add(1, Ordering::SeqCst);
            self.0.ready.notify_one();
        }
    }

    async fn next_application(rx: &mut tokio::sync::mpsc::Receiver<Event>) -> Option<Application> {
        let event = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("KWin observation timed out")
            .expect("KWin observation channel closed");
        match event {
            Event::Application(application) => application,
            _ => panic!("unexpected non-window observation"),
        }
    }

    /// This checks our D-Bus bridge and loader against a fake KWin on a private
    /// bus. It does not execute JavaScript or claim real KWin compatibility.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires isolated dbus-run-session and LUGN_TEST_DBUS=1"]
    async fn dbus_lifecycle_kwin() {
        assert_eq!(std::env::var("LUGN_TEST_DBUS").as_deref(), Ok("1"));
        assert_eq!(
            std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap(),
            std::env::var("DBUS_SYSTEM_BUS_ADDRESS").unwrap()
        );
        let calls = Arc::new(ScriptCalls::default());
        let kwin = zbus::connection::Builder::session()
            .unwrap()
            .name("org.kde.KWin")
            .unwrap()
            .serve_at("/Scripting", FakeScripting(calls.clone()))
            .unwrap()
            .serve_at("/Scripting/Script0", FakeScript(calls.clone()))
            .unwrap()
            .build()
            .await
            .unwrap();
        let runtime = tempfile::tempdir().unwrap();
        let runtime_path = runtime.path().to_owned();
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        let monitor_task = tokio::spawn(async move { monitor_in(&tx, &runtime_path).await });
        tokio::time::timeout(Duration::from_secs(3), calls.ready.notified())
            .await
            .expect("KWin script did not run");
        assert_eq!(calls.runs.load(Ordering::SeqCst), 1);
        let script_path = calls.loaded.lock().unwrap()[0].clone();
        assert!(std::path::Path::new(&script_path).starts_with(runtime.path()));
        assert_eq!(
            std::fs::read(&script_path).unwrap(),
            include_bytes!("../kwin/observe.js")
        );

        let bridge = Proxy::new(&kwin, NAME, "/org/lugn/LinuxAgent", NAME)
            .await
            .unwrap();
        bridge
            .call::<_, _, ()>(
                "ObserveWindow",
                &(true, "fixture.desktop", "fixture-class", true),
            )
            .await
            .unwrap();
        assert_eq!(
            next_application(&mut rx).await,
            Some(Application {
                app_id: "fixture.desktop".into(),
                resource_class: "fixture-class".into(),
                fullscreen: true,
            })
        );
        bridge
            .call::<_, _, ()>("ObserveWindow", &(false, "ignored", "ignored", true))
            .await
            .unwrap();
        assert_eq!(next_application(&mut rx).await, None);

        let unrelated = Connection::session().await.unwrap();
        let untrusted = Proxy::new(&unrelated, NAME, "/org/lugn/LinuxAgent", NAME)
            .await
            .unwrap();
        let error = untrusted
            .call::<_, _, ()>("ObserveWindow", &(true, "spoofed", "spoofed", false))
            .await
            .expect_err("unrelated D-Bus caller was accepted");
        assert!(matches!(error, zbus::Error::MethodError(ref name, _, _)
            if name.as_str() == "org.freedesktop.DBus.Error.AccessDenied"));
        assert!(
            rx.try_recv().is_err(),
            "rejected caller published an observation"
        );

        bridge
            .call::<_, _, ()>("ObserveWindow", &(true, "before-loss", "class", false))
            .await
            .unwrap();
        assert_eq!(
            next_application(&mut rx).await.unwrap().app_id,
            "before-loss"
        );
        kwin.release_name("org.kde.KWin").await.unwrap();
        assert_eq!(next_application(&mut rx).await, None);
        kwin.request_name("org.kde.KWin").await.unwrap();
        assert_eq!(next_application(&mut rx).await, None);
        tokio::time::timeout(Duration::from_secs(3), calls.ready.notified())
            .await
            .expect("KWin script did not reload after owner return");
        assert_eq!(calls.runs.load(Ordering::SeqCst), 2);
        assert_eq!(
            *calls.loaded.lock().unwrap(),
            vec![script_path.clone(), script_path.clone()]
        );
        bridge
            .call::<_, _, ()>("ObserveWindow", &(true, "after-return", "new-class", false))
            .await
            .unwrap();
        assert_eq!(
            next_application(&mut rx).await,
            Some(Application {
                app_id: "after-return".into(),
                resource_class: "new-class".into(),
                fullscreen: false,
            })
        );

        // Startup, owner return, and explicit shutdown each unload only our own
        // plugin. cleanup() must actually reach KWin despite swallowing errors.
        assert_eq!(calls.unloaded.lock().unwrap().len(), 2);
        cleanup().await;
        assert_eq!(
            *calls.unloaded.lock().unwrap(),
            vec![PLUGIN, PLUGIN, PLUGIN]
        );
        monitor_task.abort();
        let _ = monitor_task.await;
        assert!(
            !std::path::Path::new(&script_path).exists(),
            "runtime script leaked"
        );
    }
}
