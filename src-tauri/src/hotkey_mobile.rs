//! Mobile: no global hotkeys or switcher window; the commands are no-ops.

use tauri::AppHandle;

use super::{HotkeySettings, HotkeyStatus};
use crate::db::Db;

pub fn status() -> HotkeyStatus {
    HotkeyStatus::default()
}

pub fn apply(_app: &AppHandle, _s: &HotkeySettings) -> HotkeyStatus {
    HotkeyStatus::default()
}

pub fn suspend(_app: &AppHandle, _db: &Db, _on: bool) {}

pub fn show_main(_app: &AppHandle) {}

pub fn pending() -> Option<serde_json::Value> {
    None
}

pub fn present(_app: &AppHandle, _height: f64) {}

pub fn hide_switcher(_app: &AppHandle) {}
