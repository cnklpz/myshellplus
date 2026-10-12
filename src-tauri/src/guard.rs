//! Agent permission checks. Every agent action goes through `authorize`, which applies the
//! host's policy, asks the user when needed and writes the audit log.

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Result, bail};
use regex::Regex;
use serde_json::json;

use crate::db::Host;
use crate::state::Ctx;

/// Read-only as long as `check_args` below accepts their arguments.
const READONLY_CMDS: &[&str] = &[
    "ls", "ll", "cat", "head", "tail", "less", "more", "grep", "egrep", "zgrep", "find", "wc", "sort", "uniq", "cut",
    "awk", "df", "du", "free", "uptime", "w", "who", "whoami", "id", "ps", "top", "pgrep", "uname", "hostname",
    "hostnamectl", "date", "ip", "ss", "netstat", "ifconfig", "ping", "dig", "nslookup", "host", "lsblk", "lscpu",
    "lsof", "stat", "file", "readlink", "realpath", "pwd", "echo", "printenv", "journalctl", "dmesg", "last",
    "history", "which", "whereis", "type", "md5sum", "sha256sum", "tree", "vmstat", "iostat", "mpstat", "nproc",
    "getent", "timedatectl", "column", "jq", "test", "true",
];

/// Commands whose subcommand (see `sub_index`) must be one of these (see also `segment_readonly`).
const READONLY_SUBCMDS: &[(&str, &[&str])] = &[
    ("systemctl", &["status", "list-units", "list-unit-files", "is-active", "is-enabled", "show", "cat"]),
    ("docker", &["ps", "images", "logs", "inspect", "stats", "version", "info", "top", "port"]),
    ("kubectl", &["get", "describe", "logs", "top", "version", "explain"]),
    ("git", &["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame", "describe", "shortlog"]),
    ("apt", &["list", "show", "search", "policy"]),
];

/// Commands without any file-writing option, so an unquoted glob that might expand to a file
/// named like an option (`-o…`) can't make them write.
const GLOB_OK: &[&str] = &[
    "ls", "ll", "cat", "head", "tail", "wc", "du", "stat", "md5sum", "sha256sum", "grep", "egrep", "zgrep", "readlink",
    "realpath",
];

/// Directories a command may be named by absolute path from (`/usr/bin/ls`, not `/tmp/x/ls`).
const SYSTEM_BIN_DIRS: &[&str] = &["/bin/", "/usr/bin/", "/sbin/", "/usr/sbin/", "/usr/local/bin/"];

/// One shell word after quote removal. `glob_opt`: it has an unquoted glob that could expand to a
/// file name starting with `-`, i.e. to an option.
struct Word {
    text: String,
    glob_opt: bool,
}

/// Quote-aware split into simple commands (on unquoted `|`, `;`, `&`) and their words, with POSIX
/// quote removal. Returns None for anything whose words can't be known statically: parameter /
/// command / arithmetic expansion (`$`, backticks, `$'…'`), brace expansion, redirections,
/// subshells, line breaks and unbalanced quotes.
fn tokenize(cmd: &str) -> Option<Vec<Vec<Word>>> {
    if cmd.contains(['\n', '\r', '\0']) {
        return None;
    }
    let mut segs = Vec::new();
    let mut words: Vec<Word> = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut glob_at: Option<usize> = None;
    let finish = |words: &mut Vec<Word>, cur: &mut String, in_word: &mut bool, glob_at: &mut Option<usize>| {
        if *in_word {
            let glob_opt = glob_at.is_some_and(|i| i == 0 || cur.starts_with('-'));
            words.push(Word { text: std::mem::take(cur), glob_opt });
        }
        *in_word = false;
        *glob_at = None;
    };
    let mut chars = cmd.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '\'' => break,
                        ch => cur.push(ch),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => {
                            let n = chars.next()?;
                            if !matches!(n, '$' | '`' | '"' | '\\') {
                                cur.push('\\');
                            }
                            cur.push(n);
                        }
                        '$' | '`' => return None,
                        ch => cur.push(ch),
                    }
                }
            }
            '\\' => {
                in_word = true;
                cur.push(chars.next()?);
            }
            '$' | '`' | '{' | '}' | '(' | ')' | '<' | '>' => return None,
            '*' | '?' | '[' => {
                in_word = true;
                glob_at.get_or_insert(cur.len());
                cur.push(c);
            }
            '|' | ';' | '&' => {
                finish(&mut words, &mut cur, &mut in_word, &mut glob_at);
                if !words.is_empty() {
                    segs.push(std::mem::take(&mut words));
                }
            }
            c if c.is_whitespace() => finish(&mut words, &mut cur, &mut in_word, &mut glob_at),
            c => {
                in_word = true;
                cur.push(c);
            }
        }
    }
    finish(&mut words, &mut cur, &mut in_word, &mut glob_at);
    if !words.is_empty() {
        segs.push(words);
    }
    Some(segs)
}

