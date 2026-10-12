//! Import hosts from other tools, and encrypted backup export/import.
//!
//! Flow: `preview(source, path)` parses into candidates (nothing is written), the UI lets the
//! user pick, then `apply(candidates)` saves them. Passwords stored encrypted by other tools
//! (Xshell, FinalShell, MobaXterm) are not decrypted; those hosts import without a password.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::{Host, Snippet, TunnelDef};
use crate::state::Ctx;
use crate::util::new_id;
use crate::vault;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Alias used to resolve jump hosts inside one import.
    #[serde(default)]
    pub alias: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    /// Local private key file to import.
    #[serde(default)]
    pub key_path: Option<String>,
    /// Private key text (from backups).
    #[serde(default)]
    pub key_text: Option<String>,
    #[serde(default)]
    pub key_passphrase: Option<String>,
    #[serde(default)]
    pub jump_alias: Option<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Filled by preview: an identical user@host:port already exists.
    #[serde(default)]
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub source: String,
    pub path: String,
    pub hosts: Vec<Candidate>,
    pub snippets: Vec<Snippet>,
    pub tunnels: usize,
    pub warnings: Vec<String>,
}

/// Default location for each source on this machine (None = ask the user for a path).
pub fn default_path(source: &str) -> Option<String> {
    let home = dirs::home_dir()?;
    let p: PathBuf = match source {
        "openssh" => home.join(".ssh").join("config"),
        "xshell" => {
            let base = dirs::document_dir()?.join("NetSarang Computer");
            ["8", "7", "6"]
                .iter()
                .map(|v| base.join(v).join("Xshell").join("Sessions"))
                .find(|p| p.exists())?
        }
        "mobaxterm" => {
            let cands = [
                dirs::config_dir().map(|d| d.join("MobaXterm").join("MobaXterm.ini")),
                dirs::document_dir().map(|d| d.join("MobaXterm").join("MobaXterm.ini")),
            ];
            cands.into_iter().flatten().find(|p| p.exists())?
        }
        "putty" => return Some("HKCU\\Software\\SimonTatham\\PuTTY\\Sessions".into()),
        _ => return None,
    };
    p.exists().then(|| p.to_string_lossy().into_owned())
}

/// Read a text file in UTF-8, UTF-16 (BOM) or GBK.
fn read_text(path: &Path) -> Result<String> {
    let b = std::fs::read(path).with_context(|| format!("无法读取 {}", path.display()))?;
    if b.starts_with(&[0xFF, 0xFE]) {
        return Ok(encoding_rs::UTF_16LE.decode(&b[2..]).0.into_owned());
    }
    if b.starts_with(&[0xFE, 0xFF]) {
        return Ok(encoding_rs::UTF_16BE.decode(&b[2..]).0.into_owned());
    }
    let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&b);
    match std::str::from_utf8(b) {
        Ok(s) => Ok(s.to_string()),
        Err(_) => Ok(encoding_rs::GBK.decode(b).0.into_owned()),
    }
}

pub fn preview(ctx: &Ctx, source: &str, path: &str, password: Option<&str>) -> Result<Preview> {
    let mut warnings = Vec::new();
    let mut snippets = Vec::new();
    let mut tunnels = 0;
    let mut hosts = match source {
        "openssh" => parse_openssh(Path::new(path), &mut warnings)?,
        "putty" => parse_putty()?,
        "xshell" => parse_xshell(Path::new(path), &mut warnings)?,
        "mobaxterm" => parse_mobaxterm(&read_text(Path::new(path))?),
        "finalshell" => parse_finalshell(Path::new(path), &mut warnings)?,
        "csv" => parse_csv(&read_text(Path::new(path))?)?,
        "backup" => {
            let b = read_backup(path, password)?;
            snippets = b.snippets;
            tunnels = b.tunnels.len();
            b.hosts
        }
        _ => bail!("不支持的导入来源: {source}"),
    };
    let existing: Vec<(String, u16, String)> =
        ctx.db.list_hosts()?.into_iter().map(|h| (h.host.to_lowercase(), h.port, h.username)).collect();
    for c in hosts.iter_mut() {
        c.duplicate = existing.contains(&(c.host.to_lowercase(), c.port, c.username.clone()));
    }
    if matches!(source, "xshell" | "finalshell" | "mobaxterm") {
        warnings.push("该软件的密码为加密存储，导入后需要重新填写密码".into());
    }
    Ok(Preview { source: source.into(), path: path.into(), hosts, snippets, tunnels, warnings })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub hosts: usize,
    pub keys: usize,
    pub snippets: usize,
    pub tunnels: usize,
    pub errors: Vec<String>,
}

