//! App log: a `log` backend writing to `<data>/logs/myshellplus.log` (rotated at 2MB, one old file kept).
//! Records connection steps, disconnects, panics, UI crashes / freezes / long frames, and unclean exits.
//! Exports are redacted (addresses, user names, emails, Windows user paths) before leaving the machine.
//!
//! Line format: `2026-10-12 14:03:01.123 WARN  target  message`; message continuation lines are indented.
//! Connection entries use target `conn:<host id>` so a host's attempt can be cut out of the file.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::Result;
use log::{Level, LevelFilter, Log, Metadata, Record};
use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;

use crate::db::Db;

const MAX_BYTES: u64 = 2 * 1024 * 1024;
const FILE: &str = "myshellplus.log";
const OLD: &str = "myshellplus.1.log";
/// Present while the app runs; found at startup = the last run crashed or was killed.
const RUNNING: &str = "running";

/// Plain targets used with `log::x!(target: ...)` across the app.
const OWN_TARGETS: &[&str] = &["app", "crash", "ui", "perf", "watchdog", "tunnel"];

struct Logger {
    dir: PathBuf,
    file: Mutex<Option<File>>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

fn open(dir: &Path) -> Option<File> {
    OpenOptions::new().create(true).append(true).open(dir.join(FILE)).ok()
}

impl Logger {
    fn write_line(&self, line: &str) {
        let mut g = self.file.lock();
        if g.as_ref().and_then(|f| f.metadata().ok()).is_some_and(|m| m.len() > MAX_BYTES) {
            *g = None;
            let _ = std::fs::rename(self.dir.join(FILE), self.dir.join(OLD));
        }
        if g.is_none() {
            *g = open(&self.dir);
        }
        if let Some(f) = g.as_mut() {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

fn format_line(level: Level, target: &str, msg: &str) -> String {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let msg = msg.trim_end().replace("\r\n", "\n").replace('\n', "\n    ");
    format!("{ts} {:<5} {target}  {msg}\n", level.as_str())
}

impl Log for Logger {
    fn enabled(&self, m: &Metadata) -> bool {
        // Our own targets down to debug; libraries (russh, reqwest, ...) only info and above.
        let t = m.target();
        let ours = t.starts_with("myshellplus") || t.starts_with("conn:") || OWN_TARGETS.contains(&t);
        m.level() <= if ours { Level::Debug } else { Level::Info }
    }

    fn log(&self, r: &Record) {
        if self.enabled(r.metadata()) {
            let target = r.target().strip_prefix("myshellplus_lib::").unwrap_or(r.target());
            self.write_line(&format_line(r.level(), target, &r.args().to_string()));
        }
    }

    fn flush(&self) {
        if let Some(f) = self.file.lock().as_mut() {
            let _ = f.flush();
        }
    }
}

/// Install the logger and panic hook. Call once at startup, before anything logs.
pub fn init(data_dir: &Path) {
    let dir = data_dir.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let crashed = dir.join(RUNNING).exists();
    let logger = LOGGER.get_or_init(|| Logger { file: Mutex::new(open(&dir)), dir: dir.clone() });
    if log::set_logger(logger).is_ok() {
        log::set_max_level(LevelFilter::Debug);
    }
    let _ = std::fs::write(dir.join(RUNNING), std::process::id().to_string());

    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current().name().unwrap_or("?").to_string();
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        log::error!(target: "crash", "程序崩溃 (panic) 线程 {thread} @ {at}\n{msg}");
        log::logger().flush();
        prev(info);
    }));

    log::info!(
        target: "app",
        "启动 v{} {} {} WebView2 {}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        tauri::webview_version().unwrap_or_else(|_| "?".into()),
    );
    if crashed {
        log::error!(target: "crash", "上次运行未正常退出（崩溃或被强制结束）");
    }
}

/// Normal shutdown: the next start won't report a crash.
pub fn clean_exit() {
    log::info!(target: "app", "退出");
    if let Some(l) = LOGGER.get() {
        let _ = std::fs::remove_file(l.dir.join(RUNNING));
    }
}

pub fn dir() -> Option<PathBuf> {
    LOGGER.get().map(|l| l.dir.clone())
}

/// Log target for a host's connection entries.
pub fn conn_target(host_id: &str) -> String {
    format!("conn:{host_id}")
}

// ---------------------------------------------------------------- reading

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// "2026-10-12 14:03:01.123" (local time)
    pub ts: String,
    pub level: String,
    pub target: String,
    pub msg: String,
}

