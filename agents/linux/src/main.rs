mod artwork;
mod audio;
mod config;
mod control;
mod control_mpris;
mod dbus;
mod display;
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
    let (input_idle_tx, input_idle) = watch::channel(None);
    idle::spawn(
        tx.clone(),
        config.idle_secs,
        config
            .display_control_enabled
            .then_some((input_idle_tx, config.display_input_idle_secs)),
    );
    tokio::spawn(audio::run(tx.clone()));
    tokio::spawn(dbus::session(tx.clone(), config.collect_artwork));
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
    let result = mqtt::run_with(config, states, input_idle).await;
    kwin::cleanup().await;
    result
}
