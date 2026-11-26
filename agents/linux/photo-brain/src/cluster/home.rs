//! Where the pictures are usually taken.

use std::collections::{HashMap, HashSet};

use rayon::prelude::*;

use super::{LatLon, Picture, score::distance_km};
use crate::localtime::local_day;

/// How far from a candidate centre a picture still counts as taken there.
const HOME_RADIUS_KM: f64 = 25.0;

/// The place with pictures on the most distinct local days (not the most
/// pictures: one big party at a friend's must not become home). Home needs a
/// quarter of all photographed days and at least five located pictures.
pub fn find_home(pictures: &[Picture<'_>]) -> Option<LatLon> {
    let located: Vec<(LatLon, i64)> = pictures
        .iter()
        .filter_map(|p| Some((p.location?, local_day(p.taken_at?, p.utc_offset))))
        .collect();
    if located.len() < 5 {
        return None;
    }
    let total_days = located
        .iter()
        .map(|(_, d)| *d)
        .collect::<HashSet<_>>()
        .len();
    // Candidate centres: one real picture per ~1 km cell, so a library shot
    // mostly in one place does not cost n² distance checks.
    let mut centres: Vec<LatLon> = Vec::new();
    let mut seen = HashSet::new();
    for (at, _) in &located {
        if seen.insert((
            (at.lat * 100.0).round() as i64,
            (at.lon * 100.0).round() as i64,
        )) {
            centres.push(*at);
        }
    }
    // Distinct (cell, day) points with how they map to days, to keep the scan small.
    let mut points: HashMap<(i64, i64, i64), LatLon> = HashMap::new();
    for (at, day) in &located {
        points
            .entry((
                (at.lat * 100.0).round() as i64,
                (at.lon * 100.0).round() as i64,
                *day,
            ))
            .or_insert(*at);
    }
    let points: Vec<(LatLon, i64)> = points.into_iter().map(|((_, _, d), at)| (at, d)).collect();
    let best = centres
        .par_iter()
        .enumerate()
        .map(|(index, centre)| {
            let days: HashSet<i64> = points
                .iter()
                .filter(|(at, _)| distance_km(*centre, *at) <= HOME_RADIUS_KM)
                .map(|(_, d)| *d)
                .collect();
            (days.len(), index)
        })
        // Most days, then the earliest centre in input order (deterministic).
        .max_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)))?;
    (best.0 as f64 >= total_days as f64 * 0.25).then(|| centres[best.1])
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;

    fn at(t: i64, lat: f64, lon: f64) -> Picture<'static> {
        Picture {
            id: "x",
            taken_at: Some(t),
            utc_offset: Some(3600),
            location: Some(LatLon { lat, lon }),
            ..Default::default()
        }
    }

    #[test]
    fn home_is_where_most_days_are_not_most_pictures() {
        let mut pictures = Vec::new();
        // One wedding: 200 pictures on one day in Gothenburg.
        for i in 0..200 {
            pictures.push(at(1000 * DAY + i * 60_000, 57.70, 11.97));
        }
        // Everyday life: 30 days, two pictures each, in Stockholm.
        for d in 0..30 {
            pictures.push(at((1100 + d) * DAY, 59.33, 18.06));
            pictures.push(at((1100 + d) * DAY + 3_600_000, 59.331, 18.061));
        }
        let home = find_home(&pictures).unwrap();
        assert!((home.lat - 59.33).abs() < 0.01, "{home:?}");
    }

    #[test]
    fn no_home_without_enough_located_pictures() {
        let pictures: Vec<_> = (0..4).map(|d| at(d * DAY, 59.33, 18.06)).collect();
        assert_eq!(find_home(&pictures), None);
    }

    #[test]
    fn no_home_when_no_place_has_a_quarter_of_the_days() {
        let pictures: Vec<_> = (0..10)
            .map(|d| at(d * DAY, 40.0 + d as f64 * 2.0, 10.0))
            .collect();
        assert_eq!(find_home(&pictures), None);
    }

    #[test]
    fn full_precision_is_kept() {
        let pictures: Vec<_> = (0..6)
            .map(|d| at(d * DAY, 59.329_312_3, 18.068_581_1))
            .collect();
        let home = find_home(&pictures).unwrap();
        assert_eq!(home.lat, 59.329_312_3);
        assert_eq!(home.lon, 18.068_581_1);
    }
}
