mod ai;
mod applog;
mod batch;
mod db;
mod error;
mod guard;
mod hotkey;
mod importer;
mod mcp;
mod monitor;
mod onepass;
mod predict;
mod prompts;
mod selftest;
mod ssh;
mod state;
mod term;
mod transfer;
mod tunnel;
mod util;
mod vault;
mod watchdog;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use rand::RngCore;
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::ssh_key::{LineEnding, PrivateKey};
use russh::keys::decode_secret_key;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::ipc::{Channel, Response};
use tauri::{Manager, State};

use crate::db::{AuditEntry, Db, Host, KeyEntry, KnownHost, Snippet, TunnelDef};
use crate::error::CmdResult;
use crate::mcp::{McpServer, McpSettings};
use crate::state::{Ctx, CtxRef};
use crate::util::{log_err, new_id};

type S<'a> = State<'a, CtxRef>;

// ---------------- vault ----------------

#[tauri::command]
fn vault_status(ctx: S) -> CmdResult<vault::VaultStatus> {
    Ok(ctx.vault.status()?)
}

fn after_unlock(ctx: &CtxRef) {
    tunnel::auto_start(ctx.clone());
}

#[tauri::command]
async fn vault_setup(ctx: S<'_>, password: String, remember: bool) -> CmdResult<()> {
    let c = ctx.inner().clone();
    tokio::task::spawn_blocking(move || c.vault.enable_password(&password, remember)).await??;
    Ok(())
}

#[tauri::command]
async fn vault_disable_password(ctx: S<'_>, password: String) -> CmdResult<()> {
    let c = ctx.inner().clone();
    tokio::task::spawn_blocking(move || c.vault.disable_password(&password)).await??;
    Ok(())
}

#[tauri::command]
async fn vault_unlock(ctx: S<'_>, password: String, remember: bool) -> CmdResult<()> {
    let c = ctx.inner().clone();
    tokio::task::spawn_blocking(move || c.vault.unlock(&password, remember)).await??;
    after_unlock(ctx.inner());
    Ok(())
}

#[tauri::command]
fn vault_lock(ctx: S) {
    ctx.vault.lock();
}

#[tauri::command]
fn vault_remember(ctx: S, on: bool) -> CmdResult<()> {
    Ok(ctx.vault.remember(on)?)
}

#[tauri::command]
async fn vault_change_password(ctx: S<'_>, old: String, new: String) -> CmdResult<()> {
    let c = ctx.inner().clone();
    tokio::task::spawn_blocking(move || c.vault.change_password(&old, &new)).await??;
    Ok(())
}

// ---------------- hosts & keys ----------------

#[tauri::command]
fn host_list(ctx: S) -> CmdResult<Vec<Host>> {
    Ok(ctx.db.list_hosts()?)
}

/// Some(non-empty) sets a new secret, Some("") clears it, None keeps it.
fn apply_secret(ctx: &Ctx, slot: &mut Option<String>, value: Option<String>) -> anyhow::Result<()> {
    match value {
        Some(p) if !p.is_empty() => *slot = Some(ctx.vault.put(slot.as_deref(), &p)?),
        Some(_) => {
            if let Some(id) = slot.take() {
                ctx.vault.delete(&id)?;
            }
        }
        None => {}
    }
    Ok(())
}

/// `password` / `proxy_password`: Some(non-empty) sets a new one, Some("") clears it, None keeps it.
#[tauri::command]
fn host_save(ctx: S, mut host: Host, password: Option<String>, proxy_password: Option<String>) -> CmdResult<Host> {
    if host.name.trim().is_empty() {
        host.name = host.host.clone();
    }
    if host.host.trim().is_empty() || host.username.trim().is_empty() {
        bail_msg!("地址和用户名不能为空");
    }
    host.proxy_host = host.proxy_host.trim().to_string();
    host.proxy_user = host.proxy_user.trim().to_string();
    if host.proxy_enabled && (host.proxy_host.is_empty() || host.proxy_port == 0) {
        bail_msg!("代理地址或端口无效");
    }
    ssh::validate_jump_chain(&ctx.db, &host)?;
    if !host.id.is_empty()
        && let Ok(old) = ctx.db.get_host(&host.id)
    {
        host.password_secret = old.password_secret;
        host.proxy_secret = old.proxy_secret;
    }
    apply_secret(&ctx, &mut host.password_secret, password)?;
    apply_secret(&ctx, &mut host.proxy_secret, proxy_password)?;
    Ok(ctx.db.save_host(host)?)
}

