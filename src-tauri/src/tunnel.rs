//! Port forwarding: local (-L), remote (-R) and dynamic SOCKS5 (-D).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use anyhow::{Result, anyhow, bail};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tauri::async_runtime::JoinHandle;

use crate::db::TunnelDef;
use crate::ssh::{Conn, RemoteForward, get_conn};
use crate::state::Ctx;

#[derive(Default)]
struct Stats {
    up: AtomicU64,
    down: AtomicU64,
    active: AtomicU32,
}

struct Running {
    task: Option<JoinHandle<()>>,
    stats: Arc<Stats>,
    conn: Arc<Conn>,
    def: TunnelDef,
    /// Remote forwards: the port the server actually bound (bind_port 0 = server picks).
    remote_port: Option<u32>,
    /// Dropped on stop, which ends every forwarded connection of this tunnel.
    _cancel: watch::Sender<()>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub id: String,
    pub running: bool,
    pub up: u64,
    pub down: u64,
    pub active: u32,
    pub error: Option<String>,
    /// Remote forwards: port bound on the server.
    pub remote_port: Option<u32>,
}

#[derive(Default)]
pub struct Tunnels {
    running: Mutex<HashMap<String, Running>>,
    errors: Mutex<HashMap<String, String>>,
    /// Per-tunnel async lock held for a whole start / stop, so two concurrent starts of one
    /// tunnel can't both pass `stop` and leak the first one's listener or remote forward.
    /// Taken before (never while holding) `running` / `errors`.
    ops: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Tunnels {
    fn op_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.ops.lock().entry(id.to_string()).or_default().clone()
    }

    pub fn status(&self) -> Vec<TunnelStatus> {
        let r = self.running.lock();
        let e = self.errors.lock();
        let mut ids: Vec<String> = r.keys().chain(e.keys()).cloned().collect();
        ids.sort();
        ids.dedup();
        ids.into_iter()
            .map(|id| {
                let run = r.get(&id).filter(|x| !x.conn.is_closed());
                TunnelStatus {
                    running: run.is_some(),
                    up: run.map(|x| x.stats.up.load(Ordering::Relaxed)).unwrap_or(0),
                    down: run.map(|x| x.stats.down.load(Ordering::Relaxed)).unwrap_or(0),
                    active: run.map(|x| x.stats.active.load(Ordering::Relaxed)).unwrap_or(0),
                    error: e.get(&id).cloned(),
                    remote_port: run.and_then(|x| x.remote_port),
                    id,
                }
            })
            .collect()
    }
}

async fn pipe<A, B>(a: &mut A, b: &mut B, stats: &Stats) -> std::io::Result<()>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    stats.active.fetch_add(1, Ordering::Relaxed);
    let r = tokio::io::copy_bidirectional(a, b).await;
    stats.active.fetch_sub(1, Ordering::Relaxed);
    if let Ok((up, down)) = r {
        stats.up.fetch_add(up, Ordering::Relaxed);
        stats.down.fetch_add(down, Ordering::Relaxed);
    }
    r.map(|_| ())
}

pub async fn start(ctx: Arc<Ctx>, id: &str) -> Result<()> {
    let lock = ctx.tunnels.op_lock(id);
    let _op = lock.lock().await;
    let def = ctx.db.get_tunnel(id)?;
    stop_locked(&ctx, id).await;
    ctx.tunnels.errors.lock().remove(id);
    let res = start_inner(ctx.clone(), def).await;
    if let Err(e) = &res {
        ctx.tunnels.errors.lock().insert(id.into(), format!("{e:#}"));
    }
    let _ = ctx.app.emit("tunnels-changed", ());
    res
}

async fn start_inner(ctx: Arc<Ctx>, def: TunnelDef) -> Result<()> {
    let conn = get_conn(ctx.clone(), def.host_id.clone()).await?;
    let stats = Arc::new(Stats::default());
    let (cancel, cancelled) = watch::channel(());
    let mut remote_port = None;
    let task = match def.kind.as_str() {
        "local" | "dynamic" => {
            let listener = TcpListener::bind((def.bind_addr.as_str(), def.bind_port))
                .await
                .map_err(|e| anyhow!("本地端口 {}:{} 绑定失败: {e}", def.bind_addr, def.bind_port))?;
            let (c, s, d) = (conn.clone(), stats.clone(), def.clone());
            let id = def.id.clone();
            let ctx2 = ctx.clone();
            let mut stopped = cancelled.clone();
            Some(tauri::async_runtime::spawn(async move {
                loop {
                    let (sock, peer) = tokio::select! {
                        r = listener.accept() => match r {
                            Ok(x) => x,
                            Err(_) => break,
                        },
                        _ = stopped.changed() => break,
                    };
                    if c.is_closed() {
                        ctx2.tunnels.errors.lock().insert(id.clone(), "SSH 连接已断开".into());
                        let _ = ctx2.app.emit("tunnels-changed", ());
                        break;
                    }
                    let (c, s, d) = (c.clone(), s.clone(), d.clone());
                    let mut stopped = cancelled.clone();
                    tauri::async_runtime::spawn(async move {
                        let work = async {
                            let _ = if d.kind == "dynamic" {
                                handle_socks(sock, peer, &c, &s).await
                            } else {
                                forward(sock, peer, &c, &s, &d.target_host, d.target_port).await
                            };
                        };
                        tokio::select! {
                            _ = work => {}
                            _ = stopped.changed() => {}
                        }
                    });
                }
            }))
        }
        "remote" => {
            let port = conn
                .handle
                .tcpip_forward(def.bind_addr.clone(), def.bind_port as u32)
                .await
                .map_err(|e| anyhow!("服务器拒绝远程转发: {e}"))?;
            let port = if port == 0 { def.bind_port as u32 } else { port };
            conn.forwards.lock().insert(
                port,
                RemoteForward { host: def.target_host.clone(), port: def.target_port, cancel: cancelled },
            );
            remote_port = Some(port);
            None
        }
        k => bail!("未知隧道类型: {k}"),
    };
    ctx.tunnels.running.lock().insert(def.id.clone(), Running { task, stats, conn, def, remote_port, _cancel: cancel });
    Ok(())
}

