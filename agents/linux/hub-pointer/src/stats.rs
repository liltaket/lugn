use std::{collections::VecDeque, time::Duration};

use tokio::time::Instant;

/// Pings older than this many ids are forgotten; a pong for them only
/// proves liveness. At the warm 20 ms rate this covers the 2.5 s timeout.
const MAX_OUTSTANDING: usize = 128;

#[derive(Debug, Default)]
pub struct Pings {
    next_id: u64,
    outstanding: VecDeque<(u64, Instant, bool)>,
}

/// A matched pong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    pub rtt: Duration,
    /// The ping was one of the fast warm-up ones.
    pub fast: bool,
}

impl Pings {
    pub fn start(&mut self, now: Instant, fast: bool) -> u64 {
        self.next_id += 1;
        if self.outstanding.len() == MAX_OUTSTANDING {
            self.outstanding.pop_front();
        }
        self.outstanding.push_back((self.next_id, now, fast));
        self.next_id
    }

    /// Round-trip time for a pong, if it answers a ping we still track.
    pub fn finish(&mut self, id: u64, now: Instant) -> Option<Sample> {
        let pos = self.outstanding.iter().position(|(i, ..)| *i == id)?;
        let (_, sent, fast) = self.outstanding.remove(pos)?;
        Some(Sample {
            rtt: now - sent,
            fast,
        })
    }
}

#[derive(Debug, Default)]
pub struct Rtt {
    samples: Vec<Duration>,
    fast: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Summary {
    pub n: usize,
    /// How many of `n` answered fast warm-up pings.
    pub fast: usize,
    pub p50: Duration,
    pub p95: Duration,
    pub max: Duration,
}

impl Rtt {
    pub fn record(&mut self, sample: Sample) {
        self.samples.push(sample.rtt);
        self.fast += usize::from(sample.fast);
    }

    /// Summarizes and clears the samples taken since the last call.
    pub fn take(&mut self) -> Option<Summary> {
        if self.samples.is_empty() {
            return None;
        }
        let mut s = std::mem::take(&mut self.samples);
        let fast = std::mem::take(&mut self.fast);
        s.sort_unstable();
        let pick = |q: f64| s[((s.len() - 1) as f64 * q).round() as usize];
        Some(Summary {
            n: s.len(),
            fast,
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
        let a = p.start(t0, false);
        let b = p.start(t0 + Duration::from_millis(1000), true);
        assert_ne!(a, b);
        assert_eq!(
            p.finish(b, t0 + Duration::from_millis(1012)),
            Some(Sample {
                rtt: Duration::from_millis(12),
                fast: true
            })
        );
        assert_eq!(p.finish(b, t0 + Duration::from_millis(1013)), None);
        assert_eq!(p.finish(99, t0), None);
        for _ in 0..MAX_OUTSTANDING {
            p.start(t0, true);
        }
        assert_eq!(p.finish(a, t0), None, "old pings are dropped");
    }

    #[test]
    fn summarizes_rtt() {
        let mut r = Rtt::default();
        assert_eq!(r.take(), None);
        for ms in [5, 1, 3, 2, 4, 100, 6, 7, 8, 9] {
            r.record(Sample {
                rtt: Duration::from_millis(ms),
                fast: ms < 4,
            });
        }
        let s = r.take().unwrap();
        assert_eq!(s.n, 10);
        assert_eq!(s.fast, 3);
        assert_eq!(s.p50, Duration::from_millis(6));
        assert_eq!(s.p95, Duration::from_millis(100));
        assert_eq!(s.max, Duration::from_millis(100));
        assert_eq!(r.take(), None);
    }
}
