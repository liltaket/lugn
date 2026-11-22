//! lugn-hub-pointer: lets the desktop pointer slide off the monitor's bottom
//! edge, near the bottom-left corner, onto a Nest Hub dashboard page and back.

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
    time::{Instant, interval, sleep_until, timeout},
};

mod capture;
mod coalesce;
mod config;
mod gate;
mod keys;
mod kwin;
mod portal;
mod protocol;
mod recovery;
mod server;
mod stats;
mod stray;

use capture::{Abort, Ended, EntryRule, Exit, Pointer, ReleaseTo, in_entry_zone, leftmost_zone};
use coalesce::MoveCoalescer;
use config::Config;
use kwin::{Effects, KwinEvent, Script, approach_for};
use portal::{Portal, ZoneSet};
use protocol::{AgentMsg, PageMsg, Perf};
use recovery::ZoneRecovery;
use server::{Auth, NewPage, PageConn, PageEvent};
use stats::{Pings, Rtt};
use stray::Stray;

const PING_SLOW: Duration = Duration::from_secs(1);
/// While warm: keeps the Hub's Wi-Fi out of power save and its loop busy.
const PING_FAST: Duration = Duration::from_millis(20);
/// How long warm-up outlasts the cursor leaving the approach area.
const WARM_HYSTERESIS: Duration = Duration::from_millis(1500);
const PONG_TIMEOUT: Duration = Duration::from_millis(2500);
const LATENCY_REPORT_EVERY: Duration = Duration::from_secs(10);
/// Pause after a push against the bottom edge outside the entry corner.
const REARM_AFTER_OUTSIDE_CORNER: Duration = Duration::from_millis(300);
/// Pause after a push into the corner that did not enter (slid sideways,
/// moved back up, timed out, clicked), so a slide along the edge does not
/// re-trigger on every pixel.
const REARM_AFTER_ABORT: Duration = Duration::from_millis(400);
/// Pause after the pointer leaves the Hub, before the corner can take it again.
const REARM_AFTER_EXIT: Duration = Duration::from_millis(800);
const REARM_AFTER_DISABLED: Duration = Duration::from_secs(1);
const REARM_AFTER_FAILURE: Duration = Duration::from_secs(5);
/// After re-enabling to end a stray capture: long enough for the pointer, if
/// it is still against the edge, to be reported as a normal activation.
const STRAY_SETTLE: Duration = Duration::from_millis(400);
const EI_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const KWIN_SETUP_TIMEOUT: Duration = Duration::from_secs(5);
const KWIN_EXIT_TIMEOUT: Duration = Duration::from_secs(2);

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
        "config {}: listen {} hub_width_px {} entry_slack_px {} entry_push_px {} \
         entry_timeout {:?} gain {} origins {:?} suppress_effects {:?} exit_on_key {}",
        config_path.display(),
        cfg.listen,
        cfg.hub_width_px,
        cfg.entry_slack_px,
        cfg.entry_push_px,
        cfg.entry_timeout,
        cfg.gain,
        cfg.allowed_origins,
        cfg.suppress_effects,
        cfg.exit_on_key
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

    // Started with the monitor off or unplugged: wait for it like a later
    // hotplug instead of failing.
    let (zones, zones_error) = match portal.zones().await {
        Ok(zones) if !zones.zones.is_empty() => (zones, None),
        Ok(zones) => (zones, Some("the portal reports no zones".to_string())),
        Err(e) => (
            ZoneSet {
                id: 0,
                zones: Vec::new(),
            },
            Some(format!("{e:#}")),
        ),
    };
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

    // KWin: game gate, warm-up and effect suppression. All optional.
    let (kwin_tx, mut kwin_rx) = mpsc::channel::<KwinEvent>(64);
    let bus = match timeout(
        KWIN_SETUP_TIMEOUT,
        kwin::connect(kwin::SERVICE, kwin_tx.clone()),
    )
    .await
    {
        Ok(Ok(bus)) => Some(bus),
        Ok(Err(e)) => {
            log!("kwin: {e:#}; game gate open, no warm-up or effect suppression");
            None
        }
        Err(_) => {
            log!("kwin: session bus timed out; game gate open, no warm-up or effect suppression");
            None
        }
    };
    let effects = bus
        .as_ref()
        .filter(|_| !cfg.suppress_effects.is_empty())
        .map(|b| Effects::spawn(b.conn.clone(), cfg.suppress_effects.clone()));
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty());
    if bus.as_ref().is_some_and(|b| b.named) && runtime_dir.is_none() {
        log!("kwin: XDG_RUNTIME_DIR unset; game gate open, no warm-up");
    }
    let script = match (&bus, &runtime_dir) {
        (Some(b), Some(dir)) if b.named => Some(Script::spawn(
            b.conn.clone(),
            kwin::SERVICE,
            kwin::PLUGIN,
            std::path::Path::new(dir),
            kwin_tx,
        )),
        _ => None,
    };

    // Typing ends a capture. The watcher runs on its own threads; `key_tx`
    // lives until the loop ends, so a disabled watcher never closes the
    // channel.
    let (key_tx, mut key_rx) = mpsc::channel::<keys::KeyDown>(16);
    if cfg.exit_on_key {
        keys::spawn(key_tx.clone());
    } else {
        log!("keys: exit_on_key = false; typing does not end a capture");
    }

    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sigint = signal(SignalKind::interrupt())?;
    let mut report = interval(LATENCY_REPORT_EVERY);

    let mut app = App::new(cfg, &portal, ei, zones, event_tx, effects, script);
    app.load_script();
    if let Some(why) = zones_error {
        // The first miss only schedules a retry; it cannot give up yet.
        let id = app.zones.id;
        app.zones_missing(id, &why)?;
    }
    let result = loop {
        let far = Instant::now() + Duration::from_secs(86400);
        let pong_deadline = app
            .page
            .as_ref()
            .map_or(far, |p| p.last_pong + PONG_TIMEOUT);
        let rearm_at = app.rearm_at.unwrap_or(far);
        let move_due = app.coalescer.deadline();
        let cool_at = app.warm.cool_at;
        let entry_due = app.pointer.pending_deadline();
        let stray_due = app.stray.deadline();
        let zones_due = app.zone_recovery.deadline();
        let next_ping = app.next_ping;
        let step = tokio::select! {
            _ = sigterm.recv() => break Ok(()),
            _ = sigint.recv() => break Ok(()),
            event = ei_events.next() => match event {
                Some(Ok(event)) => app.on_ei(event).await,
                Some(Err(e)) => Err(anyhow!("EI stream: {e}")),
                None => Err(anyhow!("EIS closed the connection")),
            },
            Some(page) = page_rx.recv() => app.on_new_page(page).await,
            Some(event) = kwin_rx.recv() => app.on_kwin(event).await,
            Some(keys::KeyDown) = key_rx.recv() => app.on_key().await,
            _ = sleep_until(move_due.unwrap_or(far)), if move_due.is_some() => {
                app.on_move_due();
                Ok(())
            }
            _ = sleep_until(entry_due.unwrap_or(far)), if entry_due.is_some() => {
                app.on_entry_due().await
            }
            _ = sleep_until(stray_due.unwrap_or(far)), if stray_due.is_some() => {
                app.on_stray_due().await
            }
            _ = sleep_until(zones_due.unwrap_or(far)), if zones_due.is_some() => {
                app.refresh_zones().await
            }
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
            _ = sleep_until(next_ping), if app.page.is_some() => {
                app.on_ping_due();
                Ok(())
            }
            _ = sleep_until(cool_at.unwrap_or(far)), if cool_at.is_some() => {
                app.on_warm_cooled();
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
    drop(key_tx);
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

/// Warm-up: fast pings and a `warm` hint while the cursor is near the entry
/// corner (or captured), so the first `move` does not wake a sleeping Hub.
#[derive(Debug, Default)]
struct Warm {
    /// The KWin script last said the cursor is in the approach area.
    approach: bool,
    /// `warm {on: true}` was sent to the current page.
    on: bool,
    /// When to send `warm {on: false}`, once warm-up is no longer wanted.
    cool_at: Option<Instant>,
}

/// The agent's own input counts for the `perf` log line.
#[derive(Debug)]
struct Counters {
    since: Instant,
    /// Frozen at the end of a capture, so a `perf` sent after `leave` is not
    /// diluted by idle time.
    until: Option<Instant>,
    ei_frames: u64,
    moves_sent: u64,
    /// Activation time until the first `move` of that capture is sent.
    enter_at: Option<Instant>,
    first_move: Option<Duration>,
}

impl Counters {
    fn new(now: Instant) -> Self {
        Self {
            since: now,
            until: Some(now),
            ei_frames: 0,
            moves_sent: 0,
            enter_at: None,
            first_move: None,
        }
    }

    fn start(&mut self, now: Instant) {
        *self = Self::new(now);
        self.until = None;
        self.enter_at = Some(now);
    }

    fn moved(&mut self, now: Instant) {
        self.moves_sent += 1;
        if let Some(t) = self.enter_at.take() {
            self.first_move = Some(now - t);
        }
    }

    /// Rates since the last call, as `(ei frames/s, moves/s, moves, span)`.
    fn take(&mut self, now: Instant, active: bool) -> (f64, f64, u64, Duration) {
        let span = self.until.unwrap_or(now) - self.since;
        let secs = span.as_secs_f64();
        let rate = |n: u64| if secs > 0.0 { n as f64 / secs } else { 0.0 };
        let out = (
            rate(self.ei_frames),
            rate(self.moves_sent),
            self.moves_sent,
            span,
        );
        self.since = now;
        self.until = (!active).then_some(now);
        self.ei_frames = 0;
        self.moves_sent = 0;
        out
    }
}

struct App<'p> {
    cfg: Config,
    portal: &'p Portal,
    ei: ei::Context,
    zones: ZoneSet,
    /// True from the moment barriers may be enabled until a Disable succeeded.
    armed: bool,
    rearm_at: Option<Instant>,
    /// Captures the compositor started without announcing them.
    stray: Stray,
    /// Asks for the zones again while the compositor has none to give.
    zone_recovery: ZoneRecovery,
    pointer: Pointer,
    coalescer: MoveCoalescer,
    page: Option<Page>,
    next_page_id: u64,
    events: mpsc::Sender<PageEvent>,
    rtt: Rtt,
    next_ping: Instant,
    warm: Warm,
    /// Why the focused window keeps capture off (a game), if it does.
    gated: Option<String>,
    /// The KWin observer is running, so `warm.approach` can gate the barrier.
    approach_known: bool,
    counters: Counters,
    effects: Option<Effects>,
    script: Option<Script>,
}

impl<'p> App<'p> {
    fn new(
        cfg: Config,
        portal: &'p Portal,
        ei: ei::Context,
        zones: ZoneSet,
        events: mpsc::Sender<PageEvent>,
        effects: Option<Effects>,
        script: Option<Script>,
    ) -> Self {
        let now = Instant::now();
        Self {
            pointer: Pointer::new(
                cfg.gain,
                f64::from(cfg.hub_width_px),
                EntryRule {
                    push_px: f64::from(cfg.entry_push_px),
                    timeout: cfg.entry_timeout,
                },
            ),
            cfg,
            portal,
            ei,
            zones,
            armed: false,
            rearm_at: None,
            stray: Stray::default(),
            zone_recovery: ZoneRecovery::default(),
            coalescer: MoveCoalescer::default(),
            page: None,
            next_page_id: 0,
            events,
            rtt: Rtt::default(),
            next_ping: now + PING_SLOW,
            warm: Warm::default(),
            gated: None,
            approach_known: false,
            counters: Counters::new(now),
            effects,
            script,
        }
    }

    /// The entry corner's width: the Hub plus slack.
    fn reach(&self) -> u32 {
        self.cfg
            .hub_width_px
            .saturating_add(self.cfg.entry_slack_px)
    }

    fn page_ready(&self) -> bool {
        self.page.as_ref().is_some_and(|p| p.viewport.is_some())
    }

    fn load_script(&self) {
        if let (Some(script), Some(zone)) = (&self.script, leftmost_zone(&self.zones.zones)) {
            script.load(approach_for(zone, self.reach()));
        }
    }

    fn send(&mut self, msg: &AgentMsg) {
        if let Some(page) = &mut self.page
            && page.dead.is_none()
            && !page.conn.send(msg.encode())
        {
            page.dead = Some("page stopped reading");
        }
    }

    fn send_move(&mut self, now: Instant, (x, y): (f64, f64)) {
        self.send(&AgentMsg::Move { x, y });
        self.counters.moved(now);
    }

    /// Input frames for the page: `move`s are rate limited; anything else
    /// first flushes a pending `move` so it lands at the right point.
    fn send_input(&mut self, msg: &AgentMsg) {
        let now = Instant::now();
        match *msg {
            AgentMsg::Move { x, y } => {
                if let Some(pos) = self.coalescer.offer(now, (x, y)) {
                    self.send_move(now, pos);
                }
            }
            _ => {
                if let Some(pos) = self.coalescer.take(now) {
                    self.send_move(now, pos);
                }
                self.send(msg);
            }
        }
    }

    fn on_move_due(&mut self) {
        let now = Instant::now();
        if let Some(pos) = self.coalescer.flush_due(now) {
            self.send_move(now, pos);
        }
    }

    async fn release(&self, to: ReleaseTo) -> Result<()> {
        self.portal.release(to.activation_id, to.cursor).await
    }

    fn capture_started(&mut self) {
        let now = Instant::now();
        self.coalescer.reset();
        self.counters.start(now);
        if let Some(effects) = &self.effects {
            effects.suppress();
        }
        self.update_warm();
    }

    /// After the page got its `leave`, whoever ended the capture.
    fn capture_ended(&mut self) {
        self.coalescer.reset();
        self.counters.until = Some(Instant::now());
        self.counters.enter_at = None;
        if let Some(effects) = &self.effects {
            effects.restore();
        }
        self.update_warm();
    }

    /// Ends an ongoing capture from our side: `leave` first so the page
    /// reacts at once, then give the pointer back to the compositor. A push
    /// that has not entered yet is just handed back; the page saw nothing.
    async fn end_capture(&mut self, why: &str) -> Result<()> {
        let shown = self.pointer.is_active();
        let Some(to) = self.pointer.end() else {
            return Ok(());
        };
        if shown {
            log!("capture: ending ({why})");
            self.send_input(&AgentMsg::Leave);
            self.capture_ended();
        } else {
            log!("capture: entry abandoned ({why})");
        }
        self.release(to).await
    }

    /// A push into the corner did not enter: hand the pointer back where the
    /// hand went and rest the barrier briefly.
    async fn abort_entry(&mut self, to: ReleaseTo, why: Abort) -> Result<()> {
        log!(
            "capture: entry aborted ({}), release to {:?}",
            why.reason(),
            to.cursor
        );
        self.release(to).await?;
        self.disarm().await?;
        self.rearm_at = Some(Instant::now() + REARM_AFTER_ABORT);
        Ok(())
    }

    /// Ends a capture on our side, however `Pointer` decided it ends.
    async fn finish(&mut self, to: ReleaseTo, ended: Ended) -> Result<()> {
        match ended {
            Ended::Exit(edge) => {
                let edge = match edge {
                    Exit::Top => "top",
                    Exit::Left => "left",
                    Exit::Right => "right",
                };
                log!("capture: left the Hub's {edge}, release to {:?}", to.cursor);
                self.capture_ended();
                self.release(to).await?;
                self.rest_after_exit().await
            }
            Ended::Key => {
                log!("capture: ending (key pressed), release to {:?}", to.cursor);
                self.send_input(&AgentMsg::Leave);
                self.capture_ended();
                self.release(to).await?;
                self.rest_after_exit().await
            }
            Ended::Abort(why) => self.abort_entry(to, why).await,
        }
    }

    /// Coming back from the Hub, the hand is often still moving; resting the
    /// barrier keeps a jitter from capturing the pointer straight again.
    async fn rest_after_exit(&mut self) -> Result<()> {
        self.disarm().await?;
        self.rearm_at = Some(Instant::now() + REARM_AFTER_EXIT);
        Ok(())
    }

    /// A key went down on the desktop keyboard. Outside a capture it means
    /// nothing.
    async fn on_key(&mut self) -> Result<()> {
        match self.pointer.key_pressed() {
            Some((to, ended)) => self.finish(to, ended).await,
            None => Ok(()),
        }
    }

    async fn on_entry_due(&mut self) -> Result<()> {
        match self.pointer.timeout(Instant::now()) {
            Some(to) => self.abort_entry(to, Abort::Timeout).await,
            None => Ok(()),
        }
    }

    async fn arm(&mut self) -> Result<()> {
        self.rearm_at = None;
        if self.gated.is_some() {
            return Ok(());
        }
        let Some(zone) = leftmost_zone(&self.zones.zones) else {
            log!("portal: no zones to place a barrier on");
            return Ok(());
        };
        self.pointer.set_zone(Some(zone));
        self.armed = true;
        if let Err(e) = self.portal.arm(self.zones.id, zone).await {
            log!("portal: arming failed: {e:#}; retrying in {REARM_AFTER_FAILURE:?}");
            self.disarm().await?;
            self.rearm_at = Some(Instant::now() + REARM_AFTER_FAILURE);
        }
        Ok(())
    }

    async fn disarm(&mut self) -> Result<()> {
        self.rearm_at = None;
        if self.armed {
            self.portal.disarm(self.zones.id).await?;
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
        self.warm.on = false;
        self.warm.cool_at = None;
        self.disarm().await
    }

    async fn reap(&mut self) -> Result<()> {
        if let Some(why) = self.page.as_ref().and_then(|p| p.dead) {
            return self.drop_page(why).await;
        }
        // A game took focus or the cursor moved away during a capture:
        // disarm once it is over.
        self.sync_arm().await
    }

    async fn on_new_page(&mut self, new: NewPage) -> Result<()> {
        self.drop_page("replaced by a new connection").await?;
        self.next_page_id += 1;
        let id = self.next_page_id;
        log!("page {id}: connected from {}", new.peer);
        let now = Instant::now();
        let mut page = Page {
            conn: PageConn::spawn(id, new, self.events.clone()),
            viewport: None,
            last_pong: now,
            pings: Pings::default(),
            dead: None,
        };
        let ping_id = page.pings.start(now, false);
        self.page = Some(page);
        self.send(&AgentMsg::Ping { id: ping_id });
        self.next_ping = now + PING_SLOW;
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
                if let Some(sample) = page.pings.finish(id, now) {
                    self.rtt.record(sample);
                }
            }
            PageMsg::Hello { w, h } => {
                if page.viewport != Some((w, h)) {
                    log!("page {}: hello {w}x{h}", page.conn.id);
                }
                page.viewport = Some((w, h));
                if let Some(msg) = self.pointer.set_viewport(Some((w, h))) {
                    self.send_input(&msg);
                }
                self.update_warm();
                self.sync_arm().await?;
            }
            PageMsg::Perf(perf) => self.log_perf(&perf),
        }
        Ok(())
    }

    fn log_perf(&mut self, p: &Perf) {
        let (ei_rate, sent_rate, sent, span) =
            self.counters.take(Instant::now(), self.pointer.is_active());
        let first = self
            .counters
            .first_move
            .take()
            .map(|d| format!(", enter→move {:.1} ms", ms(d)))
            .unwrap_or_default();
        log!(
            "perf: hub lag p50 {:.1} p95 {:.1} max {:.0} ms, frame gap max {:.0} ms, \
             long tasks {:.0} ({:.0} ms), {:.0} moves {:.0} frames/{:.1} s; \
             agent ei {ei_rate:.0}/s sent {sent_rate:.0}/s ({sent} moves/{:.1} s){first}",
            p.lag_p50,
            p.lag_p95,
            p.lag_max,
            p.gap_max,
            p.long_tasks,
            p.long_task_ms,
            p.moves,
            p.frames,
            p.span / 1000.0,
            span.as_secs_f64(),
        );
    }

    async fn on_kwin(&mut self, event: KwinEvent) -> Result<()> {
        match event {
            KwinEvent::Window(window) => {
                // The script reports the window as soon as it runs, so from
                // here on the approach signal is trustworthy.
                self.approach_known = true;
                let gated = window.and_then(|w| self.cfg.gate.blocked_by(&w));
                if gated == self.gated {
                    return self.sync_arm().await;
                }
                match &gated {
                    Some(why) => log!("gate: blocked by {why}"),
                    None => log!("gate: open"),
                }
                self.gated = gated;
                // A capture in progress is left alone (it cannot start in a
                // game anyway); sync_arm() disarms once it is over.
                self.update_warm();
                self.sync_arm().await?;
            }
            KwinEvent::Approach(inside) => {
                if inside != self.warm.approach {
                    self.warm.approach = inside;
                    self.update_warm();
                    self.sync_arm().await?;
                }
            }
            KwinEvent::ScriptLost => {
                // Without the observer the barrier stays armed while a page is
                // connected, as before the approach gate, until it reports in.
                self.approach_known = false;
                self.warm.approach = false;
                self.update_warm();
                self.sync_arm().await?;
            }
        }
        Ok(())
    }

    fn warm_wanted(&self) -> bool {
        (self.warm.approach || self.pointer.is_capturing())
            && self.gated.is_none()
            && self.page_ready()
    }

    fn ping_period(&self) -> Duration {
        // During capture the moves keep the link busy.
        if self.warm.on && !self.pointer.is_active() {
            PING_FAST
        } else {
            PING_SLOW
        }
    }

    fn update_warm(&mut self) {
        if self.warm_wanted() {
            self.warm.cool_at = None;
            if !self.warm.on {
                self.warm.on = true;
                log!("warm: on");
                self.send(&AgentMsg::Warm { on: true });
            }
        } else if self.warm.on && self.warm.cool_at.is_none() {
            self.warm.cool_at = Some(Instant::now() + WARM_HYSTERESIS);
        }
        let soonest = Instant::now() + self.ping_period();
        self.next_ping = self.next_ping.min(soonest);
    }

    fn on_warm_cooled(&mut self) {
        self.warm.cool_at = None;
        if self.warm_wanted() || !self.warm.on {
            return;
        }
        self.warm.on = false;
        log!("warm: off");
        self.send(&AgentMsg::Warm { on: false });
    }

    /// The compositor captured the pointer and the portal never said so (see
    /// [`stray`]). Enabling again ends that capture; if the pointer is still
    /// against the edge the compositor then announces it properly, with its
    /// position, and the usual hand-back or entry takes over. Whatever is
    /// armed afterwards is disarmed again by `sync_arm` once the pause is over.
    async fn on_stray_due(&mut self) -> Result<()> {
        let Some(sequence) = self.stray.take_due(Instant::now()) else {
            return Ok(());
        };
        if self.pointer.is_capturing() {
            return Ok(());
        }
        let Some(zone) = leftmost_zone(&self.zones.zones) else {
            return Ok(());
        };
        log!(
            "capture: stray capture {sequence} with no activation; enabling to get the pointer back"
        );
        self.pointer.set_zone(Some(zone));
        self.armed = true;
        // A pause that was already running is not shortened.
        let settled = Instant::now() + STRAY_SETTLE;
        self.rearm_at = Some(self.rearm_at.map_or(settled, |at| at.max(settled)));
        if let Err(e) = self.portal.arm(self.zones.id, zone).await {
            log!("portal: arming failed: {e:#}; retrying in {REARM_AFTER_FAILURE:?}");
            self.disarm().await?;
            self.rearm_at = Some(Instant::now() + REARM_AFTER_FAILURE);
        }
        Ok(())
    }

    async fn on_activated(
        &mut self,
        activation_id: Option<u32>,
        cursor: Option<(f64, f64)>,
    ) -> Result<()> {
        self.stray.activated(activation_id);
        let hand_back = ReleaseTo {
            activation_id,
            cursor: leftmost_zone(&self.zones.zones).and_then(|z| z.hand_back_point(cursor)),
        };
        if !self.page_ready() {
            // Barriers are only armed with a page, but never keep a pointer
            // nobody can see.
            log!("capture: activated without a page; releasing");
            self.release(hand_back).await?;
            return self.disarm().await;
        }
        if let Some(why) = &self.gated {
            // The barrier was still up while a game took focus.
            log!("capture: activated while blocked by {why}; releasing");
            self.release(hand_back).await?;
            return self.disarm().await;
        }
        if let Some(zone) = leftmost_zone(&self.zones.zones)
            && !in_entry_zone(zone, self.reach(), cursor.map(|c| c.0))
        {
            // KDE only accepts barriers that fill the edge, so pushes along
            // the bottom outside the entry corner land here. Hand the pointer
            // straight back and rest the barrier briefly so a sustained push
            // does not loop.
            self.release(hand_back).await?;
            self.disarm().await?;
            self.rearm_at = Some(Instant::now() + REARM_AFTER_OUTSIDE_CORNER);
            return Ok(());
        }
        // Nothing shows on the Hub until the push commits (see on_ei).
        match self.pointer.activate(activation_id, cursor, Instant::now()) {
            Ok(()) => {
                log!("capture: pending");
                Ok(())
            }
            Err(to) => self.release(to).await,
        }
    }

    fn on_deactivated(&mut self, activation_id: Option<u32>) {
        let pending = self.pointer.is_pending();
        if self.pointer.deactivated(activation_id) {
            log!("capture: ended by compositor");
            self.send_input(&AgentMsg::Leave);
            self.capture_ended();
        } else if pending && !self.pointer.is_capturing() {
            log!("capture: entry ended by compositor");
        }
    }

    fn on_disabled(&mut self) {
        self.on_deactivated(None);
        // Our own Disable may echo this signal; re-arming after a pause
        // (and only with a live page) keeps that from looping.
        if self.page_ready() && self.rearm_at.is_none() {
            self.rearm_at = Some(Instant::now() + REARM_AFTER_DISABLED);
        }
    }

    async fn on_rearm(&mut self) -> Result<()> {
        self.rearm_at = None;
        self.sync_arm().await
    }

    /// The barrier must fill the whole bottom edge (KDE's rule), so it is only
    /// armed while the cursor is near the entry corner. Elsewhere a push
    /// against the bottom edge, onto the taskbar for example, never touches
    /// it. Without the KWin observer it stays armed, as before.
    fn arm_wanted(&self) -> bool {
        self.page_ready() && self.gated.is_none() && (self.warm.approach || !self.approach_known)
    }

    async fn sync_arm(&mut self) -> Result<()> {
        // No zones yet: nothing to put a barrier on, and no point asking.
        if self.pointer.is_capturing() || self.rearm_at.is_some() || self.zone_recovery.pending() {
            return Ok(());
        }
        match (self.arm_wanted(), self.armed) {
            (true, false) => self.arm().await,
            (false, true) => self.disarm().await,
            _ => Ok(()),
        }
    }

    async fn on_zones_changed(&mut self) -> Result<()> {
        self.end_capture("zones changed").await?;
        // The old zone set is invalid now and KDE has already dropped its
        // barriers; clearing them against it would be refused, and the portal
        // closes a session whose call it has to refuse.
        self.portal.forget_barrier();
        self.disarm().await?;
        self.refresh_zones().await
    }

    /// Asks the portal for the zones again. A monitor that is gone (unplugged
    /// or asleep) leaves the compositor with nothing to report, and its
    /// answer can time out; that is not fatal. The agent waits without a
    /// barrier and retries, and the next `ZonesChanged` also lands here.
    async fn refresh_zones(&mut self) -> Result<()> {
        match self.portal.zones().await {
            Ok(zones) if !zones.zones.is_empty() => {
                if self.zone_recovery.failures() > 0 {
                    log!(
                        "portal: zones are back after {} failed attempts",
                        self.zone_recovery.failures()
                    );
                }
                self.zone_recovery.recovered();
                self.zones = zones;
                log!("portal: zones {:?}", self.zones);
                self.pointer.set_zone(leftmost_zone(&self.zones.zones));
                self.load_script();
                self.sync_arm().await
            }
            Ok(zones) => self.zones_missing(zones.id, "the portal reports no zones"),
            Err(e) => {
                let id = self.zones.id;
                self.zones_missing(id, &format!("{e:#}"))
            }
        }
    }

    fn zones_missing(&mut self, id: u32, why: &str) -> Result<()> {
        // Stale zones must never reach SetPointerBarriers: the portal closes
        // a session whose call it has to refuse.
        self.zones = ZoneSet {
            id,
            zones: Vec::new(),
        };
        self.pointer.set_zone(None);
        self.armed = false;
        self.zone_recovery
            .failed(Instant::now())
            .map_err(|g| anyhow!("no usable zones after {} attempts: {why}", g.failures))?;
        log!(
            "portal: no usable zones ({why}); attempt {}, asking again in {:?}",
            self.zone_recovery.failures(),
            recovery::RETRY_AFTER
        );
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
                self.counters.ei_frames += 1;
                let out = self.pointer.frame(Instant::now());
                if out.entered {
                    // Effects and counters start only once the push commits.
                    self.capture_started();
                    if let Some(enter) = out.msgs.first() {
                        log!("capture: enter {enter:?}");
                    }
                }
                for msg in &out.msgs {
                    self.send_input(msg);
                }
                if let Some((to, ended)) = out.release {
                    self.finish(to, ended).await?;
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
                log!("ei: start emulating (sequence {})", e.sequence);
                self.stray
                    .started(e.sequence, self.pointer.is_capturing(), Instant::now());
            }
            EiEvent::DeviceStopEmulating(_) => {
                log!("ei: stop emulating");
                self.stray.stopped();
            }
            EiEvent::Disconnected(d) => {
                bail!("EIS disconnected: {:?} {:?}", d.reason, d.explanation)
            }
            _ => {}
        }
        Ok(())
    }

    fn on_ping_due(&mut self) {
        let now = Instant::now();
        let period = self.ping_period();
        self.next_ping = now + period;
        let Some(page) = self.page.as_mut() else {
            return;
        };
        let id = page.pings.start(now, period == PING_FAST);
        self.send(&AgentMsg::Ping { id });
    }

    fn report_latency(&mut self) {
        if !self.cfg.log_latency {
            return;
        }
        if let Some(s) = self.rtt.take() {
            log!(
                "ws: rtt p50 {:.1} ms p95 {:.1} ms max {:.1} ms ({} pongs, {} fast)",
                ms(s.p50),
                ms(s.p95),
                ms(s.max),
                s.n,
                s.fast
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
        if let Some(effects) = &self.effects {
            effects.shutdown(KWIN_EXIT_TIMEOUT).await;
        }
        if let Some(script) = &self.script {
            script.unload(KWIN_EXIT_TIMEOUT).await;
        }
        self.portal.close().await;
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_rate_over_the_capture_only() {
        let t0 = Instant::now();
        let mut c = Counters::new(t0);
        c.start(t0);
        for _ in 0..2000 {
            c.ei_frames += 1;
        }
        c.moved(t0 + Duration::from_millis(4));
        c.moved(t0 + Duration::from_millis(12));
        assert_eq!(c.first_move, Some(Duration::from_millis(4)));
        // Capture ends at 2 s; the post-leave perf arrives later.
        c.until = Some(t0 + Duration::from_secs(2));
        let (ei, sent, n, span) = c.take(t0 + Duration::from_secs(3), false);
        assert_eq!(
            (ei, sent, n, span),
            (1000.0, 1.0, 2, Duration::from_secs(2))
        );
        // Nothing since: zero span, zero rates.
        let (ei, sent, n, span) = c.take(t0 + Duration::from_secs(5), false);
        assert_eq!((ei, sent, n, span), (0.0, 0.0, 0, Duration::ZERO));
    }
}
