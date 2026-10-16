//! A latest-state publisher. A failed connection is discarded, including queued
//! QoS packets, so reconnect cannot replay an obsolete desktop observation.
use crate::{
    config::Config,
    control,
    state::{Availability, ChangeNotification, Observations, Snapshot, classify},
};
use anyhow::{Result, ensure};
use rumqttc::{AsyncClient, Event, EventLoop, LastWill, MqttOptions, Packet, QoS, Transport};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

struct Broker {
    client: AsyncClient,
    events: EventLoop,
    queued: u64,
    acknowledged: u64,
    command_topic: String,
    commands: Option<tokio::sync::mpsc::Sender<control::Delivery>>,
    control_clock: Option<(u64, std::time::Instant)>,
}
impl Broker {
    fn new(config: &Config, session: &str) -> Result<Self> {
        let mut options = MqttOptions::new(
            format!("lugn-{}", config.device_id),
            &config.mqtt_host,
            config.mqtt_port,
        );
        options
            .set_clean_session(true)
            .set_keep_alive(Duration::from_secs(20))
            .set_inflight(1)
            .set_max_packet_size(262144, 262144);
        if let Some(user) = &config.mqtt_username {
            options.set_credentials(user, config.mqtt_password.as_deref().unwrap_or(""));
        }
        if config.mqtt_tls {
            options.set_transport(if let Some(path) = &config.mqtt_ca_file {
                Transport::tls(std::fs::read(path)?, None, None)
            } else {
                Transport::tls_with_default_config()
            });
        }
        options.set_last_will(LastWill::new(
            config.topic("availability"),
            availability(config, session, "offline")?,
            QoS::AtLeastOnce,
            true,
        ));
        let (client, mut events) = AsyncClient::new(options, 8);
        events.network_options.set_connection_timeout(5);
        Ok(Self {
            client,
            events,
            queued: 0,
            acknowledged: 0,
            command_topic: config.topic("control/command"),
            commands: None,
            control_clock: None,
        })
    }
    fn check_control_clock(&self) -> Result<()> {
        if let Some((wall, started)) = self.control_clock {
            let expected = wall.saturating_add(started.elapsed().as_millis() as u64);
            ensure!(
                control::now_ms().abs_diff(expected) <= 2_000,
                "media control clock discontinuity"
            );
        }
        Ok(())
    }
    async fn poll(&mut self) -> Result<Event> {
        self.check_control_clock()?;
        let event = self.events.poll().await?;
        // Reconnect to rotate the control epoch after a wall-clock step. In
        // particular, cached command IDs cannot become executable in old time.
        self.check_control_clock()?;
        if matches!(event, Event::Incoming(Packet::PubAck(_))) {
            self.acknowledged += 1;
        }
        if let Event::Incoming(Packet::Publish(message)) = &event {
            if message.topic == self.command_topic && message.qos == QoS::AtLeastOnce {
                if let (Some(commands), Some(command)) =
                    (&self.commands, control::parse(&message.payload))
                {
                    // Bounded ingress; overload may drop delivery, never execute
                    // unbounded work. Controller retries use the SAME command ID.
                    let _ = commands.try_send(control::Delivery::new(command, message.retain));
                }
            }
        }
        Ok(event)
    }
    async fn subscribe_control(&mut self, topic: String) -> Result<bool> {
        self.client.subscribe(topic, QoS::AtLeastOnce).await?;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Event::Incoming(Packet::SubAck(ack)) = self.poll().await? {
                    return Ok(ack.return_codes
                        == vec![rumqttc::SubscribeReasonCode::Success(QoS::AtLeastOnce)]);
                }
            }
        })
        .await?
    }
    async fn publish(&mut self, topic: String, payload: Vec<u8>, retain: bool) -> Result<()> {
        ensure!(
            payload.len() <= 256 * 1024 - 1024,
            "telemetry exceeds MQTT payload budget"
        );
        // Accounting survives cancellation during shutdown: the offline PUBACK
        // must be received, not merely an ACK for the preceding state packet.
        self.client
            .publish(topic, QoS::AtLeastOnce, retain, payload)
            .await?;
        self.queued += 1;
        let target = self.queued;
        tokio::time::timeout(Duration::from_secs(10), async {
            while self.acknowledged < target {
                self.poll().await?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await??;
        Ok(())
    }
}
fn availability(c: &Config, session: &str, status: &str) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&Availability {
        schema_version: 1,
        device_id: c.device_id.clone(),
        session_id: session.into(),
        status: status.into(),
    })?)
}
fn snapshot(
    c: &Config,
    session: &str,
    sequence: &mut u64,
    reason: &str,
    observations: Observations,
) -> Result<Snapshot> {
    *sequence += 1;
    ensure!(*sequence <= 9_007_199_254_740_991, "sequence exhausted");
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .try_into()?;
    Ok(Snapshot {
        schema_version: 1,
        device_id: c.device_id.clone(),
        session_id: session.into(),
        sequence: *sequence,
        timestamp_ms,
        reason: reason.into(),
        heartbeat_interval_ms: c.heartbeat_secs * 1000,
        inference: classify(
            &observations,
            &c.gaming_app_ids,
            &c.video_app_ids,
            &c.music_app_ids,
        ),
        observations,
    })
}
async fn changed_control(states: &mut Option<watch::Receiver<Vec<control::Player>>>) -> Result<()> {
    match states {
        Some(states) => {
            states.changed().await?;
            Ok(())
        }
        None => std::future::pending().await,
    }
}
async fn next_control_ack(runtime: &mut Option<control::Runtime>) -> Option<control::Ack> {
    match runtime {
        Some(runtime) => runtime.acks.recv().await,
        None => std::future::pending().await,
    }
}
async fn publish_control(
    b: &mut Broker,
    c: &Config,
    context: &control::Context,
    states: &mut watch::Receiver<Vec<control::Player>>,
    sequence: &mut u64,
) -> Result<()> {
    *sequence += 1;
    ensure!(
        *sequence <= 9_007_199_254_740_991,
        "control sequence exhausted"
    );
    let state = control::State {
        schema_version: 1,
        device_id: context.device_id.clone(),
        session_id: context.session_id.clone(),
        connection_id: context.connection_id.clone(),
        sequence: *sequence,
        timestamp_ms: control::now_ms(),
        heartbeat_interval_ms: c.heartbeat_secs * 1000,
        players: states.borrow_and_update().clone(),
    };
    let payload = serde_json::to_vec(&state)?;
    ensure!(payload.len() <= 64 * 1024, "control state exceeds budget");
    b.publish(c.topic("control/state"), payload, true).await
}
async fn connected(
    b: &mut Broker,
    c: &Config,
    session: &str,
    states: &mut watch::Receiver<Observations>,
    sequence: &mut u64,
    connected_once: &mut bool,
) -> Result<()> {
    loop {
        if matches!(b.poll().await?, Event::Incoming(Packet::ConnAck(_))) {
            break;
        }
    }
    let initial_reason = if *connected_once {
        "reconnect"
    } else {
        "startup"
    };
    *connected_once = true;
    let context = control::Context {
        device_id: c.device_id.clone(),
        session_id: session.into(),
        connection_id: uuid::Uuid::new_v4().to_string(),
    };
    // Never advertise a usable control epoch until this broker accepted SUBACK.
    let mut runtime =
        if c.control_enabled && b.subscribe_control(c.topic("control/command")).await? {
            let runtime = control::spawn(context.clone());
            b.commands = Some(runtime.commands.clone());
            b.control_clock = Some((control::now_ms(), std::time::Instant::now()));
            Some(runtime)
        } else {
            None
        };
    if c.control_enabled && runtime.is_none() {
        eprintln!("Media control subscription denied; observations continue");
    }
    let mut control_states = runtime.as_ref().map(|r| r.states.clone());
    let mut control_sequence = 0;
    b.publish(
        c.topic("availability"),
        availability(c, session, "online")?,
        true,
    )
    .await?;
    let mut last = states.borrow_and_update().clone();
    let first = snapshot(c, session, sequence, initial_reason, last.clone())?;
    b.publish(c.topic("state"), serde_json::to_vec(&first)?, true)
        .await?;
    if let Some(states) = &mut control_states {
        publish_control(b, c, &context, states, &mut control_sequence).await?;
    }
    let interval = Duration::from_secs(c.heartbeat_secs);
    let mut deadline = tokio::time::Instant::now() + interval;
    let mut control_deadline = tokio::time::Instant::now() + interval;
    enum Work {
        Observation(&'static str),
        Control,
        Ack(Box<control::Ack>),
    }
    loop {
        let work = tokio::select! {
            result = states.changed() => { result?; Work::Observation("change") },
            _ = tokio::time::sleep_until(deadline) => Work::Observation("heartbeat"),
            result = changed_control(&mut control_states) => { result?; Work::Control },
            _ = tokio::time::sleep_until(control_deadline), if runtime.is_some() => Work::Control,
            ack = next_control_ack(&mut runtime) => { match ack { Some(ack) => Work::Ack(Box::new(ack)), None => anyhow::bail!("control actor stopped") } },
            result = b.poll() => { result?; continue; }
        };
        match work {
            Work::Control => {
                if let Some(states) = &mut control_states {
                    publish_control(b, c, &context, states, &mut control_sequence).await?;
                }
                control_deadline = tokio::time::Instant::now() + interval;
            }
            Work::Ack(ack) => {
                if ack.session_id == session && ack.connection_id == context.connection_id {
                    b.publish(c.topic("control/ack"), serde_json::to_vec(&ack)?, false)
                        .await?;
                }
            }
            Work::Observation(reason) => {
                let current = states.borrow_and_update().clone();
                if reason == "change" && current == last {
                    continue;
                }
                let message = snapshot(c, session, sequence, reason, current.clone())?;
                b.publish(c.topic("state"), serde_json::to_vec(&message)?, true)
                    .await?;
                if reason == "change" {
                    let notification = ChangeNotification {
                        schema_version: 1,
                        device_id: c.device_id.clone(),
                        session_id: session.into(),
                        sequence: message.sequence,
                        timestamp_ms: message.timestamp_ms,
                        r#type: "state_changed".into(),
                    };
                    b.publish(c.topic("events"), serde_json::to_vec(&notification)?, false)
                        .await?;
                }
                last = current;
                deadline = tokio::time::Instant::now() + interval;
            }
        }
    }
    // Runtime Drop aborts the dedicated actor, dropping every lease and cache
    // before a reconnect. A D-Bus method already sent cannot be retracted.
}
pub async fn run(c: Config, mut states: watch::Receiver<Observations>) -> Result<()> {
    let session = uuid::Uuid::new_v4().to_string();
    let mut sequence = 0;
    let mut connected_once = false;
    let mut retry = Duration::from_secs(1);
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let shutdown = async {
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    };
    tokio::pin!(shutdown);
    loop {
        let mut broker = Broker::new(&c, &session)?;
        let start = tokio::time::Instant::now();
        tokio::select! {
            result = connected(&mut broker, &c, &session, &mut states, &mut sequence, &mut connected_once) => {
                // Avoid dumping options or credentials in errors.
                if result.is_err() { eprintln!("MQTT connection lost/unavailable; retrying"); }
            }
            _ = &mut shutdown => {
                let _ = tokio::time::timeout(Duration::from_secs(3), async {
                    broker.publish(c.topic("availability"), availability(&c, &session, "offline")?, true).await?;
                    broker.client.disconnect().await?;
                    loop { if matches!(broker.poll().await?, Event::Outgoing(rumqttc::Outgoing::Disconnect)) { break; } }
                    Ok::<_, anyhow::Error>(())
                }).await;
                return Ok(());
            }
        }
        // Drop socket, requests and in-flight packets before starting a clean
        // session. Only watch's latest observations survive this boundary.
        drop(broker);
        if start.elapsed() > Duration::from_secs(60) {
            retry = Duration::from_secs(1);
        }
        tokio::select! { _ = &mut shutdown => return Ok(()), _ = tokio::time::sleep(retry) => {} }
        retry = (retry * 2).min(Duration::from_secs(60));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_clock_steps_require_a_fresh_connection() {
        let c: Config = toml::from_str("device_id='desktop'\nmqtt_host='localhost'").unwrap();
        let mut broker = Broker::new(&c, "fixture").unwrap();
        broker.control_clock = Some((control::now_ms(), std::time::Instant::now()));
        assert!(broker.check_control_clock().is_ok());
        broker.control_clock = Some((
            control::now_ms().saturating_sub(3_000),
            std::time::Instant::now(),
        ));
        assert!(broker.check_control_clock().is_err());
        broker.control_clock = Some((
            control::now_ms().saturating_add(3_000),
            std::time::Instant::now(),
        ));
        assert!(broker.check_control_clock().is_err());
    }
    #[test]
    fn heartbeat_has_new_identity_but_same_observations() {
        let c: Config = toml::from_str("device_id='desktop'\nmqtt_host='localhost'").unwrap();
        let mut seq = 0;
        let a = snapshot(&c, "session", &mut seq, "startup", Observations::default()).unwrap();
        let b = snapshot(&c, "session", &mut seq, "heartbeat", a.observations.clone()).unwrap();
        assert_eq!(b.sequence, a.sequence + 1);
        assert_eq!(a.observations, b.observations);
        assert!(b.timestamp_ms >= a.timestamp_ms);
        let lwt: serde_json::Value =
            serde_json::from_slice(&availability(&c, "session", "offline").unwrap()).unwrap();
        assert!(lwt.get("timestamp_ms").is_none());
        assert_eq!(lwt["status"], "offline");
    }
}

#[cfg(test)]
mod control_wire_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn frame(stream: &mut tokio::net::TcpStream) -> (u8, Vec<u8>) {
        let head = stream.read_u8().await.unwrap();
        let (mut size, mut shift) = (0usize, 0);
        loop {
            let byte = stream.read_u8().await.unwrap();
            size |= usize::from(byte & 127) << shift;
            if byte & 128 == 0 {
                break;
            }
            shift += 7;
            assert!(shift < 28);
        }
        assert!(size <= 8192);
        let mut body = vec![0; size];
        stream.read_exact(&mut body).await.unwrap();
        (head, body)
    }
    fn packet(head: u8, body: Vec<u8>) -> Vec<u8> {
        let mut output = vec![head];
        let mut length = body.len();
        loop {
            let mut byte = (length % 128) as u8;
            length /= 128;
            if length > 0 {
                byte |= 128;
            }
            output.push(byte);
            if length == 0 {
                break;
            }
        }
        output.extend(body);
        output
    }
    fn command_packet(topic: &str, payload: &[u8], id: u16, retain: bool) -> Vec<u8> {
        let mut body = (topic.len() as u16).to_be_bytes().to_vec();
        body.extend(topic.as_bytes());
        body.extend(id.to_be_bytes());
        body.extend(payload);
        packet(if retain { 0x33 } else { 0x32 }, body)
    }
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires a loopback socket"]
    async fn mqtt_control_wire_routes_commands_during_puback_wait() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let config: Config = toml::from_str(&format!(
            "device_id='desktop'\nmqtt_host='127.0.0.1'\nmqtt_port={}",
            address.port()
        ))
        .unwrap();
        let topic = config.topic("control/command");
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let (head, _) = frame(&mut stream).await;
            assert_eq!(head >> 4, 1);
            stream.write_all(&[0x20, 2, 0, 0]).await.unwrap();
            let (head, body) = frame(&mut stream).await;
            assert_eq!(head >> 4, 3);
            let topic_length = usize::from(u16::from_be_bytes([body[0], body[1]]));
            let pkid = [body[2 + topic_length], body[3 + topic_length]];
            let payload = include_bytes!("../protocol/control-pause.example.json");
            stream
                .write_all(&command_packet("unrelated/command", payload, 77, false))
                .await
                .unwrap();
            let mut qos_zero = (topic.len() as u16).to_be_bytes().to_vec();
            qos_zero.extend(topic.as_bytes());
            qos_zero.extend(payload);
            stream.write_all(&packet(0x30, qos_zero)).await.unwrap();
            stream
                .write_all(&command_packet(&topic, payload, 78, true))
                .await
                .unwrap();
            stream
                .write_all(&[0x40, 2, pkid[0], pkid[1]])
                .await
                .unwrap();
            let _ = done_rx.await;
        });
        let mut broker = Broker::new(&config, "123e4567-e89b-42d3-a456-426614174000").unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if matches!(
                    broker.poll().await.unwrap(),
                    Event::Incoming(Packet::ConnAck(_))
                ) {
                    break;
                }
            }
            let (tx, mut rx) = tokio::sync::mpsc::channel(2);
            broker.commands = Some(tx);
            broker
                .publish(config.topic("state"), b"{}".to_vec(), true)
                .await
                .unwrap();
            let delivered = rx.recv().await.unwrap();
            assert!(delivered.retained, "retain flag must reach rejection guard");
            assert_eq!(delivered.command.action, control::Action::Pause);
            assert!(
                rx.try_recv().is_err(),
                "unrelated topics must not enqueue commands"
            );
        })
        .await
        .unwrap();
        let _ = done_tx.send(());
        server.await.unwrap();
    }
}
