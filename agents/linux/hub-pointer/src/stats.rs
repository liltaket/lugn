use std::{collections::VecDeque, time::Duration};

use tokio::time::Instant;

/// Pings older than this many ids are forgotten; a pong for them only
/// proves liveness.
const MAX_OUTSTANDING: usize = 8;

#[derive(Debug, Default)]
pub struct Pings {
    next_id: u64,
    outstanding: VecDeque<(u64, Instant)>,
}

impl Pings {
    pub fn start(&mut self, now: Instant) -> u64 {
        self.next_id += 1;
        if self.outstanding.len() == MAX_OUTSTANDING {
            self.outstanding.pop_front();
        }
        self.outstanding.push_back((self.next_id, now));
        self.next_id
    }

    /// Round-trip time for a pong, if it answers a ping we still track.
    pub fn finish(&mut self, id: u64, now: Instant) -> Option<Duration> {
        let pos = self.outstanding.iter().position(|(i, _)| *i == id)?;
        let (_, sent) = self.outstanding.remove(pos)?;
        Some(now - sent)
    }
}

#[derive(Debug, Default)]
pub struct Rtt {
    samples: Vec<Duration>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Summary {
    pub n: usize,
    pub p50: Duration,
    pub p95: Duration,
    pub max: Duration,
}

impl Rtt {
    pub fn record(&mut self, rtt: Duration) {
        self.samples.push(rtt);
    }

    /// Summarizes and clears the samples taken since the last call.
    pub fn take(&mut self) -> Option<Summary> {
        if self.samples.is_empty() {
            return None;
        }
        let mut s = std::mem::take(&mut self.samples);
        s.sort_unstable();
        let pick = |q: f64| s[((s.len() - 1) as f64 * q).round() as usize];
        Some(Summary {
            n: s.len(),
            p50: pick(0.5),
            p95: pick(0.95),
            max: s[s.len() - 1],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_pongs_to_pings() {
        let t0 = Instant::now();
        let mut p = Pings::default();
        let a = p.start(t0);
        let b = p.start(t0 + Duration::from_millis(1000));
        assert_ne!(a, b);
        assert_eq!(
            p.finish(b, t0 + Duration::from_millis(1012)),
            Some(Duration::from_millis(12))
        );
        assert_eq!(p.finish(b, t0 + Duration::from_millis(1013)), None);
        assert_eq!(p.finish(99, t0), None);
        for _ in 0..20 {
            p.start(t0);
        }
        assert_eq!(p.finish(a, t0), None, "old pings are dropped");
    }

    #[test]
    fn summarizes_rtt() {
        let mut r = Rtt::default();
        assert_eq!(r.take(), None);
        for ms in [5, 1, 3, 2, 4, 100, 6, 7, 8, 9] {
            r.record(Duration::from_millis(ms));
        }
        let s = r.take().unwrap();
        assert_eq!(s.n, 10);
        assert_eq!(s.p50, Duration::from_millis(6));
        assert_eq!(s.p95, Duration::from_millis(100));
        assert_eq!(s.max, Duration::from_millis(100));
        assert_eq!(r.take(), None);
    }
}
