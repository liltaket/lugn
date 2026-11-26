//! The brain's loop: list the album, download what is new, analyse what is
//! missing, group the faces, cluster and publish.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};

use crate::analysis::{ModelIds, PictureAnalyzer};
use crate::client::{
    AlbumListing, AlbumPhoto, DownloadRules, Downloader, Lugn, NetError, PeopleResponse,
};
use crate::cluster::{self, LatLon, scenes::Vocabulary};
use crate::config::{Config, Token};
use crate::disk;
use crate::people::{self, Assigned, FaceId, Labels, Thresholds};
use crate::places::Places;
use crate::publish::{self, BuildInput};
use crate::store::{Entry, MAX_FAILURES, Store, fnv1a64};

/// Apple's links last about 15 minutes; re-list before they run out.
const RELIST_AFTER: Duration = Duration::from_secs(10 * 60);
/// In `run`, analysis stops after this long so progress gets published.
const SLICE: Duration = Duration::from_secs(10 * 60);
const MIN_BACKOFF: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);

pub type AnalyzerFactory = Box<dyn FnMut() -> Result<Box<dyn PictureAnalyzer>>>;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Published {
    /// Nothing analysed yet.
    Nothing,
    Unchanged,
    Sent {
        photos: usize,
        accepted: Option<u64>,
    },
}

#[derive(Debug, Clone)]
pub struct CycleReport {
    pub listed: usize,
    pub downloaded: usize,
    pub analysed: usize,
    pub published: Published,
    /// Stopped early (time budget); go again without waiting.
    pub more_work: bool,
    /// Apple could not be reached: back off.
    pub trouble: Option<String>,
}

