//! SSH connection pool. One SSH connection per host is shared by terminals, monitoring,
//! SFTP, exec and tunnels (channels are multiplexed).

pub mod exec;

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use russh::client::{self, ChannelOpenHandle, Handle, KeyboardInteractiveAuthResponse, Msg, Session};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate, decode_secret_key};
use russh::Channel;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use serde_json::json;
use tauri::Emitter;

use crate::db::Host;
use crate::state::Ctx;

/// Remote (-R) forwards registered on a connection: bound remote port -> local target.
pub type ForwardMap = Arc<Mutex<HashMap<u32, (String, u16)>>>;

pub struct ClientHandler {
    ctx: Weak<Ctx>,
    host_id: String,
    host: String,
    port: u16,
    forwards: ForwardMap,
}

fn key_info(k: &PublicKeyOrCertificate) -> (String, String) {
    match k {
        PublicKeyOrCertificate::PublicKey { key, .. } => {
            (key.algorithm().as_str().to_string(), key.fingerprint(HashAlg::Sha256).to_string())
        }
        PublicKeyOrCertificate::Certificate(c) => {
            (c.algorithm().as_str().to_string(), c.public_key().fingerprint(HashAlg::Sha256).to_string())
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let Some(ctx) = self.ctx.upgrade() else { return Ok(false) };
        let (algo, fp) = key_info(key);
        emit_step(&ctx, &self.host_id, "校验主机指纹", Some(format!("{algo} {fp}")));
        let known = ctx.db.known_host(&self.host, self.port).ok().flatten();
        let changed = match &known {
            Some((_, kfp)) if *kfp == fp => return Ok(true),
            Some(_) => true,
            None => false,
        };
        let data = json!({
            "host": self.host, "port": self.port, "algo": algo, "fingerprint": fp,
            "changed": changed, "oldFingerprint": known.map(|k| k.1),
        });
        emit_step(&ctx, &self.host_id, if changed { "主机指纹已变化，等待确认" } else { "新主机，等待确认指纹" }, None);
        let ans = ctx.prompts.ask("hostkey", data, Duration::from_secs(180)).await;
        if ans.and_then(|v| v.as_bool()) == Some(true) {
            let _ = ctx.db.trust_host(&self.host, self.port, &algo, &fp);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let target = self.forwards.lock().get(&connected_port).cloned();
        let Some((th, tp)) = target else {
            return Ok(()); // dropping `reply` rejects
        };
        reply.accept().await;
        tauri::async_runtime::spawn(async move {
            if let Ok(mut tcp) = tokio::net::TcpStream::connect((th.as_str(), tp)).await {
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
            }
        });
        Ok(())
    }
}

pub struct Conn {
    pub host_id: String,
    pub handle: Handle<ClientHandler>,
    pub forwards: ForwardMap,
    sftp: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
    /// Last measured SSH ping round trip (ms).
    pub latency: Mutex<Option<u32>>,
    /// Unix ms when the session was authenticated.
    pub since: u64,
    /// Keeps the jump connection alive while this one exists.
    _jump: Option<Arc<Conn>>,
}

impl Conn {
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub async fn sftp(&self) -> Result<Arc<SftpSession>> {
        let mut g = self.sftp.lock().await;
        if let Some(s) = g.as_ref() {
            // Probe: a dead SFTP session errors out fast.
            if s.canonicalize(".").await.is_ok() {
                return Ok(s.clone());
            }
        }
        let ch = self.handle.channel_open_session().await?;
        ch.request_subsystem(true, "sftp").await?;
        let s = Arc::new(SftpSession::new(ch.into_stream()).await.context("SFTP 初始化失败")?);
        *g = Some(s.clone());
        Ok(s)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnState {
    pub host_id: String,
    pub state: String,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Pool {
    conns: Mutex<HashMap<String, Arc<Conn>>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Pool {
    pub fn connected_ids(&self) -> Vec<String> {
        self.conns.lock().iter().filter(|(_, c)| !c.is_closed()).map(|(k, _)| k.clone()).collect()
    }

    pub fn latencies(&self) -> Vec<Latency> {
        self.conns
            .lock()
            .values()
            .map(|c| Latency { host_id: c.host_id.clone(), ms: *c.latency.lock(), since: c.since })
            .collect()
    }

    pub fn existing(&self, host_id: &str) -> Option<Arc<Conn>> {
        self.conns.lock().get(host_id).filter(|c| !c.is_closed()).cloned()
    }

    pub async fn disconnect(&self, host_id: &str) {
        let c = self.conns.lock().remove(host_id);
        if let Some(c) = c {
            let _ = c.handle.disconnect(russh::Disconnect::ByApplication, "", "zh").await;
        }
    }
}

/// Get (or open) the shared connection for a host.
pub fn get_conn(ctx: Arc<Ctx>, host_id: String) -> BoxFuture<'static, Result<Arc<Conn>>> {
    get_conn_depth(ctx, host_id, 0)
}

fn get_conn_depth(ctx: Arc<Ctx>, host_id: String, depth: u8) -> BoxFuture<'static, Result<Arc<Conn>>> {
    Box::pin(async move {
        if depth > 4 {
            bail!("跳板机链过长或存在循环");
        }
        if let Some(c) = ctx.pool.existing(&host_id) {
            return Ok(c);
        }
        let lock = ctx.pool.locks.lock().entry(host_id.clone()).or_default().clone();
        let _g = match lock.try_lock() {
            Ok(g) => g,
            Err(_) => {
                emit_step(&ctx, &host_id, "等待进行中的连接", None);
                lock.lock().await
            }
        };
        if let Some(c) = ctx.pool.existing(&host_id) {
            emit_step(&ctx, &host_id, "复用已有连接", None);
            return Ok(c);
        }
        emit_state(&ctx, &host_id, "connecting", None);
        match connect(ctx.clone(), &host_id, depth).await {
            Ok(c) => {
                ctx.pool.conns.lock().insert(host_id.clone(), c.clone());
                set_failure(&ctx, &host_id, None);
                emit_state(&ctx, &host_id, "connected", None);
                spawn_os_probe(ctx.clone(), c.clone());
                spawn_watch(ctx.clone(), c.clone());
                Ok(c)
            }
            Err(e) => {
                set_failure(&ctx, &host_id, Some(format!("{e:#}")));
                emit_state(&ctx, &host_id, "error", Some(format!("{e:#}")));
                Err(e)
            }
        }
    })
}

fn emit_state(ctx: &Ctx, host_id: &str, state: &str, error: Option<String>) {
    let _ = ctx.app.emit("conn-state", ConnState { host_id: host_id.into(), state: state.into(), error });
}

/// One step of an in-progress connect, shown live in the UI's connect dialog.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnStep {
    pub host_id: String,
    pub label: String,
    pub detail: Option<String>,
}

pub fn emit_step(ctx: &Ctx, host_id: &str, label: &str, detail: Option<String>) {
    let _ = ctx.app.emit("conn-step", ConnStep { host_id: host_id.into(), label: label.into(), detail });
}

/// Last connect failure of a host, kept until it connects again or the user dismisses it.
#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub error: String,
    pub at: i64,
}

const FAILURES_KEY: &str = "conn_failures";

pub fn failures(ctx: &Ctx) -> HashMap<String, Failure> {
    ctx.db.setting(FAILURES_KEY).ok().flatten().unwrap_or_default()
}

/// Record (Some) or clear (None) the last failure of a host; notifies the UI on change.
pub fn set_failure(ctx: &Ctx, host_id: &str, error: Option<String>) {
    let mut map = failures(ctx);
    let changed = match error {
        Some(error) => {
            map.insert(host_id.into(), Failure { error, at: crate::util::now_ms() });
            true
        }
        None => map.remove(host_id).is_some(),
    };
    if changed {
        let _ = ctx.db.set_setting(FAILURES_KEY, &map);
        let _ = ctx.app.emit("conn-failures", &map);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Latency {
    pub host_id: String,
    /// Round trip of an SSH ping in ms (None = no reply within 5s).
    pub ms: Option<u32>,
    /// Unix ms when the connection was established.
    pub since: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub host_id: String,
    /// Round trip in ms; None = unreachable / timed out.
    pub ms: Option<u32>,
    /// ssh = ping over the live connection, tcp = TCP handshake to the server (or its jump host).
    pub via: String,
    pub error: Option<String>,
}

/// Manual latency test: SSH ping when connected, otherwise time a TCP handshake (DNS excluded).
pub async fn probe(ctx: Arc<Ctx>, host_id: String) -> Probe {
    if let Some(c) = ctx.pool.existing(&host_id) {
        let start = std::time::Instant::now();
        let ok = tokio::time::timeout(Duration::from_secs(5), c.handle.send_ping()).await;
        let ms = matches!(ok, Ok(Ok(()))).then(|| start.elapsed().as_millis() as u32);
        *c.latency.lock() = ms;
        let _ = ctx.app.emit("latency", Latency { host_id: host_id.clone(), ms, since: c.since });
        let error = ms.is_none().then(|| "超时".to_string());
        return Probe { host_id, ms, via: "ssh".into(), error };
    }
    let r: Result<u32> = async {
        let mut h = ctx.db.get_host(&host_id)?;
        // Behind a jump host the target is usually not reachable directly: measure the first hop.
        for _ in 0..4 {
            match h.jump_host_id.clone().filter(|s| !s.is_empty()) {
                Some(j) => h = ctx.db.get_host(&j)?,
                None => break,
            }
        }
        let addr = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((h.host.as_str(), h.port)))
            .await
            .map_err(|_| anyhow!("域名解析超时"))?
            .context("域名解析失败")?
            .next()
            .ok_or_else(|| anyhow!("域名解析失败"))?;
        let start = std::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(3), tokio::net::TcpStream::connect(addr))
            .await
            .map_err(|_| anyhow!("超时"))?
            .context("无法连接")?;
        Ok(start.elapsed().as_millis().max(1) as u32)
    }
    .await;
    match r {
        Ok(ms) => Probe { host_id, ms: Some(ms), via: "tcp".into(), error: None },
        Err(e) => Probe { host_id, ms: None, via: "tcp".into(), error: Some(format!("{e:#}")) },
    }
}

/// Remember the remote OS name (shown on the home cards) after each connect.
fn spawn_os_probe(ctx: Arc<Ctx>, c: Arc<Conn>) {
    tauri::async_runtime::spawn(async move {
        let cmd = ". /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\" || uname -sr";
        let Ok(r) = exec::run(&c, cmd, Duration::from_secs(10)).await else { return };
        let os = r.stdout.lines().next().unwrap_or("").trim().to_string();
        if os.is_empty() || os.len() > 120 {
            return;
        }
        let mut map: std::collections::HashMap<String, String> = ctx.db.setting("host_os").ok().flatten().unwrap_or_default();
        if map.get(&c.host_id) != Some(&os) {
            map.insert(c.host_id.clone(), os);
            let _ = ctx.db.set_setting("host_os", &map);
            let _ = ctx.app.emit("host-os", &map);
        }
    });
}

/// Notify the UI when a pooled connection drops, and sample network latency (SSH ping RTT).
fn spawn_watch(ctx: Arc<Ctx>, c: Arc<Conn>) {
    let weak = Arc::downgrade(&c);
    drop(c);
    tauri::async_runtime::spawn(async move {
        let mut tick: u32 = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            tick += 1;
            let Some(c) = weak.upgrade() else { return };
            if tick % 2 == 1 && !c.is_closed() {
                let start = std::time::Instant::now();
                let ok = tokio::time::timeout(Duration::from_secs(5), c.handle.send_ping()).await;
                let ms = matches!(ok, Ok(Ok(()))).then(|| start.elapsed().as_millis() as u32);
                *c.latency.lock() = ms;
                let _ = ctx.app.emit("latency", Latency { host_id: c.host_id.clone(), ms, since: c.since });
            }
            if c.is_closed() {
                let id = c.host_id.clone();
                let mut m = ctx.pool.conns.lock();
                if m.get(&id).is_some_and(|x| Arc::ptr_eq(x, &c)) {
                    m.remove(&id);
                }
                drop(m);
                emit_state(&ctx, &id, "disconnected", None);
                return;
            }
        }
    });
}

async fn connect(ctx: Arc<Ctx>, host_id: &str, depth: u8) -> Result<Arc<Conn>> {
    let host = ctx.db.get_host(host_id)?;
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        inactivity_timeout: None,
        nodelay: true,
        ..Default::default()
    });
    let forwards: ForwardMap = Default::default();
    let handler = ClientHandler {
        ctx: Arc::downgrade(&ctx),
        host_id: host.id.clone(),
        host: host.host.clone(),
        port: host.port,
        forwards: forwards.clone(),
    };

    let mut jump = None;
    let connect_fut = async {
        if let Some(jid) = host.jump_host_id.clone().filter(|s| !s.is_empty()) {
            let jname = ctx.db.get_host(&jid).map(|h| h.name).unwrap_or_default();
            emit_step(&ctx, host_id, "连接跳板机", Some(jname));
            let j = get_conn_depth(ctx.clone(), jid, depth + 1).await.context("跳板机连接失败")?;
            emit_step(&ctx, host_id, "经跳板机连接目标", Some(format!("{}:{}", host.host, host.port)));
            let ch = j
                .handle
                .channel_open_direct_tcpip(host.host.clone(), host.port as u32, "127.0.0.1", 0)
                .await
                .context("跳板机无法连到目标")?;
            jump = Some(j);
            emit_step(&ctx, host_id, "SSH 握手", None);
            client::connect_stream(config, ch.into_stream(), handler).await.map_err(anyhow::Error::from)
        } else {
            emit_step(&ctx, host_id, "解析地址", Some(host.host.clone()));
            let addrs: Vec<_> = tokio::net::lookup_host((host.host.as_str(), host.port))
                .await
                .context("域名解析失败")?
                .collect();
            let mut last = anyhow!("域名解析失败");
            let mut tcp = None;
            for a in addrs {
                emit_step(&ctx, host_id, "TCP 连接", Some(a.to_string()));
                match tokio::net::TcpStream::connect(a).await {
                    Ok(s) => {
                        tcp = Some(s);
                        break;
                    }
                    Err(e) => last = e.into(),
                }
            }
            let tcp = tcp.ok_or(last)?;
            let _ = tcp.set_nodelay(true);
            emit_step(&ctx, host_id, "SSH 握手", None);
            client::connect_stream(config, tcp, handler).await.map_err(anyhow::Error::from)
        }
    };
    let mut handle = tokio::time::timeout(Duration::from_secs(20), connect_fut)
        .await
        .map_err(|_| anyhow!("连接超时"))?
        .with_context(|| format!("无法连接 {}:{}", host.host, host.port))?;

    authenticate(&ctx, &host, &mut handle).await?;

    Ok(Arc::new(Conn {
        host_id: host.id.clone(),
        handle,
        forwards,
        sftp: Default::default(),
        latency: Mutex::new(None),
        since: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
        _jump: jump,
    }))
}

