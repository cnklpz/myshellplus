//! End-to-end self test against a real SSH server, run inside the real app runtime.
//!
//!   MYSHELL_DATA_DIR=<empty temp dir> MYSHELL_SELFTEST=host:port:user:password myshellplus
//!
//! Prints PASS/FAIL per step and exits with code 0 when everything passed.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use crate::db::{Host, TunnelDef};
use crate::mcp::{McpServer, McpSettings};
use crate::ssh::{exec, get_conn};
use crate::state::Ctx;
use crate::{importer, mcp, monitor, term, transfer, tunnel};

pub async fn run(ctx: Arc<Ctx>, server: Arc<McpServer>, spec: String) -> bool {
    // Auto-accept prompts (host key, agent approvals) like a user clicking "allow".
    let pc = ctx.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            for p in pc.prompts.list() {
                let v = if p.kind == "hostkey" { json!(true) } else { json!({ "approve": true }) };
                pc.prompts.answer(&p.id, v);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });

    let mut ok = true;
    macro_rules! step {
        ($name:expr, $fut:expr) => {{
            let t = std::time::Instant::now();
            match tokio::time::timeout(Duration::from_secs(60), $fut).await {
                Ok(Ok(detail)) => println!("PASS  {:<28} {:>6}ms  {}", $name, t.elapsed().as_millis(), detail),
                Ok(Err(e)) => {
                    ok = false;
                    println!("FAIL  {:<28} {:>6}ms  {:#}", $name, t.elapsed().as_millis(), e)
                }
                Err(_) => {
                    ok = false;
                    println!("FAIL  {:<28} timeout", $name)
                }
            }
        }};
    }

    let parts: Vec<&str> = spec.splitn(4, ':').collect();
    if parts.len() != 4 {
        println!("FAIL  bad MYSHELL_SELFTEST spec, expected host:port:user:password");
        return false;
    }
    let (h, port, user, pass) = (parts[0].to_string(), parts[1].parse::<u16>().unwrap_or(22), parts[2].to_string(), parts[3].to_string());
    let mut host_id = String::new();

    step!("vault setup + unlock", async {
        if !ctx.vault.is_unlocked() {
            bail!("device mode should auto-unlock");
        }
        ctx.vault.enable_password("selftest-password", false)?;
        ctx.vault.lock();
        if ctx.vault.unlock("wrong-password!", false).is_ok() {
            bail!("wrong password accepted");
        }
        ctx.vault.unlock("selftest-password", false)?;
        Ok::<_, anyhow::Error>("ok".to_string())
    });

    step!("save host", async {
        let secret = ctx.vault.put(None, &pass)?;
        let saved = ctx.db.save_host(Host {
            id: String::new(),
            name: "selftest".into(),
            group_name: "test".into(),
            host: h.clone(),
            port,
            username: user.clone(),
            auth_type: "password".into(),
            password_secret: Some(secret),
            key_id: None,
            jump_host_id: None,
            tags: vec![],
            color: String::new(),
            notes: String::new(),
            agent_policy: "auto".into(),
            sort: 0,
            updated_at: 0,
        })?;
        host_id = saved.id.clone();
        Ok::<_, anyhow::Error>(saved.id)
    });

    step!("connect (hostkey prompt)", async {
        get_conn(ctx.clone(), host_id.clone()).await?;
        let known = ctx.db.known_host(&h, port)?.ok_or_else(|| anyhow!("host key not stored"))?;
        Ok::<_, anyhow::Error>(format!("{} {}", known.0, known.1))
    });

    step!("exec", async {
        let c = get_conn(ctx.clone(), host_id.clone()).await?;
        let r = exec::run(&c, "echo hello-$((1+2)); echo err >&2; exit 3", Duration::from_secs(10)).await?;
        if r.stdout.trim() != "hello-3" || r.stderr.trim() != "err" || r.exit_code != Some(3) {
            bail!("unexpected {:?}", r);
        }
        Ok::<_, anyhow::Error>("stdout/stderr/exit ok".to_string())
    });

    step!("terminal session", async {
        let info = term::open(ctx.clone(), host_id.clone(), 100, 30).await?;
        let got = Arc::new(parking_lot::Mutex::new(Vec::<u8>::new()));
        let g2 = got.clone();
        let sink = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Raw(b) = body {
                g2.lock().extend_from_slice(&b);
            }
            Ok(())
        });
        term::attach(&ctx, &info.id, sink)?;
        let s = ctx.terms.get(&info.id)?;
        tokio::time::sleep(Duration::from_millis(800)).await;
        s.write(b"echo term-$((40+2))\r").await?;
        term::resize(&ctx, &info.id, 120, 40).await?;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if s.tail_text(20).contains("term-42") {
                break;
            }
        }
        if !s.tail_text(20).contains("term-42") {
            bail!("no echo in terminal: {}", s.tail_text(5));
        }
        // Re-attach (simulated UI reload) must replay buffered output.
        let replay = Arc::new(parking_lot::Mutex::new(Vec::<u8>::new()));
        let r2 = replay.clone();
        term::attach(&ctx, &info.id, tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Raw(b) = body {
                r2.lock().extend_from_slice(&b);
            }
            Ok(())
        }))?;
        let replayed = String::from_utf8_lossy(&replay.lock()).contains("term-42");
        let streamed = !got.lock().is_empty();
        term::close(&ctx, &info.id).await?;
        if !replayed || !streamed {
            bail!("replayed={replayed} streamed={streamed}");
        }
        Ok::<_, anyhow::Error>("io, resize, reattach replay ok".to_string())
    });

    step!("monitor", async {
        monitor::subscribe(ctx.clone(), host_id.clone());
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if ctx.monitors.latest(&host_id).is_some() {
                break;
            }
        }
        let snap = ctx.monitors.snapshot(&host_id);
        monitor::unsubscribe(&ctx, &host_id);
        if let Some(e) = snap.error {
            bail!(e);
        }
        let s = snap.history.last().ok_or_else(|| anyhow!("no sample"))?;
        let i = snap.info.ok_or_else(|| anyhow!("no info"))?;
        if s.mem_total == 0 || s.disks.is_empty() {
            bail!("bad sample {:?}", s);
        }
        Ok::<_, anyhow::Error>(format!("{} cpu={:.1}% mem={}MB disks={} procs={}", i.os, s.cpu, s.mem_used / 1048576, s.disks.len(), s.procs.len()))
    });

    step!("sftp list/write/read", async {
        let (home, entries) = transfer::list_dir(ctx.clone(), host_id.clone(), String::new()).await?;
        let p = format!("{home}/msp_selftest.txt");
        let content = "你好 MyShell+\nline2\n";
        transfer::write_text(ctx.clone(), host_id.clone(), p.clone(), content.into()).await?;
        let back = transfer::read_text(ctx.clone(), host_id.clone(), p.clone()).await?;
        transfer::rename(ctx.clone(), host_id.clone(), p.clone(), format!("{p}.2")).await?;
        transfer::remove(ctx.clone(), host_id.clone(), vec![format!("{p}.2")]).await?;
        if back != content {
            bail!("roundtrip mismatch");
        }
        Ok::<_, anyhow::Error>(format!("home={home} entries={}", entries.len()))
    });

    step!("transfer upload+download", async {
        let dir = std::env::temp_dir().join("msp_selftest_xfer");
        std::fs::create_dir_all(&dir)?;
        let src = dir.join("up.bin");
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &data)?;
        let (home, _) = transfer::list_dir(ctx.clone(), host_id.clone(), String::new()).await?;
        let remote = format!("{home}/msp_up.bin");
        let wait = |id: String| {
            let ctx = ctx.clone();
            async move {
                for _ in 0..200 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if let Some(t) = ctx.transfers.list().into_iter().find(|t| t.id == id) {
                        if t.state != "running" {
                            return Ok::<_, anyhow::Error>(t);
                        }
                    }
                }
                bail!("transfer timeout")
            }
        };
        let up = wait(transfer::start(ctx.clone(), host_id.clone(), "upload".into(), src.to_string_lossy().into(), remote.clone())).await?;
        if up.state != "done" {
            bail!("upload {:?}", up.error);
        }
        let dst = dir.join("down.bin");
        let down = wait(transfer::start(ctx.clone(), host_id.clone(), "download".into(), dst.to_string_lossy().into(), remote.clone())).await?;
        transfer::remove(ctx.clone(), host_id.clone(), vec![remote]).await?;
        if down.state != "done" || std::fs::read(&dst)? != data {
            bail!("download mismatch {:?}", down.error);
        }
        Ok::<_, anyhow::Error>(format!("3MB roundtrip, {:.1} MB/s up", up.speed / 1048576.0))
    });

    step!("tunnel local -L", async {
        let t = ctx.db.save_tunnel(TunnelDef {
            id: String::new(),
            name: "selftest-L".into(),
            host_id: host_id.clone(),
            kind: "local".into(),
            bind_addr: "127.0.0.1".into(),
            bind_port: 18922,
            target_host: "127.0.0.1".into(),
            target_port: port,
            auto_start: false,
            updated_at: 0,
        })?;
        tunnel::start(ctx.clone(), &t.id).await?;
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", 18922)).await?;
        let mut buf = [0u8; 64];
        let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf)).await??;
        let banner = String::from_utf8_lossy(&buf[..n]).trim().to_string();
        drop(s);
        tunnel::stop(&ctx, &t.id).await;
        if !banner.starts_with("SSH-") {
            bail!("unexpected banner {banner:?}");
        }
        Ok::<_, anyhow::Error>(banner)
    });

    step!("tunnel dynamic SOCKS5", async {
        use tokio::io::AsyncWriteExt;
        let t = ctx.db.save_tunnel(TunnelDef {
            id: String::new(),
            name: "selftest-D".into(),
            host_id: host_id.clone(),
            kind: "dynamic".into(),
            bind_addr: "127.0.0.1".into(),
            bind_port: 18923,
            target_host: String::new(),
            target_port: 0,
            auto_start: false,
            updated_at: 0,
        })?;
        tunnel::start(ctx.clone(), &t.id).await?;
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", 18923)).await?;
        s.write_all(&[5, 1, 0]).await?;
        let mut r = [0u8; 2];
        s.read_exact(&mut r).await?;
        let host = b"localhost";
        let mut req = vec![5, 1, 0, 3, host.len() as u8];
        req.extend_from_slice(host);
        req.extend_from_slice(&port.to_be_bytes());
        s.write_all(&req).await?;
        let mut rep = [0u8; 10];
        s.read_exact(&mut rep).await?;
        let mut buf = [0u8; 64];
        let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf)).await??;
        tunnel::stop(&ctx, &t.id).await;
        let banner = String::from_utf8_lossy(&buf[..n]).trim().to_string();
        if rep[1] != 0 || !banner.starts_with("SSH-") {
            bail!("socks reply {} banner {banner:?}", rep[1]);
        }
        Ok::<_, anyhow::Error>(banner)
    });

    step!("MCP server", async {
        let token = mcp::new_token();
        ctx.db.set_setting("mcp", &McpSettings { enabled: true, port: 17899, token: token.clone() })?;
        mcp::restart(ctx.clone(), server.clone()).await?;
        let cli = reqwest::Client::new();
        let call = |body: Value, tok: String| {
            let cli = cli.clone();
            async move {
                cli.post("http://127.0.0.1:17899/mcp").bearer_auth(tok).json(&body).send().await
            }
        };
        let bad = call(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}), "nope".into()).await?;
        if bad.status() != 401 {
            bail!("bad token not rejected: {}", bad.status());
        }
        let init: Value = call(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}), token.clone()).await?.json().await?;
        let tools: Value = call(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), token.clone()).await?.json().await?;
        let run: Value = call(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_command","arguments":{"host":"selftest","command":"echo via-mcp"}}}), token.clone()).await?.json().await?;
        let text = run["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string();
        if !text.contains("via-mcp") {
            bail!("run_command: {run}");
        }
        // readonly policy must block writes without asking
        let mut hh = ctx.db.get_host(&host_id)?;
        hh.agent_policy = "readonly".into();
        ctx.db.save_host(hh)?;
        let denied: Value = call(json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"run_command","arguments":{"host":"selftest","command":"touch /tmp/x"}}}), token.clone()).await?.json().await?;
        let allowed: Value = call(json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"run_command","arguments":{"host":"selftest","command":"uptime"}}}), token.clone()).await?.json().await?;
        if denied["result"]["isError"] != true || allowed["result"]["isError"] != false {
            bail!("readonly policy wrong: denied={denied} allowed={allowed}");
        }
        let audit = ctx.db.list_audit(10)?;
        Ok::<_, anyhow::Error>(format!(
            "proto={} tools={} audit={}",
            init["result"]["protocolVersion"],
            tools["result"]["tools"].as_array().map(|a| a.len()).unwrap_or(0),
            audit.len()
        ))
    });

    step!("backup export/import", async {
        let p = std::env::temp_dir().join("msp_selftest_backup.json");
        let n = importer::export_backup(&ctx, &p.to_string_lossy(), Some("backup-pass"))?;
        let pv = importer::preview(&ctx, "backup", &p.to_string_lossy(), Some("backup-pass"))?;
        if pv.hosts.len() != n || pv.hosts[0].password.as_deref() != Some(pass.as_str()) || !pv.hosts[0].duplicate {
            bail!("backup preview wrong");
        }
        if importer::preview(&ctx, "backup", &p.to_string_lossy(), Some("wrong")).is_ok() {
            bail!("wrong backup password accepted");
        }
        Ok::<_, anyhow::Error>(format!("{n} hosts, encrypted"))
    });

    ctx.pool.disconnect(&host_id).await;
    ok
}
