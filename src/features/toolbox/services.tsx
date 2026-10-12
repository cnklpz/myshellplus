// Service status and control for the toolbox: Nginx / PHP-FPM / MySQL (every installed version), and other
// common services (宝塔, 1Panel, OpenClaw, Hermes, Redis, …) that are listed only when found.
// One read-only probe finds services across systemd, SysV init.d (宝塔 installs) and OpenRC; controls go
// through whichever manager owns the service.
import { ChevronRight, Copy, Play, RotateCw, Square, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExecOutput, type Risk } from "../../components/CommandPreview";
import { Select } from "../../components/Select";
import { errMsg } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { type RemoteEnv, runScript, shq } from "../../lib/remote";
import { type Action, ActionBox, type Quick, QuickBtns, useQuick } from "../docker/DockerPanel";
import { useContextMenu } from "../terminal/ContextMenu";
import { canPriv } from "./precheck";
import "../docker/docker.css";

type Mgr = "systemd" | "initd" | "openrc" | "cli";

export interface Svc {
  kind: string;
  /** systemd unit / init script name; for cli services the systemd user unit. */
  unit: string;
  mgr: Mgr;
  active: boolean;
  /** systemd is-enabled (enabled/disabled/static/…), OpenRC enabled/disabled, else "". */
  enabled: string;
  ver: string;
  bin: string;
  ports: string[];
  /** Nginx error log. */
  log: string;
}

interface PhpCli { bin: string; real: string; ver: string }
interface Probe { svcs: Svc[]; cli: PhpCli[]; cliDefault: string; alt: boolean }

const LABELS: Record<string, string> = {
  bt: "宝塔面板",
  "1panel": "1Panel",
  openclaw: "OpenClaw",
  hermes: "Hermes Agent",
  redis: "Redis",
  pgsql: "PostgreSQL",
  mongo: "MongoDB",
  apache: "Apache",
  caddy: "Caddy",
  supervisor: "Supervisor",
  memcached: "Memcached",
  ftp: "FTP",
  frp: "frp",
  nezha: "哪吒探针",
  xui: "X-UI",
  tomcat: "Tomcat",
  es: "Elasticsearch",
  rabbitmq: "RabbitMQ",
  jenkins: "Jenkins",
  gitea: "Gitea",
};
const WEB = ["nginx", "php", "mysql"];
const WEB_LABEL: Record<string, string> = { nginx: "Nginx", php: "PHP", mysql: "MySQL" };
/** Display order of the "other services" list. */
const OTHER_ORDER = Object.keys(LABELS);

