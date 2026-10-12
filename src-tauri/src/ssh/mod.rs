//! SSH connection pool. One SSH connection per host is shared by terminals, monitoring,
//! SFTP, exec and tunnels (channels are multiplexed).

pub mod exec;
mod socks;

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

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
use tokio::io::{AsyncRead, AsyncWrite};

use crate::db::{Db, Host};
use crate::state::Ctx;

/// TCP / proxy / jump-host setup (DNS, TCP connect, SOCKS handshake, direct-tcpip channel).
const SETUP_TIMEOUT: Duration = Duration::from_secs(20);
/// SSH key exchange, not counting the time the user spends on the host key prompt.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Agent auth may wait for the user to approve in 1Password.
const AGENT_AUTH_TIMEOUT: Duration = Duration::from_secs(120);
/// Jump hosts allowed in front of a host.
pub const MAX_JUMPS: usize = 4;

/// A remote (-R) forward registered on a connection.
pub struct RemoteForward {
    pub host: String,
    pub port: u16,
    /// Resolves (sender dropped) when the tunnel stops; ends its open forwarded connections.
    pub cancel: tokio::sync::watch::Receiver<()>,
}

/// Remote (-R) forwards registered on a connection: bound remote port -> local target.
pub type ForwardMap = Arc<Mutex<HashMap<u32, RemoteForward>>>;

/// Time spent waiting for the user during one connect attempt (host key prompt), which must not
/// count against the handshake timeout.
#[derive(Default)]
struct UserWait {
    inner: Mutex<(Duration, Option<Instant>)>,
}

impl UserWait {
    fn begin(self: &Arc<Self>) -> UserWaitGuard {
        self.inner.lock().1 = Some(Instant::now());
        UserWaitGuard(self.clone())
    }

    /// (total time waited so far, waiting right now)
    fn waited(&self) -> (Duration, bool) {
        let g = self.inner.lock();
        (g.0 + g.1.map(|s| s.elapsed()).unwrap_or_default(), g.1.is_some())
    }
}

struct UserWaitGuard(Arc<UserWait>);

impl Drop for UserWaitGuard {
    fn drop(&mut self) {
        let mut g = self.0.inner.lock();
        if let Some(s) = g.1.take() {
            g.0 += s.elapsed();
        }
    }
}

