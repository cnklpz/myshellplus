//! Local MCP server (Streamable HTTP, JSON responses) so external agents such as Claude Code
//! can operate servers. Bound to 127.0.0.1 only, Bearer token required, browser origins
//! rejected; every action passes through `guard::authorize`.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use parking_lot::Mutex;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::db::Host;
use crate::guard::{self, Kind};
use crate::ssh::{exec, get_conn};
use crate::state::Ctx;
use crate::{batch, monitor, transfer};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

pub fn settings(ctx: &Ctx) -> McpSettings {
    if let Ok(Some(s)) = ctx.db.setting::<McpSettings>("mcp") {
        return s;
    }
    let s = McpSettings { enabled: false, port: 17890, token: new_token() };
    let _ = ctx.db.set_setting("mcp", &s);
    s
}

pub fn new_token() -> String {
    let mut b = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut b);
    format!("msp_{}", hex::encode(b))
}

#[derive(Default)]
pub struct McpServer {
    stop: Mutex<Option<oneshot::Sender<()>>>,
    pub running_port: Mutex<Option<u16>>,
}

pub async fn restart(ctx: Arc<Ctx>, server: Arc<McpServer>) -> Result<()> {
    if let Some(tx) = server.stop.lock().take() {
        let _ = tx.send(());
    }
    *server.running_port.lock() = None;
    let s = settings(&ctx);
    if !s.enabled {
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", s.port))
        .await
        .map_err(|e| anyhow!("MCP 端口 {} 绑定失败: {e}", s.port))?;
    let (tx, rx) = oneshot::channel();
    *server.stop.lock() = Some(tx);
    *server.running_port.lock() = Some(s.port);
    let app = Router::new().route("/mcp", post(handle).get(|| async { StatusCode::METHOD_NOT_ALLOWED })).with_state(ctx);
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok(())
}

fn rpc_error(id: Value, code: i64, msg: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } })
}

async fn handle(State(ctx): State<Arc<Ctx>>, headers: HeaderMap, body: String) -> Response {
    // Browsers always send Origin; agents don't. Blocks DNS-rebinding / web pages.
    if headers.get("origin").is_some_and(|o| o != "null") {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let token = settings(&ctx).token;
    let ok = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| constant_eq(t.as_bytes(), token.as_bytes()));
    if !ok {
        return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
    }
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return axum::Json(rpc_error(Value::Null, -32700, "parse error")).into_response();
    };
    let Some(id) = req.get("id").cloned() else {
        return StatusCode::ACCEPTED.into_response(); // notification
    };
    let method = req["method"].as_str().unwrap_or_default();
    let params = req.get("params").cloned().unwrap_or(json!({}));
    let resp = match method {
        "initialize" => json!({
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "myshellplus", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "MyShell+ SSH 管理工具。先用 list_hosts 获取服务器，host 参数可传 id 或名称。部分操作需要用户在 MyShell+ 中确认，被拒绝时不要重试同一操作。"
            }
        }),
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools() } }),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default().to_string();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let result = match call_tool(&ctx, &name, &args).await {
                Ok(v) => json!({ "content": [{ "type": "text", "text": to_text(&v) }], "isError": false }),
                Err(e) => json!({ "content": [{ "type": "text", "text": format!("{e:#}") }], "isError": true }),
            };
            json!({ "jsonrpc": "2.0", "id": id, "result": result })
        }
        _ => rpc_error(id, -32601, "method not found"),
    };
    axum::Json(resp).into_response()
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn to_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        _ => serde_json::to_string_pretty(v).unwrap_or_default(),
    }
}

