//! Read-only PipeWire playback observation through its native subscription tool.
//!
//! `pw-dump --monitor` writes an initial snapshot followed by JSON change arrays.
//! No timer reads audio state; timers below only reconnect a failed subscription.

use std::{
    collections::{BTreeSet, HashMap},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value};
use tokio::{io::AsyncReadExt, process::Command, sync::mpsc::Sender, time::Instant};

use crate::state::{Audio, Event};

const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_NODES: usize = 4096;
const MAX_PROPERTY_BYTES: usize = 512;
const MAX_AUDIO_BYTES: usize = 96 * 1024;
const MAX_RETRY: Duration = Duration::from_secs(30);

pub async fn run(tx: Sender<Event>) {
    let mut published = None;
    if tx.send(Event::Audio(None)).await.is_err() {
        return;
    }
    let mut retry = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        let result = monitor(&tx, &mut published).await;
        if tx.is_closed() {
            return;
        }
        if let Err(error) = result {
            eprintln!("PipeWire subscription unavailable: {error:#}");
        }
        if published.take().is_some() && tx.send(Event::Audio(None)).await.is_err() {
            return;
        }
        if started.elapsed() >= MAX_RETRY {
            retry = Duration::from_secs(1);
        }
        tokio::select! {
            _ = tx.closed() => return,
            _ = tokio::time::sleep(retry) => {}
        }
        retry = (retry * 2).min(MAX_RETRY);
    }
}