// Everything is printed as tab-separated lines; the marker keeps pgrep -f from matching this script itself.
const PROBE = String.raw`# MSP_SVC_PROBE
SD=; [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && SD=1
RC=; command -v rc-service >/dev/null 2>&1 && RC=1
UH=$(getent passwd "${'$'}{SUDO_USER:-$(id -un)}" 2>/dev/null | cut -d: -f6); [ -n "$UH" ] || UH=$HOME
SS=$( (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -i listen)
pg() { for p in $(pgrep -f "$1" 2>/dev/null); do grep -q MSP_SVC_PROBE /proc/$p/cmdline 2>/dev/null || echo $p; done; }
tree() { for p in "$@"; do echo $p; pgrep -P $p 2>/dev/null; done; }
ports_of() { for p in $1; do printf '%s\n' "$SS" | grep -E "pid=$p,| $p/"; done | awk '{print $4}' | sed 's/.*://' | sort -un | tr '\n' ' '; }
sdv() { systemctl show -p "$2" "$1" 2>/dev/null | cut -d= -f2-; }
cg_pids() {
  cg=$(sdv "$1" ControlGroup); [ -n "$cg" ] || return 0
  for f in /sys/fs/cgroup$cg/cgroup.procs /sys/fs/cgroup/systemd$cg/cgroup.procs /sys/fs/cgroup/unified$cg/cgroup.procs; do
    [ -r "$f" ] && { cat "$f"; return 0; }
  done
}
fb() { for c in "$@"; do case $c in /*) [ -x "$c" ] && { echo "$c"; return; } ;; *) command -v "$c" 2>/dev/null && return ;; esac; done; }
emit() { printf 'S\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@"; }
kind_of() {
  case $1 in
    nginx|openresty|tengine) echo nginx ;;
    *php*-fpm*|php-fpm*) echo php ;;
    mysql|mysqld|mariadb|mysql-server|percona-server) echo mysql ;;
    bt|btpanel) echo bt ;;
    1panel|1panel-core) echo 1panel ;;
    redis|redis-server) echo redis ;;
    postgresql|postgresql-[0-9]*) echo pgsql ;;
    mongod|mongodb) echo mongo ;;
    httpd|apache2) echo apache ;;
    caddy) echo caddy ;;
    supervisor|supervisord) echo supervisor ;;
    memcached) echo memcached ;;
    pure-ftpd|vsftpd) echo ftp ;;
    frps|frpc) echo frp ;;
    nezha-agent) echo nezha ;;
    x-ui|3x-ui) echo xui ;;
    tomcat|tomcat[0-9]*) echo tomcat ;;
    elasticsearch) echo es ;;
    rabbitmq-server) echo rabbitmq ;;
    jenkins) echo jenkins ;;
    gitea) echo gitea ;;
  esac
}
NAMES=$( {
  if [ -n "$SD" ]; then
    systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null
    systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null | sed 's/^[^a-zA-Z0-9]*//'
  fi | awk '{print $1}' | sed -n 's/\.service$//p'
  [ -d /etc/init.d ] && ls /etc/init.d 2>/dev/null
} | grep -v '@' | sort -u)
SEEN=" "
for u in $NAMES; do
  k=$(kind_of "$u"); [ -n "$k" ] || continue
  mgr=; id=$u
  if [ -n "$SD" ] && [ "$(sdv "$u.service" LoadState)" = loaded ]; then
    id=$(sdv "$u.service" Id); id=${'$'}{id%.service}
    # Units generated from /etc/init.d scripts have no fragment; those (宝塔) are driven by the script itself.
    [ -n "$(sdv "$u.service" FragmentPath)" ] && mgr=systemd
  fi
  if [ -z "$mgr" ]; then
    [ -x "/etc/init.d/$u" ] || continue
    id=$u; if [ -n "$RC" ] && [ -z "$SD" ]; then mgr=openrc; else mgr=initd; fi
  fi
  case "$SEEN" in *" $id "*) continue ;; esac
  SEEN="$SEEN$id "
  bin=
  [ $mgr = systemd ] && bin=$(sdv "$id.service" ExecStart | sed -n 's/^{ path=\([^ ;]*\).*/\1/p' | head -n1)
  f=/etc/init.d/$u
  if [ $mgr != systemd ] && [ -f "$f" ]; then
    case $k in
      nginx) bin=$(grep -oE '/[^ "=;]*sbin/nginx' "$f" | head -n1) ;;
      php) p=$(sed -n 's/^prefix=//p' "$f" | head -n1); [ -n "$p" ] && bin=$p/sbin/php-fpm
           [ -x "$bin" ] || bin=$(grep -oE '/[^ "=;$]*sbin/php-fpm[0-9.]*' "$f" | head -n1); [ -x "$bin" ] || bin= ;;
      mysql) p=$(sed -n 's/^basedir=\(\/[^ ]*\).*/\1/p' "$f" | head -n1); [ -n "$p" ] && bin=$p/bin/mysqld ;;
    esac
  fi
  case $k in
    nginx) [ -x "$bin" ] || bin=$(fb /www/server/nginx/sbin/nginx nginx /usr/local/nginx/sbin/nginx /usr/local/openresty/nginx/sbin/nginx) ;;
    # The version in the unit name (php8.2-fpm, php74-php-fpm, php-fpm-74) picks the matching binary.
    php) v=$(echo "$u" | grep -oE '[0-9]\.?[0-9]+' | head -n1)
         [ -x "$bin" ] || bin=$(fb ${'$'}{v:+php-fpm$v /usr/sbin/php-fpm$v /opt/remi/php$v/root/usr/sbin/php-fpm /www/server/php/$v/sbin/php-fpm} php-fpm /usr/sbin/php-fpm) ;;
    mysql) case $bin in *mysqld_safe*) bin= ;; esac
           [ -x "$bin" ] || bin=$(fb mariadbd mysqld /usr/sbin/mariadbd /usr/sbin/mysqld /usr/libexec/mysqld /www/server/mysql/bin/mysqld) ;;
  esac
  ver=
  case $k in
    nginx) [ -n "$bin" ] && ver=$("$bin" -v 2>&1 | sed -n 's/.*version: *//p' | head -n1) ;;
    php) [ -n "$bin" ] && ver=$("$bin" -v 2>/dev/null | head -n1) ;;
    mysql) [ -n "$bin" ] && ver=$("$bin" --version 2>/dev/null | head -n1) ;;
    bt) ver=$(grep -oE "version *= *['\"][0-9.]+" /www/server/panel/class/common.py 2>/dev/null | grep -oE '[0-9.]+$' | head -n1) ;;
    1panel) ver=$(1pctl version 2>/dev/null | grep -oE 'v[0-9][0-9.]*' | head -n1) ;;
    redis) ver=$(redis-server --version 2>/dev/null | grep -oE 'v=[0-9.]+' | cut -c3-) ;;
    pgsql) ver=$(psql --version 2>/dev/null | awk '{print $3}') ;;
    mongo) ver=$(mongod --version 2>/dev/null | grep -oE 'v[0-9][0-9.]*' | head -n1) ;;
    apache) ver=$( (apache2 -v || httpd -v) 2>/dev/null | sed -n 's/.*Apache\/\([0-9.]*\).*/\1/p') ;;
    caddy) ver=$(caddy version 2>/dev/null | awk '{print $1}') ;;
  esac
  pids=; en=; st=inactive
  if [ $mgr = systemd ]; then
    st=$(systemctl is-active "$id" 2>/dev/null); pids=$(cg_pids "$id.service")
    en=$(systemctl is-enabled "$id" 2>/dev/null)
  else
    case $k in
      nginx) m=$(pg "nginx: master process $bin" | head -n1); [ -n "$m" ] || m=$(pg 'nginx: master' | head -n1) ;;
      # Master cmdline names its config: /etc/php/8.2/fpm/…, /www/server/php/74/etc/…, /etc/opt/remi/php74/…
      php) if [ -n "$v" ]; then m=$(pg "php-fpm: master process .*$v/" | head -n1); else m=$(pg 'php-fpm: master' | head -n1); fi ;;
      mysql) m=$(pgrep -x mysqld | head -n1); [ -n "$m" ] || m=$(pgrep -x mariadbd | head -n1) ;;
      bt) m=$(pg BT-Panel | head -n1); [ -n "$m" ] || m=$(pg 'panel/runserver' | head -n1) ;;
      *) m=$(pgrep -x "$u" | head -n1) ;;
    esac
    [ -n "$m" ] && { st=active; pids=$(tree $m); }
    if [ $mgr = openrc ]; then
      rc-service "$u" status >/dev/null 2>&1 && st=active
      rc-update show default 2>/dev/null | grep -qw "$u" && en=enabled || en=disabled
    fi
  fi
  ports=$(ports_of "$pids")
  [ $k = bt ] && [ -r /www/server/panel/data/port.pl ] && ports=$(cat /www/server/panel/data/port.pl)
  log=
  if [ $k = nginx ] && [ -n "$bin" ]; then
    conf=$("$bin" -V 2>&1 | grep -oE -- '--conf-path=[^ ]+' | cut -d= -f2)
    [ -r "$conf" ] && log=$(sed -n 's/^[[:space:]]*error_log[[:space:]]\{1,\}\([^ ;]*\).*/\1/p' "$conf" | head -n1)
    [ -n "$log" ] || log=$("$bin" -V 2>&1 | grep -oE -- '--error-log-path=[^ ]+' | cut -d= -f2)
  fi
  emit "$k" "$id" "$mgr" "$st" "$en" "$ver" "$bin" "$ports" "$log"
done
# PHP command-line versions
d=$(command -v php 2>/dev/null) && printf 'D\t%s\n' "$(readlink -f "$d")"
for b in /usr/bin/php[0-9]* /usr/local/bin/php[0-9]* /www/server/php/*/bin/php /opt/remi/php*/root/usr/bin/php; do
  [ -f "$b" ] && [ -x "$b" ] && printf 'C\t%s\t%s\t%s\n' "$b" "$(readlink -f "$b")" "$("$b" -r 'echo PHP_VERSION;' 2>/dev/null)"
done
update-alternatives --list php >/dev/null 2>&1 && printf 'A\t1\n'
# User-level agents
ub() { for c in "$@"; do [ -x "$c" ] && { echo "$c"; return; }; done; }
B=$(command -v openclaw 2>/dev/null || ub "$UH/.npm-global/bin/openclaw" "$UH/.local/bin/openclaw" "$UH"/.nvm/versions/node/*/bin/openclaw "$UH/.bun/bin/openclaw" "$UH/.local/share/pnpm/openclaw" /usr/local/bin/openclaw)
if [ -n "$B" ] || [ -d "$UH/.openclaw" ]; then
  v=
  if [ -n "$B" ]; then
    r=$(readlink -f "$B")
    for d in "${'$'}{r%/*}" "${'$'}{r%/*/*}"; do [ -f "$d/package.json" ] && { v=$(grep -m1 '"version"' "$d/package.json" | grep -oE '[0-9][0-9A-Za-z.+-]*'); break; }; done
  fi
  m=$(pg 'openclaw.*gateway' | head -n1); st=inactive; pids=
  [ -n "$m" ] && { st=active; pids=$(tree $m); }
  emit openclaw openclaw-gateway cli "$st" "" "$v" "$B" "$(ports_of "$pids")" ""
fi
B=$(command -v hermes 2>/dev/null || ub "$UH/.local/bin/hermes" "$UH/.hermes/hermes-agent/venv/bin/hermes")
if [ -n "$B" ] || [ -d "$UH/.hermes/hermes-agent" ]; then
  v=$(grep -m1 '^version' "$UH/.hermes/hermes-agent/pyproject.toml" 2>/dev/null | grep -oE '[0-9][0-9A-Za-z.+-]*')
  m=$(pg 'hermes.*gateway' | head -n1); st=inactive; pids=
  [ -n "$m" ] && { st=active; pids=$(tree $m); }
  emit hermes hermes-gateway cli "$st" "" "$v" "$B" "$(ports_of "$pids")" ""
fi
true`;

