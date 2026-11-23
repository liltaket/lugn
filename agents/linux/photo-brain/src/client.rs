//! Talking to Lugn (`/photo-brain/v1/*`, bearer token) and downloading
//! pictures from Apple's short-lived links. See `docs/PHOTO-BRAIN.md`.

use std::collections::HashMap;
use std::fmt;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::Url;
use reqwest::blocking::{Client, Response};
use serde::Deserialize;

use crate::config::Token;

/// Largest picture Kuffe downloads, and largest Lugn response it reads.
pub const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LISTING_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug)]
pub enum NetError {
    /// Connection refused, timeout, DNS, a 5xx: try again later.
    Unreachable(String),
    /// Lugn refused the token.
    Unauthorized,
    /// Apple's link expired (401/403/410): re-list and retry.
    Expired(u16),
    /// Anything else that retrying the same request will not fix.
    Rejected(String),
    /// SIGTERM while a transfer was running.
    Stopped,
}

impl fmt::Display for NetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable(m) => write!(f, "unreachable: {m}"),
            Self::Unauthorized => f.write_str("Lugn refused the token (401)"),
            Self::Expired(s) => write!(f, "link expired ({s})"),
            Self::Rejected(m) => write!(f, "rejected: {m}"),
            Self::Stopped => f.write_str("stopped"),
        }
    }
}

impl std::error::Error for NetError {}

impl NetError {
    pub fn is_transient(&self) -> bool {
        matches!(self, Self::Unreachable(_) | Self::Unauthorized)
    }
}

/// A reqwest error without the URL (Apple's URLs carry signatures).
fn describe(e: &reqwest::Error) -> String {
    let kind = if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else if e.is_redirect() {
        "redirect"
    } else if e.is_body() || e.is_decode() {
        "body"
    } else {
        "request"
    };
    let mut source = std::error::Error::source(e);
    let mut detail = String::new();
    while let Some(s) = source {
        detail = s.to_string();
        source = s.source();
    }
    if detail.is_empty() {
        kind.to_string()
    } else {
        format!("{kind}: {detail}")
    }
}

fn transport(e: reqwest::Error) -> NetError {
    if e.is_redirect() {
        NetError::Rejected(describe(&e))
    } else {
        NetError::Unreachable(describe(&e))
    }
}

fn read_capped(mut response: Response, cap: u64) -> Result<Vec<u8>, NetError> {
    if response.content_length().is_some_and(|n| n > cap) {
        return Err(NetError::Rejected(format!(
            "response larger than {cap} bytes"
        )));
    }
    let mut body = Vec::new();
    (&mut response)
        .take(cap + 1)
        .read_to_end(&mut body)
        .map_err(|e| NetError::Unreachable(format!("body: {e}")))?;
    if body.len() as u64 > cap {
        return Err(NetError::Rejected(format!(
            "response larger than {cap} bytes"
        )));
    }
    Ok(body)
}

// ── The album listing (GET /photo-brain/v1/album) ──

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumListing {
    pub schema: u32,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub listed_at: Option<i64>,
    pub photos: Vec<AlbumPhoto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPhoto {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub taken_at: Option<i64>,
    #[serde(default)]
    pub utc_offset_seconds: Option<i32>,
    #[serde(default)]
    pub latitude: Option<f64>,
    #[serde(default)]
    pub longitude: Option<f64>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub details: Option<AlbumDetails>,
    #[serde(default)]
    pub renditions: Vec<Rendition>,
}

/// The parts of Lugn's `AlbumPhotoDetails` the brain uses; the rest is ignored.
#[derive(Debug, Clone, Default, Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumDetails {
    #[serde(default)]
    pub caption: Option<String>,
    #[serde(default)]
    pub favorite: Option<bool>,
    /// Apple's asset subtype flags: 1 panorama, 2 HDR, 4 screenshot, 8 live, 16 depth.
    #[serde(default)]
    pub subtype: Option<u32>,
    #[serde(default)]
    pub burst: Option<bool>,
    #[serde(default)]
    pub batch: Option<String>,
}

pub const SUBTYPE_SCREENSHOT: u32 = 4;

