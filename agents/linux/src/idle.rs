//! Native, event-driven Wayland idle notifications.
//!
//! Unsupported compositors stay unknown. We keep their registry connection open
//! so that a seat or idle notifier advertised later can become usable.
//! The v1 protocol honors compositor idle inhibitors (for example video players).
//!
//! When display control is enabled a second, *input-only* notification is kept
//! per seat (`ext_idle_notifier_v1` version 2). It ignores idle inhibitors, so a
//! playing video or a busy agent does not look like someone typing, and it is
//! published only on the display channel, never in the observation v1 state.

use std::{collections::BTreeMap, thread, time::Duration};

use tokio::sync::{mpsc::Sender, watch};
use wayland_client::{
    Connection, Dispatch, Proxy, QueueHandle,
    protocol::{wl_registry, wl_seat},
};
use wayland_protocols::ext::idle_notify::v1::client::{
    ext_idle_notification_v1::{self, ExtIdleNotificationV1},
    ext_idle_notifier_v1::ExtIdleNotifierV1,
};

use crate::state::Event;

/// Start a dedicated blocking Wayland dispatch thread. No input events or
/// periodic idle queries are needed; only connection failures trigger retries.
pub fn spawn(
    tx: Sender<Event>,
    timeout_secs: u32,
    input: Option<(watch::Sender<Option<bool>>, u32)>,
) {
    let failure_tx = tx.clone();
    let (input_tx, input_secs) = match input {
        Some((tx, secs)) => (Some(tx), Some(secs)),
        None => (None, None),
    };
    if let Err(error) = thread::Builder::new()
        .name("wayland-idle".into())
        .spawn(move || {
            let mut output = Output {
                tx,
                last: None,
                input_tx,
            };
            let mut backoff = Duration::from_secs(1);
            output.send(None);
            while !output.tx.is_closed() {
                if let Err(error) = run_session(&mut output, timeout_secs, input_secs, &mut backoff)
                {
                    output.send(None);
                    output.send_input(None);
                    if output.tx.is_closed() {
                        break;
                    }
                    eprintln!("Wayland idle unavailable: {error}; retrying in {backoff:?}");
                    thread::sleep(backoff);
                    backoff = (backoff * 2).min(Duration::from_secs(60));
                } else {
                    break;
                }
            }
        })
    {
        eprintln!("Could not start Wayland idle collector: {error}");
        let _ = failure_tx.try_send(Event::Idle(None));
    }
}

struct Output {
    tx: Sender<Event>,
    // The outer Option distinguishes no publication from published unknown.
    last: Option<Option<bool>>,
    input_tx: Option<watch::Sender<Option<bool>>>,
}

impl Output {
    fn send(&mut self, idle: Option<bool>) {
        if self.last != Some(idle) && self.tx.blocking_send(Event::Idle(idle)).is_ok() {
            self.last = Some(idle);
        }
    }
}

impl Output {
    fn send_input(&self, idle: Option<bool>) {
        if let Some(tx) = &self.input_tx {
            tx.send_if_modified(|current| {
                let changed = *current != idle;
                *current = idle;
                changed
            });
        }
    }
}

fn run_session(
    output: &mut Output,
    timeout_secs: u32,
    input_secs: Option<u32>,
    backoff: &mut Duration,
) -> Result<(), String> {
    let connection = Connection::connect_to_env().map_err(|e| e.to_string())?;
    let mut queue = connection.new_event_queue::<IdleState>();
    let qh = queue.handle();
    let _registry = connection.display().get_registry(&qh, ());
    let mut state = IdleState {
        timeout_ms: timeout_secs.saturating_mul(1000),
        input_timeout_ms: input_secs.map(|secs| secs.saturating_mul(1000)),
        notifier: None,
        seats: BTreeMap::new(),
    };

    // First discover globals, then confirm the resulting notification requests
    // reached the compositor before publishing the protocol's initial state.
    queue.roundtrip(&mut state).map_err(|e| e.to_string())?;
    queue.roundtrip(&mut state).map_err(|e| e.to_string())?;
    *backoff = Duration::from_secs(1);
    output.send(state.idle());
    output.send_input(state.input_idle());

    while !output.tx.is_closed() {
        queue
            .blocking_dispatch(&mut state)
            .map_err(|e| e.to_string())?;
        output.send(state.idle());
        output.send_input(state.input_idle());
    }
    Ok(())
}

struct Seat {
    proxy: wl_seat::WlSeat,
    notification: Option<ExtIdleNotificationV1>,
    idle: Option<bool>,
    input_notification: Option<ExtIdleNotificationV1>,
    input_idle: Option<bool>,
}

struct IdleState {
    timeout_ms: u32,
    input_timeout_ms: Option<u32>,
    /// Bound notifier global name and version.
    notifier: Option<(u32, u32, ExtIdleNotifierV1)>,
    seats: BTreeMap<u32, Seat>,
}

impl IdleState {
    fn add_notifications(&mut self, qh: &QueueHandle<Self>) {
        let Some((_, version, notifier)) = &self.notifier else {
            return;
        };
        for (&name, seat) in &mut self.seats {
            if seat.input_notification.is_none()
                && *version >= 2
                && let Some(timeout) = self.input_timeout_ms
            {
                seat.input_notification = Some(notifier.get_input_idle_notification(
                    timeout,
                    &seat.proxy,
                    qh,
                    (name, true),
                ));
                seat.input_idle = Some(false);
            }
            if seat.notification.is_none() {
                seat.notification = Some(notifier.get_idle_notification(
                    self.timeout_ms,
                    &seat.proxy,
                    qh,
                    (name, false),
                ));
                // ext-idle-notify explicitly starts each notification not idle;
                // its timer starts on creation, rather than reporting past input.
                // This is protocol state, not an inferred last-input timestamp.
                seat.idle = Some(false);
            }
        }
    }