async fn authenticate(ctx: &Ctx, host: &Host, handle: &mut Handle<ClientHandler>) -> Result<()> {
    match host.auth_type.as_str() {
        "key" => {
            let kid = host.key_id.as_deref().ok_or_else(|| anyhow!("未选择密钥"))?;
            let k = ctx.db.get_key(kid)?;
            emit_step(ctx, &host.id, "身份认证", Some(format!("{} · 密钥 {}", host.username, k.name)));
            let pem = ctx.vault.get(&k.private_secret)?;
            let pass = match &k.passphrase_secret {
                Some(id) => Some(ctx.vault.get(id)?),
                None => None,
            };
            let key = decode_secret_key(&pem, pass.as_ref().map(|s| s.as_str())).context("私钥解析失败")?;
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            let r = handle
                .authenticate_publickey(&host.username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?;
            if !r.success() {
                bail!("密钥认证失败");
            }
        }
        // key_id holds the SHA256 fingerprint of the agent key to use; empty = try every key.
        "agent" => {
            let want = host.key_id.as_deref().filter(|s| !s.is_empty());
            let mut agent = crate::onepass::agent_connect().await?;
            let keys: Vec<_> = crate::onepass::agent_identities(&mut agent)
                .await?
                .into_iter()
                .filter(|(k, _)| want.is_none_or(|w| crate::onepass::fingerprint(k) == w))
                .collect();
            if keys.is_empty() {
                bail!(if want.is_some() { "Agent 中找不到所选密钥" } else { "Agent 中没有密钥" });
            }
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            for (k, comment) in keys {
                emit_step(ctx, &host.id, "身份认证", Some(format!("{} · Agent {}", host.username, comment)));
                let h = if k.algorithm().is_rsa() { hash } else { None };
                let r = handle
                    .authenticate_publickey_with(&host.username, k, h, &mut agent)
                    .await
                    .map_err(|e| anyhow!("Agent 签名失败: {e}"))?;
                if r.success() {
                    return Ok(());
                }
            }
            bail!("Agent 密钥认证失败");
        }
        _ => {
            let sid = host.password_secret.as_deref().ok_or_else(|| anyhow!("未设置密码"))?;
            let pw = ctx.vault.get(sid)?;
            emit_step(ctx, &host.id, "身份认证", Some(format!("{} · 密码", host.username)));
            let r = handle.authenticate_password(&host.username, pw.as_str()).await?;
            if r.success() {
                return Ok(());
            }
            // Many servers only allow keyboard-interactive; answer every prompt with the password.
            emit_step(ctx, &host.id, "键盘交互认证", None);
            let mut resp = handle.authenticate_keyboard_interactive_start(&host.username, None).await?;
            for _ in 0..5 {
                match resp {
                    KeyboardInteractiveAuthResponse::Success => return Ok(()),
                    KeyboardInteractiveAuthResponse::Failure { .. } => break,
                    KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                        let answers = prompts.iter().map(|_| pw.to_string()).collect();
                        resp = handle.authenticate_keyboard_interactive_respond(answers).await?;
                    }
                }
            }
            bail!("用户名或密码错误");
        }
    }
    Ok(())
}
