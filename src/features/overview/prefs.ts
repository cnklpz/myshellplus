// Overview page layout preferences. Per-viewer, in localStorage.
import { useSyncExternalStore } from "react";

export type MetricKey =
  "cpu" | "mem" | "disk" | "net" | "load" | "uptime" | "latency" | "chart";

export const METRICS: { key: MetricKey; label: string }[] = [
  { key: "cpu", label: "CPU" },
  { key: "mem", label: "内存" },
  { key: "disk", label: "磁盘" },
  { key: "net", label: "网络" },
  { key: "load", label: "负载" },
  { key: "uptime", label: "运行时间" },
  { key: "latency", label: "延迟" },
  { key: "chart", label: "趋势图" },
];

export interface OverviewPrefs {
  layout: "grid" | "list";
  metrics: MetricKey[];
  /** Groups left out of the overview */
  hiddenGroups: string[];
  /** Groups connected automatically when the overview opens */
  autoGroups: string[];
  onlyConnected: boolean;
  /** Sections per group; off shows one flat wall */
  grouped: boolean;
  /** Usage percent at which CPU / memory / disk count as an alert */
  alertPct: number;
}

const DEFAULTS: OverviewPrefs = {
  layout: "grid",
  metrics: ["cpu", "mem", "disk", "net", "load", "uptime", "latency", "chart"],
  hiddenGroups: [],
  autoGroups: [],
  onlyConnected: true,
  grouped: true,
  alertPct: 90,
};

/** Bump when a default changes and stored prefs should pick it up. */
const VERSION = 2;

const KEY = "msp.overview";
const listeners = new Set<() => void>();

function read(): OverviewPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    const stored = v && typeof v === "object" ? v : {};
    // v2: "only connected" became the default.
    if ((stored.version ?? 1) < 2) delete stored.onlyConnected;
    return { ...DEFAULTS, ...stored };
  } catch {
    return DEFAULTS;
  }
}

let prefs = read();

export const getOverviewPrefs = () => prefs;

export function setOverviewPrefs(patch: Partial<OverviewPrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...prefs, version: VERSION }));
  } catch {
    /* preferences just won't persist */
  }
  listeners.forEach((l) => l());
}

export function useOverviewPrefs(): OverviewPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => prefs,
  );
}
