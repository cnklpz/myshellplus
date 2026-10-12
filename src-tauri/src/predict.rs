//! Command prediction: history + snippets + built-in dictionary, plus AI completion
//! and natural-language-to-command.

use std::sync::Arc;

use anyhow::Result;
use serde::Serialize;
use serde_json::json;

use crate::ai::{self, Request};
use crate::state::Ctx;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub command: String,
    /// history | snippet | builtin | ai
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

pub fn local(ctx: &Ctx, host_id: &str, input: &str, limit: usize) -> Result<Vec<Suggestion>> {
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
    for h in ctx.db.search_history(host_id, input, limit)? {
        push(Suggestion { command: h.command, source: "history".into(), description: format!("用过 {} 次", h.count) }, &mut out);
    }
    let lower = input_trim.to_lowercase();
    for s in ctx.db.list_snippets()? {
        if s.command.starts_with(input_trim) || s.name.to_lowercase().contains(&lower) {
            push(Suggestion { command: s.command, source: "snippet".into(), description: s.name }, &mut out);
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