#[tauri::command]
async fn host_delete(ctx: S<'_>, id: String) -> CmdResult<()> {
    tunnel::stop_host(ctx.inner(), &id).await;
    monitor::stop_host(ctx.inner(), &id);
    ctx.pool.disconnect(&id).await;
    if let Ok(h) = ctx.db.get_host(&id) {
        for s in [h.password_secret, h.proxy_secret].into_iter().flatten() {
            log_err("删除主机密码失败", ctx.vault.delete(&s));
        }
    }
    Ok(ctx.db.delete_host(&id)?)
}

#[tauri::command]
fn key_list(ctx: S) -> CmdResult<Vec<KeyEntry>> {
    Ok(ctx.db.list_keys()?)
}

// async + spawn_blocking: bcrypt-pbkdf of an encrypted key takes long enough to freeze the UI.
#[tauri::command]
async fn key_import(ctx: S<'_>, name: String, private_key: String, passphrase: Option<String>) -> CmdResult<KeyEntry> {
    let ctx = ctx.inner().clone();
    let k = tokio::task::spawn_blocking(move || -> anyhow::Result<KeyEntry> {
        let pass = passphrase.filter(|p| !p.is_empty());
        let key = decode_secret_key(&private_key, pass.as_deref()).map_err(|e| anyhow::anyhow!("私钥无法解析: {e}"))?;
        let public_key = key.public_key().to_openssh().unwrap_or_default();
        let k = KeyEntry {
            id: new_id(),
            name,
            public_key,
            private_secret: ctx.vault.put(None, &private_key)?,
            passphrase_secret: match pass {
                Some(p) => Some(ctx.vault.put(None, &p)?),
                None => None,
            },
            updated_at: 0,
        };
        ctx.db.save_key(&k)?;
        Ok(k)
    })
    .await??;
    Ok(k)
}

#[tauri::command]
fn key_generate(ctx: S, name: String) -> CmdResult<KeyEntry> {
    let mut seed = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut seed);
    let mut key = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
    key.set_comment(format!("{name}@myshellplus"));
    let pem = key.to_openssh(LineEnding::LF)?;
    let k = KeyEntry {
        id: new_id(),
        name,
        public_key: key.public_key().to_openssh()?,
        private_secret: ctx.vault.put(None, &pem)?,
        passphrase_secret: None,
        updated_at: 0,
    };
    ctx.db.save_key(&k)?;
    Ok(k)
}

#[tauri::command]
fn key_delete(ctx: S, id: String) -> CmdResult<()> {
    let used = ctx.db.hosts_using_key(&id)?;
    if used > 0 {
        bail_msg!("还有 {used} 台主机在使用此密钥，请先修改这些主机的认证方式");
    }
    if let Ok(k) = ctx.db.get_key(&id) {
        log_err("删除私钥失败", ctx.vault.delete(&k.private_secret));
        if let Some(p) = k.passphrase_secret {
            log_err("删除私钥口令失败", ctx.vault.delete(&p));
        }
    }
    Ok(ctx.db.delete_key(&id)?)
}

// ---------------- SSH agent / 1Password ----------------

#[tauri::command]
async fn agent_keys() -> CmdResult<Vec<onepass::AgentKey>> {
    Ok(onepass::agent_keys().await?)
}

#[tauri::command]
async fn op_status() -> CmdResult<onepass::OpStatus> {
    Ok(onepass::status().await)
}

#[tauri::command]
async fn op_items(account: Option<String>) -> CmdResult<Vec<onepass::OpItem>> {
    Ok(onepass::items(account).await?)
}

#[tauri::command]
async fn op_item(reference: String, account: Option<String>) -> CmdResult<onepass::OpHost> {
    Ok(onepass::item(reference, account).await?)
}

#[tauri::command]
async fn op_vaults(account: Option<String>) -> CmdResult<Vec<onepass::OpVault>> {
    Ok(onepass::vaults(account).await?)
}

