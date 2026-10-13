//! Command prediction: history (ours and the server's) + snippets + the server's commands + built-in
//! dictionary + remote path listing, plus AI completion and natural-language-to-command.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;

use crate::ai::{self, Request};
use crate::state::Ctx;
use crate::util::sh_quote;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub command: String,
    /// history | snippet | command | builtin | path | ai
    pub source: String,
    pub description: String,
}

const BUILTIN: &[(&str, &str)] = &[
    ("ls -lah", "列出文件（含隐藏、易读大小）"),
    ("cd ..", "上一级目录"),
    ("df -h", "磁盘使用情况"),
    ("du -sh * | sort -rh | head -20", "当前目录占用最大的项"),
    ("free -h", "内存使用"),
    ("top -o %CPU", "按 CPU 排序的进程"),
    ("htop", "交互式进程查看"),
    ("ps aux --sort=-%cpu | head -20", "CPU 占用最高的进程"),
    ("ps aux --sort=-%mem | head -20", "内存占用最高的进程"),
    ("ss -tlnp", "监听中的 TCP 端口"),
    ("ss -s", "连接统计"),
    ("netstat -tlnp", "监听端口（旧版）"),
    ("ip addr", "网卡与 IP"),
    ("ip route", "路由表"),
    ("ping -c 4 ", "测试连通性"),
    ("curl -I ", "查看响应头"),
    ("curl -sSL ", "下载内容"),
    ("wget -c ", "断点续传下载"),
    ("tail -f /var/log/syslog", "实时查看系统日志"),
    ("tail -n 200 -f ", "实时查看文件尾部"),
    ("journalctl -u  -f --since '10 min ago'", "查看服务日志"),
    ("journalctl -xe", "最近的系统错误"),
    ("systemctl status ", "服务状态"),
    ("systemctl restart ", "重启服务"),
    ("systemctl enable --now ", "启用并启动服务"),
    ("systemctl list-units --type=service --state=running", "运行中的服务"),
    ("docker ps", "运行中的容器"),
    ("docker ps -a", "所有容器"),
    ("docker images", "镜像列表"),
    ("docker logs -f --tail 200 ", "容器日志"),
    ("docker exec -it  bash", "进入容器"),
    ("docker compose up -d", "后台启动 compose"),
    ("docker compose down", "停止 compose"),
    ("docker compose logs -f", "compose 日志"),
    ("docker system prune -af", "清理无用镜像和容器"),
    ("docker stats --no-stream", "容器资源占用"),
    ("kubectl get pods -A", "所有 Pod"),
    ("kubectl get nodes -o wide", "节点列表"),
    ("kubectl describe pod ", "Pod 详情"),
    ("kubectl logs -f ", "Pod 日志"),
    ("git status", "仓库状态"),
    ("git log --oneline -20", "最近提交"),
    ("git pull --rebase", "拉取并变基"),
    ("find . -name '' -type f", "按名称查找文件"),
    ("find / -type f -size +100M 2>/dev/null", "查找大于 100MB 的文件"),
    ("grep -rn '' .", "递归搜索文本"),
    ("tar -czvf archive.tar.gz ", "打包压缩"),
    ("tar -xzvf ", "解压 tar.gz"),
    ("unzip ", "解压 zip"),
    ("chmod +x ", "添加执行权限"),
    ("chown -R : ", "修改所有者"),
    ("uname -a", "内核信息"),
    ("cat /etc/os-release", "系统版本"),
    ("uptime", "运行时间与负载"),
    ("lsblk", "块设备"),
    ("mount | column -t", "挂载点"),
    ("crontab -l", "定时任务"),
    ("crontab -e", "编辑定时任务"),
    ("history | tail -50", "最近命令"),
    ("apt update && apt upgrade -y", "更新软件包 (Debian/Ubuntu)"),
    ("apt install -y ", "安装软件包 (Debian/Ubuntu)"),
    ("yum install -y ", "安装软件包 (CentOS)"),
    ("dnf install -y ", "安装软件包 (Fedora/RHEL)"),
    ("nginx -t && nginx -s reload", "检查并重载 Nginx"),
    ("ufw status", "防火墙状态"),
    ("firewall-cmd --list-all", "防火墙规则 (firewalld)"),
    ("iptables -L -n -v", "iptables 规则"),
    ("last -n 20", "最近登录"),
    ("who", "当前登录用户"),
    ("dmesg -T | tail -50", "内核消息"),
    ("lsof -i :", "占用端口的进程"),
    ("kill -9 ", "强制结束进程"),
    ("pkill -f ", "按名称结束进程"),
    ("nohup  > out.log 2>&1 &", "后台运行"),
    ("screen -ls", "screen 会话"),
    ("tmux ls", "tmux 会话"),
    ("tmux attach -t ", "连接 tmux 会话"),
    ("vim ", "编辑文件"),
    ("nano ", "编辑文件"),
    ("rsync -avzP ", "同步文件"),
    ("scp -r ", "复制文件"),
    ("ssh-keygen -t ed25519", "生成密钥"),
    ("openssl x509 -in  -noout -dates", "证书有效期"),
    ("date", "当前时间"),
    ("timedatectl", "时区与时间同步"),
    ("hostnamectl", "主机名信息"),
    ("env | sort", "环境变量"),
    ("which ", "命令位置"),
    ("mysql -u root -p", "连接 MySQL"),
    ("redis-cli", "连接 Redis"),
    ("psql -U postgres", "连接 PostgreSQL"),
    ("python3 -m http.server 8000", "临时 HTTP 服务"),
    ("pm2 list", "PM2 进程"),
    ("pm2 logs", "PM2 日志"),
];