pub fn apply(ctx: &Ctx, hosts: Vec<Candidate>, snippets: Vec<Snippet>, backup: Option<(String, Option<String>)>) -> Result<ImportResult> {
    if !ctx.vault.is_unlocked() {
        bail!("请先解锁保险库");
    }
    let mut res = ImportResult { hosts: 0, keys: 0, snippets: 0, tunnels: 0, errors: vec![] };
    let mut alias_to_id: HashMap<String, String> = HashMap::new();
    let mut key_cache: HashMap<String, String> = HashMap::new(); // key text -> key id
    let mut saved: Vec<(Host, Option<String>)> = Vec::new();

    for c in hosts {
        let label = format!("{} ({})", c.name, c.host);
        let r: Result<()> = (|| {
            let mut h = Host {
                id: String::new(),
                name: if c.name.is_empty() { c.host.clone() } else { c.name.clone() },
                group_name: c.group.clone(),
                host: c.host.clone(),
                port: if c.port == 0 { 22 } else { c.port },
                username: if c.username.is_empty() { "root".into() } else { c.username.clone() },
                auth_type: "password".into(),
                password_secret: None,
                key_id: None,
                jump_host_id: None,
                tags: c.tags.clone(),
                color: String::new(),
                notes: c.notes.clone(),
                agent_policy: "ask".into(),
                sort: 0,
                updated_at: 0,
            };
            let key_text = match (&c.key_text, &c.key_path) {
                (Some(t), _) => Some(t.clone()),
                (None, Some(p)) => match std::fs::read_to_string(expand_home(p)) {
                    Ok(t) => Some(t),
                    Err(e) => {
                        res.errors.push(format!("{label}: 读取密钥 {p} 失败: {e}"));
                        None
                    }
                },
                _ => None,
            };
            if let Some(text) = key_text {
                let kid = match key_cache.get(&text) {
                    Some(id) => id.clone(),
                    None => {
                        let id = import_key(ctx, &key_name(&c), &text, c.key_passphrase.as_deref())?;
                        res.keys += 1;
                        key_cache.insert(text, id.clone());
                        id
                    }
                };
                h.auth_type = "key".into();
                h.key_id = Some(kid);
            }
            if let Some(pw) = c.password.as_deref().filter(|p| !p.is_empty()) {
                h.password_secret = Some(ctx.vault.put(None, pw)?);
            }
            let h = ctx.db.save_host(h)?;
            if !c.alias.is_empty() {
                alias_to_id.insert(c.alias.clone(), h.id.clone());
            }
            saved.push((h, c.jump_alias.clone()));
            res.hosts += 1;
            Ok(())
        })();
        if let Err(e) = r {
            res.errors.push(format!("{label}: {e:#}"));
        }
    }

    // Second pass: resolve jump hosts (by alias in this import, then by existing host name).
    let all = ctx.db.list_hosts()?;
    for (mut h, jump) in saved {
        let Some(j) = jump else { continue };
        let jid = alias_to_id
            .get(&j)
            .cloned()
            .or_else(|| all.iter().find(|x| x.name == j || x.host == j).map(|x| x.id.clone()));
        match jid {
            Some(id) if id != h.id => {
                h.jump_host_id = Some(id);
                ctx.db.save_host(h)?;
            }
            _ => res.errors.push(format!("{}: 找不到跳板机 {j}", h.name)),
        }
    }

    for mut s in snippets {
        s.id = String::new();
        ctx.db.save_snippet(s)?;
        res.snippets += 1;
    }

    if let Some((path, pw)) = backup {
        let b = read_backup(&path, pw.as_deref())?;
        for (t, alias) in b.tunnels.into_iter().zip(b.tunnel_hosts) {
            let Some(hid) = alias_to_id.get(&alias) else { continue };
            ctx.db.save_tunnel(TunnelDef { id: String::new(), host_id: hid.clone(), auto_start: false, ..t })?;
            res.tunnels += 1;
        }
    }
    let _ = ctx.db.audit("user", None, "import", &format!("{} hosts", res.hosts), "ok");
    Ok(res)
}

