// "批量执行": a dialog with a multi-line editor whose lines are sent to one terminal session. Drafts, recall
// history and in-progress runs are kept at module level by tab id so they survive closing the dialog.
import { Play, Square, TriangleAlert } from "lucide-react";
import { Dialog } from "../../components/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { termBus } from "../../lib/termBus";
import { type TermTab, useApp } from "../../store";

type Mode = "line" | "paste";
const INTERVALS = [0, 200, 500, 1000];
const HISTORY_MAX = 20;

const drafts = new Map<string, string>();
const histories = new Map<string, string[]>();

// ---------- running jobs (per tab) ----------
interface Run {
  done: number;
  total: number;
}
const runs = new Map<string, Run>();
const cancels = new Map<string, () => void>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const setRun = (tabId: string, r: Run | null) => {
  if (r) runs.set(tabId, r);
  else runs.delete(tabId);
  emit();
};

/** Progress of a running batch in `tabId` (for the toolbar badge). */
export function useBatchRun(tabId: string): Run | undefined {
  return useSyncExternalStore(subscribe, () => runs.get(tabId));
}

const isAlive = (tabId: string) => !!useApp.getState().tabs.find((t) => t.id === tabId)?.alive;

/** Sends lines one by one to `tabId` (never to whatever tab is active later). */
async function runLines(tabId: string, hostId: string, lines: string[], interval: number) {
  let cancelled = false;
  let wake: (() => void) | null = null;
  cancels.set(tabId, () => {
    cancelled = true;
    wake?.();
  });
  setRun(tabId, { done: 0, total: lines.length });
  try {
    for (let i = 0; i < lines.length; i++) {
      if (cancelled || !isAlive(tabId)) break;
      const line = lines[i];
      try {
        await api.termWrite(tabId, line + "\r");
      } catch (e) {
        toast(errMsg(e), "error");
        break;
      }
      api.historyRecord(hostId, line.trim()).catch(() => {});
      setRun(tabId, { done: i + 1, total: lines.length });
      if (interval > 0 && i < lines.length - 1) {
        await new Promise<void>((res) => {
          const t = window.setTimeout(res, interval);
          wake = () => {
            clearTimeout(t);
            res();
          };
        });
        wake = null;
      }
    }
  } finally {
    cancels.delete(tabId);
    setRun(tabId, null);
  }
}

const DANGER =
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r|-[a-z]*r[a-z]*\s+--force|--recursive\s+--force|--force\s+--recursive)|\b(reboot|shutdown|poweroff|halt)\b|\binit\s+[06]\b|\bmkfs(\.\w+)?\b|\bdd\s+.*\bif=|\bsystemctl\s+(stop|disable|mask|kill|reboot|poweroff|halt)\b|:\(\)\s*\{|>\s*\/dev\/[sh]d[a-z]/i;

function loadPref<T extends string | number>(key: string, ok: (v: string) => boolean, def: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v !== null && ok(v)) return (typeof def === "number" ? Number(v) : v) as T;
  } catch {
    /* storage unavailable */
  }
  return def;
}
function savePref(key: string, v: string | number) {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* storage unavailable */
  }
}

