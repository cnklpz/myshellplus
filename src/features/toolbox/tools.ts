// Toolbox actions. Each tool builds a POSIX sh script from its form values and the detected system;
// the panel always shows the full script and its risk before running it.
import { api, type Host } from "../../lib/api";
import { useApp } from "../../store";
import { isLike, kernelAtLeast, pkgInstall, type RemoteEnv, shq } from "../../lib/remote";

export type Risk = "read" | "change" | "high";
export type Values = Record<string, string | boolean | string[]>;
/** Pre-run check finding; "err" blocks running. */
export interface Issue {
  level: "ok" | "warn" | "err";
  text: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "check" | "secret" | "multi";
  options?: { value: string; label: string }[];
  placeholder?: string;
  def?: string | boolean | string[];
  /** secret: offer a "generate" button */
  gen?: boolean;
}

export interface Ctx {
  env: RemoteEnv;
  /** Probe output (key=value). */
  cur: Record<string, string>;
  host?: Host;
}

export interface Built {
  script: string;
  /** Written to the script's stdin (passwords); never shown or logged. */
  stdin?: string;
}

export interface Tool {
  id: string;
  group: string;
  label: string;
  when?: (e: RemoteEnv) => boolean;
  /** Right-hand text on the list row. */
  meta?: (e: RemoteEnv) => string;
  risk: Risk | ((v: Values, c: Ctx) => Risk);
  /** One-line risk explanation for change/high tools. */
  note?: string | ((v: Values, c: Ctx) => string);
  /** Needs root (default: true unless risk is "read"). */
  priv?: boolean;
  /** Long-running: run in the terminal so progress is visible. */
  term?: boolean;
  timeout?: number;
  /** Read-only script whose key=value output fills `cur` before the form shows. */
  probe?: (e: RemoteEnv) => string;
  probePriv?: boolean;
  /** Line describing the probed state, shown above the form. */
  current?: (cur: Record<string, string>) => string;
  fields?: (c: Ctx, v: Values) => FieldDef[];
  /** null = nothing to do (button disabled); string = validation message. */
  build?: (v: Values, c: Ctx) => Built | string | null;
  /** Runs after a successful (exit 0) script. */
  after?: (v: Values, c: Ctx) => Promise<string | void>;
  /** Pre-run check, evaluated once the form builds a runnable script. */
  check?: {
    /** Read-only script (key=value output), re-run when it changes; omit or return null to check the form alone (`r` is then empty). */
    script?: (v: Values, c: Ctx) => string | null;
    issues: (r: Record<string, string>, v: Values, c: Ctx) => Issue[];
  };
  /** Rendered by a dedicated component instead of the generic form. */
  custom?: "adduser";
}

export const GROUPS = ["系统", "用户", "SSH", "网络", "磁盘", "软件"];

const str = (v: Values, k: string) => String(v[k] ?? "").trim();
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const PORT_RE = /^\d{1,5}$/;
const validPort = (p: string) => PORT_RE.test(p) && +p > 0 && +p < 65536;

// ---------- pre-run check snippets ----------
const PKG_BUSY = "for p in apt apt-get dpkg yum dnf rpm apk pacman zypper; do pgrep -x $p >/dev/null 2>&1 && { echo busy=$p; break; }; done";
const DISK_FREE = "echo free=$(df -Pm / | awk 'NR==2{print $4}')";
const VIRT = `V=$(systemd-detect-virt -c 2>/dev/null); [ -z "$V" ] && [ -d /proc/vz ] && [ ! -d /proc/bc ] && V=openvz; echo virt=$V`;
const sh = (...lines: string[]) => [...lines, "true"].join("\n");
/** Prints reach=1 when an HTTP(S) URL answers at all (any status). */
const REACH = (url: string) =>
  `if command -v curl >/dev/null 2>&1; then curl -sI -o /dev/null --max-time 5 ${url} && echo reach=1; else wget -q --spider -T 5 ${url}; c=$?; [ $c = 0 ] || [ $c = 8 ] && echo reach=1; fi`;

type R = Record<string, string>;
const busyIssue = (r: R): Issue[] => (r.busy ? [{ level: "err", text: `${r.busy} 正在运行，等它结束后再试` }] : []);
function diskIssue(r: R, needMb: number): Issue[] {
  const free = Number(r.free);
  if (!r.free || free >= needMb) return [];
  return [{ level: free < needMb / 4 ? "err" : "warn", text: `根分区仅剩 ${free} MB` }];
}
const inContainer = (r: R) => !!r.virt && r.virt !== "none";
const listOf = (s?: string) => (s ? s.split(/[,\s]+/).filter(Boolean) : []);
const appHostsFor = (c: Ctx, user: string) =>
  c.host ? useApp.getState().hosts.filter((h) => h.host === c.host!.host && h.username === user) : [];

/** Script-local helper: reload sshd on any init system. */
const RELOAD_SSH = String.raw`reload_ssh() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active ssh.socket >/dev/null 2>&1; then systemctl daemon-reload; systemctl restart ssh.socket; fi
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || systemctl restart ssh 2>/dev/null || systemctl restart sshd
  elif command -v rc-service >/dev/null 2>&1; then rc-service sshd reload
  else service ssh reload 2>/dev/null || service sshd reload; fi
}`;

/** Script-local helper: open a TCP port in whichever firewall is active. */
const OPEN_PORT = String.raw`open_port() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then ufw allow "$1/tcp"; fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then firewall-cmd --permanent --add-port="$1/tcp" && firewall-cmd --reload; fi
}`;

function upgradeCmd(e: RemoteEnv): string {
  switch (e.pkg) {
    case "apt-get":
      return "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade";
    case "dnf":
      return "dnf -y upgrade";
    case "yum":
      return "yum -y update";
    case "apk":
      return "apk update && apk upgrade";
    case "pacman":
      return "pacman -Syu --noconfirm";
    case "zypper":
      return "zypper -n refresh && zypper -n update";
    default:
      return "";
  }
}

function cleanCmd(e: RemoteEnv): string {
  switch (e.pkg) {
    case "apt-get":
      return "apt-get -y autoremove && apt-get clean";
    case "dnf":
      return "dnf -y autoremove && dnf clean all";
    case "yum":
      return "yum clean all";
    case "apk":
      return "rm -rf /var/cache/apk/*";
    case "pacman":
      return "pacman -Sc --noconfirm";
    case "zypper":
      return "zypper clean --all";
    default:
      return "";
  }
}

const MIRRORS = [
  { value: "mirrors.aliyun.com", label: "阿里云" },
  { value: "mirrors.tuna.tsinghua.edu.cn", label: "清华 TUNA" },
  { value: "mirrors.ustc.edu.cn", label: "中科大" },
  { value: "mirrors.cloud.tencent.com", label: "腾讯云" },
  { value: "repo.huaweicloud.com", label: "华为云" },
  { value: "official", label: "官方源" },
];
const MIRROR_HOSTS = String.raw`(deb\.debian\.org|security\.debian\.org|([a-z]{2}\.)?archive\.ubuntu\.com|security\.ubuntu\.com|ports\.ubuntu\.com|mirrors\.aliyun\.com|mirrors\.tuna\.tsinghua\.edu\.cn|mirrors\.ustc\.edu\.cn|mirrors\.cloud\.tencent\.com|repo\.huaweicloud\.com)`;

