// Runs maintenance scripts on a host for the toolbox and Docker panels: detects the system once per host,
// wraps scripts for root/sudo, and keeps the sudo password in memory only (never in the command line).
import { useSyncExternalStore } from "react";
import { api, type ExecResult } from "./api";
import { termBus } from "./termBus";
import { useApp } from "../store";

export type PkgManager = "apt-get" | "dnf" | "yum" | "apk" | "pacman" | "zypper";

export interface RemoteEnv {
  linux: boolean;
  /** os-release ID (ubuntu, debian, centos, rocky, alpine, …) */
  id: string;
  like: string[];
  version: string;
  name: string;
  arch: string;
  kernel: string;
  pkg: PkgManager | null;
  user: string;
  root: boolean;
  /** How privileged scripts run for a non-root user. */
  sudo: "nopass" | "pass" | "none";
  systemd: boolean;
  firewall: "ufw" | "firewalld" | null;
  selinux: string | null;
  resolved: boolean;
  /** "Docker version 27.1.1" or null */
  docker: string | null;
  /** The current user may talk to the Docker daemon without sudo. */
  dockerDirect: boolean;
}

const DETECT = String.raw`
echo "os=$(uname -s)"; echo "arch=$(uname -m)"; echo "kernel=$(uname -r)"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "id=$ID"; echo "like=$ID_LIKE"; echo "ver=$VERSION_ID"; echo "name=$PRETTY_NAME"; fi
for p in apt-get dnf yum apk pacman zypper; do command -v $p >/dev/null 2>&1 && { echo "pkg=$p"; break; }; done
echo "user=$(id -un)"; echo "uid=$(id -u)"
if [ "$(id -u)" != 0 ]; then
  if ! command -v sudo >/dev/null 2>&1; then echo sudo=none; elif sudo -n true 2>/dev/null; then echo sudo=nopass; else echo sudo=pass; fi
fi
[ -d /run/systemd/system ] && echo systemd=1
if command -v ufw >/dev/null 2>&1; then echo fw=ufw; elif command -v firewall-cmd >/dev/null 2>&1; then echo fw=firewalld; fi
command -v getenforce >/dev/null 2>&1 && echo "selinux=$(getenforce 2>/dev/null)"
[ -L /etc/resolv.conf ] && readlink /etc/resolv.conf | grep -q systemd && echo resolved=1
if command -v docker >/dev/null 2>&1; then echo "docker=$(docker --version 2>/dev/null | cut -d, -f1)"; docker info >/dev/null 2>&1 && echo dockerDirect=1; fi
true`;

/** key=value lines -> map (repeated keys are joined with ","). */
export function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    out[k] = k in out && out[k] !== v ? `${out[k]},${v}` : v;
  }
  return out;
}

const envCache = new Map<string, RemoteEnv>();
const sudoPw = new Map<string, string>();

export async function detectEnv(hostId: string, force = false): Promise<RemoteEnv> {
  const hit = envCache.get(hostId);
  if (hit && !force) return hit;
  const r = await api.execRun(hostId, `sh -c ${shq(DETECT)}`, 20, true);
  const kv = parseKv(r.stdout);
  const env: RemoteEnv = {
    linux: kv.os === "Linux",
    id: (kv.id ?? "").toLowerCase(),
    like: (kv.like ?? "").toLowerCase().split(/\s+/).filter(Boolean),
    version: kv.ver ?? "",
    name: kv.name || kv.os || "未知系统",
    arch: kv.arch ?? "",
    kernel: kv.kernel ?? "",
    pkg: (kv.pkg as PkgManager) || null,
    user: kv.user ?? "",
    root: kv.uid === "0",
    sudo: (kv.sudo as RemoteEnv["sudo"]) ?? "nopass",
    systemd: kv.systemd === "1",
    firewall: (kv.fw as RemoteEnv["firewall"]) || null,
    selinux: kv.selinux || null,
    resolved: kv.resolved === "1",
    docker: kv.docker || null,
    dockerDirect: kv.dockerDirect === "1",
  };
  envCache.set(hostId, env);
  return env;
}

/** Distro is (or derives from) one of `ids`. */
export const isLike = (e: RemoteEnv, ...ids: string[]) => ids.includes(e.id) || e.like.some((l) => ids.includes(l));

/** Kernel version at least major.minor. */
export function kernelAtLeast(e: RemoteEnv, major: number, minor: number) {
  const m = /^(\d+)\.(\d+)/.exec(e.kernel);
  return !!m && (+m[1] > major || (+m[1] === major && +m[2] >= minor));
}