fn key_name(c: &Candidate) -> String {
    c.key_path
        .as_deref()
        .and_then(|p| Path::new(p).file_name().map(|f| f.to_string_lossy().into_owned()))
        .unwrap_or_else(|| format!("{} 的密钥", c.name))
}

fn import_key(ctx: &Ctx, name: &str, text: &str, pass: Option<&str>) -> Result<String> {
    let key = russh::keys::decode_secret_key(text, pass).map_err(|e| anyhow!("私钥无法解析: {e}"))?;
    let k = crate::db::KeyEntry {
        id: new_id(),
        name: name.into(),
        public_key: key.public_key().to_openssh().unwrap_or_default(),
        private_secret: ctx.vault.put(None, text)?,
        passphrase_secret: match pass {
            Some(p) if !p.is_empty() => Some(ctx.vault.put(None, p)?),
            _ => None,
        },
        updated_at: 0,
    };
    ctx.db.save_key(&k)?;
    Ok(k.id)
}

fn expand_home(p: &str) -> PathBuf {
    match p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => PathBuf::from(p),
    }
}

// ---------------- OpenSSH ----------------

fn parse_openssh(path: &Path, warnings: &mut Vec<String>) -> Result<Vec<Candidate>> {
    let text = read_text(path)?;
    let mut out = Vec::new();
    let mut defaults: HashMap<String, String> = HashMap::new(); // from "Host *"
    let mut cur: Option<(Vec<String>, HashMap<String, String>)> = None;
    let mut blocks = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (k, v) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string()),
            None => continue,
        };
        match k.as_str() {
            "host" => {
                if let Some(b) = cur.take() {
                    blocks.push(b);
                }
                cur = Some((v.split_whitespace().map(String::from).collect(), HashMap::new()));
            }
            "match" => {
                if let Some(b) = cur.take() {
                    blocks.push(b);
                }
                warnings.push("已跳过 Match 规则".into());
            }
            "include" => warnings.push(format!("未处理 Include {v}")),
            _ => {
                if let Some((_, m)) = cur.as_mut() {
                    m.entry(k).or_insert(v);
                }
            }
        }
    }
    if let Some(b) = cur.take() {
        blocks.push(b);
    }
    for (pats, m) in &blocks {
        if pats.iter().any(|p| p == "*") {
            defaults.extend(m.clone());
        }
    }
    for (pats, m) in blocks {
        for alias in pats.iter().filter(|p| !p.contains('*') && !p.contains('?') && !p.starts_with('!')) {
            let get = |k: &str| m.get(k).or_else(|| defaults.get(k)).cloned();
            let jump = get("proxyjump").map(|j| {
                // "user@host:port" or alias; take the first hop
                let first = j.split(',').next().unwrap_or("").to_string();
                let first = first.rsplit('@').next().unwrap_or(&first).to_string();
                first.split(':').next().unwrap_or(&first).to_string()
            });
            out.push(Candidate {
                alias: alias.clone(),
                name: alias.clone(),
                group: "SSH Config".into(),
                host: get("hostname").unwrap_or_else(|| alias.clone()).replace("%h", alias),
                port: get("port").and_then(|p| p.parse().ok()).unwrap_or(22),
                username: get("user").unwrap_or_else(|| "root".into()),
                key_path: get("identityfile"),
                jump_alias: jump.filter(|j| j != "none"),
                ..Default::default()
            });
        }
    }
    // Without IdentityFile, ssh would try the default keys; mimic that.
    let default_key = ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|k| dirs::home_dir().unwrap_or_default().join(".ssh").join(k))
        .find(|p| p.exists());
    if let Some(k) = default_key {
        for c in out.iter_mut().filter(|c| c.key_path.is_none()) {
            c.key_path = Some(k.to_string_lossy().into_owned());
        }
    }
    Ok(out)
}

