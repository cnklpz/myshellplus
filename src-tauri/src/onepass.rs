//! SSH agent access (1Password, Windows OpenSSH agent, SSH_AUTH_SOCK) and reading host details from
//! 1Password items through the `op` CLI. Private keys never leave the agent; we only ask it to sign.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use serde::Serialize;
use serde_json::Value;

pub type Agent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

#[cfg(windows)]
const AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

pub async fn agent_connect() -> Result<Agent> {
    #[cfg(windows)]
    {
        let c = AgentClient::connect_named_pipe(AGENT_PIPE).await.map_err(|_| anyhow!("未检测到 SSH Agent"))?;
        Ok(c.dynamic())
    }
    #[cfg(unix)]
    {
        let mut paths: Vec<PathBuf> = std::env::var_os("SSH_AUTH_SOCK").map(PathBuf::from).into_iter().collect();
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".1password/agent.sock"));
            paths.push(home.join("Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"));
        }
        for p in paths {
            if let Ok(c) = AgentClient::connect_uds(&p).await {
                return Ok(c.dynamic());
            }
        }
        bail!("未检测到 SSH Agent")
    }
}

pub fn fingerprint(k: &PublicKey) -> String {
    k.fingerprint(HashAlg::Sha256).to_string()
}

/// Plain public keys held by the agent (certificates are skipped).
pub async fn agent_identities(agent: &mut Agent) -> Result<Vec<(PublicKey, String)>> {
    let ids = agent.request_identities().await.context("读取 Agent 密钥失败")?;
    Ok(ids
        .into_iter()
        .filter_map(|i| match i {
            AgentIdentity::PublicKey { key, comment } => Some((key, comment)),
            _ => None,
        })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentKey {
    pub fingerprint: String,
    pub comment: String,
    pub algo: String,
}

pub async fn agent_keys() -> Result<Vec<AgentKey>> {
    let mut a = agent_connect().await?;
    Ok(agent_identities(&mut a)
        .await?
        .into_iter()
        .map(|(k, comment)| AgentKey { fingerprint: fingerprint(&k), comment, algo: k.algorithm().to_string() })
        .collect())
}

// ---------------- 1Password ----------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpAccount {
    pub id: String,
    pub email: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpStatus {
    /// 1Password desktop app is installed or running.
    pub detected: bool,
    /// The SSH agent pipe/socket answers.
    pub agent: bool,
    /// `op` CLI is available (needed to read host/user/port).
    pub cli: bool,
    pub accounts: Vec<OpAccount>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpItem {
    pub id: String,
    pub title: String,
    /// SSH_KEY | SERVER | LOGIN | AGENT (agent-only fallback, id = key fingerprint)
    pub category: String,
    pub vault: String,
    pub subtitle: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpHost {
    pub title: String,
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub password: Option<String>,
    /// SHA256 fingerprint of the item's SSH key, for agent auth.
    pub key_fingerprint: Option<String>,
}

fn app_detected() -> bool {
    #[cfg(windows)]
    {
        let running = std::fs::read_dir(r"\\.\pipe\")
            .map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().to_lowercase().starts_with("1password")))
            .unwrap_or(false);
        running || dirs::data_local_dir().is_some_and(|d| d.join("1Password").join("app").exists())
    }
    #[cfg(target_os = "macos")]
    {
        std::path::Path::new("/Applications/1Password.app").exists()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs::home_dir().is_some_and(|h| h.join(".1password").exists()) || std::path::Path::new("/opt/1Password").exists()
    }
}

fn op_path() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "op.exe" } else { "op" };
    let mut cands: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join(exe)).collect())
        .unwrap_or_default();
    #[cfg(windows)]
    {
        if let Some(d) = dirs::data_local_dir() {
            cands.push(d.join(r"Microsoft\WinGet\Links\op.exe"));
            cands.push(d.join(r"1Password\op.exe"));
        }
        cands.push(PathBuf::from(r"C:\Program Files\1Password CLI\op.exe"));
    }
    #[cfg(unix)]
    {
        cands.push(PathBuf::from("/usr/local/bin/op"));
        cands.push(PathBuf::from("/opt/homebrew/bin/op"));
    }
    cands.into_iter().find(|p| p.is_file())
}

/// Runs `op <args> --format json`. Generous timeout: the first call waits for the user to unlock 1Password.
async fn op_json(args: &[&str]) -> Result<Value> {
    let exe = op_path().ok_or_else(|| anyhow!("未安装 1Password CLI"))?;
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(args).args(["--format", "json"]).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let out = tokio::time::timeout(Duration::from_secs(90), cmd.output())
        .await
        .map_err(|_| anyhow!("1Password 未响应"))??;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        // "[ERROR] 2024/01/01 12:00:00 message" → "message"
        let msg = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        let msg = msg.strip_prefix("[ERROR]").map(|m| m.trim().splitn(3, ' ').nth(2).unwrap_or(m)).unwrap_or(msg);
        bail!("1Password: {}", if msg.is_empty() { "调用失败" } else { msg });
    }
    if out.stdout.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(Value::Array(vec![]));
    }
    Ok(serde_json::from_slice(&out.stdout).context("1Password 返回格式无法解析")?)
}

