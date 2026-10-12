// Sends UI-side trouble to the app log: uncaught errors, unhandled rejections and long frames
// (main-thread tasks that froze rendering). Repeats are merged so a hot loop can't flood the log.
import { api } from "./api";

/** A task this long drops ~12 frames at 60Hz. */
const LONG_TASK_MS = 200;
const FLUSH_MS = 10_000;

let installed = false;
const recent = new Map<string, number>();

function send(level: "error" | "warn", target: "crash" | "perf" | "ui", msg: string) {
  const key = target + msg.slice(0, 200);
  const now = Date.now();
  if (now - (recent.get(key) ?? 0) < 30_000) return;
  recent.set(key, now);
  if (recent.size > 200) recent.clear();
  api.logWrite(level, target, msg).catch(() => {});
}

function describe(v: unknown): string {
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function logUiCrash(error: unknown, componentStack?: string | null) {
  send("error", "crash", `界面崩溃: ${describe(error)}${componentStack ? "\n组件:" + componentStack : ""}`);
}

export function installDiagnostics(windowLabel: string) {
  if (installed || !("__TAURI_INTERNALS__" in window)) return;
  installed = true;

  window.addEventListener("error", (e) => {
    send("error", "ui", `[${windowLabel}] 未捕获异常: ${e.error ? describe(e.error) : e.message} (${e.filename}:${e.lineno}:${e.colno})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    send("warn", "ui", `[${windowLabel}] 未处理的异步错误: ${describe(e.reason)}`);
  });

  // Long frames: batch per FLUSH_MS window into one line.
  let count = 0;
  let max = 0;
  let total = 0;
  let timer: number | undefined;
  const flush = () => {
    timer = undefined;
    if (!count) return;
    send("warn", "perf", `[${windowLabel}] 掉帧 ${count} 次，最长 ${Math.round(max)}ms，共 ${Math.round(total)}ms`);
    count = max = total = 0;
  };
  // Long animation frames also cover slow style/layout/paint; plain long tasks only script.
  const type = PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame") ? "long-animation-frame" : "longtask";
  try {
    new PerformanceObserver((list) => {
      if (document.visibilityState !== "visible") return;
      for (const e of list.getEntries()) {
        if (e.duration < LONG_TASK_MS) continue;
        count++;
        total += e.duration;
        max = Math.max(max, e.duration);
      }
      if (count && timer === undefined) timer = window.setTimeout(flush, FLUSH_MS);
    }).observe({ type, buffered: false });
  } catch {
    // longtask entries unsupported: nothing to record.
  }
}