// ---------------- PuTTY (registry) ----------------

#[cfg(windows)]
fn parse_putty() -> Result<Vec<Candidate>> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\SimonTatham\PuTTY\Sessions", "/s"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()?;
    let text = encoding_rs::GBK.decode(&out.stdout).0.into_owned();
    let mut res = Vec::new();
    let mut cur: Option<(String, HashMap<String, String>)> = None;
    let flush = |c: Option<(String, HashMap<String, String>)>, res: &mut Vec<Candidate>| {
        let Some((name, m)) = c else { return };
        if m.get("Protocol").map(|p| p.as_str()) != Some("ssh") {
            return;
        }
        let Some(host) = m.get("HostName").filter(|h| !h.is_empty()) else { return };
        let (user, host) = match host.split_once('@') {
            Some((u, h)) => (u.to_string(), h.to_string()),
            None => (m.get("UserName").cloned().unwrap_or_default(), host.clone()),
        };
        let port = m
            .get("PortNumber")
            .and_then(|p| u16::from_str_radix(p.trim_start_matches("0x"), 16).ok())
            .unwrap_or(22);
        let key = m.get("PublicKeyFile").filter(|k| !k.is_empty()).cloned();
        res.push(Candidate {
            alias: name.clone(),
            name,
            group: "PuTTY".into(),
            host,
            port,
            username: user,
            key_path: key,
            ..Default::default()
        });
    };
    for line in text.lines() {
        if line.starts_with("HKEY_") {
            flush(cur.take(), &mut res);
            let name = line.rsplit('\\').next().unwrap_or("").to_string();
            let name = urldecode(&name);
            if name != "Sessions" && name != "Default Settings" {
                cur = Some((name, HashMap::new()));
            }
        } else if let Some((_, m)) = cur.as_mut() {
            let p: Vec<&str> = line.trim().splitn(3, "    ").collect();
            if p.len() == 3 {
                m.insert(p[0].trim().into(), p[2].trim().into());
            }
        }
    }
    flush(cur.take(), &mut res);
    Ok(res)
}

#[cfg(not(windows))]
fn parse_putty() -> Result<Vec<Candidate>> {
    bail!("仅 Windows 支持从 PuTTY 导入")
}

fn urldecode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------- Xshell (.xsh INI files) ----------------

fn ini(text: &str) -> HashMap<String, HashMap<String, String>> {
    let mut out: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut sec = String::new();
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') && l.ends_with(']') {
            sec = l[1..l.len() - 1].to_string();
        } else if let Some((k, v)) = l.split_once('=') {
            out.entry(sec.clone()).or_default().insert(k.trim().into(), v.trim().into());
        }
    }
    out
}

fn walk(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, ext, out);
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case(ext)) {
            out.push(p);
        }
    }
}

