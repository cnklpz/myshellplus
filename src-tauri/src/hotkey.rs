//! System-wide hotkeys: show/hide the main window, and a hold-to-pick terminal switcher.
//!
//! The switcher works like Alt+Tab: pressing its hotkey asks the "switcher" window to load the
//! list; once it is on screen, the modifiers of the hotkey are polled and releasing them picks the
//! highlighted entry. Pressing the hotkey again while held moves to the next entry.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::db::Db;

const SWITCHER: &str = "switcher";

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

#[derive(Default)]
struct Active {
    toggle: Option<Shortcut>,
    switcher: Option<Shortcut>,
    open_only: bool,
    status: HotkeyStatus,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
/// Bumped each time the switcher opens or closes: stops a stale release watcher.
static SWITCH_SEQ: AtomicU64 = AtomicU64::new(0);
static SWITCH_OPEN: AtomicBool = AtomicBool::new(false);
/// Last "switcher-show" payload not yet presented (the window may still be loading).
static PENDING: Mutex<Option<serde_json::Value>> = Mutex::new(None);

pub fn settings(db: &Db) -> HotkeySettings {
    db.setting("hotkeys").ok().flatten().unwrap_or_default()
}

pub fn status() -> HotkeyStatus {
    ACTIVE.lock().as_ref().map(|a| a.status.clone()).unwrap_or_default()
}

/// Plugin handler for every registered hotkey.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, sc, ev| {
            let (is_toggle, is_switcher) = {
                let g = ACTIVE.lock();
                let Some(a) = g.as_ref() else { return };
                (a.toggle.as_ref().is_some_and(|t| t.id() == sc.id()), a.switcher.as_ref().is_some_and(|t| t.id() == sc.id()))
            };
            match ev.state {
                ShortcutState::Pressed if is_toggle => toggle_main(app),
                ShortcutState::Pressed if is_switcher => switcher_press(app),
                // A hotkey without modifiers is "held" by its own key.
                ShortcutState::Released if is_switcher && sc.mods.is_empty() && SWITCH_OPEN.load(Ordering::Relaxed) => {
                    let _ = app.emit_to(SWITCHER, "switcher-commit", ());
                }
                _ => {}
            }
        })
        .build()
}

/// (Re)register the hotkeys from `s`.
pub fn apply(app: &AppHandle, s: &HotkeySettings) -> HotkeyStatus {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut active = Active { open_only: s.open_only, ..Default::default() };
    let reg = |spec: &str, other: Option<&Shortcut>| -> (Option<Shortcut>, Option<String>) {
        if spec.trim().is_empty() {
            return (None, None);
        }
        let sc: Shortcut = match spec.parse() {
            Ok(sc) => sc,
            Err(_) => return (None, Some("无法识别的按键".into())),
        };
        if other.is_some_and(|o| o.id() == sc.id()) {
            return (None, Some("与另一个快捷键重复".into()));
        }
        match gs.register(sc) {
            Ok(()) => (Some(sc), None),
            Err(e) => {
                log::warn!("hotkey {spec}: {e}");
                (None, Some("已被其他程序占用".into()))
            }
        }
    };
    let (t, te) = reg(&s.toggle, None);
    let (w, we) = reg(&s.switcher, t.as_ref());
    active.toggle = t;
    active.switcher = w;
    active.status = HotkeyStatus { toggle_error: te, switcher_error: we };
    let status = active.status.clone();
    *ACTIVE.lock() = Some(active);
    if w.is_some() {
        let _ = ensure_switcher(app);
    }
    status
}

