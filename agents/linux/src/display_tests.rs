use super::*;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    sync::atomic::{AtomicUsize, Ordering},
};

const OFF: &str = include_str!("../protocol/display-command-off.example.json");
const ON: &str = include_str!("../protocol/display-command-on.example.json");
const ACK: &str = include_str!("../protocol/display-ack-off.example.json");
const STATE: &str = include_str!("../protocol/display-state.example.json");

fn command(fixture: &str) -> Command {
    parse(fixture.as_bytes()).expect("canonical display fixture must parse")
}
fn context() -> Context {
    let command = command(OFF);
    Context {
        device_id: command.device_id,
        session_id: command.session_id,
        connection_id: command.connection_id,
    }
}
fn exact_fields(value: &Value, schema: &Value) {
    let keys: BTreeSet<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let required: BTreeSet<_> = schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .map(|key| key.as_str().unwrap())
        .collect();
    let properties: BTreeSet<_> = schema["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, required);
    assert_eq!(keys, properties);
    assert_eq!(schema["additionalProperties"], false);
}
/// A command valid right now, derived from a fixture with the test context.
fn fresh(action: Action) -> Command {
    let mut c = command(OFF);
    c.action = action;
    c.command_id = uuid::Uuid::new_v4().to_string();
    c.issued_at_ms = now_ms();
    c.expires_at_ms = c.issued_at_ms + 10_000;
    c
}
fn delivery(command: Command) -> Delivery {
    Delivery::new(command, false)
}
fn executor(calls: Arc<AtomicUsize>, result: Result<(), Reason>) -> Executor {
    Arc::new(move |_| {
        calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { result })
    })
}
async fn roundtrip(runtime: &mut Runtime, delivery: Delivery) -> Ack {
    runtime.commands.send(delivery).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), runtime.acks.recv())
        .await
        .expect("acknowledgement")
        .expect("actor alive")
}

#[test]
fn fixtures_roundtrip_and_match_the_schemas() {
    let command_schema: Value =
        serde_json::from_str(include_str!("../protocol/display-command.schema.json")).unwrap();
    let ack_schema: Value =
        serde_json::from_str(include_str!("../protocol/display-ack.schema.json")).unwrap();
    let state_schema: Value =
        serde_json::from_str(include_str!("../protocol/display-state.schema.json")).unwrap();
    for fixture in [OFF, ON] {
        let expected: Value = serde_json::from_str(fixture).unwrap();
        assert_eq!(serde_json::to_value(command(fixture)).unwrap(), expected);
        exact_fields(&expected, &command_schema);
    }
    let expected: Value = serde_json::from_str(ACK).unwrap();
    let ack: Ack = serde_json::from_str(ACK).unwrap();
    assert_eq!(serde_json::to_value(ack).unwrap(), expected);
    exact_fields(&expected, &ack_schema);
    let expected: Value = serde_json::from_str(STATE).unwrap();
    let state: State = serde_json::from_str(STATE).unwrap();
    assert_eq!(serde_json::to_value(&state).unwrap(), expected);
    exact_fields(&expected, &state_schema);
    exact_fields(
        &expected["last_command"],
        &state_schema["properties"]["last_command"]["oneOf"][1],
    );
}

#[test]
fn parse_rejects_malformed_and_oversized_envelopes() {
    assert!(parse(b"{}").is_none());
    assert!(parse(&vec![b' '; 4097]).is_none());
    let mut value: Value = serde_json::from_str(OFF).unwrap();
    value["extra"] = Value::Null;
    assert!(parse(value.to_string().as_bytes()).is_none());
    let mut value: Value = serde_json::from_str(OFF).unwrap();
    value["action"] = "toggle".into();
    assert!(parse(value.to_string().as_bytes()).is_none());
    let mut value: Value = serde_json::from_str(OFF).unwrap();
    value["command_id"] = "not-a-uuid".into();
    assert!(parse(value.to_string().as_bytes()).is_none());
}

#[test]
fn backend_selection_is_fixed_and_never_runs_configured_text() {
    use BackendSetting::*;
    assert_eq!(Backend::resolve(Auto, true, true), Some(Backend::Kscreen));
    assert_eq!(Backend::resolve(Auto, false, true), Some(Backend::Xset));
    assert_eq!(Backend::resolve(Auto, false, false), None);
    assert_eq!(
        Backend::resolve(Kscreen, false, false),
        Some(Backend::Kscreen)
    );
    assert_eq!(Backend::resolve(Xset, true, false), Some(Backend::Xset));
    assert_eq!(
        Backend::Kscreen.argv(Action::Off),
        ("kscreen-doctor", &["--dpms", "off"][..])
    );
    assert_eq!(
        Backend::Kscreen.argv(Action::On),
        ("kscreen-doctor", &["--dpms", "on"][..])
    );
    assert_eq!(
        Backend::Xset.argv(Action::Off),
        ("xset", &["dpms", "force", "off"][..])
    );
    assert_eq!(
        Backend::Xset.argv(Action::On),
        ("xset", &["dpms", "force", "on"][..])
    );
}

