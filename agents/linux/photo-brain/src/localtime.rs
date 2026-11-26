//! Local calendar days without a time-zone database. A picture's own UTC
//! offset wins; without one the household's zone, Europe/Stockholm, is assumed
//! (CET, CEST under the EU rule: last Sunday of March to last Sunday of
//! October, switching at 01:00 UTC). Never silently UTC.

const DAY_MS: i64 = 86_400_000;
const HOUR_S: i32 = 3600;

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
pub fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = i64::from(year) - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day number.
pub fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = (yoe + era * 400 + i64::from(month <= 2)) as i32;
    (year, month, day)
}

/// Day number of the last Sunday of a month.
fn last_sunday(year: i32, month: u32) -> i64 {
    let last = if month == 12 {
        days_from_civil(year + 1, 1, 1) - 1
    } else {
        days_from_civil(year, month + 1, 1) - 1
    };
    // 1970-01-01 was a Thursday; 0 = Sunday.
    let weekday = (last + 4).rem_euclid(7);
    last - weekday
}

/// Europe/Stockholm's offset from UTC at an instant, in seconds.
pub fn stockholm_offset_seconds(t_ms: i64) -> i32 {
    let (year, _, _) = civil_from_days(t_ms.div_euclid(DAY_MS));
    let start = last_sunday(year, 3) * DAY_MS + 3_600_000;
    let end = last_sunday(year, 10) * DAY_MS + 3_600_000;
    if (start..end).contains(&t_ms) {
        2 * HOUR_S
    } else {
        HOUR_S
    }
}

/// The local day number a picture was taken on.
pub fn local_day(t_ms: i64, utc_offset_seconds: Option<i32>) -> i64 {
    let offset = utc_offset_seconds.unwrap_or_else(|| stockholm_offset_seconds(t_ms));
    (t_ms + i64::from(offset) * 1000).div_euclid(DAY_MS)
}

/// `YYYY-MM-DD`.
pub fn format_day(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(y: i32, mo: u32, d: u32, h: i64, mi: i64) -> i64 {
        days_from_civil(y, mo, d) * DAY_MS + h * 3_600_000 + mi * 60_000
    }

    #[test]
    fn civil_round_trips() {
        for days in [-1000, -1, 0, 1, 19_000, 20_415, 60_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(format_day(0), "1970-01-01");
        assert_eq!(format_day(days_from_civil(2024, 2, 29)), "2024-02-29");
    }

    #[test]
    fn stockholm_switches_at_one_utc_on_the_last_sundays() {
        // 2026: DST from 29 March 01:00 UTC to 25 October 01:00 UTC.
        assert_eq!(stockholm_offset_seconds(utc(2026, 3, 29, 0, 59)), 3600);
        assert_eq!(stockholm_offset_seconds(utc(2026, 3, 29, 1, 0)), 7200);
        assert_eq!(stockholm_offset_seconds(utc(2026, 10, 25, 0, 59)), 7200);
        assert_eq!(stockholm_offset_seconds(utc(2026, 10, 25, 1, 0)), 3600);
        assert_eq!(stockholm_offset_seconds(utc(2026, 1, 10, 12, 0)), 3600);
        assert_eq!(stockholm_offset_seconds(utc(2026, 7, 10, 12, 0)), 7200);
    }

    #[test]
    fn a_late_evening_picture_keeps_its_local_day() {
        // 23:30 in Stockholm in summer is 21:30 UTC: same day either way.
        let summer = utc(2026, 7, 10, 22, 30); // 00:30 local the next day
        assert_eq!(format_day(local_day(summer, None)), "2026-07-11");
        // Not UTC: UTC would still say the 10th.
        assert_eq!(format_day(summer.div_euclid(DAY_MS)), "2026-07-10");
        // The picture's own offset wins (taken in New York, UTC-4).
        assert_eq!(format_day(local_day(summer, Some(-4 * 3600))), "2026-07-10");
        assert_eq!(format_day(local_day(summer, Some(0))), "2026-07-10");
    }
}