/** Host a mirror choice resolves to ("official" depends on the distro). */
function mirrorHost(m: string, e: RemoteEnv): string {
  if (m !== "official") return m;
  return e.pkg === "apk" ? "dl-cdn.alpinelinux.org" : isLike(e, "ubuntu") ? "archive.ubuntu.com" : "deb.debian.org";
}

const TIMEZONES = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Asia/Singapore", "UTC", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles"];

const DNS_PRESETS = [
  { value: "223.5.5.5 119.29.29.29", label: "阿里 + 腾讯" },
  { value: "1.1.1.1 1.0.0.1", label: "Cloudflare" },
  { value: "8.8.8.8 8.8.4.4", label: "Google" },
  { value: "custom", label: "自定义" },
];

const dnsList = (v: Values) => (v.preset === "custom" ? str(v, "custom") : str(v, "preset")).split(/[\s,，]+/).filter(Boolean);

const TOOL_PKGS = ["curl", "wget", "git", "vim", "htop", "unzip", "tmux", "jq", "lsof", "rsync", "net-tools"];

/** A sysctl switch persisted in its own /etc/sysctl.d file. */
function sysctlTool(o: {
  id: string;
  group: string;
  label: string;
  check: string;
  keys: [string, string, string][];
  file: string;
  note: string;
  issues?: (r: R, v: Values) => Issue[];
}): Tool {
  const base = (f: string) => f.slice(f.lastIndexOf("/") + 1);
  const keyRe = o.keys[0][0].replace(/\./g, "\\.");
  return {
    id: o.id,
    group: o.group,
    label: o.label,
    risk: "change",
    note: o.note,
    probe: () => `echo "on=$(sysctl -n ${o.keys[0][0]} 2>/dev/null)"`,
    fields: (c) => [{ key: "on", label: o.check, type: "check", def: c.cur.on === o.keys[0][1] }],
    build: (v, c) => {
      const on = !!v.on;
      if (on === (c.cur.on === o.keys[0][1])) return null;
      const lines = o.keys.map(([k, onV, offV]) => `${k}=${on ? onV : offV}`).join("\\n");
      return { script: `printf '${lines}\\n' > ${o.file}\nsysctl -p ${o.file}` };
    },
    check: {
      script: () =>
        sh(
          `for f in /etc/sysctl.conf /etc/sysctl.d/*.conf /run/sysctl.d/*.conf /usr/lib/sysctl.d/*.conf; do [ "$f" = ${o.file} ] && continue; grep -qsE '^[[:space:]]*${keyRe}[[:space:]]*=' "$f" && echo "other=$f"; done`,
          VIRT,
          "command -v docker >/dev/null 2>&1 && echo docker=1",
        ),
      issues: (r, v) => {
        const out: Issue[] = [];
        // sysctl --system applies files by name with /etc/sysctl.conf last, so later ones win at boot.
        for (const f of listOf(r.other).filter((f) => f === "/etc/sysctl.conf" || base(f) > base(o.file)))
          out.push({ level: "warn", text: `${f} 也设置了该项，重启后可能被覆盖` });
        if (inContainer(r)) out.push({ level: "warn", text: `容器（${r.virt}）内通常无权修改内核参数` });
        return [...out, ...(o.issues?.(r, v) ?? [])];
      },
    },
  };
}

