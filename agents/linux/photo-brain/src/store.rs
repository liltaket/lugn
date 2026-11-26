//! Originals on disk (`store_dir/<2 chars>/<name>.<ext>`) and the index in
//! `db_dir/index.sqlite3`: what the album lists, which file holds which
//! picture version, and every picture's analysis (embeddings as f32 blobs).

use std::collections::HashSet;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::analysis::{FaceObservation, ModelIds, PictureAnalysis, PictureQuality};
use crate::client::{AlbumDetails, AlbumPhoto};

/// A picture that fails this often (download or analysis) is skipped until
/// its version or the models change.
pub const MAX_FAILURES: i64 = 2;

/// What the listing says about a picture, minus the short-lived URLs.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PictureMeta {
    pub taken_at: Option<i64>,
    pub utc_offset: Option<i32>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(default)]
    pub details: AlbumDetails,
}

impl PictureMeta {
    pub fn from_listing(photo: &AlbumPhoto) -> Self {
        let located = photo.latitude.zip(photo.longitude).filter(|(lat, lon)| {
            lat.is_finite()
                && lon.is_finite()
                && (-90.0..=90.0).contains(lat)
                && (-180.0..=180.0).contains(lon)
        });
        Self {
            taken_at: photo.taken_at.filter(|t| *t > 0),
            utc_offset: photo.utc_offset_seconds.filter(|o| o.abs() <= 18 * 3600),
            lat: located.map(|l| l.0),
            lon: located.map(|l| l.1),
            width: photo.width,
            height: photo.height,
            details: photo.details.clone().unwrap_or_default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredAnalysis {
    pub version: String,
    pub models: ModelIds,
    pub analysis: PictureAnalysis,
    /// Upright size of the analysed file, when the listing said.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub analysed_at: i64,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub id: String,
    pub version: String,
    pub meta: PictureMeta,
    pub analysis: Option<StoredAnalysis>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub listed: usize,
    pub new: usize,
    pub changed: usize,
    pub left: usize,
    pub back: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Counts {
    pub listed: u64,
    pub stored: u64,
    pub stored_bytes: u64,
    pub analysed: u64,
    pub skipped: u64,
    pub gone: u64,
}

#[derive(Debug, Clone)]
pub struct Pending {
    pub id: String,
    pub version: String,
    pub path: PathBuf,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

pub struct Store {
    conn: Connection,
    store_dir: PathBuf,
}

/// FNV-1a, 64 bit: a stable fingerprint (not a security hash).
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// File name stem for a picture id. Ids that are plain lowercase-safe are used
/// as they are; anything else (upper case, other characters) is lowercased and
/// gets a hash suffix, so a case-insensitive disk (NTFS) never mixes two up.
pub fn file_stem(id: &str) -> String {
    let plain = !id.is_empty()
        && id.len() <= 120
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    if plain {
        return id.to_string();
    }
    let mut cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .take(100)
        .collect();
    if cleaned.is_empty() {
        cleaned.push('x');
    }
    format!("{cleaned}-{:016x}", fnv1a64(id.as_bytes()))
}

/// `<2 chars>/<stem>.<ext>`, relative to `store_dir`.
pub fn relative_path(id: &str, ext: &str) -> PathBuf {
    let stem = file_stem(id);
    let prefix: String = stem.chars().chain(std::iter::repeat('_')).take(2).collect();
    PathBuf::from(prefix).join(format!("{stem}.{ext}"))
}

fn f32_blob(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn blob_f32(bytes: &[u8]) -> Result<Vec<f32>> {
    let (chunks, rest) = bytes.as_chunks::<4>();
    if !rest.is_empty() {
        bail!("f32 blob of {} bytes", bytes.len());
    }
    Ok(chunks.iter().map(|c| f32::from_le_bytes(*c)).collect())
}

#[derive(Serialize, Deserialize)]
struct FaceRow {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    score: f32,
    front: f32,
    quality: f32,
}

/// The model ids as stored and compared (serde field order is fixed).
pub fn models_key(models: &ModelIds) -> String {
    serde_json::to_string(models).expect("ModelIds serialises")
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS pictures (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    meta TEXT NOT NULL,
    listed INTEGER NOT NULL DEFAULT 1,
    rank INTEGER NOT NULL DEFAULT 0,
    gone_at INTEGER,
    file TEXT,
    file_version TEXT,
    file_ext TEXT,
    file_w INTEGER,
    file_h INTEGER,
    file_bytes INTEGER,
    dl_failures INTEGER NOT NULL DEFAULT 0,
    an_failures INTEGER NOT NULL DEFAULT 0,
    an_failed_models TEXT,
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    models TEXT NOT NULL,
    embedding BLOB NOT NULL,
    faces TEXT NOT NULL,
    face_embeddings BLOB NOT NULL,
    sharp REAL NOT NULL,
    dark REAL NOT NULL,
    img_w INTEGER,
    img_h INTEGER,
    analysed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

impl Store {
    /// Opens (creating `db_dir` if needed; never `store_dir`).
    pub fn open(db_dir: &Path, store_dir: &Path) -> Result<Self> {
        if !db_dir.is_dir() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(db_dir)
                .with_context(|| format!("create {}", db_dir.display()))?;
        }
        let conn = Connection::open(db_dir.join("index.sqlite3")).context("open the index")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)
            .context("create the index tables")?;
        Ok(Self {
            conn,
            store_dir: store_dir.to_path_buf(),
        })
    }

    pub fn store_dir(&self) -> &Path {
        &self.store_dir
    }

    /// Takes in a fresh listing (newest first). Pictures beyond `max` count as
    /// not listed. Pictures that left get `gone_at`; ones that came back lose it.
    pub fn sync_listing(
        &mut self,
        photos: &[AlbumPhoto],
        max: Option<usize>,
        now: i64,
    ) -> Result<SyncReport> {
        let tx = self.conn.transaction()?;
        let mut report = SyncReport::default();
        let mut seen = HashSet::new();
        tx.execute("UPDATE pictures SET listed = 0", [])?;
        {
            let mut lookup = tx.prepare("SELECT version, gone_at FROM pictures WHERE id = ?1")?;
            let mut upsert = tx.prepare(
                "INSERT INTO pictures (id, version, meta, listed, rank) VALUES (?1, ?2, ?3, 1, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                   dl_failures = CASE WHEN version = excluded.version THEN dl_failures ELSE 0 END,
                   an_failures = CASE WHEN version = excluded.version THEN an_failures ELSE 0 END,
                   version = excluded.version, meta = excluded.meta, listed = 1,
                   rank = excluded.rank, gone_at = NULL",
            )?;
            for photo in photos {
                if max.is_some_and(|m| seen.len() >= m) {
                    break;
                }
                if photo.id.is_empty()
                    || photo.version.is_empty()
                    || !seen.insert(photo.id.as_str())
                {
                    continue;
                }
                let before: Option<(String, Option<i64>)> = lookup
                    .query_row(params![photo.id], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()?;
                match &before {
                    None => report.new += 1,
                    Some((version, gone)) => {
                        if *version != photo.version {
                            report.changed += 1;
                        }
                        if gone.is_some() {
                            report.back += 1;
                        }
                    }
                }
                let meta = serde_json::to_string(&PictureMeta::from_listing(photo))?;
                upsert.execute(params![
                    photo.id,
                    photo.version,
                    meta,
                    (seen.len() - 1) as i64
                ])?;
            }
        }
        report.listed = seen.len();
        report.left = tx.execute(
            "UPDATE pictures SET gone_at = ?1 WHERE listed = 0 AND gone_at IS NULL",
            params![now],
        )?;
        tx.commit()?;
        Ok(report)
    }

    /// Listed pictures whose file is missing or for another version, newest first.
    /// A stored HEIC counts as missing when the analyser cannot decode HEIC.
    pub fn pending_downloads(&self, heic_ok: bool) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare(
            "SELECT id FROM pictures WHERE listed = 1 AND dl_failures < ?1
             AND (file IS NULL OR file_version IS NOT version OR (file_ext = 'heic' AND ?2 = 0))
             ORDER BY rank",
        )?;
        let ids = statement
            .query_map(params![MAX_FAILURES, heic_ok], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    }

    /// Where a download for `id` goes (the two-character directory is created).
    pub fn prepare_path(&self, id: &str, ext: &str) -> Result<(PathBuf, PathBuf)> {
        let relative = relative_path(id, ext);
        let absolute = self.store_dir.join(&relative);
        if let Some(dir) = absolute.parent() {
            std::fs::DirBuilder::new()
                .mode(0o700)
                .recursive(true)
                .create(dir)
                .with_context(|| format!("create {}", dir.display()))?;
        }
        Ok((relative, absolute))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_download(
        &self,
        id: &str,
        version: &str,
        relative: &Path,
        ext: &str,
        width: Option<u32>,
        height: Option<u32>,
        bytes: u64,
    ) -> Result<()> {
        let old: Option<Option<String>> = self
            .conn
            .query_row(
                "SELECT file FROM pictures WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        let relative_str = relative.to_string_lossy().to_string();
        if let Some(Some(old)) = old
            && old != relative_str
        {
            let _ = std::fs::remove_file(self.store_dir.join(old));
        }
        self.conn.execute(
            "UPDATE pictures SET file = ?2, file_version = ?3, file_ext = ?4, file_w = ?5, file_h = ?6,
             file_bytes = ?7, dl_failures = 0, last_error = NULL WHERE id = ?1",
            params![id, relative_str, version, ext, width, height, bytes as i64],
        )?;
        Ok(())
    }

    pub fn record_download_failure(&self, id: &str, error: &str) -> Result<i64> {
        self.conn.execute(
            "UPDATE pictures SET dl_failures = dl_failures + 1, last_error = ?2 WHERE id = ?1",
            params![id, error],
        )?;
        Ok(self
            .conn
            .query_row(
                "SELECT dl_failures FROM pictures WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    /// Stored pictures without an analysis for their version by these models.
    pub fn pending_analyses(&self, models: &ModelIds) -> Result<Vec<Pending>> {
        let key = models_key(models);
        let mut statement = self.conn.prepare(
            "SELECT p.id, p.version, p.file, p.file_w, p.file_h FROM pictures p
             LEFT JOIN analyses a ON a.id = p.id AND a.version = p.version AND a.models = ?1
             WHERE p.listed = 1 AND p.file IS NOT NULL AND p.file_version = p.version AND a.id IS NULL
             AND NOT (p.an_failures >= ?2 AND p.an_failed_models IS ?1)
             ORDER BY p.rank",
        )?;
        let rows = statement
            .query_map(params![key, MAX_FAILURES], |r| {
                let file: String = r.get(2)?;
                Ok(Pending {
                    id: r.get(0)?,
                    version: r.get(1)?,
                    path: self.store_dir.join(file),
                    width: r.get(3)?,
                    height: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn save_analysis(
        &self,
        id: &str,
        version: &str,
        models: &ModelIds,
        analysis: &PictureAnalysis,
        size: (Option<u32>, Option<u32>),
        now: i64,
    ) -> Result<()> {
        let faces: Vec<FaceRow> = analysis
            .faces
            .iter()
            .map(|f| FaceRow {
                x: f.x,
                y: f.y,
                w: f.w,
                h: f.h,
                score: f.score,
                front: f.front,
                quality: f.quality,
            })
            .collect();
        let mut face_embeddings = Vec::new();
        for face in &analysis.faces {
            if face.embedding.len() != models.face_dim {
                bail!(
                    "face embedding has {} values, the model says {}",
                    face.embedding.len(),
                    models.face_dim
                );
            }
            face_embeddings.extend(f32_blob(&face.embedding));
        }
        if analysis.embedding.len() != models.embed_dim {
            bail!(
                "picture embedding has {} values, the model says {}",
                analysis.embedding.len(),
                models.embed_dim
            );
        }
        self.conn.execute(
            "INSERT OR REPLACE INTO analyses
             (id, version, models, embedding, faces, face_embeddings, sharp, dark, img_w, img_h, analysed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id,
                version,
                models_key(models),
                f32_blob(&analysis.embedding),
                serde_json::to_string(&faces)?,
                face_embeddings,
                analysis.quality.sharp,
                analysis.quality.dark,
                size.0,
                size.1,
                now
            ],
        )?;
        self.conn.execute(
            "UPDATE pictures SET an_failures = 0, an_failed_models = NULL, last_error = NULL WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn record_analysis_failure(&self, id: &str, models: &ModelIds, error: &str) -> Result<i64> {
        let key = models_key(models);
        self.conn.execute(
            "UPDATE pictures SET
               an_failures = CASE WHEN an_failed_models IS ?2 THEN an_failures + 1 ELSE 1 END,
               an_failed_models = ?2, last_error = ?3 WHERE id = ?1",
            params![id, key, error],
        )?;
        Ok(self
            .conn
            .query_row(
                "SELECT an_failures FROM pictures WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    fn read_analysis(row: &rusqlite::Row<'_>, at: usize) -> Result<Option<StoredAnalysis>> {
        let version: Option<String> = row.get(at)?;
        let Some(version) = version else {
            return Ok(None);
        };
        let models: ModelIds = serde_json::from_str(&row.get::<_, String>(at + 1)?)?;
        let embedding = blob_f32(&row.get::<_, Vec<u8>>(at + 2)?)?;
        let faces: Vec<FaceRow> = serde_json::from_str(&row.get::<_, String>(at + 3)?)?;
        let face_values = blob_f32(&row.get::<_, Vec<u8>>(at + 4)?)?;
        if face_values.len() != faces.len() * models.face_dim {
            bail!("stored face embeddings do not match the face count");
        }
        let faces = faces
            .into_iter()
            .enumerate()
            .map(|(k, f)| FaceObservation {
                x: f.x,
                y: f.y,
                w: f.w,
                h: f.h,
                score: f.score,
                front: f.front,
                quality: f.quality,
                embedding: face_values[k * models.face_dim..(k + 1) * models.face_dim].to_vec(),
            })
            .collect();
        Ok(Some(StoredAnalysis {
            version,
            analysis: PictureAnalysis {
                embedding,
                faces,
                quality: PictureQuality {
                    sharp: row.get(at + 5)?,
                    dark: row.get(at + 6)?,
                },
            },
            models,
            width: row.get(at + 7)?,
            height: row.get(at + 8)?,
            analysed_at: row.get(at + 9)?,
        }))
    }

    /// Every listed picture, newest first, with its analysis when that is for
    /// the current version (and, if given, by these models).
    pub fn library(&self, models: Option<&ModelIds>) -> Result<Vec<Entry>> {
        let key = models.map(models_key);
        let mut statement = self.conn.prepare(
            "SELECT p.id, p.version, p.meta, a.version, a.models, a.embedding, a.faces, a.face_embeddings,
                    a.sharp, a.dark, a.img_w, a.img_h, a.analysed_at
             FROM pictures p
             LEFT JOIN analyses a ON a.id = p.id AND a.version = p.version AND (?1 IS NULL OR a.models = ?1)
             WHERE p.listed = 1 ORDER BY p.rank",
        )?;
        let mut rows = statement.query(params![key])?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let meta: PictureMeta =
                serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or_default();
            let analysis =
                Self::read_analysis(row, 3).with_context(|| format!("analysis of {id}"))?;
            entries.push(Entry {
                id,
                version: row.get(1)?,
                meta,
                analysis,
            });
        }
        Ok(entries)
    }

    /// The models of the newest stored analysis (for an offline export).
    pub fn latest_models(&self) -> Result<Option<ModelIds>> {
        let key: Option<String> = self
            .conn
            .query_row(
                "SELECT models FROM analyses ORDER BY analysed_at DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        key.map(|k| serde_json::from_str(&k).context("stored model ids"))
            .transpose()
    }

    /// Deletes pictures (rows and files) that left the album more than
    /// `grace_ms` ago. Only while the disk is there, so no file is orphaned.
    pub fn cleanup_gone(&self, now: i64, grace_ms: i64) -> Result<usize> {
        let mut statement = self
            .conn
            .prepare("SELECT id, file FROM pictures WHERE gone_at IS NOT NULL AND gone_at < ?1")?;
        let expired = statement
            .query_map(params![now - grace_ms], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, file) in &expired {
            if let Some(file) = file {
                match std::fs::remove_file(self.store_dir.join(file)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => bail!("delete {file}: {e}"),
                }
            }
            self.conn
                .execute("DELETE FROM analyses WHERE id = ?1", params![id])?;
            self.conn
                .execute("DELETE FROM pictures WHERE id = ?1", params![id])?;
        }
        Ok(expired.len())
    }

    pub fn counts(&self, models: Option<&ModelIds>) -> Result<Counts> {
        let key = models.map(models_key);
        let one = |sql: &str| -> Result<u64> {
            Ok(self
                .conn
                .query_row(sql, params![key], |r| r.get::<_, Option<i64>>(0))?
                .unwrap_or(0) as u64)
        };
        Ok(Counts {
            listed: one("SELECT COUNT(*) FROM pictures WHERE listed = 1 AND (?1 IS NULL OR 1)")?,
            stored: one("SELECT COUNT(*) FROM pictures WHERE file IS NOT NULL AND (?1 IS NULL OR 1)")?,
            stored_bytes: one("SELECT SUM(file_bytes) FROM pictures WHERE file IS NOT NULL AND (?1 IS NULL OR 1)")?,
            analysed: one(
                "SELECT COUNT(*) FROM pictures p JOIN analyses a ON a.id = p.id AND a.version = p.version
                 WHERE p.listed = 1 AND (?1 IS NULL OR a.models = ?1)",
            )?,
            skipped: one(&format!(
                "SELECT COUNT(*) FROM pictures WHERE listed = 1 AND (dl_failures >= {MAX_FAILURES} OR an_failures >= {MAX_FAILURES}) AND (?1 IS NULL OR 1)"
            ))?,
            gone: one("SELECT COUNT(*) FROM pictures WHERE gone_at IS NOT NULL AND (?1 IS NULL OR 1)")?,
        })
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn photo(id: &str, version: &str) -> AlbumPhoto {
        serde_json::from_value(serde_json::json!({
            "id": id, "version": version, "takenAt": 1_700_000_000_000i64,
            "latitude": 59.329_312_345, "longitude": 18.068_581_234,
            "details": {"subtype": 4, "burst": true, "batch": "b1", "favorite": true},
            "renditions": []
        }))
        .unwrap()
    }

    fn models(embed: &str) -> ModelIds {
        ModelIds {
            embed: embed.into(),
            detector: "d".into(),
            face: "f".into(),
            face_dim: 3,
            embed_dim: 4,
        }
    }

    fn analysis() -> PictureAnalysis {
        PictureAnalysis {
            embedding: vec![0.5, 0.5, 0.5, 0.5],
            faces: vec![FaceObservation {
                x: 0.1,
                y: 0.2,
                w: 0.3,
                h: 0.4,
                score: 0.9,
                front: 0.8,
                quality: 70.0,
                embedding: vec![1.0, 0.0, 0.0],
            }],
            quality: PictureQuality {
                sharp: 80.0,
                dark: 3.0,
            },
        }
    }

    fn open() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store_dir = dir.path().join("photos");
        std::fs::create_dir(&store_dir).unwrap();
        let store = Store::open(&dir.path().join("db"), &store_dir).unwrap();
        (dir, store)
    }

    #[test]
    fn file_names_are_safe_on_a_case_insensitive_disk() {
        assert_eq!(
            relative_path("abc-123", "jpg"),
            PathBuf::from("ab/abc-123.jpg")
        );
        let upper = relative_path("AbC", "heic");
        let lower = relative_path("aBc", "heic");
        assert_ne!(
            upper.to_string_lossy().to_lowercase(),
            lower.to_string_lossy().to_lowercase()
        );
        assert!(
            relative_path("../../etc/passwd", "jpg")
                .components()
                .count()
                == 2
        );
        assert_eq!(relative_path("a", "jpg"), PathBuf::from("a_/a.jpg"));
    }

    #[test]
    fn listing_downloads_analyses_round_trip() {
        let (_dir, mut store) = open();
        let report = store
            .sync_listing(&[photo("a", "1"), photo("b", "1")], None, 1)
            .unwrap();
        assert_eq!((report.listed, report.new), (2, 2));
        assert_eq!(store.pending_downloads(true).unwrap(), vec!["a", "b"]);
        let (rel, abs) = store.prepare_path("a", "heic").unwrap();
        std::fs::write(&abs, b"x").unwrap();
        store
            .record_download("a", "1", &rel, "heic", Some(3024), Some(4032), 1)
            .unwrap();
        assert_eq!(store.pending_downloads(true).unwrap(), vec!["b"]);
        // An analyser without HEIC support wants the JPEG instead.
        assert_eq!(store.pending_downloads(false).unwrap(), vec!["a", "b"]);
        let m = models("e1");
        let pending = store.pending_analyses(&m).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].width, Some(3024));
        store
            .save_analysis("a", "1", &m, &analysis(), (Some(3024), Some(4032)), 5)
            .unwrap();
        assert!(store.pending_analyses(&m).unwrap().is_empty());
        // New models: analyse again.
        assert_eq!(store.pending_analyses(&models("e2")).unwrap().len(), 1);
        let library = store.library(Some(&m)).unwrap();
        let a = library[0].analysis.as_ref().unwrap();
        assert_eq!(a.analysis, analysis());
        assert_eq!(library[0].meta.lat, Some(59.329_312_345));
        assert_eq!(library[0].meta.details.subtype, Some(4));
        assert!(library[1].analysis.is_none());
        // A new version invalidates the file and the analysis.
        store
            .sync_listing(&[photo("a", "2"), photo("b", "1")], None, 2)
            .unwrap();
        assert_eq!(store.pending_downloads(true).unwrap(), vec!["a", "b"]);
        assert!(store.library(Some(&m)).unwrap()[0].analysis.is_none());
        assert_eq!(store.latest_models().unwrap(), Some(m));
    }

    #[test]
    fn two_failures_skip_a_picture_until_it_changes() {
        let (_dir, mut store) = open();
        store.sync_listing(&[photo("a", "1")], None, 1).unwrap();
        assert_eq!(store.record_download_failure("a", "boom").unwrap(), 1);
        assert_eq!(store.pending_downloads(true).unwrap().len(), 1);
        assert_eq!(store.record_download_failure("a", "boom").unwrap(), 2);
        assert!(store.pending_downloads(true).unwrap().is_empty());
        assert_eq!(store.counts(None).unwrap().skipped, 1);
        store.sync_listing(&[photo("a", "2")], None, 2).unwrap();
        assert_eq!(store.pending_downloads(true).unwrap().len(), 1);

        let (rel, abs) = store.prepare_path("a", "jpg").unwrap();
        std::fs::write(&abs, b"x").unwrap();
        store
            .record_download("a", "2", &rel, "jpg", None, None, 1)
            .unwrap();
        let m = models("e1");
        store.record_analysis_failure("a", &m, "bad").unwrap();
        store.record_analysis_failure("a", &m, "bad").unwrap();
        assert!(store.pending_analyses(&m).unwrap().is_empty());
        // Other models get their own chance.
        assert_eq!(store.pending_analyses(&models("e2")).unwrap().len(), 1);
    }

    #[test]
    fn pictures_that_leave_are_deleted_after_the_grace_period() {
        let (_dir, mut store) = open();
        store
            .sync_listing(&[photo("a", "1"), photo("b", "1")], None, 1)
            .unwrap();
        let (rel, abs) = store.prepare_path("a", "jpg").unwrap();
        std::fs::write(&abs, b"x").unwrap();
        store
            .record_download("a", "1", &rel, "jpg", None, None, 1)
            .unwrap();
        let report = store.sync_listing(&[photo("b", "1")], None, 10).unwrap();
        assert_eq!(report.left, 1);
        assert_eq!(store.library(None).unwrap().len(), 1);
        assert_eq!(store.cleanup_gone(20, 100).unwrap(), 0);
        assert!(abs.exists());
        // Back within the grace period: nothing lost.
        let report = store
            .sync_listing(&[photo("a", "1"), photo("b", "1")], None, 30)
            .unwrap();
        assert_eq!(report.back, 1);
        assert!(
            store
                .pending_downloads(true)
                .unwrap()
                .contains(&"b".to_string())
        );
        assert!(
            !store
                .pending_downloads(true)
                .unwrap()
                .contains(&"a".to_string())
        );
        store.sync_listing(&[photo("b", "1")], None, 40).unwrap();
        assert_eq!(store.cleanup_gone(200, 100).unwrap(), 1);
        assert!(!abs.exists());
        assert_eq!(store.counts(None).unwrap().gone, 0);
    }

    #[test]
    fn max_pictures_keeps_the_newest() {
        let (_dir, mut store) = open();
        let report = store
            .sync_listing(
                &[photo("a", "1"), photo("b", "1"), photo("c", "1")],
                Some(2),
                1,
            )
            .unwrap();
        assert_eq!(report.listed, 2);
        assert_eq!(store.pending_downloads(true).unwrap(), vec!["a", "b"]);
    }

    #[test]
    fn a_mismatched_embedding_is_refused() {
        let (_dir, mut store) = open();
        store.sync_listing(&[photo("a", "1")], None, 1).unwrap();
        let mut bad = analysis();
        bad.embedding.push(0.0);
        assert!(
            store
                .save_analysis("a", "1", &models("e"), &bad, (None, None), 1)
                .is_err()
        );
    }
}
