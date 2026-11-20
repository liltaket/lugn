//! Pure capture logic: barrier placement, desktop <-> Hub coordinate mapping
//! and the per-libei-frame state machine.

use std::time::Duration;

use tokio::time::Instant;

use crate::protocol::{AgentMsg, ButtonName};

/// Desktop px per wheel notch; libei reports 120 units per notch.
const NOTCH_PX: f64 = 48.0;
const DISCRETE_PER_NOTCH: f64 = 120.0;
/// How far above the monitor's bottom edge (and right of its left edge) the
/// pointer comes back, so it does not immediately hit the barrier again.
const RETURN_INSET: f64 = 2.0;
/// Hub px below the top edge where the cursor lands on entry, so a small
/// upward jitter right after entry does not leave again.
const ENTRY_INSET: f64 = 24.0;
/// Desktop px a pending push may drift back up before it counts as a retreat.
const BACK_UP_PX: f64 = 4.0;

/// An InputCapture zone (one logical monitor) in desktop logical px.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Zone {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Zone {
    /// One past the last row, like the portal's `y + height`.
    pub fn bottom(&self) -> i32 {
        self.y + self.height as i32
    }

    /// One past the last column.
    pub fn right(&self) -> i32 {
        self.x + self.width as i32
    }

    /// Just above the bottom edge at desktop `x`, clamped into the zone.
    fn bottom_point(&self, x: f64) -> (f64, f64) {
        let y = self.bottom() as f64 - 1.0 - RETURN_INSET;
        (
            x.clamp(self.x as f64, self.right() as f64 - 1.0),
            y.max(self.y as f64),
        )
    }
}

/// The monitor the Hub stands below: the leftmost zone, and the lowest of
/// those if several share that x.
pub fn leftmost_zone(zones: &[Zone]) -> Option<Zone> {
    zones
        .iter()
        .copied()
        .min_by_key(|z| (z.x, std::cmp::Reverse(z.bottom())))
}

/// Horizontal barriers on the zone's whole bottom edge, in the order to try.
/// KDE rejects a barrier that does not fill the edge ("doesnt fill or on edge
/// to another screen"), so the entry corner is enforced on activation instead
/// (see [`in_entry_zone`]). Whether the line sits on the last row or one past
/// it, and whether its end is the last column or one past it, is not
/// documented, so the caller tries these in order and remembers the winner.
pub fn barrier_lines(zone: Zone) -> [(i32, i32, i32, i32); 4] {
    let (x, r, b) = (zone.x, zone.right(), zone.bottom());
    [
        (x, b, r - 1, b),
        (x, b - 1, r - 1, b - 1),
        (x, b, r, b),
        (x, b - 1, r, b - 1),
    ]
}

/// Whether an activation at `cursor_x` lies in the entry corner: from the
/// zone's left edge to `reach` px right of it (the Hub's width plus slack).
/// Unknown positions count as inside, so a missing hint never blocks entry.
pub fn in_entry_zone(zone: Zone, reach: u32, cursor_x: Option<f64>) -> bool {
    let (left, right) = (f64::from(zone.x), f64::from(zone.x) + f64::from(reach));
    cursor_x.is_none_or(|x| (left..=right).contains(&x))
}

/// Maps between the zone's bottom edge and the Hub viewport. The Hub stands
/// below the monitor with its left edge level with the monitor's, and is
/// `hub_width` desktop px wide physically, so positions along the edge scale
/// by `w / hub_width`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mapping {
    pub zone: Zone,
    pub hub_width: f64,
    pub w: f64,
    pub h: f64,
}

impl Mapping {
    /// The Hub x below desktop `cursor_x`; the middle when unknown.
    pub fn enter_x(&self, cursor_x: Option<f64>) -> f64 {
        let x = match cursor_x {
            Some(cx) => (cx - self.zone.x as f64) * self.w / self.hub_width,
            None => self.w / 2.0,
        };
        x.clamp(0.0, self.w - 1.0)
    }

    /// Where the desktop pointer comes back when the cursor leaves the Hub's
    /// top at `hub_x`: just above the monitor's bottom edge, at the matching x.
    pub fn return_point(&self, hub_x: f64) -> (f64, f64) {
        let x = self.zone.x as f64 + hub_x * self.hub_width / self.w;
        self.zone.bottom_point(x)
    }

    /// Out through the Hub's left edge: the monitor's bottom-left corner.
    pub fn return_left(&self) -> (f64, f64) {
        self.zone.bottom_point(self.zone.x as f64 + RETURN_INSET)
    }

    /// Out through the Hub's right edge: just right of the Hub's width.
    pub fn return_right(&self) -> (f64, f64) {
        self.zone
            .bottom_point(self.zone.x as f64 + self.hub_width + RETURN_INSET)
    }
}