function parse(out: string): Probe {
  const p: Probe = { svcs: [], cli: [], cliDefault: "", alt: false };
  for (const line of out.split("\n")) {
    const f = line.replace(/\r$/, "").split("\t");
    if (f[0] === "S" && f.length >= 10) {
      const [, kind, unit, mgr, st, enabled, ver, bin, ports, log] = f;
      p.svcs.push({ kind, unit, mgr: mgr as Mgr, active: st === "active", enabled, ver, bin, ports: ports.split(" ").filter(Boolean), log });
    } else if (f[0] === "C" && f[3]) {
      if (!p.cli.some((c) => c.real === f[2])) p.cli.push({ bin: f[1], real: f[2], ver: f[3] });
    } else if (f[0] === "D") p.cliDefault = f[1];
    else if (f[0] === "A") p.alt = true;
  }
  return p;
}

/** Product name and version for a row. */
function nameOf(s: Svc): { name: string; ver: string } {
  switch (s.kind) {
    case "nginx": {
      const m = /^(\w+)\/(\S+)/.exec(s.ver);
      const prod = m?.[1].toLowerCase();
      return { name: prod === "openresty" ? "OpenResty" : prod === "tengine" ? "Tengine" : "Nginx", ver: m?.[2] ?? s.ver };
    }
    case "php": {
      const full = /PHP (\d+\.\d+\.\d+)/.exec(s.ver)?.[1] ?? "";
      // Unit names carry the version too: php8.2-fpm, php74-php-fpm, php-fpm-74 (宝塔).
      const u = /(\d)\.?(\d+)/.exec(s.unit);
      const mm = full ? full.split(".").slice(0, 2).join(".") : u ? `${u[1]}.${u[2]}` : "";
      return { name: mm ? `PHP ${mm}` : "PHP", ver: full };
    }
    case "mysql": {
      const v = /Ver\s+(\d+\.\d+\.\d+)/.exec(s.ver)?.[1] ?? "";
      const name = /mariadb/i.test(s.ver) || s.unit === "mariadb" ? "MariaDB" : /percona/i.test(s.ver) ? "Percona" : "MySQL";
      return { name, ver: v };
    }
    default:
      return { name: LABELS[s.kind] ?? s.unit, ver: s.ver };
  }
}