#[derive(Debug, Clone, Deserialize)]
pub struct Rendition {
    pub kind: String,
    pub url: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// Uniform type identifier, e.g. `public.heic`.
    #[serde(default, rename = "type")]
    pub uti: Option<String>,
}

/// Which file to keep for a picture.
#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub url: String,
    pub ext: &'static str,
    /// Upright pixel size, when the listing says.
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl AlbumPhoto {
    /// The original when it is a JPEG, or a HEIC the analyser can decode;
    /// otherwise Apple's JPEG rendition.
    pub fn choose(&self, heic_ok: bool) -> Option<Choice> {
        let jpeg = self.renditions.iter().find(|r| r.kind == "jpeg");
        let original = self
            .renditions
            .iter()
            .find(|r| r.kind == "original")
            .and_then(
                |r| match r.uti.as_deref().map(str::to_ascii_lowercase).as_deref() {
                    Some("public.heic" | "public.heif") if heic_ok => Some((r, "heic")),
                    Some("public.jpeg") => Some((r, "jpg")),
                    _ => None,
                },
            );
        let (r, ext) = original.or_else(|| jpeg.map(|r| (r, "jpg")))?;
        let (mut width, mut height) = (r.width, r.height);
        // The JPEG rendition is upright; if the original's size says the
        // other orientation, it is the sensor's, so swap it.
        if let (Some(w), Some(h), Some(jw), Some(jh)) = (
            width,
            height,
            jpeg.and_then(|j| j.width),
            jpeg.and_then(|j| j.height),
        ) && (w > h) != (jw > jh)
            && w != h
            && jw != jh
        {
            (width, height) = (Some(h), Some(w));
        }
        Some(Choice {
            url: r.url.clone(),
            ext,
            width,
            height,
        })
    }
}

// ── State and people ──

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LugnState {
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub intel_at: Option<i64>,
    #[serde(default)]
    pub pictures: Option<u64>,
    #[serde(default)]
    pub analysed: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PutResponse {
    #[serde(default)]
    pub accepted: Option<u64>,
    #[serde(default)]
    pub unknown: Option<serde_json::Value>,
}

/// `GET /photo-brain/v1/people`.
#[derive(Debug, Clone, Default, Deserialize, serde::Serialize, PartialEq)]
pub struct PeopleResponse {
    pub schema: u32,
    #[serde(default)]
    pub people: Vec<PersonEntry>,
    #[serde(default)]
    pub decided: HashMap<String, Option<String>>,
    #[serde(default)]
    pub previous: HashMap<String, String>,
    #[serde(default)]
    pub not: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize, serde::Serialize, PartialEq)]
pub struct PersonEntry {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub confirmed: bool,
    #[serde(default)]
    pub hidden: bool,
}

impl PeopleResponse {
    pub fn labels(&self) -> crate::people::Labels {
        crate::people::Labels {
            confirmed: self
                .people
                .iter()
                .filter(|p| p.confirmed)
                .map(|p| p.id.clone())
                .collect(),
            hidden: self
                .people
                .iter()
                .filter(|p| p.hidden)
                .map(|p| p.id.clone())
                .collect(),
            decided: self.decided.clone(),
            previous: self.previous.clone(),
            not: self.not.clone(),
        }
    }
}

// ── Lugn ──

pub struct Lugn {
    http: Client,
    base: Url,
    token: Token,
}