fn parse(text: &str, out: &mut Vec<Entry>) {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) (\w+)\s+(\S+)  (.*)$").unwrap());
    for line in text.lines() {
        if let Some(c) = re.captures(line) {
            out.push(Entry { ts: c[1].into(), level: c[2].into(), target: c[3].into(), msg: c[4].into() });
        } else if let Some(last) = out.last_mut() {
            last.msg.push('\n');
            last.msg.push_str(line.strip_prefix("    ").unwrap_or(line));
        }
    }
}

/// Raw text of the log files, oldest first.
fn read_raw() -> String {
    let Some(dir) = dir() else { return String::new() };
    if let Some(l) = LOGGER.get() {
        l.flush();
    }
    let mut s = std::fs::read_to_string(dir.join(OLD)).unwrap_or_default();
    s.push_str(&std::fs::read_to_string(dir.join(FILE)).unwrap_or_default());
    s
}

fn entries() -> Vec<Entry> {
    let mut v = Vec::new();
    parse(&read_raw(), &mut v);
    v
}

/// Recent warnings and errors, newest first.
pub fn events(limit: usize) -> Vec<Entry> {
    let mut v: Vec<_> = entries().into_iter().filter(|e| e.level == "WARN" || e.level == "ERROR").collect();
    v.reverse();
    v.truncate(limit);
    v
}

fn render(e: &Entry) -> String {
    format!("{} {:<5} {}  {}\n", e.ts, e.level, e.target, e.msg.replace('\n', "\n    "))
}

/// Entries of the host's last connect attempt: from its last "开始连接" to the matching result,
/// plus library and jump-host lines logged in between. `chain`: the host, then its jump hosts.
pub fn last_attempt(chain: &[String]) -> Vec<Entry> {
    let all = entries();
    let Some(host_id) = chain.first() else { return all };
    let me = conn_target(host_id);
    let chain: Vec<String> = chain.iter().map(|h| conn_target(h)).collect();
    let Some(start) = all.iter().rposition(|e| e.target == me && e.msg.starts_with("开始连接")) else {
        return all.into_iter().filter(|e| e.target == me).collect();
    };
    let end = all[start..]
        .iter()
        .position(|e| e.target == me && (e.msg.starts_with("连接成功") || e.msg.starts_with("连接失败")))
        .map(|i| start + i + 1)
        .unwrap_or(all.len());
    all[start..end]
        .iter()
        .filter(|e| if e.target.starts_with("conn:") { chain.contains(&e.target) } else { !OWN_TARGETS.contains(&e.target.as_str()) })
        .cloned()
        .collect()
}

// ---------------------------------------------------------------- redaction

/// Replaces host addresses, server names, user names and key names from the database with
/// placeholders, then masks IPs, emails and the Windows user name.
pub struct Redactor {
    pairs: Vec<(String, String)>,
}

/// Generic user names that carry no identity (and would mangle paths like /root if replaced).
const COMMON_USERS: &[&str] = &["root", "admin", "ubuntu", "centos", "debian", "user", "ec2-user", "pi", "opc", "test"];

impl Redactor {
    pub fn new(db: &Db) -> Self {
        let mut pairs: Vec<(String, String)> = Vec::new();
        let mut add = |from: &str, to: String| {
            let from = from.trim();
            if from.chars().count() >= 3 && !pairs.iter().any(|(f, _)| f == from) {
                pairs.push((from.to_string(), to));
            }
        };
        for (i, h) in db.list_hosts().unwrap_or_default().iter().enumerate() {
            let n = i + 1;
            add(&h.host, format!("<host{n}>"));
            add(&h.name, format!("<server{n}>"));
            if !COMMON_USERS.contains(&h.username.as_str()) {
                add(&h.username, format!("<user{n}>"));
            }
            add(&h.proxy_host, format!("<proxy{n}>"));
            add(&h.proxy_user, format!("<proxyuser{n}>"));
        }
        for (i, k) in db.list_keys().unwrap_or_default().iter().enumerate() {
            add(&k.name, format!("<key{}>", i + 1));
        }
        for var in ["USERNAME", "COMPUTERNAME", "USERDOMAIN"] {
            if let Ok(v) = std::env::var(var) {
                add(&v, format!("<{}>", var.to_lowercase()));
            }
        }
        // Longest first so "web-prod-1" is replaced before "web".
        pairs.sort_by_key(|a| std::cmp::Reverse(a.0.len()));
        Redactor { pairs }
    }

