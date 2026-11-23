//! Outings: the library cut where the camera rested for long or moved far.

use std::collections::HashSet;

use super::{LatLon, Picture, score::distance_km};
use crate::bundle::Event;

pub struct Events {
    /// Outings with at least two pictures, in time order.
    pub events: Vec<Event>,
    pub event_of: Vec<Option<u32>>,
    /// Where each picture was taken, or for one without GPS the location of
    /// the nearest-in-time located picture of its outing.
    pub location: Vec<Option<LatLon>>,
}

/// A new outing starts after a pause longer than `gap_ms`, or when a located
/// picture is more than `km` from the outing's previous located picture.
/// Pictures without a time belong to none.
pub fn find_events(pictures: &[Picture<'_>], gap_ms: i64, km: f64) -> Events {
    let mut timed: Vec<usize> = (0..pictures.len())
        .filter(|&i| pictures[i].taken_at.is_some())
        .collect();
    timed.sort_by_key(|&i| (pictures[i].taken_at, i));
    let t = |i: usize| pictures[i].taken_at.unwrap_or_default();

    let mut segments: Vec<Vec<usize>> = Vec::new();
    let mut last_located: Option<LatLon> = None;
    for &i in &timed {
        let at = pictures[i].location;
        let split = match segments.last() {
            None => true,
            Some(segment) => {
                t(i) - t(*segment.last().unwrap()) > gap_ms
                    || matches!((at, last_located), (Some(a), Some(b)) if distance_km(a, b) > km)
            }
        };
        if split {
            segments.push(Vec::new());
            last_located = None;
        }
        segments.last_mut().unwrap().push(i);
        if at.is_some() {
            last_located = at;
        }
    }

    let mut location: Vec<Option<LatLon>> = pictures.iter().map(|p| p.location).collect();
    let mut events = Vec::new();
    let mut event_of = vec![None; pictures.len()];
    let mut ids = HashSet::new();
    for segment in &segments {
        let located: Vec<usize> = segment
            .iter()
            .copied()
            .filter(|&i| pictures[i].location.is_some())
            .collect();
        if !located.is_empty() {
            for &i in segment {
                if location[i].is_none() {
                    let nearest = located
                        .iter()
                        .min_by_key(|&&j| ((t(j) - t(i)).abs(), j))
                        .unwrap();
                    location[i] = pictures[*nearest].location;
                }
            }
        }
        if segment.len() < 2 {
            continue;
        }
        let from = t(segment[0]);
        let mut id = format!("e{}", from / 1000);
        let mut suffix = 2;
        while !ids.insert(id.clone()) {
            id = format!("e{}-{suffix}", from / 1000);
            suffix += 1;
        }
        let index = events.len() as u32;
        events.push(Event {
            id,
            from,
            to: t(*segment.last().unwrap()),
            count: segment.len() as u32,
        });
        for &i in segment {
            event_of[i] = Some(index);
        }
    }
    Events {
        events,
        event_of,
        location,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 3_600_000;
    const A: LatLon = LatLon {
        lat: 59.33,
        lon: 18.06,
    };
    const B: LatLon = LatLon {
        lat: 59.86,
        lon: 17.64,
    };

    fn pic(t: Option<i64>, at: Option<LatLon>) -> Picture<'static> {
        Picture {
            id: "x",
            taken_at: t,
            location: at,
            ..Default::default()
        }
    }

    #[test]
    fn pauses_and_jumps_cut_outings() {
        let pictures = vec![
            pic(Some(0), Some(A)),
            pic(Some(H), None),
            pic(Some(2 * H), Some(A)),
            // 64 km away an hour later: a new outing.
            pic(Some(3 * H), Some(B)),
            pic(Some(3 * H + 60_000), Some(B)),
            // Five hours later: a new outing (a single picture is no event).
            pic(Some(8 * H + 60_000), Some(B)),
            pic(None, Some(A)),
        ];
        let events = find_events(&pictures, 4 * H, 25.0);
        assert_eq!(events.events.len(), 2);
        assert_eq!(events.events[0].count, 3);
        assert_eq!(events.events[1].count, 2);
        assert_eq!(events.event_of[1], Some(0));
        assert_eq!(events.event_of[3], Some(1));
        assert_eq!(events.event_of[5], None);
        assert_eq!(events.event_of[6], None);
        // The picture without GPS borrows its outing's place.
        assert_eq!(events.location[1], Some(A));
        assert_ne!(events.events[0].id, events.events[1].id);
    }

    #[test]
    fn a_picture_without_gps_does_not_cut_an_outing() {
        let pictures = vec![
            pic(Some(0), Some(A)),
            pic(Some(H), None),
            pic(Some(2 * H), Some(A)),
        ];
        let events = find_events(&pictures, 4 * H, 25.0);
        assert_eq!(events.events.len(), 1);
        assert_eq!(events.events[0].count, 3);
    }
}
