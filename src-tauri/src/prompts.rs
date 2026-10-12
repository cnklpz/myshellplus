//! Questions the backend asks the user (host key confirmation, agent approvals).
//! Pending prompts survive a webview reload: the UI re-fetches them with `prompt_list`.

use std::collections::HashMap;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::util::{new_id, now_ms};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEvent {
    pub id: String,
    pub kind: String,
    pub data: Value,
    pub created: i64,
    pub expires: i64,
}

pub struct Prompts {
    app: AppHandle,
    pending: Mutex<HashMap<String, (PromptEvent, oneshot::Sender<Value>)>>,
}

impl Prompts {
    pub fn new(app: AppHandle) -> Self {
        Self { app, pending: Mutex::new(HashMap::new()) }
    }

    /// Ask the user; returns `None` on timeout or if the UI dismissed it.
    pub async fn ask(&self, kind: &str, data: Value, timeout: Duration) -> Option<Value> {
        let (tx, rx) = oneshot::channel();
        let ev = PromptEvent {
            id: new_id(),
            kind: kind.into(),
            data,
            created: now_ms(),
            expires: now_ms() + timeout.as_millis() as i64,
        };
        self.pending.lock().insert(ev.id.clone(), (ev.clone(), tx));
        let _ = self.app.emit("prompt", &ev);
        // Removes the prompt from the UI however this ends, including when the caller's
        // future is dropped (e.g. an outer timeout), so no dead prompt is left behind.
        let _closer = Closer { prompts: self, id: ev.id };
        let res = tokio::time::timeout(timeout, rx).await;
        match res {
            Ok(Ok(v)) => Some(v),
            _ => None,
        }
    }

    pub fn answer(&self, id: &str, value: Value) {
        if let Some((_, tx)) = self.pending.lock().remove(id) {
            let _ = tx.send(value);
        }
    }

    pub fn list(&self) -> Vec<PromptEvent> {
        let mut v: Vec<_> = self.pending.lock().values().map(|(e, _)| e.clone()).collect();
        v.sort_by_key(|e| e.created);
        v
    }
}

struct Closer<'a> {
    prompts: &'a Prompts,
    id: String,
}

impl Drop for Closer<'_> {
    fn drop(&mut self) {
        self.prompts.pending.lock().remove(&self.id);
        let _ = self.prompts.app.emit("prompt-closed", &self.id);
    }
}