fn parse_xshell(dir: &Path, warnings: &mut Vec<String>) -> Result<Vec<Candidate>> {
    let mut files = Vec::new();
    if dir.is_file() {
        files.push(dir.to_path_buf());
    } else {
        walk(dir, "xsh", &mut files);
    }
    if files.is_empty() {
        bail!("没有找到 .xsh 会话文件");
    }
    let mut out = Vec::new();
    for f in files {
        let Ok(text) = read_text(&f) else {
            warnings.push(format!("无法读取 {}", f.display()));
            continue;
        };
        let m = ini(&text);
        let conn = m.get("CONNECTION").cloned().unwrap_or_default();
        if conn.get("Protocol").is_some_and(|p| !p.eq_ignore_ascii_case("SSH")) {
            continue;
        }
        let Some(host) = conn.get("Host").filter(|h| !h.is_empty()).cloned() else { continue };
        let auth = m.get("CONNECTION:AUTHENTICATION").cloned().unwrap_or_default();
        let group = f
            .parent()
            .and_then(|p| p.strip_prefix(dir).ok())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let name = f.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or(host.clone());
        out.push(Candidate {
            alias: name.clone(),
            name,
            group: if group.is_empty() { "Xshell".into() } else { group },
            host,
            port: conn.get("Port").and_then(|p| p.parse().ok()).unwrap_or(22),
            username: auth.get("UserName").cloned().unwrap_or_default(),
            notes: conn.get("Description").cloned().unwrap_or_default(),
            ..Default::default()
        });
    }
    Ok(out)
}

// ---------------- MobaXterm (MobaXterm.ini / .mxtsessions) ----------------

fn parse_mobaxterm(text: &str) -> Vec<Candidate> {
    let mut out = Vec::new();
    let mut group = String::new();
    let mut in_bookmarks = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_bookmarks = l.to_lowercase().starts_with("[bookmarks");
            group.clear();
            continue;
        }
        if !in_bookmarks {
            continue;
        }
        let Some((k, v)) = l.split_once('=') else { continue };
        if k == "SubRep" {
            group = v.replace('\\', "/");
            continue;
        }
        if k == "ImgNum" {
            continue;
        }
        // name=#109#0%host%port%user%...  (109 = SSH)
        let Some(rest) = v.strip_prefix("#109#") else { continue };
        let parts: Vec<&str> = rest.split('%').collect();
        if parts.len() < 4 || parts[1].is_empty() {
            continue;
        }
        let key = parts.get(14).map(|s| s.replace("_CurrentDrive_:", "C:")).filter(|s| !s.is_empty() && s.contains(['/', '\\']));
        out.push(Candidate {
            alias: k.to_string(),
            name: k.to_string(),
            group: if group.is_empty() { "MobaXterm".into() } else { group.clone() },
            host: parts[1].to_string(),
            port: parts[2].parse().unwrap_or(22),
            username: parts[3].to_string(),
            key_path: key,
            ..Default::default()
        });
    }
    out
}

// ---------------- FinalShell (conn/*.json) ----------------

fn parse_finalshell(dir: &Path, warnings: &mut Vec<String>) -> Result<Vec<Candidate>> {
    let mut files = Vec::new();
    if dir.is_file() {
        files.push(dir.to_path_buf());
    } else {
        walk(dir, "json", &mut files);
    }
    let mut out = Vec::new();
    for f in files {
        let Ok(text) = read_text(&f) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            warnings.push(format!("无法解析 {}", f.display()));
            continue;
        };
        let Some(host) = v["host"].as_str().filter(|h| !h.is_empty()) else { continue };
        if v["conection_type"].as_i64().is_some_and(|t| t != 100) && v["connection_type"].as_i64().is_some_and(|t| t != 100) {
            continue;
        }
        let name = v["name"].as_str().unwrap_or(host).to_string();
        out.push(Candidate {
            alias: name.clone(),
            name,
            group: "FinalShell".into(),
            host: host.into(),
            port: v["port"].as_u64().unwrap_or(22) as u16,
            username: v["user_name"].as_str().unwrap_or("root").into(),
            notes: v["description"].as_str().unwrap_or_default().into(),
            ..Default::default()
        });
    }
    if out.is_empty() {
        bail!("没有找到 FinalShell 连接文件（通常在 FinalShell 安装目录的 conn 文件夹）");
    }
    Ok(out)
}

