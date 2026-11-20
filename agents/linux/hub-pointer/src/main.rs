//! lugn-hub-pointer: lets the desktop pointer slide off the monitor's left
//! edge onto a Nest Hub dashboard page and back.

use std::{
    fmt,
    os::unix::net::UnixStream,
    path::PathBuf,
    pin::pin,
    process::ExitCode,
    sync::{Arc, OnceLock},
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use futures_util::StreamExt;
use reis::{
    ei::{self, button::ButtonState, handshake::ContextType},
    event::{DeviceCapability, EiEvent},
};
use tokio::{
    net::TcpListener,
    signal::unix::{SignalKind, signal},
    sync::mpsc,
    time::{Instant, MissedTickBehavior, interval, sleep_until, timeout},
};

mod capture;
mod config;
mod portal;
mod protocol;
mod server;
mod stats;

use capture::{Pointer, ReleaseTo, leftmost_zone};
use config::Config;
use portal::{Portal, ZoneSet};
use protocol::{AgentMsg, PageMsg};
use server::{Auth, NewPage, PageConn, PageEvent};
use stats::{Pings, Rtt};

const PING_EVERY: Duration = Duration::from_secs(1);
const PONG_TIMEOUT: Duration = Duration::from_millis(2500);
const LATENCY_REPORT_EVERY: Duration = Duration::from_secs(10);
const REARM_AFTER_DISABLED: Duration = Duration::from_secs(1);
const REARM_AFTER_FAILURE: Duration = Duration::from_secs(5);
const EI_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

static START: OnceLock<std::time::Instant> = OnceLock::new();

#[doc(hidden)]
pub fn log_line(args: fmt::Arguments<'_>) {
    let t = START.get_or_init(std::time::Instant::now).elapsed();
    eprintln!("[{:>9.3}] {args}", t.as_secs_f64());
}

#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => { $crate::log_line(format_args!($($arg)*)) };
}

fn main() -> ExitCode {
    START.get_or_init(std::time::Instant::now);
    let path = match parse_args() {
        Ok(Some(path)) => path,
        Ok(None) => return ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e:#}");
            return ExitCode::from(2);
        }
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    match runtime.block_on(run(path)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) if e.is::<portal::Denied>() => {
            log!("exiting: {e}");
            ExitCode::from(portal::DENIED_EXIT_STATUS)
        }
        Err(e) => {
            log!("fatal: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn parse_args() -> Result<Option<PathBuf>> {
    let mut path = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--config") => {
                path = Some(PathBuf::from(args.next().context("--config needs a path")?))
            }
            Some("-h" | "--help") => {
                println!(
                    "usage: lugn-hub-pointer [--config <path>]\n\
                     default config: {}",
                    config::default_path().display()
                );
                return Ok(None);
            }
            _ => bail!("unknown argument {arg:?} (try --help)"),
        }
    }
    Ok(Some(path.unwrap_or_else(config::default_path)))
}

