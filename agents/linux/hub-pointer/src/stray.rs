//! Spots captures nobody asked for.
//!
//! KWin keeps a barrier alive after the portal's `Disable`: a push against the
//! bottom edge still starts a capture (libei `start emulating`), but the
//! portal never sends `Activated` for it, so the agent does not know it holds
//! the pointer. The desktop pointer is then frozen and invisible until the
//! barrier is enabled again. The signature is a `start emulating` that no
//! `Activated` for the same sequence follows.

use std::time::Duration;

use tokio::time::Instant;

/// `Activated` normally arrives within a millisecond of `start emulating`;
/// this is how long to wait for it before calling the capture stray.
pub const GRACE: Duration = Duration::from_millis(250);

#[derive(Debug, Default)]
pub struct Stray {
    /// The activation the portal last announced; its `start emulating` may
    /// arrive after the signal and is not stray.
    announced: Option<u32>,
    /// A `start emulating` waiting for its `Activated`.
    waiting: Option<(u32, Instant)>,
}

impl Stray {
    /// libei says the compositor started sending events. `known` is true when
    /// the agent already holds a capture, which this belongs to.
    pub fn started(&mut self, sequence: u32, known: bool, now: Instant) {
        if known || self.announced == Some(sequence) {
            return;
        }
        self.waiting = Some((sequence, now + GRACE));
    }

    /// The portal announced an activation.
    pub fn activated(&mut self, id: Option<u32>) {
        self.announced = id;
        if let (Some((sequence, _)), Some(id)) = (self.waiting, id)
            && sequence == id
        {
            self.waiting = None;
        }
        // An activation without an id cannot be matched to a sequence; it is
        // the capture that is waiting.
        if id.is_none() {
            self.waiting = None;
        }
    }

    /// The compositor stopped sending events: nothing left to recover.
    pub fn stopped(&mut self) {
        self.waiting = None;
    }

    /// When the waiting capture counts as stray.
    pub fn deadline(&self) -> Option<Instant> {
        self.waiting.map(|(_, at)| at)
    }

    /// The stray capture's sequence once its grace has passed, taken once.
    pub fn take_due(&mut self, now: Instant) -> Option<u32> {
        match self.waiting {
            Some((sequence, at)) if now >= at => {
                self.waiting = None;
                Some(sequence)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(t0: Instant, ms: u64) -> Instant {
        t0 + Duration::from_millis(ms)
    }

    #[test]
    fn a_capture_nobody_announced_is_stray_after_the_grace() {
        let t0 = Instant::now();
        let mut s = Stray::default();
        s.started(7, false, t0);
        assert_eq!(s.deadline(), Some(at(t0, 250)));
        assert_eq!(s.take_due(at(t0, 100)), None);
        assert_eq!(s.take_due(at(t0, 250)), Some(7));
        assert_eq!(s.take_due(at(t0, 300)), None, "taken once");
    }

    #[test]
    fn activated_after_start_clears_it() {
        let t0 = Instant::now();
        let mut s = Stray::default();
        s.started(8, false, t0);
        s.activated(Some(8));
        assert_eq!(s.deadline(), None);
    }

    #[test]
    fn start_after_activated_is_not_stray() {
        let t0 = Instant::now();
        let mut s = Stray::default();
        s.activated(Some(9));
        s.started(9, false, t0);
        assert_eq!(s.deadline(), None);
    }

    #[test]
    fn a_held_capture_is_not_stray() {
        let t0 = Instant::now();
        let mut s = Stray::default();
        s.started(10, true, t0);
        assert_eq!(s.deadline(), None);
    }

    #[test]
    fn an_older_activation_does_not_clear_a_newer_stray_capture() {
        let t0 = Instant::now();
        let mut s = Stray::default();
        s.activated(Some(10));
        s.started(11, false, t0);
        assert_eq!(s.deadline(), Some(at(t0, 250)));
    }

    #[test]
    fn stopping_clears_it() {
        let t0 = Instant::now();
        let mut s = Stray::default();
        s.started(12, false, t0);
        s.stopped();
        assert_eq!(s.deadline(), None);
    }
}