/** POSIX single-quote. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Components re-render when a password is saved or dropped (e.g. runScript found it wrong).
const sudoListeners = new Set<() => void>();
const sudoChanged = () => sudoListeners.forEach((f) => f());
const subscribeSudo = (f: () => void) => {
  sudoListeners.add(f);
  return () => void sudoListeners.delete(f);
};
function dropSudoPassword(hostId: string) {
  if (sudoPw.delete(hostId)) sudoChanged();
}

export const hasSudoPassword = (hostId: string) => sudoPw.has(hostId);
export function setSudoPassword(hostId: string, pw: string) {
  if (!pw) return dropSudoPassword(hostId);
  sudoPw.set(hostId, pw);
  sudoChanged();
}

/** A privileged script needs a sudo password we don't have yet. */
export const needsSudoPassword = (hostId: string, e: RemoteEnv) => !e.root && e.sudo === "pass" && !sudoPw.has(hostId);

/** Reactive `needsSudoPassword`: flips back to true when a wrong password is dropped. */
export function useNeedsSudoPassword(hostId: string, e: RemoteEnv | null): boolean {
  const has = useSyncExternalStore(subscribeSudo, () => sudoPw.has(hostId));
  return !!e && !e.root && e.sudo === "pass" && !has;
}

/** How a script will run, for the command preview. */
export function runAsLabel(e: RemoteEnv, priv: boolean): string {
  if (!priv || e.root) return e.root ? "以 root 执行" : `以 ${e.user || "当前用户"} 执行`;
  return e.sudo === "none" ? "需要 root（未安装 sudo）" : "通过 sudo 执行";
}

export class RemoteError extends Error {}

/** Run `script` with sh; privileged scripts go through sudo for non-root users. Secrets go in `stdin`. */
export async function runScript(
  hostId: string,
  e: RemoteEnv,
  script: string,
  opts: { priv?: boolean; stdin?: string; timeout?: number; quiet?: boolean } = {},
): Promise<ExecResult> {
  let cmd = `sh -c ${shq(script)}`;
  let stdin = opts.stdin;
  if (opts.priv && !e.root) {
    if (e.sudo === "none") throw new RemoteError("需要 root 权限，服务器未安装 sudo");
    if (e.sudo === "nopass") cmd = `sudo -n ${cmd}`;
    else {
      const pw = sudoPw.get(hostId);
      if (!pw) throw new RemoteError("请先输入 sudo 密码");
      // -k: always read the password, so it is never left over on the script's stdin.
      cmd = `sudo -k -S -p '' ${cmd}`;
      stdin = `${pw}\n${stdin ?? ""}`;
    }
  }
  const r = await api.execRun(hostId, cmd, opts.timeout ?? 120, opts.quiet, stdin);
  if (opts.priv && e.sudo === "pass" && /incorrect password|Sorry, try again|密码错误|抱歉，请重试/i.test(r.stderr)) {
    dropSudoPassword(hostId);
    throw new RemoteError("sudo 密码错误");
  }
  return r;
}

/** Terminal tab of this host to type into: the active tab when it is on this host, else the first one. */
function hostTab(hostId: string): string | null {
  const { tabs, activeTab } = useApp.getState();
  const active = tabs.find((t) => t.id === activeTab);
  if (active?.hostId === hostId && active.alive) return active.id;
  return tabs.find((t) => t.hostId === hostId && t.alive)?.id ?? null;
}

const b64 = (s: string) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));

/** Run a long or interactive script in the host's terminal, so progress (and a sudo prompt) is visible there. */
export function runInTerminal(hostId: string, e: RemoteEnv, script: string, priv: boolean): void {
  const tab = hostTab(hostId);
  const h = tab && termBus.get(tab);
  if (!tab || !h) throw new RemoteError("请先打开该服务器的终端");
  const sudo = priv && !e.root ? "sudo " : "";
  useApp.getState().setActiveTab(tab);
  // One-liners go in as typed; multi-line scripts are passed through base64 to survive the shell's line editing.
  // sudo only covers the first command of a list, so compound one-liners run under sh -c.
  const line = !script.includes("\n")
    ? sudo && /[;&|<>`$]/.test(script)
      ? `sudo sh -c ${shq(script)}`
      : `${sudo}${script}`
    : `${sudo}sh -c "$(echo ${b64(script)} | base64 -d)"`;
  h.run(line);
  h.focus();
}

/** One command per package manager. */
export function pkgInstall(e: RemoteEnv, pkgs: string[]): string {
  const p = pkgs.join(" ");
  switch (e.pkg) {
    case "apt-get":
      return `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ${p}`;
    case "dnf":
      return `dnf install -y ${p}`;
    case "yum":
      return `yum install -y ${p}`;
    case "apk":
      return `apk add ${p}`;
    case "pacman":
      return `pacman -S --noconfirm --needed ${p}`;
    case "zypper":
      return `zypper -n install ${p}`;
    default:
      return `echo "未识别的包管理器" >&2; exit 1`;
  }
}

/** Random password from an unambiguous alphabet. */
export function genPassword(len = 20): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => abc[n % abc.length]).join("");
}