// ---------------- CSV ----------------

fn split_csv(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut q = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if q && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => q = !q,
            ',' if !q => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out.into_iter().map(|s| s.trim().to_string()).collect()
}

/// Header row required; recognised columns: name, group, host, port, username/user, password, key, notes, tags.
fn parse_csv(text: &str) -> Result<Vec<Candidate>> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let header: Vec<String> = split_csv(lines.next().ok_or_else(|| anyhow!("CSV 为空"))?)
        .into_iter()
        .map(|h| h.to_lowercase())
        .collect();
    let col = |names: &[&str]| header.iter().position(|h| names.contains(&h.as_str()));
    let c_host = col(&["host", "hostname", "address", "ip", "主机", "地址"]).ok_or_else(|| anyhow!("CSV 缺少 host 列"))?;
    let c_name = col(&["name", "名称"]);
    let c_group = col(&["group", "分组"]);
    let c_port = col(&["port", "端口"]);
    let c_user = col(&["username", "user", "用户名", "用户"]);
    let c_pass = col(&["password", "密码"]);
    let c_key = col(&["key", "keyfile", "identityfile", "密钥"]);
    let c_notes = col(&["notes", "备注"]);
    let c_tags = col(&["tags", "标签"]);
    let mut out = Vec::new();
    for line in lines {
        let f = split_csv(line);
        let get = |c: Option<usize>| c.and_then(|i| f.get(i)).cloned().unwrap_or_default();
        let host = get(Some(c_host));
        if host.is_empty() {
            continue;
        }
        let name = get(c_name);
        out.push(Candidate {
            alias: if name.is_empty() { host.clone() } else { name.clone() },
            name: if name.is_empty() { host.clone() } else { name },
            group: get(c_group),
            host,
            port: get(c_port).parse().unwrap_or(22),
            username: get(c_user),
            password: Some(get(c_pass)).filter(|p| !p.is_empty()),
            key_path: Some(get(c_key)).filter(|p| !p.is_empty()),
            notes: get(c_notes),
            tags: get(c_tags).split([';', '|']).map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
            ..Default::default()
        });
    }
    Ok(out)
}

// ---------------- backup (own format) ----------------

struct Backup {
    hosts: Vec<Candidate>,
    snippets: Vec<Snippet>,
    tunnels: Vec<TunnelDef>,
    /// Alias of the host each tunnel belongs to (parallel to `tunnels`).
    tunnel_hosts: Vec<String>,
}

/// Export everything. With a password, secrets are included and the payload is encrypted;
/// without one, the file contains no passwords or keys.
pub fn export_backup(ctx: &Ctx, path: &str, password: Option<&str>) -> Result<usize> {
    let with_secrets = password.is_some_and(|p| !p.is_empty());
    if with_secrets && !ctx.vault.is_unlocked() {
        bail!("请先解锁保险库");
    }
    let hosts = ctx.db.list_hosts()?;
    let keys = ctx.db.list_keys()?;
    let mut hs = Vec::new();
    for h in &hosts {
        let mut c = Candidate {
            alias: h.id.clone(),
            name: h.name.clone(),
            group: h.group_name.clone(),
            host: h.host.clone(),
            port: h.port,
            username: h.username.clone(),
            notes: h.notes.clone(),
            tags: h.tags.clone(),
            jump_alias: h.jump_host_id.clone(),
            ..Default::default()
        };
        if with_secrets {
            if let Some(s) = &h.password_secret {
                c.password = Some(ctx.vault.get(s)?.to_string());
            }
            if let Some(k) = h.key_id.as_ref().and_then(|id| keys.iter().find(|k| &k.id == id)) {
                c.key_text = Some(ctx.vault.get(&k.private_secret)?.to_string());
                if let Some(p) = &k.passphrase_secret {
                    c.key_passphrase = Some(ctx.vault.get(p)?.to_string());
                }
            }
        }
        hs.push(c);
    }
    let tunnels = ctx.db.list_tunnels()?;
    let payload = json!({
        "hosts": hs,
        "snippets": ctx.db.list_snippets()?,
        "tunnels": tunnels,
    });
    let body = serde_json::to_vec(&payload)?;
    let file = if with_secrets {
        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        let kek = vault::derive_kek(password.unwrap(), &salt)?;
        let (n, ct) = vault::seal(&kek, &body)?;
        json!({ "format": "myshellplus-backup", "version": 1, "encrypted": true,
                "salt": B64.encode(salt), "nonce": B64.encode(n), "data": B64.encode(ct) })
    } else {
        json!({ "format": "myshellplus-backup", "version": 1, "encrypted": false, "data": payload })
    };
    std::fs::write(path, serde_json::to_vec_pretty(&file)?)?;
    let _ = ctx.db.audit("user", None, "export", path, if with_secrets { "with secrets" } else { "no secrets" });
    Ok(hosts.len())
}

