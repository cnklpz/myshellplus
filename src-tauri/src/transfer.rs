//! SFTP file browsing, file operations and queued transfers with progress events.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Result, anyhow, bail};
use parking_lot::Mutex;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Semaphore;

use crate::ssh::{Conn, exec, get_conn};
use crate::state::Ctx;
use crate::util::{new_id, sh_quote};

/// Transfers running at once per host; the rest wait in the queue.
const PER_HOST: usize = 3;
/// Remote shell file operations (copy, extract, compress) can take long on big trees.
const OP_TIMEOUT: Duration = Duration::from_secs(1800);

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

fn split_remote(p: &str) -> (&str, &str) {
    match p.trim_end_matches('/').rsplit_once('/') {
        Some(("", name)) => ("/", name),
        Some((dir, name)) => (dir, name),
        None => (".", p),
    }
}

pub async fn list_dir(ctx: Arc<Ctx>, host_id: String, path: String) -> Result<(String, Vec<FileEntry>)> {
    let conn = get_conn(ctx, host_id).await?;
    let sftp = conn.sftp().await?;
    let path = if path.is_empty() { "." } else { path.as_str() };
    let real = sftp.canonicalize(path).await?;
    let mut out = Vec::new();
    let mut links = Vec::new();
    for e in sftp.read_dir(real.clone()).await? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let md = e.metadata();
        let ft = e.file_type();
        if ft.is_symlink() {
            links.push(out.len());
        }
        out.push(FileEntry {
            path: join(&real, &name),
            name,
            is_dir: ft.is_dir(),
            is_link: ft.is_symlink(),
            size: md.size.unwrap_or(0),
            mtime: md.mtime.unwrap_or(0),
            perms: md.permissions.unwrap_or(0) & 0o7777,
            owner: md.user.clone().unwrap_or_else(|| md.uid.map(|u| u.to_string()).unwrap_or_default()),
        });
    }
    // Resolve symlink targets concurrently: one round trip each adds up in /usr/lib-sized dirs.
    let targets = futures::future::join_all(links.iter().map(|&i| sftp.metadata(out[i].path.clone()))).await;
    for (&i, t) in links.iter().zip(targets) {
        if let Ok(t) = t {
            out[i].is_dir = t.is_dir();
            if !t.is_dir() {
                out[i].size = t.size.unwrap_or(0);
            }
        }
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

/// Save a text file the same way uploads do (temp file + rename), so a dropped connection mid-save
/// never leaves the file truncated.
pub async fn write_text(ctx: Arc<Ctx>, host_id: String, path: String, content: String) -> Result<()> {
    let conn = get_conn(ctx, host_id).await?;
    let sftp = conn.sftp().await?;
    let mut buf = vec![0u8; 64 * 1024];
    put_file(&sftp, Links::Ask(&conn), &mut content.as_bytes(), &path, &mut buf, &mut |_| Ok(()), None).await
}

pub async fn mkdir(ctx: Arc<Ctx>, host_id: String, path: String) -> Result<()> {
    let conn = get_conn(ctx, host_id).await?;
    conn.sftp().await?.create_dir(path).await?;
    Ok(())
}

pub async fn rename(ctx: Arc<Ctx>, host_id: String, from: String, to: String) -> Result<()> {
    let conn = get_conn(ctx, host_id).await?;
    let sftp = conn.sftp().await?;
    // SFTP v3 rename may overwrite on some servers: never clobber silently.
    if sftp.symlink_metadata(to.clone()).await.is_ok() {
        bail!("已存在同名项");
    }
    sftp.rename(from, to).await?;
    Ok(())
}

fn check_remove_targets(paths: &[String]) -> Result<()> {
    for p in paths {
        if p.trim().is_empty() || p.trim().trim_end_matches('/').is_empty() {
            bail!("拒绝删除根目录");
        }
    }
    Ok(())
}

pub async fn remove(ctx: Arc<Ctx>, host_id: String, paths: Vec<String>) -> Result<()> {
    check_remove_targets(&paths)?;
    let conn = get_conn(ctx, host_id).await?;
    let cmd = format!("rm -rf -- {}", paths.iter().map(|p| sh_quote(p)).collect::<Vec<_>>().join(" "));
    run_op(&conn, &cmd, "删除失败").await
}

pub async fn chmod(ctx: Arc<Ctx>, host_id: String, path: String, mode: u32) -> Result<()> {
    let conn = get_conn(ctx, host_id).await?;
    let cmd = format!("chmod {:o} -- {}", mode & 0o7777, sh_quote(&path));
    run_op(&conn, &cmd, "修改权限失败").await
}

async fn run_op(conn: &Conn, cmd: &str, what: &str) -> Result<()> {
    let r = exec::run(conn, cmd, OP_TIMEOUT).await?;
    if r.timed_out {
        bail!("{what}: 超时");
    }
    match r.exit_code {
        Some(0) => Ok(()),
        Some(127) => bail!("{what}: 远程主机缺少命令（{}）", r.stderr.trim()),
        _ => bail!("{what}: {}", r.stderr.trim()),
    }
}

// ---------- conflicts and names ----------

/// What to do when the target name already exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Conflict {
    /// Replace a file; merge into a folder.
    #[default]
    Overwrite,
    Skip,
    /// Keep both: the new item gets a numbered name.
    Rename,
}