/// `prev`: the command this terminal ran last. What usually follows it ranks above plain history.
pub fn local(ctx: &Ctx, host_id: &str, input: &str, prev: Option<&str>, limit: usize) -> Result<Vec<Suggestion>> {
    let input_trim = input.trim_start();
    if input_trim.is_empty() {
        return Ok(vec![]);
    }
    let mut out: Vec<Suggestion> = Vec::new();
    let push = |s: Suggestion, out: &mut Vec<Suggestion>| {
        if s.command != input && !out.iter().any(|x| x.command == s.command) {
            out.push(s);
        }
    };
    let index = ctx.indexes.get(host_id);
    if let Some(prev) = prev.map(str::trim).filter(|p| !p.is_empty()) {
        let mut next: Vec<(String, i64)> =
            ctx.db.next_commands(host_id, prev, input_trim, 4)?.into_iter().map(|h| (h.command, h.count)).collect();
        if let Some(f) = index.as_ref().and_then(|i| i.follows.get(prev)) {
            for (c, n) in f.iter().filter(|(c, _)| c.starts_with(input_trim)) {
                match next.iter_mut().find(|(x, _)| x == c) {
                    Some(e) => e.1 += i64::from(*n),
                    None => next.push((c.clone(), i64::from(*n))),
                }
            }
        }
        next.sort_by_key(|e| std::cmp::Reverse(e.1));
        for (c, _) in next.into_iter().take(3) {
            push(Suggestion { command: c, source: "history".into(), description: "常接在上一条后".into() }, &mut out);
        }
    }
    for h in ctx.db.search_history(host_id, input, limit)? {
        push(Suggestion { command: h.command, source: "history".into(), description: format!("用过 {} 次", h.count) }, &mut out);
    }
    if let Some(idx) = &index {
        for c in idx.history.iter().filter(|c| c.starts_with(input_trim)).take(limit) {
            push(Suggestion { command: c.clone(), source: "history".into(), description: "服务器历史".into() }, &mut out);
        }
    }
    let lower = input_trim.to_lowercase();
    for s in ctx.db.list_snippets()? {
        if s.host_id.as_deref().is_some_and(|h| h != host_id) {
            continue;
        }
        if s.command.starts_with(input_trim) || s.name.to_lowercase().contains(&lower) {
            push(Suggestion { command: s.command, source: "snippet".into(), description: s.name }, &mut out);
        }
    }
    // Still typing the command name: complete it from what is actually installed on the server.
    if let Some(idx) = &index
        && !input_trim.contains(char::is_whitespace)
    {
        let mut names: Vec<&String> = idx.commands.iter().filter(|c| c.starts_with(input_trim)).collect();
        names.sort_by_key(|c| c.len());
        for c in names.into_iter().take(4) {
            push(Suggestion { command: c.clone(), source: "command".into(), description: "命令".into() }, &mut out);
        }
    }
    for (c, d) in BUILTIN {
        if c.starts_with(input_trim) {
            push(Suggestion { command: (*c).into(), source: "builtin".into(), description: (*d).into() }, &mut out);
        }
    }
    out.truncate(limit);
    Ok(out)
}

