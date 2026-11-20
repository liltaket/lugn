//! Pure capture logic: barrier placement, desktop <-> Hub coordinate mapping
//! and the per-libei-frame state machine.

use crate::protocol::{AgentMsg, ButtonName};

/// Desktop px per wheel notch; libei reports 120 units per notch.
const NOTCH_PX: f64 = 48.0;
const DISCRETE_PER_NOTCH: f64 = 120.0;
/// How far above the monitor's bottom edge the pointer comes back, so it does
/// not immediately hit the barrier again.
const RETURN_INSET: f64 = 2.0;

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
    /// The cursor enters on the Hub's top row.
    pub fn enter_point(&self, cursor_x: Option<f64>) -> (f64, f64) {
        let x = match cursor_x {
            Some(cx) => (cx - self.zone.x as f64) * self.w / self.hub_width,
            None => self.w / 2.0,
        };
        (x.clamp(0.0, self.w - 1.0), 0.0)
    }

    /// Where the desktop pointer comes back when the cursor leaves the Hub's
    /// top at `hub_x`: just above the monitor's bottom edge, at the matching x.
    pub fn return_point(&self, hub_x: f64) -> (f64, f64) {
        let left = self.zone.x as f64;
        let x = left + hub_x * self.hub_width / self.w;
        let y = self.zone.bottom() as f64 - 1.0 - RETURN_INSET;
        (
            x.clamp(left, self.zone.right() as f64 - 1.0),
            y.max(self.zone.y as f64),
        )
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
struct FrameAcc {
    dx: f64,
    dy: f64,
    buttons: Vec<(ButtonName, bool)>,
    scroll: (f64, f64),
    discrete: (i32, i32),
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Active {
    activation_id: Option<u32>,
    x: f64,
    y: f64,
}

/// What the caller must do to end a capture with the compositor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReleaseTo {
    pub activation_id: Option<u32>,
    /// Desktop position to put the pointer back at, if known.
    pub cursor: Option<(f64, f64)>,
}

#[derive(Debug, Default, PartialEq)]
pub struct FrameOutcome {
    pub msgs: Vec<AgentMsg>,
    /// Set when the pointer left the Hub's top; `msgs` then ends with
    /// `leave` and the caller must Release.
    pub release: Option<ReleaseTo>,
}

/// Capture state. The compositor decides when capture starts (Activated);
/// this decides when it ends on our side.
#[derive(Debug)]
pub struct Pointer {
    gain: f64,
    hub_width: f64,
    zone: Option<Zone>,
    viewport: Option<(f64, f64)>,
    active: Option<Active>,
    frame: FrameAcc,
}

impl Pointer {
    pub fn new(gain: f64, hub_width: f64) -> Self {
        Self {
            gain,
            hub_width,
            zone: None,
            viewport: None,
            active: None,
            frame: FrameAcc::default(),
        }
    }

    pub fn is_active(&self) -> bool {
        self.active.is_some()
    }

    pub fn set_zone(&mut self, zone: Option<Zone>) {
        self.zone = zone;
    }

    /// Returns a `move` if a resize pulled an active cursor back inside.
    pub fn set_viewport(&mut self, viewport: Option<(f64, f64)>) -> Option<AgentMsg> {
        self.viewport = viewport;
        let (w, h) = viewport?;
        let a = self.active.as_mut()?;
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

    /// Handles the compositor's Activated signal. `Err` means there is no
    /// page geometry to show a cursor on, so the caller must release at once.
    pub fn activate(
        &mut self,
        activation_id: Option<u32>,
        cursor: Option<(f64, f64)>,
    ) -> Result<AgentMsg, ReleaseTo> {
        self.frame = FrameAcc::default();
        let Some(map) = self.mapping() else {
            self.active = None;
            return Err(ReleaseTo {
                activation_id,
                cursor: None,
            });
        };
        let (x, y) = map.enter_point(cursor.map(|c| c.0));
        self.active = Some(Active {
            activation_id,
            x,
            y,
        });
        Ok(AgentMsg::Enter { x, y })
    }

    /// The compositor ended capture itself. Returns whether we were active
    /// (and so the page needs a `leave`). A mismatched activation id belongs
    /// to an older capture and is ignored.
    pub fn deactivated(&mut self, activation_id: Option<u32>) -> bool {
        match (self.active, activation_id) {
            (Some(a), Some(id)) if a.activation_id.is_some_and(|own| own != id) => false,
            (Some(_), _) => {
                self.active = None;
                true
            }
            (None, _) => false,
        }
    }

    /// Ends capture from our side (disconnect, timeout, shutdown).
    pub fn end(&mut self) -> Option<ReleaseTo> {
        let a = self.active.take()?;
        let cursor = self.mapping().map(|m| m.return_point(a.x));
        Some(ReleaseTo {
            activation_id: a.activation_id,
            cursor,
        })
    }

    pub fn motion(&mut self, dx: f64, dy: f64) {
        self.frame.dx += dx;
        self.frame.dy += dy;
    }

    pub fn button(&mut self, evdev_code: u32, down: bool) {
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
    pub fn frame(&mut self) -> FrameOutcome {
        let f = std::mem::take(&mut self.frame);
        let mut out = FrameOutcome::default();
        let (Some(map), Some(a)) = (self.mapping(), self.active.as_mut()) else {
            return out;
        };

        if f.dx != 0.0 || f.dy != 0.0 {
            let nx = (a.x + f.dx * self.gain).clamp(0.0, map.w - 1.0);
            let ny = (a.y + f.dy * self.gain).min(map.h - 1.0);
            if ny < 0.0 {
                // Out through the top, anywhere along it: back to the desktop.
                let release = ReleaseTo {
                    activation_id: a.activation_id,
                    cursor: Some(map.return_point(nx)),
                };
                self.active = None;
                out.msgs.push(AgentMsg::Leave);
                out.release = Some(release);
                return out;
            }
            if (nx, ny) != (a.x, a.y) {
                (a.x, a.y) = (nx, ny);
                out.msgs.push(AgentMsg::Move { x: nx, y: ny });
            }
        }

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

    fn hub() -> Pointer {
        let mut p = Pointer::new(1.0, HUB_WIDTH);
        p.set_zone(Some(MONITOR));
        p.set_viewport(Some((1280.0, 800.0)));
        p
    }

    fn map() -> Mapping {
        Mapping {
            zone: MONITOR,
            hub_width: HUB_WIDTH,
            w: 1280.0,
            h: 800.0,
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
        let reach = 560 + 160;
        assert!(in_entry_zone(MONITOR, reach, Some(0.0)));
        assert!(in_entry_zone(MONITOR, reach, Some(300.5)));
        assert!(in_entry_zone(MONITOR, reach, Some(720.0)));
        assert!(!in_entry_zone(MONITOR, reach, Some(720.5)));
        assert!(!in_entry_zone(MONITOR, reach, Some(2000.0)));
        assert!(in_entry_zone(MONITOR, reach, None));
        let offset = Zone { x: 1000, ..MONITOR };
        assert!(!in_entry_zone(offset, reach, Some(999.0)));
        assert!(in_entry_zone(offset, reach, Some(1720.0)));
        assert!(!in_entry_zone(offset, reach, Some(1721.0)));
    }

    #[test]
    fn enter_maps_x_along_the_hub_width() {
        let m = map();
        assert_eq!(m.enter_point(Some(0.0)), (0.0, 0.0));
        assert_eq!(m.enter_point(Some(280.0)), (640.0, 0.0));
        assert_eq!(m.enter_point(Some(140.0)), (320.0, 0.0));
        // The slack past the Hub's right edge clamps to its last column.
        assert_eq!(m.enter_point(Some(600.0)), (1279.0, 0.0));
        assert_eq!(m.enter_point(Some(720.0)), (1279.0, 0.0));
        assert_eq!(m.enter_point(None), (640.0, 0.0));
        let offset = Mapping {
            zone: Zone { x: -500, ..MONITOR },
            ..m
        };
        assert_eq!(offset.enter_point(Some(-220.0)), (640.0, 0.0));
    }

    #[test]
    fn return_inverts_enter() {
        let m = map();
        for cx in [0.0, 1.0, 100.25, 280.0, 559.0] {
            let (hx, _) = m.enter_point(Some(cx));
            let (rx, ry) = m.return_point(hx);
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
    }

    #[test]
    fn enters_at_the_top_row() {
        let mut p = hub();
        assert_eq!(
            p.activate(Some(5), Some((280.0, 1028.0))),
            Ok(AgentMsg::Enter { x: 640.0, y: 0.0 })
        );
        assert!(p.is_active());
    }

    #[test]
    fn motion_moves_clamps_and_sends_once_per_frame() {
        let mut p = hub();
        p.activate(Some(5), Some((280.0, 1028.0))).unwrap();
        p.motion(-10.0, 5.0);
        p.motion(-10.0, 100.0);
        let out = p.frame();
        assert_eq!(out.msgs, [AgentMsg::Move { x: 620.0, y: 105.0 }]);
        assert_eq!(out.release, None);

        p.motion(5000.0, 5000.0);
        assert_eq!(
            p.frame().msgs,
            [AgentMsg::Move {
                x: 1279.0,
                y: 799.0
            }]
        );
        // Pushing further against a clamped corner sends nothing.
        p.motion(1.0, 1.0);
        assert_eq!(p.frame(), FrameOutcome::default());
        // Left and right edges clamp; they do not end capture.
        p.motion(-5000.0, 0.0);
        assert_eq!(p.frame().msgs, [AgentMsg::Move { x: 0.0, y: 799.0 }]);
        assert!(p.is_active());
    }

    #[test]
    fn gain_scales_motion() {
        let mut p = Pointer::new(2.0, HUB_WIDTH);
        p.set_zone(Some(MONITOR));
        p.set_viewport(Some((1280.0, 800.0)));
        p.activate(None, Some((280.0, 1028.0))).unwrap();
        p.motion(-10.0, 3.0);
        assert_eq!(p.frame().msgs, [AgentMsg::Move { x: 620.0, y: 6.0 }]);
    }

    #[test]
    fn leaving_the_top_releases_at_matching_x() {
        let mut p = hub();
        p.activate(Some(9), Some((280.0, 1028.0))).unwrap();
        p.motion(320.0, 50.0);
        p.frame();
        // Sideways motion in the same frame still counts toward the exit x.
        p.motion(0.0, -50.0);
        assert_eq!(p.frame().msgs, [AgentMsg::Move { x: 960.0, y: 0.0 }]);
        p.motion(-320.0, -0.5);
        p.button(0x110, true);
        let out = p.frame();
        assert_eq!(out.msgs, [AgentMsg::Leave]);
        assert_eq!(
            out.release,
            Some(ReleaseTo {
                activation_id: Some(9),
                cursor: Some((280.0, 1026.0)),
            })
        );
        assert!(!p.is_active());
        // Later events of the same capture are dropped.
        p.motion(-5.0, 0.0);
        assert_eq!(p.frame(), FrameOutcome::default());
    }

    #[test]
    fn exit_is_only_through_the_top() {
        let mut p = hub();
        p.activate(Some(1), Some((0.0, 1028.0))).unwrap();
        p.motion(-100.0, 0.0);
        assert_eq!(p.frame(), FrameOutcome::default());
        p.motion(10000.0, 10000.0);
        assert!(p.frame().release.is_none());
        p.motion(0.0, -799.0);
        assert!(p.frame().release.is_none());
        p.motion(0.0, -0.01);
        assert!(p.frame().release.is_some());
    }

    #[test]
    fn buttons_and_wheel_report_at_cursor() {
        let mut p = hub();
        p.activate(None, Some((0.0, 1028.0))).unwrap();
        p.motion(1200.0, 700.0);
        p.button(0x110, true);
        p.button(0x111, false);
        p.button(0x113, true);
        let out = p.frame();
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
            p.frame().msgs,
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
            p.frame().msgs,
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
        let mut p = Pointer::new(1.0, HUB_WIDTH);
        p.set_zone(Some(MONITOR));
        assert_eq!(
            p.activate(Some(1), Some((100.0, 1028.0))),
            Err(ReleaseTo {
                activation_id: Some(1),
                cursor: None
            })
        );
        assert!(!p.is_active());
    }

    #[test]
    fn events_outside_capture_are_dropped() {
        let mut p = hub();
        p.motion(-5.0, 0.0);
        p.button(0x110, true);
        assert_eq!(p.frame(), FrameOutcome::default());
        // Stale accumulation does not leak into the next capture.
        p.motion(-5.0, 0.0);
        p.activate(None, Some((0.0, 1028.0))).unwrap();
        assert_eq!(p.frame(), FrameOutcome::default());
    }

    #[test]
    fn end_and_deactivate() {
        let mut p = hub();
        assert_eq!(p.end(), None);
        p.activate(Some(3), Some((140.0, 1028.0))).unwrap();
        assert_eq!(
            p.end(),
            Some(ReleaseTo {
                activation_id: Some(3),
                cursor: Some((140.0, 1026.0)),
            })
        );

        p.activate(Some(4), Some((0.0, 1028.0))).unwrap();
        assert!(!p.deactivated(Some(3)));
        assert!(p.is_active());
        assert!(p.deactivated(Some(4)));
        assert!(!p.deactivated(Some(4)));
        p.activate(None, Some((0.0, 1028.0))).unwrap();
        assert!(p.deactivated(Some(8)));
    }

    #[test]
    fn resize_pulls_cursor_inside() {
        let mut p = hub();
        p.activate(None, Some((0.0, 1028.0))).unwrap();
        p.motion(1279.0, 799.0);
        p.frame();
        assert_eq!(
            p.set_viewport(Some((800.0, 600.0))),
            Some(AgentMsg::Move { x: 799.0, y: 599.0 })
        );
        assert_eq!(p.set_viewport(Some((1280.0, 800.0))), None);
    }
}