#[tauri::command]
async fn op_create_ssh_key(
    title: String,
    url: String,
    username: String,
    vault: Option<String>,
    account: Option<String>,
) -> CmdResult<onepass::OpNewKey> {
    Ok(onepass::create_ssh_key(title, url, username, vault, account).await?)
}

#[tauri::command]
async fn op_create_login(
    title: String,
    url: String,
    username: String,
    password: String,
    vault: Option<String>,
    account: Option<String>,
) -> CmdResult<String> {
    Ok(onepass::create_login(title, url, username, password, vault, account).await?)
}

// ---------------- connections & terminals ----------------

#[tauri::command]
async fn conn_connect(ctx: S<'_>, host_id: String) -> CmdResult<()> {
    ssh::get_conn(ctx.inner().clone(), host_id).await?;
    Ok(())
}

#[tauri::command]
async fn conn_disconnect(ctx: S<'_>, host_id: String) -> CmdResult<()> {
    for t in ctx.terms.list().into_iter().filter(|t| t.host_id == host_id) {
        term::close(ctx.inner(), &t.id).await?;
    }
    monitor::stop_host(ctx.inner(), &host_id);
    ctx.pool.disconnect(&host_id).await;
    Ok(())
}

#[tauri::command]
fn conn_list(ctx: S) -> Vec<String> {
    ctx.pool.connected_ids()
}

/// host id -> last connect failure (cleared on the next successful connect).
#[tauri::command]
fn conn_failures(ctx: S) -> HashMap<String, ssh::Failure> {
    ssh::failures(ctx.inner())
}

#[tauri::command]
fn conn_failure_dismiss(ctx: S, host_id: String) {
    ssh::set_failure(ctx.inner(), &host_id, None);
}

/// host id -> remote OS name, learned on connect.
#[tauri::command]
fn host_os_map(ctx: S) -> HashMap<String, String> {
    ctx.db.setting_or_default("host_os")
}

#[tauri::command]
fn conn_latency(ctx: S) -> Vec<ssh::Latency> {
    ctx.pool.latencies()
}

#[tauri::command]
async fn host_probe(ctx: S<'_>, host_ids: Vec<String>) -> CmdResult<Vec<ssh::Probe>> {
    let tasks: Vec<_> = host_ids
        .into_iter()
        .map(|id| tauri::async_runtime::spawn(ssh::probe(ctx.inner().clone(), id)))
        .collect();
    let mut out = Vec::with_capacity(tasks.len());
    for t in tasks {
        if let Ok(p) = t.await {
            out.push(p);
        }
    }
    Ok(out)
}

#[tauri::command]
async fn term_open(ctx: S<'_>, host_id: String, cols: u32, rows: u32) -> CmdResult<term::TermInfo> {
    Ok(term::open(ctx.inner().clone(), host_id, cols, rows).await?)
}

#[tauri::command]
fn term_attach(ctx: S, id: String, sink: Channel<Response>) -> CmdResult<term::TermInfo> {
    Ok(term::attach(ctx.inner(), &id, sink)?)
}

#[tauri::command]
async fn term_write(ctx: S<'_>, id: String, data: String) -> CmdResult<()> {
    ctx.terms.get(&id)?.write(data.as_bytes()).await?;
    // Lets the files panel re-check the shell's directory after a command runs.
    if data.contains('\r') {
        use tauri::Emitter;
        let _ = ctx.app.emit("term-enter", &id);
    }
    Ok(())
}

#[tauri::command]
async fn term_cwd(ctx: S<'_>, id: String) -> CmdResult<Option<String>> {
    Ok(term::cwd(ctx.inner().clone(), &id).await?)
}

#[tauri::command]
async fn term_resize(ctx: S<'_>, id: String, cols: u32, rows: u32) -> CmdResult<()> {
    Ok(term::resize(ctx.inner(), &id, cols, rows).await?)
}

#[tauri::command]
async fn term_close(ctx: S<'_>, id: String) -> CmdResult<()> {
    Ok(term::close(ctx.inner(), &id).await?)
}

#[tauri::command]
fn term_list(ctx: S) -> Vec<term::TermInfo> {
    ctx.terms.list()
}

#[tauri::command]
fn history_record(ctx: S, host_id: String, command: String) -> CmdResult<()> {
    Ok(ctx.db.record_history(&host_id, &command)?)
}