/// Messages that should appear once per change, not every cycle.
#[derive(Default)]
struct Notes(HashMap<&'static str, String>);

impl Notes {
    fn set(&mut self, key: &'static str, message: String) {
        if self.0.get(key) != Some(&message) {
            eprintln!("{message}");
            self.0.insert(key, message);
        }
    }
    fn clear(&mut self, key: &'static str, message: &str) {
        if self.0.remove(key).is_some() {
            eprintln!("{message}");
        }
    }
}

pub struct Brain {
    config: Config,
    lugn: Lugn,
    downloader: Downloader,
    store: Store,
    open_analyzer: AnalyzerFactory,
    analyzer: Option<Box<dyn PictureAnalyzer>>,
    vocabulary: Option<Vocabulary>,
    places: Option<Places>,
    pool: rayon::ThreadPool,
    stop: Arc<AtomicBool>,
    notes: Notes,
    listing: Option<(AlbumListing, Instant)>,
    proposals: Option<(u64, HashMap<FaceId, Assigned>)>,
}

impl Brain {
    pub fn new(
        config: Config,
        token: Token,
        rules: DownloadRules,
        open_analyzer: AnalyzerFactory,
        stop: Arc<AtomicBool>,
    ) -> Result<Self> {
        let store = Store::open(&config.db_dir, &config.store_dir)?;
        let vocabulary = match std::fs::read_to_string(&config.scenes_file)
            .with_context(|| format!("read {}", config.scenes_file.display()))
            .and_then(|text| Vocabulary::parse(&text))
        {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("scene vocabulary unavailable, no scenes: {e:#}");
                None
            }
        };
        let places_path = config.places_path();
        let places = match std::fs::read_to_string(&places_path) {
            Ok(text) => Some(Places::parse(&text)),
            Err(e) => {
                eprintln!(
                    "{} unavailable, trips get no place names: {e}",
                    places_path.display()
                );
                None
            }
        };
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(config.threads)
            .thread_name(|i| format!("cluster-{i}"))
            .build()?;
        Ok(Self {
            lugn: Lugn::new(&config.lugn_url, token)?,
            downloader: Downloader::new(rules)?,
            store,
            open_analyzer,
            analyzer: None,
            vocabulary,
            places,
            pool,
            stop,
            notes: Notes::default(),
            listing: None,
            proposals: None,
            config,
        })
    }

    fn stopping(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    /// Sleeps, waking early on SIGTERM.
    fn rest(&self, duration: Duration) {
        let until = Instant::now() + duration;
        while !self.stopping() {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            std::thread::sleep(left.min(Duration::from_millis(250)));
        }
    }

    fn ensure_analyzer(&mut self) {
        if self.analyzer.is_some() {
            return;
        }
        match (self.open_analyzer)() {
            Ok(analyzer) => {
                let m = analyzer.model_ids();
                self.notes.clear("analyzer", "models opened");
                eprintln!(
                    "models: embed {} ({}), detector {}, face {} ({}), HEIC {}",
                    m.embed,
                    m.embed_dim,
                    m.detector,
                    m.face,
                    m.face_dim,
                    if analyzer.decodes_heic() { "yes" } else { "no" }
                );
                self.analyzer = Some(analyzer);
            }
            Err(e) => self.notes.set(
                "analyzer",
                format!("models unavailable, analysing nothing: {e:#}"),
            ),
        }
    }

    fn relist(&mut self) -> Result<usize, NetError> {
        let listing = self.lugn.album()?;
        let report = self
            .store
            .sync_listing(&listing.photos, self.config.max_pictures, now_ms())
            .map_err(|e| NetError::Rejected(format!("index: {e:#}")))?;
        if report.new + report.changed + report.left + report.back > 0 {
            eprintln!(
                "album: {} pictures ({} new, {} changed, {} left, {} back)",
                report.listed, report.new, report.changed, report.left, report.back
            );
        }
        self.listing = Some((listing, Instant::now()));
        Ok(report.listed)
    }

    fn listed_photo(&self, id: &str) -> Option<AlbumPhoto> {
        self.listing
            .as_ref()?
            .0
            .photos
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    fn store_ready(&mut self) -> bool {
        match disk::prepare_store_dir(&self.config.store_dir) {
            Ok(()) => {
                self.notes.clear("store", "store_dir is back");
                true
            }
            Err(why) => {
                self.notes.set(
                    "store",
                    format!("store_dir not ready, not downloading or analysing: {why}"),
                );
                false
            }
        }
    }

    fn room_left(&mut self) -> bool {
        let floor = (self.config.min_free_gb * 1e9) as u64;
        match disk::free_bytes(&self.config.store_dir) {
            Ok(free) if free >= floor => {
                self.notes
                    .clear("space", "free space is back above min_free_gb");
                true
            }
            Ok(free) => {
                self.notes.set(
                    "space",
                    format!(
                        "only {:.1} GB free on store_dir (min_free_gb {}): not downloading",
                        free as f64 / 1e9,
                        self.config.min_free_gb
                    ),
                );
                false
            }
            Err(e) => {
                self.notes
                    .set("space", format!("cannot read free space on store_dir: {e}"));
                false
            }
        }
    }

    /// Downloads pending pictures until done, out of time or out of room.
    /// `Err` only when Apple cannot be reached.
    fn download(&mut self, deadline: Option<Instant>, more: &mut bool) -> Result<usize, String> {
        let heic_ok = self.analyzer.as_ref().is_none_or(|a| a.decodes_heic());
        let pending = self
            .store
            .pending_downloads(heic_ok)
            .map_err(|e| format!("index: {e:#}"))?;
        let mut downloaded = 0;
        for id in pending {
            if self.stopping() || deadline.is_some_and(|d| Instant::now() >= d) {
                *more = true;
                break;
            }
            if !self.room_left() {
                break;
            }
            if self
                .listing
                .as_ref()
                .is_none_or(|(_, at)| at.elapsed() > RELIST_AFTER)
            {
                self.relist().map_err(|e| format!("re-listing: {e}"))?;
            }
            let mut relisted = false;
            while let Some(photo) = self.listed_photo(&id) {
                let Some(choice) = photo.choose(heic_ok) else {
                    self.download_failed(&id, "no usable rendition");
                    break;
                };
                let (relative, absolute) = match self.store.prepare_path(&id, choice.ext) {
                    Ok(paths) => paths,
                    Err(e) => return Err(format!("store_dir: {e:#}")),
                };
                match self.downloader.fetch(&choice.url, &absolute, &self.stop) {
                    Ok(bytes) => {
                        if let Err(e) = self.store.record_download(
                            &id,
                            &photo.version,
                            &relative,
                            choice.ext,
                            choice.width,
                            choice.height,
                            bytes,
                        ) {
                            return Err(format!("index: {e:#}"));
                        }
                        downloaded += 1;
                    }
                    Err(NetError::Expired(status)) if !relisted => {
                        // The link ran out: list again for a fresh one, once.
                        relisted = true;
                        self.relist()
                            .map_err(|e| format!("re-listing after {status}: {e}"))?;
                        continue;
                    }
                    Err(NetError::Unreachable(m)) => return Err(format!("Apple unreachable: {m}")),
                    Err(NetError::Stopped) => *more = true,
                    Err(e) => self.download_failed(&id, &e.to_string()),
                }
                break;
            }
        }
        Ok(downloaded)
    }

    fn download_failed(&self, id: &str, why: &str) {
        let count = self
            .store
            .record_download_failure(id, why)
            .unwrap_or(MAX_FAILURES);
        let skip = if count >= MAX_FAILURES {
            "; skipped until it changes"
        } else {
            ""
        };
        eprintln!("download of {id} failed ({count}x): {why}{skip}");
    }

    fn analyse(&mut self, deadline: Option<Instant>, more: &mut bool) -> Result<usize> {
        let Some(models) = self.analyzer.as_ref().map(|a| a.model_ids().clone()) else {
            return Ok(0);
        };
        let pending = self.store.pending_analyses(&models)?;
        let pause = Duration::from_millis(self.config.pause_ms);
        let mut analysed = 0;
        for item in pending {
            if self.stopping() || deadline.is_some_and(|d| Instant::now() >= d) {
                *more = true;
                break;
            }
            let analyzer = self.analyzer.as_mut().expect("checked above");
            let result = analyzer.analyse(&item.path).and_then(|analysis| {
                self.store.save_analysis(
                    &item.id,
                    &item.version,
                    &models,
                    &analysis,
                    (item.width, item.height),
                    now_ms(),
                )
            });
            match result {
                Ok(()) => analysed += 1,
                Err(e) => {
                    let count =
                        self.store
                            .record_analysis_failure(&item.id, &models, &format!("{e:#}"))?;
                    let skip = if count >= MAX_FAILURES {
                        "; skipped until it or the models change"
                    } else {
                        ""
                    };
                    eprintln!("analysis of {} failed ({count}x): {e:#}{skip}", item.id);
                }
            }
            self.rest(pause);
        }
        Ok(analysed)
    }

    fn people_cache(&self) -> std::path::PathBuf {
        self.config.db_dir.join("people.json")
    }

    /// Lugn's people decisions, or the last ones it gave.
    fn labels(&mut self, online: bool) -> PeopleResponse {
        if online {
            match self.lugn.people() {
                Ok(people) => {
                    self.notes
                        .clear("people", "people decisions available again");
                    if let Ok(json) = serde_json::to_vec(&people) {
                        let _ = publish::write_atomic(&self.people_cache(), &json);
                    }
                    return people;
                }
                Err(e) => self.notes.set(
                    "people",
                    format!("people decisions unavailable ({e}); using the cached ones"),
                ),
            }
        }
        std::fs::read(self.people_cache())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// The grouping's thresholds for the recogniser that made the faces.
    fn face_thresholds(&self) -> Thresholds {
        let model = self
            .analyzer
            .as_ref()
            .map(|a| a.model_ids().face.clone())
            .or_else(|| {
                self.store
                    .latest_models()
                    .ok()
                    .flatten()
                    .map(|models| models.face)
            })
            .unwrap_or_default();
        let faces = self.config.faces;
        Thresholds::for_model(&model).with_overrides(
            faces.join,
            faces.keep,
            faces.link,
            faces.margin,
        )
    }

    /// Face proposals; recomputed only when the faces or the decisions changed.
    fn proposals(
        &mut self,
        entries: &[Entry],
        people: &PeopleResponse,
    ) -> HashMap<FaceId, Assigned> {
        let faces = publish::face_records(entries);
        let mut key = String::new();
        // Sorted, so the fingerprint does not depend on hash map order.
        let sorted = (
            {
                let mut p = people.people.clone();
                p.sort_by(|a, b| a.id.cmp(&b.id));
                p
            },
            people.decided.iter().collect::<BTreeMap<_, _>>(),
            people.previous.iter().collect::<BTreeMap<_, _>>(),
            people.not.iter().collect::<BTreeMap<_, _>>(),
        );
        key.push_str(&serde_json::to_string(&sorted).unwrap_or_default());
        for entry in entries {
            if let Some(a) = &entry.analysis {
                key.push_str(&format!(
                    "|{}:{}:{}:{}",
                    entry.id,
                    entry.version,
                    a.analysed_at,
                    a.analysis.faces.len()
                ));
            }
        }
        let fingerprint = fnv1a64(key.as_bytes());
        if let Some((cached, proposals)) = &self.proposals
            && *cached == fingerprint
        {
            return proposals.clone();
        }
        let labels: Labels = people.labels();
        let thresholds = self.face_thresholds();
        let proposals = self
            .pool
            .install(|| people::cluster(&faces, &labels, &thresholds));
        self.proposals = Some((fingerprint, proposals.clone()));
        proposals
    }

    fn build(&mut self, models: &ModelIds, online: bool) -> Result<Option<crate::bundle::Bundle>> {
        let entries = self.store.library(Some(models))?;
        if !entries.iter().any(|e| e.analysis.is_some()) {
            return Ok(None);
        }
        let people = self.labels(online);
        let proposals = self.proposals(&entries, &people);
        let vocabulary = match &self.vocabulary {
            Some(v) if v.matches_model(&models.embed, models.embed_dim) => {
                self.notes
                    .clear("vocabulary", "scene vocabulary matches the embedding model");
                Some(v)
            }
            Some(v) => {
                let message = format!(
                    "scene vocabulary is for {} ({} dims), embeddings are from {} ({} dims): no scenes",
                    v.model, v.dim, models.embed, models.embed_dim
                );
                self.notes.set("vocabulary", message);
                None
            }
            None => None,
        };
        let options = cluster::Options {
            home: self.config.home.map(|h| LatLon {
                lat: h.lat,
                lon: h.lon,
            }),
            event_gap_ms: (self.config.events.gap_hours * 3_600_000.0) as i64,
            event_km: self.config.events.km,
            ..Default::default()
        };
        let started = Instant::now();
        let input = BuildInput {
            entries: &entries,
            models,
            vocabulary,
            scenes: self.config.scenes,
            places: self.places.as_ref(),
            options,
            proposals: &proposals,
            now: now_ms(),
        };
        let (bundle, stats) = self.pool.install(|| publish::build(&input));
        let elapsed = started.elapsed();
        if elapsed > Duration::from_secs(5) {
            eprintln!(
                "clustered {} pictures in {:.1} s ({} of {} pairs needed the embeddings)",
                entries.len(),
                elapsed.as_secs_f64(),
                stats.dots,
                stats.pairs
            );
        }
        Ok(Some(bundle))
    }

    fn publish(&mut self, models: &ModelIds) -> Result<Published> {
        let Some(bundle) = self.build(models, true)? else {
            return Ok(Published::Nothing);
        };
        let key = publish::content_key(&bundle).to_string();
        // Lugn lost its copy (fresh install, wiped state): send it again.
        let lugn_lacks = matches!(self.lugn.state(), Ok(state) if state.intel_at.is_none());
        if !lugn_lacks && self.store.get_meta("bundle_key")?.as_deref() == Some(key.as_str()) {
            return Ok(Published::Unchanged);
        }
        let json = serde_json::to_vec(&bundle)?;
        let gzipped = publish::gzip(&json);
        let response = self
            .lugn
            .put_intel(gzipped.clone())
            .map_err(|e| anyhow::anyhow!("PUT intel: {e}"))?;
        publish::write_atomic(&self.config.db_dir.join("intel.json.gz"), &gzipped)?;
        self.store.set_meta("bundle_key", &key)?;
        self.store
            .set_meta("published_at", &bundle.generated_at.to_string())?;
        self.store
            .set_meta("published_photos", &bundle.photos.len().to_string())?;
        let unknown = response
            .unknown
            .as_ref()
            .and_then(|u| u.as_array().map(Vec::len))
            .unwrap_or(0);
        eprintln!(
            "published {} pictures ({} KB gzipped): Lugn accepted {}{}",
            bundle.photos.len(),
            gzipped.len() / 1024,
            response.accepted.map_or("?".to_string(), |a| a.to_string()),
            if unknown > 0 {
                format!(", {unknown} unknown to it")
            } else {
                String::new()
            }
        );
        Ok(Published::Sent {
            photos: bundle.photos.len(),
            accepted: response.accepted,
        })
    }

    /// One pass. `slice`: stop analysing after this long (more work is reported).
    pub fn cycle(&mut self, slice: Option<Duration>) -> Result<CycleReport> {
        let deadline = slice.map(|s| Instant::now() + s);
        let listed = self
            .relist()
            .map_err(|e| anyhow::anyhow!("listing the album: {e}"))?;
        self.ensure_analyzer();
        let mut report = CycleReport {
            listed,
            downloaded: 0,
            analysed: 0,
            published: Published::Nothing,
            more_work: false,
            trouble: None,
        };
        let store_ready = self.store_ready();
        if store_ready {
            match self.download(deadline, &mut report.more_work) {
                Ok(n) => report.downloaded = n,
                Err(why) => {
                    eprintln!("downloads paused: {why}");
                    report.trouble = Some(why);
                }
            }
            report.analysed = self.analyse(deadline, &mut report.more_work)?;
        }
        let models = match &self.analyzer {
            Some(a) => Some(a.model_ids().clone()),
            None => self.store.latest_models()?,
        };
        if let Some(models) = models {
            report.published = self.publish(&models)?;
        }
        if store_ready {
            let grace = self.config.gone_grace_days as i64 * 86_400_000;
            let removed = self.store.cleanup_gone(now_ms(), grace)?;
            if removed > 0 {
                eprintln!("removed {removed} pictures that left the album");
            }
        }
        Ok(report)
    }

    /// Runs until SIGTERM.
    pub fn run(&mut self) {
        let mut backoff = MIN_BACKOFF;
        while !self.stopping() {
            match self.cycle(Some(SLICE)) {
                Ok(report) => {
                    if report.downloaded + report.analysed > 0 {
                        eprintln!(
                            "cycle: {} listed, {} downloaded, {} analysed{}",
                            report.listed,
                            report.downloaded,
                            report.analysed,
                            if report.more_work { ", more to do" } else { "" }
                        );
                    }
                    if report.trouble.is_some() {
                        self.rest(backoff);
                        backoff = (backoff * 2).min(MAX_BACKOFF);
                        continue;
                    }
                    backoff = MIN_BACKOFF;
                    if !report.more_work {
                        self.rest(Duration::from_secs(self.config.poll_minutes * 60));
                    }
                }
                Err(e) => {
                    eprintln!("cycle failed: {e:#}; next try in {} s", backoff.as_secs());
                    self.rest(backoff);
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
        }
        eprintln!("stopping");
    }

    /// Writes the bundle the store would publish, without contacting Lugn
    /// (people decisions from the cache).
    pub fn export(&mut self, path: &Path) -> Result<usize> {
        let models = match &self.analyzer {
            Some(a) => Some(a.model_ids().clone()),
            None => self.store.latest_models()?,
        };
        let models = models.context("nothing has been analysed yet")?;
        let bundle = self
            .build(&models, false)?
            .context("nothing has been analysed yet")?;
        publish::write_atomic(path, &serde_json::to_vec(&bundle)?)?;
        Ok(bundle.photos.len())
    }

    /// How well the face model separates the people the household has pinned:
    /// the report of [`people::calibrate`], for `calibrate`. Uses the cached
    /// decisions unless `online`.
    pub fn calibration(&mut self, online: bool) -> Result<String> {
        let models = self
            .store
            .latest_models()?
            .context("nothing has been analysed yet")?;
        let entries = self.store.library(Some(&models))?;
        let people = self.labels(online);
        let faces = publish::face_records(&entries);
        let known: std::collections::HashSet<&str> = faces.iter().map(|f| f.id.as_str()).collect();
        let truth: HashMap<FaceId, String> = people
            .decided
            .iter()
            .filter_map(|(face, person)| Some((face.clone(), person.clone()?)))
            .filter(|(face, _)| known.contains(face.as_str()))
            .collect();
        let pinned = people.decided.values().filter(|p| p.is_some()).count();
        let mut out = format!(
            "face model {} ({} dims), {} faces in {} pictures; {} pinned faces in the decisions, {} of them match a face found now\n\n",
            models.face,
            models.face_dim,
            faces.len(),
            entries.iter().filter(|e| e.analysis.is_some()).count(),
            pinned,
            truth.len()
        );
        if truth.len() < 4 {
            out.push_str("too few pinned faces to calibrate\n");
        } else {
            out.push_str(
                &people::calibrate_with(&faces, &truth, &self.face_thresholds()).to_string(),
            );
        }
        Ok(out)
    }

    /// Human-readable state for `status`.
    pub fn status(&mut self, ask_lugn: bool) -> Result<String> {
        let models = self.store.latest_models()?;
        let counts = self.store.counts(models.as_ref())?;
        let mut out = String::new();
        out.push_str(&format!(
            "pictures: {} listed, {} stored ({:.1} GB), {} analysed{}, {} skipped, {} gone (pending deletion)\n",
            counts.listed,
            counts.stored,
            counts.stored_bytes as f64 / 1e9,
            counts.analysed,
            models.as_ref().map_or(String::new(), |m| format!(" by {}", m.embed)),
            counts.skipped,
            counts.gone
        ));
        match disk::prepare_store_dir(&self.config.store_dir)
            .map(|()| disk::free_bytes(&self.config.store_dir))
        {
            Ok(Ok(free)) => out.push_str(&format!(
                "store_dir: {} ({:.1} GB free, floor {} GB)\n",
                self.config.store_dir.display(),
                free as f64 / 1e9,
                self.config.min_free_gb
            )),
            Ok(Err(e)) => out.push_str(&format!("store_dir: free space unknown: {e}\n")),
            Err(why) => out.push_str(&format!("store_dir: not ready: {why}\n")),
        }
        match self
            .store
            .get_meta("published_at")?
            .and_then(|t| t.parse::<i64>().ok())
        {
            Some(at) => out.push_str(&format!(
                "last publish: {} min ago, {} pictures\n",
                (now_ms() - at) / 60_000,
                self.store.get_meta("published_photos")?.unwrap_or_default()
            )),
            None => out.push_str("last publish: never\n"),
        }
        if !ask_lugn {
            return Ok(out);
        }
        match self.lugn.state() {
            Ok(state) => out.push_str(&format!(
                "Lugn: {} pictures, {} analysed, intel {}\n",
                state.pictures.map_or("?".into(), |n| n.to_string()),
                state.analysed.map_or("?".into(), |n| n.to_string()),
                state.intel_at.map_or("none".into(), |t| format!(
                    "{} min old",
                    (now_ms() - t) / 60_000
                ))
            )),
            Err(e) => out.push_str(&format!("Lugn: {e}\n")),
        }
        Ok(out)
    }
}
