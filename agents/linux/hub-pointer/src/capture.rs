//! Pure capture logic: barrier placement, desktop <-> Hub coordinate mapping
//! and the per-libei-frame state machine.

use crate::protocol::{AgentMsg, ButtonName};

/// Desktop px per wheel notch; libei reports 120 units per notch.
const NOTCH_PX: f64 = 48.0;
const DISCRETE_PER_NOTCH: f64 = 120.0;
/// How far inside the monitor's left edge the pointer comes back, so it does
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
}

/// The monitor the Hub stands next to: the leftmost zone, and the lowest of
/// those if several share that x.
pub fn leftmost_zone(zones: &[Zone]) -> Option<Zone> {
    zones
        .iter()
        .copied()
        .min_by_key(|z| (z.x, std::cmp::Reverse(z.bottom())))
}

/// Vertical barriers on the zone's whole left edge, most likely first. KDE
/// rejects a barrier that does not fill the edge ("doesnt fill or on edge to
/// another screen"), so the lower entry zone is enforced on activation
/// instead (see [`in_entry_zone`]). Whether the end point is the last row or
/// one past it is not documented, so the caller tries both.
pub fn barrier_lines(zone: Zone) -> [(i32, i32, i32, i32); 2] {
    [
        (zone.x, zone.y, zone.x, zone.bottom() - 1),
        (zone.x, zone.y, zone.x, zone.bottom()),
    ]
}

/// Whether an activation at `cursor_y` lies in the bottom `zone_height` rows
/// of the left edge, the part level with the Hub. Unknown positions count as
/// inside, so a missing hint never blocks entry.
pub fn in_entry_zone(zone: Zone, zone_height: u32, cursor_y: Option<f64>) -> bool {
    let top = (zone.bottom() - zone_height.min(zone.height) as i32).max(zone.y);
    cursor_y.is_none_or(|y| y >= f64::from(top))
}

/// Maps between the zone's left edge and the Hub viewport. The Hub's bottom
/// edge is level with the monitor's bottom edge, so heights are measured up
/// from the bottom on both sides.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mapping {
    pub zone: Zone,
    pub gain: f64,
    pub w: f64,
    pub h: f64,
}

impl Mapping {
    pub fn enter_point(&self, cursor_y: Option<f64>) -> (f64, f64) {
        let y = match cursor_y {
            Some(cy) => self.h - 1.0 - (self.zone.bottom() as f64 - 1.0 - cy) * self.gain,
            None => self.h / 2.0,
        };
        (self.w - 1.0, y.clamp(0.0, self.h - 1.0))
    }