#[tauri::command]
fn history_list(ctx: S, host_id: String, query: String, limit: Option<usize>) -> CmdResult<Vec<db::HistoryHit>> {
    Ok(ctx.db.list_history(&host_id, &query, limit.unwrap_or(500).min(5000))?)
}

#[tauri::command]
fn history_delete(ctx: S, host_id: String, command: String) -> CmdResult<()> {
    Ok(ctx.db.delete_history(&host_id, &command)?)
}

#[tauri::command]
async fn exec_run(
    ctx: S<'_>,
    host_id: String,
    command: String,
    timeout_secs: Option<u64>,
    quiet: Option<bool>,
    stdin: Option<String>,
) -> CmdResult<ssh::exec::ExecResult> {
    let c = ssh::get_conn(ctx.inner().clone(), host_id.clone()).await?;
    // Monitor cards poll their command; only the first run of a card is audited.
    if !quiet.unwrap_or(false) {
        log_err("写入审计日志失败", ctx.db.audit("user", Some(&host_id), "exec", &command, "run"));
    }
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(60));
    Ok(ssh::exec::run_input(&c, &command, stdin.as_deref().map(str::as_bytes), timeout).await?)
}

// ---------------- monitor ----------------

#[tauri::command]
fn monitor_subscribe(ctx: S, host_id: String) -> monitor::MonitorSnapshot {
    monitor::subscribe(ctx.inner().clone(), host_id.clone(), true);
    ctx.monitors.snapshot(&host_id)
}

#[tauri::command]
fn monitor_unsubscribe(ctx: S, host_id: String) {
    monitor::unsubscribe(ctx.inner(), &host_id, true);
}

// ---------------- sftp ----------------

#[derive(Serialize)]
struct DirListing {
    path: String,
    entries: Vec<transfer::FileEntry>,
}

#[tauri::command]
async fn sftp_list(ctx: S<'_>, host_id: String, path: String) -> CmdResult<DirListing> {
    let (path, entries) = transfer::list_dir(ctx.inner().clone(), host_id, path).await?;
    Ok(DirListing { path, entries })
}

#[tauri::command]
async fn sftp_read(ctx: S<'_>, host_id: String, path: String) -> CmdResult<String> {
    Ok(transfer::read_text(ctx.inner().clone(), host_id, path).await?)
}

#[tauri::command]
async fn sftp_write(ctx: S<'_>, host_id: String, path: String, content: String) -> CmdResult<()> {
    Ok(transfer::write_text(ctx.inner().clone(), host_id, path, content).await?)
}

#[tauri::command]
async fn sftp_mkdir(ctx: S<'_>, host_id: String, path: String) -> CmdResult<()> {
    Ok(transfer::mkdir(ctx.inner().clone(), host_id, path).await?)
}

#[tauri::command]
async fn sftp_rename(ctx: S<'_>, host_id: String, from: String, to: String) -> CmdResult<()> {
    Ok(transfer::rename(ctx.inner().clone(), host_id, from, to).await?)
}

#[tauri::command]
async fn sftp_remove(ctx: S<'_>, host_id: String, paths: Vec<String>) -> CmdResult<()> {
    log_err("写入审计日志失败", ctx.db.audit("user", Some(&host_id), "sftp_remove", &paths.join(", "), "run"));
    Ok(transfer::remove(ctx.inner().clone(), host_id, paths).await?)
}

#[tauri::command]
async fn sftp_chmod(ctx: S<'_>, host_id: String, path: String, mode: u32) -> CmdResult<()> {
    Ok(transfer::chmod(ctx.inner().clone(), host_id, path, mode).await?)
}

#[tauri::command]
fn transfer_start(ctx: S, host_id: String, direction: String, local: String, remote: String) -> String {
    transfer::start(ctx.inner().clone(), host_id, direction, local, remote)
}

#[tauri::command]
fn transfer_list(ctx: S) -> Vec<transfer::TransferInfo> {
    ctx.transfers.list()
}

#[tauri::command]
fn transfer_cancel(ctx: S, id: String) {
    ctx.transfers.cancel(&id);
}

#[tauri::command]
fn transfer_clear(ctx: S) {
    ctx.transfers.clear_finished();
}

// ---------------- tunnels ----------------

