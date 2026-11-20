//! JSON frames of wire protocol v2 (see PROTOCOL.md).

use serde::{Deserialize, Serialize};

/// `hello` versions we accept. v1 pages lack `perf` and ignore `warm`.
pub const VERSIONS: std::ops::RangeInclusive<u32> = 1..=2;
/// Largest viewport side we accept from a page, in CSS px.
const MAX_VIEWPORT: f64 = 16384.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ButtonName {
    Left,
    Right,
    Middle,
}

impl ButtonName {
    /// Linux `input-event-codes.h` codes, as libei reports them.
    pub fn from_evdev(code: u32) -> Option<Self> {
        match code {
            0x110 => Some(Self::Left),
            0x111 => Some(Self::Right),
            0x112 => Some(Self::Middle),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum AgentMsg {
    Enter {
        x: f64,
        y: f64,
    },
    Move {
        x: f64,
        y: f64,
    },
    Button {
        button: ButtonName,
        down: bool,
        x: f64,
        y: f64,
    },
    Wheel {
        dx: f64,
        dy: f64,
        x: f64,
        y: f64,
    },
    Leave,
    Warm {
        on: bool,
    },
    Ping {
        id: u64,
    },
}

impl AgentMsg {
    pub fn encode(&self) -> String {
        serde_json::to_string(&self.rounded()).expect("agent messages always serialize")
    }

    /// Hundredths of a CSS px are plenty and keep frames short.
    fn rounded(&self) -> Self {
        let r = |v: f64| (v * 100.0).round() / 100.0;
        match *self {
            Self::Enter { x, y } => Self::Enter { x: r(x), y: r(y) },
            Self::Move { x, y } => Self::Move { x: r(x), y: r(y) },
            Self::Button { button, down, x, y } => Self::Button {
                button,
                down,
                x: r(x),
                y: r(y),
            },
            Self::Wheel { dx, dy, x, y } => Self::Wheel {
                dx: r(dx),
                dy: r(dy),
                x: r(x),
                y: r(y),
            },
            Self::Leave => Self::Leave,
            Self::Warm { on } => Self::Warm { on },
            Self::Ping { id } => Self::Ping { id },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum RawPageMsg {
    Hello {
        v: u32,
        w: f64,
        h: f64,
    },
    Pong {
        id: u64,
    },
    Perf(Perf),
    #[serde(other)]
    Unknown,
}

/// The page's render telemetry (see PROTOCOL.md, Telemetry). Times in ms.
/// Missing fields count as 0.
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Perf {
    pub frames: f64,
    pub moves: f64,
    pub lag_p50: f64,
    pub lag_p95: f64,
    pub lag_max: f64,
    pub gap_max: f64,
    pub long_tasks: f64,
    pub long_task_ms: f64,
    pub span: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PageMsg {
    Hello { w: f64, h: f64 },
    Pong { id: u64 },
    Perf(Perf),
}

#[derive(Debug, PartialEq)]
pub enum DecodeError {
    Json(String),
    Version(u32),
    Viewport(f64, f64),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(e) => write!(f, "bad frame: {e}"),
            Self::Version(v) => write!(f, "unsupported protocol version {v}"),
            Self::Viewport(w, h) => write!(f, "bad viewport {w}x{h}"),
        }
    }
}

/// `Ok(None)` is a well-formed frame with an unknown `t`, which is ignored.
pub fn decode_page(text: &str) -> Result<Option<PageMsg>, DecodeError> {
    let raw: RawPageMsg =
        serde_json::from_str(text).map_err(|e| DecodeError::Json(e.to_string()))?;
    Ok(match raw {
        RawPageMsg::Hello { v, .. } if !VERSIONS.contains(&v) => {
            return Err(DecodeError::Version(v));
        }
        RawPageMsg::Hello { w, h, .. } => {
            let ok = |s: f64| s.is_finite() && (1.0..=MAX_VIEWPORT).contains(&s);
            if !ok(w) || !ok(h) {
                return Err(DecodeError::Viewport(w, h));
            }
            Some(PageMsg::Hello {
                w: w.floor(),
                h: h.floor(),
            })
        }
        RawPageMsg::Pong { id } => Some(PageMsg::Pong { id }),
        RawPageMsg::Perf(p) => Some(PageMsg::Perf(p)),
        RawPageMsg::Unknown => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_agent_messages() {
        assert_eq!(
            AgentMsg::Enter {
                x: 1279.0,
                y: 799.0
            }
            .encode(),
            r#"{"t":"enter","x":1279.0,"y":799.0}"#
        );
        assert_eq!(
            AgentMsg::Move {
                x: 10.123456,
                y: 0.5
            }
            .encode(),
            r#"{"t":"move","x":10.12,"y":0.5}"#
        );
        assert_eq!(
            AgentMsg::Button {
                button: ButtonName::Left,
                down: true,
                x: 1.0,
                y: 2.0
            }
            .encode(),
            r#"{"t":"button","button":"left","down":true,"x":1.0,"y":2.0}"#
        );
        assert_eq!(
            AgentMsg::Wheel {
                dx: 0.0,
                dy: -48.0,
                x: 3.0,
                y: 4.0
            }
            .encode(),
            r#"{"t":"wheel","dx":0.0,"dy":-48.0,"x":3.0,"y":4.0}"#
        );
        assert_eq!(AgentMsg::Leave.encode(), r#"{"t":"leave"}"#);
        assert_eq!(AgentMsg::Ping { id: 7 }.encode(), r#"{"t":"ping","id":7}"#);
        assert_eq!(
            AgentMsg::Warm { on: true }.encode(),
            r#"{"t":"warm","on":true}"#
        );
    }

    #[test]
    fn decodes_page_messages() {
        assert_eq!(
            decode_page(r#"{"t":"hello","v":1,"w":1280,"h":800,"extra":true}"#),
            Ok(Some(PageMsg::Hello {
                w: 1280.0,
                h: 800.0
            }))
        );
        assert_eq!(
            decode_page(r#"{"t":"hello","v":1,"w":1280.7,"h":800}"#),
            Ok(Some(PageMsg::Hello {
                w: 1280.0,
                h: 800.0
            }))
        );
        assert_eq!(
            decode_page(r#"{"t":"pong","id":42}"#),
            Ok(Some(PageMsg::Pong { id: 42 }))
        );
        assert_eq!(
            decode_page(r#"{"t":"hello","v":2,"w":1280,"h":800}"#),
            Ok(Some(PageMsg::Hello {
                w: 1280.0,
                h: 800.0
            }))
        );
        assert_eq!(decode_page(r#"{"t":"later","x":1}"#), Ok(None));
    }

    #[test]
    fn decodes_perf() {
        assert_eq!(
            decode_page(
                r#"{"t":"perf","frames":120,"moves":118,"lagP50":3.1,"lagP95":9.8,
                "lagMax":31,"gapMax":48,"longTasks":2,"longTaskMs":130,"span":2000,"x":1}"#
            ),
            Ok(Some(PageMsg::Perf(Perf {
                frames: 120.0,
                moves: 118.0,
                lag_p50: 3.1,
                lag_p95: 9.8,
                lag_max: 31.0,
                gap_max: 48.0,
                long_tasks: 2.0,
                long_task_ms: 130.0,
                span: 2000.0,
            })))
        );
        assert_eq!(
            decode_page(r#"{"t":"perf","moves":3}"#),
            Ok(Some(PageMsg::Perf(Perf {
                moves: 3.0,
                ..Perf::default()
            })))
        );
    }

    #[test]
    fn rejects_bad_page_messages() {
        assert!(matches!(decode_page("nope"), Err(DecodeError::Json(_))));
        assert!(matches!(
            decode_page(r#"{"id":1}"#),
            Err(DecodeError::Json(_))
        ));
        assert_eq!(
            decode_page(r#"{"t":"hello","v":3,"w":1280,"h":800}"#),
            Err(DecodeError::Version(3))
        );
        assert!(matches!(
            decode_page(r#"{"t":"hello","v":1,"w":0,"h":800}"#),
            Err(DecodeError::Viewport(..))
        ));
        assert!(matches!(
            decode_page(r#"{"t":"hello","v":1,"w":1280,"h":1e9}"#),
            Err(DecodeError::Viewport(..))
        ));
    }

    #[test]
    fn maps_evdev_buttons() {
        assert_eq!(ButtonName::from_evdev(0x110), Some(ButtonName::Left));
        assert_eq!(ButtonName::from_evdev(0x111), Some(ButtonName::Right));
        assert_eq!(ButtonName::from_evdev(0x112), Some(ButtonName::Middle));
        assert_eq!(ButtonName::from_evdev(0x113), None);
    }
}
