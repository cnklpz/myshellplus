// Server status dashboard for one host (side panel).
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronRight, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Bar, Dialog, Empty, toast } from "../../components/ui";
import { api, errMsg, type Proc, type Sample, type SysInfo } from "../../lib/api";
import { fmtBytes, fmtPct, fmtRate, fmtUptime } from "../../lib/format";
import { Sparkline } from "./Sparkline";
import "./monitor.css";

const MAX = 60;

interface MonitorEvent {
  hostId: string;
  sample?: Sample;
  info?: SysInfo | null;
  error?: string;
}

function useMonitor(hostId: string, gen: number) {
  const [history, setHistory] = useState<Sample[]>([]);
  const [info, setInfo] = useState<SysInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    setLoading(true);
    setError(null);

    const append = (s: Sample) =>
      setHistory((h) => {
        if (h.length && h[h.length - 1].ts >= s.ts) return h;
        const next = h.length >= MAX ? h.slice(h.length - MAX + 1) : h.slice();
        next.push(s);
        return next;
      });

    listen<MonitorEvent>("monitor", (e) => {
      const p = e.payload;
      if (!alive || p.hostId !== hostId) return;
      if (p.error) {
        setError(p.error);
      } else {
        setError(null);
        if (p.info) setInfo(p.info);
        if (p.sample) append(p.sample);
      }
      setLoading(false);
    }).then((f) => {
      if (alive) unlisten = f;
      else f();
    });

    api
      .monitorSubscribe(hostId)
      .then((snap) => {
        if (!alive) return;
        if (snap.info) setInfo(snap.info);
        if (snap.error) setError(snap.error);
        setHistory((h) => {
          // Merge: events that raced ahead of the snapshot are kept if newer.
          const last = snap.history.length ? snap.history[snap.history.length - 1].ts : 0;
          return [...snap.history, ...h.filter((s) => s.ts > last)].slice(-MAX);
        });
        if (snap.history.length || snap.error) setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(errMsg(e));
        setLoading(false);
      });

    return () => {
      alive = false;
      unlisten?.();
      api.monitorUnsubscribe(hostId).catch(() => {});
    };
  }, [hostId, gen]);

  return { history, info, error, loading };
}


export function MonitorPanel({ hostId }: { hostId: string }) {
  const [gen, setGen] = useState(0);
  const { history, info, error, loading } = useMonitor(hostId, gen);
  const cur = history[history.length - 1];
  const retry = () => setGen((g) => g + 1);

  if (!cur) {
    if (error)
      return (
        <div className="panel-body">
          <Empty
            icon={<AlertTriangle />}
            text={<span className="selectable">{error}</span>}
            action={
              <button className="btn sm" onClick={retry}>
                <RefreshCw /> 重试
              </button>
            }
          />
        </div>
      );
    return (
      <div className="panel-body">
        <div className="mon">
          {info && <HostInfo info={info} />}
          <div className="mon-sec">
            <div className="mon-loading">{loading ? "采集中…" : "等待数据…"}</div>
            <div className="mon-skel-tiles">
              <div className="mon-skel" />
              <div className="mon-skel" />
              <div className="mon-skel" />
            </div>
          </div>
          <div className="mon-skel wide" />
        </div>
      </div>
    );
  }

  return (
    <div className="panel-body">
      <div className="mon">
        {error && (
          <div className="mon-alert">
            <AlertTriangle />
            <span className="grow ellipsis selectable" title={error}>{error}</span>
            <button className="btn ghost sm" onClick={retry}>重试</button>
          </div>
        )}
        {info && <HostInfo info={info} sample={cur} />}
        <Gauges history={history} cur={cur} />
        {cur.cores.length > 1 && <Cores cores={cur.cores} />}
        <NetSection history={history} cur={cur} />
        <DiskIoSection history={history} cur={cur} />
        <DisksSection cur={cur} />
        <ProcSection hostId={hostId} procs={cur.procs} />
      </div>
    </div>
  );
}