    pub fn apply(&self, s: &str) -> String {
        static RES: OnceLock<[(Regex, &'static str); 5]> = OnceLock::new();
        let res = RES.get_or_init(|| {
            [
                (Regex::new(r"(?i)\b([a-z]:[\\/]+Users[\\/]+)[^\\/\s]+").unwrap(), "${1}<user>"),
                (Regex::new(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+").unwrap(), "<email>"),
                (Regex::new(r"\[[0-9a-fA-F:.%\w]*:[0-9a-fA-F:.%\w]*\]").unwrap(), "[<ipv6>]"),
                (Regex::new(r"\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){4,7}\b").unwrap(), "<ipv6>"),
                (Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").unwrap(), "<ip>"),
            ]
        });
        let mut out = s.to_string();
        for (from, to) in &self.pairs {
            out = out.replace(from.as_str(), to);
        }
        for (re, to) in res.iter() {
            out = re
                .replace_all(&out, |c: &regex::Captures| {
                    // Loopback / unspecified addresses say nothing about the user.
                    if matches!(&c[0], "127.0.0.1" | "0.0.0.0") {
                        return c[0].to_string();
                    }
                    let mut s = String::new();
                    c.expand(to, &mut s);
                    s
                })
                .into_owned();
        }
        out
    }
}

fn header(title: &str) -> String {
    format!(
        "# MyShell+ {title}\n# 版本 {} · {} {} · WebView2 {}\n# 导出时间 {}\n\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        tauri::webview_version().unwrap_or_else(|_| "?".into()),
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
    )
}

/// Whole app log, always redacted.
pub fn export_all(db: &Db) -> String {
    let r = Redactor::new(db);
    let mut s = header("诊断日志（已脱敏）");
    s.push_str(&r.apply(&read_raw()));
    s
}

/// The host followed by its jump hosts.
fn jump_chain(db: &Db, host_id: &str) -> Vec<String> {
    let mut chain = vec![host_id.to_string()];
    while chain.len() < 6 {
        let next = db
            .get_host(chain.last().unwrap())
            .ok()
            .and_then(|h| h.jump_host_id)
            .filter(|j| !j.is_empty() && !chain.contains(j));
        match next {
            Some(j) => chain.push(j),
            None => break,
        }
    }
    chain
}

/// Host settings that matter for connecting (no secrets).
fn host_summary(db: &Db, host_id: &str) -> String {
    let Ok(h) = db.get_host(host_id) else { return "# 服务器已删除\n".into() };
    let auth = match h.auth_type.as_str() {
        "key" => "密钥",
        "agent" => "SSH Agent",
        _ => "密码",
    };
    let jump = h.jump_host_id.as_deref().filter(|s| !s.is_empty()).and_then(|j| db.get_host(j).ok());
    format!(
        "# 服务器 {} ({}@{}:{})\n# 认证 {auth} · 跳板机 {} · 代理 {}\n\n",
        h.name,
        h.username,
        h.host,
        h.port,
        jump.map(|j| format!("{} ({}:{})", j.name, j.host, j.port)).unwrap_or_else(|| "无".into()),
        if !h.proxy_enabled || h.proxy_host.is_empty() { "无".into() } else { format!("socks5://{}:{}", h.proxy_host, h.proxy_port) },
    )
}

/// The host's last connect attempt as text; `redact` hides addresses and names.
pub fn export_conn(db: &Db, host_id: &str, redact: bool) -> String {
    let mut s = header(if redact { "连接日志（已脱敏）" } else { "连接日志" });
    s.push_str(&host_summary(db, host_id));
    for e in last_attempt(&jump_chain(db, host_id)) {
        s.push_str(&render(&e));
    }
    if redact { Redactor::new(db).apply(&s) } else { s }
}

pub fn write_file(path: &str, content: &str) -> Result<()> {
    std::fs::write(path, content)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_multiline() {
        let mut v = Vec::new();
        parse("2026-10-12 14:03:01.123 ERROR crash  boom\n    at x\n2026-10-12 14:03:02.000 INFO  app  ok\n", &mut v);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].msg, "boom\nat x");
        assert_eq!(v[1].target, "app");
    }

    #[test]
    fn redact_patterns() {
        let r = Redactor { pairs: vec![("web-prod".into(), "<server1>".into())] };
        let s = r.apply("web-prod 10.0.0.5:22 [2001:db8::1]:22 a.b@c.com C:\\Users\\alice\\x 127.0.0.1 14:03:01.123");
        assert_eq!(s, "<server1> <ip>:22 [<ipv6>]:22 <email> C:\\Users\\<user>\\x 127.0.0.1 14:03:01.123");
    }
}
