//! Rate limit for `move` frames: leading edge plus one trailing flush, so a
//! 1000 Hz mouse sends at most one `move` per [`MIN_INTERVAL`] without delaying
//! the first move after a pause.

use std::time::Duration;

use tokio::time::Instant;

pub const MIN_INTERVAL: Duration = Duration::from_millis(8);

#[derive(Debug, Default)]
pub struct MoveCoalescer {
    last_sent: Option<Instant>,
    pending: Option<(f64, f64)>,
}

impl MoveCoalescer {
    /// A new position. Returns it if it may go out now; otherwise it is kept
    /// (replacing any older pending one) until [`Self::deadline`].
    pub fn offer(&mut self, now: Instant, pos: (f64, f64)) -> Option<(f64, f64)> {
        let due = self.last_sent.is_none_or(|t| now >= t + MIN_INTERVAL);
        if due {
            self.pending = None;
            self.last_sent = Some(now);
            Some(pos)
        } else {
            self.pending = Some(pos);
            None
        }
    }

    /// When the pending position must be flushed, if there is one.
    pub fn deadline(&self) -> Option<Instant> {
        self.pending?;
        self.last_sent.map(|t| t + MIN_INTERVAL)
    }

    /// The pending position once its deadline has passed.
    pub fn flush_due(&mut self, now: Instant) -> Option<(f64, f64)> {
        if self.deadline().is_some_and(|d| now >= d) {
            self.take(now)
        } else {
            None
        }
    }

    /// The pending position regardless of the deadline, for a `button`,
    /// `wheel` or `leave` that must land after it.
    pub fn take(&mut self, now: Instant) -> Option<(f64, f64)> {
        let pos = self.pending.take()?;
        self.last_sent = Some(now);
        Some(pos)
    }

    /// Forgets everything, e.g. at the start or end of a capture.
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn first_move_goes_at_once_then_trailing_flush() {
        let t0 = Instant::now();
        let mut c = MoveCoalescer::default();
        assert_eq!(c.deadline(), None);
        assert_eq!(c.offer(t0, (1.0, 1.0)), Some((1.0, 1.0)));
        assert_eq!(c.deadline(), None);
        // A 1000 Hz burst: only the latest survives, flushed at last + 8 ms.
        for i in 1..=7 {
            assert_eq!(c.offer(t0 + ms(i), (i as f64, 0.0)), None);
        }
        assert_eq!(c.deadline(), Some(t0 + ms(8)));
        assert_eq!(c.flush_due(t0 + ms(7)), None);
        assert_eq!(c.flush_due(t0 + ms(8)), Some((7.0, 0.0)));
        assert_eq!(c.deadline(), None);
        assert_eq!(c.flush_due(t0 + ms(9)), None);
        // The flush counts as a send: the next one waits for 16 ms.
        assert_eq!(c.offer(t0 + ms(9), (9.0, 0.0)), None);
        assert_eq!(c.deadline(), Some(t0 + ms(16)));
    }

    #[test]
    fn a_due_move_replaces_the_pending_one() {
        let t0 = Instant::now();
        let mut c = MoveCoalescer::default();
        c.offer(t0, (0.0, 0.0));
        assert_eq!(c.offer(t0 + ms(3), (3.0, 0.0)), None);
        // The timer was late; a new position at the deadline goes straight out.
        assert_eq!(c.offer(t0 + ms(8), (8.0, 0.0)), Some((8.0, 0.0)));
        assert_eq!(c.deadline(), None);
    }

    #[test]
    fn no_delay_after_a_pause() {
        let t0 = Instant::now();
        let mut c = MoveCoalescer::default();
        c.offer(t0, (0.0, 0.0));
        assert_eq!(c.offer(t0 + ms(500), (1.0, 0.0)), Some((1.0, 0.0)));
        assert_eq!(c.offer(t0 + ms(508), (2.0, 0.0)), Some((2.0, 0.0)));
    }

    #[test]
    fn take_flushes_early_and_reset_forgets() {
        let t0 = Instant::now();
        let mut c = MoveCoalescer::default();
        assert_eq!(c.take(t0), None);
        c.offer(t0, (0.0, 0.0));
        c.offer(t0 + ms(2), (2.0, 0.0));
        assert_eq!(c.take(t0 + ms(3)), Some((2.0, 0.0)));
        assert_eq!(c.take(t0 + ms(4)), None);
        assert_eq!(c.offer(t0 + ms(5), (5.0, 0.0)), None);
        assert_eq!(c.deadline(), Some(t0 + ms(11)));
        c.reset();
        assert_eq!(c.deadline(), None);
        assert_eq!(c.offer(t0 + ms(6), (6.0, 0.0)), Some((6.0, 0.0)));
    }
}