/// Compound extensions kept together when numbering (`a.tar.gz` → `a (1).tar.gz`).
const MULTI_EXT: &[&str] = &[".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"];

fn numbered(name: &str, n: u32) -> String {
    let lower = name.to_ascii_lowercase();
    let split = MULTI_EXT
        .iter()
        .find(|e| lower.ends_with(*e) && lower.len() > e.len())
        .map(|e| name.len() - e.len())
        .or_else(|| name.rfind('.').filter(|&i| i > 0));
    match split {
        Some(i) => match (name.get(..i), name.get(i..)) {
            (Some(a), Some(b)) => format!("{a} ({n}){b}"),
            _ => format!("{name} ({n})"),
        },
        None => format!("{name} ({n})"),
    }
}

async fn unique_remote(sftp: &SftpSession, path: &str) -> Result<String> {
    let (dir, name) = split_remote(path);
    for n in 1..1000 {
        let cand = join(dir, &numbered(name, n));
        if sftp.symlink_metadata(cand.clone()).await.is_err() {
            return Ok(cand);
        }
    }
    bail!("找不到可用的文件名")
}

async fn unique_local(path: &Path) -> Result<PathBuf> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    for n in 1..1000 {
        let cand = path.with_file_name(numbered(&name, n));
        if !tokio::fs::try_exists(&cand).await.unwrap_or(true) {
            return Ok(cand);
        }
    }
    bail!("找不到可用的文件名")
}

/// Windows device names: `nul`, `con.txt` etc. open the device, not a file, in any folder.
const WIN_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A remote file name made safe as a Windows/Unix file name component. Mirrored by `localName`
/// in FilesPanel.tsx.
fn local_name(name: &str) -> String {
    let mut n: String = name
        .chars()
        .map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    // Windows silently drops trailing dots and spaces, so `a.` and `a` would collide.
    let kept = n.trim_end_matches(['.', ' ']).len();
    if kept < n.len() {
        n.truncate(kept);
        n.push('_');
    }
    let stem = n.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase();
    if WIN_RESERVED.contains(&stem.as_str()) {
        n.insert(0, '_');
    }
    n
}

pub async fn local_exists(paths: Vec<String>) -> Vec<bool> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        out.push(tokio::fs::try_exists(&p).await.unwrap_or(false));
    }
    out
}

// ---------- remote copy / move / archives ----------

pub async fn paste(ctx: Arc<Ctx>, host_id: String, srcs: Vec<String>, dest: String, mov: bool, conflict: Conflict) -> Result<()> {
    let conn = get_conn(ctx, host_id).await?;
    let sftp = conn.sftp().await?;
    let dest = dest.trim_end_matches('/').to_string();
    let dest = if dest.is_empty() { "/".to_string() } else { dest };
    for src in &srcs {
        let src = src.trim_end_matches('/');
        let (parent, name) = split_remote(src);
        if src.is_empty() || name.is_empty() {
            bail!("无效路径");
        }
        if dest == src || dest.starts_with(&format!("{src}/")) {
            bail!("不能放到自身内部: {name}");
        }
        let mut target = join(&dest, name);
        if parent == dest {
            if mov {
                continue;
            }
            target = unique_remote(&sftp, &target).await?;
        }
        let s = sh_quote(src);
        let cmd = match sftp.symlink_metadata(target.clone()).await {
            Err(_) => format!("{} -- {s} {}", if mov { "mv" } else { "cp -a" }, sh_quote(&target)),
            Ok(_) if conflict == Conflict::Skip => continue,
            Ok(_) if conflict == Conflict::Rename => {
                target = unique_remote(&sftp, &target).await?;
                format!("{} -- {s} {}", if mov { "mv" } else { "cp -a" }, sh_quote(&target))
            }
            Ok(old) => {
                let src_dir = sftp.metadata(src.to_string()).await.map(|m| m.is_dir()).unwrap_or(false);
                let t = sh_quote(&target);
                match (src_dir, old.is_dir()) {
                    (true, true) if mov => format!("cp -a -- {s}/. {t}/ && rm -rf -- {s}"),
                    (true, true) => format!("cp -a -- {s}/. {t}/"),
                    (false, false) if mov => format!("mv -f -- {s} {t}"),
                    (false, false) => format!("cp -a -- {s} {t}"),
                    _ => bail!("{name}: 文件与文件夹不能互相覆盖"),
                }
            }
        };
        run_op(&conn, &cmd, if mov { "移动失败" } else { "复制失败" }).await?;
    }
    Ok(())
}

/// Extract command for archive `a` into directory `d`; single-file formats write `d/s`.
type ExtractFn = fn(&str, &str, &str) -> String;

