use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Application {
    pub app_id: String,
    pub resource_class: String,
    pub fullscreen: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Audio {
    pub playing: bool,
    pub applications: Vec<String>,
    pub roles: Vec<String>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Media {
    pub player: String,
    pub identity: Option<String>,
    pub desktop_entry: Option<String>,
    pub playback_status: Option<String>,
    pub title: Option<String>,
    pub artists: Option<Vec<String>>,
    pub album: Option<String>,
    pub content_type: Option<String>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Observations {
    pub network_online: Option<bool>,
    pub locked: Option<bool>,
    pub idle: Option<bool>,
    pub active_application: Option<Application>,
    pub audio: Option<Audio>,
    pub media: Option<Vec<Media>>,
}
#[derive(Clone, Debug)]
pub enum Event {
    Network(Option<bool>),
    Lock(Option<bool>),
    Idle(Option<bool>),
    Application(Option<Application>),
    Audio(Option<Audio>),
    Media(Option<Vec<Media>>),
}
impl Observations {
    pub fn apply(&mut self, event: Event) -> bool {
        let previous = self.clone();
        match event {
            Event::Network(v) => self.network_online = v,
            Event::Lock(v) => self.locked = v,
            Event::Idle(v) => self.idle = v,
            Event::Application(v) => self.active_application = v,
            Event::Audio(v) => self.audio = v,
            Event::Media(v) => self.media = v,
        }
        *self != previous
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Inference {
    pub activity: String,
    pub basis: String,
}
// Deliberately conservative: fullscreen alone never identifies video or gaming.
pub fn classify(
    s: &Observations,
    games: &[String],
    video: &[String],
    music: &[String],
) -> Inference {
    let result = if s.locked == Some(true) || s.idle == Some(true) {
        ("idle", "locked_or_idle")
    } else if let Some(app) = &s.active_application {
        if games.contains(&app.app_id) || app.resource_class.starts_with("steam_app_") {
            ("gaming", "application_rule")
        } else if video.contains(&app.app_id) && playing(s) {
            ("video", "application_rule_and_playback")
        } else if music.contains(&app.app_id) && playing(s) {
            ("music", "application_rule_and_playback")
        } else {
            media_class(s).unwrap_or(("desktop", "active_application"))
        }
    } else {
        media_class(s).unwrap_or(("unknown", "insufficient_evidence"))
    };
    Inference {
        activity: result.0.into(),
        basis: result.1.into(),
    }
}
fn playing(s: &Observations) -> bool {
    s.audio.as_ref().is_some_and(|a| a.playing)
        || s.media.as_ref().is_some_and(|m| {
            m.iter()
                .any(|p| p.playback_status.as_deref() == Some("Playing"))
        })
}
fn media_class(s: &Observations) -> Option<(&'static str, &'static str)> {
    // Only explicit MPRIS content type, never titles or browser identity guesses.
    let players = s.media.as_ref()?;
    if players.iter().any(|p| {
        p.playback_status.as_deref() == Some("Playing")
            && p.content_type
                .as_deref()
                .is_some_and(|t| t.starts_with("video/"))
    }) {
        return Some(("video", "mpris_content_type"));
    }
    if players.iter().any(|p| {
        p.playback_status.as_deref() == Some("Playing")
            && p.content_type
                .as_deref()
                .is_some_and(|t| t.starts_with("audio/"))
    }) {
        return Some(("music", "mpris_content_type"));
    }
    None
}
#[derive(Serialize, Deserialize, Debug)]
pub struct Snapshot {
    pub schema_version: u8,
    pub device_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub reason: String,
    pub heartbeat_interval_ms: u64,
    pub observations: Observations,
    pub inference: Inference,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct Availability {
    pub schema_version: u8,
    pub device_id: String,
    pub session_id: String,
    pub status: String,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct ChangeNotification {
    pub schema_version: u8,
    pub device_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub r#type: String,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepted_contract_fixtures_match_wire_types() {
        for bytes in [
            include_str!("../protocol/state.example.json"),
            include_str!("../protocol/state-unknown.example.json"),
        ] {
            let expected: serde_json::Value = serde_json::from_str(bytes).unwrap();
            let state: Snapshot = serde_json::from_str(bytes).unwrap();
            assert_eq!(serde_json::to_value(state).unwrap(), expected);
        }
        let unknown: Snapshot =
            serde_json::from_str(include_str!("../protocol/state-unknown.example.json")).unwrap();
        assert_eq!(unknown.observations, Observations::default());
        for bytes in [
            include_str!("../protocol/availability-online.example.json"),
            include_str!("../protocol/availability-offline.example.json"),
        ] {
            let a: Availability = serde_json::from_str(bytes).unwrap();
            assert_eq!(
                serde_json::to_value(a).unwrap(),
                serde_json::from_str::<serde_json::Value>(bytes).unwrap()
            );
        }
        let bytes = include_str!("../protocol/events.example.json");
        let a: ChangeNotification = serde_json::from_str(bytes).unwrap();
        assert_eq!(
            serde_json::to_value(a).unwrap(),
            serde_json::from_str::<serde_json::Value>(bytes).unwrap()
        );
    }
    #[test]
    fn explicit_media_types_and_app_rules_require_playback() {
        let mut s = Observations {
            active_application: Some(Application {
                app_id: "video-player".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let videos = vec!["video-player".into()];
        assert_eq!(classify(&s, &[], &videos, &[]).activity, "desktop");
        s.audio = Some(Audio {
            playing: true,
            ..Default::default()
        });
        assert_eq!(classify(&s, &[], &videos, &[]).activity, "video");
        s.active_application = None;
        s.media = Some(vec![Media {
            playback_status: Some("Playing".into()),
            content_type: Some("audio/flac".into()),
            ..Default::default()
        }]);
        assert_eq!(classify(&s, &[], &[], &[]).activity, "music");
        s.media.as_mut().unwrap()[0].playback_status = Some("Paused".into());
        assert_eq!(classify(&s, &[], &[], &[]).activity, "unknown");
    }
    #[test]
    fn unknown_and_fullscreen_do_not_invent_activity() {
        let mut s = Observations::default();
        assert_eq!(classify(&s, &[], &[], &[]).activity, "unknown");
        s.active_application = Some(Application {
            app_id: "firefox".into(),
            fullscreen: true,
            ..Default::default()
        });
        assert_eq!(classify(&s, &[], &[], &[]).activity, "desktop");
        s.active_application.as_mut().unwrap().resource_class = "steam_app_123".into();
        assert_eq!(classify(&s, &[], &[], &[]).activity, "gaming");
        s.locked = Some(true);
        assert_eq!(classify(&s, &[], &[], &[]).activity, "idle");
    }
    #[test]
    fn deduplicates_and_clears_observations() {
        let mut s = Observations::default();
        assert!(s.apply(Event::Lock(Some(false))));
        assert!(!s.apply(Event::Lock(Some(false))));
        assert!(s.apply(Event::Lock(None)));
    }
}
