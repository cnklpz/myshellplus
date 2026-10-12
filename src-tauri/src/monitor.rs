//! Server status sampling over the shared SSH connection (Linux /proc).

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::Emitter;

use crate::ssh::{exec, get_conn};
use crate::state::Ctx;
use crate::util::now_ms;

const INTERVAL: Duration = Duration::from_secs(3);
const HISTORY: usize = 60;

const SCRIPT: &str = r#"export LC_ALL=C
echo '@@stat'; grep '^cpu' /proc/stat
echo '@@mem'; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
echo '@@load'; cat /proc/loadavg
echo '@@up'; cat /proc/uptime
echo '@@net'; tail -n +3 /proc/net/dev
echo '@@disk'; df -kP 2>/dev/null | tail -n +2
echo '@@dio'; cat /proc/diskstats 2>/dev/null
echo '@@ps'; ps -eo pid,user,pcpu,pmem,rss,comm --sort=-pcpu 2>/dev/null | head -n 16 | tail -n +2
echo '@@tcp'; cat /proc/net/sockstat 2>/dev/null | grep '^TCP'
"#;

const INFO_SCRIPT: &str = r#"export LC_ALL=C
. /etc/os-release 2>/dev/null; echo "os=${PRETTY_NAME:-$(uname -s)}"
echo "kernel=$(uname -r)"; echo "arch=$(uname -m)"; echo "hostname=$(hostname)"
echo "cores=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
echo "cpu=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ *//')"
echo "ip=$(hostname -I 2>/dev/null | awk '{print $1}')"
"#;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SysInfo {
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub hostname: String,
    pub cores: u32,
    pub cpu: String,
    pub ip: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub fs: String,
    pub mount: String,
    pub total: u64,
    pub used: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetIf {
    pub name: String,
    pub rx_rate: f64,
    pub tx_rate: f64,
    pub rx_total: u64,
    pub tx_total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    pub pid: u32,
    pub user: String,
    pub cpu: f32,
    pub mem: f32,
    pub rss: u64,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub ts: i64,
    pub cpu: f32,
    pub cores: Vec<f32>,
    pub mem_total: u64,
    pub mem_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub load: [f32; 3],
    pub uptime: u64,
    pub rx_rate: f64,
    pub tx_rate: f64,
    pub read_rate: f64,
    pub write_rate: f64,
    pub tcp_conns: u32,
    pub nets: Vec<NetIf>,
    pub disks: Vec<DiskUsage>,
    pub procs: Vec<Proc>,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub host_id: String,
    pub info: Option<SysInfo>,
    pub history: Vec<Sample>,
    pub error: Option<String>,
}

#[derive(Default, Clone)]
struct Prev {
    ts: i64,
    cpu: Vec<(u64, u64)>, // (busy, total) for "cpu", "cpu0".. in order
    net: HashMap<String, (u64, u64)>,
    dio: (u64, u64), // sectors read, written
}

struct Entry {
    subscribers: usize,
    info: Option<SysInfo>,
    history: VecDeque<Sample>,
    error: Option<String>,
    stop: Arc<tokio::sync::Notify>,
}

#[derive(Default)]
pub struct Monitors {
    map: Mutex<HashMap<String, Entry>>,
}

impl Monitors {
    pub fn snapshot(&self, host_id: &str) -> MonitorSnapshot {
        let m = self.map.lock();
        match m.get(host_id) {
            Some(e) => MonitorSnapshot {
                host_id: host_id.into(),
                info: e.info.clone(),
                history: e.history.iter().cloned().collect(),
                error: e.error.clone(),
            },
            None => MonitorSnapshot { host_id: host_id.into(), ..Default::default() },
        }
    }

    pub fn latest(&self, host_id: &str) -> Option<Sample> {
        self.map.lock().get(host_id).and_then(|e| e.history.back().cloned())
    }
}

pub fn subscribe(ctx: Arc<Ctx>, host_id: String) {
    let stop = {
        let mut m = ctx.monitors.map.lock();
        if let Some(e) = m.get_mut(&host_id) {
            e.subscribers += 1;
            return;
        }
        let stop = Arc::new(tokio::sync::Notify::new());
        m.insert(
            host_id.clone(),
            Entry { subscribers: 1, info: None, history: VecDeque::new(), error: None, stop: stop.clone() },
        );
        stop
    };
    tokio::spawn(run_loop(ctx, host_id, stop));
}

pub fn unsubscribe(ctx: &Ctx, host_id: &str) {
    let mut m = ctx.monitors.map.lock();
    if let Some(e) = m.get_mut(host_id) {
        e.subscribers = e.subscribers.saturating_sub(1);
        if e.subscribers == 0 {
            e.stop.notify_one();
            m.remove(host_id);
        }
    }
}

