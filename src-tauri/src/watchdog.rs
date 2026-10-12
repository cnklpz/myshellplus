//! Self-healing UI: the webview pings `ui_heartbeat` every few seconds. If a visible window stops
//! pinging (renderer crashed / hung → white or black screen), reload it. SSH sessions live in Rust,
//! so the reloaded UI simply re-attaches to them.

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::util::now_ms;

static LAST_BEAT: AtomicI64 = AtomicI64::new(0);
// > 60s: background windows may only run timers once a minute.
const STALE_MS: i64 = 90_000;

pub fn beat() {
    LAST_BEAT.store(now_ms(), Ordering::Relaxed);
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(10));
        let last = LAST_BEAT.load(Ordering::Relaxed);
        if last == 0 || now_ms() - last < STALE_MS {
            continue;
        }
        let Some(w) = app.get_webview_window("main") else { continue };
        let visible = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true);
        if visible {
            log::error!(target: "crash", "界面无响应 {}s，已自动重载", (now_ms() - last) / 1000);
            let _ = w.reload();
            LAST_BEAT.store(now_ms(), Ordering::Relaxed); // grace period for the reload
        }
    });
}