#[test]
fn validation_applies_the_identity_and_expiry_fences() {
    let context = context();
    let now = now_ms();
    let ok = delivery(fresh(Action::Off));
    assert_eq!(ok.validate(&context, now), Ok(()));
    let mut c = fresh(Action::Off);
    c.session_id = "99999999-9999-4999-8999-999999999999".into();
    assert_eq!(
        delivery(c).validate(&context, now),
        Err(Reason::WrongSession)
    );
    let mut c = fresh(Action::Off);
    c.connection_id = "99999999-9999-4999-8999-999999999999".into();
    assert_eq!(
        delivery(c).validate(&context, now),
        Err(Reason::WrongConnection)
    );
    let mut c = fresh(Action::Off);
    c.device_id = "other".into();
    assert_eq!(
        delivery(c).validate(&context, now),
        Err(Reason::InvalidCommand)
    );
    assert_eq!(
        Delivery::new(fresh(Action::Off), true).validate(&context, now),
        Err(Reason::Retained)
    );
    let mut c = fresh(Action::Off);
    c.expires_at_ms = c.issued_at_ms + 15_001;
    assert_eq!(
        delivery(c).validate(&context, now),
        Err(Reason::InvalidCommand)
    );
    let mut c = fresh(Action::Off);
    c.issued_at_ms = now + 2_500;
    c.expires_at_ms = c.issued_at_ms + 5_000;
    assert_eq!(
        delivery(c).validate(&context, now),
        Err(Reason::InvalidCommand)
    );
    let mut c = fresh(Action::Off);
    c.issued_at_ms = now - 12_000;
    c.expires_at_ms = now - 1_000;
    assert_eq!(delivery(c).validate(&context, now), Err(Reason::Expired));
}

#[tokio::test(flavor = "current_thread")]
async fn applied_request_runs_once_acks_and_reports_last_command() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut runtime = spawn_with(
        context(),
        Some(Backend::Kscreen),
        Some(executor(calls.clone(), Ok(()))),
    );
    let off = fresh(Action::Off);
    let ack = roundtrip(&mut runtime, delivery(off.clone())).await;
    assert_eq!(
        (ack.outcome, ack.reason),
        (Outcome::Applied, Reason::DisplayOff)
    );
    assert_eq!(ack.command_id, off.command_id);
    let last = runtime.status.borrow().last_command.clone().unwrap();
    assert_eq!(last.command_id, off.command_id);
    assert_eq!(last.action, Action::Off);

    // Redelivery returns the cached answer and does not touch the screen again.
    let again = roundtrip(&mut runtime, delivery(off.clone())).await;
    assert_eq!(again, ack);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Reusing an ID for a different request is a conflict, never an execution.
    let mut conflicting = off.clone();
    conflicting.action = Action::On;
    let conflict = roundtrip(&mut runtime, delivery(conflicting)).await;
    assert_eq!(
        (conflict.outcome, conflict.reason),
        (Outcome::Rejected, Reason::IdConflict)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let on = roundtrip(&mut runtime, delivery(fresh(Action::On))).await;
    assert_eq!(
        (on.outcome, on.reason),
        (Outcome::Applied, Reason::DisplayOn)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn rejected_deliveries_never_reach_the_backend() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut runtime = spawn_with(
        context(),
        Some(Backend::Kscreen),
        Some(executor(calls.clone(), Ok(()))),
    );
    let mut wrong = fresh(Action::Off);
    wrong.connection_id = "99999999-9999-4999-8999-999999999999".into();
    let ack = roundtrip(&mut runtime, delivery(wrong)).await;
    assert_eq!(ack.reason, Reason::WrongConnection);
    let ack = roundtrip(&mut runtime, Delivery::new(fresh(Action::Off), true)).await;
    assert_eq!(
        (ack.outcome, ack.reason),
        (Outcome::Rejected, Reason::Retained)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(runtime.status.borrow().last_command.is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn backend_failures_are_reported_without_pretending_success() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut runtime = spawn_with(
        context(),
        Some(Backend::Xset),
        Some(executor(calls, Err(Reason::Failed))),
    );
    let ack = roundtrip(&mut runtime, delivery(fresh(Action::Off))).await;
    assert_eq!(
        (ack.outcome, ack.reason),
        (Outcome::Rejected, Reason::Failed)
    );
    let last = runtime.status.borrow().last_command.clone().unwrap();
    assert_eq!(last.outcome, Outcome::Rejected);

    let mut runtime = spawn_with(
        context(),
        Some(Backend::Xset),
        Some(executor(
            Arc::new(AtomicUsize::new(0)),
            Err(Reason::Timeout),
        )),
    );
    let ack = roundtrip(&mut runtime, delivery(fresh(Action::Off))).await;
    assert_eq!(
        (ack.outcome, ack.reason),
        (Outcome::Uncertain, Reason::Timeout)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn missing_backend_rejects_as_unavailable() {
    let mut runtime = spawn_with(context(), None, None);
    let ack = roundtrip(&mut runtime, delivery(fresh(Action::On))).await;
    assert_eq!(
        (ack.outcome, ack.reason),
        (Outcome::Rejected, Reason::Unavailable)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_hung_backend_is_uncertain_within_the_delivery_budget() {
    let hang: Executor = Arc::new(|_| Box::pin(std::future::pending()));
    let mut runtime = spawn_with(context(), Some(Backend::Kscreen), Some(hang));
    let mut c = fresh(Action::Off);
    c.expires_at_ms = c.issued_at_ms + 1_000;
    runtime.commands.send(delivery(c)).await.unwrap();
    let ack = runtime.acks.recv().await.unwrap();
    assert_eq!(
        (ack.outcome, ack.reason),
        (Outcome::Uncertain, Reason::Timeout)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn program_runner_maps_spawn_and_exit_failures() {
    // Harmless programs only: no screen is ever touched by the unit tests.
    assert_eq!(
        run_program("/nonexistent/lugn-display", &[]).await,
        Err(Reason::Unavailable)
    );
    assert_eq!(run_program("true", &[]).await, Ok(()));
    assert_eq!(run_program("false", &[]).await, Err(Reason::Failed));
}