fn extract_cmd(name: &str) -> Option<(usize, ExtractFn)> {
    // Compound suffixes before their single-suffix tails.
    let table: &[(&str, ExtractFn)] = &[
        (".tar.gz", |a, d, _| format!("tar -xzf {a} -C {d}")),
        (".tgz", |a, d, _| format!("tar -xzf {a} -C {d}")),
        (".tar.bz2", |a, d, _| format!("tar -xjf {a} -C {d}")),
        (".tbz2", |a, d, _| format!("tar -xjf {a} -C {d}")),
        (".tar.xz", |a, d, _| format!("tar -xJf {a} -C {d}")),
        (".txz", |a, d, _| format!("tar -xJf {a} -C {d}")),
        (".tar.zst", |a, d, _| format!("tar --zstd -xf {a} -C {d}")),
        (".tar", |a, d, _| format!("tar -xf {a} -C {d}")),
        (".zip", |a, d, _| format!("unzip -o -q {a} -d {d}")),
        (".jar", |a, d, _| format!("unzip -o -q {a} -d {d}")),
        (".war", |a, d, _| format!("unzip -o -q {a} -d {d}")),
        (".7z", |a, d, _| format!("7z x -y -o{d} {a}")),
        (".rar", |a, d, _| format!("unrar x -o+ {a} {d}/")),
        (".gz", |a, d, s| format!("gzip -dc {a} > {d}/{s}")),
        (".bz2", |a, d, s| format!("bzip2 -dc {a} > {d}/{s}")),
        (".xz", |a, d, s| format!("xz -dc {a} > {d}/{s}")),
        (".zst", |a, d, s| format!("zstd -dc {a} > {d}/{s}")),
    ];
    let lower = name.to_ascii_lowercase();
    table
        .iter()
        .find(|(ext, _)| lower.ends_with(ext) && lower.len() > ext.len())
        .map(|&(ext, f)| (ext.len(), f))
}

/// Extract an archive next to itself (`to_folder = false`) or into a new folder named after it.
/// Returns the directory the contents went to. Existing files are overwritten.
pub async fn extract(ctx: Arc<Ctx>, host_id: String, path: String, to_folder: bool) -> Result<String> {
    let (dir, name) = split_remote(&path);
    let (ext_len, cmd) = extract_cmd(name).ok_or_else(|| anyhow!("不支持的压缩格式"))?;
    let stem = name.get(..name.len() - ext_len).unwrap_or(name).to_string();
    let conn = get_conn(ctx, host_id).await?;
    let sftp = conn.sftp().await?;
    let dest = if to_folder {
        let d = join(dir, &stem);
        if sftp.symlink_metadata(d.clone()).await.is_ok() { unique_remote(&sftp, &d).await? } else { d }
    } else {
        dir.to_string()
    };
    let out = sh_quote(&stem);
    let full = format!("mkdir -p -- {d} && {}", cmd(&sh_quote(&path), &sh_quote(&dest), &out), d = sh_quote(&dest));
    run_op(&conn, &full, "解压失败").await?;
    Ok(dest)
}

/// Pack `paths` (all in one directory) into a `.tar.gz` beside them. Returns the archive path.
pub async fn compress(ctx: Arc<Ctx>, host_id: String, paths: Vec<String>) -> Result<String> {
    let first = paths.first().ok_or_else(|| anyhow!("未选择文件"))?;
    let (dir, _) = split_remote(first);
    let mut names = Vec::new();
    for p in &paths {
        let (d, n) = split_remote(p);
        if d != dir || n.is_empty() {
            bail!("只能压缩同一目录下的文件");
        }
        names.push(n.to_string());
    }
    let base = if names.len() == 1 { names[0].clone() } else { split_remote(dir).1.to_string() };
    let base = if base.is_empty() || base == "/" { "archive".to_string() } else { base };
    let conn = get_conn(ctx, host_id).await?;
    let sftp = conn.sftp().await?;
    let mut archive = join(dir, &format!("{base}.tar.gz"));
    if sftp.symlink_metadata(archive.clone()).await.is_ok() {
        archive = unique_remote(&sftp, &archive).await?;
    }
    let list = names.iter().map(|n| sh_quote(n)).collect::<Vec<_>>().join(" ");
    let cmd = format!("cd {} && tar -czf {} -- {list}", sh_quote(dir), sh_quote(&archive));
    run_op(&conn, &cmd, "压缩失败").await?;
    Ok(archive)
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
    pub conflict: Conflict,
    /// The target path has been settled by a run (numbered name picked, or folder created), so a
    /// retry continues into it instead of applying `conflict` again.
    #[serde(skip)]
    pub owned: bool,
    pub is_dir: bool,
    pub total: u64,
    pub done: u64,
    pub speed: f64,
    pub files_done: u32,
    pub files_total: u32,
    /// queued | running | done | skipped | error | cancelled
    pub state: String,
    pub error: Option<String>,
}

impl TransferInfo {
    fn active(&self) -> bool {
        self.state == "running" || self.state == "queued"
    }
}