pub async fn status() -> OpStatus {
    let agent = agent_connect().await.is_ok();
    let cli = op_path().is_some();
    let accounts = if cli {
        op_json(&["account", "list"])
            .await
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .map(|a| OpAccount {
                id: s(a, "account_uuid"),
                email: s(a, "email"),
                url: s(a, "url"),
            })
            .collect()
    } else {
        vec![]
    };
    OpStatus { detected: app_detected() || cli, agent, cli, accounts }
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn with_account<'a>(mut args: Vec<&'a str>, account: Option<&'a str>) -> Vec<&'a str> {
    if let Some(a) = account.filter(|a| !a.is_empty()) {
        args.extend(["--account", a]);
    }
    args
}

pub async fn items(account: Option<String>) -> Result<Vec<OpItem>> {
    if op_path().is_none() {
        // Without the CLI only the agent's keys are visible (1Password sets the comment to the item title).
        return Ok(agent_keys()
            .await?
            .into_iter()
            .map(|k| OpItem { title: k.comment, category: "AGENT".into(), vault: String::new(), subtitle: k.fingerprint.clone(), id: k.fingerprint })
            .collect());
    }
    let args = with_account(vec!["item", "list", "--categories", "SSH Key,Server,Login"], account.as_deref());
    let v = op_json(&args).await?;
    let mut out: Vec<OpItem> = v
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|i| {
            let url = i
                .get("urls")
                .and_then(|u| u.as_array())
                .and_then(|u| u.iter().find(|x| x.get("primary").and_then(|p| p.as_bool()) == Some(true)).or(u.first()))
                .map(|u| s(u, "href"))
                .unwrap_or_default();
            let extra = s(i, "additional_information");
            OpItem {
                id: s(i, "id"),
                title: s(i, "title"),
                category: s(i, "category"),
                vault: i.get("vault").map(|v| s(v, "name")).unwrap_or_default(),
                subtitle: if url.is_empty() { extra } else { url },
            }
        })
        .collect();
    // SSH keys first, then servers, then logins.
    let rank = |c: &str| match c {
        "SSH_KEY" => 0,
        "SERVER" => 1,
        _ => 2,
    };
    out.sort_by(|a, b| rank(&a.category).cmp(&rank(&b.category)).then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase())));
    Ok(out)
}

/// Accepts an item id, an `op://vault/item[/field]` reference or a 1Password private link
/// (`https://start.1password.com/open/i?a=ACCOUNT&v=VAULT&i=ITEM`).
fn parse_ref(r: &str) -> (Option<String>, String, Option<String>) {
    let r = r.trim();
    if let Some(rest) = r.strip_prefix("op://") {
        let mut it = rest.split('/');
        let vault = it.next().map(str::to_string);
        let item = it.next().unwrap_or("").to_string();
        return (vault, item, None);
    }
    if r.contains("1password") && r.contains('?') {
        let q = r.split_once('?').map(|x| x.1).unwrap_or("");
        let get = |k: &str| q.split('&').find_map(|p| p.strip_prefix(k).and_then(|v| v.strip_prefix('='))).map(str::to_string);
        if let Some(i) = get("i") {
            return (get("v"), i, get("a"));
        }
    }
    (None, r.to_string(), None)
}

pub async fn item(reference: String, account: Option<String>) -> Result<OpHost> {
    let (vault, id, link_account) = parse_ref(&reference);
    if id.is_empty() {
        bail!("无效的条目 ID");
    }
    let account = link_account.or(account);
    let mut base = vec!["item", "get", id.as_str()];
    if let Some(v) = vault.as_deref() {
        base.extend(["--vault", v]);
    }
    let args = with_account(base.clone(), account.as_deref());
    let mut revealed = args.clone();
    revealed.push("--reveal");
    let v = match op_json(&revealed).await {
        // Older CLIs return concealed values in JSON already and reject --reveal.
        Err(e) if e.to_string().contains("unknown flag") => op_json(&args).await?,
        r => r?,
    };
    Ok(parse_item(&v))
}

