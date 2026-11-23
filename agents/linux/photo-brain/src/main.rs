//! lugn-photo-brain: Kuffe's photo brain (see docs/PHOTO-BRAIN.md).

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use anyhow::{Context, Result, bail};
use photo_brain::client::DownloadRules;
use photo_brain::config::{self, Config, Token};
use photo_brain::infer;
use photo_brain::service::{AnalyzerFactory, Brain, Published};

const USAGE: &str = "usage: lugn-photo-brain [--config <path>] <command>

commands:
  run                  list, download, analyse, cluster and publish until SIGTERM
  once                 one full pass (everything pending), then exit
  status               counts, free space, last publish
  export-bundle <file> write the bundle the store would publish (no network)

The bearer token comes from LUGN_PHOTO_BRAIN_TOKEN.";

fn main() -> ExitCode {
    match real_main() {
        Ok(code) => code,
        Err(e) => {
            eprintln!("lugn-photo-brain: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn real_main() -> Result<ExitCode> {
    let mut args = std::env::args().skip(1);
    let mut config_path = config::default_path();
    let mut command: Option<String> = None;
    let mut rest = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => {
                config_path = PathBuf::from(args.next().context("--config needs a path")?)
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(ExitCode::SUCCESS);
            }
            "--version" => {
                println!("lugn-photo-brain {}", env!("CARGO_PKG_VERSION"));
                return Ok(ExitCode::SUCCESS);
            }
            _ if command.is_none() => command = Some(arg),
            _ => rest.push(arg),
        }
    }
    let Some(command) = command else {
        eprintln!("{USAGE}");
        return Ok(ExitCode::from(2));
    };
    let config = Config::load(&config_path)?;
    let stop = Arc::new(AtomicBool::new(false));
    for signal in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(signal, stop.clone()).context("install signal handler")?;
    }
    let (models_dir, threads) = (config.models_dir.clone(), config.threads);
    let factory: AnalyzerFactory = Box::new(move || infer::open(&models_dir, threads));
    let no_models: AnalyzerFactory = Box::new(|| bail!("not opened for this command"));

    match command.as_str() {
        "run" | "once" => {
            let token = Token::from_env()?;
            let mut brain = Brain::new(config, token, DownloadRules::apple(), factory, stop)?;
            if command == "run" {
                eprintln!("lugn-photo-brain {} running", env!("CARGO_PKG_VERSION"));
                brain.run();
            } else {
                let report = brain.cycle(None)?;
                let published = match report.published {
                    Published::Nothing => "nothing to publish".to_string(),
                    Published::Unchanged => "bundle unchanged".to_string(),
                    Published::Sent { photos, .. } => format!("published {photos} pictures"),
                };
                println!(
                    "{} listed, {} downloaded, {} analysed, {published}",
                    report.listed, report.downloaded, report.analysed
                );
                if let Some(trouble) = report.trouble {
                    bail!("{trouble}");
                }
            }
        }
        "status" => {
            let (token, ask_lugn) = match Token::from_env() {
                Ok(token) => (token, true),
                Err(_) => {
                    eprintln!("{} is not set; Lugn's side is not shown", config::TOKEN_ENV);
                    (Token::new("unset".into())?, false)
                }
            };
            let mut brain = Brain::new(config, token, DownloadRules::apple(), no_models, stop)?;
            print!("{}", brain.status(ask_lugn)?);
        }
        "export-bundle" => {
            let [file] = rest.as_slice() else {
                bail!("export-bundle needs exactly one file argument");
            };
            let token = Token::new("unused".into())?;
            let mut brain = Brain::new(config, token, DownloadRules::apple(), no_models, stop)?;
            let photos = brain.export(&PathBuf::from(file))?;
            println!("wrote {photos} pictures to {file}");
        }
        other => {
            eprintln!("unknown command {other:?}\n\n{USAGE}");
            return Ok(ExitCode::from(2));
        }
    }
    Ok(ExitCode::SUCCESS)
}
