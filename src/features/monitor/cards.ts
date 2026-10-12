// Monitor card layout: an ordered list of configurable card instances, shared across hosts
// (a card may be scoped to one host) and persisted locally.
import { useSyncExternalStore } from "react";
import type { Sample, SysInfo } from "../../lib/api";
import { fmtBytes, fmtRate, fmtUptime } from "../../lib/format";

export type CardType =
  | "info" | "metric" | "load" | "cores" | "net" | "nic" | "io" | "disks" | "disk" | "procs" | "gpu" | "apps" | "docker" | "command" | "service" | "note";

/** s = one third, m = half, l = full row. */
export type CardSize = "s" | "m" | "l";

export type MetricKey =
  | "cpu" | "mem" | "swap" | "disk" | "load1" | "load5" | "load15" | "rx" | "tx" | "read" | "write" | "tcp" | "uptime";

export type InfoField =
  | "hostname" | "kernel" | "cpu" | "ip" | "ssh" | "uptime" | "load" | "mem" | "disk" | "net" | "tcp" | "user";

/** Order here is the display order. */
export const INFO_FIELDS: [InfoField, string][] = [
  ["hostname", "主机名"],
  ["user", "账号"],
  ["kernel", "内核"],
  ["cpu", "CPU"],
  ["ip", "IP"],
  ["ssh", "SSH"],
  ["uptime", "运行"],
  ["load", "负载"],
  ["mem", "内存"],
  ["disk", "根分区"],
  ["net", "网速"],
  ["tcp", "TCP"],
];

export const DEFAULT_INFO_FIELDS: InfoField[] = ["hostname", "kernel", "cpu", "ip", "ssh", "uptime", "load"];

export interface CardCfg {
  // info
  fields?: InfoField[];
  /** Hide the name / OS heading. */
  noHead?: boolean;
  // metric
  metric?: MetricKey;
  view?: "trend" | "gauge" | "number";
  color?: 1 | 2 | 3 | 4;
  warn?: number;
  err?: number;
  // disk / nic
  mount?: string;
  nic?: string;
  // procs
  limit?: number;
  sort?: "cpu" | "mem";
  filter?: string;
  // command / service
  command?: string;
  interval?: number;
  output?: "text" | "number";
  unit?: string;
  lines?: number;
  services?: string;
  // apps: process names (matched against the kernel comm)
  apps?: string;
  // note
  text?: string;
}

export interface CardInst {
  uid: string;
  type: CardType;
  size: CardSize;
  /** Custom title; empty = the type's default. */
  title?: string;
  /** Only shown for this host id. */
  host?: string;
  cfg: CardCfg;
}

export const DEFAULT_APPS = "nginx php-fpm mysqld mariadbd redis-server postgres mongod java node dockerd containerd";

export interface TypeMeta {
  label: string;
  group: string;
  size: CardSize;
  cfg?: CardCfg;
}

export const TYPE_META: Record<CardType, TypeMeta> = {
  info: { label: "主机信息", group: "概览", size: "l" },
  metric: { label: "指标", group: "概览", size: "s", cfg: { metric: "cpu", view: "trend", color: 1 } },
  load: { label: "负载", group: "概览", size: "l" },
  cores: { label: "核心", group: "CPU", size: "l" },
  procs: { label: "进程", group: "CPU", size: "l", cfg: { limit: 10, sort: "cpu" } },
  gpu: { label: "GPU", group: "CPU", size: "l", cfg: { interval: 5 } },
  net: { label: "网络", group: "网络", size: "l" },
  nic: { label: "网卡", group: "网络", size: "m" },
  io: { label: "磁盘 IO", group: "存储", size: "l" },
  disks: { label: "磁盘", group: "存储", size: "l" },
  disk: { label: "挂载点", group: "存储", size: "s", cfg: { mount: "/", warn: 75, err: 90 } },
  apps: { label: "应用占用", group: "应用", size: "l", cfg: { apps: DEFAULT_APPS, interval: 10 } },
  docker: { label: "Docker 容器", group: "应用", size: "l", cfg: { limit: 10, interval: 10 } },
  command: { label: "命令", group: "自定义", size: "l", cfg: { command: "", interval: 30, output: "text", lines: 6 } },
  service: { label: "服务状态", group: "自定义", size: "l", cfg: { services: "", interval: 30 } },
  note: { label: "便签", group: "自定义", size: "l", cfg: { text: "" } },
};

