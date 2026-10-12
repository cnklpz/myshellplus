// Batch execution page: run one command on many hosts and compare results.
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronRight, Copy, History, Layers, Play, RotateCcw, ScrollText, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Confirm, Empty, toast } from "../../components/ui";
import { api, errMsg, type BatchHostResult, type Host, type Snippet } from "../../lib/api";
import { useApp } from "../../store";
import "./batch.css";

const TIMEOUTS = [
  { v: 30, label: "30 秒" },
  { v: 60, label: "60 秒" },
  { v: 300, label: "5 分钟" },
  { v: 1800, label: "30 分钟" },
];

const DANGER: RegExp[] = [
  /\brm\s+(-\S*\s+)*-[a-zA-Z]*[rRf]/,
  /\b(reboot|shutdown|poweroff|halt)\b/,
  /\binit\s+[06]\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b.*\bof=/,
  /\bsystemctl\s+(stop|restart|disable|mask|kill|poweroff|reboot|halt)\b/,
  /\bservice\s+\S+\s+(stop|restart)\b/,
  /\bkill(all)?\s+-9\b/,
  /\b(userdel|wipefs|fdisk|parted)\b/,
  /\biptables\s+-F\b/,
  /\bchmod\s+(-\S+\s+)*0?777\s+\/(\s|$)/,
  />\s*\/dev\/(sd|nvme|vd|hd)/,
  /:\(\)\s*\{.*:\|:/,
];
const isDangerous = (cmd: string) => DANGER.some((r) => r.test(cmd));

type Outcome = "running" | "ok" | "fail";
const outcome = (r: BatchHostResult): Outcome =>
  r.state === "running" ? "running" : r.state === "done" && r.exitCode === 0 && !r.error ? "ok" : "fail";

interface Run {
  id: string;
  command: string;
  hostIds: string[];
  timeout: number;
  started: number;
  ended: number | null;
  results: Record<string, BatchHostResult>;
}

type Filter = "all" | "ok" | "fail";

const fmtDur = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}分${Math.round((ms % 60000) / 1000)}秒`);
const fmtClock = (ms: number) => {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function BatchView() {
  const hosts = useApp((s) => s.hosts);
  const conn = useApp((s) => s.conn);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [command, setCommand] = useState("");
  const [timeout, setTimeoutSecs] = useState(60);
  const [runs, setRuns] = useState<Run[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [pendingDanger, setPendingDanger] = useState<{ hostIds: string[]; command: string; timeout: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [, setTick] = useState(0);

  // Events can arrive before batchStart resolves; buffer those for unknown ids.
  const known = useRef(new Set<string>());
  const early = useRef(new Map<string, BatchHostResult[]>());

  const applyResult = useCallback((r: BatchHostResult) => {
    setRuns((rs) =>
      rs.map((run) => {
        if (run.id !== r.batchId) return run;
        const results = { ...run.results, [r.hostId]: r };
        const done = run.hostIds.every((h) => results[h] && results[h].state !== "running");
        return { ...run, results, ended: done ? run.ended ?? Date.now() : null };
      }),
    );
  }, []);

  useEffect(() => {
    const un = listen<BatchHostResult>("batch", (e) => {
      const r = e.payload;
      if (known.current.has(r.batchId)) applyResult(r);
      else {
        const arr = early.current.get(r.batchId) ?? [];
        arr.push(r);
        early.current.set(r.batchId, arr);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [applyResult]);

  const current = runs.find((r) => r.id === currentId) ?? null;
  const running = !!current && current.ended === null;

  // Live elapsed counter while a run is in progress.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [running]);

  const start = async (hostIds: string[], cmd: string, secs: number) => {
    setStarting(true);
    const started = Date.now();
    try {
      const id = await api.batchStart(hostIds, cmd, secs);
      const results: Record<string, BatchHostResult> = {};
      for (const h of hostIds) results[h] = { batchId: id, hostId: h, state: "running", stdout: "", stderr: "", exitCode: null, durationMs: 0 };
      known.current.add(id);
      setRuns((rs) => [{ id, command: cmd, hostIds, timeout: secs, started, ended: null, results }, ...rs].slice(0, 10));
      setCurrentId(id);
      setFilter("all");
      setCollapsed(new Set());
      const buf = early.current.get(id);
      early.current.delete(id);
      buf?.forEach(applyResult);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setStarting(false);
    }
  };

  const request = (hostIds: string[], cmd: string, secs: number) => {
    if (!hostIds.length || !cmd.trim()) return;
    if (isDangerous(cmd)) setPendingDanger({ hostIds, command: cmd, timeout: secs });
    else start(hostIds, cmd, secs);
  };

  const selectedIds = hosts.filter((h) => selected.has(h.id)).map((h) => h.id);
  const canRun = selectedIds.length > 0 && command.trim() !== "" && !starting;
  const execute = () => canRun && request(selectedIds, command, timeout);

  const openRun = (r: Run) => {
    setCurrentId(r.id);
    setCommand(r.command);
    setSelected(new Set(r.hostIds));
    setTimeoutSecs(r.timeout);
    setFilter("all");
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>批量执行</h1>
        <span className="spacer" />
        <HistoryMenu runs={runs} currentId={currentId} onOpen={openRun} onRerun={(r) => request(r.hostIds.filter((h) => hosts.some((x) => x.id === h)), r.command, r.timeout)} />
      </div>
      <div className="bt-layout">
        <HostPicker hosts={hosts} conn={conn} selected={selected} setSelected={setSelected} search={search} setSearch={setSearch} />

        <div className="bt-main">
          <div className="bt-editor">
            <textarea
              className="textarea mono bt-cmd"
              placeholder="df -h"
              spellCheck={false}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  execute();
                }
              }}
            />
            <div className="row">
              <label className="faint bt-lbl">超时</label>
              <select className="select sm bt-timeout" value={timeout} onChange={(e) => setTimeoutSecs(+e.target.value)}>
                {TIMEOUTS.map((t) => (
                  <option key={t.v} value={t.v}>{t.label}</option>
                ))}
              </select>
              <SnippetMenu onPick={(s) => setCommand((c) => (c.trim() ? c.replace(/\s*$/, "\n") + s.command : s.command))} />
              <span className="spacer" />
              <button className="btn primary sm" disabled={!canRun} onClick={execute} title="Ctrl+Enter">
                <Play />
                执行
              </button>
            </div>
          </div>

          {current ? (
            <Results
              run={current}
              hosts={hosts}
              filter={filter}
              setFilter={setFilter}
              collapsed={collapsed}
              setCollapsed={setCollapsed}
              onRetry={(ids) => request(ids, current.command, current.timeout)}
            />
          ) : (
            <Empty icon={<Layers />} text="选择服务器并输入命令" />
          )}
        </div>
      </div>

      {pendingDanger && (
        <Confirm
          title="危险命令"
          danger
          confirmText={`在 ${pendingDanger.hostIds.length} 台上执行`}
          message={
            <div className="stack">
              <div>该命令可能不可逆：</div>
              <pre className="mono bt-danger-cmd">{pendingDanger.command}</pre>
            </div>
          }
          onCancel={() => setPendingDanger(null)}
          onConfirm={() => {
            const p = pendingDanger;
            setPendingDanger(null);
            start(p.hostIds, p.command, p.timeout);
          }}
        />
      )}
    </div>
  );
}

// ---------------- host picker ----------------

function Check(props: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!props.indeterminate;
  }, [props.indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="bt-check"
      checked={props.checked}
      onChange={(e) => props.onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function HostPicker(props: {
  hosts: Host[];
  conn: Record<string, { state: string }>;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  search: string;
  setSearch: (s: string) => void;
}) {
  const { hosts, selected, setSelected } = props;
  const groups = useMemo(() => {
    const k = props.search.trim().toLowerCase();
    const list = hosts
      .filter((h) => !k || [h.name, h.host, h.username, h.groupName, ...h.tags].some((x) => x.toLowerCase().includes(k)))
      .sort((a, b) => a.groupName.localeCompare(b.groupName, "zh-CN") || a.sort - b.sort || a.name.localeCompare(b.name, "zh-CN"));
    const m = new Map<string, Host[]>();
    for (const h of list) {
      const g = h.groupName || "未分组";
      m.set(g, [...(m.get(g) ?? []), h]);
    }
    return [...m.entries()];
  }, [hosts, props.search]);

  const setMany = (ids: string[], on: boolean) => {
    const s = new Set(selected);
    ids.forEach((id) => (on ? s.add(id) : s.delete(id)));
    setSelected(s);
  };
  const visibleIds = groups.flatMap(([, hs]) => hs.map((h) => h.id));
  const count = hosts.filter((h) => selected.has(h.id)).length;

  const dot = (id: string) => {
    const st = props.conn[id]?.state;
    return st === "connected" ? "ok" : st === "connecting" ? "warn" : st === "error" ? "err" : "";
  };

  return (
    <div className="bt-hosts">
      <div className="bt-hosts-top">
        <div className="bt-search">
          <Search />
          <input className="input sm" placeholder="搜索服务器" value={props.search} onChange={(e) => props.setSearch(e.target.value)} />
        </div>
        <div className="row">
          <span className="faint bt-count grow">已选 {count} 台</span>
          <button className="btn ghost sm" onClick={() => setMany(visibleIds, true)} disabled={!visibleIds.length}>全选</button>
          <button className="btn ghost sm" onClick={() => setSelected(new Set())} disabled={!count}>清空</button>
        </div>
      </div>
      <div className="bt-hosts-list">
        {hosts.length === 0 ? (
          <div className="empty">还没有服务器</div>
        ) : groups.length === 0 ? (
          <div className="empty">无匹配</div>
        ) : (
          groups.map(([g, hs]) => {
            const n = hs.filter((h) => selected.has(h.id)).length;
            const ids = hs.map((h) => h.id);
            return (
              <div key={g}>
                <div className="list-row bt-group" onClick={() => setMany(ids, n < hs.length)}>
                  <Check checked={n === hs.length} indeterminate={n > 0 && n < hs.length} onChange={(v) => setMany(ids, v)} />
                  <span className="grow ellipsis">{g}</span>
                  <span className="meta">
                    {n}/{hs.length}
                  </span>
                </div>
                {hs.map((h) => (
                  <div key={h.id} className={"list-row bt-host" + (selected.has(h.id) ? " selected" : "")} onClick={() => setMany([h.id], !selected.has(h.id))} title={`${h.username}@${h.host}:${h.port}`}>
                    <Check checked={selected.has(h.id)} onChange={(v) => setMany([h.id], v)} />
                    <span className={"dot " + dot(h.id)} />
                    <span className="grow ellipsis">{h.name}</span>
                    <span className="meta ellipsis bt-addr">{h.host}</span>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------- menus ----------------

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function SnippetMenu(props: { onPick: (s: Snippet) => void }) {
  const { open, setOpen, ref } = usePopover();
  const [list, setList] = useState<Snippet[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) return;
    setQ("");
    api.snippetList().then(setList, (e) => {
      toast(errMsg(e), "error");
      setList([]);
    });
  }, [open]);
  const k = q.trim().toLowerCase();
  const shown = (list ?? []).filter((s) => !k || s.name.toLowerCase().includes(k) || s.command.toLowerCase().includes(k));
  return (
    <div className="bt-pop-wrap" ref={ref}>
      <button className="btn sm" onClick={() => setOpen(!open)}>
        <ScrollText />
        命令
        <ChevronDown />
      </button>
      {open && (
        <div className="bt-pop">
          <input className="input sm" placeholder="搜索命令" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="bt-pop-list">
            {list === null ? (
              <div className="faint bt-pop-empty">加载中…</div>
            ) : shown.length === 0 ? (
              <div className="faint bt-pop-empty">{list.length ? "无匹配" : "还没有命令"}</div>
            ) : (
              shown.map((s) => (
                <div
                  key={s.id}
                  className="bt-pop-item"
                  onClick={() => {
                    props.onPick(s);
                    setOpen(false);
                  }}
                >
                  <span className="ellipsis">{s.name}</span>
                  <span className="mono faint ellipsis bt-pop-sub">{s.command}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function runCounts(r: Run) {
  const c = { ok: 0, fail: 0, running: 0 };
  for (const h of r.hostIds) c[r.results[h] ? outcome(r.results[h]) : "running"]++;
  return c;
}

function HistoryMenu(props: { runs: Run[]; currentId: string | null; onOpen: (r: Run) => void; onRerun: (r: Run) => void }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="bt-pop-wrap" ref={ref}>
      <button className="btn sm" disabled={!props.runs.length} onClick={() => setOpen(!open)}>
        <History />
        历史 {props.runs.length > 0 && <span className="faint">{props.runs.length}</span>}
        <ChevronDown />
      </button>
      {open && (
        <div className="bt-pop right wide">
          <div className="bt-pop-list">
            {props.runs.map((r) => {
              const c = runCounts(r);
              return (
                <div
                  key={r.id}
                  className={"bt-pop-item bt-hist" + (r.id === props.currentId ? " on" : "")}
                  onClick={() => {
                    props.onOpen(r);
                    setOpen(false);
                  }}
                >
                  <div className="row">
                    <span className="mono ellipsis grow">{r.command.replace(/\s*\n\s*/g, " ⏎ ")}</span>
                    <button
                      className="icon-btn"
                      title="重新执行"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        props.onRerun(r);
                      }}
                    >
                      <RotateCcw />
                    </button>
                  </div>
                  <div className="row bt-hist-meta">
                    <span className="num">{fmtClock(r.started)}</span>
                    <span>{r.hostIds.length} 台</span>
                    <span className="spacer" />
                    {c.running > 0 && <span className="bt-warn">运行中 {c.running}</span>}
                    <span className="bt-ok">成功 {c.ok}</span>
                    {c.fail > 0 && <span className="bt-fail">失败 {c.fail}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- results ----------------

function Results(props: {
  run: Run;
  hosts: Host[];
  filter: Filter;
  setFilter: (f: Filter) => void;
  collapsed: Set<string>;
  setCollapsed: (s: Set<string>) => void;
  onRetry: (hostIds: string[]) => void;
}) {
  const { run, hosts, filter, collapsed } = props;
  const name = (id: string) => hosts.find((h) => h.id === id)?.name ?? "（已删除）";
  const items = run.hostIds.map((h) => run.results[h]).filter(Boolean);
  const c = runCounts(run);
  const elapsed = (run.ended ?? Date.now()) - run.started;
  const failedIds = items.filter((r) => outcome(r) === "fail" && hosts.some((h) => h.id === r.hostId)).map((r) => r.hostId);
  const shown = items.filter((r) => filter === "all" || outcome(r) === filter);

  const copyAll = async () => {
    const text = items
      .map((r) => {
        const head = `### ${name(r.hostId)}  (exit ${r.exitCode ?? "-"})`;
        return [head, r.stdout.trimEnd(), r.stderr.trimEnd(), r.error ?? ""].filter(Boolean).join("\n");
      })
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制全部输出", "success");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const toggle = (id: string) => {
    const s = new Set(collapsed);
    s.has(id) ? s.delete(id) : s.add(id);
    props.setCollapsed(s);
  };
  const allCollapsed = shown.length > 0 && shown.every((r) => collapsed.has(r.hostId));

  return (
    <div className="bt-results">
      <div className="row bt-summary">
        <span className="bt-ok">成功 {c.ok}</span>
        <span className={c.fail ? "bt-fail" : "faint"}>失败 {c.fail}</span>
        {c.running > 0 && <span className="bt-warn">运行中 {c.running}</span>}
        <span className="faint num">用时 {fmtDur(elapsed)}</span>
        <span className="spacer" />
        <div className="seg">
          {(
            [
              ["all", "全部"],
              ["ok", "成功"],
              ["fail", "失败"],
            ] as [Filter, string][]
          ).map(([f, l]) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => props.setFilter(f)}>
              {l}
            </button>
          ))}
        </div>
        <button className="btn ghost sm" onClick={() => props.setCollapsed(allCollapsed ? new Set() : new Set(shown.map((r) => r.hostId)))}>
          {allCollapsed ? "展开" : "折叠"}
        </button>
        <button className="btn ghost sm" onClick={copyAll} disabled={!items.length} title="复制全部输出">
          <Copy />
          复制
        </button>
        <button className="btn ghost sm" disabled={!failedIds.length || c.running > 0} onClick={() => props.onRetry(failedIds)}>
          <RotateCcw />
          重试失败
        </button>
      </div>

      <div className="bt-cards">
        {shown.length === 0 && <div className="empty">无{filter === "ok" ? "成功" : "失败"}结果</div>}
        {shown.map((r) => {
          const o = outcome(r);
          const open = !collapsed.has(r.hostId);
          const hasBody = r.stdout || r.stderr || r.error;
          return (
            <div key={r.hostId} className="bt-card">
              <div className="bt-card-head" onClick={() => toggle(r.hostId)}>
                {open ? <ChevronDown /> : <ChevronRight />}
                <span className={"dot " + (o === "ok" ? "ok" : o === "fail" ? "err" : "warn")} />
                <span className="ellipsis grow bt-card-name">{name(r.hostId)}</span>
                {o === "running" ? (
                  <span className="bt-code bt-warn">运行中</span>
                ) : r.state === "error" ? (
                  <span className="bt-code bt-fail">错误</span>
                ) : (
                  <span className={"bt-code mono " + (r.exitCode === 0 ? "bt-ok" : "bt-fail")}>exit {r.exitCode ?? "-"}</span>
                )}
                <span className="num faint bt-dur">{o === "running" ? "…" : fmtDur(r.durationMs)}</span>
              </div>
              {open && (
                <div className="bt-card-body">
                  {r.error && <div className="bt-err selectable">{r.error}</div>}
                  {r.stdout && <pre className="mono bt-out selectable">{r.stdout}</pre>}
                  {r.stderr && <pre className="mono bt-out bt-stderr selectable">{r.stderr}</pre>}
                  {!hasBody && <div className="faint bt-noout">{o === "running" ? "执行中…" : "无输出"}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