/// Lock order: `map` before `slots`.
#[derive(Default)]
pub struct Transfers {
    map: Mutex<HashMap<String, (TransferInfo, Arc<AtomicBool>)>>,
    slots: Mutex<HashMap<String, Arc<Semaphore>>>,
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
    /// Stop everything for a host (disconnect / delete).
    pub fn cancel_host(&self, host_id: &str) {
        for (t, c) in self.map.lock().values() {
            if t.host_id == host_id {
                c.store(true, Ordering::Relaxed);
            }
        }
    }
    pub fn clear_finished(&self) {
        self.map.lock().retain(|_, (t, _)| t.active());
    }
    fn update(&self, ctx: &Ctx, t: &TransferInfo) {
        if let Some(e) = self.map.lock().get_mut(&t.id) {
            e.0 = t.clone();
        }
        let _ = ctx.app.emit("transfer", t);
    }
    fn slot(&self, host_id: &str) -> Arc<Semaphore> {
        self.slots.lock().entry(host_id.to_string()).or_insert_with(|| Arc::new(Semaphore::new(PER_HOST))).clone()
    }
}

/// Queue an upload (`direction = "upload"`) or download of a file or folder. Returns the id at once.
pub fn start(ctx: Arc<Ctx>, host_id: String, direction: String, local: String, remote: String, conflict: Conflict) -> String {
    let id = new_id();
    let info = TransferInfo {
        id: id.clone(),
        host_id,
        direction,
        local,
        remote,
        conflict,
        owned: false,
        is_dir: false,
        total: 0,
        done: 0,
        speed: 0.0,
        files_done: 0,
        files_total: 0,
        state: "queued".into(),
        error: None,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    ctx.transfers.map.lock().insert(id.clone(), (info.clone(), cancel.clone()));
    launch(ctx, info, cancel);
    id
}

/// Run a failed or cancelled transfer again under the same id.
pub fn retry(ctx: Arc<Ctx>, id: &str) -> Result<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    // Check and re-register under one lock: a double-clicked retry must not start two jobs.
    let info = {
        let mut map = ctx.transfers.map.lock();
        let (t, _) = map.get(id).ok_or_else(|| anyhow!("传输记录不存在"))?;
        if t.active() {
            bail!("传输正在进行");
        }
        let conflict = if t.owned { Conflict::Overwrite } else { t.conflict };
        let info = TransferInfo {
            conflict,
            done: 0,
            total: 0,
            speed: 0.0,
            files_done: 0,
            files_total: 0,
            state: "queued".into(),
            error: None,
            ..t.clone()
        };
        map.insert(id.to_string(), (info.clone(), cancel.clone()));
        info
    };
    launch(ctx, info, cancel);
    Ok(())
}

/// Run a registered transfer once a per-host slot frees up.
fn launch(ctx: Arc<Ctx>, info: TransferInfo, cancel: Arc<AtomicBool>) {
    let _ = ctx.app.emit("transfer", &info);
    tauri::async_runtime::spawn(async move {
        let mut job = Job { ctx: ctx.clone(), t: info, cancel, start: Instant::now(), last_emit: Instant::now() };
        let slot = ctx.transfers.slot(&job.t.host_id);
        let acquire = slot.acquire_owned();
        tokio::pin!(acquire);
        let permit = loop {
            tokio::select! {
                p = &mut acquire => break p.ok(),
                _ = tokio::time::sleep(Duration::from_millis(200)) => {
                    if job.cancel.load(Ordering::Relaxed) {
                        break None;
                    }
                }
            }
        };
        let res = match permit {
            Some(_permit) => {
                job.t.state = "running".into();
                job.start = Instant::now();
                ctx.transfers.update(&ctx, &job.t);
                job.run().await
            }
            None => Err(anyhow!("已取消")),
        };
        let mut t = job.t;
        t.speed = t.done as f64 / job.start.elapsed().as_secs_f64().max(0.001);
        match res {
            Ok(true) => t.state = "done".into(),
            Ok(false) => t.state = "skipped".into(),
            Err(e) => {
                t.state = if job.cancel.load(Ordering::Relaxed) { "cancelled".into() } else { "error".into() };
                t.error = Some(format!("{e:#}"));
            }
        }
        ctx.transfers.update(&ctx, &t);
    });
}

/// One entry of a folder transfer, relative to its root.
struct Item {
    rel: Vec<String>,
    is_dir: bool,
    size: u64,
    mtime: Option<u32>,
}

struct Job {
    ctx: Arc<Ctx>,
    t: TransferInfo,
    cancel: Arc<AtomicBool>,
    start: Instant,
    last_emit: Instant,
}

