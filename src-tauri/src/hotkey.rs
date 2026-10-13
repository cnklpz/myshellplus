//! System-wide hotkeys: show/hide the main window, and a hold-to-pick terminal switcher.
//!
//! The switcher works like Alt+Tab: pressing its hotkey asks the "switcher" window to load the
//! list; once it is on screen, the modifiers of the hotkey are polled and releasing them picks the
//! highlighted entry. Pressing the hotkey again while held moves to the next entry.

use serde::{Deserialize, Serialize};

use crate::db::Db;

#[cfg(desktop)]
#[path = "hotkey_desktop.rs"]
mod imp;
#[cfg(mobile)]
#[path = "hotkey_mobile.rs"]
mod imp;
pub use imp::*;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct HotkeySettings {
    /// Show / hide the main window ("" = off)
    pub toggle: String,
    /// Hold to pick a terminal ("" = off)
    pub switcher: String,
    /// Switcher lists only open terminals (otherwise also servers without one)
    pub open_only: bool,
}

impl Default for HotkeySettings {
    fn default() -> Self {
        Self { toggle: "Ctrl+Alt+M".into(), switcher: "Alt+Backquote".into(), open_only: true }
    }
}

/// Registration result per hotkey: None = ok / off, Some(reason) = not active.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    pub toggle_error: Option<String>,
    pub switcher_error: Option<String>,
}

pub fn settings(db: &Db) -> HotkeySettings {
    db.setting_or_default("hotkeys")
}