/// Environment assignments allowed before a read-only command (not LD_PRELOAD, PAGER, ...).
fn safe_env_assign(w: &str) -> bool {
    let Some((name, _)) = w.split_once('=') else { return false };
    name.starts_with("LC_") || matches!(name, "LANG" | "LANGUAGE" | "TZ" | "COLUMNS" | "LINES" | "NO_COLOR")
}

/// Bare command name, or a path into a system bin directory.
fn command_name(w: &str) -> Option<&str> {
    if !w.contains('/') {
        return Some(w);
    }
    SYSTEM_BIN_DIRS.iter().find_map(|d| w.strip_prefix(d)).filter(|n| !n.is_empty() && !n.contains('/'))
}

/// Short-option word (`-uo`) containing one of `bad`. Letters in `with_arg` take the rest of the
/// word as their value (`-t,` / `-k1,1`), so scanning stops there.
fn short_has(a: &str, bad: &str, with_arg: &str) -> bool {
    let Some(rest) = a.strip_prefix('-') else { return false };
    if rest.starts_with('-') {
        return false;
    }
    for c in rest.chars() {
        if bad.contains(c) {
            return true;
        }
        if with_arg.contains(c) {
            return false;
        }
    }
    false
}

/// Long option name without its `=value`.
fn long_name(a: &str) -> &str {
    a.split('=').next().unwrap_or(a)
}

/// `a` selects one of the `blocked` long options. getopt_long (and git) accept any unambiguous
/// prefix (`--out` = `--output`), so a prefix of a blocked option counts; an exact match of a
/// harmless option in `exact_ok` wins over the prefix rule, as in getopt_long.
fn long_hit(a: &str, blocked: &[&str], exact_ok: &[&str]) -> bool {
    let name = long_name(a);
    name.len() > 2 && name.starts_with("--") && !exact_ok.contains(&name) && blocked.iter().any(|o| o.starts_with(name))
}

fn any_long(args: &[&str], blocked: &[&str]) -> bool {
    args.iter().any(|a| long_hit(a, blocked, &[]))
}

fn positionals<'a>(args: &[&'a str]) -> Vec<&'a str> {
    args.iter().copied().filter(|a| !a.starts_with('-')).collect()
}

/// `--output=FILE` / `--log-file=FILE` write files. For df, journalctl, kubectl and systemctl
/// `--output` is only a format switch. kubectl (pflag) treats `_` like `-` (`--log_file`).
fn writes_file_opt(cmd: &str, args: &[&str]) -> bool {
    let blocked: &[&str] = if matches!(cmd, "df" | "journalctl" | "kubectl" | "systemctl") {
        &["--log-file", "--log-dir", "--LOG-FILE"]
    } else {
        &["--output", "--output-file", "--log-file", "--log-dir", "--LOG-FILE"]
    };
    args.iter().any(|a| {
        let a = if cmd == "kubectl" { a.replace('_', "-") } else { (*a).to_string() };
        long_hit(&a, blocked, &[])
    })
}