async fn run_loop(ctx: Arc<Ctx>, host_id: String, stop: Arc<tokio::sync::Notify>) {
    let mut prev = Prev::default();
    loop {
        let result = sample_once(&ctx, &host_id, &mut prev).await;
        let mut delay = INTERVAL;
        {
            let mut m = ctx.monitors.map.lock();
            let Some(e) = m.get_mut(&host_id) else { return };
            match result {
                Ok((info, sample)) => {
                    if info.is_some() {
                        e.info = info;
                    }
                    if let Some(s) = sample {
                        e.history.push_back(s.clone());
                        while e.history.len() > HISTORY {
                            e.history.pop_front();
                        }
                        let _ = ctx.app.emit("monitor", serde_json::json!({ "hostId": host_id, "sample": s, "info": e.info }));
                    }
                    e.error = None;
                    if e.history.is_empty() {
                        delay = Duration::from_secs(1);
                    }
                }
                Err(err) => {
                    let msg = format!("{err:#}");
                    e.error = Some(msg.clone());
                    let _ = ctx.app.emit("monitor", serde_json::json!({ "hostId": host_id, "error": msg }));
                }
            }
        }
        tokio::select! {
            _ = stop.notified() => return,
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

async fn sample_once(ctx: &Arc<Ctx>, host_id: &str, prev: &mut Prev) -> Result<(Option<SysInfo>, Option<Sample>)> {
    let conn = get_conn(ctx.clone(), host_id.to_string()).await?;
    let need_info = ctx.monitors.map.lock().get(host_id).is_some_and(|e| e.info.is_none());
    let info = if need_info {
        let r = exec::run(&conn, INFO_SCRIPT, Duration::from_secs(10)).await?;
        Some(parse_info(&r.stdout))
    } else {
        None
    };
    let r = exec::run(&conn, SCRIPT, Duration::from_secs(10)).await?;
    if !r.stdout.contains("@@stat") {
        anyhow::bail!("不支持的系统（需要 Linux /proc）");
    }
    Ok((info, parse_sample(&r.stdout, prev)))
}

fn parse_info(s: &str) -> SysInfo {
    let mut i = SysInfo::default();
    for line in s.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim().to_string();
        match k {
            "os" => i.os = v,
            "kernel" => i.kernel = v,
            "arch" => i.arch = v,
            "hostname" => i.hostname = v,
            "cores" => i.cores = v.parse().unwrap_or(0),
            "cpu" => i.cpu = v,
            "ip" => i.ip = v,
            _ => {}
        }
    }
    i
}

fn sections(s: &str) -> HashMap<&str, Vec<&str>> {
    let mut map: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut cur = "";
    for line in s.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            cur = name.trim();
            map.entry(cur).or_default();
        } else if !cur.is_empty() {
            map.entry(cur).or_default().push(line);
        }
    }
    map
}

fn nums(line: &str) -> Vec<u64> {
    line.split_whitespace().filter_map(|x| x.parse().ok()).collect()
}