function HostInfo({ info, sample }: { info: SysInfo; sample?: Sample }) {
  return (
    <section className="mon-host selectable">
      <div className="mon-host-title">
        <span className="mon-host-name ellipsis" title={info.hostname}>{info.hostname || "-"}</span>
        <span className="mon-host-os ellipsis" title={info.os}>{info.os || "-"}</span>
      </div>
      <dl className="mon-info">
        <dt>内核</dt>
        <dd className="ellipsis" title={`${info.kernel} · ${info.arch}`}>
          {info.kernel} <span className="sep">·</span> {info.arch}
        </dd>
        <dt>CPU</dt>
        <dd className="ellipsis" title={info.cpu}>
          {info.cores} 核 <span className="sep">· {info.cpu || "-"}</span>
        </dd>
        <dt>IP</dt>
        <dd className="ellipsis mono">{info.ip || "-"}</dd>
        {sample && (
          <>
            <dt>运行</dt>
            <dd>{fmtUptime(sample.uptime)}</dd>
            <dt>负载</dt>
            <dd title="1 / 5 / 15 分钟">
              {sample.load.map((l) => l.toFixed(2)).join("  ")}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

function Gauges({ history, cur }: { history: Sample[]; cur: Sample }) {
  const memPct = cur.memTotal ? (cur.memUsed / cur.memTotal) * 100 : 0;
  const swapPct = cur.swapTotal ? (cur.swapUsed / cur.swapTotal) * 100 : 0;
  const cpuS = useMemo(() => history.map((s) => s.cpu), [history]);
  const memS = useMemo(() => history.map((s) => (s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0)), [history]);
  const swapS = useMemo(() => history.map((s) => (s.swapTotal ? (s.swapUsed / s.swapTotal) * 100 : 0)), [history]);
  return (
    <div className="mon-gauges">
      <Tile label="CPU" pct={cur.cpu} sub={`负载 ${cur.load[0].toFixed(2)}`} values={cpuS} color="var(--chart-1)" />
      <Tile label="内存" pct={memPct} sub={`${fmtBytes(cur.memUsed)} / ${fmtBytes(cur.memTotal)}`} values={memS} color="var(--chart-2)" />
      <Tile
        label="Swap"
        pct={swapPct}
        sub={cur.swapTotal ? `${fmtBytes(cur.swapUsed)} / ${fmtBytes(cur.swapTotal)}` : "未启用"}
        values={swapS}
        color="var(--chart-3)"
      />
    </div>
  );
}

function pctColor(p: number) {
  return p >= 90 ? "var(--err)" : p >= 75 ? "var(--warn)" : undefined;
}

function Tile(props: { label: string; pct: number; sub: string; values: number[]; color: string }) {
  return (
    <div className="mon-tile">
      <span className="lbl">{props.label}</span>
      <span className="big" style={{ color: pctColor(props.pct) }}>
        {props.pct.toFixed(0)}
        <small>%</small>
      </span>
      <span className="sub ellipsis" title={props.sub}>{props.sub}</span>
      <Sparkline series={[{ values: props.values, color: props.color }]} max={100} height={28} />
    </div>
  );
}

function Cores({ cores }: { cores: number[] }) {
  return (
    <div className="mon-sec">
      <div className="section-title">
        核心 <span className="count">{cores.length}</span>
      </div>
      <div className="mon-cores">
        {cores.map((c, i) => (
          <div className="mon-core" key={i} title={`CPU${i}: ${fmtPct(c, 1)}`}>
            <i className={c >= 90 ? "err" : c >= 75 ? "warn" : ""} style={{ height: `${Math.max(0, Math.min(100, c))}%` }} />
            <span>{c.toFixed(0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NetSection({ history, cur }: { history: Sample[]; cur: Sample }) {
  const [open, setOpen] = useState(false);
  const rx = useMemo(() => history.map((s) => s.rxRate), [history]);
  const tx = useMemo(() => history.map((s) => s.txRate), [history]);
  return (
    <div className="mon-sec">
      <div className="section-title">
        网络
        <span className="meta">TCP {cur.tcpConns}</span>
      </div>
      <div className="mon-rate">
        <ArrowDown className="c2" />
        <span className="ellipsis" title="下行">{fmtRate(cur.rxRate)}</span>
        <ArrowUp className="c1" />
        <span className="ellipsis" title="上行">{fmtRate(cur.txRate)}</span>
      </div>
      <div className="mon-chart">
        <Sparkline
          series={[
            { values: rx, color: "var(--chart-2)" },
            { values: tx, color: "var(--chart-1)" },
          ]}
          floor={1024}
          height={40}
        />
      </div>
      {cur.nets.length > 0 && (
        <>
          <div className="list-row mon-toggle" onClick={() => setOpen(!open)}>
            {open ? <ChevronDown /> : <ChevronRight />}
            <span className="grow">
              网卡 <span className="count">{cur.nets.length}</span>
            </span>
          </div>
          {open && (
            <div>
              <div className="mon-grid-row head">
                <span>名称</span>
                <span className="num">下行</span>
                <span className="num">上行</span>
              </div>
              {cur.nets.map((n) => (
                <div className="mon-grid-row" key={n.name} title={`累计 ↓${fmtBytes(n.rxTotal)} ↑${fmtBytes(n.txTotal)}`}>
                  <span className="ellipsis mono">{n.name}</span>
                  <span className="num">{fmtRate(n.rxRate)}</span>
                  <span className="num">{fmtRate(n.txRate)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DiskIoSection({ history, cur }: { history: Sample[]; cur: Sample }) {
  const rd = useMemo(() => history.map((s) => s.readRate), [history]);
  const wr = useMemo(() => history.map((s) => s.writeRate), [history]);
  return (
    <div className="mon-sec">
      <div className="section-title">磁盘 IO</div>
      <div className="mon-rate">
        <span className="k c2">读</span>
        <span className="ellipsis">{fmtRate(cur.readRate)}</span>
        <span className="k c4">写</span>
        <span className="ellipsis">{fmtRate(cur.writeRate)}</span>
      </div>
      <div className="mon-chart">
        <Sparkline
          series={[
            { values: rd, color: "var(--chart-2)" },
            { values: wr, color: "var(--chart-4)" },
          ]}
          floor={4096}
          height={40}
        />
      </div>
    </div>
  );
}

function DisksSection({ cur }: { cur: Sample }) {
  if (!cur.disks.length) return null;
  return (
    <div className="mon-sec">
      <div className="section-title">磁盘</div>
      <div>
        {cur.disks.map((d) => {
          const pct = d.total ? (d.used / d.total) * 100 : 0;
          return (
            <div className="mon-disk" key={d.mount + d.fs} title={d.fs}>
              <div className="mon-disk-head">
                <span className="ellipsis mono">{d.mount}</span>
                <span className="size">
                  {fmtBytes(d.used)} / {fmtBytes(d.total)}
                </span>
                <span className="pct" style={{ color: pctColor(pct) }}>{pct.toFixed(0)}%</span>
              </div>
              <Bar value={d.used} max={d.total || 1} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProcSection({ hostId, procs }: { hostId: string; procs: Proc[] }) {
  const [target, setTarget] = useState<Proc | null>(null);
  const [killed, setKilled] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  // Forget optimistic hides once the process is really gone from the latest sample.
  useEffect(() => {
    setKilled((k) => {
      if (k.size === 0) return k;
      const live = new Set(procs.map((p) => p.pid));
      const next = new Set([...k].filter((p) => live.has(p)));
      return next.size === k.size ? k : next;
    });
  }, [procs]);

  const kill = async (force: boolean) => {
    if (!target) return;
    const pid = target.pid;
    setBusy(true);
    try {
      const r = await api.execRun(hostId, `kill ${force ? "-9 " : ""}${pid}`, 10);
      if (r.exitCode !== 0) {
        toast((r.stderr || r.stdout || `退出码 ${r.exitCode}`).trim(), "error");
      } else {
        toast(`已向 ${pid} 发送 ${force ? "SIGKILL" : "SIGTERM"}`, "success");
        setKilled((k) => new Set(k).add(pid));
      }
      setTarget(null);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const rows = procs.filter((p) => !killed.has(p.pid));
  return (
    <div className="mon-sec">
      <div className="section-title">
        进程 <span className="count">{rows.length}</span>
      </div>
      <table className="table mon-procs">
        <colgroup>
          <col style={{ width: 52 }} />
          <col style={{ width: 60 }} />
          <col style={{ width: 44 }} />
          <col style={{ width: 56 }} />
          <col />
          <col style={{ width: 24 }} />
        </colgroup>
        <thead>
          <tr>
            <th className="num">PID</th>
            <th>用户</th>
            <th className="num">CPU</th>
            <th className="num">内存</th>
            <th>命令</th>
            <th className="act" />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.pid} onContextMenu={(e) => { e.preventDefault(); setTarget(p); }}>
              <td className="num mono pid">{p.pid}</td>
              <td className="user" title={p.user}>{p.user}</td>
              <td className={"num" + (p.cpu >= 90 ? " cpu-err" : p.cpu >= 75 ? " cpu-warn" : "")}>{p.cpu.toFixed(1)}</td>
              <td className="num" title={fmtPct(p.mem, 1)}>{fmtBytes(p.rss, 0)}</td>
              <td className="cmd mono" title={p.command}>{p.command}</td>
              <td className="act">
                <button className="icon-btn" title="结束进程" onClick={() => setTarget(p)}>
                  <X />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {target && (
        <Dialog
          title="结束进程"
          width={420}
          onClose={() => !busy && setTarget(null)}
          footer={
            <>
              <button className="btn" disabled={busy} onClick={() => setTarget(null)}>取消</button>
              <button className="btn danger" disabled={busy} title="kill -9" onClick={() => kill(true)}>强制结束</button>
              <button className="btn danger solid" disabled={busy} onClick={() => kill(false)}>结束</button>
            </>
          }
        >
          <div className="muted selectable">
            结束 <span className="mono">{target.command}</span>（PID <span className="mono">{target.pid}</span>）？
          </div>
        </Dialog>
      )}
    </div>
  );
}