fn date_readonly(args: &[&str]) -> bool {
    let mut prev = "";
    for &a in args {
        if short_has(a, "s", "dfIr") || long_hit(a, &["--set"], &[]) {
            return false;
        }
        // `date MMDDhhmm[[CC]YY][.ss]` sets the clock.
        let takes_value = matches!(prev, "-d" | "--date" | "-r" | "--reference" | "-f" | "--file");
        if !a.starts_with(['-', '+']) && !takes_value && a.chars().all(|c| c.is_ascii_digit() || c == '.') {
            return false;
        }
        prev = a;
    }
    true
}

/// gawk: program files / extensions (`-f`, `-i`, `-E`, `-l`), dump / profile files (`-d`, `-o`,
/// `-p`), and program text that writes or runs commands (`>`, `|`, `system`, `@load`, inplace).
fn awk_readonly(args: &[&str]) -> bool {
    let mut prev = "";
    for &a in args {
        if short_has(a, "fiEldop", "vFWe")
            || long_hit(
                a,
                &[
                    "--file", "--include", "--load", "--exec", "--dump-variables", "--pretty-print", "--profile",
                    "--debug", "--source",
                ],
                &[],
            )
        {
            return false;
        }
        // Values of -F / -v are a separator / variable, not program text.
        let is_value = matches!(prev, "-F" | "-v");
        let is_opt_value = a.starts_with("-F") || a.starts_with("-v");
        if !is_value && !is_opt_value && (a.contains(['>', '|', '@']) || a.contains("system") || a.contains("inplace")) {
            return false;
        }
        prev = a;
    }
    true
}

/// iproute2 objects in its own lookup order: a word selects the first object it is a prefix of
/// (`l` = link, `a` = address).
const IP_OBJECTS: &[&str] = &[
    "address", "addrlabel", "maddress", "route", "rule", "neighbor", "neighbour", "ntable", "ntbl", "link", "l2tp",
    "fou", "ila", "macsec", "tunnel", "tuntap", "tap", "token", "tcpmetrics", "tcp_metrics", "monitor", "xfrm",
    "mroute", "mrule", "netns", "netconf", "vrf", "sr", "nexthop", "mptcp", "ioam", "stats",
];
const IP_READ_OBJECTS: &[&str] = &[
    "address", "addrlabel", "maddress", "route", "rule", "neighbor", "neighbour", "ntable", "link", "tunnel", "tuntap",
    "netconf", "nexthop",
];
/// Harmless global options (without leading dashes). Anything else (-batch, -netns, -all, -force,
/// abbreviations like -fam) is rejected.
const IP_SAFE_OPTS: &[&str] = &[
    "4", "6", "0", "s", "stats", "statistics", "d", "details", "r", "resolve", "o", "oneline", "t", "timestamp",
    "c", "color", "h", "human", "human-readable", "iec", "j", "json", "p", "pretty", "br", "brief", "N", "Numeric",
];

/// `ip [OPTIONS] OBJECT [COMMAND ...]`: only listing commands.
fn ip_readonly(args: &[&str]) -> bool {
    let mut it = args.iter();
    let mut obj = None;
    while let Some(&a) = it.next() {
        // Global options end at the first non-option word; iproute2 accepts `-opt` and `--opt`.
        let Some(n) = a.strip_prefix('-') else {
            obj = Some(a);
            break;
        };
        let n = n.strip_prefix('-').unwrap_or(n);
        if matches!(n, "f" | "family") {
            if it.next().is_none() {
                return false;
            }
        } else if !IP_SAFE_OPTS.contains(&n) && !n.starts_with("color=") {
            return false;
        }
    }
    let Some(obj) = obj else { return true };
    if obj.is_empty() {
        return false;
    }
    let Some(resolved) = IP_OBJECTS.iter().find(|o| o.starts_with(obj)) else { return false };
    if !IP_READ_OBJECTS.contains(resolved) {
        return false;
    }
    match it.next() {
        None => true,
        Some(&c) => {
            !c.is_empty() && ("show".starts_with(c) || "list".starts_with(c) || matches!(c, "lst" | "get" | "help"))
        }
    }
}

