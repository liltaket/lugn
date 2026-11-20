//! Whether the focused window is a game, in which case the barrier stays
//! disarmed and the screen edge behaves normally.

/// The active window as the KWin script reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub resource_class: String,
    pub desktop_file: String,
    pub fullscreen: bool,
}

impl Window {
    /// The name to log: the window class, else the desktop file.
    pub fn label(&self) -> &str {
        if self.resource_class.is_empty() {
            &self.desktop_file
        } else {
            &self.resource_class
        }
    }
}

/// Ids compare case-insensitively, and a desktop file name matches with or
/// without its `.desktop` suffix.
pub fn normalize_id(id: &str) -> String {
    let id = id.trim().to_lowercase();
    match id.strip_suffix(".desktop") {
        Some(stem) => stem.to_string(),
        None => id,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    /// Normalized with [`normalize_id`].
    pub game_app_ids: Vec<String>,
    /// Normalized with [`normalize_id`].
    pub fullscreen_ok_app_ids: Vec<String>,
}

impl Policy {
    pub fn new(game_app_ids: &[String], fullscreen_ok_app_ids: &[String]) -> Self {
        let norm = |ids: &[String]| {
            ids.iter()
                .map(|id| normalize_id(id))
                .filter(|id| !id.is_empty())
                .collect()
        };
        Self {
            game_app_ids: norm(game_app_ids),
            fullscreen_ok_app_ids: norm(fullscreen_ok_app_ids),
        }
    }

    /// Why capture must stay off for this window, or `None` to allow it.
    pub fn blocked_by(&self, window: &Window) -> Option<String> {
        let class = normalize_id(&window.resource_class);
        let desktop = normalize_id(&window.desktop_file);
        let listed = |list: &[String]| {
            [&class, &desktop]
                .iter()
                .any(|id| !id.is_empty() && list.contains(id))
        };
        let why = if class.starts_with("steam_app_") {
            "Steam game"
        } else if listed(&self.game_app_ids) {
            "game list"
        } else if class.ends_with(".exe") {
            "Wine"
        } else if window.fullscreen && !listed(&self.fullscreen_ok_app_ids) {
            "fullscreen"
        } else {
            return None;
        };
        Some(format!("{} ({why})", window.label()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        let ids = |s: &[&str]| s.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        Policy::new(
            &ids(&["gamescope", "net.lutris.Lutris", "steam_proton"]),
            &ids(&["zen", "firefox_firefox", "org.videolan.VLC", " mpv "]),
        )
    }

    fn window(class: &str, desktop: &str, fullscreen: bool) -> Window {
        Window {
            resource_class: class.into(),
            desktop_file: desktop.into(),
            fullscreen,
        }
    }

    fn blocked(class: &str, desktop: &str, fullscreen: bool) -> Option<String> {
        policy().blocked_by(&window(class, desktop, fullscreen))
    }

    #[test]
    fn ordinary_windows_are_allowed() {
        assert_eq!(blocked("com.t3tools.T3Code", "", false), None);
        assert_eq!(blocked("zen", "zen", false), None);
        assert_eq!(blocked("", "", false), None);
    }

    #[test]
    fn fullscreen_browsers_and_players_are_allowed() {
        assert_eq!(blocked("zen", "zen", true), None);
        assert_eq!(blocked("firefox_firefox", "firefox_firefox", true), None);
        assert_eq!(blocked("vlc", "org.videolan.VLC.desktop", true), None);
        assert_eq!(blocked("MPV", "", true), None);
    }

    #[test]
    fn fullscreen_unknown_apps_are_blocked() {
        assert_eq!(
            blocked("SomeGame", "", true).as_deref(),
            Some("SomeGame (fullscreen)")
        );
        assert_eq!(
            blocked("", "org.example.Thing", true).as_deref(),
            Some("org.example.Thing (fullscreen)")
        );
    }

    #[test]
    fn steam_wine_and_listed_games_are_blocked_even_windowed() {
        assert_eq!(
            blocked("steam_app_1086940", "", false).as_deref(),
            Some("steam_app_1086940 (Steam game)")
        );
        assert_eq!(
            blocked("Steam_App_570", "", true).as_deref(),
            Some("Steam_App_570 (Steam game)")
        );
        assert_eq!(
            blocked("setup.EXE", "", false).as_deref(),
            Some("setup.EXE (Wine)")
        );
        assert_eq!(
            blocked("gamescope", "", false).as_deref(),
            Some("gamescope (game list)")
        );
        // A listed desktop file matches whatever the class is.
        assert_eq!(
            blocked("lutris", "NET.LUTRIS.LUTRIS", false).as_deref(),
            Some("lutris (game list)")
        );
        // Being on the fullscreen allow list does not unlist a game.
        assert!(blocked("steam_app_1", "zen", true).is_some());
    }

    #[test]
    fn normalizes_ids() {
        assert_eq!(normalize_id(" Org.KDE.Haruna.desktop "), "org.kde.haruna");
        assert_eq!(normalize_id("zen"), "zen");
        assert_eq!(normalize_id(""), "");
    }
}