    pub fn return_point(&self, hub_y: f64) -> (f64, f64) {
        let bottom = self.zone.bottom() as f64 - 1.0;
        let y = bottom - (self.h - 1.0 - hub_y) / self.gain;
        (
            self.zone.x as f64 + RETURN_INSET,
            y.clamp(self.zone.y as f64, bottom),
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
    /// Set when the pointer left the Hub on the right; `msgs` then ends with
    /// `leave` and the caller must Release.
    pub release: Option<ReleaseTo>,
}

/// Capture state. The compositor decides when capture starts (Activated);
/// this decides when it ends on our side.
#[derive(Debug)]
pub struct Pointer {
    gain: f64,
    zone: Option<Zone>,
    viewport: Option<(f64, f64)>,
    active: Option<Active>,
    frame: FrameAcc,
}

impl Pointer {
    pub fn new(gain: f64) -> Self {
        Self {
            gain,
            zone: None,
            viewport: None,
            active: None,
            frame: FrameAcc::default(),
        }
    }

    #[cfg(test)]
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
            gain: self.gain,
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
        let (x, y) = map.enter_point(cursor.map(|c| c.1));
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
        let cursor = self.mapping().map(|m| m.return_point(a.y));
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
            let nx = a.x + f.dx * self.gain;
            let ny = (a.y + f.dy * self.gain).clamp(0.0, map.h - 1.0);
            if nx >= map.w {
                let release = ReleaseTo {
                    activation_id: a.activation_id,
                    cursor: Some(map.return_point(ny)),
                };
                self.active = None;
                out.msgs.push(AgentMsg::Leave);
                out.release = Some(release);
                return out;
            }
            let nx = nx.max(0.0);
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
        width: 3658,
        height: 1029,
    };

    fn hub() -> Pointer {
        let mut p = Pointer::new(1.0);
        p.set_zone(Some(MONITOR));
        p.set_viewport(Some((1280.0, 800.0)));
        p
    }

    #[test]
    fn picks_leftmost_then_lowest_zone() {
        let right = Zone {
            x: 3658,
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
    fn barriers_fill_the_left_edge() {
        assert_eq!(barrier_lines(MONITOR), [(0, 0, 0, 1028), (0, 0, 0, 1029)]);
        let offset = Zone {
            x: -100,
            y: 50,
            width: 100,
            height: 200,
        };
        assert_eq!(barrier_lines(offset)[0], (-100, 50, -100, 249));
    }

    #[test]
    fn entry_zone_is_the_bottom_of_the_edge() {
        assert!(in_entry_zone(MONITOR, 420, Some(1028.0)));
        assert!(in_entry_zone(MONITOR, 420, Some(609.0)));
        assert!(!in_entry_zone(MONITOR, 420, Some(608.9)));
        assert!(!in_entry_zone(MONITOR, 420, Some(0.0)));
        assert!(in_entry_zone(MONITOR, 420, None));
        // Taller than the monitor: the whole edge.
        assert!(in_entry_zone(MONITOR, 5000, Some(0.0)));
    }

    #[test]
    fn enter_maps_height_from_bottom() {
        let map = Mapping {
            zone: MONITOR,
            gain: 1.0,
            w: 1280.0,
            h: 800.0,
        };
        assert_eq!(map.enter_point(Some(1028.0)), (1279.0, 799.0));
        assert_eq!(map.enter_point(Some(828.0)), (1279.0, 599.0));
        // Above the Hub's height clamps to its top row.
        assert_eq!(map.enter_point(Some(100.0)), (1279.0, 0.0));
        assert_eq!(map.enter_point(None), (1279.0, 400.0));
        let fast = Mapping { gain: 2.0, ..map };
        assert_eq!(fast.enter_point(Some(928.0)), (1279.0, 599.0));
    }

    #[test]
    fn return_inverts_enter() {
        for gain in [0.5, 1.0, 1.7] {
            let map = Mapping {
                zone: MONITOR,
                gain,
                w: 1280.0,
                h: 800.0,
            };
            for cy in [1028.0, 900.5, 700.0] {
                let (_, hy) = map.enter_point(Some(cy));
                let (rx, ry) = map.return_point(hy);
                assert_eq!(rx, 2.0);
                assert!((ry - cy).abs() < 1e-9, "gain {gain} cy {cy} -> {ry}");
            }
        }
        // A cursor at the Hub's top maps above the monitor's top: clamp.
        let map = Mapping {
            zone: MONITOR,
            gain: 0.5,
            w: 1280.0,
            h: 800.0,
        };
        assert_eq!(map.return_point(0.0), (2.0, 0.0));
    }

    #[test]
    fn motion_moves_clamps_and_sends_once_per_frame() {
        let mut p = hub();
        assert_eq!(
            p.activate(Some(5), Some((0.0, 1028.0))),
            Ok(AgentMsg::Enter {
                x: 1279.0,
                y: 799.0
            })
        );
        p.motion(-10.0, -5.0);
        p.motion(-10.0, 100.0);
        let out = p.frame();
        assert_eq!(
            out.msgs,
            [AgentMsg::Move {
                x: 1259.0,
                y: 799.0
            }]
        );
        assert_eq!(out.release, None);

        p.motion(-5000.0, -5000.0);
        assert_eq!(p.frame().msgs, [AgentMsg::Move { x: 0.0, y: 0.0 }]);
        // Pushing further against a clamped corner sends nothing.
        p.motion(-1.0, -1.0);
        assert_eq!(p.frame(), FrameOutcome::default());
        assert!(p.is_active());
    }

    #[test]
    fn gain_scales_motion() {
        let mut p = Pointer::new(2.0);
        p.set_zone(Some(MONITOR));
        p.set_viewport(Some((1280.0, 800.0)));
        p.activate(None, Some((0.0, 1028.0))).unwrap();
        p.motion(-10.0, -3.0);
        assert_eq!(
            p.frame().msgs,
            [AgentMsg::Move {
                x: 1259.0,
                y: 793.0
            }]
        );
    }

    #[test]
    fn leaving_right_releases_at_matching_height() {
        let mut p = hub();
        p.activate(Some(9), Some((0.0, 828.0))).unwrap();
        p.motion(-100.0, 0.0);
        p.frame();
        p.motion(101.0, -50.0);
        p.button(0x110, true);
        let out = p.frame();
        assert_eq!(out.msgs, [AgentMsg::Leave]);
        assert_eq!(
            out.release,
            Some(ReleaseTo {
                activation_id: Some(9),
                cursor: Some((2.0, 778.0)),
            })
        );
        assert!(!p.is_active());
        // Later events of the same capture are dropped.
        p.motion(-5.0, 0.0);
        assert_eq!(p.frame(), FrameOutcome::default());
    }

    #[test]
    fn buttons_and_wheel_report_at_cursor() {
        let mut p = hub();
        p.activate(None, Some((0.0, 1028.0))).unwrap();
        p.motion(-79.0, -99.0);
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
        let mut p = Pointer::new(1.0);
        p.set_zone(Some(MONITOR));
        assert_eq!(
            p.activate(Some(1), Some((0.0, 900.0))),
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
        p.activate(Some(3), Some((0.0, 1000.0))).unwrap();
        assert_eq!(
            p.end(),
            Some(ReleaseTo {
                activation_id: Some(3),
                cursor: Some((2.0, 1000.0)),
            })
        );

        p.activate(Some(4), Some((0.0, 1000.0))).unwrap();
        assert!(!p.deactivated(Some(3)));
        assert!(p.is_active());
        assert!(p.deactivated(Some(4)));
        assert!(!p.deactivated(Some(4)));
        p.activate(None, Some((0.0, 1000.0))).unwrap();
        assert!(p.deactivated(Some(8)));
    }

    #[test]
    fn resize_pulls_cursor_inside() {
        let mut p = hub();
        p.activate(None, Some((0.0, 1028.0))).unwrap();
        assert_eq!(
            p.set_viewport(Some((800.0, 600.0))),
            Some(AgentMsg::Move { x: 799.0, y: 599.0 })
        );
        assert_eq!(p.set_viewport(Some((1280.0, 800.0))), None);
    }
}