fn tools() -> Value {
    let host = json!({ "type": "string", "description": "服务器 id 或名称" });
    json!([
        { "name": "list_hosts", "description": "列出可用的服务器（含分组、地址、Agent 权限、是否已连接）",
          "inputSchema": { "type": "object", "properties": { "group": { "type": "string" } } } },
        { "name": "run_command", "description": "在服务器上执行非交互命令，返回 stdout/stderr/退出码。根据服务器权限可能需要用户确认。",
          "inputSchema": { "type": "object", "required": ["host", "command"], "properties": {
              "host": host, "command": { "type": "string" }, "timeout_secs": { "type": "integer", "default": 60 } } } },
        { "name": "batch_run", "description": "在多台服务器上并发执行同一命令",
          "inputSchema": { "type": "object", "required": ["hosts", "command"], "properties": {
              "hosts": { "type": "array", "items": { "type": "string" } }, "command": { "type": "string" },
              "timeout_secs": { "type": "integer", "default": 60 } } } },
        { "name": "host_status", "description": "获取服务器实时状态：CPU、内存、负载、网络、磁盘、进程",
          "inputSchema": { "type": "object", "required": ["host"], "properties": { "host": host } } },
        { "name": "list_dir", "description": "列出远程目录",
          "inputSchema": { "type": "object", "required": ["host", "path"], "properties": { "host": host, "path": { "type": "string" } } } },
        { "name": "read_file", "description": "读取远程文本文件（≤5MB）",
          "inputSchema": { "type": "object", "required": ["host", "path"], "properties": { "host": host, "path": { "type": "string" } } } },
        { "name": "write_file", "description": "写入远程文本文件（覆盖）",
          "inputSchema": { "type": "object", "required": ["host", "path", "content"], "properties": {
              "host": host, "path": { "type": "string" }, "content": { "type": "string" } } } },
        { "name": "list_terminals", "description": "列出用户当前打开的终端会话",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "read_terminal", "description": "读取终端会话最近的输出（纯文本）",
          "inputSchema": { "type": "object", "required": ["session_id"], "properties": {
              "session_id": { "type": "string" }, "lines": { "type": "integer", "default": 100 } } } },
        { "name": "send_terminal", "description": "向用户可见的终端会话输入文本（用于交互式程序）",
          "inputSchema": { "type": "object", "required": ["session_id", "input"], "properties": {
              "session_id": { "type": "string" }, "input": { "type": "string" }, "press_enter": { "type": "boolean", "default": true } } } }
    ])
}

fn resolve_host(ctx: &Ctx, key: &str) -> Result<Host> {
    let hosts = ctx.db.list_hosts()?;
    let h = hosts
        .iter()
        .find(|h| h.id == key)
        .or_else(|| hosts.iter().find(|h| h.name == key))
        .or_else(|| hosts.iter().find(|h| h.name.eq_ignore_ascii_case(key) || h.host == key))
        .cloned()
        .ok_or_else(|| anyhow!("找不到服务器: {key}"))?;
    if h.agent_policy == "deny" {
        bail!("找不到服务器: {key}");
    }
    Ok(h)
}

fn arg_str<'a>(args: &'a Value, k: &str) -> Result<&'a str> {
    args[k].as_str().ok_or_else(|| anyhow!("缺少参数 {k}"))
}