pub async fn stop(ctx: &Ctx, id: &str) {
    let lock = ctx.tunnels.op_lock(id);
    let _op = lock.lock().await;
    stop_locked(ctx, id).await;
}

/// How long to wait for the server to acknowledge cancelling a remote forward. A half-open
/// connection never answers, and stopping (or deleting the host) must not hang on it.
const CANCEL_FORWARD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// `stop` with the tunnel's op lock already held.
async fn stop_locked(ctx: &Ctx, id: &str) {
    let r = ctx.tunnels.running.lock().remove(id);
    if let Some(Running { task, conn, def, remote_port, _cancel: cancel, .. }) = r {
        // End the tunnel's open connections before anything below can wait on the network.
        drop(cancel);
        if let Some(t) = task {
            t.abort();
            // Wait until the task is gone so its listener is closed: a restart binds the same port.
            let _ = t.await;
        }
        if let Some(port) = remote_port {
            conn.forwards.lock().remove(&port);
            if !conn.is_closed() {
                let cancel = conn.handle.cancel_tcpip_forward(def.bind_addr.clone(), port);
                match tokio::time::timeout(CANCEL_FORWARD_TIMEOUT, cancel).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => log::warn!("取消远程转发 {}:{port} 失败: {e}", def.bind_addr),
                    Err(_) => log::warn!("取消远程转发 {}:{port} 超时", def.bind_addr),
                }
            }
        }
    }
    let _ = ctx.app.emit("tunnels-changed", ());
}

/// Stop every running tunnel of a host (host deleted).
pub async fn stop_host(ctx: &Ctx, host_id: &str) {
    let ids: Vec<String> =
        ctx.tunnels.running.lock().iter().filter(|(_, r)| r.def.host_id == host_id).map(|(id, _)| id.clone()).collect();
    for id in ids {
        stop(ctx, &id).await;
    }
    let defs = ctx.db.list_tunnels().unwrap_or_default();
    let mut errors = ctx.tunnels.errors.lock();
    errors.retain(|id, _| !defs.iter().any(|d| &d.id == id && d.host_id == host_id));
}

async fn forward(mut sock: TcpStream, peer: SocketAddr, c: &Conn, s: &Stats, host: &str, port: u16) -> Result<()> {
    let ch = c
        .handle
        .channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32)
        .await?;
    let mut stream = ch.into_stream();
    pipe(&mut sock, &mut stream, s).await?;
    Ok(())
}

/// Minimal SOCKS5 (no auth, CONNECT only).
async fn handle_socks(mut sock: TcpStream, peer: SocketAddr, c: &Conn, s: &Stats) -> Result<()> {
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await?;
    if head[0] != 5 {
        bail!("不是 SOCKS5 请求");
    }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods).await?;
    sock.write_all(&[5, 0]).await?;

    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await?;
    if req[1] != 1 {
        sock.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        bail!("仅支持 CONNECT 请求");
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut l = [0u8; 1];
            sock.read_exact(&mut l).await?;
            let mut d = vec![0u8; l[0] as usize];
            sock.read_exact(&mut d).await?;
            String::from_utf8_lossy(&d).into_owned()
        }
        4 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => bail!("不支持的地址类型"),
    };
    let mut p = [0u8; 2];
    sock.read_exact(&mut p).await?;
    let port = u16::from_be_bytes(p);

    match c
        .handle
        .channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32)
        .await
    {
        Ok(ch) => {
            sock.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            let mut stream = ch.into_stream();
            pipe(&mut sock, &mut stream, s).await?;
        }
        Err(_) => {
            sock.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        }
    }
    Ok(())
}

/// Start tunnels flagged auto_start (called once the vault is unlocked).
pub fn auto_start(ctx: Arc<Ctx>) {
    tauri::async_runtime::spawn(async move {
        let Ok(list) = ctx.db.list_tunnels() else { return };
        for t in list.into_iter().filter(|t| t.auto_start) {
            let _ = start(ctx.clone(), &t.id).await;
        }
    });
}