fn read_backup(path: &str, password: Option<&str>) -> Result<Backup> {
    let v: Value = serde_json::from_str(&read_text(Path::new(path))?).context("不是有效的备份文件")?;
    if v["format"] != "myshellplus-backup" {
        bail!("不是 MyShell+ 备份文件");
    }
    let payload: Value = if v["encrypted"].as_bool() == Some(true) {
        let pw = password.filter(|p| !p.is_empty()).ok_or_else(|| anyhow!("NEED_PASSWORD"))?;
        let salt = B64.decode(v["salt"].as_str().unwrap_or_default())?;
        let nonce = B64.decode(v["nonce"].as_str().unwrap_or_default())?;
        let data = B64.decode(v["data"].as_str().unwrap_or_default())?;
        let kek = vault::derive_kek(pw, &salt)?;
        let pt = vault::open(&kek, &nonce, &data).map_err(|_| anyhow!("备份密码错误"))?;
        serde_json::from_slice(&pt)?
    } else {
        v["data"].clone()
    };
    let hosts: Vec<Candidate> = serde_json::from_value(payload["hosts"].clone()).unwrap_or_default();
    let snippets: Vec<Snippet> = serde_json::from_value(payload["snippets"].clone()).unwrap_or_default();
    let tunnels: Vec<TunnelDef> = serde_json::from_value(payload["tunnels"].clone()).unwrap_or_default();
    let tunnel_hosts = tunnels.iter().map(|t| t.host_id.clone()).collect();
    Ok(Backup { hosts, snippets, tunnels, tunnel_hosts })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openssh_config() {
        let dir = std::env::temp_dir().join("msp_test_ssh_config");
        std::fs::write(
            &dir,
            "Host *\n  User admin\n\nHost web1 web2\n  HostName 10.0.0.%h\n  Port 2222\n\nHost db\n  HostName db.internal\n  User root\n  ProxyJump bastion\n  IdentityFile ~/.ssh/db_key\n",
        )
        .unwrap();
        let mut w = vec![];
        let r = parse_openssh(&dir, &mut w).unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].username, "admin");
        assert_eq!(r[0].port, 2222);
        assert_eq!(r[2].jump_alias.as_deref(), Some("bastion"));
        assert_eq!(r[2].key_path.as_deref(), Some("~/.ssh/db_key"));
    }

    #[test]
    fn csv() {
        let r = parse_csv("name,host,port,user,password\n\"web, prod\",1.2.3.4,22,root,\"p\"\"w\"\n").unwrap();
        assert_eq!(r[0].name, "web, prod");
        assert_eq!(r[0].password.as_deref(), Some("p\"w"));
    }

    #[test]
    fn moba() {
        let r = parse_mobaxterm("[Bookmarks_1]\nSubRep=prod\\web\nImgNum=41\nweb1=#109#0%10.0.0.1%22%root%%-1%-1%%%22%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%1%-1#0# #-1\n");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].host, "10.0.0.1");
        assert_eq!(r[0].group, "prod/web");
    }
}