impl Job {
    fn tick(&mut self, n: usize) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            bail!("已取消");
        }
        self.t.done += n as u64;
        if self.last_emit.elapsed() > Duration::from_millis(250) {
            self.t.speed = self.t.done as f64 / self.start.elapsed().as_secs_f64().max(0.001);
            self.ctx.transfers.update(&self.ctx, &self.t);
            self.last_emit = Instant::now();
        }
        Ok(())
    }

    fn emit(&mut self) {
        self.ctx.transfers.update(&self.ctx, &self.t);
        self.last_emit = Instant::now();
    }

    /// Ok(false) when skipped because the target exists.
    async fn run(&mut self) -> Result<bool> {
        let conn = get_conn(self.ctx.clone(), self.t.host_id.clone()).await?;
        let sftp = conn.sftp().await?;
        if self.t.direction == "upload" { self.upload(&conn, &sftp).await } else { self.download(&sftp).await }
    }

    async fn upload(&mut self, conn: &Conn, sftp: &SftpSession) -> Result<bool> {
        let local = PathBuf::from(&self.t.local);
        let md = tokio::fs::metadata(&local).await.map_err(|e| anyhow!("无法读取本地文件: {e}"))?;
        self.t.is_dir = md.is_dir();
        let mut target = self.t.remote.clone();
        let mut merge = false;
        if let Ok(old) = sftp.symlink_metadata(target.clone()).await {
            match self.t.conflict {
                Conflict::Skip => return Ok(false),
                Conflict::Rename => target = unique_remote(sftp, &target).await?,
                Conflict::Overwrite => {
                    let old_dir = sftp.metadata(target.clone()).await.map(|m| m.is_dir()).unwrap_or(old.is_dir());
                    if old_dir != self.t.is_dir {
                        bail!("目标已存在且类型不同，无法覆盖");
                    }
                    merge = true;
                }
            }
        }
        self.t.remote = target.clone();
        self.t.owned = true;
        let mut buf = vec![0u8; 256 * 1024];

        if !self.t.is_dir {
            self.t.total = md.len();
            self.t.files_total = 1;
            self.emit();
            let mut src = tokio::fs::File::open(&local).await?;
            put_file(sftp, Links::Ask(conn), &mut src, &target, &mut buf, &mut |n| self.tick(n), mtime_secs(&md)).await?;
            self.t.files_done = 1;
            return Ok(true);
        }

        let root = local.clone();
        let items = tokio::task::spawn_blocking(move || walk_local(&root)).await??;
        self.t.total = items.iter().map(|i| i.size).sum();
        self.t.files_total = items.iter().filter(|i| !i.is_dir).count() as u32;
        self.emit();
        // Merging into an existing folder: one `find` for hard-linked files instead of a `stat`
        // exec per file. A fresh folder has nothing to look up.
        let linked = if merge { linked_files(conn, &target).await } else { Some(HashSet::new()) };
        mkdir_remote(sftp, &target).await?;
        for it in &items {
            let remote = join(&target, &it.rel.join("/"));
            if it.is_dir {
                mkdir_remote(sftp, &remote).await?;
                continue;
            }
            let path = it.rel.iter().fold(local.clone(), |p, c| p.join(c));
            let mut src = tokio::fs::File::open(&path).await.map_err(|e| anyhow!("{}: {e}", it.rel.join("/")))?;
            let links = linked.as_ref().map_or(Links::Ask(conn), Links::Known);
            put_file(sftp, links, &mut src, &remote, &mut buf, &mut |n| self.tick(n), it.mtime)
                .await
                .map_err(|e| anyhow!("{}: {e:#}", it.rel.join("/")))?;
            self.t.files_done += 1;
        }
        Ok(true)
    }

    async fn download(&mut self, sftp: &SftpSession) -> Result<bool> {
        let remote = self.t.remote.clone();
        let md = sftp.metadata(remote.clone()).await?;
        self.t.is_dir = md.is_dir();
        let mut local = PathBuf::from(&self.t.local);
        check_local_path(&local)?;
        if let Ok(old) = tokio::fs::metadata(&local).await {
            match self.t.conflict {
                Conflict::Skip => return Ok(false),
                Conflict::Rename => local = unique_local(&local).await?,
                Conflict::Overwrite if old.is_dir() != self.t.is_dir => bail!("目标已存在且类型不同，无法覆盖"),
                Conflict::Overwrite => {}
            }
        }
        self.t.local = local.to_string_lossy().into_owned();
        self.t.owned = true;
        let mut buf = vec![0u8; 256 * 1024];

        if !self.t.is_dir {
            self.t.total = md.size.unwrap_or(0);
            self.t.files_total = 1;
            self.emit();
            get_file(sftp, &remote, &local, &mut buf, &mut |n| self.tick(n), md.mtime).await?;
            self.t.files_done = 1;
            return Ok(true);
        }

        let items = walk_remote(sftp, &remote, &self.cancel).await?;
        self.t.total = items.iter().map(|i| i.size).sum();
        self.t.files_total = items.iter().filter(|i| !i.is_dir).count() as u32;
        self.emit();
        tokio::fs::create_dir_all(&local).await?;
        for it in &items {
            let dst = it.rel.iter().fold(local.clone(), |p, c| p.join(local_name(c)));
            check_local_path(&dst)?;
            if it.is_dir {
                tokio::fs::create_dir_all(&dst).await?;
                continue;
            }
            let src = join(&remote, &it.rel.join("/"));
            get_file(sftp, &src, &dst, &mut buf, &mut |n| self.tick(n), it.mtime)
                .await
                .map_err(|e| anyhow!("{}: {e:#}", it.rel.join("/")))?;
            self.t.files_done += 1;
        }
        Ok(true)
    }
}