/// `tokio::time::timeout`, except that time spent waiting for the user does not count. `wait` is
/// shared by several phases (handshake, auth), so only the waiting done during this call is
/// excluded, not a prompt from an earlier phase.
async fn timeout_excluding_user<F: Future>(limit: Duration, wait: &UserWait, fut: F) -> Option<F::Output> {
    let start = Instant::now();
    let base = wait.waited().0;
    let mut fut = std::pin::pin!(fut);
    loop {
        let (waited, waiting) = wait.waited();
        let used = start.elapsed().saturating_sub(waited.saturating_sub(base));
        if used >= limit && !waiting {
            return None;
        }
        let nap = limit.saturating_sub(used).max(Duration::from_millis(200));
        tokio::select! {
            r = &mut fut => return Some(r),
            _ = tokio::time::sleep(nap) => {}
        }
    }
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

pub struct ClientHandler {
    ctx: Weak<Ctx>,
    host_id: String,
    host: String,
    port: u16,
    forwards: ForwardMap,
    wait: Arc<UserWait>,
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
        let ans = {
            let _waiting = self.wait.begin();
            ctx.prompts.ask("hostkey", data, Duration::from_secs(180)).await
        };
        if ans.and_then(|v| v.as_bool()) == Some(true) {
            if let Err(e) = ctx.db.trust_host(&self.host, self.port, &algo, &fp) {
                log::warn!(target: &crate::applog::conn_target(&self.host_id), "保存主机指纹失败: {e:#}");
            }
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
        let target = self.forwards.lock().get(&connected_port).map(|f| (f.host.clone(), f.port, f.cancel.clone()));
        let Some((th, tp, mut cancel)) = target else {
            return Ok(()); // dropping `reply` rejects
        };
        reply.accept().await;
        tauri::async_runtime::spawn(async move {
            let fwd = async {
                if let Ok(mut tcp) = tokio::net::TcpStream::connect((th.as_str(), tp)).await {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                }
            };
            tokio::select! {
                _ = fwd => {}
                _ = cancel.changed() => {}
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
    get_conn_chain(ctx, host_id, Vec::new())
}

fn host_name(db: &Db, id: &str) -> String {
    db.get_host(id).map(|h| h.name).unwrap_or_else(|_| id.to_string())
}

/// `chain`: the hosts connecting through this one. A jump-host cycle would otherwise wait
/// forever on its own per-host connect lock.
fn get_conn_chain(ctx: Arc<Ctx>, host_id: String, mut chain: Vec<String>) -> BoxFuture<'static, Result<Arc<Conn>>> {
    Box::pin(async move {
        if chain.contains(&host_id) {
            let names: Vec<String> = chain.iter().chain([&host_id]).map(|id| host_name(&ctx.db, id)).collect();
            bail!("跳板机存在循环: {}", names.join(" → "));
        }
        if chain.len() > MAX_JUMPS {
            bail!("跳板机链过长（最多 {MAX_JUMPS} 级）");
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
        let target = crate::applog::conn_target(&host_id);
        match ctx.db.get_host(&host_id) {
            Ok(h) => log::info!(target: &target, "开始连接 {}@{}:{} 认证={}", h.username, h.host, h.port, h.auth_type),
            Err(_) => log::info!(target: &target, "开始连接"),
        }
        let started = std::time::Instant::now();
        chain.push(host_id.clone());
        match connect(ctx.clone(), &host_id, &chain).await {
            Ok(c) => {
                log::info!(target: &target, "连接成功 {}ms", started.elapsed().as_millis());
                ctx.pool.conns.lock().insert(host_id.clone(), c.clone());
                set_failure(&ctx, &host_id, None);
                emit_state(&ctx, &host_id, "connected", None);
                spawn_os_probe(ctx.clone(), c.clone());
                spawn_watch(ctx.clone(), c.clone());
                Ok(c)
            }
            Err(e) => {
                log::warn!(target: &target, "连接失败 {}ms: {e:#}", started.elapsed().as_millis());
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
    log::info!(target: &crate::applog::conn_target(host_id), "{label} {}", detail.as_deref().unwrap_or(""));
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
    ctx.db.setting_or_default(FAILURES_KEY)
}

/// Record (Some) or clear (None) the last failure of a host; notifies the UI on change.
pub fn set_failure(ctx: &Ctx, host_id: &str, error: Option<String>) {
    let r = ctx.db.update_setting(FAILURES_KEY, |map: &mut HashMap<String, Failure>| match error {
        Some(error) => {
            map.insert(host_id.into(), Failure { error, at: crate::util::now_ms() });
            true
        }
        None => map.remove(host_id).is_some(),
    });
    match r {
        Ok(Some(map)) => {
            let _ = ctx.app.emit("conn-failures", &map);
        }
        Ok(None) => {}
        Err(e) => log::warn!("保存连接失败记录出错: {e:#}"),
    }
}

/// Reject jump-host chains that loop back or are too long (checked when saving a host).
pub fn validate_jump_chain(db: &Db, host: &Host) -> Result<()> {
    let mut seen = vec![host.id.clone()];
    let mut next = host.jump_host_id.clone().filter(|s| !s.is_empty());
    while let Some(j) = next {
        if seen.contains(&j) {
            bail!("跳板机不能形成循环");
        }
        if seen.len() > MAX_JUMPS {
            bail!("跳板机链过长（最多 {MAX_JUMPS} 级）");
        }
        // A missing jump host is reported when connecting.
        let Ok(h) = db.get_host(&j) else { break };
        seen.push(j);
        next = h.jump_host_id.filter(|s| !s.is_empty());
    }
    Ok(())
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
        // Behind a proxy, likewise measure the hop to the proxy.
        let (host, port) = match h.proxy_host.trim() {
            p if h.proxy_enabled && !p.is_empty() => (p, h.proxy_port),
            _ => (h.host.as_str(), h.port),
        };
        let addr = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host, port)))
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
        let r = ctx.db.update_setting("host_os", |map: &mut HashMap<String, String>| {
            if map.get(&c.host_id) == Some(&os) {
                return false;
            }
            map.insert(c.host_id.clone(), os);
            true
        });
        match r {
            Ok(Some(map)) => {
                let _ = ctx.app.emit("host-os", &map);
            }
            Ok(None) => {}
            Err(e) => log::warn!("保存系统名称出错: {e:#}"),
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
                let up = (crate::util::now_ms() as u64).saturating_sub(c.since) / 1000;
                log::warn!(target: &crate::applog::conn_target(&id), "连接断开，已连接 {up}s");
                emit_state(&ctx, &id, "disconnected", None);
                return;
            }
        }
    });
}

async fn connect(ctx: Arc<Ctx>, host_id: &str, chain: &[String]) -> Result<Arc<Conn>> {
    let host = ctx.db.get_host(host_id)?;
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        inactivity_timeout: None,
        nodelay: true,
        ..Default::default()
    });
    let forwards: ForwardMap = Default::default();
    let wait = Arc::new(UserWait::default());
    let handler = ClientHandler {
        ctx: Arc::downgrade(&ctx),
        host_id: host.id.clone(),
        host: host.host.clone(),
        port: host.port,
        forwards: forwards.clone(),
        wait: wait.clone(),
    };
    let unreachable = || format!("无法连接 {}:{}", host.host, host.port);

    // The jump host connects under its own timeouts (it may be waiting on its own host key prompt).
    let jump = match host.jump_host_id.clone().filter(|s| !s.is_empty()) {
        Some(jid) => {
            emit_step(&ctx, host_id, "连接跳板机", Some(host_name(&ctx.db, &jid)));
            Some(get_conn_chain(ctx.clone(), jid, chain.to_vec()).await.context("跳板机连接失败")?)
        }
        None => None,
    };

    // Transport only: the host key prompt and auth have their own limits below.
    let setup = async {
        if let Some(j) = &jump {
            emit_step(&ctx, host_id, "经跳板机连接目标", Some(format!("{}:{}", host.host, host.port)));
            let ch = j
                .handle
                .channel_open_direct_tcpip(host.host.clone(), host.port as u32, "127.0.0.1", 0)
                .await
                .context("跳板机无法连到目标")?;
            Ok::<Box<dyn Io>, anyhow::Error>(Box::new(ch.into_stream()) as Box<dyn Io>)
        } else if host.proxy_enabled && !host.proxy_host.trim().is_empty() {
            let (ph, pp) = (host.proxy_host.trim(), host.proxy_port);
            emit_step(&ctx, host_id, "连接代理", Some(format!("{ph}:{pp}")));
            let mut tcp = tokio::net::TcpStream::connect((ph, pp)).await.context("无法连接代理")?;
            let _ = tcp.set_nodelay(true);
            let pass = match &host.proxy_secret {
                Some(id) => Some(ctx.vault.get(id)?),
                None => None,
            };
            let user = host.proxy_user.trim();
            let auth = (!user.is_empty()).then(|| (user, pass.as_ref().map(|p| p.as_str()).unwrap_or("")));
            emit_step(&ctx, host_id, "经代理连接目标", Some(format!("{}:{}", host.host, host.port)));
            socks::handshake(&mut tcp, &host.host, host.port, auth).await.context("SOCKS5 代理握手失败")?;
            Ok(Box::new(tcp) as Box<dyn Io>)
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
            Ok(Box::new(tcp) as Box<dyn Io>)
        }
    };
    let stream = tokio::time::timeout(SETUP_TIMEOUT, setup)
        .await
        .map_err(|_| anyhow!("连接超时"))?
        .with_context(unreachable)?;

    emit_step(&ctx, host_id, "SSH 握手", None);
    let mut handle = timeout_excluding_user(HANDSHAKE_TIMEOUT, &wait, client::connect_stream(config, stream, handler))
        .await
        .ok_or_else(|| anyhow!("SSH 握手超时"))
        .with_context(unreachable)?
        .map_err(anyhow::Error::from)
        .with_context(unreachable)?;

    let auth_limit = if host.auth_type == "agent" { AGENT_AUTH_TIMEOUT } else { AUTH_TIMEOUT };
    timeout_excluding_user(auth_limit, &wait, authenticate(&ctx, &host, &mut handle))
        .await
        .ok_or_else(|| anyhow!("身份认证超时"))??;

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
            // bcrypt-pbkdf for encrypted keys is slow: keep it off the async workers.
            let key = tokio::task::spawn_blocking(move || decode_secret_key(&pem, pass.as_ref().map(|s| s.as_str())))
                .await?
                .context("私钥解析失败")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn host(db: &Db, id: &str, jump: Option<&str>) -> Host {
        let h: Host = serde_json::from_value(json!({
            "id": id, "name": id, "host": "10.0.0.1", "port": 22, "username": "root", "authType": "password",
            "jumpHostId": jump,
        }))
        .unwrap();
        db.save_host(h).unwrap()
    }

    #[test]
    fn jump_cycles_rejected() {
        let path = std::env::temp_dir().join(format!("msp-jump-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = Db::open(&path).unwrap();
        let a = host(&db, "a", None);
        host(&db, "b", Some("a"));
        assert!(validate_jump_chain(&db, &a).is_ok());
        // a -> b -> a
        let mut a2 = a.clone();
        a2.jump_host_id = Some("b".into());
        assert!(validate_jump_chain(&db, &a2).is_err());
        // self jump
        a2.jump_host_id = Some("a".into());
        assert!(validate_jump_chain(&db, &a2).is_err());
        // too long: c -> h1 -> h2 -> h3 -> h4 -> h5
        host(&db, "h5", None);
        host(&db, "h4", Some("h5"));
        host(&db, "h3", Some("h4"));
        host(&db, "h2", Some("h3"));
        let h1 = host(&db, "h1", Some("h2"));
        assert!(validate_jump_chain(&db, &h1).is_ok());
        let c: Host = serde_json::from_value(json!({
            "id": "c", "name": "c", "host": "x", "port": 22, "username": "u", "authType": "password", "jumpHostId": "h1",
        }))
        .unwrap();
        assert!(validate_jump_chain(&db, &c).is_err());
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn user_wait_excluded_from_timeout() {
        let wait = Arc::new(UserWait::default());
        // Times out normally.
        let r = timeout_excluding_user(Duration::from_millis(100), &wait, tokio::time::sleep(Duration::from_secs(5))).await;
        assert!(r.is_none());
        // 700ms spent on a prompt does not count against a 300ms budget.
        let w = wait.clone();
        let fut = async move {
            {
                let _g = w.begin();
                tokio::time::sleep(Duration::from_millis(700)).await;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            7
        };
        assert_eq!(timeout_excluding_user(Duration::from_millis(300), &wait, fut).await, Some(7));
        // That earlier prompt doesn't extend a later phase's budget.
        let t = Instant::now();
        let r = timeout_excluding_user(Duration::from_millis(100), &wait, tokio::time::sleep(Duration::from_secs(5))).await;
        assert!(r.is_none());
        assert!(t.elapsed() < Duration::from_millis(600), "{:?}", t.elapsed());
    }
}