    fn idle(&self) -> Option<bool> {
        aggregate_idle(self.seats.values().map(|seat| seat.idle))
    }

    /// Unknown unless input idle was requested and the compositor supports it.
    fn input_idle(&self) -> Option<bool> {
        self.input_timeout_ms?;
        aggregate_idle(self.seats.values().map(|seat| seat.input_idle))
    }
}

/// One active seat makes the session active; idle requires every seat to be
/// known idle. An absent seat or incomplete observation remains unknown.
fn aggregate_idle(states: impl Iterator<Item = Option<bool>>) -> Option<bool> {
    let mut any = false;
    let mut unknown = false;
    for idle in states {
        any = true;
        match idle {
            Some(false) => return Some(false),
            Some(true) => {}
            None => unknown = true,
        }
    }
    if any && !unknown { Some(true) } else { None }
}

impl Dispatch<wl_registry::WlRegistry, ()> for IdleState {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } if version > 0 => {
                match interface.as_str() {
                    "ext_idle_notifier_v1" if state.notifier.is_none() => {
                        // v1 suffices for plain idle; v2 adds input-only idle.
                        let wanted = if state.input_timeout_ms.is_some() {
                            2
                        } else {
                            1
                        };
                        let bound = version.min(wanted);
                        state.notifier = Some((name, bound, registry.bind(name, bound, qh, ())));
                    }
                    "wl_seat" => {
                        let proxy = registry.bind(name, version.min(5), qh, ());
                        state.seats.insert(
                            name,
                            Seat {
                                proxy,
                                notification: None,
                                idle: None,
                                input_notification: None,
                                input_idle: None,
                            },
                        );
                    }
                    _ => {}
                }
                state.add_notifications(qh);
            }
            wl_registry::Event::GlobalRemove { name } => {
                if state
                    .notifier
                    .as_ref()
                    .is_some_and(|(id, _, _)| *id == name)
                {
                    for seat in state.seats.values_mut() {
                        if let Some(notification) = seat.notification.take() {
                            notification.destroy();
                        }
                        if let Some(notification) = seat.input_notification.take() {
                            notification.destroy();
                        }
                        seat.idle = None;
                        seat.input_idle = None;
                    }
                    if let Some((_, _, notifier)) = state.notifier.take() {
                        notifier.destroy();
                    }
                }
                if let Some(seat) = state.seats.remove(&name) {
                    if let Some(notification) = seat.notification {
                        notification.destroy();
                    }
                    if let Some(notification) = seat.input_notification {
                        notification.destroy();
                    }
                    if seat.proxy.version() >= 5 {
                        seat.proxy.release();
                    }
                }
            }
            _ => {}
        }
    }
}

/// User data: seat global name and whether this is the input-only notification.
impl Dispatch<ExtIdleNotificationV1, (u32, bool)> for IdleState {
    fn event(
        state: &mut Self,
        notification: &ExtIdleNotificationV1,
        event: ext_idle_notification_v1::Event,
        (name, input): &(u32, bool),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(seat) = state.seats.get_mut(name) else {
            return;
        };
        // Discard queued events from notifications destroyed after global loss.
        let current = if *input {
            seat.input_notification.as_ref()
        } else {
            seat.notification.as_ref()
        };
        if current.map(Proxy::id) != Some(notification.id()) {
            return;
        }
        let slot = if *input {
            &mut seat.input_idle
        } else {
            &mut seat.idle
        };
        match event {
            ext_idle_notification_v1::Event::Idled => *slot = Some(true),
            ext_idle_notification_v1::Event::Resumed => *slot = Some(false),
            _ => {}
        }
    }
}

wayland_client::delegate_noop!(IdleState: ignore wl_seat::WlSeat);
wayland_client::delegate_noop!(IdleState: ignore ExtIdleNotifierV1);

#[cfg(test)]
mod tests {
    use super::{Output, aggregate_idle};
    use crate::state::Event;

    #[test]
    fn missing_or_unobserved_seats_are_unknown() {
        assert_eq!(aggregate_idle([].into_iter()), None);
        assert_eq!(aggregate_idle([None].into_iter()), None);
        assert_eq!(aggregate_idle([Some(true), None].into_iter()), None);
    }

    #[test]
    fn idle_requires_every_seat_but_activity_on_any_seat_wins() {
        assert_eq!(
            aggregate_idle([Some(true), Some(true)].into_iter()),
            Some(true)
        );
        assert_eq!(
            aggregate_idle([Some(true), Some(false)].into_iter()),
            Some(false)
        );
        assert_eq!(aggregate_idle([None, Some(false)].into_iter()), Some(false));
        assert_eq!(aggregate_idle([Some(false), None].into_iter()), Some(false));
    }

    #[test]
    fn transitions_publish_once_and_connection_loss_clears_known_state() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let mut output = Output {
            tx,
            last: None,
            input_tx: None,
        };
        for value in [None, None, Some(false), Some(false), Some(true), None, None] {
            output.send(value);
        }
        assert!(matches!(rx.try_recv(), Ok(Event::Idle(None))));
        assert!(matches!(rx.try_recv(), Ok(Event::Idle(Some(false)))));
        assert!(matches!(rx.try_recv(), Ok(Event::Idle(Some(true)))));
        assert!(matches!(rx.try_recv(), Ok(Event::Idle(None))));
        assert!(rx.try_recv().is_err());
    }
}
