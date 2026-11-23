//! Which pictures belong together: home, trips, outings (events), each
//! picture's best candidates and its near-duplicates. Pure logic, no IO.
//!
//! Ported from `src/runtime/photo-intel/grouping.ts`, without the people term
//! (people are decided on BrunoCAM, which re-ranks `cand`; see
//! `docs/PHOTO-BRAIN.md`) and with the fixes listed on each function.

pub mod events;
pub mod home;
pub mod pairs;
pub mod scenes;
pub mod score;
pub mod trips;

pub use score::LatLon;

use crate::bundle::{Event, Trip};

/// One picture as the clustering sees it.
#[derive(Debug, Clone, Default)]
pub struct Picture<'a> {
    pub id: &'a str,
    /// Capture time, ms since the epoch.
    pub taken_at: Option<i64>,
    /// Seconds east of UTC where it was taken; `None`: Europe/Stockholm.
    pub utc_offset: Option<i32>,
    pub location: Option<LatLon>,
    /// Nearest populated place and its country (ISO 3166 alpha-2).
    pub place: Option<&'a str>,
    pub cc: Option<&'a str>,
    /// Unit-length picture embedding (any length, the same for every picture).
    pub embedding: Option<&'a [f32]>,
    /// The album says it is part of a burst.
    pub burst: bool,
    /// Pictures added to the album in one go share a batch.
    pub batch: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct Options {
    /// Overrides the home the pictures suggest.
    pub home: Option<LatLon>,
    /// A pause longer than this starts a new outing.
    pub event_gap_ms: i64,
    /// A jump further than this between two located pictures starts a new outing.
    pub event_km: f64,
    pub min_score: f32,
    pub max_candidates: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            home: None,
            event_gap_ms: 4 * 3_600_000,
            event_km: 25.0,
            min_score: pairs::MIN_SCORE,
            max_candidates: pairs::MAX_CANDIDATES,
        }
    }
}

/// One candidate neighbour.
#[derive(Debug, Clone, PartialEq)]
pub struct Cand {
    /// Index into the input.
    pub other: u32,
    /// Combined score without people, 0-1.
    pub score: f32,
    pub time: Option<f32>,
    pub place: Option<f32>,
    pub look: Option<f32>,
}

#[derive(Debug, Clone, Default)]
pub struct Clustering {
    pub home: Option<LatLon>,
    pub trips: Vec<Trip>,
    pub trip_of: Vec<Option<u32>>,
    pub events: Vec<Event>,
    pub event_of: Vec<Option<u32>>,
    /// Best first.
    pub cand: Vec<Vec<Cand>>,
    pub du: Vec<Vec<u32>>,
    pub stats: pairs::PairStats,
}

/// Runs everything. Call it inside a rayon pool sized for the machine's share.
pub fn cluster(
    pictures: &[Picture<'_>],
    options: &Options,
    country_name: &dyn Fn(&str) -> String,
) -> Clustering {
    let home = options.home.or_else(|| home::find_home(pictures));
    let trips = trips::find_trips(pictures, home, country_name);
    let events = events::find_events(pictures, options.event_gap_ms, options.event_km);
    let context = pairs::Context::new(pictures, home, &trips.trip_of, &events);
    let (cand, du, stats) = context.candidates(options.min_score, options.max_candidates);
    Clustering {
        home,
        trips: trips.trips,
        trip_of: trips.trip_of,
        events: events.events,
        event_of: events.event_of,
        cand,
        du,
        stats,
    }
}
