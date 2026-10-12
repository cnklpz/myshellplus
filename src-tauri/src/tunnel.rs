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
use tokio::task::JoinHandle;

use crate::db::TunnelDef;
use crate::ssh::{Conn, get_conn};
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
}

#[derive(Default)]
pub struct Tunnels {
    running: Mutex<HashMap<String, Running>>,
    errors: Mutex<HashMap<String, String>>,
}

impl Tunnels {
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
    let def = ctx.db.get_tunnel(id)?;
    stop(&ctx, id).await;
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
    let task = match def.kind.as_str() {
        "local" | "dynamic" => {
            let listener = TcpListener::bind((def.bind_addr.as_str(), def.bind_port))
                .await
                .map_err(|e| anyhow!("本地端口 {}:{} 绑定失败: {e}", def.bind_addr, def.bind_port))?;
            let (c, s, d) = (conn.clone(), stats.clone(), def.clone());
            let id = def.id.clone();
            let ctx2 = ctx.clone();
            Some(tokio::spawn(async move {
                loop {
                    let Ok((sock, peer)) = listener.accept().await else { break };
                    if c.is_closed() {
                        ctx2.tunnels.errors.lock().insert(id.clone(), "SSH 连接已断开".into());
                        let _ = ctx2.app.emit("tunnels-changed", ());
                        break;
                    }
                    let (c, s, d) = (c.clone(), s.clone(), d.clone());
                    tokio::spawn(async move {
                        let _ = if d.kind == "dynamic" {
                            handle_socks(sock, peer, &c, &s).await
                        } else {
                            forward(sock, peer, &c, &s, &d.target_host, d.target_port).await
                        };
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
            conn.forwards.lock().insert(port, (def.target_host.clone(), def.target_port));
            None
        }
        k => bail!("未知隧道类型: {k}"),
    };
    ctx.tunnels.running.lock().insert(def.id.clone(), Running { task, stats, conn, def });
    Ok(())
}

pub async fn stop(ctx: &Ctx, id: &str) {
    let r = ctx.tunnels.running.lock().remove(id);
    if let Some(r) = r {
        if let Some(t) = r.task {
            t.abort();
        }
        if r.def.kind == "remote" {
            r.conn.forwards.lock().remove(&(r.def.bind_port as u32));
            let _ = r.conn.handle.cancel_tcpip_forward(r.def.bind_addr.clone(), r.def.bind_port as u32).await;
        }
    }
    let _ = ctx.app.emit("tunnels-changed", ());
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
        bail!("not socks5");
    }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods).await?;
    sock.write_all(&[5, 0]).await?;

    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await?;
    if req[1] != 1 {
        sock.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        bail!("only CONNECT supported");
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
        _ => bail!("bad address type"),
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
    tokio::spawn(async move {
        let Ok(list) = ctx.db.list_tunnels() else { return };
        for t in list.into_iter().filter(|t| t.auto_start) {
            let _ = start(ctx.clone(), &t.id).await;
        }
    });
}
