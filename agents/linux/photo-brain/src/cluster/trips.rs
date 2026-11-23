//! Trips: runs of away-from-home sessions.

use std::collections::{BTreeSet, HashMap};

use super::{LatLon, Picture, score::distance_km};
use crate::bundle::Trip;
use crate::localtime::{format_day, local_day};

/// One outing is a run of pictures without a pause longer than this.
const SESSION_GAP_MS: i64 = 6 * 3_600_000;
/// Two away sessions further apart than this are two trips.
const TRIP_GAP_MS: i64 = 40 * 3_600_000;
/// Further than this from home is away.
pub const AWAY_KM: f64 = 80.0;
const HOME_CC_RADIUS_KM: f64 = 25.0;

pub struct Trips {
    pub trips: Vec<Trip>,
    pub trip_of: Vec<Option<u32>>,
}

/// The most common value with its share of the values that are present
/// (pictures without a place do not dilute the share).
fn dominant<'a>(values: impl Iterator<Item = Option<&'a str>>) -> Option<(&'a str, f64)> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut order: Vec<&str> = Vec::new();
    let mut total = 0usize;
    for value in values.flatten() {
        total += 1;
        let count = counts.entry(value).or_insert(0);
        if *count == 0 {
            order.push(value);
        }
        *count += 1;
    }
    // Ties: the value seen first.
    let mut best: Option<(&str, usize)> = None;
    for value in order {
        let count = counts[value];
        if best.is_none_or(|(_, c)| count > c) {
            best = Some((value, count));
        }
    }
    best.map(|(value, count)| (value, count as f64 / total as f64))
}