/// How hard a push into the entry corner must be before it enters the Hub.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EntryRule {
    /// Desktop px of mostly-downward motion that commits; the same amount
    /// sideways aborts.
    pub push_px: f64,
    /// A push that has not committed by then is aborted.
    pub timeout: Duration,
}

#[derive(Debug, Default, Clone, PartialEq)]
struct FrameAcc {
    dx: f64,
    dy: f64,
    buttons: Vec<(ButtonName, bool)>,
    /// Any button event, including ones the page has no name for.
    any_button: bool,
    scroll: (f64, f64),
    discrete: (i32, i32),
}

impl FrameAcc {
    fn has_input(&self) -> bool {
        self.any_button || self.scroll != (0.0, 0.0) || self.discrete != (0, 0)
    }
}

/// Captured by the compositor, but not shown on the Hub yet: the push down
/// out of the corner has to prove it means it.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Pending {
    activation_id: Option<u32>,
    /// Desktop x where the barrier stopped the pointer, if the portal said.
    start_x: Option<f64>,
    /// Motion since activation, desktop px.
    dx: f64,
    dy: f64,
    deadline: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Active {
    activation_id: Option<u32>,
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    Idle,
    Pending(Pending),
    Active(Active),
}

/// What the caller must do to end a capture with the compositor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReleaseTo {
    pub activation_id: Option<u32>,
    /// Desktop position to put the pointer back at, if known.
    pub cursor: Option<(f64, f64)>,
}

/// The Hub edge a shown cursor left through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Top,
    Left,
    Right,
}

/// Why a pending push did not enter the Hub.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Abort {
    /// Slid along the bottom edge instead of pushing down.
    Sideways,
    /// Moved back up.
    BackUp,
    /// Did not push far enough in time.
    Timeout,
    /// A button or the wheel was used; libei captured that event, so the
    /// desktop never sees it.
    Input,
}

impl Abort {
    pub fn reason(self) -> &'static str {
        match self {
            Self::Sideways => "slid sideways",
            Self::BackUp => "moved back up",
            Self::Timeout => "timed out",
            Self::Input => "button or wheel used; that event is lost",
        }
    }
}

/// How a capture ended on our side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// The cursor left the Hub; the page needs `leave` (already in `msgs`).
    Exit(Exit),
    /// The push never entered; the page saw nothing.
    Abort(Abort),
}

#[derive(Debug, Default, PartialEq)]
pub struct FrameOutcome {
    pub msgs: Vec<AgentMsg>,
    /// The push committed; `msgs` starts with `enter`.
    pub entered: bool,
    /// Capture ends here and the caller must Release. After an exit `msgs`
    /// ends with `leave`; after an abort nothing is sent.
    pub release: Option<(ReleaseTo, Ended)>,
}

/// Capture state. The compositor decides when capture starts (Activated);
/// this decides whether it becomes an entry and when it ends on our side.
#[derive(Debug)]
pub struct Pointer {
    gain: f64,
    hub_width: f64,
    entry: EntryRule,
    zone: Option<Zone>,
    viewport: Option<(f64, f64)>,
    state: State,
    frame: FrameAcc,
}

impl Pointer {
    pub fn new(gain: f64, hub_width: f64, entry: EntryRule) -> Self {
        Self {
            gain,
            hub_width,
            entry,
            zone: None,
            viewport: None,
            state: State::Idle,
            frame: FrameAcc::default(),
        }
    }

    /// The cursor is shown on the Hub.
    pub fn is_active(&self) -> bool {
        matches!(self.state, State::Active(_))
    }

    /// Captured, but the push has not committed yet.
    pub fn is_pending(&self) -> bool {
        matches!(self.state, State::Pending(_))
    }

    /// The compositor has handed us the pointer (pending or active).
    pub fn is_capturing(&self) -> bool {
        !matches!(self.state, State::Idle)
    }

    /// When a pending push times out, so the caller can wake up for it.
    pub fn pending_deadline(&self) -> Option<Instant> {
        match self.state {
            State::Pending(p) => Some(p.deadline),
            _ => None,
        }
    }

    pub fn set_zone(&mut self, zone: Option<Zone>) {
        self.zone = zone;
    }

    /// Returns a `move` if a resize pulled an active cursor back inside.
    pub fn set_viewport(&mut self, viewport: Option<(f64, f64)>) -> Option<AgentMsg> {
        self.viewport = viewport;
        let (w, h) = viewport?;
        let State::Active(a) = &mut self.state else {
            return None;
        };
        let (x, y) = (a.x.clamp(0.0, w - 1.0), a.y.clamp(0.0, h - 1.0));
        if (x, y) == (a.x, a.y) {
            return None;
        }
        (a.x, a.y) = (x, y);
        Some(AgentMsg::Move { x, y })
    }