export function BatchDialog(props: { tab: TermTab; initialText?: string; onClose: () => void }) {
  const { tab } = props;
  const hostName = useApp((s) => s.hosts.find((h) => h.id === tab.hostId)?.name ?? tab.title);
  const [text, setText] = useState(() => {
    if (props.initialText === undefined) return drafts.get(tab.id) ?? "";
    drafts.set(tab.id, props.initialText);
    return props.initialText;
  });
  const [mode, setMode] = useState<Mode>(() => loadPref<Mode>("cmdbar.mode", (v) => v === "line" || v === "paste", "line"));
  const [interval, setIntervalMs] = useState(() =>
    loadPref<number>("cmdbar.interval", (v) => INTERVALS.includes(Number(v)), 0),
  );
  const [confirm, setConfirm] = useState(false);
  const recall = useRef<{ idx: number; stash: string } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const run = useSyncExternalStore(subscribe, () => runs.get(tab.id));

  const update = (v: string) => {
    setText(v);
    drafts.set(tab.id, v);
    setConfirm(false);
  };

  // Focus the editor once the dialog is shown.
  useEffect(() => {
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => taRef.current?.focus());
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
    // only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lines = () =>
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.trim() && !l.trimStart().startsWith("#"));

  const pushHistory = (block: string) => {
    const h = (histories.get(tab.id) ?? []).filter((b) => b !== block);
    h.push(block);
    histories.set(tab.id, h.slice(-HISTORY_MAX));
    recall.current = null;
  };

  const execute = async (force = false) => {
    if (run || !tab.alive) return;
    const block = text.replace(/\s+$/, "");
    if (!block.trim()) return;
    const ls = mode === "line" ? lines() : block.split(/\r?\n/);
    if (mode === "line" && !ls.length) return;
    if (!force && ls.some((l) => DANGER.test(l))) {
      setConfirm(true);
      return;
    }
    setConfirm(false);
    pushHistory(block);
    taRef.current?.select();
    if (mode === "line") {
      await runLines(tab.id, tab.hostId, ls, interval);
    } else {
      const h = termBus.get(tab.id);
      if (!h) {
        toast("终端未就绪", "error");
        return;
      }
      h.paste(block); // bracketed paste when the shell enabled it
      await new Promise((r) => setTimeout(r, 30));
      api.termWrite(tab.id, "\r").catch((e) => toast(errMsg(e), "error"));
    }
    // Done: hand control back to the terminal that received the commands.
    props.onClose();
    termBus.get(tab.id)?.focus();
  };

  const stop = () => cancels.get(tab.id)?.();

  const recallStep = (delta: number) => {
    const h = histories.get(tab.id) ?? [];
    if (!h.length) return;
    const cur = recall.current;
    if (!cur) {
      if (delta > 0) return;
      recall.current = { idx: h.length - 1, stash: text };
    } else {
      const idx = cur.idx + delta;
      if (idx < 0) return;
      if (idx >= h.length) {
        recall.current = null;
        update(cur.stash);
        return;
      }
      recall.current = { ...cur, idx };
    }
    const v = h[recall.current!.idx];
    setText(v);
    drafts.set(tab.id, v);
    setConfirm(false);
  };

  const disabled = !tab.alive;

  const runButton = run ? (
    <>
      <span className="cmdbar-progress">
        {run.done}/{run.total}
      </span>
      <button className="btn" onClick={stop}>
        <Square />
        停止
      </button>
    </>
  ) : (
    <button className="btn primary" title="Ctrl+Enter" disabled={disabled || !text.trim()} onClick={() => execute()}>
      <Play />
      执行
    </button>
  );

  return (
    <Dialog
      title={`批量执行 · ${hostName}`}
      width={760}
      onClose={props.onClose}
      footer={
        <>
          <select
            className="select cmdbar-select"
            title="发送方式"
            value={mode}
            onChange={(e) => {
              const m = e.target.value as Mode;
              setMode(m);
              savePref("cmdbar.mode", m);
            }}
          >
            <option value="line">逐行发送</option>
            <option value="paste">整段粘贴</option>
          </select>
          {mode === "line" && (
            <select
              className="select cmdbar-select num"
              title="行间隔"
              value={interval}
              onChange={(e) => {
                const v = Number(e.target.value);
                setIntervalMs(v);
                savePref("cmdbar.interval", v);
              }}
            >
              {INTERVALS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms === 0 ? "无间隔" : ms < 1000 ? `间隔 ${ms}ms` : `间隔 ${ms / 1000}s`}
                </option>
              ))}
            </select>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={props.onClose}>
            取消
          </button>
          {runButton}
        </>
      }
    >
      {confirm && (
        <div className="cmdbar-confirm row">
          <TriangleAlert />
          <span className="grow">包含高风险命令</span>
          <button className="btn sm ghost" onClick={() => setConfirm(false)}>
            取消
          </button>
          <button className="btn sm danger solid" onClick={() => execute(true)}>
            确认执行
          </button>
        </div>
      )}
      <textarea
        ref={taRef}
        className="textarea mono cmdbar-editor"
        spellCheck={false}
        rows={12}
        disabled={disabled}
        placeholder={"cd /var/log\nls -la\ndf -h"}
        value={text}
        onChange={(e) => {
          recall.current = null;
          update(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && e.ctrlKey) {
            e.preventDefault();
            if (confirm) execute(true);
            else execute();
          } else if (e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            recallStep(e.key === "ArrowUp" ? -1 : 1);
          }
        }}
      />
    </Dialog>
  );
}