/// While the settings page records a new combination, the hotkeys are released so the page sees every key.
pub fn suspend(app: &AppHandle, db: &Db, on: bool) {
    if on {
        let _ = app.global_shortcut().unregister_all();
        if let Some(a) = ACTIVE.lock().as_mut() {
            a.toggle = None;
            a.switcher = None;
        }
    } else {
        apply(app, &settings(db));
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let shown = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
    if shown && w.is_focused().unwrap_or(false) {
        let _ = w.hide();
    } else {
        show_main(app);
    }
}

// ---------------- switcher ----------------

fn ensure_switcher(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(SWITCHER) {
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, SWITCHER, WebviewUrl::App("index.html".into()))
        .title("MyShell+ 切换终端")
        .inner_size(480.0, 360.0)
        .decorations(false)
        .shadow(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .background_color(tauri::window::Color(10, 12, 15, 255))
        .build()
}

fn switcher_press(app: &AppHandle) {
    let Ok(w) = ensure_switcher(app) else { return };
    if SWITCH_OPEN.load(Ordering::Relaxed) && w.is_visible().unwrap_or(false) {
        let _ = app.emit_to(SWITCHER, "switcher-next", ());
        return;
    }
    SWITCH_SEQ.fetch_add(1, Ordering::Relaxed);
    let main_focused = app
        .get_webview_window("main")
        .is_some_and(|m| m.is_visible().unwrap_or(false) && m.is_focused().unwrap_or(false));
    let open_only = ACTIVE.lock().as_ref().is_some_and(|a| a.open_only);
    // The window shows itself (switcher_present) once its list is rendered and sized.
    let payload = json!({ "openOnly": open_only, "mainFocused": main_focused });
    *PENDING.lock() = Some(payload.clone());
    let _ = app.emit_to(SWITCHER, "switcher-show", payload);
}

/// A switcher window that just loaded asks whether it was summoned meanwhile.
pub fn pending() -> Option<serde_json::Value> {
    PENDING.lock().clone()
}

/// Called by the switcher window when its list is ready: put it on screen and watch the hotkey's modifiers.
pub fn present(app: &AppHandle, height: f64) {
    let Some(w) = app.get_webview_window(SWITCHER) else { return };
    if PENDING.lock().take().is_none() {
        return; // cancelled meanwhile
    }
    let _ = w.set_size(tauri::LogicalSize::new(480.0, height.clamp(80.0, 560.0)));
    center_on_cursor(app, &w);
    let _ = w.show();
    let _ = w.set_focus();
    SWITCH_OPEN.store(true, Ordering::Relaxed);
    let seq = SWITCH_SEQ.load(Ordering::Relaxed);
    let mods = ACTIVE.lock().as_ref().and_then(|a| a.switcher).map(|s| s.mods).unwrap_or_default();
    if mods.is_empty() {
        return; // released state comes from the plugin
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // Give up after a minute held down (stuck key state).
        for _ in 0..3000 {
            std::thread::sleep(Duration::from_millis(20));
            if SWITCH_SEQ.load(Ordering::Relaxed) != seq || !SWITCH_OPEN.load(Ordering::Relaxed) {
                return;
            }
            if !mods_down(mods) {
                let _ = app.emit_to(SWITCHER, "switcher-commit", ());
                return;
            }
        }
    });
}

pub fn hide_switcher(app: &AppHandle) {
    PENDING.lock().take();
    SWITCH_OPEN.store(false, Ordering::Relaxed);
    SWITCH_SEQ.fetch_add(1, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window(SWITCHER) {
        let _ = w.hide();
    }
}

fn center_on_cursor(app: &AppHandle, w: &tauri::WebviewWindow) {
    if std::env::var("MYSHELL_TEST_INSTANCE").is_ok() {
        let _ = w.set_position(tauri::PhysicalPosition::new(-20000, -20000));
        return;
    }
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| w.current_monitor().ok().flatten());
    let (Some(m), Ok(size)) = (monitor, w.outer_size()) else { return };
    let (mp, ms) = (m.position(), m.size());
    let x = mp.x + (ms.width as i32 - size.width as i32) / 2;
    // A bit above center, like a launcher.
    let y = mp.y + (ms.height as i32 - size.height as i32) * 2 / 5;
    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
}

#[cfg(windows)]
fn mods_down(m: Modifiers) -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};
    let down = |vk: u16| unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000 != 0;
    (m.contains(Modifiers::CONTROL) && down(VK_CONTROL))
        || (m.contains(Modifiers::ALT) && down(VK_MENU))
        || (m.contains(Modifiers::SHIFT) && down(VK_SHIFT))
        || (m.contains(Modifiers::SUPER) && (down(VK_LWIN) || down(VK_RWIN)))
}

#[cfg(not(windows))]
fn mods_down(_m: Modifiers) -> bool {
    false
}