const verNum = (s: Svc) => nameOf(s).ver.split(".").reduce((a, x) => a * 1000 + (parseInt(x) || 0), 0);
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

/** Command to run a CLI-managed agent with its own node/python on PATH. */
function cliCmd(s: Svc): string {
  const name = s.kind === "openclaw" ? "openclaw" : "hermes";
  if (!s.bin) return `PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH" ${name}`;
  return `PATH=${shq(dirOf(s.bin))}:"$PATH" ${shq(s.bin)}`;
}

function ctl(s: Svc, a: string): string {
  switch (s.mgr) {
    case "systemd":
      return `systemctl ${a} ${s.unit}`;
    case "initd":
      return `/etc/init.d/${s.unit} ${a}`;
    case "openrc":
      return `rc-service ${s.unit} ${a}`;
    case "cli":
      return `${cliCmd(s)} gateway ${a}`;
  }
}

/** Config check command, run before reload/restart. */
function testCmd(s: Svc): string | null {
  if (!s.bin) return null;
  if (s.kind === "nginx") return `${shq(s.bin)} -t`;
  if (s.kind === "php") return `${shq(s.bin)} -t`;
  return null;
}
const guarded = (s: Svc, cmd: string) => {
  const t = testCmd(s);
  return t ? `${t} && ${cmd}` : cmd;
};