    fn mapping(&self) -> Option<Mapping> {
        let (w, h) = self.viewport?;
        Some(Mapping {
            zone: self.zone?,
            hub_width: self.hub_width,
            w,
            h,
        })
    }

    /// Handles the compositor's Activated signal: the push becomes pending.
    /// `Err` means there is no page geometry to show a cursor on, so the
    /// caller must release at once.
    pub fn activate(
        &mut self,
        activation_id: Option<u32>,
        cursor: Option<(f64, f64)>,
        now: Instant,
    ) -> Result<(), ReleaseTo> {
        self.frame = FrameAcc::default();
        if self.mapping().is_none() {
            self.state = State::Idle;
            return Err(ReleaseTo {
                activation_id,
                cursor: None,
            });
        }
        self.state = State::Pending(Pending {
            activation_id,
            start_x: cursor.map(|c| c.0),
            dx: 0.0,
            dy: 0.0,
            deadline: now + self.entry.timeout,
        });
        Ok(())
    }

    /// The compositor ended capture itself. Returns whether the cursor was
    /// shown (and so the page needs a `leave`). A mismatched activation id
    /// belongs to an older capture and is ignored.
    pub fn deactivated(&mut self, activation_id: Option<u32>) -> bool {
        let own = match self.state {
            State::Idle => return false,
            State::Pending(p) => p.activation_id,
            State::Active(a) => a.activation_id,
        };
        if let (Some(own), Some(id)) = (own, activation_id)
            && own != id
        {
            return false;
        }
        let was_active = self.is_active();
        self.state = State::Idle;
        was_active
    }

    /// Where a pending push hands the pointer back: where the hand went,
    /// just above the bottom edge.
    fn abort_release(&self, p: &Pending) -> ReleaseTo {
        ReleaseTo {
            activation_id: p.activation_id,
            cursor: self
                .zone
                .zip(p.start_x)
                .map(|(zone, x)| zone.bottom_point(x + p.dx)),
        }
    }

    /// Ends capture from our side (disconnect, timeout, shutdown). Check
    /// [`Self::is_active`] first: only a shown cursor needs a `leave`.
    pub fn end(&mut self) -> Option<ReleaseTo> {
        match std::mem::replace(&mut self.state, State::Idle) {
            State::Idle => None,
            State::Pending(p) => Some(self.abort_release(&p)),
            State::Active(a) => Some(ReleaseTo {
                activation_id: a.activation_id,
                cursor: self.mapping().map(|m| m.return_point(a.x)),
            }),
        }
    }

    /// Aborts a pending push whose deadline has passed.
    pub fn timeout(&mut self, now: Instant) -> Option<ReleaseTo> {
        let State::Pending(p) = self.state else {
            return None;
        };
        if now < p.deadline {
            return None;
        }
        self.state = State::Idle;
        self.frame = FrameAcc::default();
        Some(self.abort_release(&p))
    }

    pub fn motion(&mut self, dx: f64, dy: f64) {
        self.frame.dx += dx;
        self.frame.dy += dy;
    }

    pub fn button(&mut self, evdev_code: u32, down: bool) {
        self.frame.any_button = true;
        if let Some(b) = ButtonName::from_evdev(evdev_code) {
            self.frame.buttons.push((b, down));
        }
    }

    pub fn scroll(&mut self, dx: f64, dy: f64) {
        self.frame.scroll.0 += dx;
        self.frame.scroll.1 += dy;
    }

    pub fn scroll_discrete(&mut self, dx: i32, dy: i32) {
        self.frame.discrete.0 += dx;
        self.frame.discrete.1 += dy;
    }

    /// Applies everything accumulated since the last libei frame.
    pub fn frame(&mut self, now: Instant) -> FrameOutcome {
        let f = std::mem::take(&mut self.frame);
        let Some(map) = self.mapping() else {
            return FrameOutcome::default();
        };
        match self.state {
            State::Idle => FrameOutcome::default(),
            State::Pending(p) => self.pending_frame(map, p, f, now),
            State::Active(a) => self.active_frame(map, a, f),
        }
    }

    fn pending_frame(
        &mut self,
        map: Mapping,
        mut p: Pending,
        f: FrameAcc,
        now: Instant,
    ) -> FrameOutcome {
        let mut out = FrameOutcome::default();
        p.dx += f.dx;
        p.dy += f.dy;
        let push = self.entry.push_px;
        let abort = if now >= p.deadline {
            Some(Abort::Timeout)
        } else if f.has_input() {
            Some(Abort::Input)
        } else if p.dy >= push && p.dx.abs() < p.dy {
            let x = map.enter_x(p.start_x.map(|x| x + p.dx));
            let y = ((p.dy - push) * self.gain + ENTRY_INSET).clamp(0.0, map.h - 1.0);
            self.state = State::Active(Active {
                activation_id: p.activation_id,
                x,
                y,
            });
            out.msgs.push(AgentMsg::Enter { x, y });
            out.entered = true;
            return out;
        } else if p.dx.abs() >= push {
            Some(Abort::Sideways)
        } else if p.dy < -BACK_UP_PX {
            Some(Abort::BackUp)
        } else {
            None
        };
        match abort {
            Some(why) => {
                self.state = State::Idle;
                out.release = Some((self.abort_release(&p), Ended::Abort(why)));
            }
            None => self.state = State::Pending(p),
        }
        out
    }

