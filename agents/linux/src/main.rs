mod audio;
mod config;
mod dbus;
mod idle;
mod kwin;
mod mqtt;
mod state;
use anyhow::Result;
use tokio::sync::{mpsc, watch};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let path = match (args.next().as_deref(), args.next(), args.next()) {
        (Some("--config"), Some(path), None) => path,
        _ => anyhow::bail!("usage: lugn-linux-agent --config /path/to/config.toml"),
    };
    let config = config::Config::load(std::path::Path::new(&path))?;
    let (tx, mut rx) = mpsc::channel(64);
    let (latest, states) = watch::channel(state::Observations::default());
    idle::spawn(tx.clone(), config.idle_secs);
    tokio::spawn(audio::run(tx.clone()));
    tokio::spawn(dbus::session(tx.clone()));
    tokio::spawn(dbus::network(tx.clone()));
    tokio::spawn(kwin::run(tx));
    tokio::spawn(async move {
        let mut state = state::Observations::default();
        while let Some(event) = rx.recv().await {
            if state.apply(event) {
                latest.send_replace(state.clone());
            }
        }
    });
    let result = mqtt::run(config, states).await;
    kwin::cleanup().await;
    result
}