fn mtime_secs(md: &std::fs::Metadata) -> Option<u32> {
    md.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs().min(u32::MAX as u64) as u32)
}

/// Local tree in pre-order (parents before children). Symlinked folders are skipped to avoid loops.
fn walk_local(root: &Path) -> Result<Vec<Item>> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), Vec::<String>::new())];
    while let Some((dir, rel)) = stack.pop() {
        // An unreadable subfolder (Windows system folders, ACL-protected dirs) is skipped rather
        // than failing the whole upload; only the folder the user picked must be readable.
        let read = std::fs::read_dir(&dir).and_then(|it| it.collect::<std::io::Result<Vec<_>>>());
        let mut entries = match read {
            Ok(e) => e,
            Err(e) if rel.is_empty() => bail!("无法读取文件夹 {}: {e}", dir.display()),
            Err(e) => {
                log::warn!("跳过无法读取的文件夹 {}: {e}", dir.display());
                continue;
            }
        };
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            let mut r = rel.clone();
            r.push(name);
            let Ok(ft) = e.file_type() else { continue };
            // Symlinks are followed to files only; folders behind them could loop.
            let md = match if ft.is_symlink() { std::fs::metadata(e.path()) } else { e.metadata() } {
                Ok(m) if ft.is_symlink() && !m.is_file() => continue,
                Ok(m) => m,
                Err(_) => continue,
            };
            if md.is_dir() {
                out.push(Item { rel: r.clone(), is_dir: true, size: 0, mtime: None });
                stack.push((e.path(), r));
            } else if md.is_file() {
                out.push(Item { rel: r, is_dir: false, size: md.len(), mtime: mtime_secs(&md) });
            }
        }
    }
    Ok(out)
}

/// Remote tree in pre-order. Symlinks to files are followed; symlinked folders are skipped.
async fn walk_remote(sftp: &SftpSession, root: &str, cancel: &AtomicBool) -> Result<Vec<Item>> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_string(), Vec::<String>::new())];
    while let Some((dir, rel)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            bail!("已取消");
        }
        for e in sftp.read_dir(dir.clone()).await? {
            let name = e.file_name();
            if name == "." || name == ".." || name.contains('/') {
                continue;
            }
            let full = join(&dir, &name);
            let mut r = rel.clone();
            r.push(name);
            let ft = e.file_type();
            let md = if ft.is_symlink() {
                match sftp.metadata(full.clone()).await {
                    Ok(m) if !m.is_dir() => m,
                    _ => continue,
                }
            } else {
                e.metadata()
            };
            if md.is_dir() {
                out.push(Item { rel: r.clone(), is_dir: true, size: 0, mtime: None });
                stack.push((full, r));
            } else {
                out.push(Item { rel: r, is_dir: false, size: md.size.unwrap_or(0), mtime: md.mtime });
            }
        }
    }
    Ok(out)
}

async fn mkdir_remote(sftp: &SftpSession, path: &str) -> Result<()> {
    if let Err(e) = sftp.create_dir(path.to_string()).await {
        match sftp.metadata(path.to_string()).await {
            Ok(m) if m.is_dir() => {}
            Ok(_) => bail!("{path} 已存在且不是文件夹"),
            Err(_) => return Err(anyhow!("创建文件夹 {path} 失败: {e}")),
        }
    }
    Ok(())
}

async fn pump<R, W>(src: &mut R, dst: &mut W, buf: &mut [u8], tick: &mut (dyn FnMut(usize) -> Result<()> + Send)) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    loop {
        let n = src.read(buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        tick(n)?;
    }
    dst.flush().await?;
    dst.shutdown().await?;
    Ok(())
}

fn mtime_attrs(mtime: u32) -> FileAttributes {
    FileAttributes { atime: Some(mtime), mtime: Some(mtime), ..FileAttributes::empty() }
}

