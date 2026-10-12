//! Interactive terminal sessions. Sessions live in the Rust process: output is kept in a
//! ring buffer and replayed when the UI (re)attaches, so a webview reload never kills a shell.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Result, anyhow};
use parking_lot::Mutex;
use russh::client::Msg;
use russh::{ChannelMsg, ChannelWriteHalf, Pty};
use serde::Serialize;
use tauri::Emitter;
use tauri::ipc::{Channel, Response};
use tokio::sync::Notify;

use crate::ssh::get_conn;
use crate::state::Ctx;
use crate::util::{new_id, now_ms};

const RING_CAP: usize = 512 * 1024;
const PENDING_CAP: usize = 8 * 1024 * 1024;

pub struct TermSession {
    pub id: String,
    pub host_id: String,
    pub created: i64,
    writer: ChannelWriteHalf<Msg>,
    ring: Mutex<VecDeque<u8>>,
    pending: Mutex<Vec<u8>>,
    notify: Notify,
    sink: Mutex<Option<Channel<Response>>>,
    alive: AtomicBool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    pub id: String,
    pub host_id: String,
    pub created: i64,
    pub alive: bool,
}

impl TermSession {
    fn push(&self, data: &[u8]) {
        {
            let mut r = self.ring.lock();
            r.extend(data);
            let over = r.len().saturating_sub(RING_CAP);
            if over > 0 {
                r.drain(..over);
            }
        }
        let mut p = self.pending.lock();
        if p.len() + data.len() <= PENDING_CAP {
            p.extend_from_slice(data);
        }
        drop(p);
        self.notify.notify_one();
    }

    pub fn info(&self) -> TermInfo {
        TermInfo {
            id: self.id.clone(),
            host_id: self.host_id.clone(),
            created: self.created,
            alive: self.alive.load(Ordering::Relaxed),
        }
    }

    /// Plain-text tail of the output (ANSI stripped), used by the agent API.
    pub fn tail_text(&self, max_lines: usize) -> String {
        let raw: Vec<u8> = self.ring.lock().iter().copied().collect();
        let text = strip_ansi(&String::from_utf8_lossy(&raw));
        let lines: Vec<&str> = text.lines().collect();
        let start = lines.len().saturating_sub(max_lines);
        lines[start..].join("\n")
    }

    pub async fn write(&self, data: &[u8]) -> Result<()> {
        self.writer.data_bytes(data.to_vec()).await.map_err(|e| anyhow!("写入失败: {e}"))
    }
}

pub fn strip_ansi(s: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]|\r").unwrap()
    });
    re.replace_all(s, "").into_owned()
}

#[derive(Default)]
pub struct Terms {
    map: Mutex<HashMap<String, Arc<TermSession>>>,
}

impl Terms {
    pub fn get(&self, id: &str) -> Result<Arc<TermSession>> {
        self.map.lock().get(id).cloned().ok_or_else(|| anyhow!("终端会话不存在"))
    }

    pub fn list(&self) -> Vec<TermInfo> {
        let mut v: Vec<_> = self.map.lock().values().map(|s| s.info()).collect();
        v.sort_by_key(|s| s.created);
        v
    }

    pub fn remove(&self, id: &str) -> Option<Arc<TermSession>> {
        self.map.lock().remove(id)
    }
}

pub async fn open(ctx: Arc<Ctx>, host_id: String, cols: u32, rows: u32) -> Result<TermInfo> {
    let conn = get_conn(ctx.clone(), host_id.clone()).await?;
    let ch = conn.handle.channel_open_session().await?;
    ch.request_pty(
        true,
        "xterm-256color",
        cols.max(10),
        rows.max(4),
        0,
        0,
        &[(Pty::ECHO, 1), (Pty::TTY_OP_ISPEED, 115200), (Pty::TTY_OP_OSPEED, 115200)],
    )
    .await?;
    let _ = ch.set_env(false, "LANG", "en_US.UTF-8").await;
    let _ = ch.set_env(false, "COLORTERM", "truecolor").await;
    ch.request_shell(true).await?;
    let (mut reader, writer) = ch.split();

    let s = Arc::new(TermSession {
        id: new_id(),
        host_id,
        created: now_ms(),
        writer,
        ring: Mutex::new(VecDeque::with_capacity(64 * 1024)),
        pending: Mutex::new(Vec::new()),
        notify: Notify::new(),
        sink: Mutex::new(None),
        alive: AtomicBool::new(true),
    });
    ctx.terms.map.lock().insert(s.id.clone(), s.clone());

    // Reader: SSH -> ring buffer + pending.
    let rs = s.clone();
    let rctx = ctx.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = reader.wait().await {
            match msg {
                ChannelMsg::Data { data } => rs.push(&data),
                ChannelMsg::ExtendedData { data, .. } => rs.push(&data),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        rs.alive.store(false, Ordering::Relaxed);
        rs.notify.notify_one();
        let _ = rctx.app.emit("term-exit", &rs.id);
    });

    // Flusher: coalesce output into ~60fps batches so heavy output can't flood the webview.
    let fs = s.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            fs.notify.notified().await;
            tokio::time::sleep(Duration::from_millis(12)).await;
            let chunk = std::mem::take(&mut *fs.pending.lock());
            if !chunk.is_empty() {
                if let Some(sink) = fs.sink.lock().as_ref() {
                    let _ = sink.send(Response::new(chunk));
                }
            }
            if !fs.alive.load(Ordering::Relaxed) && fs.pending.lock().is_empty() {
                break;
            }
        }
    });

    Ok(s.info())
}

/// Attach the UI to a session; replays buffered output first.
pub fn attach(ctx: &Ctx, id: &str, sink: Channel<Response>) -> Result<TermInfo> {
    let s = ctx.terms.get(id)?;
    let replay: Vec<u8> = s.ring.lock().iter().copied().collect();
    s.pending.lock().clear();
    if !replay.is_empty() {
        let _ = sink.send(Response::new(replay));
    }
    *s.sink.lock() = Some(sink);
    Ok(s.info())
}

pub async fn resize(ctx: &Ctx, id: &str, cols: u32, rows: u32) -> Result<()> {
    let s = ctx.terms.get(id)?;
    s.writer.window_change(cols.max(10), rows.max(4), 0, 0).await?;
    Ok(())
}

pub async fn close(ctx: &Ctx, id: &str) -> Result<()> {
    if let Some(s) = ctx.terms.remove(id) {
        s.alive.store(false, Ordering::Relaxed);
        let _ = s.writer.close().await;
        s.notify.notify_one();
    }
    Ok(())
}