fn git_readonly(sub: &str, args: &[&str]) -> bool {
    if any_long(args, &["--output", "--ext-diff"]) {
        return false;
    }
    match sub {
        "branch" => {
            let writes = args.iter().any(|a| {
                short_has(a, "dDmMcCfut", "")
                    || long_hit(
                        a,
                        &[
                            "--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream",
                            "--edit-description", "--track", "--no-track", "--create-reflog",
                        ],
                        &[],
                    )
            });
            let list_mode = args.iter().any(|a| {
                matches!(
                    long_name(a),
                    "--list" | "-l" | "-a" | "-r" | "--all" | "--remotes" | "--contains" | "--no-contains" | "--merged"
                        | "--no-merged" | "--points-at"
                )
            });
            // `git branch NAME` creates a branch.
            !writes && (list_mode || positionals(args).is_empty())
        }
        "remote" => match positionals(args).first() {
            None => true,
            Some(s) => matches!(*s, "show" | "get-url"),
        },
        _ => true,
    }
}

/// Per-command argument checks for otherwise read-only commands.
fn check_args(cmd: &str, args: &[&str]) -> bool {
    match cmd {
        "sort" => !args.iter().any(|a| short_has(a, "o", "kStT")) && !any_long(args, &["--output", "--compress-program"]),
        "find" => !args.iter().any(|a| {
            matches!(*a, "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir" | "-fls" | "-fprint" | "-fprint0" | "-fprintf")
        }),
        "awk" => awk_readonly(args),
        "date" => date_readonly(args),
        "hostname" => {
            positionals(args).is_empty() && !args.iter().any(|a| short_has(a, "Fb", "")) && !any_long(args, &["--file", "--boot"])
        }
        "hostnamectl" => positionals(args).first().is_none_or(|s| *s == "status"),
        "timedatectl" => positionals(args)
            .first()
            .is_none_or(|s| matches!(*s, "status" | "show" | "list-timezones" | "timesync-status" | "show-timesync")),
        "journalctl" => !args.iter().any(|a| {
            long_hit(
                a,
                &[
                    "--vacuum-size", "--vacuum-time", "--vacuum-files", "--rotate", "--flush", "--sync",
                    "--relinquish-var", "--smart-relinquish-var", "--setup-keys", "--update-catalog", "--cursor-file",
                ],
                &["--cursor"],
            )
        }),
        "dmesg" => {
            !args.iter().any(|a| short_has(a, "cCDEn", "lfFs"))
                && !any_long(args, &["--clear", "--read-clear", "--console-off", "--console-on", "--console-level"])
        }
        "ip" => ip_readonly(args),
        "ifconfig" => positionals(args).len() <= 1,
        // -K kills sockets, -D dumps raw diag data to a file.
        "ss" => !args.iter().any(|a| short_has(a, "KD", "fAFN")) && !any_long(args, &["--kill", "--diag"]),
        "uniq" => positionals(args).len() <= 1, // `uniq IN OUT` writes OUT
        "tree" => !args.iter().any(|a| short_has(a, "o", "LPIHT")),
        "less" | "more" => !args.iter().any(|a| short_has(a, "oO", "bhjkpPtTxyz") || a.starts_with('+')),
        "file" => !args.iter().any(|a| short_has(a, "C", "eFfmP")) && !any_long(args, &["--compile"]),
        "history" => !args.iter().any(|a| a.starts_with('-')),
        _ => true,
    }
}

