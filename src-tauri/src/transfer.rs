//! SFTP file browsing and transfers with progress events.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use parking_lot::Mutex;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh::{exec, get_conn};
use crate::state::Ctx;
use crate::util::{new_id, sh_quote};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    pub mtime: u32,
    pub perms: u32,
    pub owner: String,
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

pub async fn list_dir(ctx: Arc<Ctx>, host_id: String, path: String) -> Result<(String, Vec<FileEntry>)> {
    let conn = get_conn(ctx, host_id).await?;
    let sftp = conn.sftp().await?;
    let path = if path.is_empty() { "." } else { path.as_str() };
    let real = sftp.canonicalize(path).await?;
    let mut out = Vec::new();
    for e in sftp.read_dir(real.clone()).await? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let md = e.metadata();
        let ft = e.file_type();
        let full = join(&real, &name);
        let mut is_dir = ft.is_dir();
        if ft.is_symlink() {
            if let Ok(t) = sftp.metadata(full.clone()).await {
                is_dir = t.is_dir();
            }
        }
        out.push(FileEntry {
            name,
            path: full,
            is_dir,
            is_link: ft.is_symlink(),
            size: md.size.unwrap_or(0),
            mtime: md.mtime.unwrap_or(0),
            perms: md.permissions.unwrap_or(0) & 0o7777,
            owner: md.user.clone().unwrap_or_else(|| md.uid.map(|u| u.to_string()).unwrap_or_default()),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok((real, out))
}

pub async fn read_text(ctx: Arc<Ctx>, host_id: String, path: String) -> Result<String> {
    let conn = get_conn(ctx, host_id).await?;
    let sftp = conn.sftp().await?;
    let md = sftp.metadata(path.clone()).await?;
    if md.size.unwrap_or(0) > 5 * 1024 * 1024 {
        bail!("文件超过 5MB，请下载后查看");
    }
    let data = sftp.read(path).await?;
    String::from_utf8(data).map_err(|_| anyhow!("不是 UTF-8 文本文件"))
}

pub async fn write_text(ctx: Arc<Ctx>, host_id: String, path: String, content: String) -> Result<()> {
    let conn = get_conn(ctx, host_id).await?;
    let sftp = conn.sftp().await?;
    let mut f = sftp
        .open_with_flags(path, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
        .await?;
    f.write_all(content.as_bytes()).await?;
    f.shutdown().await?;
    Ok(())
}

pub async fn mkdir(ctx: Arc<Ctx>, host_id: String, path: String) -> Result<()> {
    let conn = get_conn(ctx, host_id).await?;
    conn.sftp().await?.create_dir(path).await?;
    Ok(())
}

pub async fn rename(ctx: Arc<Ctx>, host_id: String, from: String, to: String) -> Result<()> {
    let conn = get_conn(ctx, host_id).await?;
    conn.sftp().await?.rename(from, to).await?;
    Ok(())
}

pub async fn remove(ctx: Arc<Ctx>, host_id: String, paths: Vec<String>) -> Result<()> {
    let conn = get_conn(ctx, host_id).await?;
    for p in &paths {
        if p.trim().is_empty() || p.trim() == "/" {
            bail!("拒绝删除根目录");
        }
    }
    let cmd = format!("rm -rf -- {}", paths.iter().map(|p| sh_quote(p)).collect::<Vec<_>>().join(" "));
    let r = exec::run(&conn, &cmd, Duration::from_secs(120)).await?;
    if r.exit_code != Some(0) {
        bail!("删除失败: {}", r.stderr.trim());
    }
    Ok(())
}

pub async fn chmod(ctx: Arc<Ctx>, host_id: String, path: String, mode: u32) -> Result<()> {
    let conn = get_conn(ctx, host_id).await?;
    let cmd = format!("chmod {:o} -- {}", mode & 0o7777, sh_quote(&path));
    let r = exec::run(&conn, &cmd, Duration::from_secs(30)).await?;
    if r.exit_code != Some(0) {
        bail!("修改权限失败: {}", r.stderr.trim());
    }
    Ok(())
}

// ---------- transfers ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    pub id: String,
    pub host_id: String,
    pub direction: String,
    pub local: String,
    pub remote: String,
    pub total: u64,
    pub done: u64,
    pub speed: f64,
    pub state: String,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Transfers {
    map: Mutex<HashMap<String, (TransferInfo, Arc<AtomicBool>)>>,
}

impl Transfers {
    pub fn list(&self) -> Vec<TransferInfo> {
        self.map.lock().values().map(|(t, _)| t.clone()).collect()
    }
    pub fn cancel(&self, id: &str) {
        if let Some((_, c)) = self.map.lock().get(id) {
            c.store(true, Ordering::Relaxed);
        }
    }
    pub fn clear_finished(&self) {
        self.map.lock().retain(|_, (t, _)| t.state == "running");
    }
    fn update(&self, ctx: &Ctx, t: &TransferInfo) {
        if let Some(e) = self.map.lock().get_mut(&t.id) {
            e.0 = t.clone();
        }
        let _ = ctx.app.emit("transfer", t);
    }
}

/// Start an upload (`direction = "upload"`) or download. Returns the transfer id at once.
pub fn start(ctx: Arc<Ctx>, host_id: String, direction: String, local: String, remote: String) -> String {
    let id = new_id();
    let cancel = Arc::new(AtomicBool::new(false));
    let info = TransferInfo {
        id: id.clone(),
        host_id,
        direction,
        local,
        remote,
        total: 0,
        done: 0,
        speed: 0.0,
        state: "running".into(),
        error: None,
    };
    ctx.transfers.map.lock().insert(id.clone(), (info.clone(), cancel.clone()));
    tauri::async_runtime::spawn(async move {
        let mut t = info;
        let res = run_transfer(&ctx, &mut t, &cancel).await;
        match res {
            Ok(()) => t.state = "done".into(),
            Err(e) => {
                t.state = if cancel.load(Ordering::Relaxed) { "cancelled".into() } else { "error".into() };
                t.error = Some(format!("{e:#}"));
            }
        }
        ctx.transfers.update(&ctx, &t);
    });
    id
}

async fn run_transfer(ctx: &Arc<Ctx>, t: &mut TransferInfo, cancel: &AtomicBool) -> Result<()> {
    let conn = get_conn(ctx.clone(), t.host_id.clone()).await?;
    let sftp = conn.sftp().await?;
    let mut buf = vec![0u8; 256 * 1024];
    let start = Instant::now();
    let mut last_emit = Instant::now();

    macro_rules! pump {
        ($src:expr, $dst:expr) => {{
            loop {
                if cancel.load(Ordering::Relaxed) {
                    bail!("已取消");
                }
                let n = $src.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                $dst.write_all(&buf[..n]).await?;
                t.done += n as u64;
                if last_emit.elapsed() > Duration::from_millis(250) {
                    t.speed = t.done as f64 / start.elapsed().as_secs_f64().max(0.001);
                    ctx.transfers.update(ctx, t);
                    last_emit = Instant::now();
                }
            }
            $dst.flush().await?;
            $dst.shutdown().await?;
        }};
    }

    if t.direction == "upload" {
        let mut src = tokio::fs::File::open(&t.local).await?;
        t.total = src.metadata().await?.len();
        let mut dst = sftp
            .open_with_flags(t.remote.clone(), OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
            .await?;
        pump!(src, dst);
    } else {
        let mut src = sftp.open(t.remote.clone()).await?;
        t.total = src.metadata().await?.size.unwrap_or(0);
        let local = PathBuf::from(&t.local);
        if let Some(p) = local.parent() {
            tokio::fs::create_dir_all(p).await?;
        }
        let mut dst = tokio::fs::File::create(&local).await?;
        pump!(src, dst);
    }
    t.speed = t.done as f64 / start.elapsed().as_secs_f64().max(0.001);
    Ok(())
}
