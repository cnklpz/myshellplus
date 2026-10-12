//! Run one command on many hosts concurrently.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde::Serialize;
use tauri::Emitter;

use crate::ssh::{exec, get_conn};
use crate::state::Ctx;
use crate::util::new_id;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostResult {
    pub batch_id: String,
    pub host_id: String,
    /// running | done | error
    pub state: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
    pub duration_ms: u64,
    pub error: Option<String>,
}

pub async fn run_many(ctx: Arc<Ctx>, batch_id: String, host_ids: Vec<String>, command: String, timeout: Duration) -> Vec<HostResult> {
    futures::stream::iter(host_ids)
        .map(|hid| {
            let ctx = ctx.clone();
            let command = command.clone();
            let batch_id = batch_id.clone();
            async move {
                let mut r = HostResult {
                    batch_id,
                    host_id: hid.clone(),
                    state: "running".into(),
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: None,
                    duration_ms: 0,
                    error: None,
                };
                let _ = ctx.app.emit("batch", &r);
                let res = async {
                    let c = get_conn(ctx.clone(), hid.clone()).await?;
                    exec::run(&c, &command, timeout).await
                }
                .await;
                match res {
                    Ok(x) => {
                        r.state = "done".into();
                        r.stdout = x.stdout;
                        r.stderr = x.stderr;
                        r.exit_code = x.exit_code;
                        r.duration_ms = x.duration_ms;
                        if x.timed_out {
                            r.error = Some("执行超时".into());
                        }
                    }
                    Err(e) => {
                        r.state = "error".into();
                        r.error = Some(format!("{e:#}"));
                    }
                }
                let _ = ctx.db.record_history(&hid, &command);
                let _ = ctx.app.emit("batch", &r);
                r
            }
        })
        .buffer_unordered(16)
        .collect()
        .await
}

pub fn start(ctx: Arc<Ctx>, host_ids: Vec<String>, command: String, timeout_secs: u64) -> String {
    let id = new_id();
    let bid = id.clone();
    let _ = ctx.db.audit("user", None, "batch", &format!("{} 台: {}", host_ids.len(), command), "started");
    tokio::spawn(async move {
        run_many(ctx, bid, host_ids, command, Duration::from_secs(timeout_secs.clamp(1, 3600))).await;
    });
    id
}