/// Index of the subcommand in `args`, skipping harmless global options before it
/// (`git -C dir log`, `systemctl --no-pager status`, `kubectl -n ns get`).
fn sub_index(cmd: &str, args: &[&str]) -> usize {
    let (flags, with_val): (&[&str], &[&str]) = match cmd {
        "git" => (&["--no-pager", "-P"], &["-C"]),
        "systemctl" => (
            &["--no-pager", "--no-legend", "--full", "-l", "--all", "-a", "--plain", "-q", "--quiet", "--user", "--system"],
            &["-t", "--type", "--state", "-p", "--property", "-n", "--lines", "-o", "--output"],
        ),
        "kubectl" => (&[], &["-n", "--namespace", "--context"]),
        _ => (&[], &[]),
    };
    let mut i = 0;
    while let Some(&a) = args.get(i) {
        if flags.contains(&a) {
            i += 1;
        } else if with_val.contains(&a) {
            i += 2;
        } else if with_val.iter().any(|o| o.starts_with("--") && a.strip_prefix(o).is_some_and(|v| v.starts_with('='))) {
            i += 1;
        } else {
            break;
        }
    }
    i
}

fn segment_readonly(words: &[Word]) -> bool {
    let mut i = 0;
    while i < words.len() && words[i].text.contains('=') && !words[i].text.starts_with('-') {
        if !safe_env_assign(&words[i].text) {
            return false;
        }
        i += 1;
    }
    let Some(first) = words.get(i) else { return true };
    let Some(cmd) = command_name(&first.text) else { return false };
    let rest = words.get(i + 1..).unwrap_or_default();
    if rest.iter().any(|w| w.glob_opt) && !GLOB_OK.contains(&cmd) {
        return false;
    }
    let args: Vec<&str> = rest.iter().map(|w| w.text.as_str()).collect();
    if writes_file_opt(cmd, &args) {
        return false;
    }
    if READONLY_CMDS.contains(&cmd) {
        return check_args(cmd, &args);
    }
    if cmd == "nginx" {
        // Only test / version flags (`-t`, `-tq`); -c / -e / -g / -p / -s load files or signal.
        return !args.is_empty()
            && args.iter().all(|a| {
                a.strip_prefix('-').is_some_and(|f| !f.is_empty() && f.chars().all(|c| "tTvVqh?".contains(c)))
            });
    }
    let Some((_, subs)) = READONLY_SUBCMDS.iter().find(|(c, _)| *c == cmd) else { return false };
    let k = sub_index(cmd, &args);
    let Some(&sub) = args.get(k) else { return false };
    if !subs.contains(&sub) {
        return false;
    }
    let after = args.get(k + 1..).unwrap_or_default();
    match cmd {
        "git" => git_readonly(sub, after),
        // -o / -c can point apt's cache (which it rewrites) anywhere.
        "apt" => !args.iter().any(|a| short_has(a, "oc", "")) && !any_long(&args, &["--option", "--config-file"]),
        _ => true,
    }
}

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