    fn active_frame(&mut self, map: Mapping, mut a: Active, f: FrameAcc) -> FrameOutcome {
        let mut out = FrameOutcome::default();
        if f.dx != 0.0 || f.dy != 0.0 {
            let nx = a.x + f.dx * self.gain;
            // The bottom is a wall; the other three edges lead back.
            let ny = (a.y + f.dy * self.gain).min(map.h - 1.0);
            let exit = if ny < 0.0 {
                // Anywhere along the top: straight up onto the monitor.
                Some((Exit::Top, map.return_point(nx.clamp(0.0, map.w - 1.0))))
            } else if nx < 0.0 {
                Some((Exit::Left, map.return_left()))
            } else if nx >= map.w {
                Some((Exit::Right, map.return_right()))
            } else {
                None
            };
            if let Some((edge, cursor)) = exit {
                self.state = State::Idle;
                out.msgs.push(AgentMsg::Leave);
                out.release = Some((
                    ReleaseTo {
                        activation_id: a.activation_id,
                        cursor: Some(cursor),
                    },
                    Ended::Exit(edge),
                ));
                return out;
            }
            let nx = nx.min(map.w - 1.0);
            if (nx, ny) != (a.x, a.y) {
                (a.x, a.y) = (nx, ny);
                out.msgs.push(AgentMsg::Move { x: nx, y: ny });
            }
        }
        self.state = State::Active(a);

        let (x, y) = (a.x, a.y);
        for (button, down) in f.buttons {
            out.msgs.push(AgentMsg::Button { button, down, x, y });
        }

        // Wheels may report both a discrete notch and a smooth delta for the
        // same motion; the notch wins so a frame never scrolls twice.
        let (dx, dy) = if f.discrete != (0, 0) {
            let px = |d: i32| d as f64 / DISCRETE_PER_NOTCH * NOTCH_PX;
            (px(f.discrete.0), px(f.discrete.1))
        } else {
            f.scroll
        };
        if dx != 0.0 || dy != 0.0 {
            out.msgs.push(AgentMsg::Wheel { dx, dy, x, y });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: Zone = Zone {
        x: 0,
        y: 0,
        width: 3657,
        height: 1029,
    };
    const HUB_WIDTH: f64 = 560.0;
    const RULE: EntryRule = EntryRule {
        push_px: 40.0,
        timeout: Duration::from_millis(350),
    };

    fn hub_with_gain(gain: f64) -> Pointer {
        let mut p = Pointer::new(gain, HUB_WIDTH, RULE);
        p.set_zone(Some(MONITOR));
        p.set_viewport(Some((1280.0, 800.0)));
        p
    }

    fn hub() -> Pointer {
        hub_with_gain(1.0)
    }

    fn map() -> Mapping {
        Mapping {
            zone: MONITOR,
            hub_width: HUB_WIDTH,
            w: 1280.0,
            h: 800.0,
        }
    }

    fn ms(t0: Instant, n: u64) -> Instant {
        t0 + Duration::from_millis(n)
    }

    /// Activates at `cursor_x` and pushes exactly far enough to commit,
    /// landing at the entry inset.
    fn enter(p: &mut Pointer, id: Option<u32>, cursor_x: f64) -> (f64, f64) {
        let t0 = Instant::now();
        p.activate(id, Some((cursor_x, 1028.0)), t0).unwrap();
        p.motion(0.0, RULE.push_px);
        let out = p.frame(ms(t0, 10));
        assert!(out.entered, "{out:?}");
        match out.msgs[..] {
            [AgentMsg::Enter { x, y }] => (x, y),
            _ => panic!("{out:?}"),
        }
    }

    fn aborted(out: &FrameOutcome) -> Option<(Option<(f64, f64)>, Abort)> {
        match out.release {
            Some((to, Ended::Abort(why))) => Some((to.cursor, why)),
            _ => None,
        }
    }

    #[test]
    fn picks_leftmost_then_lowest_zone() {
        let right = Zone {
            x: 3657,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert_eq!(leftmost_zone(&[right, MONITOR]), Some(MONITOR));
        let upper = Zone {
            x: 0,
            y: -1080,
            width: 1920,
            height: 1080,
        };
        assert_eq!(leftmost_zone(&[upper, MONITOR]), Some(MONITOR));
        assert_eq!(leftmost_zone(&[]), None);
    }

    #[test]
    fn barriers_fill_the_bottom_edge() {
        assert_eq!(
            barrier_lines(MONITOR),
            [
                (0, 1029, 3656, 1029),
                (0, 1028, 3656, 1028),
                (0, 1029, 3657, 1029),
                (0, 1028, 3657, 1028),
            ]
        );
        let offset = Zone {
            x: -100,
            y: 50,
            width: 100,
            height: 200,
        };
        assert_eq!(barrier_lines(offset)[0], (-100, 250, -1, 250));
        assert_eq!(barrier_lines(offset)[3], (-100, 249, 0, 249));
    }

    #[test]
    fn entry_zone_is_the_bottom_left_corner() {
        let reach = 560 + 60;
        assert!(in_entry_zone(MONITOR, reach, Some(0.0)));
        assert!(in_entry_zone(MONITOR, reach, Some(300.5)));
        assert!(in_entry_zone(MONITOR, reach, Some(620.0)));
        assert!(!in_entry_zone(MONITOR, reach, Some(620.5)));
        assert!(!in_entry_zone(MONITOR, reach, Some(2000.0)));
        assert!(in_entry_zone(MONITOR, reach, None));
        let offset = Zone { x: 1000, ..MONITOR };
        assert!(!in_entry_zone(offset, reach, Some(999.0)));
        assert!(in_entry_zone(offset, reach, Some(1620.0)));
        assert!(!in_entry_zone(offset, reach, Some(1621.0)));
    }

    #[test]
    fn enter_maps_x_along_the_hub_width() {
        let m = map();
        assert_eq!(m.enter_x(Some(0.0)), 0.0);
        assert_eq!(m.enter_x(Some(280.0)), 640.0);
        assert_eq!(m.enter_x(Some(140.0)), 320.0);
        // The slack past the Hub's right edge clamps to its last column.
        assert_eq!(m.enter_x(Some(600.0)), 1279.0);
        assert_eq!(m.enter_x(Some(620.0)), 1279.0);
        assert_eq!(m.enter_x(None), 640.0);
        let offset = Mapping {
            zone: Zone { x: -500, ..MONITOR },
            ..m
        };
        assert_eq!(offset.enter_x(Some(-220.0)), 640.0);
    }

    #[test]
    fn return_inverts_enter() {
        let m = map();
        for cx in [0.0, 1.0, 100.25, 280.0, 559.0] {
            let (rx, ry) = m.return_point(m.enter_x(Some(cx)));
            assert!((rx - cx).abs() < 1e-9, "cx {cx} -> {rx}");
            assert_eq!(ry, 1026.0);
        }
        // The last column comes back just inside the Hub's width.
        let (rx, _) = m.return_point(1279.0);
        assert!((rx - 559.5625).abs() < 1e-9);
        // A Hub mapped wider than the monitor clamps into the zone.
        let tiny = Zone {
            width: 300,
            ..MONITOR
        };
        let narrow = Mapping { zone: tiny, ..m };
        assert_eq!(narrow.return_point(1279.0).0, 299.0);
        assert_eq!(narrow.return_right(), (299.0, 1026.0));
    }

    #[test]
    fn activation_is_pending_until_pushed_far_enough_down() {
        let mut p = hub();
        let t0 = Instant::now();
        assert_eq!(p.activate(Some(5), Some((280.0, 1028.0)), t0), Ok(()));
        assert!(p.is_pending() && p.is_capturing() && !p.is_active());
        assert_eq!(p.pending_deadline(), Some(ms(t0, 350)));
        // Short of the push, with a little sideways wobble: nothing yet.
        p.motion(3.0, 20.0);
        assert_eq!(p.frame(ms(t0, 10)), FrameOutcome::default());
        p.motion(-1.0, 19.5);
        assert_eq!(p.frame(ms(t0, 20)), FrameOutcome::default());
        assert!(p.is_pending());
        // 40.5 down, 2 right: commits at the hand's x, just below the top.
        p.motion(0.0, 1.0);
        let out = p.frame(ms(t0, 30));
        assert!(out.entered);
        assert_eq!(out.release, None);
        let x = map().enter_x(Some(282.0));
        assert_eq!(out.msgs, [AgentMsg::Enter { x, y: 24.5 }]);
        assert!(p.is_active() && !p.is_pending());
        assert_eq!(p.pending_deadline(), None);
        // The deadline no longer applies once entered.
        assert_eq!(p.timeout(ms(t0, 1000)), None);
        assert!(p.is_active());
    }

    #[test]
    fn commit_point_is_inset_and_scaled_by_gain() {
        let mut p = hub_with_gain(2.0);
        assert_eq!(enter(&mut p, None, 0.0), (0.0, 24.0));
        // An overshoot within the committing frame carries on, gain scaled.
        let mut p = hub_with_gain(2.0);
        let t0 = Instant::now();
        p.activate(None, Some((140.0, 1028.0)), t0).unwrap();
        p.motion(10.0, 50.0);
        let out = p.frame(ms(t0, 5));
        let x = map().enter_x(Some(150.0));
        assert_eq!(out.msgs, [AgentMsg::Enter { x, y: 44.0 }]);
        // A huge push clamps to the last row.
        let mut p = hub_with_gain(2.0);
        p.activate(None, Some((140.0, 1028.0)), t0).unwrap();
        p.motion(0.0, 5000.0);
        assert_eq!(
            p.frame(ms(t0, 5)).msgs,
            [AgentMsg::Enter { x: 320.0, y: 799.0 }]
        );
        // Unknown activation x enters in the middle.
        let mut p = hub();
        p.activate(None, None, t0).unwrap();
        p.motion(0.0, 40.0);
        assert_eq!(
            p.frame(ms(t0, 5)).msgs,
            [AgentMsg::Enter { x: 640.0, y: 24.0 }]
        );
    }

    #[test]
    fn small_upward_jitter_after_entry_does_not_exit() {
        let mut p = hub();
        enter(&mut p, Some(1), 280.0);
        p.motion(0.0, -20.0);
        let out = p.frame(Instant::now());
        assert_eq!(out.msgs, [AgentMsg::Move { x: 640.0, y: 4.0 }]);
        assert!(p.is_active());
    }

    #[test]
    fn sliding_sideways_along_the_edge_aborts() {
        let mut p = hub();
        let t0 = Instant::now();
        p.activate(Some(2), Some((300.0, 1028.0)), t0).unwrap();
        p.motion(25.0, 10.0);
        assert_eq!(p.frame(ms(t0, 10)), FrameOutcome::default());
        p.motion(15.0, 5.0);
        let out = p.frame(ms(t0, 20));
        assert!(out.msgs.is_empty() && !out.entered);
        assert_eq!(
            aborted(&out),
            Some((Some((340.0, 1026.0)), Abort::Sideways))
        );
        assert_eq!(out.release.unwrap().0.activation_id, Some(2));
        assert!(!p.is_capturing());
        // To the left as well, clamped into the zone.
        let mut p = hub();
        p.activate(None, Some((10.0, 1028.0)), t0).unwrap();
        p.motion(-40.0, 0.0);
        assert_eq!(
            aborted(&p.frame(ms(t0, 5))),
            Some((Some((0.0, 1026.0)), Abort::Sideways))
        );
        // Diagonal but mostly down, past the push in one frame: enters.
        let mut p = hub();
        p.activate(None, Some((10.0, 1028.0)), t0).unwrap();
        p.motion(45.0, 50.0);
        assert!(p.frame(ms(t0, 5)).entered);
    }

    #[test]
    fn moving_back_up_aborts() {
        let mut p = hub();
        let t0 = Instant::now();
        p.activate(Some(3), Some((200.0, 1028.0)), t0).unwrap();
        p.motion(0.0, 10.0);
        p.frame(ms(t0, 5));
        p.motion(0.0, -14.0);
        assert_eq!(p.frame(ms(t0, 10)), FrameOutcome::default());
        p.motion(2.0, -0.5);
        let out = p.frame(ms(t0, 15));
        assert!(out.msgs.is_empty());
        assert_eq!(aborted(&out), Some((Some((202.0, 1026.0)), Abort::BackUp)));
        assert!(!p.is_capturing());
    }

    #[test]
    fn pending_push_times_out() {
        let mut p = hub();
        let t0 = Instant::now();
        p.activate(Some(4), Some((100.0, 1028.0)), t0).unwrap();
        p.motion(5.0, 30.0);
        p.frame(ms(t0, 100));
        assert_eq!(p.timeout(ms(t0, 349)), None);
        assert!(p.is_pending());
        assert_eq!(
            p.timeout(ms(t0, 350)),
            Some(ReleaseTo {
                activation_id: Some(4),
                cursor: Some((105.0, 1026.0)),
            })
        );
        assert!(!p.is_capturing());
        assert_eq!(p.timeout(ms(t0, 400)), None);

        // A frame that arrives after the deadline aborts even if it would
        // have committed.
        let mut p = hub();
        p.activate(None, Some((100.0, 1028.0)), t0).unwrap();
        p.motion(0.0, 100.0);
        let out = p.frame(ms(t0, 360));
        assert!(!out.entered && out.msgs.is_empty());
        assert_eq!(aborted(&out).map(|a| a.1), Some(Abort::Timeout));
    }

    #[test]
    fn buttons_and_wheel_while_pending_abort() {
        let t0 = Instant::now();
        for input in [
            (|p: &mut Pointer| p.button(0x110, true)) as fn(&mut Pointer),
            |p| p.button(0x113, true), // a side button the page has no name for
            |p| p.scroll(0.0, 3.0),
            |p| p.scroll_discrete(0, 120),
        ] {
            let mut p = hub();
            p.activate(Some(6), Some((50.0, 1028.0)), t0).unwrap();
            p.motion(0.0, 45.0);
            input(&mut p);
            let out = p.frame(ms(t0, 5));
            assert!(out.msgs.is_empty() && !out.entered, "{out:?}");
            assert_eq!(aborted(&out), Some((Some((50.0, 1026.0)), Abort::Input)));
            assert!(!p.is_capturing());
        }
    }

    #[test]
    fn motion_moves_clamps_and_sends_once_per_frame() {
        let mut p = hub();
        enter(&mut p, Some(5), 280.0);
        let now = Instant::now();
        p.motion(-10.0, 5.0);
        p.motion(-10.0, 100.0);
        let out = p.frame(now);
        assert_eq!(out.msgs, [AgentMsg::Move { x: 620.0, y: 129.0 }]);
        assert_eq!(out.release, None);

        p.motion(659.0, 5000.0);
        assert_eq!(
            p.frame(now).msgs,
            [AgentMsg::Move {
                x: 1279.0,
                y: 799.0
            }]
        );
        // Pushing further against the bottom wall sends nothing.
        p.motion(0.0, 1.0);
        assert_eq!(p.frame(now), FrameOutcome::default());
        assert!(p.is_active());
    }

    #[test]
    fn gain_scales_motion() {
        let mut p = hub_with_gain(2.0);
        enter(&mut p, None, 280.0);
        p.motion(-10.0, 3.0);
        assert_eq!(
            p.frame(Instant::now()).msgs,
            [AgentMsg::Move { x: 620.0, y: 30.0 }]
        );
    }

    #[test]
    fn leaving_the_top_releases_at_matching_x() {
        let mut p = hub();
        enter(&mut p, Some(9), 280.0);
        let now = Instant::now();
        p.motion(320.0, 50.0);
        p.frame(now);
        // Sideways motion in the same frame still counts toward the exit x.
        p.motion(0.0, -74.0);
        assert_eq!(p.frame(now).msgs, [AgentMsg::Move { x: 960.0, y: 0.0 }]);
        p.motion(-320.0, -0.5);
        p.button(0x110, true);
        let out = p.frame(now);
        assert_eq!(out.msgs, [AgentMsg::Leave]);
        assert_eq!(
            out.release,
            Some((
                ReleaseTo {
                    activation_id: Some(9),
                    cursor: Some((280.0, 1026.0)),
                },
                Ended::Exit(Exit::Top)
            ))
        );
        assert!(!p.is_capturing());
        // Later events of the same capture are dropped.
        p.motion(-5.0, 0.0);
        assert_eq!(p.frame(now), FrameOutcome::default());
    }

    #[test]
    fn leaving_the_left_edge_returns_to_the_corner() {
        let mut p = hub();
        enter(&mut p, Some(7), 0.0);
        let now = Instant::now();
        p.motion(0.0, 300.0);
        p.frame(now);
        // The first column is still inside.
        assert!(p.frame(now).release.is_none());
        p.motion(-0.01, 0.0);
        let out = p.frame(now);
        assert_eq!(out.msgs, [AgentMsg::Leave]);
        assert_eq!(
            out.release,
            Some((
                ReleaseTo {
                    activation_id: Some(7),
                    cursor: Some((2.0, 1026.0)),
                },
                Ended::Exit(Exit::Left)
            ))
        );
        assert!(!p.is_capturing());
    }

    #[test]
    fn leaving_the_right_edge_returns_past_the_hub() {
        let mut p = hub();
        enter(&mut p, Some(8), 280.0);
        let now = Instant::now();
        p.motion(639.0, 0.0);
        assert_eq!(p.frame(now).msgs, [AgentMsg::Move { x: 1279.0, y: 24.0 }]);
        // The last column is still inside: a push short of one more px
        // stays clamped there.
        p.motion(0.5, 0.0);
        assert_eq!(p.frame(now), FrameOutcome::default());
        p.motion(1.0, 0.0);
        let out = p.frame(now);
        assert_eq!(out.msgs, [AgentMsg::Leave]);
        assert_eq!(
            out.release,
            Some((
                ReleaseTo {
                    activation_id: Some(8),
                    cursor: Some((562.0, 1026.0)),
                },
                Ended::Exit(Exit::Right)
            ))
        );
        // Out through the top-left corner counts as the top.
        let mut p = hub();
        enter(&mut p, None, 0.0);
        p.motion(-5.0, -30.0);
        let out = p.frame(now);
        assert_eq!(out.release.map(|r| r.1), Some(Ended::Exit(Exit::Top)));
        assert_eq!(out.release.unwrap().0.cursor, Some((0.0, 1026.0)));
    }

    #[test]
    fn bottom_is_a_wall() {
        let mut p = hub();
        enter(&mut p, Some(1), 0.0);
        let now = Instant::now();
        p.motion(100.0, 10000.0);
        let out = p.frame(now);
        assert_eq!(out.msgs, [AgentMsg::Move { x: 100.0, y: 799.0 }]);
        assert!(out.release.is_none());
        p.motion(0.0, 10000.0);
        assert_eq!(p.frame(now), FrameOutcome::default());
        p.motion(0.0, -799.0);
        assert!(p.frame(now).release.is_none());
        p.motion(0.0, -0.01);
        assert!(p.frame(now).release.is_some());
    }

    #[test]
    fn buttons_and_wheel_report_at_cursor() {
        let mut p = hub();
        enter(&mut p, None, 0.0);
        let now = Instant::now();
        p.motion(1200.0, 676.0);
        p.button(0x110, true);
        p.button(0x111, false);
        p.button(0x113, true);
        let out = p.frame(now);
        assert_eq!(
            out.msgs,
            [
                AgentMsg::Move {
                    x: 1200.0,
                    y: 700.0
                },
                AgentMsg::Button {
                    button: ButtonName::Left,
                    down: true,
                    x: 1200.0,
                    y: 700.0
                },
                AgentMsg::Button {
                    button: ButtonName::Right,
                    down: false,
                    x: 1200.0,
                    y: 700.0
                },
            ]
        );

        p.scroll(0.0, 7.5);
        assert_eq!(
            p.frame(now).msgs,
            [AgentMsg::Wheel {
                dx: 0.0,
                dy: 7.5,
                x: 1200.0,
                y: 700.0
            }]
        );
        p.scroll(0.0, 15.0);
        p.scroll_discrete(0, -120);
        assert_eq!(
            p.frame(now).msgs,
            [AgentMsg::Wheel {
                dx: 0.0,
                dy: -48.0,
                x: 1200.0,
                y: 700.0
            }]
        );
    }

    #[test]
    fn activation_without_page_geometry_is_refused() {
        let mut p = Pointer::new(1.0, HUB_WIDTH, RULE);
        p.set_zone(Some(MONITOR));
        assert_eq!(
            p.activate(Some(1), Some((100.0, 1028.0)), Instant::now()),
            Err(ReleaseTo {
                activation_id: Some(1),
                cursor: None
            })
        );
        assert!(!p.is_capturing());
    }

    #[test]
    fn events_outside_capture_are_dropped() {
        let mut p = hub();
        let now = Instant::now();
        p.motion(-5.0, 0.0);
        p.button(0x110, true);
        assert_eq!(p.frame(now), FrameOutcome::default());
        // Stale accumulation does not leak into the next capture.
        p.motion(0.0, 500.0);
        p.button(0x110, true);
        p.activate(None, Some((0.0, 1028.0)), now).unwrap();
        assert_eq!(p.frame(now), FrameOutcome::default());
        assert!(p.is_pending());
    }

    #[test]
    fn end_and_deactivate() {
        let mut p = hub();
        let now = Instant::now();
        assert_eq!(p.end(), None);
        enter(&mut p, Some(3), 140.0);
        assert_eq!(
            p.end(),
            Some(ReleaseTo {
                activation_id: Some(3),
                cursor: Some((140.0, 1026.0)),
            })
        );
        // A pending push ends where the hand went, and needs no `leave`.
        p.activate(Some(4), Some((140.0, 1028.0)), now).unwrap();
        p.motion(-12.0, 5.0);
        p.frame(now);
        assert!(!p.is_active());
        assert_eq!(
            p.end(),
            Some(ReleaseTo {
                activation_id: Some(4),
                cursor: Some((128.0, 1026.0)),
            })
        );

        enter(&mut p, Some(4), 0.0);
        assert!(!p.deactivated(Some(3)));
        assert!(p.is_active());
        assert!(p.deactivated(Some(4)));
        assert!(!p.deactivated(Some(4)));
        enter(&mut p, None, 0.0);
        assert!(p.deactivated(Some(8)));
        // Deactivated while pending: cleared, but the page saw nothing.
        p.activate(Some(5), None, now).unwrap();
        assert!(!p.deactivated(Some(4)));
        assert!(p.is_pending());
        assert!(!p.deactivated(Some(5)));
        assert!(!p.is_capturing());
    }

    #[test]
    fn resize_pulls_cursor_inside() {
        let mut p = hub();
        enter(&mut p, None, 0.0);
        p.motion(1279.0, 799.0);
        p.frame(Instant::now());
        assert_eq!(
            p.set_viewport(Some((800.0, 600.0))),
            Some(AgentMsg::Move { x: 799.0, y: 599.0 })
        );
        assert_eq!(p.set_viewport(Some((1280.0, 800.0))), None);
    }
}