async fn run(config_path: PathBuf) -> Result<()> {
    let cfg = Config::load(&config_path)?;
    log!(
        "config {}: listen {} zone_height {} gain {} origins {:?}",
        config_path.display(),
        cfg.listen,
        cfg.zone_height,
        cfg.gain,
        cfg.allowed_origins
    );
    // Bind first so a port clash fails before anything touches the portal.
    let listener = TcpListener::bind(cfg.listen)
        .await
        .with_context(|| format!("binding {}", cfg.listen))?;

    let (portal, eis_fd) = Portal::open().await?;
    let ei = ei::Context::new(UnixStream::from(eis_fd)).context("EIS socket")?;
    let (_ei_connection, mut ei_events) = timeout(
        EI_HANDSHAKE_TIMEOUT,
        ei.handshake_tokio("lugn-hub-pointer", ContextType::Receiver),
    )
    .await
    .map_err(|_| anyhow!("EI handshake timed out"))?
    .context("EI handshake")?;
    log!("ei: handshake ok");

    let zones = portal.zones().await?;
    log!("portal: zones {zones:?}");

    // Subscribe before anything is enabled so no signal can be missed.
    let mut activated = pin!(portal.ic.receive_activated().await?);
    let mut deactivated = pin!(portal.ic.receive_deactivated().await?);
    let mut disabled = pin!(portal.ic.receive_disabled().await?);
    let mut zones_changed = pin!(portal.ic.receive_zones_changed().await?);
    let mut session_closed = pin!(portal.session.receive_closed().await?);

    let (page_tx, mut page_rx) = mpsc::channel::<NewPage>(4);
    let (event_tx, mut event_rx) = mpsc::channel::<PageEvent>(64);
    let auth = Arc::new(Auth {
        token: cfg.token.clone(),
        allowed_origins: cfg.allowed_origins.clone(),
    });
    tokio::spawn(server::accept_loop(listener, auth, page_tx));
    log!("ws: listening on ws://{}{}", cfg.listen, server::PATH);

    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sigint = signal(SignalKind::interrupt())?;
    let mut ping = interval(PING_EVERY);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut report = interval(LATENCY_REPORT_EVERY);

    let mut app = App::new(cfg, &portal, ei, zones, event_tx);
    let result = loop {
        let far = Instant::now() + Duration::from_secs(86400);
        let pong_deadline = app
            .page
            .as_ref()
            .map_or(far, |p| p.last_pong + PONG_TIMEOUT);
        let rearm_at = app.rearm_at.unwrap_or(far);
        let step = tokio::select! {
            _ = sigterm.recv() => break Ok(()),
            _ = sigint.recv() => break Ok(()),
            event = ei_events.next() => match event {
                Some(Ok(event)) => app.on_ei(event).await,
                Some(Err(e)) => Err(anyhow!("EI stream: {e}")),
                None => Err(anyhow!("EIS closed the connection")),
            },
            Some(page) = page_rx.recv() => app.on_new_page(page).await,
            Some(event) = event_rx.recv() => app.on_page_event(event).await,
            signal = activated.next() => match signal {
                Some(a) if a.session_handle().as_str() == portal.session_path => {
                    let cursor = a.cursor_position().map(|(x, y)| (f64::from(x), f64::from(y)));
                    log!(
                        "portal: Activated id {:?} cursor {cursor:?} barrier {:?}",
                        a.activation_id(),
                        a.barrier_id()
                    );
                    app.on_activated(a.activation_id(), cursor).await
                }
                Some(_) => Ok(()),
                None => Err(anyhow!("Activated signal stream ended")),
            },
            signal = deactivated.next() => match signal {
                Some(d) if d.session_handle().as_str() == portal.session_path => {
                    log!("portal: Deactivated id {:?}", d.activation_id());
                    app.on_deactivated(d.activation_id());
                    Ok(())
                }
                Some(_) => Ok(()),
                None => Err(anyhow!("Deactivated signal stream ended")),
            },
            signal = disabled.next() => match signal {
                Some(d) if d.session_handle().as_str() == portal.session_path => {
                    log!("portal: Disabled");
                    app.on_disabled();
                    Ok(())
                }
                Some(_) => Ok(()),
                None => Err(anyhow!("Disabled signal stream ended")),
            },
            signal = zones_changed.next() => match signal {
                Some(z) if z.session_handle().as_str() == portal.session_path => {
                    log!("portal: ZonesChanged (zone_set {:?})", z.zone_set());
                    app.on_zones_changed().await
                }
                Some(_) => Ok(()),
                None => Err(anyhow!("ZonesChanged signal stream ended")),
            },
            _ = session_closed.next() => Err(anyhow!("portal closed the session")),
            _ = ping.tick() => {
                app.on_ping_tick();
                Ok(())
            }
            _ = sleep_until(pong_deadline), if app.page.is_some() => {
                app.drop_page("no pong for 2.5 s").await
            }
            _ = sleep_until(rearm_at), if app.rearm_at.is_some() => app.on_rearm().await,
            _ = report.tick() => {
                app.report_latency();
                Ok(())
            }
        };
        if let Err(e) = step {
            break Err(e);
        }
        if let Err(e) = app.reap().await {
            break Err(e);
        }
    };
    app.shutdown().await;
    result
}

struct Page {
    conn: PageConn,
    viewport: Option<(f64, f64)>,
    last_pong: Instant,
    pings: Pings,
    /// Set when the page stopped taking frames; dropped after this event.
    dead: Option<&'static str>,
}

struct App<'p> {
    cfg: Config,
    portal: &'p Portal,
    ei: ei::Context,
    zones: ZoneSet,
    /// True from the moment barriers may be enabled until a Disable succeeded.
    armed: bool,
    rearm_at: Option<Instant>,
    pointer: Pointer,
    page: Option<Page>,
    next_page_id: u64,
    events: mpsc::Sender<PageEvent>,
    rtt: Rtt,
}

impl<'p> App<'p> {
    fn new(
        cfg: Config,
        portal: &'p Portal,
        ei: ei::Context,
        zones: ZoneSet,
        events: mpsc::Sender<PageEvent>,
    ) -> Self {
        Self {
            pointer: Pointer::new(cfg.gain),
            cfg,
            portal,
            ei,
            zones,
            armed: false,
            rearm_at: None,
            page: None,
            next_page_id: 0,
            events,
            rtt: Rtt::default(),
        }
    }