impl Lugn {
    pub fn new(base_url: &str, token: Token) -> anyhow::Result<Self> {
        let mut base = Url::parse(base_url)?;
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("lugn-photo-brain/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self { http, base, token })
    }

    fn url(&self, path: &str) -> Url {
        self.base.join(path).expect("static path")
    }

    fn check(response: Response) -> Result<Response, NetError> {
        let status = response.status();
        match status.as_u16() {
            200..=299 => Ok(response),
            401 => Err(NetError::Unauthorized),
            // The tunnel or Lugn is down, or the endpoint is not there yet.
            404 | 408 | 429 | 500..=599 => Err(NetError::Unreachable(format!("HTTP {status}"))),
            _ => Err(NetError::Rejected(format!("HTTP {status}"))),
        }
    }

    fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, NetError> {
        let response = self
            .http
            .get(self.url(path))
            .bearer_auth(self.token.expose())
            .header("Accept", "application/json")
            .send()
            .map_err(transport)?;
        let body = read_capped(Self::check(response)?, MAX_LISTING_BYTES)?;
        serde_json::from_slice(&body).map_err(|e| NetError::Rejected(format!("{path}: {e}")))
    }

    pub fn album(&self) -> Result<AlbumListing, NetError> {
        let listing: AlbumListing = self.get_json("photo-brain/v1/album")?;
        if listing.schema != 1 {
            return Err(NetError::Rejected(format!(
                "album schema {} is not 1",
                listing.schema
            )));
        }
        Ok(listing)
    }

    pub fn state(&self) -> Result<LugnState, NetError> {
        self.get_json("photo-brain/v1/state")
    }

    pub fn people(&self) -> Result<PeopleResponse, NetError> {
        let people: PeopleResponse = self.get_json("photo-brain/v1/people")?;
        if people.schema != 1 {
            return Err(NetError::Rejected(format!(
                "people schema {} is not 1",
                people.schema
            )));
        }
        Ok(people)
    }

    /// PUTs an already gzipped bundle.
    pub fn put_intel(&self, gzipped: Vec<u8>) -> Result<PutResponse, NetError> {
        let response = self
            .http
            .put(self.url("photo-brain/v1/intel"))
            .bearer_auth(self.token.expose())
            .header("Content-Type", "application/json")
            .header("Content-Encoding", "gzip")
            .body(gzipped)
            .send()
            .map_err(transport)?;
        let body = read_capped(Self::check(response)?, 1024 * 1024)?;
        serde_json::from_slice(&body)
            .map_err(|e| NetError::Rejected(format!("intel response: {e}")))
    }
}

// ── Apple downloads ──

/// Where pictures may be downloaded from.
#[derive(Debug, Clone)]
pub struct DownloadRules {
    pub https_only: bool,
    /// A host must equal one of these or be a subdomain of it.
    pub host_suffixes: Vec<String>,
}

impl DownloadRules {
    /// Apple's picture CDN: `https://*.icloud-content.com` only.
    pub fn apple() -> Self {
        Self {
            https_only: true,
            host_suffixes: vec!["icloud-content.com".into()],
        }
    }

    pub fn allows(&self, url: &Url) -> bool {
        let scheme_ok = match url.scheme() {
            "https" => url.port().is_none_or(|p| p == 443),
            "http" => !self.https_only,
            _ => false,
        };
        let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
            return false;
        };
        scheme_ok
            && url.username().is_empty()
            && url.password().is_none()
            && self
                .host_suffixes
                .iter()
                .any(|s| host == *s || host.ends_with(&format!(".{s}")))
    }
}

pub struct Downloader {
    http: Client,
    rules: DownloadRules,
    cap: u64,
}