/// Returns None on the first call (rates need two samples).
fn parse_sample(s: &str, prev: &mut Prev) -> Option<Sample> {
    let sec = sections(s);
    let now = now_ms();
    let dt = if prev.ts > 0 { (now - prev.ts) as f64 / 1000.0 } else { 0.0 };
    let mut out = Sample { ts: now, ..Default::default() };

    // CPU
    let mut cur_cpu = Vec::new();
    for line in sec.get("stat").map(|v| v.as_slice()).unwrap_or_default() {
        let n = nums(line);
        if n.len() < 4 {
            continue;
        }
        let total: u64 = n.iter().sum();
        let idle = n[3] + n.get(4).copied().unwrap_or(0);
        cur_cpu.push((total - idle, total));
    }
    let pct = |i: usize| -> f32 {
        match (prev.cpu.get(i), cur_cpu.get(i)) {
            (Some(&(pb, pt)), Some(&(cb, ct))) if ct > pt => ((cb.saturating_sub(pb)) as f32 / (ct - pt) as f32 * 100.0).clamp(0.0, 100.0),
            _ => 0.0,
        }
    };
    out.cpu = pct(0);
    out.cores = (1..cur_cpu.len()).map(pct).collect();

    // Memory (kB)
    let mut mem: HashMap<&str, u64> = HashMap::new();
    for line in sec.get("mem").map(|v| v.as_slice()).unwrap_or_default() {
        if let Some((k, v)) = line.split_once(':') {
            mem.insert(k.trim(), nums(v).first().copied().unwrap_or(0) * 1024);
        }
    }
    out.mem_total = mem.get("MemTotal").copied().unwrap_or(0);
    out.mem_used = out.mem_total.saturating_sub(mem.get("MemAvailable").copied().unwrap_or(0));
    out.swap_total = mem.get("SwapTotal").copied().unwrap_or(0);
    out.swap_used = out.swap_total.saturating_sub(mem.get("SwapFree").copied().unwrap_or(0));

    if let Some(l) = sec.get("load").and_then(|v| v.first()) {
        let p: Vec<f32> = l.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
        if p.len() == 3 {
            out.load = [p[0], p[1], p[2]];
        }
    }
    if let Some(l) = sec.get("up").and_then(|v| v.first()) {
        out.uptime = l.split_whitespace().next().and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0) as u64;
    }

    // Network
    let mut cur_net = HashMap::new();
    for line in sec.get("net").map(|v| v.as_slice()).unwrap_or_default() {
        let Some((name, rest)) = line.split_once(':') else { continue };
        let name = name.trim().to_string();
        let n = nums(rest);
        if n.len() < 9 || name == "lo" {
            continue;
        }
        let (rx, tx) = (n[0], n[8]);
        let (rr, tr) = match prev.net.get(&name) {
            Some(&(prx, ptx)) if dt > 0.0 => (rx.saturating_sub(prx) as f64 / dt, tx.saturating_sub(ptx) as f64 / dt),
            _ => (0.0, 0.0),
        };
        out.rx_rate += rr;
        out.tx_rate += tr;
        out.nets.push(NetIf { name: name.clone(), rx_rate: rr, tx_rate: tr, rx_total: rx, tx_total: tx });
        cur_net.insert(name, (rx, tx));
    }
    out.nets.sort_by(|a, b| (b.rx_total + b.tx_total).cmp(&(a.rx_total + a.tx_total)));

    // Disks
    for line in sec.get("disk").map(|v| v.as_slice()).unwrap_or_default() {
        let p: Vec<&str> = line.split_whitespace().collect();
        if p.len() < 6 {
            continue;
        }
        let fs = p[0];
        if !(fs.starts_with('/') || fs.contains(':')) || p[5].starts_with("/snap") || p[5].starts_with("/boot/efi") {
            continue;
        }
        let total = p[1].parse::<u64>().unwrap_or(0) * 1024;
        if total == 0 {
            continue;
        }
        out.disks.push(DiskUsage {
            fs: fs.into(),
            mount: p[5..].join(" "),
            total,
            used: p[2].parse::<u64>().unwrap_or(0) * 1024,
        });
    }

    // Disk IO: whole devices only (sd*, vd*, nvme*n*, xvd*), skip partitions
    let mut rd = 0u64;
    let mut wr = 0u64;
    for line in sec.get("dio").map(|v| v.as_slice()).unwrap_or_default() {
        let p: Vec<&str> = line.split_whitespace().collect();
        if p.len() < 10 {
            continue;
        }
        let dev = p[2];
        let whole = (dev.starts_with("sd") || dev.starts_with("vd") || dev.starts_with("xvd") || dev.starts_with("hd"))
            && !dev.ends_with(|c: char| c.is_ascii_digit())
            || (dev.starts_with("nvme") && !dev.contains('p'));
        if whole {
            rd += p[5].parse::<u64>().unwrap_or(0);
            wr += p[9].parse::<u64>().unwrap_or(0);
        }
    }
    if dt > 0.0 && prev.dio != (0, 0) {
        out.read_rate = rd.saturating_sub(prev.dio.0) as f64 * 512.0 / dt;
        out.write_rate = wr.saturating_sub(prev.dio.1) as f64 * 512.0 / dt;
    }

    // Processes
    for line in sec.get("ps").map(|v| v.as_slice()).unwrap_or_default() {
        let p: Vec<&str> = line.split_whitespace().collect();
        if p.len() < 6 {
            continue;
        }
        out.procs.push(Proc {
            pid: p[0].parse().unwrap_or(0),
            user: p[1].into(),
            cpu: p[2].parse().unwrap_or(0.0),
            mem: p[3].parse().unwrap_or(0.0),
            rss: p[4].parse::<u64>().unwrap_or(0) * 1024,
            command: p[5..].join(" "),
        });
    }

    if let Some(l) = sec.get("tcp").and_then(|v| v.first()) {
        // "TCP: inuse 5 orphan 0 tw 0 alloc 7 mem 1"
        let p: Vec<&str> = l.split_whitespace().collect();
        if let Some(i) = p.iter().position(|x| *x == "inuse") {
            out.tcp_conns = p.get(i + 1).and_then(|x| x.parse().ok()).unwrap_or(0);
        }
    }

    let first = prev.ts == 0;
    *prev = Prev { ts: now, cpu: cur_cpu, net: cur_net, dio: (rd, wr) };
    if first { None } else { Some(out) }
}