    fn page_ready(&self) -> bool {
        self.page.as_ref().is_some_and(|p| p.viewport.is_some())
    }

    fn send(&mut self, msg: &AgentMsg) {
        if let Some(page) = &mut self.page
            && page.dead.is_none()
            && !page.conn.send(msg.encode())
        {
            page.dead = Some("page stopped reading");
        }
    }

    async fn release(&self, to: ReleaseTo) -> Result<()> {
        self.portal.release(to.activation_id, to.cursor).await
    }

    /// Ends an ongoing capture from our side: `leave` first so the page
    /// reacts at once, then give the pointer back to the compositor.
    async fn end_capture(&mut self, why: &str) -> Result<()> {
        let Some(to) = self.pointer.end() else {
            return Ok(());
        };
        log!("capture: ending ({why})");
        self.send(&AgentMsg::Leave);
        self.release(to).await
    }

    async fn arm(&mut self) -> Result<()> {
        self.rearm_at = None;
        let Some(zone) = leftmost_zone(&self.zones.zones) else {
            log!("portal: no zones to place a barrier on");
            return Ok(());
        };
        self.pointer.set_zone(Some(zone));
        self.armed = true;
        if let Err(e) = self
            .portal
            .arm(self.zones.id, zone, self.cfg.zone_height)
            .await
        {
            log!("portal: arming failed: {e:#}; retrying in {REARM_AFTER_FAILURE:?}");
            self.disarm().await?;
            self.rearm_at = Some(Instant::now() + REARM_AFTER_FAILURE);
        }
        Ok(())
    }

    async fn disarm(&mut self) -> Result<()> {
        self.rearm_at = None;
        if self.armed {
            self.portal.disarm().await?;
            self.armed = false;
        }
        Ok(())
    }

    async fn drop_page(&mut self, why: &str) -> Result<()> {
        let Some((id, peer)) = self.page.as_ref().map(|p| (p.conn.id, p.conn.peer)) else {
            return Ok(());
        };
        log!("page {id} ({peer}): dropping ({why})");
        self.end_capture(why).await?;
        // Dropping the connection closes it after the queued `leave`.
        self.page = None;
        self.pointer.set_viewport(None);
        self.disarm().await
    }

    async fn reap(&mut self) -> Result<()> {
        match self.page.as_ref().and_then(|p| p.dead) {
            Some(why) => self.drop_page(why).await,
            None => Ok(()),
        }
    }

    async fn on_new_page(&mut self, new: NewPage) -> Result<()> {
        self.drop_page("replaced by a new connection").await?;
        self.next_page_id += 1;
        let id = self.next_page_id;
        log!("page {id}: connected from {}", new.peer);
        let mut page = Page {
            conn: PageConn::spawn(id, new, self.events.clone()),
            viewport: None,
            last_pong: Instant::now(),
            pings: Pings::default(),
            dead: None,
        };
        let ping_id = page.pings.start(Instant::now());
        self.page = Some(page);
        self.send(&AgentMsg::Ping { id: ping_id });
        Ok(())
    }

    async fn on_page_event(&mut self, event: PageEvent) -> Result<()> {
        let current = self.page.as_ref().map(|p| p.conn.id);
        match event {
            PageEvent::Closed(id, why) if Some(id) == current => self.drop_page(&why).await,
            PageEvent::Msg(id, msg) if Some(id) == current => self.on_page_msg(msg).await,
            _ => Ok(()),
        }
    }

    async fn on_page_msg(&mut self, msg: PageMsg) -> Result<()> {
        let Some(page) = self.page.as_mut() else {
            return Ok(());
        };
        match msg {
            PageMsg::Pong { id } => {
                let now = Instant::now();
                page.last_pong = now;
                if let Some(rtt) = page.pings.finish(id, now) {
                    self.rtt.record(rtt);
                }
            }
            PageMsg::Hello { w, h } => {
                if page.viewport != Some((w, h)) {
                    log!("page {}: hello {w}x{h}", page.conn.id);
                }
                page.viewport = Some((w, h));
                if let Some(msg) = self.pointer.set_viewport(Some((w, h))) {
                    self.send(&msg);
                }
                if !self.armed {
                    self.arm().await?;
                }
            }
        }
        Ok(())
    }

    async fn on_activated(
        &mut self,
        activation_id: Option<u32>,
        cursor: Option<(f64, f64)>,
    ) -> Result<()> {
        if !self.page_ready() {
            // Barriers are only armed with a page, but never keep a pointer
            // nobody can see.
            log!("capture: activated without a page; releasing");
            return self
                .release(ReleaseTo {
                    activation_id,
                    cursor: None,
                })
                .await;
        }
        match self.pointer.activate(activation_id, cursor) {
            Ok(enter) => {
                log!("capture: enter {enter:?}");
                self.send(&enter);
                Ok(())
            }
            Err(to) => self.release(to).await,
        }
    }