/// Port of `findTrips`, with these fixes: a session without any GPS between two
/// away sessions bridges them instead of splitting the trip; place and country
/// shares count only pictures that have one; local dates use the picture's own
/// offset or Europe/Stockholm.
pub fn find_trips(
    pictures: &[Picture<'_>],
    home: Option<LatLon>,
    country_name: &dyn Fn(&str) -> String,
) -> Trips {
    let mut trip_of = vec![None; pictures.len()];
    let mut trips = Vec::new();
    let Some(home) = home else {
        return Trips { trips, trip_of };
    };
    let mut timed: Vec<usize> = (0..pictures.len())
        .filter(|&i| pictures[i].taken_at.is_some())
        .collect();
    timed.sort_by_key(|&i| (pictures[i].taken_at, i));
    let t = |i: usize| pictures[i].taken_at.unwrap_or_default();

    let mut sessions: Vec<Vec<usize>> = Vec::new();
    for &i in &timed {
        match sessions.last_mut() {
            Some(last) if t(i) - t(*last.last().unwrap()) <= SESSION_GAP_MS => last.push(i),
            _ => sessions.push(vec![i]),
        }
    }

    let home_cc = dominant(
        pictures
            .iter()
            .filter(|p| {
                p.location
                    .is_some_and(|at| distance_km(at, home) <= HOME_CC_RADIUS_KM)
            })
            .map(|p| p.cc),
    )
    .map(|(cc, _)| cc);

    let away = |session: &[usize]| -> Option<bool> {
        let located: Vec<LatLon> = session
            .iter()
            .filter_map(|&i| pictures[i].location)
            .collect();
        if located.is_empty() {
            return None;
        }
        let far = located
            .iter()
            .filter(|&&at| distance_km(at, home) > AWAY_KM)
            .count();
        Some(far * 2 >= located.len())
    };

    let mut close = |chain: &mut Vec<&Vec<usize>>| {
        if chain.is_empty() {
            return;
        }
        let entries: Vec<usize> = chain.iter().flat_map(|s| s.iter().copied()).collect();
        chain.clear();
        let days: BTreeSet<i64> = entries
            .iter()
            .map(|&i| local_day(t(i), pictures[i].utc_offset))
            .collect();
        let (Some(&first), Some(&last)) = (days.first(), days.last()) else {
            return;
        };
        let abroad = home_cc.is_some_and(|home_cc| {
            entries
                .iter()
                .any(|&i| pictures[i].cc.is_some_and(|cc| cc != home_cc))
        });
        if first == last && !abroad {
            return;
        }
        let place = dominant(entries.iter().map(|&i| pictures[i].place));
        let country = dominant(entries.iter().map(|&i| pictures[i].cc));
        // One place carries the pictures: name it; otherwise the country.
        let title = match (place, country) {
            (Some((place, share)), _) if share >= 0.6 => place.to_string(),
            (_, Some((cc, _))) => country_name(cc),
            (Some((place, _)), None) => place.to_string(),
            (None, None) => String::new(),
        };
        if title.is_empty() {
            return;
        }
        let index = trips.len() as u32;
        trips.push(Trip {
            title,
            from: format_day(first),
            to: format_day(last),
            cc: country.map(|(cc, _)| cc.to_string()),
        });
        for i in entries {
            trip_of[i] = Some(index);
        }
    };

    let mut chain: Vec<&Vec<usize>> = Vec::new();
    // Sessions without GPS after the chain's last away session: they join the
    // trip only if another away session follows.
    let mut pending: Vec<&Vec<usize>> = Vec::new();
    for session in &sessions {
        match away(session) {
            Some(true) => {
                let mut joined = !chain.is_empty();
                if joined {
                    let mut previous = t(*chain.last().unwrap().last().unwrap());
                    for s in pending.iter().copied().chain(std::iter::once(session)) {
                        if t(s[0]) - previous > TRIP_GAP_MS {
                            joined = false;
                        }
                        previous = t(*s.last().unwrap());
                    }
                }
                if joined {
                    chain.append(&mut pending);
                } else {
                    close(&mut chain);
                    pending.clear();
                }
                chain.push(session);
            }
            None if !chain.is_empty() => pending.push(session),
            None => {}
            Some(false) => {
                close(&mut chain);
                pending.clear();
            }
        }
    }
    close(&mut chain);
    Trips { trips, trip_of }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 3_600_000;
    const HOME: LatLon = LatLon {
        lat: 59.33,
        lon: 18.06,
    };
    const KRAKOW: LatLon = LatLon {
        lat: 50.06,
        lon: 19.94,
    };

    fn pic(
        t: i64,
        at: Option<LatLon>,
        place: Option<&'static str>,
        cc: Option<&'static str>,
    ) -> Picture<'static> {
        Picture {
            id: "x",
            taken_at: Some(t),
            utc_offset: Some(3600),
            location: at,
            place,
            cc,
            ..Default::default()
        }
    }

    fn name(cc: &str) -> String {
        format!("land {cc}")
    }

    fn home_days(start: i64, days: i64) -> Vec<Picture<'static>> {
        (0..days)
            .map(|d| {
                pic(
                    start + d * 24 * H,
                    Some(HOME),
                    Some("Stockholm"),
                    Some("SE"),
                )
            })
            .collect()
    }

    #[test]
    fn a_session_without_gps_does_not_split_a_trip() {
        let day0 = 20_000 * 24 * H + 10 * H;
        let mut pictures = home_days(day0 - 10 * 24 * H, 5);
        // Day 1 and 2 in Kraków, day 3 nothing located (phone GPS off), day 4 Kraków.
        for d in [0, 1] {
            for k in 0..3 {
                pictures.push(pic(
                    day0 + d * 24 * H + k * H,
                    Some(KRAKOW),
                    Some("Kraków"),
                    Some("PL"),
                ));
            }
        }
        let gap_start = pictures.len();
        for k in 0..3 {
            pictures.push(pic(day0 + 2 * 24 * H + k * H, None, None, None));
        }
        for k in 0..3 {
            pictures.push(pic(
                day0 + 3 * 24 * H + k * H,
                Some(KRAKOW),
                Some("Kraków"),
                Some("PL"),
            ));
        }
        pictures.extend(home_days(day0 + 6 * 24 * H, 3));
        let trips = find_trips(&pictures, Some(HOME), &name);
        assert_eq!(trips.trips.len(), 1, "{:?}", trips.trips);
        assert_eq!(trips.trips[0].title, "Kraków");
        assert_eq!(trips.trips[0].cc.as_deref(), Some("PL"));
        assert_eq!(trips.trip_of[gap_start], Some(0));
        let span = (trips.trips[0].from.clone(), trips.trips[0].to.clone());
        assert_eq!(span.0, format_day(local_day(day0, Some(3600))));
        assert_eq!(span.1, format_day(local_day(day0 + 3 * 24 * H, Some(3600))));
        // Home pictures are not in it.
        assert_eq!(trips.trip_of[0], None);
    }

    #[test]
    fn a_trailing_session_without_gps_is_not_claimed() {
        let day0 = 20_000 * 24 * H + 10 * H;
        let mut pictures = home_days(day0 - 10 * 24 * H, 5);
        for d in 0..2 {
            pictures.push(pic(
                day0 + d * 24 * H,
                Some(KRAKOW),
                Some("Kraków"),
                Some("PL"),
            ));
        }
        pictures.push(pic(day0 + 2 * 24 * H, None, None, None));
        let last = pictures.len() - 1;
        let trips = find_trips(&pictures, Some(HOME), &name);
        assert_eq!(trips.trips.len(), 1);
        assert_eq!(trips.trip_of[last], None);
    }

    #[test]
    fn shares_ignore_pictures_without_a_place() {
        let day0 = 20_000 * 24 * H;
        let mut pictures = home_days(day0 - 10 * 24 * H, 5);
        // Two days abroad: 2 named Kraków, 1 named Wieliczka, 5 unnamed. Old code:
        // 2/8 < 0.6 and the country wins; over present values Kraków has 2/3.
        for k in 0..8 {
            let place = match k {
                0 | 1 => Some("Kraków"),
                2 => Some("Wieliczka"),
                _ => None,
            };
            pictures.push(pic(day0 + k * 4 * H, Some(KRAKOW), place, Some("PL")));
        }
        let trips = find_trips(&pictures, Some(HOME), &name);
        assert_eq!(trips.trips[0].title, "Kraków");
        // Without a dominant place the country names it.
        let mut pictures = home_days(day0 - 10 * 24 * H, 5);
        for k in 0..8 {
            let place = if k % 2 == 0 { "Kraków" } else { "Wieliczka" };
            pictures.push(pic(day0 + k * 4 * H, Some(KRAKOW), Some(place), Some("PL")));
        }
        assert_eq!(
            find_trips(&pictures, Some(HOME), &name).trips[0].title,
            "land PL"
        );
    }

    #[test]
    fn a_day_trip_at_home_in_the_country_is_not_a_trip_but_abroad_is() {
        let day0 = 20_000 * 24 * H + 8 * H;
        let uppsala = LatLon {
            lat: 59.86,
            lon: 17.64,
        };
        let gothenburg = LatLon {
            lat: 57.70,
            lon: 11.97,
        };
        let mut pictures = home_days(day0 - 10 * 24 * H, 5);
        for k in 0..3 {
            pictures.push(pic(
                day0 + k * H,
                Some(gothenburg),
                Some("Göteborg"),
                Some("SE"),
            ));
        }
        let _ = uppsala;
        assert!(find_trips(&pictures, Some(HOME), &name).trips.is_empty());
        let mut pictures = home_days(day0 - 10 * 24 * H, 5);
        for k in 0..3 {
            pictures.push(pic(day0 + k * H, Some(KRAKOW), Some("Kraków"), Some("PL")));
        }
        assert_eq!(find_trips(&pictures, Some(HOME), &name).trips.len(), 1);
    }

    #[test]
    fn long_gaps_split_trips() {
        let day0 = 20_000 * 24 * H;
        let mut pictures = home_days(day0 - 10 * 24 * H, 5);
        for d in [0, 1, 5, 6] {
            pictures.push(pic(
                day0 + d * 24 * H,
                Some(KRAKOW),
                Some("Kraków"),
                Some("PL"),
            ));
        }
        assert_eq!(find_trips(&pictures, Some(HOME), &name).trips.len(), 2);
    }
}