#[tauri::command]
fn tunnel_list(ctx: S) -> CmdResult<Vec<TunnelDef>> {
    Ok(ctx.db.list_tunnels()?)
}

#[tauri::command]
fn tunnel_save(ctx: S, tunnel: TunnelDef) -> CmdResult<TunnelDef> {
    if !["local", "remote", "dynamic"].contains(&tunnel.kind.as_str()) {
        bail_msg!("隧道类型无效");
    }
    if tunnel.kind != "dynamic" && (tunnel.target_host.is_empty() || tunnel.target_port == 0) {
        bail_msg!("请填写目标地址和端口");
    }
    Ok(ctx.db.save_tunnel(tunnel)?)
}

#[tauri::command]
async fn tunnel_delete(ctx: S<'_>, id: String) -> CmdResult<()> {
    tunnel::stop(ctx.inner(), &id).await;
    Ok(ctx.db.delete_tunnel(&id)?)
}

#[tauri::command]
async fn tunnel_start(ctx: S<'_>, id: String) -> CmdResult<()> {
    Ok(tunnel::start(ctx.inner().clone(), &id).await?)
}

#[tauri::command]
async fn tunnel_stop(ctx: S<'_>, id: String) -> CmdResult<()> {
    tunnel::stop(ctx.inner(), &id).await;
    Ok(())
}

#[tauri::command]
fn tunnel_status(ctx: S) -> Vec<tunnel::TunnelStatus> {
    ctx.tunnels.status()
}

// ---------------- snippets / batch ----------------

#[tauri::command]
fn snippet_list(ctx: S) -> CmdResult<Vec<Snippet>> {
    Ok(ctx.db.list_snippets()?)
}

#[tauri::command]
fn snippet_save(ctx: S, snippet: Snippet) -> CmdResult<Snippet> {
    Ok(ctx.db.save_snippet(snippet)?)
}

#[tauri::command]
fn snippet_delete(ctx: S, id: String) -> CmdResult<()> {
    Ok(ctx.db.delete_snippet(&id)?)
}

#[tauri::command]
fn batch_start(ctx: S, host_ids: Vec<String>, command: String, timeout_secs: u64) -> String {
    batch::start(ctx.inner().clone(), host_ids, command, timeout_secs)
}

// ---------------- prediction & AI ----------------

#[tauri::command]
fn predict_local(ctx: S, host_id: String, input: String) -> CmdResult<Vec<predict::Suggestion>> {
    Ok(predict::local(ctx.inner(), &host_id, &input, 8)?)
}

#[tauri::command]
async fn predict_ai(ctx: S<'_>, host_id: String, input: String, screen: String) -> CmdResult<Vec<predict::Suggestion>> {
    Ok(predict::ai_predict(ctx.inner().clone(), host_id, input, screen).await?)
}

#[tauri::command]
async fn ai_nl2cmd(ctx: S<'_>, host_id: String, prompt: String) -> CmdResult<predict::NlCommand> {
    Ok(predict::nl_to_command(ctx.inner().clone(), host_id, prompt).await?)
}

#[tauri::command]
async fn ai_explain(ctx: S<'_>, host_id: String, text: String) -> CmdResult<String> {
    Ok(predict::explain(ctx.inner().clone(), host_id, text).await?)
}

#[tauri::command]
async fn ai_chat(ctx: S<'_>, host_id: String, messages: Vec<predict::ChatMsg>, screen: Option<String>) -> CmdResult<String> {
    Ok(predict::chat(ctx.inner().clone(), host_id, messages, screen).await?)
}

#[tauri::command]
fn ai_settings_get(ctx: S) -> ai::AiSettings {
    ai::settings(&ctx.db)
}

/// `keys`: provider id -> new API key (empty string clears it).
#[tauri::command]
fn ai_settings_save(ctx: S, mut settings: ai::AiSettings, keys: HashMap<String, String>) -> CmdResult<()> {
    let old = ai::settings(&ctx.db);
    // Drop stored keys of providers that were removed.
    for o in &old.providers {
        if !settings.providers.iter().any(|p| p.id == o.id)
            && let Some(id) = &o.api_key_secret
        {
            log_err("删除 API Key 失败", ctx.vault.delete(id));
        }
    }
    for p in settings.providers.iter_mut() {
        p.api_key_secret = old.providers.iter().find(|o| o.id == p.id).and_then(|o| o.api_key_secret.clone());
        if let Some(k) = keys.get(&p.id) {
            if k.is_empty() {
                if let Some(id) = p.api_key_secret.take() {
                    log_err("删除 API Key 失败", ctx.vault.delete(&id));
                }
            } else {
                p.api_key_secret = Some(ctx.vault.put(p.api_key_secret.as_deref(), k)?);
            }
        }
    }
    Ok(ctx.db.set_setting("ai", &settings)?)
}

