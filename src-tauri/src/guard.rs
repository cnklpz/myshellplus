//! Agent permission checks. Every agent action goes through `authorize`, which applies the
//! host's policy, asks the user when needed and writes the audit log.

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Result, bail};
use regex::Regex;
use serde_json::json;

use crate::db::Host;
use crate::state::Ctx;

const READONLY_CMDS: &[&str] = &[
    "ls", "ll", "cat", "head", "tail", "less", "more", "grep", "egrep", "zgrep", "find", "wc", "sort", "uniq", "cut",
    "awk", "df", "du", "free", "uptime", "w", "who", "whoami", "id", "ps", "top", "pgrep", "uname", "hostname",
    "hostnamectl", "date", "ip", "ss", "netstat", "ifconfig", "ping", "dig", "nslookup", "host", "lsblk", "lscpu",
    "lsof", "stat", "file", "readlink", "realpath", "pwd", "echo", "printenv", "env", "journalctl", "dmesg", "last",
    "history", "which", "whereis", "type", "md5sum", "sha256sum", "tree", "vmstat", "iostat", "mpstat", "nproc",
    "getent", "timedatectl", "column", "jq", "test", "true",
];

const READONLY_SUBCMDS: &[(&str, &[&str])] = &[
    ("systemctl", &["status", "list-units", "list-unit-files", "is-active", "is-enabled", "show", "cat"]),
    ("docker", &["ps", "images", "logs", "inspect", "stats", "version", "info", "top", "port"]),
    ("kubectl", &["get", "describe", "logs", "top", "version", "explain"]),
    ("git", &["status", "log", "diff", "show", "branch", "remote"]),
    ("nginx", &["-t", "-v", "-V", "-T"]),
    ("apt", &["list", "show", "search", "policy"]),
];

fn dangerous_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?x)
            \brm\s+(-[a-zA-Z]*[rRf]|--recursive|--force)
            | \bmkfs | \bdd\s+ | \bshred\b | \bwipefs\b | \bfdisk\b | \bparted\b
            | \b(shutdown|reboot|poweroff|halt)\b | \binit\s+[06]\b
            | >\s*/dev/(sd|vd|nvme|hd)
            | \bchmod\s+(-R\s+)?[0-7]*777 | \bchown\s+-R\s+\S+\s+/(\s|$)
            | :\(\)\s*\{
            | \b(iptables|ip6tables)\s+-(F|X|P) | \bufw\s+(disable|reset) | \bnft\s+flush
            | \b(userdel|deluser|passwd|usermod)\b
            | \bsystemctl\s+(stop|disable|mask|kill)\b
            | \bdocker\s+(rm|rmi|kill|stop)\b | \bdocker\s+(system|volume|image)\s+(prune|rm)
            | \bkubectl\s+(delete|drain|cordon)\b
            | (?i:\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)\b)
            | \bcrontab\s+-r\b | \bkill\s+-9\s+1\b
            | \bgit\s+push\s+.*--force | \bgit\s+reset\s+--hard | \bgit\s+clean\s+-[a-z]*f
            | >\s*/etc/",
        )
        .unwrap()
    })
}

pub fn is_dangerous(cmd: &str) -> Option<String> {
    dangerous_re().find(cmd).map(|m| format!("包含高风险操作: {}", m.as_str().trim()))
}

/// Conservative read-only check: every pipeline segment must start with a known read-only
/// command, and no output redirection / command substitution is allowed.
pub fn is_readonly(cmd: &str) -> bool {
    if cmd.contains('`') || cmd.contains("$(") || cmd.contains('>') || cmd.contains("<(") || cmd.contains('\n') {
        return false;
    }
    let segments = cmd.split(['|', ';', '&']).map(str::trim).filter(|s| !s.is_empty());
    for seg in segments {
        let mut words = seg.split_whitespace().skip_while(|w| w.contains('=') && !w.starts_with('-'));
        let Some(first) = words.next() else { continue };
        let first = first.rsplit('/').next().unwrap_or(first);
        if first == "sudo" {
            return false;
        }
        if READONLY_CMDS.contains(&first) {
            if (first == "find" && (seg.contains("-delete") || seg.contains("-exec") || seg.contains("-ok")))
                || (first == "awk" && seg.contains("system"))
            {
                return false;
            }
            continue;
        }
        let sub = words.next().unwrap_or("");
        if !READONLY_SUBCMDS.iter().any(|(c, subs)| *c == first && subs.contains(&sub)) {
            return false;
        }
    }
    true
}

pub enum Kind<'a> {
    Command(&'a str),
    WriteFile(&'a str),
    ReadFile(&'a str),
    TerminalInput(&'a str),
}

/// Check and (when needed) ask the user. Returns Err with a reason if denied.
pub async fn authorize(ctx: &Ctx, host: &Host, kind: Kind<'_>) -> Result<()> {
    let (action, detail) = match &kind {
        Kind::Command(c) => ("run_command", c.to_string()),
        Kind::WriteFile(p) => ("write_file", p.to_string()),
        Kind::ReadFile(p) => ("read_file", p.to_string()),
        Kind::TerminalInput(t) => ("terminal_input", t.to_string()),
    };
    let policy = host.agent_policy.as_str();
    let audit = |result: &str| {
        let _ = ctx.db.audit("agent", Some(&host.id), action, &detail, result);
    };
    let ask_reason: Option<String> = match (policy, &kind) {
        ("deny", _) => {
            audit("denied: policy");
            bail!("该服务器禁止 Agent 访问");
        }
        ("readonly", Kind::Command(c)) if is_readonly(c) => None,
        ("readonly", Kind::ReadFile(_)) => None,
        ("readonly", _) => {
            audit("denied: readonly");
            bail!("该服务器为只读模式，此操作被拒绝（只允许查看类命令）");
        }
        ("auto", Kind::Command(c)) | ("auto", Kind::TerminalInput(c)) => is_dangerous(c),
        ("auto", _) => None,
        _ => Some("该服务器要求每次操作都需确认".into()),
    };
    if let Some(reason) = ask_reason {
        let ans = ctx
            .prompts
            .ask(
                "agent",
                json!({
                    "hostId": host.id, "hostName": host.name, "host": host.host,
                    "action": action, "detail": detail, "reason": reason,
                    "dangerous": is_dangerous(&detail).is_some(),
                }),
                Duration::from_secs(300),
            )
            .await;
        if !ans.as_ref().and_then(|v| v["approve"].as_bool()).unwrap_or(false) {
            audit("denied: user");
            bail!("用户拒绝了此操作");
        }
        audit("approved: user");
    } else {
        audit("allowed: policy");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly() {
        assert!(is_readonly("ls -la /var/log | grep nginx"));
        assert!(is_readonly("systemctl status nginx"));
        assert!(is_readonly("docker ps -a"));
        assert!(!is_readonly("rm -rf /tmp/x"));
        assert!(!is_readonly("cat a > b"));
        assert!(!is_readonly("ls; reboot"));
        assert!(!is_readonly("echo $(reboot)"));
        assert!(!is_readonly("find / -name x -delete"));
        assert!(!is_readonly("systemctl restart nginx"));
        assert!(!is_readonly("sudo ls"));
    }

    #[test]
    fn dangerous() {
        assert!(is_dangerous("rm -rf /var/www").is_some());
        assert!(is_dangerous("sudo reboot").is_some());
        assert!(is_dangerous("systemctl stop nginx").is_some());
        assert!(is_dangerous("ls -la").is_none());
        assert!(is_dangerous("docker ps").is_none());
    }
}