/** CLI services run as the login user; system services need root. */
const privOf = (s: Svc, e: RemoteEnv) => s.mgr !== "cli" && !e.root;

function actionsOf(s: Svc): Action[] {
  const k = s.unit;
  const a = (label: string, script: string, risk: Risk, extra: Partial<Action> = {}): Action => ({ key: k, label, script, risk, ...extra });
  const out: Action[] = [];
  if (s.active) {
    out.push(a("停止", ctl(s, "stop"), "change", { note: "服务会中断" }));
    out.push(a("重启", guarded(s, ctl(s, "restart")), "change", { note: "服务会短暂中断" }));
    if (["nginx", "php", "apache", "caddy"].includes(s.kind) && s.mgr !== "cli")
      out.push(a("重载配置", guarded(s, ctl(s, "reload")), "change", { note: "不中断连接" }));
  } else out.push(a("启动", guarded(s, ctl(s, "start")), "change"));
  const t = testCmd(s);
  if (t) out.push(a("检查配置", t, "read"));
  out.push(a("状态", s.mgr === "systemd" ? `systemctl status ${s.unit} --no-pager -l` : ctl(s, "status"), "read"));
  if (s.mgr === "systemd") out.push(a("日志", `journalctl -u ${s.unit} -n 200 --no-pager`, "read"));
  if (s.mgr === "cli") out.push(a("日志", `journalctl --user -u ${s.unit} -n 200 --no-pager`, "read"));
  if (s.kind === "nginx" && s.log) out.push(a("错误日志", `tail -n 200 ${shq(s.log)}`, "read"));
  if (s.kind === "mysql") {
    const client = s.bin.startsWith("/www/server/") ? shq(`${dirOf(s.bin)}/mysql`) : "mysql";
    out.push(a("命令行", `${client} -uroot -p`, "change", { term: true, note: "exit 退出" }));
  }
  if (s.kind === "bt") out.push(a("面板信息", "bt default", "read", { note: "输出面板地址和账号" }));
  if (s.kind === "1panel") out.push(a("面板信息", "1pctl user-info", "read", { note: "输出面板地址和账号" }));
  if (s.mgr === "cli") out.push(a("诊断", `${cliCmd(s)} doctor`, "read", { term: true }));
  if (s.mgr === "systemd" || s.mgr === "openrc") {
    const on = s.enabled === "enabled";
    if (on || s.enabled === "disabled") {
      const cmd =
        s.mgr === "systemd" ? `systemctl ${on ? "disable" : "enable"} ${s.unit}` : `rc-update ${on ? "del" : "add"} ${s.unit} default`;
      out.push(a(on ? "取消自启" : "开机自启", cmd, "change"));
    }
  }
  return out;
}

function quicksOf(s: Svc, e: RemoteEnv): Quick[] {
  const priv = privOf(s, e);
  return s.active
    ? [
        { kind: "stop", script: ctl(s, "stop"), priv },
        { kind: "restart", script: guarded(s, ctl(s, "restart")), priv },
      ]
    : [{ kind: "start", script: guarded(s, ctl(s, "start")), priv }];
}

const MGR_LABEL: Record<Mgr, string> = { systemd: "systemd", initd: "init.d", openrc: "OpenRC", cli: "用户服务" };