    fn on_deactivated(&mut self, activation_id: Option<u32>) {
        if self.pointer.deactivated(activation_id) {
            log!("capture: ended by compositor");
            self.send(&AgentMsg::Leave);
        }
    }

    fn on_disabled(&mut self) {
        self.on_deactivated(None);
        // Our own Disable may echo this signal; re-arming after a pause
        // (and only with a live page) keeps that from looping.
        if self.page_ready() {
            self.rearm_at = Some(Instant::now() + REARM_AFTER_DISABLED);
        }
    }

    async fn on_rearm(&mut self) -> Result<()> {
        self.rearm_at = None;
        if self.page_ready() {
            self.arm().await?;
        }
        Ok(())
    }

    async fn on_zones_changed(&mut self) -> Result<()> {
        self.end_capture("zones changed").await?;
        self.disarm().await?;
        self.zones = self.portal.zones().await?;
        log!("portal: zones {:?}", self.zones);
        self.pointer.set_zone(leftmost_zone(&self.zones.zones));
        if self.page_ready() {
            self.arm().await?;
        }
        Ok(())
    }

    async fn on_ei(&mut self, event: EiEvent) -> Result<()> {
        match event {
            EiEvent::PointerMotion(m) => self.pointer.motion(f64::from(m.dx), f64::from(m.dy)),
            EiEvent::Button(b) => self.pointer.button(b.button, b.state == ButtonState::Press),
            EiEvent::ScrollDelta(s) => self.pointer.scroll(f64::from(s.dx), f64::from(s.dy)),
            EiEvent::ScrollDiscrete(s) => {
                self.pointer.scroll_discrete(s.discrete_dx, s.discrete_dy)
            }
            EiEvent::Frame(_) => {
                let out = self.pointer.frame();
                for msg in &out.msgs {
                    self.send(msg);
                }
                if let Some(to) = out.release {
                    log!(
                        "capture: left the Hub on the right, release to {:?}",
                        to.cursor
                    );
                    self.release(to).await?;
                }
            }
            EiEvent::SeatAdded(s) => {
                log!(
                    "ei: seat {:?} added, binding pointer+button+scroll",
                    s.seat.name()
                );
                s.seat.bind_capabilities(
                    DeviceCapability::Pointer | DeviceCapability::Button | DeviceCapability::Scroll,
                );
                self.ei.flush().context("EI flush")?;
            }
            EiEvent::SeatRemoved(s) => log!("ei: seat {:?} removed", s.seat.name()),
            EiEvent::DeviceAdded(d) => log!(
                "ei: device {:?} added ({:?}; pointer {} button {} scroll {})",
                d.device.name(),
                d.device.device_type(),
                d.device.has_capability(DeviceCapability::Pointer),
                d.device.has_capability(DeviceCapability::Button),
                d.device.has_capability(DeviceCapability::Scroll),
            ),
            EiEvent::DeviceRemoved(d) => log!("ei: device {:?} removed", d.device.name()),
            EiEvent::DevicePaused(d) => log!("ei: device {:?} paused", d.device.name()),
            EiEvent::DeviceResumed(d) => log!("ei: device {:?} resumed", d.device.name()),
            EiEvent::DeviceStartEmulating(e) => {
                log!("ei: start emulating (sequence {})", e.sequence)
            }
            EiEvent::DeviceStopEmulating(_) => log!("ei: stop emulating"),
            EiEvent::Disconnected(d) => {
                bail!("EIS disconnected: {:?} {:?}", d.reason, d.explanation)
            }
            _ => {}
        }
        Ok(())
    }

    fn on_ping_tick(&mut self) {
        let Some(page) = self.page.as_mut() else {
            return;
        };
        let id = page.pings.start(Instant::now());
        self.send(&AgentMsg::Ping { id });
    }

    fn report_latency(&mut self) {
        if !self.cfg.log_latency {
            return;
        }
        if let Some(s) = self.rtt.take() {
            log!(
                "ws: rtt p50 {:.1} ms p95 {:.1} ms max {:.1} ms ({} pongs)",
                ms(s.p50),
                ms(s.p95),
                ms(s.max),
                s.n
            );
        }
    }

    async fn shutdown(&mut self) {
        log!("shutting down");
        if let Err(e) = self.drop_page("agent exiting").await {
            log!("{e:#}");
        }
        if let Err(e) = self.disarm().await {
            log!("{e:#}");
        }
        self.portal.close().await;
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}