// ---------------- MCP / agent ----------------

#[tauri::command]
fn mcp_settings_get(ctx: S, server: State<'_, Arc<McpServer>>) -> CmdResult<Value> {
    // A corrupt row must not lock the user out of the form: show defaults (not persisted, so the
    // old token isn't silently replaced) plus the error; saving overwrites the bad row.
    let (settings, error) = match mcp::settings(ctx.inner()) {
        Ok(s) => (s, None),
        Err(e) => (mcp::defaults(), Some(format!("MCP 设置无法读取，已显示默认值，保存后覆盖: {e:#}"))),
    };
    Ok(json!({ "settings": settings, "runningPort": *server.running_port.lock(), "error": error }))
}

#[tauri::command]
async fn mcp_settings_save(ctx: S<'_>, server: State<'_, Arc<McpServer>>, settings: McpSettings) -> CmdResult<()> {
    ctx.db.set_setting("mcp", &settings)?;
    mcp::restart(ctx.inner().clone(), server.inner().clone()).await?;
    Ok(())
}

#[tauri::command]
fn mcp_new_token() -> String {
    mcp::new_token()
}

#[tauri::command]
fn prompt_list(ctx: S) -> Vec<prompts::PromptEvent> {
    ctx.prompts.list()
}

#[tauri::command]
fn prompt_answer(ctx: S, id: String, value: Value) {
    ctx.prompts.answer(&id, value);
}

#[tauri::command]
fn known_host_list(ctx: S) -> CmdResult<Vec<KnownHost>> {
    Ok(ctx.db.list_known_hosts()?)
}

#[tauri::command]
fn known_host_delete(ctx: S, host: String, port: u16) -> CmdResult<()> {
    Ok(ctx.db.forget_host(&host, port)?)
}

#[tauri::command]
fn audit_list(ctx: S, limit: Option<usize>) -> CmdResult<Vec<AuditEntry>> {
    Ok(ctx.db.list_audit(limit.unwrap_or(500))?)
}

// ---------------- UI support ----------------

#[tauri::command]
fn ui_heartbeat() {
    watchdog::beat();
}

const LOCAL_FILE_MAX: u64 = 2 * 1024 * 1024;

/// Read a small local text file chosen by the user (key files, configs).
#[tauri::command]
fn local_read_text(path: String) -> CmdResult<String> {
    let md = std::fs::metadata(&path)?;
    if md.len() > LOCAL_FILE_MAX {
        bail_msg!("文件过大");
    }
    Ok(std::fs::read_to_string(&path)?)
}

/// Write a small local text file to a path chosen by the user via a save dialog.
#[tauri::command]
fn local_write_text(path: String, content: String) -> CmdResult<()> {
    if content.len() as u64 > LOCAL_FILE_MAX {
        bail_msg!("内容过大");
    }
    Ok(std::fs::write(&path, content)?)
}

// ---------------- logs ----------------

/// UI-side events (render errors, uncaught exceptions, long frames) for the app log.
#[tauri::command]
fn log_write(level: String, target: String, msg: String) {
    let target = match target.as_str() {
        "crash" | "perf" => target.as_str(),
        _ => "ui",
    };
    let msg: String = msg.chars().take(4000).collect();
    match level.as_str() {
        "error" => log::error!(target: target, "{msg}"),
        "warn" => log::warn!(target: target, "{msg}"),
        _ => log::info!(target: target, "{msg}"),
    }
}

/// Recent warnings and errors (crashes, freezes, long frames, connection failures), newest first.
#[tauri::command]
async fn log_events(limit: Option<usize>) -> CmdResult<Vec<applog::Entry>> {
    Ok(tokio::task::spawn_blocking(move || applog::events(limit.unwrap_or(200))).await?)
}

