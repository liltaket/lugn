//! A latest-state publisher. A failed connection is discarded, including queued
//! QoS packets, so reconnect cannot replay an obsolete desktop observation.
use crate::{
    config::Config,
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
        })
    }
    async fn poll(&mut self) -> Result<Event> {
        let event = self.events.poll().await?;
        if matches!(event, Event::Incoming(Packet::PubAck(_))) {
            self.acknowledged += 1;
        }
        Ok(event)
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
    let mut deadline = tokio::time::Instant::now() + Duration::from_secs(c.heartbeat_secs);
    loop {
        let reason = tokio::select! {
            result = states.changed() => { result?; "change" },
            _ = tokio::time::sleep_until(deadline) => "heartbeat",
            result = b.poll() => { result?; continue; }
        };
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
        deadline = tokio::time::Instant::now() + Duration::from_secs(c.heartbeat_secs);
    }
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