/// What a live connection tells us about the server: executables on `$PATH` and the user's own shell history.
#[derive(Default)]
pub struct RemoteIndex {
    /// Sorted, deduplicated command names.
    commands: Vec<String>,
    /// Newest first, deduplicated.
    history: Vec<String>,
    /// Command -> commands typed right after it (at least `MIN_FOLLOWS` times), most frequent first.
    follows: HashMap<String, Vec<(String, u32)>>,
}

/// Per-host remote indexes, tagged with the `since` of the connection they were read from so a reconnect
/// reloads them. `map` and `loading` are never held together.
#[derive(Default)]
pub struct Indexes {
    map: Mutex<HashMap<String, (u64, Arc<RemoteIndex>)>>,
    loading: Mutex<HashSet<String>>,
}

impl Indexes {
    fn get(&self, host_id: &str) -> Option<Arc<RemoteIndex>> {
        self.map.lock().get(host_id).map(|(_, i)| i.clone())
    }

    pub fn forget(&self, host_id: &str) {
        self.map.lock().remove(host_id);
    }
}

const INDEX_SCRIPT: &str = r#"echo @@CMDS
if command -v bash >/dev/null 2>&1; then bash -c 'compgen -c' 2>/dev/null
else (IFS=:; for d in $PATH; do ls -1 "$d" 2>/dev/null; done); fi
echo @@HIST
tail -n 3000 ~/.bash_history 2>/dev/null
echo @@SEP
tail -n 3000 ~/.zsh_history 2>/dev/null
echo @@SEP
tail -n 6000 ~/.local/share/fish/fish_history 2>/dev/null | sed -n 's/^- cmd: //p'
true"#;

const MAX_HISTORY: usize = 5000;
/// A pairing seen once is chance; twice is a habit.
const MIN_FOLLOWS: u32 = 2;

fn parse_index(out: &str) -> RemoteIndex {
    let (cmds, hist) = out.split_once("@@HIST\n").unwrap_or((out, ""));
    let cmds = cmds.strip_prefix("@@CMDS\n").unwrap_or(cmds);
    let mut commands: Vec<String> = cmds
        .lines()
        .map(str::trim)
        .filter(|c| c.len() >= 2 && !c.starts_with('_') && !c.contains(char::is_whitespace))
        .map(str::to_string)
        .collect();
    commands.sort();
    commands.dedup();
    // In file order (oldest -> newest); `None` marks a file boundary or an entry that can't be replayed.
    let entries: Vec<Option<&str>> = hist.lines().filter_map(history_line).collect();
    let mut seen = HashSet::new();
    let mut history = Vec::new();
    // Walk backwards so the newest copy of each command wins.
    for cmd in entries.iter().rev().flatten() {
        if seen.insert(*cmd) {
            history.push(cmd.to_string());
            if history.len() >= MAX_HISTORY {
                break;
            }
        }
    }
    // What was typed right after what: "cd app" is usually followed by "git pull".
    let mut pairs: HashMap<(&str, &str), u32> = HashMap::new();
    for w in entries.windows(2) {
        if let [Some(a), Some(b)] = w
            && a != b
        {
            *pairs.entry((*a, *b)).or_default() += 1;
        }
    }
    let mut follows: HashMap<String, Vec<(String, u32)>> = HashMap::new();
    for ((a, b), n) in pairs {
        if n >= MIN_FOLLOWS {
            follows.entry(a.to_string()).or_default().push((b.to_string(), n));
        }
    }
    for v in follows.values_mut() {
        v.sort_by(|x, y| y.1.cmp(&x.1).then_with(|| x.0.cmp(&y.0)));
        v.truncate(8);
    }
    RemoteIndex { commands, history, follows }
}