#[tauri::command]
fn log_dir() -> Option<String> {
    applog::dir().map(|d| d.to_string_lossy().into_owned())
}

/// Whole app log, redacted, to a path picked with the save dialog.
#[tauri::command]
async fn log_export(ctx: S<'_>, path: String) -> CmdResult<()> {
    let c = ctx.inner().clone();
    Ok(tokio::task::spawn_blocking(move || applog::write_file(&path, &applog::export_all(&c.db))).await??)
}

/// The host's last connect attempt; `redact` hides addresses and names.
#[tauri::command]
async fn conn_log_export(ctx: S<'_>, host_id: String, path: String, redact: bool) -> CmdResult<()> {
    let c = ctx.inner().clone();
    Ok(tokio::task::spawn_blocking(move || applog::write_file(&path, &applog::export_conn(&c.db, &host_id, redact))).await??)
}

#[tauri::command]
async fn conn_diagnose(ctx: S<'_>, host_id: String) -> CmdResult<String> {
    Ok(predict::diagnose_conn(ctx.inner().clone(), host_id).await?)
}

// ---------------- global hotkeys ----------------

#[tauri::command]
fn hotkey_get(ctx: S) -> Value {
    json!({ "settings": hotkey::settings(&ctx.db), "status": hotkey::status() })
}

// async: registering runs on the main thread and must not be called from it.
#[tauri::command]
async fn hotkey_save(ctx: S<'_>, settings: hotkey::HotkeySettings) -> CmdResult<hotkey::HotkeyStatus> {
    ctx.db.set_setting("hotkeys", &settings)?;
    Ok(hotkey::apply(&ctx.app, &settings))
}

#[tauri::command]
async fn hotkey_suspend(ctx: S<'_>, on: bool) -> CmdResult<()> {
    hotkey::suspend(&ctx.app, &ctx.db, on);
    Ok(())
}

#[tauri::command]
fn switcher_pending() -> Option<Value> {
    hotkey::pending()
}

#[tauri::command]
async fn switcher_present(app: tauri::AppHandle, height: f64) {
    hotkey::present(&app, height);
}

#[tauri::command]
async fn switcher_hide(app: tauri::AppHandle) {
    hotkey::hide_switcher(&app);
}

/// Pick from the switcher: `{ tabId }` focuses an open terminal, `{ hostId }` opens a new one.
#[tauri::command]
async fn switcher_pick(app: tauri::AppHandle, target: Value) {
    use tauri::Emitter;
    hotkey::hide_switcher(&app);
    hotkey::show_main(&app);
    let _ = app.emit_to("main", "switcher-pick", target);
}

// ---------------- import / export ----------------

#[tauri::command]
fn import_default_path(source: String) -> Option<String> {
    importer::default_path(&source)
}

#[tauri::command]
async fn import_preview(ctx: S<'_>, source: String, path: String, password: Option<String>) -> CmdResult<importer::Preview> {
    let c = ctx.inner().clone();
    Ok(tokio::task::spawn_blocking(move || importer::preview(&c, &source, &path, password.as_deref())).await??)
}

#[tauri::command]
async fn import_apply(
    ctx: S<'_>,
    hosts: Vec<importer::Candidate>,
    snippets: Vec<Snippet>,
    backup_path: Option<String>,
    backup_password: Option<String>,
) -> CmdResult<importer::ImportResult> {
    let c = ctx.inner().clone();
    let backup = backup_path.map(|p| (p, backup_password));
    Ok(tokio::task::spawn_blocking(move || importer::apply(&c, hosts, snippets, backup)).await??)
}

