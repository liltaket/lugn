//! Downloads the model files into a models directory, checking SHA-256.
//!
//!   cargo run --release --example fetch -- <models-dir>             # default set
//!   cargo run --release --example fetch -- <models-dir> --in-use    # runtime + [use]
//!   cargo run --release --example fetch -- <models-dir> runtime sface-2021dec …
//!
//! The non-commercial `buffalo_l-w600k-r50` is only fetched when named.

use std::path::PathBuf;

use photo_brain::infer::models::{Which, ensure};

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        anyhow::bail!("usage: fetch <models-dir> [--in-use | <key>…]");
    };
    let rest: Vec<String> = args.collect();
    let which = match rest.as_slice() {
        [] => Which::Default,
        [flag] if flag == "--in-use" => Which::InUse,
        keys => Which::Only(keys.to_vec()),
    };
    for (key, outcome) in ensure(&PathBuf::from(dir), &which)? {
        println!("{key}: {outcome:?}");
    }
    Ok(())
}
