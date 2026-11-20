//! What is holding the machine awake, read from PowerDevil (read-only).
//!
//! `ListInhibitions` returns an (application, reason) pair for every idle
//! inhibition: a browser's "Playing video" or "Playing audio", a tool's "Agents
//! are working". It is how a controller can tell a film from music. The method
//! is deprecated upstream but still served; when it cannot be read the answer
//! is `None` (unknown), never an empty list. Only these short strings are
//! published (to the display state), never anything else about the processes.
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::watch;
use zbus::Connection;

const SERVICE: &str = "org.kde.Solid.PowerManagement";
const PATH: &str = "/org/kde/Solid/PowerManagement/PolicyAgent";
const IFACE: &str = "org.kde.Solid.PowerManagement.PolicyAgent";
/// Idle decisions are made over tens of minutes; this is plenty fast.
const POLL: Duration = Duration::from_secs(15);
pub const MAX_BLOCKERS: usize = 8;
const MAX_TEXT: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Blocker {
    pub app: String,
    pub reason: String,
}

pub fn spawn(tx: watch::Sender<Option<Vec<Blocker>>>) {
    tokio::spawn(run(tx));
}

async fn run(tx: watch::Sender<Option<Vec<Blocker>>>) {
    let mut connection: Option<Connection> = None;
    loop {
        let result = list(&mut connection).await;
        if result.is_err() {
            connection = None;
        }
        let value = result.ok();
        tx.send_if_modified(|current| {
            let changed = *current != value;
            *current = value;
            changed
        });
        if tx.is_closed() {
            return;
        }
        tokio::time::sleep(POLL).await;
    }
}

async fn list(connection: &mut Option<Connection>) -> zbus::Result<Vec<Blocker>> {
    if connection.is_none() {
        *connection = Some(Connection::session().await?);
    }
    let reply = connection
        .as_ref()
        .expect("connection set above")
        .call_method(Some(SERVICE), PATH, Some(IFACE), "ListInhibitions", &())
        .await?;
    Ok(parse(reply.body().deserialize::<Vec<Vec<String>>>()?))
}

/// Bounds and cleans the raw (application, reason) pairs.
pub fn parse(raw: Vec<Vec<String>>) -> Vec<Blocker> {
    let mut blockers: Vec<Blocker> = raw
        .into_iter()
        .filter_map(|pair| {
            let mut pair = pair.into_iter();
            Some(Blocker {
                app: clean(&pair.next()?),
                reason: clean(&pair.next()?),
            })
        })
        .collect();
    blockers.sort_by(|a, b| (&a.app, &a.reason).cmp(&(&b.app, &b.reason)));
    blockers.dedup();
    blockers.truncate(MAX_BLOCKERS);
    blockers
}

fn clean(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(MAX_TEXT)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(app: &str, reason: &str) -> Vec<String> {
        vec![app.into(), reason.into()]
    }

    #[test]
    fn pairs_are_sorted_and_deduplicated_and_malformed_ones_dropped() {
        let parsed = parse(vec![
            pair("zen", "Playing video"),
            pair("T3 Code", "Agents are working"),
            pair("zen", "Playing video"),
            vec!["malformed".into()],
            vec![],
        ]);
        assert_eq!(
            parsed,
            vec![
                Blocker {
                    app: "T3 Code".into(),
                    reason: "Agents are working".into()
                },
                Blocker {
                    app: "zen".into(),
                    reason: "Playing video".into()
                },
            ]
        );
    }

    #[test]
    fn the_list_is_bounded() {
        let parsed = parse((0..20).map(|i| pair(&format!("app{i:02}"), "x")).collect());
        assert_eq!(parsed.len(), MAX_BLOCKERS);
    }

    #[test]
    fn text_is_stripped_of_control_characters_and_truncated() {
        let long = "é".repeat(200);
        let parsed = parse(vec![pair("a\u{0}b\n", &long)]);
        assert_eq!(parsed[0].app, "ab");
        assert_eq!(parsed[0].reason.chars().count(), MAX_TEXT);
    }

    /// Read-only call to the real session's PowerDevil; prints what it sees.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires the live KDE session bus"]
    async fn live_policy_agent_list_is_readable() {
        let mut connection = None;
        let blockers = list(&mut connection).await.expect("PolicyAgent readable");
        eprintln!("blockers: {blockers:?}");
    }
}