#[tauri::command]
async fn export_backup(ctx: S<'_>, path: String, secrets: bool, password: Option<String>) -> CmdResult<usize> {
    let c = ctx.inner().clone();
    Ok(tokio::task::spawn_blocking(move || importer::export_backup(&c, &path, secrets, password.as_deref())).await??)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Self test / UI test instances run next to the user's window.
    let isolated = std::env::var("MYSHELL_SELFTEST").is_ok() || std::env::var("MYSHELL_TEST_INSTANCE").is_ok();
    let mut builder = tauri::Builder::default();
    if !isolated {
        // One window only: launching again brings the existing window to the front.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            hotkey::show_main(app);
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(hotkey::plugin())
        // A (re)loaded main page has lost its monitor subscriptions; connections stay untouched.
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started
                && let Some(ctx) = webview.app_handle().try_state::<CtxRef>()
            {
                monitor::reset_ui(ctx.inner());
            }
        })
        // The hidden switcher window must not keep the app alive.
        .on_window_event(|w, e| {
            if w.label() == "main" && matches!(e, tauri::WindowEvent::Destroyed) {
                w.app_handle().exit(0);
            }
        })
        .setup(move |app| {
            // MYSHELL_DATA_DIR: portable mode / isolated test data.
            let dir = match std::env::var_os("MYSHELL_DATA_DIR") {
                Some(d) => std::path::PathBuf::from(d),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&dir)?;
            applog::init(&dir);
            let db = Arc::new(Db::open(&dir.join("myshellplus.db"))?);
            let vault = Arc::new(vault::Vault::new(db.clone()));
            let unlocked = vault.is_unlocked();
            let ctx: CtxRef = Arc::new(Ctx {
                app: app.handle().clone(),
                db,
                vault,
                prompts: prompts::Prompts::new(app.handle().clone()),
                pool: Default::default(),
                terms: Default::default(),
                monitors: Default::default(),
                tunnels: Default::default(),
                transfers: Default::default(),
            });
            let server = Arc::new(McpServer::default());
            watchdog::spawn(app.handle().clone());
            app.manage(ctx.clone());
            app.manage(server.clone());
            if std::env::var("MYSHELL_TEST_INSTANCE").is_ok() {
                // UI test instance: keep rendering (CDP screenshots need it) but stay off the user's screen.
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_position(tauri::PhysicalPosition::new(-20000, -20000));
                    let _ = w.set_size(tauri::PhysicalSize::new(1440, 900));
                }
            }
            if let Ok(spec) = std::env::var("MYSHELL_SELFTEST") {
                // Headless: never put a window on the user's screen.
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                let (c, srv, handle) = (ctx.clone(), server.clone(), app.handle().clone());
                tauri::async_runtime::spawn(async move {
                    let ok = selftest::run(c, srv, spec).await;
                    println!("SELFTEST {}", if ok { "OK" } else { "FAILED" });
                    handle.exit(if ok { 0 } else { 1 });
                });
                return Ok(());
            }
            if !isolated {
                hotkey::apply(app.handle(), &hotkey::settings(&ctx.db));
            }
            let c2 = ctx.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = mcp::restart(c2.clone(), server).await {
                    log::warn!("MCP 启动失败: {e:#}");
                }
                if unlocked {
                    tunnel::auto_start(c2);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status, vault_setup, vault_disable_password, vault_unlock, vault_lock, vault_remember, vault_change_password,
            host_list, host_save, host_delete, key_list, key_import, key_generate, key_delete,
            agent_keys, op_status, op_items, op_item, op_vaults, op_create_ssh_key, op_create_login,
            conn_connect, conn_disconnect, conn_list, conn_failures, conn_failure_dismiss, conn_latency, host_probe, host_os_map,
            term_open, term_attach, term_write, term_resize, term_close, term_list, term_cwd, history_record, history_list, history_delete, exec_run,
            monitor_subscribe, monitor_unsubscribe,
            sftp_list, sftp_read, sftp_write, sftp_mkdir, sftp_rename, sftp_remove, sftp_chmod,
            transfer_start, transfer_list, transfer_cancel, transfer_clear,
            tunnel_list, tunnel_save, tunnel_delete, tunnel_start, tunnel_stop, tunnel_status,
            snippet_list, snippet_save, snippet_delete, batch_start,
            predict_local, predict_ai, ai_nl2cmd, ai_explain, ai_chat, ai_settings_get, ai_settings_save,
            mcp_settings_get, mcp_settings_save, mcp_new_token, prompt_list, prompt_answer, audit_list, known_host_list, known_host_delete,
            import_default_path, import_preview, import_apply, export_backup,
            ui_heartbeat, local_read_text, local_write_text,
            log_write, log_events, log_dir, log_export, conn_log_export, conn_diagnose,
            hotkey_get, hotkey_save, hotkey_suspend, switcher_pending, switcher_present, switcher_hide, switcher_pick,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_, e| {
            if let tauri::RunEvent::Exit = e {
                applog::clean_exit();
            }
        });
}
