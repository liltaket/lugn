//! Rides out a monitor that disappears.
//!
//! When the last output goes away (a monitor unplugged, switched off or put
//! to sleep by its KVM or dock) KDE sends `ZonesChanged`, and its answer to
//! `GetZones` can take far longer than the call is allowed to wait, or never
//! come until the output is back. That used to be fatal: the agent exited, and
//! a unit without a restart policy stayed dead. The session is still fine, so
//! the agent now drops its zones, keeps running without a barrier and asks
//! again until the compositor answers. Only a compositor that stays silent
//! for a long time ends the process, so that systemd can start it afresh.

use std::time::Duration;

use tokio::time::Instant;

/// Pause between two `GetZones` attempts.
pub const RETRY_AFTER: Duration = Duration::from_secs(3);

/// Failed attempts in a row before giving up. Each one can spend up to the
/// call's own timeout, so this is several minutes of a missing monitor.
pub const GIVE_UP_AFTER: u32 = 20;

#[derive(Debug, Default)]
pub struct ZoneRecovery {
    failures: u32,
    retry_at: Option<Instant>,
}

/// The compositor has not given usable zones for too long.
#[derive(Debug, PartialEq, Eq)]
pub struct GiveUp {
    pub failures: u32,
}

impl ZoneRecovery {
    /// An attempt failed, or returned no zones. Schedules the next one, or
    /// says it is time to give up.
    pub fn failed(&mut self, now: Instant) -> Result<(), GiveUp> {
        self.failures += 1;
        if self.failures >= GIVE_UP_AFTER {
            self.retry_at = None;
            return Err(GiveUp {
                failures: self.failures,
            });
        }
        self.retry_at = Some(now + RETRY_AFTER);
        Ok(())
    }

    /// Usable zones arrived.
    pub fn recovered(&mut self) {
        *self = Self::default();
    }

    /// Whether zones are missing and being waited for.
    pub fn pending(&self) -> bool {
        self.retry_at.is_some()
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.retry_at
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedules_a_retry_after_a_failure() {
        let now = Instant::now();
        let mut r = ZoneRecovery::default();
        assert!(!r.pending());
        assert_eq!(r.failed(now), Ok(()));
        assert!(r.pending());
        assert_eq!(r.deadline(), Some(now + RETRY_AFTER));
        assert_eq!(r.failures(), 1);
    }

    #[test]
    fn recovery_forgets_earlier_failures() {
        let now = Instant::now();
        let mut r = ZoneRecovery::default();
        for _ in 0..GIVE_UP_AFTER - 1 {
            assert_eq!(r.failed(now), Ok(()));
        }
        r.recovered();
        assert!(!r.pending());
        assert_eq!(r.failures(), 0);
        // A fresh run of failures gets the full allowance again.
        for _ in 0..GIVE_UP_AFTER - 1 {
            assert_eq!(r.failed(now), Ok(()));
        }
    }

    #[test]
    fn gives_up_after_too_many_failures_in_a_row() {
        let now = Instant::now();
        let mut r = ZoneRecovery::default();
        for _ in 0..GIVE_UP_AFTER - 1 {
            assert_eq!(r.failed(now), Ok(()));
        }
        assert_eq!(
            r.failed(now),
            Err(GiveUp {
                failures: GIVE_UP_AFTER
            })
        );
        assert!(!r.pending());
    }
}