/// How `put_file` learns whether an existing target is hard-linked.
#[derive(Clone, Copy)]
enum Links<'a> {
    /// Paths already known to be hard-linked (from `linked_files`).
    Known(&'a HashSet<String>),
    /// Run `stat` for the target.
    Ask(&'a Conn),
}

/// Write `src` to a remote file through a hidden temp file renamed over the target on success, so
/// a failed or cancelled write never leaves a truncated file under the real name.
async fn put_file<R: AsyncRead + Unpin>(
    sftp: &SftpSession,
    links: Links<'_>,
    src: &mut R,
    remote: &str,
    buf: &mut [u8],
    tick: &mut (dyn FnMut(usize) -> Result<()> + Send),
    mtime: Option<u32>,
) -> Result<()> {
    let old = sftp.symlink_metadata(remote.to_string()).await.ok();
    if old.as_ref().is_some_and(|m| m.is_dir()) {
        bail!("目标是文件夹，无法覆盖");
    }
    // Replacing a symlink or a hard-linked file by rename would break the link: write in place.
    let in_place = match &old {
        Some(md) if md.file_type().is_symlink() => true,
        Some(md) if md.file_type().is_file() => match links {
            Links::Known(set) => set.contains(remote),
            Links::Ask(conn) => remote_nlink(conn, remote).await > 1,
        },
        _ => false,
    };
    let tmp = remote_temp_path(remote);
    let opened = if in_place {
        None
    } else {
        match sftp.open_with_flags(tmp.clone(), OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).await {
            Ok(f) => Some(f),
            // The directory isn't writable, but the file itself may be.
            Err(e) if old.is_some() && is_permission_denied(&e) => None,
            Err(e) => return Err(e.into()),
        }
    };
    let Some(mut dst) = opened else {
        let mut dst = sftp
            .open_with_flags(remote.to_string(), OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
            .await?;
        pump(src, &mut dst, buf, tick).await?;
        if let Some(m) = mtime {
            crate::util::log_err("设置修改时间失败", sftp.set_metadata(remote.to_string(), mtime_attrs(m)).await);
        }
        return Ok(());
    };
    if let Err(e) = pump(src, &mut dst, buf, tick).await {
        drop(dst);
        crate::util::log_err("删除临时文件失败", sftp.remove_file(tmp).await);
        return Err(e);
    }
    drop(dst);
    if let Some(md) = &old {
        copy_owner_perms(sftp, &tmp, md).await;
    }
    if let Some(m) = mtime {
        crate::util::log_err("设置修改时间失败", sftp.set_metadata(tmp.clone(), mtime_attrs(m)).await);
    }
    replace_remote(sftp, &tmp, remote, old.is_some()).await
}

/// Download one remote file through a local temp file renamed over `local` on success.
async fn get_file(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    buf: &mut [u8],
    tick: &mut (dyn FnMut(usize) -> Result<()> + Send),
    mtime: Option<u32>,
) -> Result<()> {
    if tokio::fs::metadata(local).await.is_ok_and(|m| m.is_dir()) {
        bail!("目标是文件夹，无法覆盖");
    }
    let mut src = sftp.open(remote.to_string()).await?;
    if let Some(p) = local.parent() {
        tokio::fs::create_dir_all(p).await?;
    }
    let tmp = local_temp_path(local);
    let res = async {
        let mut dst = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).await?;
        pump(&mut src, &mut dst, buf, tick).await?;
        if let Some(m) = mtime {
            let t = SystemTime::UNIX_EPOCH + Duration::from_secs(m as u64);
            let f = dst.into_std().await;
            crate::util::log_err("设置修改时间失败", tokio::task::spawn_blocking(move || f.set_modified(t)).await?);
        } else {
            drop(dst);
        }
        tokio::fs::rename(&tmp, local).await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if let Err(e) = res {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
}

fn is_permission_denied(e: &russh_sftp::client::error::Error) -> bool {
    matches!(e, russh_sftp::client::error::Error::Status(s) if s.status_code == StatusCode::PermissionDenied)
}

/// Hard-link count of a remote file. SFTP v3 attributes don't carry it, so ask `stat`; 1 when
/// unknown (non-GNU stat, exec refused).
async fn remote_nlink(conn: &Conn, path: &str) -> u64 {
    let cmd = format!("stat -c %h -- {} 2>/dev/null", sh_quote(path));
    match exec::run(conn, &cmd, Duration::from_secs(15)).await {
        Ok(r) if r.exit_code == Some(0) => r.stdout.trim().parse().unwrap_or(1),
        _ => 1,
    }
}

/// Hard-linked files under `dir` (as `dir/...` paths). None when unknown (no GNU find, output
/// truncated): callers then ask per file.
async fn linked_files(conn: &Conn, dir: &str) -> Option<HashSet<String>> {
    let cmd = format!("find {} -type f -links +1 -print0 2>/dev/null", sh_quote(dir));
    match exec::run(conn, &cmd, Duration::from_secs(60)).await {
        Ok(r) if r.exit_code == Some(0) && !r.truncated => {
            Some(r.stdout.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())
        }
        _ => None,
    }
}

/// Give the new file the old one's mode and owner. Best effort: changing the owner needs root.
async fn copy_owner_perms(sftp: &SftpSession, tmp: &str, old: &FileAttributes) {
    if let Some(perms) = old.permissions {
        let attrs = FileAttributes { permissions: Some(perms & 0o7777), ..FileAttributes::empty() };
        crate::util::log_err("复制文件权限失败", sftp.set_metadata(tmp.to_string(), attrs).await);
    }
    if let (Some(uid), Some(gid)) = (old.uid, old.gid) {
        let attrs = FileAttributes { uid: Some(uid), gid: Some(gid), ..FileAttributes::empty() };
        crate::util::log_err("复制文件属主失败", sftp.set_metadata(tmp.to_string(), attrs).await);
    }
}

/// Move the uploaded temp file over the target. SFTP v3 rename doesn't overwrite, so an existing
/// target is removed first; once it's gone the temp file is the only copy and is never deleted.
async fn replace_remote(sftp: &SftpSession, tmp: &str, remote: &str, exists: bool) -> Result<()> {
    let first = match sftp.rename(tmp.to_string(), remote.to_string()).await {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    let cleanup = |e: anyhow::Error| async move {
        crate::util::log_err("删除临时文件失败", sftp.remove_file(tmp.to_string()).await);
        Err(e)
    };
    if !exists {
        return cleanup(anyhow!("重命名临时文件失败: {first}")).await;
    }
    if let Err(e) = sftp.remove_file(remote.to_string()).await {
        return cleanup(anyhow!("无法替换原文件: {e}")).await;
    }
    sftp.rename(tmp.to_string(), remote.to_string())
        .await
        .map_err(|e| anyhow!("原文件已删除但重命名失败，上传内容保存在 {tmp}: {e}"))
}

/// `dir/.name.myshell-<random>.part`: hidden, and never clobbers a user's own `name.part`.
fn temp_name(name: &str) -> String {
    format!(".{name}.myshell-{:08x}.part", rand::random::<u32>())
}

fn remote_temp_path(remote: &str) -> String {
    match remote.rsplit_once('/') {
        Some((dir, name)) => format!("{dir}/{}", temp_name(name)),
        None => temp_name(remote),
    }
}

fn local_temp_path(p: &Path) -> PathBuf {
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    p.with_file_name(temp_name(&name))
}

/// Download targets come from remote file names: never let one escape the chosen directory.
fn check_local_path(p: &Path) -> Result<()> {
    if !p.is_absolute() {
        bail!("本地路径必须是绝对路径");
    }
    for c in p.components() {
        match c {
            Component::ParentDir => bail!("本地路径不能包含 .."),
            // `name:stream` would write an NTFS alternate data stream.
            Component::Normal(n) if cfg!(windows) && n.to_string_lossy().contains(':') => {
                bail!("文件名不能包含冒号")
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_path_checks() {
        let base = if cfg!(windows) { "C:\\dl" } else { "/dl" };
        assert!(check_local_path(Path::new(&format!("{base}/a.txt"))).is_ok());
        assert!(check_local_path(Path::new(&format!("{base}/../evil.txt"))).is_err());
        assert!(check_local_path(Path::new(&format!("{base}/x/../../evil"))).is_err());
        assert!(check_local_path(Path::new("relative.txt")).is_err());
        if cfg!(windows) {
            assert!(check_local_path(Path::new("C:\\dl\\..\\evil")).is_err());
            assert!(check_local_path(Path::new("C:\\dl\\a:stream")).is_err());
        }
        let tmp = local_temp_path(Path::new(&format!("{base}/a.txt")));
        assert_eq!(tmp.parent(), Some(Path::new(base)));
        let name = tmp.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(".a.txt.myshell-") && name.ends_with(".part"), "{name}");
        let r = remote_temp_path("/srv/a.txt");
        assert!(r.starts_with("/srv/.a.txt.myshell-") && r.ends_with(".part"), "{r}");
        assert!(remote_temp_path("/a.txt").starts_with("/.a.txt.myshell-"));
    }

    #[test]
    fn numbering() {
        assert_eq!(numbered("a.txt", 1), "a (1).txt");
        assert_eq!(numbered("a.tar.gz", 2), "a (2).tar.gz");
        assert_eq!(numbered(".bashrc", 1), ".bashrc (1)");
        assert_eq!(numbered("dir", 3), "dir (3)");
        assert_eq!(numbered(".tar.gz", 1), ".tar (1).gz");
    }

    #[test]
    fn names() {
        assert_eq!(local_name("a:b\\c"), "a_b_c");
        assert_eq!(local_name(".."), "_");
        assert_eq!(local_name("ok.txt"), "ok.txt");
        assert_eq!(local_name("nul"), "_nul");
        assert_eq!(local_name("Con.tar.gz"), "_Con.tar.gz");
        assert_eq!(local_name("com1 .txt"), "_com1 .txt");
        assert_eq!(local_name("console.log"), "console.log");
        assert_eq!(local_name("a. "), "a_");
        assert_eq!(local_name("数据."), "数据_");
        assert_eq!(split_remote("/srv/a.txt"), ("/srv", "a.txt"));
        assert_eq!(split_remote("/a"), ("/", "a"));
        assert_eq!(split_remote("/srv/dir/"), ("/srv", "dir"));
        assert!(check_remove_targets(&["/".into()]).is_err());
        assert!(check_remove_targets(&["//".into()]).is_err());
        assert!(check_remove_targets(&["/tmp/x".into()]).is_ok());
    }

    #[test]
    fn archive_kinds() {
        let (n, f) = extract_cmd("x.tar.gz").unwrap();
        assert_eq!(n, 7);
        assert_eq!(f("A", "D", "S"), "tar -xzf A -C D");
        assert_eq!(extract_cmd("x.gz").unwrap().0, 3);
        assert_eq!(extract_cmd("X.ZIP").unwrap().1("A", "D", "S"), "unzip -o -q A -d D");
        assert!(extract_cmd("x.txt").is_none());
        assert!(extract_cmd(".zip").is_none());
    }
}