async fn monitor(tx: &Sender<Event>, published: &mut Option<Audio>) -> Result<()> {
    let mut child = Command::new("pw-dump")
        .args(["--monitor", "--no-colors"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("start pw-dump")?;
    let mut stdout = child.stdout.take().context("pw-dump stdout")?;
    let mut decoder = Frames::default();
    let mut graph = Graph::default();
    let mut buffer = [0_u8; 8192];
    let result = async {
        loop {
            let count = tokio::select! {
                _ = tx.closed() => return Ok(()),
                count = stdout.read(&mut buffer) => count.context("read pw-dump")?,
            };
            if count == 0 {
                bail!("pw-dump closed its subscription");
            }
            for changes in decoder.push(&buffer[..count])? {
                graph.apply(changes)?;
                let audio = graph.audio();
                if published.as_ref() != Some(&audio) {
                    if tx.send(Event::Audio(Some(audio.clone()))).await.is_err() {
                        return Ok(());
                    }
                    *published = Some(audio);
                }
            }
        }
    }
    .await;
    // Reap on EOF, protocol errors, and receiver shutdown. Cancellation also
    // kills the process through kill_on_drop.
    let _ = child.kill().await;
    result
}

/// Frames consecutive top-level arrays without repeatedly parsing incomplete
/// JSON. Quotes/escapes can straddle arbitrary reads; memory has a hard bound.
#[derive(Default)]
struct Frames {
    bytes: Vec<u8>,
    depth: usize,
    in_string: bool,
    escaped: bool,
}

impl Frames {
    fn push(&mut self, input: &[u8]) -> Result<Vec<Value>> {
        let mut frames = Vec::new();
        for &byte in input {
            if self.bytes.is_empty() {
                if byte.is_ascii_whitespace() {
                    continue;
                }
                if byte != b'[' {
                    bail!("pw-dump frame is not a JSON array");
                }
                self.depth = 1;
                self.bytes.push(byte);
                continue;
            }
            if self.bytes.len() >= MAX_FRAME_BYTES {
                bail!("pw-dump frame exceeds {MAX_FRAME_BYTES} bytes");
            }
            self.bytes.push(byte);
            if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'"' {
                    self.in_string = false;
                }
            } else {
                match byte {
                    b'"' => self.in_string = true,
                    b'[' | b'{' => self.depth += 1,
                    b']' | b'}' => {
                        self.depth -= 1;
                        if self.depth == 0 {
                            let frame = std::mem::take(&mut self.bytes);
                            frames.push(
                                serde_json::from_slice(&frame)
                                    .context("decode pw-dump change array")?,
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(frames)
    }
}

#[derive(Default)]
struct Node {
    running: bool,
    media_class: Option<String>,
    application_name: Option<String>,
    application_binary: Option<String>,
    role: Option<String>,
}

impl Node {
    fn properties(&mut self, props: &Map<String, Value>, replace: bool) -> Result<()> {
        for (key, field) in [
            ("media.class", &mut self.media_class),
            ("application.name", &mut self.application_name),
            ("application.process.binary", &mut self.application_binary),
            ("media.role", &mut self.role),
        ] {
            if replace {
                *field = None;
            }
            if let Some(value) = props.get(key) {
                *field = match value {
                    Value::Null => None,
                    Value::String(text) if text.len() <= MAX_PROPERTY_BYTES => {
                        (!text.is_empty()).then(|| text.clone())
                    }
                    _ => bail!("invalid or oversized PipeWire property {key}"),
                };
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct Graph {
    nodes: HashMap<u64, Node>,
}

impl Graph {
    fn apply(&mut self, changes: Value) -> Result<()> {
        let changes = changes
            .as_array()
            .context("expected pw-dump change array")?;
        for change in changes {
            let id = change
                .get("id")
                .and_then(Value::as_u64)
                .context("pw-dump object has no numeric id")?;
            // Upstream pw-dump emits an info:null tombstone for removed nodes.
            if change.get("info").is_some_and(Value::is_null) {
                self.nodes.remove(&id);
                continue;
            }
            match change.get("type").and_then(Value::as_str) {
                Some("PipeWire:Interface:Node") => {}
                Some(_) => {
                    self.nodes.remove(&id);
                    continue;
                }
                None if self.nodes.contains_key(&id) => {}
                None => continue,
            }
            if !self.nodes.contains_key(&id) && self.nodes.len() >= MAX_NODES {
                bail!("PipeWire node count exceeds {MAX_NODES}");
            }
            let node = self.nodes.entry(id).or_default();
            let Some(info) = change.get("info").and_then(Value::as_object) else {
                continue;
            };
            if let Some(state) = info.get("state") {
                node.running = state.as_str() == Some("running");
            }
            if let Some(props) = info.get("props").and_then(Value::as_object) {
                // Native dumps contain a complete property dictionary when the
                // props mask is set. Omitted info/props fields remain unchanged;
                // unmasked property patches can also explicitly clear with null.
                let replace = info
                    .get("change-mask")
                    .and_then(Value::as_array)
                    .is_some_and(|mask| mask.iter().any(|field| field == "props"));
                node.properties(props, replace)?;
            }
        }
        Ok(())
    }

    fn audio(&self) -> Audio {
        let mut audio = Audio::default();
        let mut applications = BTreeSet::new();
        let mut roles = BTreeSet::new();
        for node in self.nodes.values().filter(|node| {
            node.running && node.media_class.as_deref() == Some("Stream/Output/Audio")
        }) {
            audio.playing = true;
            if let Some(name) = node
                .application_name
                .as_ref()
                .or(node.application_binary.as_ref())
            {
                applications.insert(name.clone());
            }
            if let Some(role) = &node.role {
                roles.insert(role.clone());
            }
        }
        // Control characters expand in JSON. Bound the encoded payload as well
        // as the number and UTF-8 length of labels, preserving playing itself.
        let mut budget = MAX_AUDIO_BYTES - serde_json::to_vec(&audio).unwrap().len();
        for (labels, output) in [
            (applications, &mut audio.applications),
            (roles, &mut audio.roles),
        ] {
            for label in labels.into_iter().take(128) {
                let bytes =
                    serde_json::to_vec(&label).unwrap().len() + usize::from(!output.is_empty());
                if bytes > budget {
                    break;
                }
                budget -= bytes;
                output.push(label);
            }
        }
        audio
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stream(id: u64, application: &str, role: &str) -> Value {
        json!({"id": id, "type": "PipeWire:Interface:Node", "info": {
            "state": "running", "change-mask": ["state", "props"],
            "props": {"media.class": "Stream/Output/Audio",
                "application.name": application, "media.role": role}
        }})
    }

    #[test]
    fn frames_handle_arbitrary_chunks_escaped_quotes_and_consecutive_arrays() {
        let input = br#" [{"id":1,"value":"[\\\"}]"}] [{"id":2}] [] "#;
        let expected: Vec<Value> = serde_json::Deserializer::from_slice(input)
            .into_iter::<Value>()
            .map(Result::unwrap)
            .collect();
        for chunk_size in 1..=input.len() {
            let mut decoder = Frames::default();
            let mut actual = Vec::new();
            for chunk in input.chunks(chunk_size) {
                actual.extend(decoder.push(chunk).unwrap());
            }
            assert_eq!(actual, expected, "chunk size {chunk_size}");
            assert!(decoder.bytes.is_empty());
        }
    }

    #[test]
    fn rejects_invalid_or_unbounded_frames() {
        assert!(Frames::default().push(b"{}").is_err());
        assert!(Frames::default().push(b"[{]}").is_err());
        let mut decoder = Frames::default();
        decoder.push(b"[\"").unwrap();
        let chunk = [b'a'; 8192];
        for _ in 0..(MAX_FRAME_BYTES / chunk.len() - 1) {
            decoder.push(&chunk).unwrap();
        }
        assert!(decoder.push(&chunk).is_err());
        assert!(decoder.bytes.len() <= MAX_FRAME_BYTES);
    }

    #[test]
    fn tracks_state_only_updates_removals_and_reused_ids() {
        let mut graph = Graph::default();
        graph.apply(json!([stream(1, "Firefox", "Music")])).unwrap();
        assert_eq!(
            graph.audio(),
            Audio {
                playing: true,
                applications: vec!["Firefox".into()],
                roles: vec!["Music".into()],
            }
        );
        graph
            .apply(json!([{"id":1,"info":{"state":"idle"}}]))
            .unwrap();
        assert_eq!(graph.audio(), Audio::default());
        graph
            .apply(json!([{"id":1,"info":{"state":"running"}}]))
            .unwrap();
        assert_eq!(graph.audio().applications, ["Firefox"]);
        graph.apply(json!([{"id":1,"info":null}])).unwrap();
        assert_eq!(graph.audio(), Audio::default());
        let mut reused = stream(1, "Recorder", "Communication");
        reused["info"]["props"]["media.class"] = json!("Stream/Input/Audio");
        graph.apply(json!([reused])).unwrap();
        assert_eq!(graph.audio(), Audio::default());
    }

    #[test]
    fn filters_sinks_and_capture_deduplicates_and_sorts_running_metadata() {
        let mut graph = Graph::default();
        let mut sink = stream(4, "Speakers", "Music");
        sink["info"]["props"]["media.class"] = json!("Audio/Sink");
        let mut capture = stream(5, "Microphone", "Communication");
        capture["info"]["props"]["media.class"] = json!("Stream/Input/Audio");
        graph
            .apply(json!([
                stream(1, "Zplayer", "Music"),
                stream(2, "Browser", "Movie"),
                stream(3, "Browser", "Music"),
                sink,
                capture,
            ]))
            .unwrap();
        assert_eq!(
            graph.audio(),
            Audio {
                playing: true,
                applications: vec!["Browser".into(), "Zplayer".into()],
                roles: vec!["Movie".into(), "Music".into()],
            }
        );
    }

    #[test]
    fn property_patches_and_full_replacements_clear_metadata_correctly() {
        let mut graph = Graph::default();
        graph.apply(json!([stream(1, "Player", "Music")])).unwrap();
        graph
            .apply(json!([{"id":1,"info":{"props":{"media.role":null}}}]))
            .unwrap();
        assert_eq!(graph.audio().applications, ["Player"]);
        assert!(graph.audio().roles.is_empty());
        graph
            .apply(json!([{"id":1,"info":{
                "change-mask":["props"], "props":{
                    "media.class":"Stream/Output/Audio", "application.process.binary":"mpv"
                }
            }}]))
            .unwrap();
        assert_eq!(graph.audio().applications, ["mpv"]);
        assert!(graph.audio().playing);
    }

    #[test]
    fn caps_retained_node_count_and_metadata_size() {
        let mut graph = Graph::default();
        for id in 0..MAX_NODES as u64 {
            graph
                .apply(json!([{"id":id,"type":"PipeWire:Interface:Node"}]))
                .unwrap();
        }
        assert!(
            graph
                .apply(json!([stream(MAX_NODES as u64, "Player", "Music")]))
                .is_err()
        );
        graph.apply(json!([{"id":0,"info":null}])).unwrap();
        assert!(
            graph
                .apply(json!([stream(
                    MAX_NODES as u64,
                    &"x".repeat(MAX_PROPERTY_BYTES + 1),
                    "Music"
                )]))
                .is_err()
        );
    }

    #[test]
    fn caps_serialized_audio_even_when_json_escapes_expand_labels() {
        let mut graph = Graph::default();
        for id in 0..128 {
            let label = format!("{id}{}", "\u{0001}".repeat(500));
            graph.apply(json!([stream(id, &label, &label)])).unwrap();
        }
        let audio = graph.audio();
        assert!(audio.playing);
        assert!(audio.applications.len() <= 128);
        assert!(audio.roles.len() <= 128);
        assert!(serde_json::to_vec(&audio).unwrap().len() <= MAX_AUDIO_BYTES);
    }
}