impl Downloader {
    pub fn new(rules: DownloadRules) -> anyhow::Result<Self> {
        let checked = rules.clone();
        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 3 {
                attempt.error("too many redirects")
            } else if checked.allows(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("redirect away from the picture host")
            }
        });
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(180))
            .redirect(policy)
            .user_agent(concat!("lugn-photo-brain/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            http,
            rules,
            cap: MAX_DOWNLOAD_BYTES,
        })
    }

    /// Downloads `url` into `dest` (through `dest.part`, renamed at the end).
    /// Returns the size.
    pub fn fetch(&self, url: &str, dest: &Path, stop: &AtomicBool) -> Result<u64, NetError> {
        let parsed = Url::parse(url).map_err(|_| NetError::Rejected("not a URL".into()))?;
        if !self.rules.allows(&parsed) {
            return Err(NetError::Rejected(format!(
                "refusing to download from {}",
                parsed.host_str().unwrap_or("?")
            )));
        }
        let mut response = self.http.get(parsed).send().map_err(transport)?;
        let status = response.status().as_u16();
        match status {
            200 => {}
            401 | 403 | 410 => return Err(NetError::Expired(status)),
            408 | 429 | 500..=599 => return Err(NetError::Unreachable(format!("HTTP {status}"))),
            _ => return Err(NetError::Rejected(format!("HTTP {status}"))),
        }
        if response.content_length().is_some_and(|n| n > self.cap) {
            return Err(NetError::Rejected("picture larger than 64 MB".into()));
        }
        let part = dest.with_extension(format!(
            "{}.part",
            dest.extension().and_then(|e| e.to_str()).unwrap_or("")
        ));
        let result = (|| {
            let mut file = std::fs::File::create(&part)
                .map_err(|e| NetError::Rejected(format!("create: {e}")))?;
            let mut total = 0u64;
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                if stop.load(Ordering::Relaxed) {
                    return Err(NetError::Stopped);
                }
                let n = response
                    .read(&mut buffer)
                    .map_err(|e| NetError::Unreachable(format!("body: {e}")))?;
                if n == 0 {
                    break;
                }
                total += n as u64;
                if total > self.cap {
                    return Err(NetError::Rejected("picture larger than 64 MB".into()));
                }
                file.write_all(&buffer[..n])
                    .map_err(|e| NetError::Rejected(format!("write: {e}")))?;
            }
            if total == 0 {
                return Err(NetError::Rejected("empty picture".into()));
            }
            file.sync_all()
                .map_err(|e| NetError::Rejected(format!("sync: {e}")))?;
            drop(file);
            std::fs::rename(&part, dest).map_err(|e| NetError::Rejected(format!("rename: {e}")))?;
            Ok(total)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&part);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mockhttp::{MockServer, Response as MockResponse};
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;

    fn token() -> Token {
        Token::new("t0k3n".into()).unwrap()
    }

    #[test]
    fn apple_rules() {
        let rules = DownloadRules::apple();
        let ok = |u: &str| rules.allows(&Url::parse(u).unwrap());
        assert!(ok("https://cvws.icloud-content.com/B/abc"));
        assert!(ok("https://p123-sharedstreams.ICLOUD-content.com/x"));
        assert!(!ok("http://cvws.icloud-content.com/B/abc"));
        assert!(!ok("https://icloud-content.com.evil.example/x"));
        assert!(!ok("https://evilicloud-content.com/x"));
        assert!(!ok("https://a.icloud-content.com:8443/x"));
        assert!(!ok("https://user@a.icloud-content.com/x"));
    }

    #[test]
    fn rendition_choice() {
        let photo: AlbumPhoto = serde_json::from_str(
            r#"{"id":"a","version":"v","renditions":[
                {"kind":"jpeg","url":"https://x.icloud-content.com/j","width":1536,"height":2048},
                {"kind":"original","url":"https://x.icloud-content.com/o","width":4032,"height":3024,"type":"public.heic"}]}"#,
        )
        .unwrap();
        let heic = photo.choose(true).unwrap();
        assert_eq!(heic.ext, "heic");
        // Sensor orientation corrected from the upright JPEG.
        assert_eq!((heic.width, heic.height), (Some(3024), Some(4032)));
        let jpeg = photo.choose(false).unwrap();
        assert_eq!(
            (jpeg.ext, jpeg.url.as_str()),
            ("jpg", "https://x.icloud-content.com/j")
        );
    }

    #[test]
    fn lugn_calls_carry_the_token_and_gzip() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        let server = MockServer::start(move |request| {
            log.lock().unwrap().push(request.clone());
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/photo-brain/v1/album") => MockResponse::json(
                    r#"{"schema":1,"title":"T","listedAt":5,"photos":[{"id":"a","version":"1",
                    "takenAt":10,"utcOffsetSeconds":null,"latitude":59.123456789,"longitude":18.0,
                    "details":{"subtype":4,"burst":true,"batch":"b","favorite":true,"keywords":["x"]},
                    "renditions":[]}]}"#,
                ),
                ("GET", "/photo-brain/v1/state") => MockResponse::json(
                    r#"{"revision":"r","intelAt":null,"pictures":1,"analysed":0}"#,
                ),
                ("GET", "/photo-brain/v1/people") => MockResponse::json(
                    r#"{"schema":1,"people":[{"id":"p3","name":"Anna","confirmed":true,"hidden":false}],
                    "decided":{"a.0":"p3","a.1":null},"previous":{"a.2":"p3"},"not":{"a.3":["p5"]}}"#,
                ),
                ("PUT", "/photo-brain/v1/intel") => {
                    MockResponse::json(r#"{"accepted":1,"unknown":[]}"#)
                }
                _ => MockResponse::status(404),
            }
        });
        let lugn = Lugn::new(&server.url(), token()).unwrap();
        let album = lugn.album().unwrap();
        assert_eq!(album.photos[0].latitude, Some(59.123456789));
        assert_eq!(album.photos[0].utc_offset_seconds, None);
        assert_eq!(album.photos[0].details.as_ref().unwrap().subtype, Some(4));
        assert_eq!(lugn.state().unwrap().intel_at, None);
        let labels = lugn.people().unwrap().labels();
        assert!(labels.confirmed.contains("p3"));
        assert_eq!(labels.decided["a.0"], Some("p3".to_string()));
        assert_eq!(labels.decided["a.1"], None);
        assert_eq!(labels.not["a.3"], vec!["p5".to_string()]);
        let put = lugn.put_intel(vec![0x1f, 0x8b]).unwrap();
        assert_eq!(put.accepted, Some(1));
        let requests = seen.lock().unwrap();
        assert!(
            requests
                .iter()
                .all(|r| r.header("authorization") == Some("Bearer t0k3n"))
        );
        let put = requests.iter().find(|r| r.method == "PUT").unwrap();
        assert_eq!(put.header("content-encoding"), Some("gzip"));
        assert_eq!(put.body, vec![0x1f, 0x8b]);
    }

    #[test]
    fn lugn_errors_are_classified() {
        let server = MockServer::start(|request| match request.path.as_str() {
            "/photo-brain/v1/album" => MockResponse::status(401),
            "/photo-brain/v1/state" => MockResponse::status(502),
            _ => MockResponse::json(r#"{"schema":2,"photos":[]}"#),
        });
        let lugn = Lugn::new(&server.url(), token()).unwrap();
        assert!(matches!(lugn.album(), Err(NetError::Unauthorized)));
        assert!(matches!(lugn.state(), Err(NetError::Unreachable(_))));
        assert!(matches!(lugn.people(), Err(NetError::Rejected(_))));
        drop(server);
        let down = Lugn::new("http://127.0.0.1:9", token()).unwrap();
        assert!(matches!(down.album(), Err(NetError::Unreachable(_))));
    }

    #[test]
    fn downloads_are_capped_and_classified() {
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let server = MockServer::start(move |request| {
            h.fetch_add(1, Ordering::Relaxed);
            match request.path.as_str() {
                "/ok" => MockResponse::bytes(vec![7u8; 1000]),
                "/gone" => MockResponse::status(410),
                "/away" => MockResponse::redirect("https://evil.example/x"),
                "/big" => MockResponse::bytes(vec![0u8; 5000]),
                _ => MockResponse::status(500),
            }
        });
        let rules = DownloadRules {
            https_only: false,
            host_suffixes: vec!["127.0.0.1".into()],
        };
        let mut downloader = Downloader::new(rules).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.jpg");
        let stop = AtomicBool::new(false);
        assert_eq!(
            downloader
                .fetch(&format!("{}/ok", server.url()), &dest, &stop)
                .unwrap(),
            1000
        );
        assert_eq!(std::fs::read(&dest).unwrap().len(), 1000);
        assert!(matches!(
            downloader.fetch(&format!("{}/gone", server.url()), &dest, &stop),
            Err(NetError::Expired(410))
        ));
        assert!(matches!(
            downloader.fetch(&format!("{}/away", server.url()), &dest, &stop),
            Err(NetError::Rejected(_))
        ));
        assert!(matches!(
            downloader.fetch(&format!("{}/x", server.url()), &dest, &stop),
            Err(NetError::Unreachable(_))
        ));
        downloader.cap = 4096;
        let big = dir.path().join("big.jpg");
        assert!(matches!(
            downloader.fetch(&format!("{}/big", server.url()), &big, &stop),
            Err(NetError::Rejected(_))
        ));
        assert!(!big.exists());
        assert!(!dir.path().join("big.jpg.part").exists());
        // Not the picture host: never even asked.
        let before = hits.load(Ordering::Relaxed);
        assert!(matches!(
            downloader.fetch("https://example.com/x", &dest, &stop),
            Err(NetError::Rejected(_))
        ));
        assert_eq!(hits.load(Ordering::Relaxed), before);
    }
}