function useServices(hostId: string, env: RemoteEnv, privKey: boolean) {
  const [data, setData] = useState<Probe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    runScript(hostId, env, PROBE, { priv: privKey, quiet: true, timeout: 40 }).then(
      (r) => {
        if (n !== seq.current) return;
        setError(null);
        setData(parse(r.stdout));
      },
      (e) => n === seq.current && setError(errMsg(e)),
    );
  }, [hostId, env, privKey]);
  useEffect(() => {
    reload();
    const t = setInterval(() => document.visibilityState === "visible" && reload(), 15000);
    return () => clearInterval(t);
  }, [reload]);
  return { data, error, reload };
}

/** Web stack at the top of the toolbox, and the detected-services list for the bottom. */
export function useServiceList(hostId: string, env: RemoteEnv) {
  return useServices(hostId, env, canPriv(hostId, env));
}

type List = ReturnType<typeof useServiceList>;

export function WebServices(props: { hostId: string; env: RemoteEnv; list: List }) {
  const { data, error } = props.list;
  return (
    <div className="tb-group">
      <div className="section-title tb-group-title">Web 环境</div>
      {error && !data ? (
        <div className="sv-note tb-err">{error}</div>
      ) : !data ? (
        <div className="sv-note faint">正在检测</div>
      ) : (
        <SvcRows {...props} kinds={WEB} />
      )}
    </div>
  );
}

export function OtherServices(props: { hostId: string; env: RemoteEnv; list: List }) {
  const svcs = props.list.data?.svcs.filter((s) => !WEB.includes(s.kind)) ?? [];
  if (!svcs.length) return null;
  return (
    <div className="tb-group">
      <div className="section-title tb-group-title">已识别服务</div>
      <SvcRows {...props} kinds={OTHER_ORDER} />
    </div>
  );
}