export const TYPE_GROUPS = ["概览", "CPU", "网络", "存储", "应用", "自定义"];

export interface MetricMeta {
  label: string;
  /** Percent metrics get a 0–100 scale and default thresholds. */
  pct?: boolean;
  get: (s: Sample, info: SysInfo | null) => number;
  fmt: (v: number) => string;
  /** Detail dialog opened on click. */
  detail: "cpu" | "mem" | "net" | "io" | "disk";
  sub?: (s: Sample, info: SysInfo | null) => string;
}

const ratio = (a: number, b: number) => (b ? (a / b) * 100 : 0);
const fmtNum = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));

export const METRICS: Record<MetricKey, MetricMeta> = {
  cpu: { label: "CPU", pct: true, get: (s) => s.cpu, fmt: (v) => v.toFixed(0), detail: "cpu", sub: (s) => `负载 ${s.load[0].toFixed(2)}` },
  mem: {
    label: "内存", pct: true, get: (s) => ratio(s.memUsed, s.memTotal), fmt: (v) => v.toFixed(0), detail: "mem",
    sub: (s) => `${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}`,
  },
  swap: {
    label: "Swap", pct: true, get: (s) => ratio(s.swapUsed, s.swapTotal), fmt: (v) => v.toFixed(0), detail: "mem",
    sub: (s) => (s.swapTotal ? `${fmtBytes(s.swapUsed)} / ${fmtBytes(s.swapTotal)}` : "未启用"),
  },
  disk: {
    label: "最满磁盘", pct: true, detail: "disk", fmt: (v) => v.toFixed(0),
    get: (s) => Math.max(0, ...s.disks.map((d) => ratio(d.used, d.total))),
    sub: (s) => {
      const d = [...s.disks].sort((a, b) => ratio(b.used, b.total) - ratio(a.used, a.total))[0];
      return d ? d.mount : "-";
    },
  },
  load1: { label: "负载 1 分钟", get: (s) => s.load[0], fmt: fmtNum, detail: "cpu", sub: (s, i) => `${s.cores.length || i?.cores || 1} 核` },
  load5: { label: "负载 5 分钟", get: (s) => s.load[1], fmt: fmtNum, detail: "cpu", sub: (s, i) => `${s.cores.length || i?.cores || 1} 核` },
  load15: { label: "负载 15 分钟", get: (s) => s.load[2], fmt: fmtNum, detail: "cpu", sub: (s, i) => `${s.cores.length || i?.cores || 1} 核` },
  rx: { label: "下行", get: (s) => s.rxRate, fmt: fmtRate, detail: "net", sub: (s) => `TCP ${s.tcpConns}` },
  tx: { label: "上行", get: (s) => s.txRate, fmt: fmtRate, detail: "net", sub: (s) => `TCP ${s.tcpConns}` },
  read: { label: "磁盘读", get: (s) => s.readRate, fmt: fmtRate, detail: "io" },
  write: { label: "磁盘写", get: (s) => s.writeRate, fmt: fmtRate, detail: "io" },
  tcp: { label: "TCP 连接", get: (s) => s.tcpConns, fmt: (v) => v.toFixed(0), detail: "net" },
  uptime: { label: "运行时间", get: (s) => s.uptime, fmt: fmtUptime, detail: "cpu" },
};

export function cardTitle(c: CardInst) {
  if (c.title?.trim()) return c.title.trim();
  if (c.type === "metric") return METRICS[c.cfg.metric ?? "cpu"].label;
  if (c.type === "disk") return c.cfg.mount || TYPE_META.disk.label;
  if (c.type === "nic") return c.cfg.nic || TYPE_META.nic.label;
  return TYPE_META[c.type].label;
}

