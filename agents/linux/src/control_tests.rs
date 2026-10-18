use super::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const NOW: u64 = 1_770_000_000_000;
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PAUSE: &str = include_str!("../protocol/control-pause.example.json");
const RESUME: &str = include_str!("../protocol/control-resume.example.json");
const STATE: &str = include_str!("../protocol/control-state.example.json");
const PAUSED: &str = include_str!("../protocol/control-ack-paused.example.json");
const RESUMED: &str = include_str!("../protocol/control-ack-resumed.example.json");

fn pause() -> Command {
    parse(PAUSE.as_bytes()).expect("canonical pause fixture must parse")
}

fn resume() -> Command {
    parse(RESUME.as_bytes()).expect("canonical resume fixture must parse")
}

fn context() -> Context {
    let command = pause();
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

#[test]
fn control_fixtures_roundtrip_and_share_an_exact_pause_lease() {
    let command_schema: Value =
        serde_json::from_str(include_str!("../protocol/control-command.schema.json")).unwrap();
    let state_schema: Value =
        serde_json::from_str(include_str!("../protocol/control-state.schema.json")).unwrap();
    let ack_schema: Value =
        serde_json::from_str(include_str!("../protocol/control-ack.schema.json")).unwrap();
    for fixture in [PAUSE, RESUME] {
        let expected: Value = serde_json::from_str(fixture).unwrap();
        let command = parse(fixture.as_bytes()).unwrap();
        assert_eq!(serde_json::to_value(command).unwrap(), expected);
        exact_fields(&expected, &command_schema);
    }
    for fixture in [PAUSED, RESUMED] {
        let expected: Value = serde_json::from_str(fixture).unwrap();
        let ack: Ack = serde_json::from_str(fixture).unwrap();
        assert_eq!(serde_json::to_value(ack).unwrap(), expected);
        exact_fields(&expected, &ack_schema);
    }
    let state: State = serde_json::from_str(STATE).unwrap();
    let state_value: Value = serde_json::from_str(STATE).unwrap();
    assert_eq!(serde_json::to_value(&state).unwrap(), state_value);
    exact_fields(&state_value, &state_schema);
    let player_schema = &state_schema["properties"]["players"]["items"];
    exact_fields(&state_value["players"][0], player_schema);
    exact_fields(
        &state_value["players"][0]["pause_lease"],
        &player_schema["properties"]["pause_lease"]["anyOf"][0],
    );
    assert!(STATE.len() <= 64 * 1024);
    for fixture in [PAUSE, RESUME, PAUSED, RESUMED] {
        assert!(fixture.len() <= 8192);
    }
    assert!(state.players.len() <= 64);
    assert!(state.sequence > 0 && state.sequence <= SAFE_INTEGER);
    assert!((5000..=300_000).contains(&state.heartbeat_interval_ms));

    let paused: Ack = serde_json::from_str(PAUSED).unwrap();
    let resumed: Ack = serde_json::from_str(RESUMED).unwrap();
    let pause = pause();
    let resume = resume();
    assert_eq!(pause.validate(&context(), NOW), Ok(()));
    assert_eq!(resume.validate(&context(), NOW + 2000), Ok(()));
    assert_eq!(paused.command_id, pause.command_id);
    assert_eq!(resumed.command_id, resume.command_id);
    assert_eq!(paused.outcome, Outcome::Applied);
    assert_eq!(paused.reason, Reason::Paused);
    assert_eq!(resumed.reason, Reason::Resumed);
    assert!(resumed.resume_token.is_none() && resumed.lease_expires_at_ms.is_none());
    assert_eq!(
        resume.pause_command_id.as_deref(),
        Some(pause.command_id.as_str())
    );
    assert_eq!(resume.resume_token, paused.resume_token);
    let player = &state.players[0];
    let lease = player.pause_lease.as_ref().unwrap();
    assert_eq!(player.playback_status.as_deref(), Some("Paused"));
    assert_eq!(lease.pause_command_id, pause.command_id);
    assert_eq!(
        Some(lease.resume_token.as_str()),
        resume.resume_token.as_deref()
    );
    assert_eq!(Some(lease.expires_at_ms), paused.lease_expires_at_ms);
    assert_eq!(
        lease.expires_at_ms - paused.timestamp_ms,
        pause.lease_ttl_ms.unwrap()
    );
    for command in [&pause, &resume] {
        assert_eq!(command.device_id, state.device_id);
        assert_eq!(command.session_id, state.session_id);
        assert_eq!(command.connection_id, state.connection_id);
        assert_eq!(command.player, player.player);
        assert_eq!(command.player_instance_id, player.player_instance_id);
        assert_eq!(
            Some(command.content_id.as_str()),
            player.content_id.as_deref()
        );
        assert_eq!(command.expires_at_ms - command.issued_at_ms, 10_000);
    }
}

#[test]
fn control_reason_schema_matches_every_rust_wire_variant() {
    let reasons = [
        Reason::Paused,
        Reason::Resumed,
        Reason::Disabled,
        Reason::Retained,
        Reason::Expired,
        Reason::InvalidCommand,
        Reason::WrongSession,
        Reason::WrongConnection,
        Reason::UnknownPlayer,
        Reason::PlayerChanged,
        Reason::ContentChanged,
        Reason::NotPlaying,
        Reason::NotPaused,
        Reason::NotCapable,
        Reason::NotOwner,
        Reason::LeaseExpired,
        Reason::IdConflict,
        Reason::Busy,
        Reason::Unavailable,
        Reason::Timeout,
        Reason::Unconfirmed,
    ];
    let schema: Value =
        serde_json::from_str(include_str!("../protocol/control-ack.schema.json")).unwrap();
    let wire: Vec<Value> = reasons
        .iter()
        .map(|reason| serde_json::to_value(reason).unwrap())
        .collect();
    assert_eq!(schema["properties"]["reason"]["enum"], json!(wire));
    assert_eq!(
        schema["properties"]["outcome"]["enum"],
        json!([
            serde_json::to_value(Outcome::Applied).unwrap(),
            serde_json::to_value(Outcome::Rejected).unwrap(),
            serde_json::to_value(Outcome::Uncertain).unwrap(),
        ])
    );
}

#[test]
fn control_parse_requires_all_fields_and_enforces_payload_budget() {
    for fixture in [PAUSE, RESUME] {
        let original: Value = serde_json::from_str(fixture).unwrap();
        for key in original.as_object().unwrap().keys() {
            let mut missing = original.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(
                parse(&serde_json::to_vec(&missing).unwrap()).is_none(),
                "accepted missing {key}"
            );
        }
        let mut extra = original;
        extra["arbitrary_method"] = json!("PlayPause");
        assert!(parse(&serde_json::to_vec(&extra).unwrap()).is_none());
        let mut bytes = fixture.as_bytes().to_vec();
        bytes.resize(8192, b' ');
        assert!(parse(&bytes).is_some());
        bytes.push(b' ');
        assert!(parse(&bytes).is_none());
    }
    for payload in [b"null".as_slice(), b"[]", b"{}", b"not json"] {
        assert!(parse(payload).is_none());
    }
    for action in ["play", "PlayPause", "Pause", "toggle", "stop"] {
        let mut value: Value = serde_json::from_str(PAUSE).unwrap();
        value["action"] = json!(action);
        assert!(parse(&serde_json::to_vec(&value).unwrap()).is_none());
    }
}

#[test]
fn control_validation_fences_device_session_connection_and_canonical_uuids() {
    let mut command = pause();
    command.device_id = "another-device".into();
    assert_eq!(
        command.validate(&context(), NOW),
        Err(Reason::InvalidCommand)
    );
    command = pause();
    command.schema_version = 2;
    assert_eq!(
        command.validate(&context(), NOW),
        Err(Reason::InvalidCommand)
    );
    command = pause();
    command.session_id = "88888888-8888-4888-8888-888888888888".into();
    assert_eq!(command.validate(&context(), NOW), Err(Reason::WrongSession));
    command = pause();
    command.connection_id = "99999999-9999-4999-8999-999999999999".into();
    assert_eq!(
        command.validate(&context(), NOW),
        Err(Reason::WrongConnection)
    );
    for field in [
        "session_id",
        "connection_id",
        "command_id",
        "player_instance_id",
        "content_id",
    ] {
        let mut value = serde_json::to_value(pause()).unwrap();
        value[field] = json!("not-a-uuid");
        let command: Command = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            command.validate(&context(), NOW),
            Err(Reason::InvalidCommand)
        );
        assert!(parse(&serde_json::to_vec(&value).unwrap()).is_none());
    }
    assert!(uuid_valid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    for invalid in [
        "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
        "{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}",
    ] {
        assert!(!uuid_valid(invalid));
    }
    for invalid in [
        "org.other.Player",
        "org.mpris.MediaPlayer2.",
        "org.mpris.MediaPlayer2.1invalid",
        "org.mpris.MediaPlayer2.bad/name",
        ":1.42",
    ] {
        let mut command = pause();
        command.player = invalid.into();
        assert_eq!(
            command.validate(&context(), NOW),
            Err(Reason::InvalidCommand)
        );
    }
    let mut command = pause();
    let prefix = "org.mpris.MediaPlayer2.";
    command.player = format!("{prefix}{}", "a".repeat(255 - prefix.len()));
    assert_eq!(command.validate(&context(), NOW), Ok(()));
    command.player.push('a');
    assert_eq!(
        command.validate(&context(), NOW),
        Err(Reason::InvalidCommand)
    );
}

#[test]
fn control_validation_checks_expiry_delivery_window_skew_and_safe_integers() {
    let mut command = pause();
    assert_eq!(
        command.validate(&context(), command.expires_at_ms - 1),
        Ok(())
    );
    assert_eq!(
        command.validate(&context(), command.expires_at_ms),
        Err(Reason::Expired)
    );
    command.expires_at_ms = command.issued_at_ms;
    assert_eq!(
        command.validate(&context(), NOW),
        Err(Reason::InvalidCommand)
    );
    command.expires_at_ms = NOW + 15_000;
    assert_eq!(command.validate(&context(), NOW), Ok(()));
    command.expires_at_ms += 1;
    assert_eq!(
        command.validate(&context(), NOW),
        Err(Reason::InvalidCommand)
    );
    command.issued_at_ms = NOW + 2000;
    command.expires_at_ms = command.issued_at_ms + 10_000;
    assert_eq!(command.validate(&context(), NOW), Ok(()));
    command.issued_at_ms += 1;
    assert_eq!(
        command.validate(&context(), NOW),
        Err(Reason::InvalidCommand)
    );
    command.issued_at_ms = SAFE_INTEGER - 10_000;
    command.expires_at_ms = SAFE_INTEGER;
    assert_eq!(command.validate(&context(), command.issued_at_ms), Ok(()));
    command.expires_at_ms += 1;
    assert_eq!(
        command.validate(&context(), command.issued_at_ms),
        Err(Reason::InvalidCommand)
    );
    command.issued_at_ms = SAFE_INTEGER + 1;
    assert_eq!(
        command.validate(&context(), SAFE_INTEGER),
        Err(Reason::InvalidCommand)
    );
}

#[test]
fn control_validation_separates_pause_lease_request_from_resume_authority() {
    let mut command = pause();
    for ttl in [1000, 1_200_000, 3_600_000] {
        command.lease_ttl_ms = Some(ttl);
        assert_eq!(command.validate(&context(), NOW), Ok(()));
    }
    for ttl in [None, Some(999), Some(3_600_001)] {
        command.lease_ttl_ms = ttl;
        assert_eq!(
            command.validate(&context(), NOW),
            Err(Reason::InvalidCommand)
        );
    }
    command = pause();
    command.pause_command_id = Some(command.command_id.clone());
    assert_eq!(
        command.validate(&context(), NOW),
        Err(Reason::InvalidCommand)
    );
    command = pause();
    command.resume_token = resume().resume_token;
    assert_eq!(
        command.validate(&context(), NOW),
        Err(Reason::InvalidCommand)
    );

    for field in ["pause_command_id", "resume_token"] {
        for token in [Value::Null, json!("not-a-uuid")] {
            let mut value = serde_json::to_value(resume()).unwrap();
            value[field] = token;
            let command: Command = serde_json::from_value(value).unwrap();
            assert_eq!(
                command.validate(&context(), NOW + 2000),
                Err(Reason::InvalidCommand)
            );
        }
    }
    command = resume();
    command.lease_ttl_ms = Some(1000);
    assert_eq!(
        command.validate(&context(), NOW + 2000),
        Err(Reason::InvalidCommand)
    );
}

#[test]
fn control_delivery_keeps_only_the_remaining_bounded_monotonic_budget() {
    let received_at = Instant::now();
    let mut delivery = Delivery {
        command: pause(),
        retained: false,
        received_at,
        received_at_ms: NOW + 4000,
    };
    assert_eq!(
        delivery.deadline(),
        received_at + Duration::from_millis(6000)
    );
    delivery.received_at_ms = delivery.command.expires_at_ms;
    assert_eq!(delivery.deadline(), received_at);
    delivery.received_at_ms = delivery.command.expires_at_ms + 1;
    assert_eq!(delivery.deadline(), received_at);
    delivery.command.expires_at_ms = NOW + 100_000;
    delivery.received_at_ms = NOW;
    assert_eq!(delivery.deadline(), received_at + Duration::from_secs(15));
    // Retained-message policy belongs to backend delivery handling, not validate.
    delivery = Delivery {
        command: pause(),
        retained: true,
        received_at,
        received_at_ms: NOW,
    };
    assert_eq!(delivery.command.validate(&context(), NOW), Ok(()));
    assert!(delivery.retained);
}
