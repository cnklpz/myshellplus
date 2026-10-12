// Right-click actions for a process row, shared by the panel card and the detail dialogs:
// details, copy, pause / resume, end / force end.
import { ClipboardCopy, Copy, FolderOpen, Info, Pause, Play, RefreshCw, Skull, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Confirm, Dialog, toast } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { fmtBytes } from "../../lib/format";
import { useApp } from "../../store";
import type { MenuItem } from "../terminal/ContextMenu";

export interface ProcRef {
  pid: number;
  user?: string;
  command: string;
  /** ps STAT; "T" = stopped. Unknown: both pause and resume are offered. */
  stat?: string;
}

const SIGNALS = { TERM: "结束", KILL: "强制结束", STOP: "暂停", CONT: "继续" } as const;
type Sig = keyof typeof SIGNALS;

export const copyText = (text: string, what: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast(`已复制${what}`, "success"),
    () => toast("复制失败", "error"),
  );

/**
 * `items(p)` builds the menu for one process; render `node` once next to the table.
 * `onDone(pid, sig)` runs after a signal was delivered (e.g. hide the row, refresh).
 */
export function useProcActions(hostId: string, onDone?: (pid: number, sig: Sig) => void) {
  const [confirm, setConfirm] = useState<{ p: ProcRef; sig: "TERM" | "KILL" } | null>(null);
  const [detail, setDetail] = useState<ProcRef | null>(null);

  const send = useCallback(
    async (p: ProcRef, sig: Sig) => {
      try {
        const r = await api.execRun(hostId, `kill -${sig} ${p.pid}`, 10);
        if (r.exitCode !== 0) return toast((r.stderr || r.stdout || `退出码 ${r.exitCode}`).trim(), "error");
        toast(`已${SIGNALS[sig]} ${p.pid}`, "success");
        onDone?.(p.pid, sig);
      } catch (e) {
        toast(errMsg(e), "error");
      }
    },
    [hostId, onDone],
  );

  const items = (p: ProcRef): MenuItem[] => {
    const stopped = p.stat?.includes("T");
    return [
      { label: "详情…", icon: <Info />, onSelect: () => setDetail(p) },
      "sep",
      { label: "复制 PID", icon: <Copy />, onSelect: () => copyText(String(p.pid), " PID") },
      { label: "复制命令", icon: <ClipboardCopy />, onSelect: () => copyText(p.command, "命令") },
      "sep",
      stopped !== true && { label: "暂停", icon: <Pause />, hint: "STOP", onSelect: () => send(p, "STOP") },
      stopped !== false && { label: "继续", icon: <Play />, hint: "CONT", onSelect: () => send(p, "CONT") },
      "sep",
      { label: "结束…", icon: <X />, hint: "TERM", danger: true, onSelect: () => setConfirm({ p, sig: "TERM" }) },
      { label: "强制结束…", icon: <Skull />, hint: "KILL", danger: true, onSelect: () => setConfirm({ p, sig: "KILL" }) },
    ];
  };

  const node: ReactNode = (
    <>
      {confirm && (
        <Confirm
          title={SIGNALS[confirm.sig] + "进程"}
          danger
          confirmText={SIGNALS[confirm.sig]}
          message={
            <>
              发送 SIG{confirm.sig} 给 <span className="mono">{confirm.p.command.slice(0, 120)}</span>（PID{" "}
              <span className="mono">{confirm.p.pid}</span>）？
            </>
          }
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            send(c.p, c.sig);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {detail && <ProcDetail hostId={hostId} p={detail} onClose={() => setDetail(null)} onKill={(sig) => setConfirm({ p: detail, sig })} />}
    </>
  );

  return { items, node, showDetail: (p: ProcRef) => setDetail(p), confirmKill: (p: ProcRef, force = false) => setConfirm({ p, sig: force ? "KILL" : "TERM" }) };
}

const SEP = "__MSP_SEP__";

interface Facts {
  kv: [string, string][];
  cwd: string;
  cmdline: string;
  conns: string[];
}

function detailCmd(pid: number) {
  return [
    `p=${pid}`,
    `[ -d /proc/$p ] || { echo GONE; exit 0; }`,
    `ps -o ppid=,user=,nlwp=,ni=,stat=,etime=,pcpu=,pmem=,rss=,vsz= -p $p`,
    `echo ${SEP}; ps -o lstart= -p $p`,
    `echo ${SEP}; readlink /proc/$p/exe 2>/dev/null`,
    `echo ${SEP}; readlink /proc/$p/cwd 2>/dev/null`,
    `echo ${SEP}; tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null`,
    `echo ${SEP}; ls /proc/$p/fd 2>/dev/null | wc -l`,
    `echo ${SEP}; ss -tunapH 2>/dev/null | grep "pid=$p," | head -30`,
  ].join("; ");
}

function parseDetail(out: string): Facts | null {
  if (out.trim() === "GONE") return null;
  const [ps, start, exe, cwd, cmdline, fds, ss] = out.split(new RegExp(`^${SEP}$`, "m")).map((x) => x.trim());
  const f = (ps ?? "").split(/\s+/);
  const kv: [string, string][] = [
    ["父进程", f[0] ?? "-"],
    ["用户", f[1] ?? "-"],
    ["状态", f[4] ?? "-"],
    ["线程", f[2] ?? "-"],
    ["优先级", f[3] ?? "-"],
    ["CPU", f[6] ? `${f[6]}%` : "-"],
    ["内存", f[7] ? `${f[7]}%` : "-"],
    ["RSS", f[8] ? fmtBytes(Number(f[8]) * 1024) : "-"],
    ["虚拟内存", f[9] ? fmtBytes(Number(f[9]) * 1024) : "-"],
    ["运行", f[5] ?? "-"],
    ["启动于", start || "-"],
    ["文件句柄", fds || "-"],
    ["程序", exe || "-"],
    ["工作目录", cwd || "-"],
  ];
  return { kv, cwd: cwd ?? "", cmdline: cmdline ?? "", conns: (ss ?? "").split("\n").filter((l) => l.trim()) };
}

function ProcDetail(props: { hostId: string; p: ProcRef; onClose: () => void; onKill: (sig: "TERM" | "KILL") => void }) {
  const [facts, setFacts] = useState<Facts | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    api
      .execRun(props.hostId, detailCmd(props.p.pid), 15)
      .then((r) => {
        if (!alive) return;
        setFacts(parseDetail(r.stdout));
        setError(r.exitCode !== 0 && !r.stdout.trim() ? (r.stderr || `退出码 ${r.exitCode}`).trim() : null);
      })
      .catch((e) => alive && setError(errMsg(e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [props.hostId, props.p.pid, tick]);

  return (
    <Dialog
      width={640}
      onClose={props.onClose}
      title={
        <span className="mon-d-title">
          <span className="ellipsis">进程 {props.p.pid}</span>
          <button className="icon-btn" title="刷新" onClick={() => setTick((t) => t + 1)}>
            <RefreshCw className={busy ? "mon-spin" : undefined} />
          </button>
        </span>
      }
      footer={
        <>
          {facts?.cwd && (
            <button className="btn" title={facts.cwd} onClick={() => useApp.getState().openFilesAt(props.hostId, facts.cwd)}>
              <FolderOpen /> 工作目录
            </button>
          )}
          <span className="grow" />
          <button className="btn danger" disabled={!facts} onClick={() => props.onKill("KILL")}>强制结束</button>
          <button className="btn danger solid" disabled={!facts} onClick={() => props.onKill("TERM")}>结束</button>
        </>
      }
    >
      <div className="mon-pd selectable">
        {error && <div className="mon-d-err">{error}</div>}
        {facts === null ? (
          <div className="mon-muted">进程已退出</div>
        ) : facts === undefined ? (
          <div className="mon-muted">…</div>
        ) : (
          <>
            <pre className="mon-d-pre mono">{facts.cmdline || props.p.command}</pre>
            <dl className="mon-kv">
              {facts.kv.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd className="ellipsis mono" title={v}>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="section-title">
              网络连接 <span className="meta">{facts.conns.length}</span>
            </div>
            {facts.conns.length ? <pre className="mon-d-pre mono">{facts.conns.join("\n")}</pre> : <div className="mon-muted">无</div>}
          </>
        )}
      </div>
    </Dialog>
  );
}