export const TOOLS: Tool[] = [
  // ---------- 系统 ----------
  {
    id: "upgrade",
    group: "系统",
    label: "系统更新",
    when: (e) => !!e.pkg,
    meta: (e) => e.pkg ?? "",
    risk: "change",
    note: "内核更新后需要重启",
    term: true,
    build: (_, c) => ({ script: upgradeCmd(c.env) }),
    check: {
      script: () => sh(PKG_BUSY, DISK_FREE, "[ -f /var/run/reboot-required ] && echo reboot=1"),
      issues: (r) => [
        ...busyIssue(r),
        ...diskIssue(r, 1024),
        ...(r.reboot ? [{ level: "warn", text: "上次更新后尚未重启" } as Issue] : []),
      ],
    },
  },
  {
    id: "hostname",
    group: "系统",
    label: "主机名",
    risk: "change",
    note: "修改主机名并同步 /etc/hosts",
    probe: () => `echo "name=$(hostname)"`,
    fields: (c) => [{ key: "name", label: "主机名", type: "text", def: c.cur.name ?? "", placeholder: "web-01" }],
    build: (v, c) => {
      const n = str(v, "name");
      if (!n || n === c.cur.name) return null;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/.test(n)) return "主机名只能包含字母、数字、点和横线";
      return {
        script: [
          `N=${shq(n)}; O=$(hostname)`,
          `if command -v hostnamectl >/dev/null 2>&1; then hostnamectl set-hostname "$N"; else echo "$N" > /etc/hostname; hostname "$N"; fi`,
          // Never rewrite "localhost" entries when the old name is localhost.
          `if [ "$O" != localhost ] && grep -qw "$O" /etc/hosts; then sed -i "s/\\b$O\\b/$N/g" /etc/hosts; else echo "127.0.1.1 $N" >> /etc/hosts; fi`,
          `echo "主机名: $(hostname)"`,
        ].join("\n"),
      };
    },
    check: {
      script: (v) =>
        sh(
          `N=${shq(str(v, "name"))}; O=$(hostname)`,
          'echo hosts=$(grep -cw "$O" /etc/hosts)',
          'grep -qw "$N" /etc/hosts && echo taken=1',
          "[ -f /etc/cloud/cloud.cfg ] && ! grep -rqsE '^preserve_hostname:[[:space:]]*true' /etc/cloud/cloud.cfg /etc/cloud/cloud.cfg.d && echo cloud=1",
        ),
      issues: (r, v, c) => {
        const out: Issue[] = [];
        if (r.taken) out.push({ level: "warn", text: `/etc/hosts 中已有 ${str(v, "name")} 的记录` });
        else if (Number(r.hosts) > 0 && c.cur.name !== "localhost") out.push({ level: "ok", text: `将替换 /etc/hosts 中 ${r.hosts} 处旧名称` });
        if (r.cloud) out.push({ level: "warn", text: "cloud-init 可能在重启后改回主机名" });
        return out;
      },
    },
  },
  {
    id: "timezone",
    group: "系统",
    label: "时区与时间",
    risk: "change",
    note: "定时任务按新时区执行",
    probe: () =>
      `echo "tz=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || readlink /etc/localtime | sed 's#.*/zoneinfo/##')"; echo "now=$(date '+%F %T %Z')"`,
    current: (cur) => (cur.now ? `服务器时间：${cur.now}` : ""),
    fields: (c) => {
      const tz = c.cur.tz || "UTC";
      const list = TIMEZONES.includes(tz) ? TIMEZONES : [tz, ...TIMEZONES];
      const f: FieldDef[] = [{ key: "tz", label: "时区", type: "select", def: tz, options: list.map((t) => ({ value: t, label: t })) }];
      if (c.env.systemd) f.push({ key: "ntp", label: "自动校时", type: "check", def: true });
      return f;
    },
    build: (v, c) => {
      const tz = str(v, "tz");
      if (!/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(tz)) return "时区格式不正确";
      const s = [
        `if command -v timedatectl >/dev/null 2>&1; then timedatectl set-timezone ${tz}; else ln -sf /usr/share/zoneinfo/${tz} /etc/localtime && echo ${tz} > /etc/timezone; fi`,
      ];
      if (c.env.systemd && v.ntp) s.push(`timedatectl set-ntp true 2>/dev/null || echo "未安装 NTP 服务，跳过自动校时"`);
      s.push("date");
      return { script: s.join("\n") };
    },
    check: {
      script: (v) =>
        sh(
          `[ -e /usr/share/zoneinfo/${str(v, "tz")} ] || echo nozone=1`,
          "command -v timedatectl >/dev/null 2>&1 && echo ntp=$(timedatectl show -p CanNTP --value 2>/dev/null)",
        ),
      issues: (r, v) => {
        const out: Issue[] = [];
        if (r.nozone) out.push({ level: "err", text: "缺少时区数据，请先安装 tzdata" });
        if (v.ntp && r.ntp === "no") out.push({ level: "warn", text: "未安装 NTP 服务，自动校时会跳过" });
        return out;
      },
    },
  },
  {
    id: "swap",
    group: "系统",
    label: "Swap",
    risk: "change",
    note: "会先删除现有 /swapfile",
    probe: () => `free -m | awk '/^Swap:/{print "swap="$2}'; [ -f /swapfile ] && echo file=1; true`,
    fields: (c) => [{ key: "mb", label: "大小 (MB)", type: "number", def: c.cur.file ? c.cur.swap : "2048", placeholder: "2048" }],
    build: (v) => {
      const mb = str(v, "mb");
      if (!/^\d+$/.test(mb)) return "请输入整数 MB";
      const s = [
        "if [ -f /swapfile ]; then swapoff /swapfile 2>/dev/null; rm -f /swapfile; fi",
        "sed -i '\\#^/swapfile[[:space:]]#d' /etc/fstab",
      ];
      if (+mb > 0)
        s.push(
          `fallocate -l ${mb}M /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=${mb} status=none`,
          "chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile",
          "echo '/swapfile none swap sw 0 0' >> /etc/fstab",
        );
      s.push("free -m");
      return { script: s.join("\n") };
    },
    check: {
      script: () =>
        sh(
          DISK_FREE,
          `free -m | awk '/^Mem:/{print "avail="$NF} /^Swap:/{print "used="$3}'`,
          "[ -f /swapfile ] && echo cursize=$(( $(stat -c %s /swapfile) / 1048576 ))",
          "echo fs=$(stat -f -c %T / 2>/dev/null)",
          VIRT,
        ),
      issues: (r, v, c) => {
        const mb = Number(str(v, "mb"));
        const out: Issue[] = [];
        if (mb > 0 && inContainer(r)) out.push({ level: "err", text: `容器（${r.virt}）内无法启用 swap` });
        if (mb > 0 && r.free) {
          const need = mb - Number(r.cursize ?? 0);
          if (Number(r.free) - need < 512) out.push({ level: "err", text: `磁盘空间不足：需要 ${need} MB，可用 ${r.free} MB` });
        }
        const used = Number(r.used ?? 0);
        if (c.cur.file && used > 0) {
          if (r.avail && used > Number(r.avail)) out.push({ level: "err", text: `swap 已用 ${used} MB，超过可用内存，无法关闭` });
          else out.push({ level: "warn", text: `swap 已用 ${used} MB，关闭时会移回内存` });
        }
        if (mb > 0 && r.fs === "btrfs") out.push({ level: "warn", text: "btrfs 上创建 swapfile 可能失败" });
        if (mb === 0 && !c.cur.file) out.push({ level: "warn", text: "当前没有 /swapfile" });
        return out;
      },
    },
    timeout: 300,
  },
  {
    id: "mirror",
    group: "系统",
    label: "软件源",
    when: (e) => (e.pkg === "apt-get" && isLike(e, "debian", "ubuntu")) || e.pkg === "apk",
    risk: "change",
    note: "原文件备份在 /etc/apt/.myshell-bak",
    probe: (e) =>
      e.pkg === "apk"
        ? `echo "cur=$(grep -oE '//[^/]+' /etc/apk/repositories | sort -u | tr -d / | tr '\\n' ' ')"`
        : `echo "cur=$(cat /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null | grep -v '^#' | grep -oE 'https?://[^/ ]+' | sed 's#.*//##' | sort -u | tr '\\n' ' ')"`,
    current: (cur) => (cur.cur ? `当前：${cur.cur}` : ""),
    fields: (c) => [{ key: "mirror", label: c.cur.cur ? "切换到" : "镜像", type: "select", def: "mirrors.aliyun.com", options: MIRRORS }],
    build: (v, c) => {
      const m = str(v, "mirror");
      if (c.env.pkg === "apk") {
        const host = m === "official" ? "dl-cdn.alpinelinux.org" : m;
        return {
          script: [
            "S=http; [ -s /etc/ssl/certs/ca-certificates.crt ] && S=https",
            "cp -p /etc/apk/repositories /etc/apk/repositories.myshell.bak",
            `sed -i -E "s#https?://[^/]+/alpine#$S://${host}/alpine#g" /etc/apk/repositories`,
            "cat /etc/apk/repositories",
            "apk update",
          ].join("\n"),
        };
      }
      const ubuntu = isLike(c.env, "ubuntu");
      const host = m === "official" ? (ubuntu ? "archive.ubuntu.com" : "deb.debian.org") : m;
      const s = [
        `H='${MIRROR_HOSTS}'`,
        m === "official" ? "S=http" : "S=http; [ -s /etc/ssl/certs/ca-certificates.crt ] && S=https",
        "B=/etc/apt/.myshell-bak; mkdir -p $B",
        "for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do",
        '  [ -f "$f" ] || continue',
        '  [ -f "$B/$(basename "$f")" ] || cp -p "$f" "$B/"',
        `  sed -i -E "s#https?://$H/#$S://${host}/#g" "$f"`,
      ];
      if (m === "official" && ubuntu) s.push(`  sed -i -E 's#://archive\\.ubuntu\\.com/ubuntu-ports#://ports.ubuntu.com/ubuntu-ports#g' "$f"`);
      s.push("done", "apt-get update");
      return { script: s.join("\n") };
    },
    check: {
      script: (v, c) => sh(REACH(`http://${mirrorHost(str(v, "mirror"), c.env)}/`), PKG_BUSY),
      issues: (r, v, c) => {
        const host = mirrorHost(str(v, "mirror"), c.env);
        const out: Issue[] = busyIssue(r);
        if (!r.reach) out.push({ level: "warn", text: `无法连接 ${host}，切换后更新可能失败` });
        if (listOf(c.cur.cur).includes(host)) out.push({ level: "ok", text: "当前已使用该源" });
        return out;
      },
    },
    timeout: 300,
  },
  {
    id: "bbr",
    group: "系统",
    label: "BBR 加速",
    when: (e) => kernelAtLeast(e, 4, 9),
    risk: "change",
    note: "立即生效",
    probe: () => `echo "cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)"`,
    fields: (c) => [{ key: "on", label: "启用 BBR", type: "check", def: c.cur.cc === "bbr" }],
    build: (v, c) => {
      if (!!v.on === (c.cur.cc === "bbr")) return null;
      const f = "/etc/sysctl.d/99-myshell-bbr.conf";
      return {
        script: v.on
          ? `modprobe tcp_bbr 2>/dev/null || true\nprintf 'net.core.default_qdisc=fq\\nnet.ipv4.tcp_congestion_control=bbr\\n' > ${f}\nsysctl -p ${f}`
          : `rm -f ${f}\nsysctl -w net.ipv4.tcp_congestion_control=cubic`,
      };
    },
    check: {
      script: (v) =>
        v.on
          ? sh(
              "grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null && echo avail=1",
              "modinfo tcp_bbr >/dev/null 2>&1 && echo mod=1",
              VIRT,
            )
          : null,
      issues: (r, v) => {
        if (!v.on) return [];
        const out: Issue[] = [];
        if (!r.avail && !r.mod) out.push({ level: "err", text: "内核没有 tcp_bbr 模块" });
        if (inContainer(r)) out.push({ level: "warn", text: `容器（${r.virt}）内通常需在宿主机设置` });
        return out;
      },
    },
  },
  {
    id: "selinux",
    group: "系统",
    label: "SELinux",
    when: (e) => !!e.selinux,
    meta: (e) => e.selinux ?? "",
    risk: "change",
    note: "改为 Disabled 需重启生效",
    probe: () => `echo "mode=$(getenforce)"`,
    fields: (c) => [
      {
        key: "mode",
        label: "模式",
        type: "select",
        def: c.cur.mode || "Enforcing",
        options: ["Enforcing", "Permissive", "Disabled"].map((m) => ({ value: m, label: m })),
      },
    ],
    build: (v, c) => {
      const m = str(v, "mode");
      if (m === c.cur.mode) return null;
      const s = [`sed -i 's/^SELINUX=.*/SELINUX=${m.toLowerCase()}/' /etc/selinux/config`];
      if (c.cur.mode !== "Disabled" && m !== "Disabled") s.push(`setenforce ${m === "Enforcing" ? 1 : 0}`);
      if (m === "Disabled" && c.cur.mode !== "Disabled") s.push("setenforce 0");
      s.push("getenforce");
      return { script: s.join("\n") };
    },
    check: {
      issues: (_, v, c) => {
        const m = str(v, "mode");
        if (m === "Disabled") return [{ level: "warn", text: "需重启生效；以后重新启用要重新标记全部文件" }];
        if (c.cur.mode === "Disabled") return [{ level: "warn", text: "需重启生效，首次启动会重新标记文件，耗时较长" }];
        return [];
      },
    },
  },
  {
    id: "reboot",
    group: "系统",
    label: "重启服务器",
    risk: "high",
    note: "所有连接和正在运行的任务会中断",
    build: () => ({ script: `echo "2 秒后重启"\nnohup sh -c 'sleep 2; reboot' >/dev/null 2>&1 &` }),
    check: {
      script: () =>
        sh(
          PKG_BUSY,
          "echo who=$(who | wc -l)",
          "command -v docker >/dev/null 2>&1 && echo ctr=$(docker ps -q 2>/dev/null | wc -l)",
          "[ -f /var/run/reboot-required ] && echo req=1",
        ),
      issues: (r) => {
        const out: Issue[] = [];
        if (r.busy) out.push({ level: "err", text: `${r.busy} 正在运行，重启可能损坏软件包` });
        if (Number(r.who) > 0) out.push({ level: "warn", text: `${r.who} 个登录会话会断开` });
        if (Number(r.ctr) > 0) out.push({ level: "warn", text: `${r.ctr} 个容器在运行，未设自动重启的不会恢复` });
        if (r.req) out.push({ level: "ok", text: "系统更新要求重启" });
        return out;
      },
    },
  },

  // ---------- 用户 ----------
  { id: "adduser", group: "用户", label: "添加用户", risk: "change", custom: "adduser" },
  {
    id: "passwd",
    group: "用户",
    label: "修改密码",
    risk: (v, c) => (str(v, "user") === c.env.user || str(v, "user") === c.host?.username ? "high" : "change"),
    note: (v, c) =>
      str(v, "user") === c.host?.username && c.host?.authType === "password" ? "当前登录账号，需同步更新保存的密码" : "",
    fields: (c) => [
      { key: "user", label: "用户", type: "text", def: c.env.user || "root", placeholder: "root" },
      { key: "pw", label: "新密码", type: "secret", gen: true },
    ],
    build: (v) => {
      const u = str(v, "user");
      const pw = String(v.pw ?? "");
      if (!u || !pw) return null;
      if (!USER_RE.test(u) && u !== "root") return "用户名格式不正确";
      if (pw.includes("\n") || pw.includes(":")) return "密码不能包含冒号或换行";
      return { script: `id ${u} >/dev/null || exit 1\nchpasswd && echo "已修改 ${u} 的密码"`, stdin: `${u}:${pw}\n` };
    },
    check: {
      script: (v) => sh(`id ${str(v, "user")} >/dev/null 2>&1 && echo exists=1`),
      issues: (r, v) => {
        const out: Issue[] = [];
        if (!r.exists) out.push({ level: "err", text: `用户 ${str(v, "user")} 不存在` });
        if (String(v.pw ?? "").length < 8) out.push({ level: "warn", text: "密码少于 8 位" });
        return out;
      },
    },
  },
  {
    id: "users",
    group: "用户",
    label: "用户列表",
    risk: "read",
    priv: false,
    build: () => ({
      script: String.raw`printf '%-16s %-6s %-6s %s\n' 用户 UID 管理员 Shell
awk -F: '($3==0||$3>=1000)&&$1!="nobody"{print $1, $3, $7}' /etc/passwd | while read u id sh; do
  g=$(id -nG "$u" 2>/dev/null | tr ' ' '\n' | grep -Ex 'sudo|wheel|admin' | head -1)
  printf '%-16s %-6s %-6s %s\n' "$u" "$id" "$([ -n "$g" ] || [ "$id" = 0 ] && echo 是)" "$sh"
done`,
    }),
  },
  {
    id: "deluser",
    group: "用户",
    label: "删除用户",
    risk: "high",
    note: "勾选后会删除家目录全部文件",
    fields: () => [
      { key: "user", label: "用户", type: "text", placeholder: "deploy" },
      { key: "home", label: "删除家目录", type: "check", def: false },
    ],
    build: (v, c) => {
      const u = str(v, "user");
      if (!u) return null;
      if (!USER_RE.test(u)) return "用户名格式不正确";
      if (u === "root" || u === c.env.user || u === c.host?.username) return "不能删除 root 或当前登录用户";
      const s = [`H=$(getent passwd ${u} | cut -d: -f6); [ -n "$H" ] || { echo "用户 ${u} 不存在" >&2; exit 1; }`];
      s.push(`if command -v userdel >/dev/null 2>&1; then userdel ${u}; else deluser ${u}; fi`);
      s.push(`rm -f /etc/sudoers.d/${u}`);
      if (v.home) s.push(`case "$H" in /home/?*) rm -rf "$H";; esac`);
      s.push(`echo "已删除 ${u}"`);
      return { script: s.join("\n") };
    },
    check: {
      script: (v) =>
        sh(
          `U=${str(v, "user")}`,
          'if id "$U" >/dev/null 2>&1; then',
          "  echo exists=1; echo procs=$(pgrep -u \"$U\" 2>/dev/null | wc -l)",
          '  H=$(getent passwd "$U" | cut -d: -f6); echo "home=$H"; [ -d "$H" ] && echo size=$(du -sh "$H" 2>/dev/null | cut -f1)',
          '  crontab -l -u "$U" >/dev/null 2>&1 && echo cron=1',
          "  id -nG \"$U\" | grep -qwE 'sudo|wheel|admin' && echo admin=1",
          "fi",
        ),
      issues: (r, v, c) => {
        const u = str(v, "user");
        if (!r.exists) return [{ level: "err", text: `用户 ${u} 不存在` }];
        const out: Issue[] = [];
        if (Number(r.procs) > 0) out.push({ level: "err", text: `${u} 有 ${r.procs} 个进程在运行，需先结束` });
        if (r.admin) out.push({ level: "warn", text: `${u} 是管理员` });
        if (r.cron) out.push({ level: "warn", text: "该用户的定时任务将失效" });
        if (v.home) {
          if (/^\/home\/./.test(r.home ?? "")) out.push({ level: "warn", text: `将删除 ${r.home}${r.size ? `（${r.size}）` : ""}` });
          else out.push({ level: "warn", text: `家目录 ${r.home || "未知"} 不在 /home 下，不会删除` });
        }
        for (const h of appHostsFor(c, u)) out.push({ level: "warn", text: `服务器「${h.name}」使用此账号` });
        return out;
      },
    },
  },

  // ---------- SSH ----------
  {
    id: "sshd",
    group: "SSH",
    label: "SSH 设置",
    risk: "high",
    note: (v, c) =>
      !v.pass && c.cur.passwordauthentication === "yes" && c.host?.authType === "password"
        ? "当前用密码登录，关闭密码登录后将无法连接"
        : "配置有误可能无法登录；校验失败会自动还原",
    probePriv: true,
    probe: () =>
      `S=$(command -v sshd || echo /usr/sbin/sshd); $S -T 2>/dev/null | awk '$1=="port"||$1=="permitrootlogin"||$1=="passwordauthentication"{print $1"="$2}'`,
    fields: (c) => [
      { key: "port", label: "端口", type: "text", def: c.cur.port ?? "22", placeholder: "22" },
      {
        key: "root",
        label: "root 登录",
        type: "select",
        def: c.cur.permitrootlogin === "without-password" ? "prohibit-password" : (c.cur.permitrootlogin ?? "prohibit-password"),
        options: [
          { value: "yes", label: "允许" },
          { value: "prohibit-password", label: "仅密钥" },
          { value: "no", label: "禁止" },
        ],
      },
      { key: "pass", label: "密码登录", type: "check", def: c.cur.passwordauthentication !== "no" },
    ],
    build: (v, c) => {
      if (!c.cur.port) return "读取 sshd 配置失败";
      const port = str(v, "port");
      const curRoot = c.cur.permitrootlogin === "without-password" ? "prohibit-password" : c.cur.permitrootlogin;
      const set: [string, string][] = [];
      if (port !== c.cur.port) {
        if (!validPort(port)) return "端口应为 1-65535";
        set.push(["Port", port]);
      }
      if (str(v, "root") !== curRoot) set.push(["PermitRootLogin", str(v, "root")]);
      if (!!v.pass !== (c.cur.passwordauthentication !== "no")) set.push(["PasswordAuthentication", v.pass ? "yes" : "no"]);
      if (!set.length) return null;
      const s = [
        RELOAD_SSH,
        OPEN_PORT,
        "C=/etc/ssh/sshd_config; D=/etc/ssh/sshd_config.d",
        `if grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d' "$C" && [ -d "$D" ]; then F="$D/00-myshell.conf"; else F="$C"; fi`,
        '[ -e "$F" ] || touch "$F"; B=$(mktemp); cp -p "$F" "$B"',
        // Drop the option outside Match blocks, then put the new value first (sshd uses the first value it sees).
        `set_opt() { T=$(mktemp); { echo "$1 $2"; awk -v k="$1" '/^[[:space:]]*Match[[:space:]]/{m=1} m||tolower($1)!=tolower(k){print}' "$F"; } > "$T"; cat "$T" > "$F"; rm -f "$T"; }`,
        ...set.map(([k, val]) => `set_opt ${k} ${val}`),
        `if ! $(command -v sshd || echo /usr/sbin/sshd) -t; then cat "$B" > "$F"; rm -f "$B"; echo "配置校验失败，已还原" >&2; exit 1; fi`,
        'rm -f "$B"',
      ];
      if (set.some(([k]) => k === "Port")) {
        s.push(`open_port ${port}`);
        s.push(
          `if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Enforcing ] && command -v semanage >/dev/null 2>&1; then semanage port -a -t ssh_port_t -p tcp ${port} 2>/dev/null || semanage port -m -t ssh_port_t -p tcp ${port}; fi`,
        );
      }
      s.push("reload_ssh", `echo "已生效: ${set.map(([k, val]) => `${k} ${val}`).join(", ")}"`);
      return { script: s.join("\n") };
    },
    // Keep the saved server entry reachable after a port change.
    after: async (v, c) => {
      const port = Number(str(v, "port"));
      const h = c.host;
      if (!h || port === h.port || String(h.port) !== c.cur.port) return;
      await api.hostSave({ ...h, port });
      await useApp.getState().refreshHosts();
      return `已将「${h.name}」的连接端口改为 ${port}`;
    },
    check: {
      script: (v, c) => {
        const port = str(v, "port");
        if (port === c.cur.port) return null;
        return sh(
          `P=${port}`,
          `L=$(ss -ltnp 2>/dev/null | awk -v p=":$P" 'NR>1 && substr($4, length($4)-length(p)+1)==p')`,
          `[ -n "$L" ] && echo "inuse=$(echo "$L" | grep -oE '"[^"]+"' | head -1 | tr -d '"')"`,
          "command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active' && echo fw=ufw",
          "command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1 && echo fw=firewalld",
          `command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Enforcing ] && ! command -v semanage >/dev/null 2>&1 && echo nosemanage=1`,
        );
      },
      issues: (r, v, c) => {
        const out: Issue[] = [];
        const port = str(v, "port");
        const pwLogin = c.host?.authType === "password";
        if (port !== c.cur.port) {
          if ("inuse" in r && r.inuse !== "sshd") out.push({ level: "err", text: `端口 ${port} 已被${r.inuse ? ` ${r.inuse} ` : ""}占用` });
          if (r.nosemanage) out.push({ level: "err", text: "SELinux 已启用但缺少 semanage，无法使用新端口" });
          if (r.fw) out.push({ level: "ok", text: `将在 ${r.fw} 放行 ${port}` });
          out.push({ level: "warn", text: `云服务器还需在安全组放行 ${port}` });
        }
        if (!v.pass && c.cur.passwordauthentication !== "no" && pwLogin)
          out.push({ level: "err", text: "当前用密码登录，关闭后将无法连接" });
        if (c.host?.username === "root") {
          if (v.root === "no") out.push({ level: "err", text: "当前以 root 登录，禁止后将无法连接" });
          else if (v.root === "prohibit-password" && pwLogin) out.push({ level: "err", text: "当前 root 用密码登录，改为仅密钥后将无法连接" });
        }
        return out;
      },
    },
  },
  {
    id: "logins",
    group: "SSH",
    label: "登录记录",
    risk: "read",
    priv: true,
    build: () => ({
      script: String.raw`echo "== 最近登录 =="
last -a -n 15 2>/dev/null | grep -v '^$' | head -n 15 || echo "无记录"
echo; echo "== 失败次数最多的 IP（近期） =="
L=$(cat /var/log/auth.log /var/log/secure 2>/dev/null)
[ -n "$L" ] || L=$(journalctl -u ssh -u sshd --since '7 days ago' --no-pager 2>/dev/null)
echo "$L" | grep -E 'Failed password|Invalid user' | grep -oE 'from [0-9a-fA-F.:]+' | awk '{print $2}' | sort | uniq -c | sort -rn | head -10`,
    }),
  },
  {
    id: "conns",
    group: "SSH",
    label: "当前连接",
    risk: "read",
    priv: false,
    build: () => ({
      script: String.raw`echo "== 登录会话 =="; who
echo; echo "== 连接数最多的 IP =="
ss -tn state established 2>/dev/null | awk 'NR>1{p=$4; sub(/:[0-9]+$/,"",p); gsub(/^\[|\]$/,"",p); print p}' | sort | uniq -c | sort -rn | head -15`,
    }),
  },
  {
    id: "fail2ban",
    group: "SSH",
    label: "Fail2ban 防爆破",
    when: (e) => !!e.pkg,
    risk: "change",
    note: "多次登录失败的 IP 会被封禁",
    timeout: 600,
    probe: () => `command -v fail2ban-client >/dev/null 2>&1 && echo installed=1; true`,
    fields: () => [
      { key: "retry", label: "失败次数", type: "number", def: "5" },
      {
        key: "ban",
        label: "封禁时长",
        type: "select",
        def: "1h",
        options: [
          { value: "1h", label: "1 小时" },
          { value: "1d", label: "1 天" },
          { value: "1w", label: "1 周" },
        ],
      },
    ],
    build: (v, c) => {
      const retry = str(v, "retry");
      if (!/^\d{1,3}$/.test(retry) || +retry < 1) return "失败次数应为正整数";
      const e = c.env;
      const pkgs = e.pkg === "apt-get" ? ["fail2ban", "python3-systemd"] : ["fail2ban"];
      const s: string[] = [];
      if (!c.cur.installed) {
        if (e.pkg === "dnf" || e.pkg === "yum") s.push(`${e.pkg} install -y epel-release 2>/dev/null || true`);
        s.push(pkgInstall(e, pkgs) + " || exit 1");
      }
      s.push(
        "B=auto; [ -f /var/log/auth.log ] || [ -f /var/log/secure ] || B=systemd",
        "mkdir -p /etc/fail2ban/jail.d",
        `printf '[sshd]\\nenabled = true\\nport = ${c.host?.port ?? 22}\\nmaxretry = ${retry}\\nfindtime = 10m\\nbantime = ${str(v, "ban")}\\nbackend = %s\\n' "$B" > /etc/fail2ban/jail.d/myshell.local`,
        "if command -v systemctl >/dev/null 2>&1; then systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban; else rc-update add fail2ban 2>/dev/null; rc-service fail2ban restart; fi",
        "sleep 2; fail2ban-client status sshd",
      );
      return { script: s.join("\n") };
    },
    check: {
      script: () => sh(PKG_BUSY, DISK_FREE, "[ -f /etc/fail2ban/jail.d/myshell.local ] && echo cfg=1"),
      issues: (r, v, c) => {
        const out: Issue[] = c.cur.installed ? [] : [...busyIssue(r), ...diskIssue(r, 200)];
        if (c.cur.installed) out.push({ level: "ok", text: "已安装，只更新配置" });
        if (r.cfg) out.push({ level: "warn", text: "将覆盖之前的 jail.d/myshell.local" });
        if (Number(str(v, "retry")) < 3) out.push({ level: "warn", text: "失败次数过低，输错几次密码也会被封" });
        return out;
      },
    },
  },

  // ---------- 网络 ----------
  {
    id: "ports",
    group: "网络",
    label: "端口监听",
    risk: "read",
    priv: true,
    build: () => ({ script: "ss -tulnp 2>/dev/null || netstat -tulnp" }),
  },
  {
    id: "firewall",
    group: "网络",
    label: "防火墙",
    when: (e) => !!e.firewall,
    meta: (e) => e.firewall ?? "",
    risk: (v) => (v.action === "enable" ? "high" : v.action === "status" ? "read" : "change"),
    note: (v, c) => (v.action === "enable" ? `启用前会先放行当前 SSH 端口 ${c.host?.port ?? 22}` : "立即生效"),
    probePriv: true,
    probe: (e) =>
      e.firewall === "ufw"
        ? `echo "state=$(ufw status | head -1 | awk '{print $2}')"`
        : `echo "state=$(firewall-cmd --state 2>/dev/null || echo inactive)"`,
    current: (cur) => (cur.state ? `状态：${cur.state}` : ""),
    fields: (_, v) => {
      const f: FieldDef[] = [
        {
          key: "action",
          label: "操作",
          type: "select",
          def: "status",
          options: [
            { value: "status", label: "查看规则" },
            { value: "allow", label: "放行端口" },
            { value: "remove", label: "取消放行" },
            { value: "enable", label: "启用防火墙" },
            { value: "disable", label: "停用防火墙" },
          ],
        },
      ];
      if (v.action === "allow" || v.action === "remove")
        f.push(
          { key: "port", label: "端口", type: "text", placeholder: "8080 或 8000:8100" },
          {
            key: "proto",
            label: "协议",
            type: "select",
            def: "tcp",
            options: [
              { value: "tcp", label: "TCP" },
              { value: "udp", label: "UDP" },
              { value: "both", label: "TCP + UDP" },
            ],
          },
        );
      return f;
    },
    build: (v, c) => {
      const a = str(v, "action") || "status";
      const ufw = c.env.firewall === "ufw";
      const ssh = c.host?.port ?? 22;
      const show = ufw ? "ufw status numbered" : "firewall-cmd --list-ports; firewall-cmd --list-services";
      if (a === "status") return { script: show };
      if (a === "enable")
        return {
          script: ufw
            ? `ufw allow ${ssh}/tcp\nufw --force enable\n${show}`
            : `systemctl enable --now firewalld\nfirewall-cmd --permanent --add-port=${ssh}/tcp\nfirewall-cmd --reload\n${show}`,
        };
      if (a === "disable") return { script: ufw ? "ufw disable" : "systemctl disable --now firewalld" };
      const port = str(v, "port");
      if (!port) return null;
      if (!/^\d{1,5}([:-]\d{1,5})?$/.test(port)) return "端口格式：8080 或 8000:8100";
      const protos = v.proto === "both" ? ["tcp", "udp"] : [str(v, "proto") || "tcp"];
      const rm = a === "remove";
      const lines = protos.map((p) =>
        ufw
          ? `ufw ${rm ? "delete " : ""}allow ${port.replace("-", ":")}/${p}`
          : `firewall-cmd --permanent --${rm ? "remove" : "add"}-port=${port.replace(":", "-")}/${p}`,
      );
      if (!ufw) lines.push("firewall-cmd --reload");
      lines.push(show);
      return { script: lines.join("\n") };
    },
    check: {
      script: (v, c) => {
        const a = str(v, "action");
        if (a === "enable")
          return sh(
            "echo listen=$(ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | grep -vE '^(127\\.|\\[::1\\]|::1:)' | sed 's/.*://' | sort -un | tr '\\n' ' ')",
            c.env.firewall === "ufw"
              ? "echo allowed=$(ufw show added 2>/dev/null | grep -oE '(^| )[0-9]+(:[0-9]+)?(/tcp)?( |$)' | tr -d ' /tcp' | tr '\\n' ' ')"
              : [
                  `F="firewall-cmd --permanent"; firewall-cmd --state >/dev/null 2>&1 || F=firewall-offline-cmd`,
                  "echo allowed=$( { $F --list-ports; for s in $($F --list-services); do $F --service=$s --get-ports; done; } 2>/dev/null | tr ' ' '\\n' | grep /tcp | sed 's#/tcp##; s/-/:/' | tr '\\n' ' ')",
                ].join("\n"),
          );
        const port = str(v, "port");
        if (a === "allow" && /^\d+$/.test(port)) return sh(`ss -ltnu 2>/dev/null | awk 'NR>1{print $5}' | grep -qE ':${port}$' && echo listen=1`);
        return null;
      },
      issues: (r, v, c) => {
        const a = str(v, "action");
        const port = str(v, "port");
        const ssh = c.host?.port ?? 22;
        const active = c.cur.state === "active" || c.cur.state === "running";
        if (a === "enable") {
          const ranges = listOf(r.allowed).map((x) => x.split(":").map(Number));
          const blocked = listOf(r.listen)
            .map(Number)
            .filter((p) => p !== ssh && !ranges.some(([lo, hi]) => p >= lo && p <= (hi ?? lo)));
          if (!blocked.length) return [];
          const shown = blocked.slice(0, 8).join(", ") + (blocked.length > 8 ? " 等" : "");
          return [{ level: "warn", text: `正在监听的 ${shown} 将被拦截` }];
        }
        if (a === "disable") return [{ level: "warn", text: "所有端口将对外开放" }];
        const out: Issue[] = [];
        if (a === "remove" && port === String(ssh)) out.push({ level: "err", text: "这是当前 SSH 端口，取消后将无法连接" });
        if (a === "allow" && /^\d+$/.test(port) && !r.listen) out.push({ level: "warn", text: `当前没有进程监听 ${port}` });
        if ((a === "allow" || a === "remove") && !active) out.push({ level: "warn", text: "防火墙未启用，规则在启用后生效" });
        return out;
      },
    },
  },
  sysctlTool({
    id: "ping",
    group: "网络",
    label: "禁止 Ping",
    check: "禁止",
    keys: [["net.ipv4.icmp_echo_ignore_all", "1", "0"]],
    file: "/etc/sysctl.d/99-myshell-ping.conf",
    note: "开启后服务器不再响应 ICMP Ping",
  }),
  sysctlTool({
    id: "forward",
    group: "网络",
    label: "IP 转发",
    check: "启用",
    keys: [
      ["net.ipv4.ip_forward", "1", "0"],
      ["net.ipv6.conf.all.forwarding", "1", "0"],
    ],
    file: "/etc/sysctl.d/99-myshell-forward.conf",
    note: "",
    issues: (r, v) => (!v.on && r.docker ? [{ level: "warn", text: "Docker 容器网络依赖 IP 转发" }] : []),
  }),
  {
    id: "dns",
    group: "网络",
    label: "DNS",
    risk: "change",
    note: (_, c) => (c.env.resolved ? "会重启 systemd-resolved" : "可能被网络管理器改回"),
    probe: (e) =>
      e.resolved
        ? `echo "cur=$(resolvectl dns 2>/dev/null | awk -F: '{print $2}' | xargs)"`
        : `echo "cur=$(awk '/^nameserver/{print $2}' /etc/resolv.conf | xargs)"`,
    current: (cur) => (cur.cur ? `当前：${cur.cur}` : ""),
    fields: (_, v) => {
      const f: FieldDef[] = [{ key: "preset", label: "DNS", type: "select", def: DNS_PRESETS[0].value, options: DNS_PRESETS }];
      if (v.preset === "custom") f.push({ key: "custom", label: "地址", type: "text", placeholder: "223.5.5.5 8.8.8.8" });
      return f;
    },
    build: (v, c) => {
      const list = dnsList(v);
      if (!list.length) return null;
      if (list.some((a) => !/^[0-9a-fA-F.:]+$/.test(a))) return "请输入 IP 地址";
      if (c.env.resolved)
        return {
          script: [
            "mkdir -p /etc/systemd/resolved.conf.d",
            `printf '[Resolve]\\nDNS=${list.join(" ")}\\n' > /etc/systemd/resolved.conf.d/99-myshell.conf`,
            "systemctl restart systemd-resolved",
            "resolvectl dns",
          ].join("\n"),
        };
      return {
        script: [
          "cp -pL /etc/resolv.conf /etc/resolv.conf.myshell.bak 2>/dev/null",
          "[ -L /etc/resolv.conf ] && rm -f /etc/resolv.conf",
          `printf 'nameserver %s\\n' ${list.join(" ")} > /etc/resolv.conf`,
          "cat /etc/resolv.conf",
        ].join("\n"),
      };
    },
    check: {
      script: (v, c) =>
        sh(
          `for s in ${dnsList(v).join(" ")}; do`,
          "  if command -v dig >/dev/null 2>&1; then dig +time=2 +tries=1 +short @$s baidu.com A | grep -q . && echo ok=$s || echo bad=$s",
          "  elif command -v nslookup >/dev/null 2>&1; then timeout 4 nslookup baidu.com $s >/dev/null 2>&1 && echo ok=$s || echo bad=$s",
          "  else echo notool=1; break; fi",
          "done",
          c.env.resolved ? "" : "command -v systemctl >/dev/null 2>&1 && systemctl is-active NetworkManager >/dev/null 2>&1 && echo nm=1",
        ),
      issues: (r) => {
        const bad = listOf(r.bad);
        const out: Issue[] = [];
        if (bad.length && !r.ok) out.push({ level: "err", text: "所有 DNS 均无响应" });
        else if (bad.length) out.push({ level: "warn", text: `${bad.join(", ")} 无响应` });
        if (r.nm) out.push({ level: "warn", text: "NetworkManager 运行中，可能改回 resolv.conf" });
        return out;
      },
    },
  },
  {
    id: "ipinfo",
    group: "网络",
    label: "公网 IP",
    risk: "read",
    priv: false,
    build: () => ({
      script: String.raw`get() { curl -fsS --max-time 6 "$@" 2>/dev/null || wget -qO- -T 6 "$2" 2>/dev/null; }
echo "== IPv4 =="; get -4 https://ipinfo.io/json || echo "获取失败"
echo; echo "== IPv6 =="; get -6 https://api64.ipify.org || echo "无"`,
    }),
  },
  {
    id: "pingtest",
    group: "网络",
    label: "连通测试",
    risk: "read",
    priv: false,
    timeout: 60,
    fields: () => [{ key: "target", label: "目标", type: "text", def: "baidu.com", placeholder: "baidu.com" }],
    build: (v) => {
      const t = str(v, "target");
      if (!t) return null;
      if (!/^[a-zA-Z0-9.:-]+$/.test(t)) return "目标格式不正确";
      return { script: `ping -c 4 -W 3 ${t}` };
    },
  },

  // ---------- 磁盘 ----------
  {
    id: "disks",
    group: "磁盘",
    label: "磁盘分区",
    risk: "read",
    priv: false,
    build: () => ({
      script: "lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT 2>/dev/null; echo; df -hPT -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null || df -hP",
    }),
  },
  {
    id: "du",
    group: "磁盘",
    label: "目录占用",
    risk: "read",
    priv: true,
    timeout: 180,
    fields: () => [{ key: "path", label: "目录", type: "text", def: "/", placeholder: "/var" }],
    build: (v) => {
      const p = str(v, "path");
      if (!p) return null;
      return { script: `du -xh -d 1 ${shq(p)} 2>/dev/null | sort -rh | head -20` };
    },
    check: {
      script: (v) => sh(`[ -d ${shq(str(v, "path"))} ] || echo missing=1`),
      issues: (r) => (r.missing ? [{ level: "err", text: "目录不存在" }] : []),
    },
  },
  {
    id: "clean",
    group: "磁盘",
    label: "清理空间",
    when: (e) => !!e.pkg,
    risk: "change",
    note: "日志只保留 200MB",
    timeout: 300,
    build: (_, c) => ({
      script: [
        `B=$(df -P / | awk 'NR==2{print $4}')`,
        cleanCmd(c.env),
        "command -v journalctl >/dev/null 2>&1 && journalctl --vacuum-size=200M",
        `A=$(df -P / | awk 'NR==2{print $4}')`,
        `echo "释放 $(( (A - B) / 1024 )) MB"; df -h /`,
      ].join("\n"),
    }),
    check: {
      script: () =>
        sh(
          PKG_BUSY,
          "echo cache=$(du -sm /var/cache/apt /var/cache/dnf /var/cache/yum /var/cache/apk /var/cache/pacman/pkg /var/cache/zypp 2>/dev/null | awk '{s+=$1} END{print s+0}')",
          "command -v journalctl >/dev/null 2>&1 && echo journal=$(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]' | head -1)",
          "command -v apt-get >/dev/null 2>&1 && echo auto=$(apt-get -s autoremove 2>/dev/null | grep -c '^Remv')",
        ),
      issues: (r) => {
        const out: Issue[] = busyIssue(r);
        const parts = [`软件包缓存 ${r.cache ?? "?"} MB`, r.journal ? `日志 ${r.journal}` : ""].filter(Boolean);
        out.push({ level: "ok", text: parts.join("，") });
        if (Number(r.auto) > 0) out.push({ level: "warn", text: `将卸载 ${r.auto} 个无用依赖包` });
        return out;
      },
    },
  },

  // ---------- 软件 ----------
  {
    id: "pkgs",
    group: "软件",
    label: "常用工具",
    when: (e) => !!e.pkg,
    risk: "change",
    term: true,
    fields: () => [
      { key: "pkgs", label: "软件", type: "multi", def: ["curl", "wget", "git", "vim", "htop"], options: TOOL_PKGS.map((p) => ({ value: p, label: p })) },
    ],
    build: (v, c) => {
      const p = (v.pkgs as string[]) ?? [];
      if (!p.length) return null;
      return { script: pkgInstall(c.env, p) };
    },
    check: {
      script: (v) =>
        sh(
          PKG_BUSY,
          DISK_FREE,
          `for p in ${((v.pkgs as string[]) ?? []).join(" ")}; do b=$p; [ $p = net-tools ] && b=netstat; command -v $b >/dev/null 2>&1 && echo have=$p; done`,
        ),
      issues: (r, v) => {
        const out: Issue[] = [...busyIssue(r), ...diskIssue(r, 300)];
        const have = listOf(r.have);
        if (have.length === ((v.pkgs as string[]) ?? []).length) out.push({ level: "warn", text: "所选软件都已安装" });
        else if (have.length) out.push({ level: "ok", text: `已安装：${have.join(", ")}` });
        return out;
      },
    },
  },
  {
    id: "docker",
    group: "软件",
    label: "安装 Docker",
    when: (e) => !e.docker,
    risk: "change",
    note: "将运行 get.docker.com 脚本",
    term: true,
    fields: () => [
      {
        key: "src",
        label: "下载源",
        type: "select",
        def: "Aliyun",
        options: [
          { value: "Aliyun", label: "阿里云镜像" },
          { value: "AzureChinaCloud", label: "Azure 中国" },
          { value: "official", label: "官方" },
        ],
      },
    ],
    build: (v) => ({
      script: [
        "curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || wget -qO /tmp/get-docker.sh https://get.docker.com",
        `sh /tmp/get-docker.sh${v.src && v.src !== "official" ? ` --mirror ${v.src}` : ""}`,
        "command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker",
        "docker --version",
      ].join("\n"),
    }),
    check: {
      script: () =>
        sh(
          "command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || echo nodl=1",
          REACH("https://get.docker.com"),
          "command -v podman >/dev/null 2>&1 && echo podman=1",
          PKG_BUSY,
          DISK_FREE,
          VIRT,
        ),
      issues: (r, _, c) => {
        if (isLike(c.env, "alpine")) return [{ level: "err", text: "官方脚本不支持 Alpine，请用 apk add docker" }];
        const out: Issue[] = [...busyIssue(r), ...diskIssue(r, 2048)];
        if (r.nodl) out.push({ level: "err", text: "缺少 curl 和 wget" });
        else if (!r.reach) out.push({ level: "warn", text: "无法连接 get.docker.com" });
        if (r.podman) out.push({ level: "warn", text: "已安装 Podman，可能与 Docker 冲突" });
        if (r.virt === "lxc" || r.virt === "openvz") out.push({ level: "warn", text: `容器（${r.virt}）内运行 Docker 可能失败` });
        return out;
      },
    },
  },
];