async fn call_tool(ctx: &Arc<Ctx>, name: &str, args: &Value) -> Result<Value> {
    let timeout = Duration::from_secs(args["timeout_secs"].as_u64().unwrap_or(60).clamp(1, 1800));
    match name {
        "list_hosts" => {
            let connected = ctx.pool.connected_ids();
            let group = args["group"].as_str();
            let list: Vec<Value> = ctx
                .db
                .list_hosts()?
                .into_iter()
                .filter(|h| h.agent_policy != "deny")
                .filter(|h| group.is_none_or(|g| h.group_name == g))
                .map(|h| {
                    json!({ "id": h.id, "name": h.name, "group": h.group_name, "address": format!("{}@{}:{}", h.username, h.host, h.port),
                            "policy": h.agent_policy, "connected": connected.contains(&h.id), "tags": h.tags, "notes": h.notes })
                })
                .collect();
            Ok(json!(list))
        }
        "run_command" => {
            let h = resolve_host(ctx, arg_str(args, "host")?)?;
            let cmd = arg_str(args, "command")?;
            guard::authorize(ctx, &h, Kind::Command(cmd)).await?;
            let c = get_conn(ctx.clone(), h.id.clone()).await?;
            let r = exec::run(&c, cmd, timeout).await?;
            Ok(serde_json::to_value(r)?)
        }
        "batch_run" => {
            let cmd = arg_str(args, "command")?;
            let mut ids = Vec::new();
            for k in args["hosts"].as_array().cloned().unwrap_or_default() {
                let h = resolve_host(ctx, k.as_str().unwrap_or_default())?;
                guard::authorize(ctx, &h, Kind::Command(cmd)).await?;
                ids.push(h.id);
            }
            let res = batch::run_many(ctx.clone(), crate::util::new_id(), ids, cmd.into(), timeout).await;
            Ok(serde_json::to_value(res)?)
        }
        "host_status" => {
            let h = resolve_host(ctx, arg_str(args, "host")?)?;
            if ctx.monitors.latest(&h.id).is_none() {
                monitor::subscribe(ctx.clone(), h.id.clone());
                for _ in 0..20 {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if ctx.monitors.latest(&h.id).is_some() {
                        break;
                    }
                }
                let (c2, id2) = (ctx.clone(), h.id.clone());
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    monitor::unsubscribe(&c2, &id2);
                });
            }
            let snap = ctx.monitors.snapshot(&h.id);
            if let Some(e) = snap.error {
                bail!(e);
            }
            Ok(json!({ "info": snap.info, "latest": snap.history.last() }))
        }
        "list_dir" => {
            let h = resolve_host(ctx, arg_str(args, "host")?)?;
            let path = arg_str(args, "path")?;
            guard::authorize(ctx, &h, Kind::ReadFile(path)).await?;
            let (real, entries) = transfer::list_dir(ctx.clone(), h.id, path.into()).await?;
            Ok(json!({ "path": real, "entries": entries }))
        }
        "read_file" => {
            let h = resolve_host(ctx, arg_str(args, "host")?)?;
            let path = arg_str(args, "path")?;
            guard::authorize(ctx, &h, Kind::ReadFile(path)).await?;
            Ok(json!(transfer::read_text(ctx.clone(), h.id, path.into()).await?))
        }
        "write_file" => {
            let h = resolve_host(ctx, arg_str(args, "host")?)?;
            let path = arg_str(args, "path")?;
            let content = arg_str(args, "content")?;
            guard::authorize(ctx, &h, Kind::WriteFile(path)).await?;
            transfer::write_text(ctx.clone(), h.id, path.into(), content.into()).await?;
            Ok(json!("ok"))
        }
        "list_terminals" => {
            let hosts = ctx.db.list_hosts()?;
            let list: Vec<Value> = ctx
                .terms
                .list()
                .into_iter()
                .filter_map(|t| {
                    let h = hosts.iter().find(|h| h.id == t.host_id && h.agent_policy != "deny")?;
                    Some(json!({ "sessionId": t.id, "host": h.name, "hostId": h.id, "alive": t.alive }))
                })
                .collect();
            Ok(json!(list))
        }
        "read_terminal" => {
            let s = ctx.terms.get(arg_str(args, "session_id")?)?;
            let h = resolve_host(ctx, &s.host_id)?;
            guard::authorize(ctx, &h, Kind::ReadFile("<terminal>")).await?;
            Ok(json!(s.tail_text(args["lines"].as_u64().unwrap_or(100).clamp(1, 2000) as usize)))
        }
        "send_terminal" => {
            let s = ctx.terms.get(arg_str(args, "session_id")?)?;
            let h = resolve_host(ctx, &s.host_id)?;
            let mut input = arg_str(args, "input")?.to_string();
            guard::authorize(ctx, &h, Kind::TerminalInput(&input)).await?;
            if args["press_enter"].as_bool().unwrap_or(true) {
                input.push('\r');
            }
            s.write(input.as_bytes()).await?;
            Ok(json!("ok"))
        }
        _ => bail!("未知工具: {name}"),
    }
}