let seq = 0;
export const newUid = () => Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

export function newCard(type: CardType, patch?: Partial<CardInst>): CardInst {
  const m = TYPE_META[type];
  return { uid: newUid(), type, size: m.size, cfg: { ...m.cfg }, ...patch };
}

const metricCard = (metric: MetricKey): CardInst => ({ ...newCard("metric"), cfg: { ...TYPE_META.metric.cfg, metric, color: metric === "cpu" ? 1 : metric === "mem" ? 2 : 3 } });

function defaults(): CardInst[] {
  return [
    newCard("info"),
    metricCard("cpu"),
    metricCard("mem"),
    metricCard("swap"),
    newCard("cores"),
    newCard("net"),
    newCard("io"),
    newCard("disks"),
    newCard("procs"),
  ];
}

const KEY = "mon.cards.v2";
const OLD_KEY = "mon.cards";

/** Old format: fixed ids with an order and a hidden set. */
function migrate(raw: string): CardInst[] {
  const old = JSON.parse(raw) as { order?: string[]; hidden?: string[] };
  const hidden = new Set(old.hidden ?? ["load"]);
  const out: CardInst[] = [];
  for (const id of old.order ?? []) {
    if (hidden.has(id)) continue;
    if (id === "cpu" || id === "mem" || id === "swap") out.push(metricCard(id));
    else if (id in TYPE_META) out.push(newCard(id as CardType));
  }
  return out.length ? out : defaults();
}

function load(): CardInst[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const list = JSON.parse(raw) as CardInst[];
      if (Array.isArray(list)) return list.filter((c) => c && c.uid && c.type in TYPE_META).map((c) => ({ ...c, cfg: c.cfg ?? {} }));
    }
    const old = localStorage.getItem(OLD_KEY);
    if (old) return migrate(old);
  } catch {
    /* corrupt: fall through */
  }
  return defaults();
}

let cards = load();
const listeners = new Set<() => void>();

export function setCards(next: CardInst[]) {
  cards = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export const getCards = () => cards;

export function useCards() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => cards,
  );
}

/** Move `uid` to sit just before / after `target`. Returns false when nothing changed. */
export function moveCard(uid: string, target: string, after: boolean) {
  if (uid === target) return false;
  const item = cards.find((c) => c.uid === uid);
  if (!item) return false;
  const list = cards.filter((c) => c.uid !== uid);
  const at = list.findIndex((c) => c.uid === target) + (after ? 1 : 0);
  list.splice(at, 0, item);
  if (list.every((c, i) => c === cards[i])) return false;
  setCards(list);
  return true;
}

/** Put `uid` right after `after` (null = first). */
export function placeAfter(uid: string, after: string | null) {
  const item = cards.find((c) => c.uid === uid);
  if (!item) return;
  const list = cards.filter((c) => c.uid !== uid);
  list.splice(after ? list.findIndex((c) => c.uid === after) + 1 : 0, 0, item);
  setCards(list);
}

export const upsertCard = (c: CardInst, before?: string) => {
  const i = cards.findIndex((x) => x.uid === c.uid);
  if (i >= 0) return setCards(cards.map((x) => (x.uid === c.uid ? c : x)));
  const at = before ? cards.findIndex((x) => x.uid === before) : -1;
  const list = cards.slice();
  list.splice(at >= 0 ? at : list.length, 0, c);
  setCards(list);
};
export const removeCard = (uid: string) => setCards(cards.filter((c) => c.uid !== uid));
export const resetCards = () => setCards(defaults());

/** Same types / sizes / config as the defaults (uids differ). */
export function isDefaultLayout(list: CardInst[]) {
  const d = defaults();
  const strip = (c: CardInst) => JSON.stringify({ ...c, uid: "" });
  return list.length === d.length && list.every((c, i) => strip(c) === strip(d[i]));
}