function SvcRows(props: { hostId: string; env: RemoteEnv; list: List; kinds: string[] }) {
  const { hostId, env, list } = props;
  const [open, setOpen] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const quick = useQuick({ hostId, env, priv: !env.root }, list.reload);
  const all = list.data!.svcs;
  const web = props.kinds === WEB;
  const menu = useContextMenu();

  // Row menu: start/stop/restart run at once like the row buttons; the rest opens the command preview.
  const onMenu = (e: React.MouseEvent, s: Svc) => {
    const busy = !!quick.busy[s.unit];
    const [q0, q1] = quicksOf(s, env);
    const preview = (a: Action) => (setOpen(s.unit), setAction(a));
    const rest = actionsOf(s).filter((a) => !["启动", "停止", "重启"].includes(a.label));
    const item = (a: Action) => ({ label: a.label + "…", icon: a.term ? <SquareTerminal /> : undefined, onSelect: () => preview(a) });
    menu.open(e, [
      s.active
        ? { label: "停止", icon: <Square />, disabled: busy, onSelect: () => quick.run(s.unit, q0) }
        : { label: "启动", icon: <Play />, disabled: busy, onSelect: () => quick.run(s.unit, q0) },
      { label: "重启", icon: <RotateCw />, disabled: busy || !s.active, onSelect: () => q1 && quick.run(s.unit, q1) },
      "sep",
      {
        label: "复制服务名",
        icon: <Copy />,
        onSelect: () => void copyText(s.unit, "服务名"),
      },
      "sep",
      ...rest.filter((a) => a.risk !== "read").map(item),
      "sep",
      ...rest.filter((a) => a.risk === "read").map(item),
    ]);
  };

  return (
    <div className="sv-list">
      {props.kinds.map((kind) => {
        const rows = all.filter((s) => s.kind === kind).sort((a, b) => verNum(b) - verNum(a));
        if (!rows.length)
          return web ? (
            <div key={kind} className="dk-row static">
              <span className="dot" />
              <span className="dk-name ellipsis">{WEB_LABEL[kind]}</span>
              <span className="sv-sub grow">未安装</span>
            </div>
          ) : null;
        return (
          <div key={kind} className="sv-kind">
            {rows.map((s) => {
              const { name, ver } = nameOf(s);
              const failed = quick.fail?.key === s.unit ? quick.fail : null;
              const isOpen = open === s.unit || !!failed;
              const toggle = () => (setOpen(isOpen ? null : s.unit), setAction(null), failed && quick.clear());
              const priv = privOf(s, env);
              return (
                <div key={s.unit} className={"dk-item" + (isOpen ? " open" : "")}>
                  <div
                    className="dk-row"
                    role="button"
                    tabIndex={0}
                    onClick={toggle}
                    onKeyDown={(e) => e.key === "Enter" && toggle()}
                    onContextMenu={(e) => onMenu(e, s)}
                  >
                    <span className={"dot " + (s.active ? "ok" : "")} />
                    <span className="dk-name ellipsis">{name}</span>
                    <span className="sv-sub ellipsis grow">{ver}</span>
                    {s.active && s.ports.length > 0 && (
                      <span className="dk-nums" title="监听端口">
                        <span className="ellipsis">{s.ports.slice(0, 2).join(" ")}</span>
                      </span>
                    )}
                    <QuickBtns items={quicksOf(s, env)} busy={!!quick.busy[s.unit]} onRun={(q) => quick.run(s.unit, q)} />
                    <ChevronRight className="dk-chev" />
                  </div>
                  {isOpen && (
                    <div className="dk-detail">
                      {failed && <ExecOutput result={failed.result} error={failed.error} />}
                      <div className="kv">
                        <span>状态</span>
                        <span className={s.active ? "sv-ok" : "faint"}>
                          {s.active ? "运行中" : "已停止"}
                          {s.enabled === "enabled" ? " · 开机自启" : s.enabled === "disabled" ? " · 未设自启" : ""}
                        </span>
                        <span>服务</span>
                        <span className="mono ellipsis">{s.unit}<span className="faint"> · {MGR_LABEL[s.mgr]}</span></span>
                        {s.bin && (
                          <>
                            <span>程序</span>
                            <span className="mono ellipsis" title={s.bin}>{s.bin}</span>
                          </>
                        )}
                        {s.ports.length > 0 && (
                          <>
                            <span>端口</span>
                            <span className="mono ellipsis">{s.ports.join(" ")}</span>
                          </>
                        )}
                      </div>
                      <div className="dk-btns">
                        {actionsOf(s).map((a) => (
                          <button
                            key={a.label}
                            className={"btn sm" + (action?.key === s.unit && action.label === a.label ? " on" : "")}
                            onClick={() => setAction(action?.key === s.unit && action.label === a.label ? null : a)}
                          >
                            {a.term && <SquareTerminal />}
                            {a.label}
                          </button>
                        ))}
                      </div>
                      {action && action.key === s.unit && (
                        <ActionBox
                          key={action.label}
                          hostId={hostId}
                          env={env}
                          priv={priv}
                          action={action}
                          onDone={list.reload}
                          onCancel={() => setAction(null)}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {kind === "php" && <PhpCliRow hostId={hostId} env={env} list={list} />}
          </div>
        );
      })}
      {menu.node}
    </div>
  );
}

/** Default `php` on the command line, switchable when several versions are installed. */
function PhpCliRow(props: { hostId: string; env: RemoteEnv; list: List }) {
  const { cli, cliDefault, alt } = props.list.data!;
  const [pick, setPick] = useState<string | null>(null);
  if (cli.length < 2) return null;
  const opts = [...cli]
    .sort((a, b) => b.ver.localeCompare(a.ver, undefined, { numeric: true }))
    .map((c) => ({ value: c.real, label: `${c.ver}  ${c.bin}` }));
  const cur = cli.find((c) => c.real === cliDefault);
  const target = pick && pick !== cliDefault ? cli.find((c) => c.real === pick) : null;
  // Debian/Ubuntu: alternatives; 宝塔 and others: /usr/bin/php symlink.
  const script = target
    ? alt && target.bin.startsWith("/usr/bin/")
      ? `update-alternatives --set php ${shq(target.bin)}`
      : `ln -sf ${shq(target.real)} /usr/bin/php`
    : null;
  return (
    <div className="sv-cli">
      <div className="field">
        <label>命令行 php</label>
        <Select size="sm" width="100%" value={pick ?? cliDefault} options={cur ? opts : [{ value: cliDefault, label: cliDefault || "未设置" }, ...opts]} onChange={(v) => setPick(v)} />
      </div>
      {script && (
        <ActionBox
          key={script}
          hostId={props.hostId}
          env={props.env}
          priv={!props.env.root}
          action={{ key: "php-cli", label: "切换", script, risk: "change" }}
          onDone={props.list.reload}
          onCancel={() => setPick(null)}
        />
      )}
    </div>
  );
}