export const riskOf = (t: Tool, v: Values, c: Ctx): Risk => (typeof t.risk === "function" ? t.risk(v, c) : t.risk);
export const noteOf = (t: Tool, v: Values, c: Ctx) => (typeof t.note === "function" ? t.note(v, c) : t.note) ?? "";
export const privOf = (t: Tool, v: Values, c: Ctx) => t.priv ?? riskOf(t, v, c) !== "read";

/** Form defaults from the field definitions. */
export function defaults(fields: FieldDef[]): Values {
  const v: Values = {};
  for (const f of fields) v[f.key] = f.def ?? (f.type === "check" ? false : f.type === "multi" ? [] : "");
  return v;
}

/** One-line description, shown as the tool card tooltip. */
export const DESCS: Record<string, string> = {
  upgrade: "通过系统包管理器升级全部已安装软件包，在终端中执行以便查看进度。",
  hostname: "修改服务器主机名，并同步更新 /etc/hosts 中的对应记录。",
  timezone: "设置系统时区，可同时开启 NTP 自动校时。",
  swap: "创建或调整 /swapfile 交换文件，内存较小的服务器可避免 OOM。",
  mirror: "把系统软件源切换到国内镜像，加快安装和更新速度。",
  bbr: "启用 TCP BBR 拥塞控制，改善高延迟、丢包线路的吞吐。",
  selinux: "查看并切换 SELinux 模式。",
  reboot: "立即重启服务器。",
  adduser: "创建新用户，配置密钥或密码登录，可选授予 sudo 并保存为新服务器。",
  passwd: "修改指定用户的登录密码，密码经标准输入传递。",
  users: "列出 root 和普通用户的 UID、是否管理员及登录 Shell。",
  deluser: "删除用户账号，可选同时删除其家目录。",
  sshd: "修改 sshd 端口、root 登录和密码登录策略，修改前会检查配置。",
  logins: "查看最近的登录记录，以及登录失败次数最多的 IP。",
  conns: "查看当前登录会话和连接数最多的来源 IP。",
  fail2ban: "安装 Fail2ban 并保护 sshd，多次登录失败的 IP 会被自动封禁。",
  ports: "列出正在监听的 TCP/UDP 端口及对应进程。",
  firewall: "查看规则、放行或取消放行端口，启用或停用防火墙。",
  ping: "让服务器不响应 ICMP Ping 请求。",
  forward: "开启内核 IPv4/IPv6 转发，路由、NAT 和容器网络需要。",
  dns: "设置服务器使用的 DNS 服务器。",
  ipinfo: "查询服务器的公网 IPv4（含归属地）和 IPv6 地址。",
  pingtest: "从服务器 ping 指定目标，检查网络连通性和延迟。",
  disks: "查看磁盘、分区和挂载点的容量使用情况。",
  du: "统计指定目录下各子目录的占用大小，按大小排序。",
  clean: "清理软件包缓存、无用依赖和过大的系统日志。",
  pkgs: "一次安装多个常用命令行工具。",
  docker: "使用官方脚本安装 Docker，可选国内下载源。",
};