fn parse_item(v: &Value) -> OpHost {
    let fields: Vec<&Value> = v.get("fields").and_then(|f| f.as_array()).map(|a| a.iter().collect()).unwrap_or_default();
    let norm = |f: &Value| (s(f, "id").to_lowercase(), s(f, "label").to_lowercase());
    let find = |names: &[&str]| -> Option<String> {
        fields.iter().find_map(|f| {
            let (id, label) = norm(f);
            let val = s(f, "value");
            (!val.trim().is_empty() && names.iter().any(|n| id == *n || label == *n)).then(|| val.trim().to_string())
        })
    };
    let category = s(v, "category");
    let mut h = OpHost { title: s(v, "title"), ..Default::default() };

    // Address: explicit host-like fields, then the item's URLs.
    let mut addr = find(&["host", "hostname", "server", "address", "ip", "url", "地址", "主机", "服务器"]);
    if addr.is_none() {
        let urls = v.get("urls").and_then(|u| u.as_array()).cloned().unwrap_or_default();
        addr = urls
            .iter()
            .find(|u| u.get("primary").and_then(|p| p.as_bool()) == Some(true))
            .or(urls.first())
            .map(|u| s(u, "href"))
            .filter(|x| !x.is_empty());
    }
    if let Some(a) = addr {
        let (user, host, port) = split_addr(&a);
        h.host = host;
        h.port = port;
        if let Some(u) = user {
            h.username = u;
        }
    }
    if let Some(p) = find(&["port", "端口"]).and_then(|p| p.parse().ok()) {
        h.port = Some(p);
    }
    let user = fields
        .iter()
        .find(|f| s(f, "purpose") == "USERNAME" && !s(f, "value").is_empty())
        .map(|f| s(f, "value"))
        .or_else(|| find(&["username", "user", "用户名", "用户"]));
    if let Some(u) = user {
        h.username = u;
    }
    if category == "SSH_KEY" {
        h.key_fingerprint = find(&["fingerprint"]).or_else(|| {
            find(&["public_key", "public key"]).and_then(|p| PublicKey::from_openssh(&p).ok()).map(|k| fingerprint(&k))
        });
    } else {
        h.password = fields
            .iter()
            .find(|f| s(f, "purpose") == "PASSWORD" || (s(f, "id") == "password" && s(f, "type") == "CONCEALED"))
            .map(|f| s(f, "value"))
            .filter(|p| !p.is_empty());
    }
    h
}

/// `ssh://user@host:2222/path`, `host:2222`, `[::1]:22`, `user@host` → (user, host, port)
fn split_addr(raw: &str) -> (Option<String>, String, Option<u16>) {
    let mut a = raw.trim();
    if let Some((_, rest)) = a.split_once("://") {
        a = rest;
    }
    a = a.split(['/', '?', '#']).next().unwrap_or("");
    let mut user = None;
    if let Some((u, rest)) = a.rsplit_once('@') {
        user = Some(u.split(':').next().unwrap_or(u).to_string()).filter(|u| !u.is_empty());
        a = rest;
    }
    if let Some(rest) = a.strip_prefix('[') {
        if let Some((h, tail)) = rest.split_once(']') {
            let port = tail.strip_prefix(':').and_then(|p| p.parse().ok());
            return (user, h.to_string(), port);
        }
    }
    match a.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (user, h.to_string(), p.parse().ok()),
        _ => (user, a.to_string(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addr_forms() {
        assert_eq!(split_addr("ssh://root@10.0.0.1:2222"), (Some("root".into()), "10.0.0.1".into(), Some(2222)));
        assert_eq!(split_addr("example.com"), (None, "example.com".into(), None));
        assert_eq!(split_addr("https://example.com/login"), (None, "example.com".into(), None));
        assert_eq!(split_addr("[::1]:22"), (None, "::1".into(), Some(22)));
        assert_eq!(split_addr("fe80::1"), (None, "fe80::1".into(), None));
    }

    #[test]
    fn refs() {
        assert_eq!(parse_ref("op://Private/web01/password"), (Some("Private".into()), "web01".into(), None));
        assert_eq!(
            parse_ref("https://start.1password.com/open/i?a=ACC&v=VLT&i=ITEM&h=my.1password.com"),
            (Some("VLT".into()), "ITEM".into(), Some("ACC".into()))
        );
        assert_eq!(parse_ref(" abc123 "), (None, "abc123".into(), None));
    }

    #[test]
    fn server_item() {
        let v: Value = serde_json::json!({
            "title": "web", "category": "SERVER",
            "fields": [
                {"id": "url", "label": "URL", "value": "10.0.0.5:2200"},
                {"id": "username", "label": "username", "value": "ops"},
                {"id": "password", "type": "CONCEALED", "label": "password", "value": "pw"}
            ]
        });
        let h = parse_item(&v);
        assert_eq!((h.host.as_str(), h.port, h.username.as_str(), h.password.as_deref()), ("10.0.0.5", Some(2200), "ops", Some("pw")));
    }
}

#[cfg(test)]
mod live {
    /// Talks to the real local agent: `cargo test --lib onepass::live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn list_agent_keys() {
        let st = super::status().await;
        println!("detected={} agent={} cli={} accounts={}", st.detected, st.agent, st.cli, st.accounts.len());
        for k in super::agent_keys().await.unwrap() {
            println!("{} {} {}", k.algo, k.fingerprint, k.comment);
        }
    }
}