/// Conservative read-only check: every pipeline segment must be a known read-only command with
/// arguments that don't make it write, and no output redirection / command substitution.
pub fn is_readonly(cmd: &str) -> bool {
    tokenize(cmd).is_some_and(|segs| segs.iter().all(|s| segment_readonly(s)))
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
        crate::util::log_err("写入审计日志失败", ctx.db.audit("agent", Some(&host.id), action, &detail, result));
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
    fn readonly_allows_common_reads() {
        for c in [
            "LC_ALL=C df -h --output=source,pcent",
            "ps -eo pid,comm --sort=-pcpu | head",
            "grep -o foo /var/log/syslog",
            "sort -k2,2nr -t, data.csv | uniq -c",
            "find /var/log -name '*.gz' -mtime +7",
            "date +%F",
            "date -d '2 days ago'",
            "date -Iseconds",
            "hostname -I",
            "hostnamectl",
            "hostnamectl status",
            "timedatectl show",
            "journalctl -u nginx -o json --since today",
            "dmesg -T -l err",
            "ip -br addr",
            "ip route get 1.1.1.1",
            "ip addr show dev eth0",
            "ss -tlnp",
            "ifconfig eth0",
            "tree -L 2",
            "git status",
            "git log --oneline -n 5",
            "git branch -a",
            "git branch --list 'feat*'",
            "git remote -v",
            "git remote get-url origin",
            "nginx -t",
            "kubectl get pods -o wide",
        ] {
            assert!(is_readonly(c), "{c}");
        }
    }

    #[test]
    fn readonly_rejects_write_bypasses() {
        for c in [
            // env runs arbitrary commands
            "env rm -rf /tmp/x",
            "LD_PRELOAD=/tmp/x.so ls",
            "PAGER=sh git log",
            // sort writes with -o / --output, runs --compress-program
            "sort -o /etc/passwd x",
            "sort -uo /etc/passwd x",
            "sort --output=/etc/passwd x",
            "sort '-o' /etc/passwd x",
            "sort --compress-program=sh x",
            // find actions
            "find / -fprint /etc/x",
            "find / -fls /etc/x",
            "find / -fprintf /etc/x %p",
            "find / -fprint0 /etc/x",
            "find / -delete",
            "find / -exec rm {} ;",
            "find / -execdir rm {} +",
            "find / -okdir rm {} ;",
            // date sets the clock
            "date -s 2020-01-01",
            "date --set=2020-01-01",
            "date -us 2020-01-01",
            "date 010112002020",
            // ip changes
            "ip addr add 10.0.0.2/24 dev eth0",
            "ip addr a 10.0.0.2/24 dev eth0",
            "ip link set eth0 down",
            "ip route del default",
            "ip route flush table main",
            "ip route change default via 10.0.0.1",
            "ip route replace default via 10.0.0.1",
            "ip neigh flush all",
            "ip netns exec x rm -rf /",
            "ip -batch /tmp/cmds",
            "ip -b /tmp/cmds",
            // hostname / hostnamectl / timedatectl setters
            "hostname evil",
            "hostname -F /tmp/name",
            "hostnamectl set-hostname evil",
            "timedatectl set-time 2020-01-01",
            "timedatectl set-ntp false",
            // journalctl maintenance
            "journalctl --vacuum-size=1M",
            "journalctl --vacuum-time=1s",
            "journalctl --rotate",
            "journalctl --flush",
            // dmesg clears the ring buffer
            "dmesg -C",
            "dmesg -c",
            "dmesg --clear",
            "dmesg -n 1",
            // git writes
            "git branch -D main",
            "git branch -d feature",
            "git branch -m old new",
            "git branch newbranch",
            "git branch -f main HEAD~3",
            "git branch --set-upstream-to=origin/x",
            "git remote add evil https://x",
            "git remote remove origin",
            "git remote set-url origin https://x",
            "git log --output=/etc/passwd",
            "git diff --output=/tmp/x",
            "git diff --ext-diff",
            "git -c core.pager=sh log",
            "git checkout .",
            "git tag v1",
            // other writers
            "uniq in.txt /etc/passwd",
            "tree -o /etc/passwd",
            "less -o /tmp/log file",
            "less +!sh file",
            "file -C -m /tmp/magic",
            "ifconfig eth0 down",
            "ss -K dst 10.0.0.1",
            "history -c",
            "history -w /tmp/h",
            "awk -f /tmp/prog.awk x",
            "awk -i inplace '{print}' f",
            "awk 'BEGIN{system(\"id\")}'",
            "nginx -t -s stop",
            "nginx -T -g 'pid /tmp/x;'",
            "cat x --output=/tmp/y",
            "ls\rreboot",
        ] {
            assert!(!is_readonly(c), "{c}");
        }
    }

    #[test]
    fn readonly_allows_normal_reads() {
        for c in [
            "ls -la",
            "ps aux",
            "df -h",
            "free -m",
            "cat /etc/os-release",
            "journalctl -u nginx -n 50",
            "journalctl --cursor=s=abc -n 5",
            "git log --oneline -5",
            "ip addr",
            "ip -br a",
            "ip a s",
            "ip -4 -s link show",
            "ip --json route list",
            "ss -tlnp",
            "systemctl status nginx",
            "systemctl --no-pager status nginx",
            "systemctl --type=service list-units",
            "docker ps",
            "find /var/log -name '*.log' -mtime -1",
            "awk '{print $1}' /etc/passwd",
            "awk -F: '{print $1}' /etc/passwd",
            "awk -F '|' '{print $1}' f",
            "grep -E 'a|b' f",
            "grep \"a;b\" f && echo ok",
            "ps aux | grep nginx",
            "git -C dir log",
            "git --no-pager -C /srv/app log -n 3",
            "kubectl -n kube-system get pods -o wide",
            "kubectl get pods --output=json",
            "ls /var/log/*.gz",
            "ls *.log",
            "/usr/bin/ls -la",
            "nginx -tq",
            "apt list --installed",
        ] {
            assert!(is_readonly(c), "{c}");
        }
    }

    #[test]
    fn readonly_rejects_round2_bypasses() {
        for c in [
            // shell expansion
            "sort $'-o' /etc/passwd x",
            "sort {-o,/etc/passwd} x",
            "sort ${U:--o} /etc/passwd x",
            "find / {-delete,}",
            "date $'-s' 2020-01-01",
            "dmesg ${X:--C}",
            "sort $\"-o\" /etc/passwd x",
            "sort \"$U\" /etc/passwd x",
            "LC_ALL=$(id) ls",
            "cat <> /etc/x",
            "cat < /etc/passwd",
            "(reboot)",
            "ls 'unterminated",
            "ls \"a\nb\"",
            // globs that may expand to options
            "sort * x",
            "sort '-'* x",
            "sort ?o x",
            "sort [-]o* x",
            // GNU long-option prefixes
            "sort --out=/etc/passwd x",
            "sort --outp /etc/passwd x",
            "sort --compress=sh x",
            "date --se=2020-01-01",
            "date --s 2020-01-01",
            "journalctl --rot",
            "journalctl --flu",
            "journalctl --vac=1s",
            "dmesg --cle",
            "ss --ki dst 1.2.3.4",
            "file --comp -m x",
            "cat x --outp=/tmp/y",
            "git log --outp=/tmp/x",
            "git diff --ext",
            "git branch --del main",
            "hostname --f /tmp/name",
            // ip
            "ip -fam inet l add dummy0 type dummy",
            "ip -fam inet l set eth0 down",
            "ip -net x l set eth0 down",
            "ip l set eth0 down",
            "ip a add 10.0.0.2/24 dev eth0",
            "ip -all netns exec reboot",
            "ip --batch /tmp/cmds",
            "ip -force -b /tmp/cmds",
            "ip netns exec x id",
            "ip xfrm state flush",
            "ip r flush cache",
            // missing write options
            "ss -D /tmp/x",
            "ss -tD/tmp/x",
            "ss --diag=/tmp/x",
            "journalctl --cursor-file=/tmp/c",
            "awk -d/tmp/x 'BEGIN{}'",
            "awk --dump-variables=/tmp/x 1",
            "awk -o/tmp/x 1",
            "awk --pretty-print=/tmp/x 1",
            "awk -p 1",
            "awk --profile=/tmp/x 1",
            "awk -lrwarray 1",
            "awk -f/tmp/p x",
            "awk -i/tmp/p x",
            "awk -E /tmp/p x",
            "awk --fi=/tmp/p x",
            "awk --inc=x 1",
            "awk '{print > \"/tmp/x\"}' f",
            "awk '{print | \"sh\"}' f",
            "awk '@load \"rwarray\"'",
            "kubectl get pods --log-file=/tmp/x",
            "kubectl get pods --log_file=/tmp/x",
            "kubectl --log-dir=/tmp get pods",
            "nginx -t -e /tmp/x",
            "nginx -t -c /tmp/x.conf",
            "nginx -tc/tmp/x.conf",
            "nginx -t -p /tmp",
            "apt list -o Dir::Cache=/tmp/x",
            // command paths
            "/tmp/x/ls",
            "./ls",
            "/usr/bin/../../tmp/ls",
            "/usr/bin/",
            // global options that aren't skipped
            "systemctl -H host status x",
            "git -c core.pager=sh -C . log",
            "kubectl -n get pods",
        ] {
            assert!(!is_readonly(c), "{c}");
        }
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