/// One history file line: `Some(None)` breaks a sequence, `None` is skipped (timestamps).
fn history_line(line: &str) -> Option<Option<&str>> {
    if line == "@@SEP" {
        return Some(None);
    }
    // bash HISTTIMEFORMAT stamps (#1700000000)
    if line.strip_prefix('#').is_some_and(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    // zsh extended history (: 1700000000:0;cmd)
    let cmd = match line.strip_prefix(": ") {
        Some(rest) => rest.split_once(';').map_or(line, |(_, c)| c),
        None => line,
    }
    .trim();
    // multi-line entries can't be replayed from one line
    if cmd.is_empty() || cmd.len() > 300 || cmd.ends_with('\\') {
        return Some(None);
    }
    Some(Some(cmd))
}

/// Read the server's command names and shell history once per connection. Only uses a live connection.
/// Returns whether a new index was loaded (cached suggestions are stale then).
pub async fn warm(ctx: Arc<Ctx>, host_id: String) -> Result<bool> {
    let Some(conn) = ctx.pool.existing(&host_id) else { return Ok(false) };
    if ctx.indexes.map.lock().get(&host_id).is_some_and(|(since, _)| *since == conn.since) {
        return Ok(false);
    }
    if !ctx.indexes.loading.lock().insert(host_id.clone()) {
        return Ok(false);
    }
    let r = crate::ssh::exec::run(&conn, &format!("sh -c {}", sh_quote(INDEX_SCRIPT)), Duration::from_secs(20)).await;
    ctx.indexes.loading.lock().remove(&host_id);
    let idx = parse_index(&r?.stdout);
    ctx.indexes.map.lock().insert(host_id, (conn.since, Arc::new(idx)));
    Ok(true)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathEntry {
    pub name: String,
    pub is_dir: bool,
}

const MAX_ENTRIES: usize = 3000;
const MAX_LINK_STATS: usize = 128;

/// Entries of `dir` as typed at terminal `id`'s prompt: absolute, `~/…`, or relative to the shell's cwd.
/// Only uses the live connection; an unreadable directory is just an empty list.
pub async fn list_path(ctx: Arc<Ctx>, id: String, dir: String) -> Result<Vec<PathEntry>> {
    let host_id = ctx.terms.get(&id)?.host_id.clone();
    let Some(conn) = ctx.pool.existing(&host_id) else { return Ok(vec![]) };
    let work = async {
        let sftp = conn.sftp().await?;
        let base = if dir.starts_with('/') {
            dir.clone()
        } else if dir == "~" || dir.starts_with("~/") {
            let home = sftp.canonicalize(".").await?;
            format!("{}{}", home.trim_end_matches('/'), dir.get(1..).unwrap_or(""))
        } else {
            let cwd = match crate::term::cwd_existing(&ctx, &id).await.ok().flatten() {
                Some(c) => c,
                None => sftp.canonicalize(".").await?,
            };
            format!("{}/{}", cwd.trim_end_matches('/'), dir)
        };
        let mut out = Vec::new();
        let mut links = Vec::new();
        for e in sftp.read_dir(base.clone()).await?.take(MAX_ENTRIES) {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let ft = e.file_type();
            if ft.is_symlink() && links.len() < MAX_LINK_STATS {
                links.push(out.len());
            }
            out.push(PathEntry { name, is_dir: ft.is_dir() });
        }
        // Symlinked directories (/bin, /lib…) matter for `cd`: resolve them concurrently.
        let stats = futures::future::join_all(links.iter().map(|&i| {
            let path = format!("{}/{}", base.trim_end_matches('/'), out[i].name);
            let sftp = sftp.clone();
            async move { sftp.metadata(path).await.map(|m| m.is_dir()).unwrap_or(false) }
        }))
        .await;
        for (&i, d) in links.iter().zip(stats) {
            out[i].is_dir = d;
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok::<_, anyhow::Error>(out)
    };
    match tokio::time::timeout(Duration::from_secs(5), work).await {
        Ok(r) => Ok(r.unwrap_or_default()),
        Err(_) => Ok(vec![]),
    }
}

fn host_context(ctx: &Ctx, host_id: &str) -> String {
    let info = ctx.monitors.snapshot(host_id).info;
    let recent = ctx.db.recent_history(host_id, 15).unwrap_or_default();
    let mut s = String::new();
    if let Some(i) = info {
        s.push_str(&format!("系统: {} / 内核 {} / {}\n", i.os, i.kernel, i.arch));
    }
    if !recent.is_empty() {
        s.push_str("最近执行的命令（新→旧）:\n");
        for c in recent {
            s.push_str(&format!("  {c}\n"));
        }
    }
    s
}

const PREDICT_SYSTEM: &str = "你是 Linux shell 命令补全引擎。根据用户已输入的前缀和上下文，给出最可能的完整命令。\
只输出 JSON 数组，最多 3 项，每项形如 {\"command\":\"完整命令（必须以用户前缀开头）\",\"description\":\"不超过 12 个字的中文说明\"}。\
不要输出任何其他文字。";

const NL_PREDICT_SYSTEM: &str = "你是 Linux shell 助手。用户在命令行里用自然语言描述了想做的事，给出可直接执行的命令。只输出 JSON 数组，最多 3 项，按推荐程度排序，每项形如 {\"command\":\"单行命令\",\"description\":\"不超过 12 个字的中文说明\"}。不要输出任何其他文字。";

/// Natural language at the prompt (starts with CJK text) rather than a command prefix.
pub fn is_natural_language(s: &str) -> bool {
    s.trim_start().chars().next().is_some_and(|c| matches!(c as u32, 0x3400..=0x9FFF | 0xF900..=0xFAFF | 0x3040..=0x30FF | 0xAC00..=0xD7AF))
}

pub async fn ai_predict(ctx: Arc<Ctx>, host_id: String, input: String, screen: String) -> Result<Vec<Suggestion>> {
    let s = ai::settings(&ctx.db);
    let nl = is_natural_language(&input);
    let screen: String = screen.chars().rev().take(1500).collect::<String>().chars().rev().collect();
    let user = if nl {
        format!("{}\n终端屏幕最后几行:\n{}\n\n用户的需求: {}", host_context(&ctx, &host_id), screen, input.trim())
    } else {
        format!("{}\n终端屏幕最后几行:\n{}\n\n用户当前输入的前缀: {}", host_context(&ctx, &host_id), screen, input)
    };
    let text = ai::complete(
        &ctx.db,
        &ctx.vault,
        s.predict_provider.as_deref(),
        Request {
            system: if nl { NL_PREDICT_SYSTEM } else { PREDICT_SYSTEM },
            user,
            max_tokens: 1024,
            effort: "low",
            think: false,
            model: s.predict_model.clone(),
        },
    )
    .await?;
    let v = ai::extract_json(&text).unwrap_or(json!([]));
    let mut out = Vec::new();
    for item in v.as_array().cloned().unwrap_or_default() {
        let cmd = item["command"].as_str().unwrap_or_default().trim().to_string();
        if cmd.is_empty() || cmd.contains('\n') || (!nl && !cmd.starts_with(input.trim_start())) {
            continue;
        }
        if out.iter().any(|o: &Suggestion| o.command == cmd) {
            continue;
        }
        out.push(Suggestion {
            command: cmd,
            source: "ai".into(),
            description: item["description"].as_str().unwrap_or_default().into(),
        });
    }
    Ok(out)
}

const NL_SYSTEM: &str = "你是资深 Linux 运维。把用户的中文/英文需求翻译成可直接在目标服务器上执行的 shell 命令。\
只输出 JSON 对象: {\"command\":\"命令（单行，可用 && 或管道连接）\",\"explanation\":\"简短中文说明\",\"dangerous\":true/false}。\
dangerous 表示命令会删除数据、停止服务、修改系统配置或重启。不要输出任何其他文字。";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NlCommand {
    pub command: String,
    pub explanation: String,
    pub dangerous: bool,
}

pub async fn nl_to_command(ctx: Arc<Ctx>, host_id: String, prompt: String) -> Result<NlCommand> {
    let user = format!("{}\n需求: {}", host_context(&ctx, &host_id), prompt);
    let text = ai::complete(&ctx.db, &ctx.vault, None, Request { system: NL_SYSTEM, user, max_tokens: 8000, effort: "medium", think: ai::settings(&ctx.db).thinking, model: None }).await?;
    let v = ai::extract_json(&text).ok_or_else(|| anyhow::anyhow!("AI 返回无法解析: {text}"))?;
    Ok(NlCommand {
        command: v["command"].as_str().unwrap_or_default().trim().into(),
        explanation: v["explanation"].as_str().unwrap_or_default().into(),
        dangerous: v["dangerous"].as_bool().unwrap_or(true),
    })
}

const EXPLAIN_SYSTEM: &str = "你是资深 Linux 运维。用简洁的中文解释用户给出的命令或终端输出：它做了什么、关键信息、如有错误给出原因和修复命令。使用 Markdown，控制在 300 字内。";

pub async fn explain(ctx: Arc<Ctx>, host_id: String, text: String) -> Result<String> {
    let user = format!("{}\n内容:\n{}", host_context(&ctx, &host_id), text);
    ai::complete(&ctx.db, &ctx.vault, None, Request { system: EXPLAIN_SYSTEM, user, max_tokens: 8000, effort: "medium", think: ai::settings(&ctx.db).thinking, model: None }).await
}

const DIAGNOSE_SYSTEM: &str = "你是 SSH 连接故障诊断专家。根据用户提供的连接日志（地址和用户名已脱敏）判断连接失败的原因。用简洁的中文 Markdown 回答，依次给出：**原因**（一句话）、**依据**（引用日志中的关键行）、**解决办法**（客户端设置或服务器端命令，按可能性排序）。不要编造日志中没有的信息，原因不确定时说明需要补充什么。控制在 400 字内。";

/// AI reading of the host's last connect attempt. The log is redacted before it leaves the machine.
pub async fn diagnose_conn(ctx: Arc<Ctx>, host_id: String) -> Result<String> {
    let log = crate::applog::export_conn(&ctx.db, &host_id, true);
    let user = format!("客户端: MyShell+（Rust russh 实现的 SSH 客户端，Windows）\n\n{log}");
    ai::complete(&ctx.db, &ctx.vault, None, Request { system: DIAGNOSE_SYSTEM, user, max_tokens: 8000, effort: "medium", think: ai::settings(&ctx.db).thinking, model: None }).await
}

const CHAT_SYSTEM: &str = "你是资深 Linux 运维助手，在 SSH 客户端的侧边栏里和用户对话。用简洁的中文 Markdown 回答。需要执行的命令放在 ```bash 代码块里，一个代码块只放一条可直接执行的命令；会修改系统、删除数据或可能断开连接的命令，在代码块前用一句话说明风险。不确定服务器环境时先给出查看命令。";

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// Multi-turn chat about a host. Earlier turns are folded into the prompt (the AI layer is single-turn).
pub async fn chat(ctx: Arc<Ctx>, host_id: String, messages: Vec<ChatMsg>, screen: Option<String>) -> Result<String> {
    let Some((last, earlier)) = messages.split_last() else { anyhow::bail!("没有内容") };
    let mut user = host_context(&ctx, &host_id);
    if let Some(s) = screen.filter(|s| !s.trim().is_empty()) {
        user.push_str(&format!("\n终端最近输出:\n```\n{}\n```\n", s.trim_end()));
    }
    // Keep the prompt bounded: the most recent turns matter most.
    let start = earlier.len().saturating_sub(16);
    if start < earlier.len() {
        user.push_str("\n之前的对话:\n");
        for m in &earlier[start..] {
            let who = if m.role == "assistant" { "助手" } else { "用户" };
            user.push_str(&format!("{who}: {}\n\n", m.content.trim()));
        }
    }
    user.push_str(&format!("\n用户: {}", last.content.trim()));
    ai::complete(&ctx.db, &ctx.vault, None, Request { system: CHAT_SYSTEM, user, max_tokens: 8000, effort: "medium", think: ai::settings(&ctx.db).thinking, model: None }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_parses_commands_and_all_history_formats() {
        let out = "@@CMDS\nls\ngit\n_private\ngit\nx\n@@HIST\n#1700000000\ngit status\n: 1700000001:0;docker ps\nls -la\ngit status\necho a \\\n\n";
        let idx = parse_index(out);
        assert_eq!(idx.commands, vec!["git", "ls"]);
        assert_eq!(idx.history, vec!["git status", "ls -la", "docker ps"]);
    }

    #[test]
    fn index_learns_what_follows_what() {
        let out = "@@CMDS\n@@HIST\ncd app\ngit pull\ncd app\ngit pull\ncd app\n@@SEP\nls\n";
        let idx = parse_index(out);
        assert_eq!(idx.follows.get("cd app"), Some(&vec![("git pull".to_string(), 2)]));
        assert_eq!(idx.follows.get("git pull"), Some(&vec![("cd app".to_string(), 2)]));
        // never across a file boundary
        assert!(idx.follows.get("cd app").is_some_and(|v| v.iter().all(|(c, _)| c != "ls")));
    }

    #[test]
    fn index_tolerates_missing_sections() {
        let idx = parse_index("");
        assert!(idx.commands.is_empty() && idx.history.is_empty());
    }
}
