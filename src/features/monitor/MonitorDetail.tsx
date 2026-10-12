// Second-level detail dialogs for the status panel. Live charts come from the panel's sample
// history (passed down, so they update every 3s); extra facts are fetched with execRun and
// refreshed every 5s while the dialog is open.
import { ChevronDown, ChevronUp, FolderSearch, LoaderCircle, RefreshCw, Skull, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Bar, Confirm, Dialog, toast } from "../../components/ui";
import { api, errMsg, type Sample, type SysInfo } from "../../lib/api";
import { fmtBytes, fmtPct, fmtRate } from "../../lib/format";
import { useApp } from "../../store";
import { AreaChart } from "./AreaChart";

export type DetailKind = "cpu" | "mem" | "net" | "io" | "disk" | "proc";

const TITLES: Record<DetailKind, string> = {
  cpu: "CPU",
  mem: "内存",
  net: "网络",
  io: "磁盘 IO",
  disk: "磁盘",
  proc: "进程",
};

const POLL_MS = 5000;
const SEP = "__MSP_SEP__";
const SPAN = "3 分钟";

// ---------- helpers ----------

const bytesAxis = (v: number) => fmtBytes(v).replace(/\.0 /, " ");
const rateAxis = (v: number) => `${bytesAxis(v)}/s`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const pctColor = (p: number) => (p >= 90 ? "var(--err)" : p >= 75 ? "var(--warn)" : undefined);
const lines = (s: string) => s.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
const fields = (l: string) => l.trim().split(/\s+/);

/** Split a combined command's stdout on the SEP marker lines. */
function parts(out: string, n: number): string[] {
  const p = out.split(new RegExp(`^${SEP}$`, "m"));
  while (p.length < n) p.push("");
  return p;
}

interface Ctx {
  hostId: string;
  tick: number;
  refresh: () => void;
  track: (d: number) => void;
}
const DetailCtx = createContext<Ctx>(null as unknown as Ctx);

interface ExecState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Run `cmd` on mount and, unless `once`, on every refresh tick. Keeps the last good data on error. */
function useExec<T>(cmd: string, parse: (out: string) => T, opts?: { once?: boolean; timeout?: number }) {
  const { hostId, tick, track } = useContext(DetailCtx);
  const [st, setSt] = useState<ExecState<T>>({ data: null, error: null, loading: true });
  const parseRef = useRef(parse);
  parseRef.current = parse;
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const key = opts?.once ? 0 : tick;
  useEffect(() => {
    if (busy.current) return;
    busy.current = true;
    track(1);
    setSt((s) => ({ ...s, loading: true }));
    api
      .execRun(hostId, cmd, opts?.timeout ?? 15)
      .then((r) => {
        if (!alive.current) return;
        if (r.timedOut) return setSt((s) => ({ ...s, error: "执行超时", loading: false }));
        if (r.exitCode !== 0 && !r.stdout.trim()) {
          const msg = (r.stderr || `退出码 ${r.exitCode}`).trim().split("\n")[0];
          return setSt((s) => ({ ...s, error: msg, loading: false }));
        }
        try {
          setSt({ data: parseRef.current(r.stdout), error: null, loading: false });
        } catch (e) {
          setSt((s) => ({ ...s, error: `解析失败：${errMsg(e)}`, loading: false }));
        }
      })
      .catch((e) => alive.current && setSt((s) => ({ ...s, error: errMsg(e), loading: false })))
      .finally(() => {
        busy.current = false;
        track(-1);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, cmd, key]);
  return st;
}

// ---------- dialog shell ----------

export function MonitorDetail(props: {
  kind: DetailKind;
  hostId: string;
  history: Sample[];
  info: SysInfo | null;
  onClose: () => void;
}) {
  const hostName = useApp((s) => s.hosts.find((h) => h.id === props.hostId)?.name);
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const track = useCallback((d: number) => setPending((p) => Math.max(0, p + d)), []);

  useEffect(() => {
    const t = window.setInterval(() => {
      if (!document.hidden) setTick((x) => x + 1);
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, []);

  const ctx = useMemo(() => ({ hostId: props.hostId, tick, refresh, track }), [props.hostId, tick, refresh, track]);
  const cur = props.history[props.history.length - 1];
  const name = hostName || props.info?.hostname || "";

  return (
    <Dialog
      width={880}
      onClose={props.onClose}
      title={
        <span className="mon-d-title">
          <span className="ellipsis">
            {TITLES[props.kind]}
            {name && <span className="host"> · {name}</span>}
          </span>
          <button className="icon-btn" title="刷新" onClick={refresh}>
            <RefreshCw className={pending > 0 ? "mon-spin" : undefined} />
          </button>
        </span>
      }
    >
      <DetailCtx.Provider value={ctx}>
        <div className="mon-d">
          {!cur ? null : props.kind === "cpu" ? (
            <CpuView history={props.history} cur={cur} info={props.info} />
          ) : props.kind === "mem" ? (
            <MemView history={props.history} cur={cur} />
          ) : props.kind === "net" ? (
            <NetView history={props.history} cur={cur} />
          ) : props.kind === "io" ? (
            <IoView history={props.history} />
          ) : props.kind === "disk" ? (
            <DiskView />
          ) : (
            <ProcView />
          )}
        </div>
      </DetailCtx.Provider>
    </Dialog>
  );
}

function Sec(props: { title: ReactNode; meta?: ReactNode; error?: string | null; children?: ReactNode }) {
  return (
    <section className="mon-d-sec">
      <div className="section-title">
        {props.title}
        {props.meta !== undefined && <span className="meta">{props.meta}</span>}
      </div>
      {props.error && <div className="mon-d-err selectable">{props.error}</div>}
      {props.children}
    </section>
  );
}

function Stat(props: { label: string; value: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <div className="mon-stat">
      <span className="lbl">{props.label}</span>
      <span className="val" style={{ color: props.color }}>{props.value}</span>
      {props.sub !== undefined && <span className="sub">{props.sub}</span>}
    </div>
  );
}

function useSeries(history: Sample[], pick: (s: Sample) => number) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => history.map(pick), [history]);
}

// ---------- CPU ----------

function parseKv(out: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const l of lines(out)) {
    const i = l.indexOf(":");
    if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return kv;
}

function CpuView({ history, cur, info }: { history: Sample[]; cur: Sample; info: SysInfo | null }) {
  const ts = useSeries(history, (s) => s.ts);
  const cpu = useSeries(history, (s) => s.cpu);
  const ls = useExec("LC_ALL=C lscpu", parseKv, { once: true });
  const ncores = cur.cores.length || info?.cores || 1;

  const facts = useMemo(() => {
    const kv = ls.data ?? {};
    const out: [string, string][] = [];
    const model = kv["Model name"] || info?.cpu;
    if (model) out.push(["型号", model]);
    if (kv["Architecture"] || info?.arch) out.push(["架构", kv["Architecture"] || info!.arch]);
    const threads = Number(kv["CPU(s)"]) || ncores;
    const sockets = Number(kv["Socket(s)"]) || 1;
    const perSocket = Number(kv["Core(s) per socket"]) || 0;
    out.push(["核心/线程", perSocket ? `${perSocket * sockets} / ${threads}` : `${threads}`]);
    const mhz = Number(kv["CPU max MHz"]) || Number(kv["CPU MHz"]);
    if (mhz) out.push(["频率", `${(mhz / 1000).toFixed(2)} GHz`]);
    if (sockets > 1) out.push(["插槽", String(sockets)]);
    const cache = kv["L3 cache"] || kv["L2 cache"];
    if (cache) out.push([kv["L3 cache"] ? "L3 缓存" : "L2 缓存", cache]);
    const virt = kv["Hypervisor vendor"] || kv["Virtualization"];
    if (virt) out.push([kv["Hypervisor vendor"] ? "虚拟化平台" : "虚拟化", virt]);
    return out;
  }, [ls.data, info, ncores]);

  return (
    <>
      <AreaChart series={[{ label: "使用率", values: cpu, color: "var(--chart-1)" }]} ts={ts} max={100} fmt={(v) => fmtPct(v, 1)} axisFmt={(v) => `${v}%`} span={SPAN} />
      <Sec title="负载" meta={`${ncores} 核`}>
        <div className="mon-stats">
          {(["1 分钟", "5 分钟", "15 分钟"] as const).map((l, i) => {
            const v = cur.load[i];
            const r = (v / ncores) * 100;
            return (
              <div className="mon-stat" key={l}>
                <span className="lbl">{l}</span>
                <span className="val" style={{ color: pctColor(r) }}>{v.toFixed(2)}</span>
                <Bar value={r} />
              </div>
            );
          })}
        </div>
      </Sec>
      {cur.cores.length > 0 && (
        <Sec title="核心" meta={cur.cores.length}>
          <div className="mon-d-cores">
            {cur.cores.map((c, i) => (
              <div className="mon-d-core" key={i}>
                <span className="lbl mono">{i}</span>
                <Bar value={c} />
                <span className="num" style={{ color: pctColor(c) }}>{fmtPct(c, 0)}</span>
              </div>
            ))}
          </div>
        </Sec>
      )}
      <Sec title="处理器" error={ls.error}>
        <dl className="mon-kv selectable">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="ellipsis" title={v}>{v}</dd>
            </div>
          ))}
        </dl>
      </Sec>
    </>
  );
}

// ---------- Memory ----------

interface MemData {
  kv: Record<string, number>;
  top: { pid: number; user: string; rss: number; pmem: number; comm: string }[];
}

const MEM_CMD = `cat /proc/meminfo; echo ${SEP}; ps -eo pid,user:32,rss,pmem,comm --sort=-rss | head -11`;

function parseMem(out: string): MemData {
  const [mi, ps] = parts(out, 2);
  const kv: Record<string, number> = {};
  for (const l of lines(mi)) {
    const m = /^(\S+):\s+(\d+)/.exec(l);
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  const top = lines(ps)
    .slice(1)
    .map((l) => {
      const f = fields(l);
      return { pid: Number(f[0]), user: f[1], rss: Number(f[2]) * 1024, pmem: Number(f[3]), comm: f.slice(4).join(" ") };
    })
    .filter((p) => p.pid > 0);
  return { kv, top };
}

function MemView({ history, cur }: { history: Sample[]; cur: Sample }) {
  const ts = useSeries(history, (s) => s.ts);
  const mem = useSeries(history, (s) => (s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0));
  const swap = useSeries(history, (s) => (s.swapTotal ? (s.swapUsed / s.swapTotal) * 100 : 0));
  const r = useExec(MEM_CMD, parseMem);
  const kv = r.data?.kv;

  const total = kv?.MemTotal ?? cur.memTotal;
  const free = kv?.MemFree ?? 0;
  const avail = kv?.MemAvailable ?? total - cur.memUsed;
  const buffers = kv?.Buffers ?? 0;
  const cached = (kv?.Cached ?? 0) + (kv?.SReclaimable ?? 0);
  const shmem = kv?.Shmem ?? 0;
  const apps = kv ? Math.max(0, total - free - buffers - cached) : cur.memUsed;
  const swapTotal = kv?.SwapTotal ?? cur.swapTotal;
  const swapUsed = kv ? swapTotal - (kv.SwapFree ?? 0) : cur.swapUsed;
  const pct = (v: number) => (total ? (v / total) * 100 : 0);

  const segs = [
    { label: "应用", v: apps, color: "var(--chart-1)" },
    { label: "缓存", v: cached, color: "var(--chart-3)" },
    { label: "缓冲", v: buffers, color: "var(--chart-4)" },
  ];
  const rows: { label: string; v: number; color?: string; of?: number }[] = [
    { label: "总量", v: total },
    { label: "已用", v: total - avail, of: total },
    { label: "可用", v: avail, of: total },
    { label: "应用", v: apps, color: segs[0].color, of: total },
    { label: "缓存", v: cached, color: segs[1].color, of: total },
    { label: "缓冲", v: buffers, color: segs[2].color, of: total },
    { label: "共享", v: shmem, of: total },
    { label: "Swap 总量", v: swapTotal },
    { label: "Swap 已用", v: swapUsed, of: swapTotal },
  ];

  return (
    <>
      <AreaChart
        series={[
          { label: "内存", values: mem, color: "var(--chart-2)" },
          ...(cur.swapTotal ? [{ label: "Swap", values: swap, color: "var(--chart-3)" }] : []),
        ]}
        ts={ts}
        max={100}
        fmt={(v) => fmtPct(v, 1)}
        axisFmt={(v) => `${v}%`}
        span={SPAN}
      />
      <Sec title="构成" error={r.error}>
        <div className="mon-stack" title={segs.map((s) => `${s.label} ${fmtBytes(s.v)}`).join("  ")}>
          {segs.map((s) => (
            <i key={s.label} style={{ width: `${pct(s.v)}%`, background: s.color }} />
          ))}
        </div>
        <div className="mon-d-kvt">
          {rows.map((x) => (
            <div className="row-kv" key={x.label}>
              <span className="dot" style={{ background: x.color ?? "transparent" }} />
              <span className="lbl">{x.label}</span>
              <span className="num">{fmtBytes(x.v)}</span>
              <span className="num faint">{x.of ? fmtPct((x.v / x.of) * 100, 1) : ""}</span>
            </div>
          ))}
        </div>
      </Sec>
      <Sec title="内存占用前 10">
        <table className="table mon-d-table">
          <colgroup>
            <col style={{ width: 80 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 72 }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th className="num">PID</th>
              <th>用户</th>
              <th className="num">RSS</th>
              <th className="num">内存</th>
              <th>命令</th>
            </tr>
          </thead>
          <tbody>
            {(r.data?.top ?? []).map((p) => (
              <tr key={p.pid}>
                <td className="num mono faint">{p.pid}</td>
                <td className="ellipsis-cell" title={p.user}>{p.user}</td>
                <td className="num">{fmtBytes(p.rss)}</td>
                <td className="num">{fmtPct(p.pmem, 1)}</td>
                <td className="mono ellipsis-cell" title={p.comm}>{p.comm}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Sec>
    </>
  );
}

// ---------- Network ----------

interface Listen {
  proto: string;
  addr: string;
  port: number;
  proc: string;
}
interface NetData {
  summary: { total?: number; tcp?: number; pairs: [string, number][]; table: string[][]; raw: string[] };
  listen: Listen[];
}

const NET_CMD = `ss -s 2>/dev/null; echo ${SEP}; ss -tulnpH 2>/dev/null || netstat -tulnp 2>/dev/null`;

function splitAddr(s: string): [string, number] {
  const i = s.lastIndexOf(":");
  if (i < 0) return [s, 0];
  const a = s.slice(0, i).replace(/^\[|\]$/g, "");
  return [a, Number(s.slice(i + 1)) || 0];
}

function parseNet(out: string): NetData {
  const [ssS, ls] = parts(out, 2);
  const raw = lines(ssS);
  const summary: NetData["summary"] = { pairs: [], table: [], raw };
  for (const l of raw) {
    let m = /^Total:\s*(\d+)/.exec(l);
    if (m) summary.total = Number(m[1]);
    m = /^TCP:\s*(\d+)\s*\((.*)\)/.exec(l);
    if (m) {
      summary.tcp = Number(m[1]);
      for (const p of m[2].split(",")) {
        const mm = /([a-z/]+)\s+(\d+)/i.exec(p.trim());
        if (mm) summary.pairs.push([mm[1], Number(mm[2])]);
      }
    }
    if (/^(Transport|RAW|UDP|TCP|INET|FRAG)\s/.test(l) && !/^TCP:/.test(l)) summary.table.push(fields(l));
  }

  const listen: Listen[] = [];
  for (const l of lines(ls)) {
    const f = fields(l);
    if (/^(Proto|Active|Netid|State)/.test(f[0])) continue;
    if (/^(tcp|udp)/.test(f[0]) && f.length >= 5 && /^\d+$/.test(f[1]) && /^\d+$/.test(f[2])) {
      // netstat: Proto Recv-Q Send-Q Local Foreign [State] PID/Program
      const [addr, port] = splitAddr(f[3]);
      const [pid, ...nm] = f[f.length - 1].split("/");
      listen.push({ proto: f[0], addr, port, proc: nm.length ? `${nm.join("/")}(${pid})` : "-" });
    } else if (/^(tcp|udp)$/.test(f[0]) && f.length >= 6) {
      // ss -tulnpH: Netid State Recv-Q Send-Q Local Peer [Process]
      const [addr, port] = splitAddr(f[4]);
      const procs = [...l.matchAll(/\("([^"]+)",pid=(\d+)/g)].map((m) => `${m[1]}(${m[2]})`);
      listen.push({ proto: f[0], addr, port, proc: [...new Set(procs)].join(", ") || "-" });
    }
  }
  listen.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto) || a.addr.localeCompare(b.addr));
  return { summary, listen };
}

function NetView({ history, cur }: { history: Sample[]; cur: Sample }) {
  const ts = useSeries(history, (s) => s.ts);
  const rx = useSeries(history, (s) => s.rxRate);
  const tx = useSeries(history, (s) => s.txRate);
  const r = useExec(NET_CMD, parseNet);
  const sum = r.data?.summary;

  return (
    <>
      <AreaChart
        series={[
          { label: "下行", values: rx, color: "var(--chart-2)" },
          { label: "上行", values: tx, color: "var(--chart-1)" },
        ]}
        ts={ts}
        floor={1024}
        bytes
        fmt={fmtRate}
        axisFmt={rateAxis}
        span={SPAN}
      />
      <Sec title="网卡" meta={cur.nets.length}>
        <table className="table mon-d-table">
          <colgroup>
            <col />
            <col style={{ width: 120 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 120 }} />
          </colgroup>
          <thead>
            <tr>
              <th>名称</th>
              <th className="num">下行</th>
              <th className="num">上行</th>
              <th className="num">总接收</th>
              <th className="num">总发送</th>
            </tr>
          </thead>
          <tbody>
            {cur.nets.map((n) => (
              <tr key={n.name}>
                <td className="mono ellipsis-cell">{n.name}</td>
                <td className="num">{fmtRate(n.rxRate)}</td>
                <td className="num">{fmtRate(n.txRate)}</td>
                <td className="num faint">{fmtBytes(n.rxTotal)}</td>
                <td className="num faint">{fmtBytes(n.txTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Sec>
      <Sec title="连接" error={r.error}>
        {sum && (sum.total !== undefined || sum.tcp !== undefined) ? (
          <>
            <div className="mon-stats">
              {sum.total !== undefined && <Stat label="套接字" value={sum.total} />}
              {sum.tcp !== undefined && <Stat label="TCP" value={sum.tcp} />}
              {sum.pairs.map(([k, v]) => (
                <Stat key={k} label={k} value={v} />
              ))}
            </div>
            {sum.table.length > 1 && (
              <table className="table mon-d-table mon-d-ss">
                <thead>
                  <tr>
                    {sum.table[0].map((h, i) => (
                      <th key={i} className={i ? "num" : undefined}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sum.table.slice(1).map((row) => (
                    <tr key={row[0]}>
                      {row.map((c, i) => (
                        <td key={i} className={i ? "num" : "mono"}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : sum && sum.raw.length ? (
          <pre className="mon-d-pre selectable">{sum.raw.join("\n")}</pre>
        ) : null}
      </Sec>
      <Sec title="监听端口" meta={r.data ? r.data.listen.length : undefined}>
        <table className="table mon-d-table">
          <colgroup>
            <col style={{ width: 72 }} />
            <col style={{ width: 240 }} />
            <col style={{ width: 80 }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>协议</th>
              <th>地址</th>
              <th className="num">端口</th>
              <th>进程</th>
            </tr>
          </thead>
          <tbody>
            {(r.data?.listen ?? []).map((x, i) => (
              <tr key={i}>
                <td className="faint">{x.proto}</td>
                <td className="mono ellipsis-cell" title={x.addr}>{x.addr}</td>
                <td className="num mono">{x.port}</td>
                <td className="mono ellipsis-cell" title={x.proc}>{x.proc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Sec>
    </>
  );
}

// ---------- Disk IO ----------

interface DiskStat {
  name: string;
  reads: number;
  sectorsRead: number;
  writes: number;
  sectorsWritten: number;
  ioTicks: number;
}
interface IoSnap {
  t: number; // seconds (uptime)
  devs: DiskStat[];
}

const IO_CMD = `cat /proc/uptime; echo ${SEP}; ls /sys/block 2>/dev/null; echo ${SEP}; cat /proc/diskstats`;

function parseIo(out: string): IoSnap {
  const [up, blk, ds] = parts(out, 3);
  const t = parseFloat(up.trim().split(/\s+/)[0]) || Date.now() / 1000;
  const whole = new Set(lines(blk).flatMap(fields));
  const devs: DiskStat[] = [];
  for (const l of lines(ds)) {
    const f = fields(l);
    if (f.length < 14) continue;
    const name = f[2];
    if (whole.size ? !whole.has(name) : /\d$/.test(name) && !/^nvme\d+n\d+$/.test(name)) continue;
    if (/^(loop|ram|zram|fd)\d*/.test(name)) continue;
    devs.push({
      name,
      reads: Number(f[3]),
      sectorsRead: Number(f[5]),
      writes: Number(f[7]),
      sectorsWritten: Number(f[9]),
      ioTicks: Number(f[12]),
    });
  }
  return { t, devs };
}

function IoView({ history }: { history: Sample[] }) {
  const ts = useSeries(history, (s) => s.ts);
  const rd = useSeries(history, (s) => s.readRate);
  const wr = useSeries(history, (s) => s.writeRate);
  const r = useExec(IO_CMD, parseIo);
  const { refresh } = useContext(DetailCtx);
  const [pair, setPair] = useState<{ prev: IoSnap | null; cur: IoSnap | null }>({ prev: null, cur: null });

  useEffect(() => {
    if (r.data) setPair((p) => (p.cur === r.data ? p : { prev: p.cur, cur: r.data }));
  }, [r.data]);
  // Rates need two snapshots: take the second one quickly instead of waiting a full poll.
  useEffect(() => {
    if (pair.cur && !pair.prev) {
      const t = window.setTimeout(refresh, 1000);
      return () => window.clearTimeout(t);
    }
  }, [pair, refresh]);

  const rows = useMemo(() => {
    const { prev, cur } = pair;
    if (!cur) return [];
    const dt = prev ? cur.t - prev.t : 0;
    return cur.devs.map((d) => {
      const p = prev?.devs.find((x) => x.name === d.name);
      if (!p || dt <= 0) return { name: d.name, rps: NaN, wps: NaN, rbs: NaN, wbs: NaN, busy: NaN };
      return {
        name: d.name,
        rps: Math.max(0, d.reads - p.reads) / dt,
        wps: Math.max(0, d.writes - p.writes) / dt,
        rbs: (Math.max(0, d.sectorsRead - p.sectorsRead) * 512) / dt,
        wbs: (Math.max(0, d.sectorsWritten - p.sectorsWritten) * 512) / dt,
        busy: Math.min(100, Math.max(0, d.ioTicks - p.ioTicks) / (dt * 10)),
      };
    });
  }, [pair]);

  const n = (v: number, f: (x: number) => string) => (isNaN(v) ? "-" : f(v));
  return (
    <>
      <AreaChart
        series={[
          { label: "读", values: rd, color: "var(--chart-2)" },
          { label: "写", values: wr, color: "var(--chart-4)" },
        ]}
        ts={ts}
        floor={4096}
        bytes
        fmt={fmtRate}
        axisFmt={rateAxis}
        span={SPAN}
      />
      <Sec title="设备" meta={rows.length || undefined} error={r.error}>
        <table className="table mon-d-table">
          <colgroup>
            <col />
            <col style={{ width: 96 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 80 }} />
          </colgroup>
          <thead>
            <tr>
              <th>设备</th>
              <th className="num">读次/s</th>
              <th className="num">写次/s</th>
              <th className="num">读取</th>
              <th className="num">写入</th>
              <th className="num">繁忙</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.name}>
                <td className="mono">{d.name}</td>
                <td className="num">{n(d.rps, (x) => x.toFixed(1))}</td>
                <td className="num">{n(d.wps, (x) => x.toFixed(1))}</td>
                <td className="num">{n(d.rbs, fmtRate)}</td>
                <td className="num">{n(d.wbs, fmtRate)}</td>
                <td className="num" style={{ color: isNaN(d.busy) ? undefined : pctColor(d.busy) }}>{n(d.busy, (x) => fmtPct(x, 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Sec>
    </>
  );
}

// ---------- Disks ----------

interface Mount {
  fs: string;
  type: string;
  total: number;
  used: number;
  avail: number;
  mount: string;
  ipct: number | null;
}

const DF_CMD = `df -PTk; echo ${SEP}; df -iP`;
const PSEUDO_FS = /^(tmpfs|devtmpfs|squashfs|efivarfs|overlay|proc|sysfs|cgroup2?|devpts|ramfs)$/;

function parseDf(out: string): Mount[] {
  const [sz, ino] = parts(out, 2);
  const inodes = new Map<string, number>();
  for (const l of lines(ino).slice(1)) {
    const f = fields(l);
    if (f.length < 6) continue;
    const p = parseInt(f[4], 10);
    if (!isNaN(p)) inodes.set(f.slice(5).join(" "), p);
  }
  const out2: Mount[] = [];
  for (const l of lines(sz).slice(1)) {
    const f = fields(l);
    if (f.length < 7 || PSEUDO_FS.test(f[1])) continue;
    const mount = f.slice(6).join(" ");
    out2.push({
      fs: f[0],
      type: f[1],
      total: Number(f[2]) * 1024,
      used: Number(f[3]) * 1024,
      avail: Number(f[4]) * 1024,
      mount,
      ipct: inodes.get(mount) ?? null,
    });
  }
  return out2;
}

/** "1.5G" → bytes, for proportional bars in the du list. */
function parseHuman(s: string): number {
  const m = /^([\d.]+)([KMGTPE]?)/i.exec(s);
  if (!m) return 0;
  const k = "BKMGTPE".indexOf((m[2] || "B").toUpperCase());
  return parseFloat(m[1]) * Math.pow(1024, Math.max(0, k));
}

function DiskView() {
  const { hostId } = useContext(DetailCtx);
  const r = useExec(DF_CMD, parseDf);
  const mounts = r.data ?? [];
  const [sel, setSel] = useState("");
  const [du, setDu] = useState<{ mount: string; rows: { size: string; bytes: number; path: string }[] } | null>(null);
  const [duBusy, setDuBusy] = useState(false);
  const [duErr, setDuErr] = useState<string | null>(null);
  const target = sel || mounts.find((m) => m.mount === "/")?.mount || mounts[0]?.mount || "/";

  const scan = async () => {
    setDuBusy(true);
    setDuErr(null);
    try {
      const res = await api.execRun(hostId, `du -xh --max-depth=1 ${shq(target)} 2>/dev/null | sort -rh | head -20`, 60);
      if (res.timedOut) setDuErr("执行超时");
      const rows = lines(res.stdout).map((l) => {
        const i = l.search(/\s/);
        const size = l.slice(0, i);
        return { size, bytes: parseHuman(size), path: l.slice(i).trim() };
      });
      if (!rows.length && !res.timedOut) setDuErr((res.stderr || "无结果").trim().split("\n")[0]);
      setDu({ mount: target, rows });
    } catch (e) {
      setDuErr(errMsg(e));
    } finally {
      setDuBusy(false);
    }
  };

  const maxBytes = du?.rows[0]?.bytes || 1;
  return (
    <>
      <Sec title="挂载点" meta={mounts.length || undefined} error={r.error}>
        <table className="table mon-d-table">
          <colgroup>
            <col />
            <col style={{ width: 80 }} />
            <col style={{ width: 88 }} />
            <col style={{ width: 88 }} />
            <col style={{ width: 88 }} />
            <col style={{ width: 160 }} />
            <col style={{ width: 72 }} />
          </colgroup>
          <thead>
            <tr>
              <th>挂载点</th>
              <th>类型</th>
              <th className="num">总量</th>
              <th className="num">已用</th>
              <th className="num">可用</th>
              <th className="num">使用率</th>
              <th className="num">inode</th>
            </tr>
          </thead>
          <tbody>
            {mounts.map((m) => {
              const used = m.used + m.avail ? (m.used / (m.used + m.avail)) * 100 : 0;
              return (
                <tr key={m.mount + m.fs}>
                  <td className="mono ellipsis-cell" title={`${m.fs} → ${m.mount}`}>{m.mount}</td>
                  <td className="faint ellipsis-cell">{m.type}</td>
                  <td className="num">{fmtBytes(m.total)}</td>
                  <td className="num">{fmtBytes(m.used)}</td>
                  <td className="num">{fmtBytes(m.avail)}</td>
                  <td>
                    <div className="mon-d-usage">
                      <Bar value={used} />
                      <span className="num" style={{ color: pctColor(used) }}>{fmtPct(used, 0)}</span>
                    </div>
                  </td>
                  <td className="num" style={{ color: m.ipct === null ? undefined : pctColor(m.ipct) }}>
                    {m.ipct === null ? "-" : fmtPct(m.ipct, 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Sec>
      <Sec title="大文件">
        <div className="row">
          <select className="select sm mon-d-select" value={target} onChange={(e) => setSel(e.target.value)} disabled={duBusy}>
            {mounts.map((m) => (
              <option key={m.mount} value={m.mount}>{m.mount}</option>
            ))}
          </select>
          <button className="btn sm" disabled={duBusy || !mounts.length} onClick={scan}>
            {duBusy ? <LoaderCircle className="mon-spin" /> : <FolderSearch />}
            查找大文件
          </button>
          {duBusy && <span className="faint mon-d-hint">最长 60 秒</span>}
        </div>
        {duErr && <div className="mon-d-err selectable">{duErr}</div>}
        {du && du.rows.length > 0 && (
          <div className="mon-du selectable">
            {du.rows.map((x) => (
              <div className="mon-du-row" key={x.path}>
                <span className="num">{x.size}</span>
                <div className="mon-du-bar">
                  <i style={{ width: `${Math.min(100, (x.bytes / maxBytes) * 100)}%` }} />
                </div>
                <span className={"mono ellipsis" + (x.path === du.mount ? " faint" : "")} title={x.path}>{x.path}</span>
              </div>
            ))}
          </div>
        )}
      </Sec>
    </>
  );
}

// ---------- Processes ----------

interface PRow {
  pid: number;
  ppid: number;
  user: string;
  cpu: number;
  mem: number;
  rss: number;
  etime: string;
  secs: number;
  stat: string;
  args: string;
}
type SortKey = "pid" | "ppid" | "user" | "cpu" | "mem" | "rss" | "secs" | "stat" | "args";

const PS_CMD = "ps -eo pid,ppid,user:32,pcpu,pmem,rss,etime,stat,args --sort=-pcpu | head -301";

function etimeSecs(s: string): number {
  // [[dd-]hh:]mm:ss
  const [d, rest] = s.includes("-") ? s.split("-") : ["0", s];
  const p = rest.split(":").map(Number);
  while (p.length < 3) p.unshift(0);
  return Number(d) * 86400 + p[0] * 3600 + p[1] * 60 + p[2];
}

function parsePs(out: string): PRow[] {
  return lines(out)
    .slice(1)
    .map((l) => {
      const f = fields(l);
      return {
        pid: Number(f[0]),
        ppid: Number(f[1]),
        user: f[2],
        cpu: Number(f[3]),
        mem: Number(f[4]),
        rss: Number(f[5]) * 1024,
        etime: f[6],
        secs: etimeSecs(f[6] ?? "0"),
        stat: f[7],
        args: f.slice(8).join(" "),
      };
    })
    .filter((p) => p.pid > 0);
}

const PS_COLS: { key: SortKey; label: string; width?: number; num?: boolean }[] = [
  { key: "pid", label: "PID", width: 72, num: true },
  { key: "ppid", label: "PPID", width: 72, num: true },
  { key: "user", label: "用户", width: 96 },
  { key: "cpu", label: "CPU", width: 64, num: true },
  { key: "mem", label: "内存", width: 64, num: true },
  { key: "rss", label: "RSS", width: 88, num: true },
  { key: "secs", label: "运行", width: 96, num: true },
  { key: "stat", label: "状态", width: 56 },
  { key: "args", label: "命令" },
];

function ProcView() {
  const { hostId, refresh } = useContext(DetailCtx);
  const r = useExec(PS_CMD, parsePs);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "cpu", desc: true });
  const [target, setTarget] = useState<{ p: PRow; force: boolean } | null>(null);
  const [gone, setGone] = useState<Set<number>>(new Set());

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (r.data ?? []).filter(
      (p) =>
        !gone.has(p.pid) &&
        (!needle || p.args.toLowerCase().includes(needle) || p.user.toLowerCase().includes(needle) || String(p.pid) === needle),
    );
    const k = sort.key;
    list.sort((a, b) => {
      const av = a[k];
      const bv = b[k];
      const c = typeof av === "number" ? av - (bv as number) : String(av).localeCompare(String(bv));
      return sort.desc ? -c : c;
    });
    return list;
  }, [r.data, q, sort, gone]);

  useEffect(() => setGone(new Set()), [r.data]);

  const clickHead = (key: SortKey, num?: boolean) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: !!num }));

  const kill = async () => {
    if (!target) return;
    const { p, force } = target;
    setTarget(null);
    try {
      const res = await api.execRun(hostId, `kill ${force ? "-9 " : ""}${p.pid}`, 10);
      if (res.exitCode !== 0) {
        toast((res.stderr || res.stdout || `退出码 ${res.exitCode}`).trim(), "error");
      } else {
        toast(`已向 ${p.pid} 发送 ${force ? "SIGKILL" : "SIGTERM"}`, "success");
        setGone((g) => new Set(g).add(p.pid));
        window.setTimeout(refresh, 600);
      }
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  return (
    <Sec
      title={
        <>
          进程 <span className="count">{rows.length}</span>
        </>
      }
      meta={
        <input className="input sm mon-d-filter" placeholder="nginx" value={q} onChange={(e) => setQ(e.target.value)} />
      }
      error={r.error}
    >
      <table className="table mon-d-table mon-d-procs">
        <colgroup>
          {PS_COLS.map((c) => (
            <col key={c.key} style={c.width ? { width: c.width } : undefined} />
          ))}
          <col style={{ width: 64 }} />
        </colgroup>
        <thead>
          <tr>
            {PS_COLS.map((c) => (
              <th key={c.key} className={"sortable" + (c.num ? " num" : "")} onClick={() => clickHead(c.key, c.num)}>
                <span className="th-in">
                  {c.label}
                  {sort.key === c.key && (sort.desc ? <ChevronDown /> : <ChevronUp />)}
                </span>
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.pid}>
              <td className="num mono faint">{p.pid}</td>
              <td className="num mono faint">{p.ppid}</td>
              <td className="ellipsis-cell" title={p.user}>{p.user}</td>
              <td className="num" style={{ color: pctColor(p.cpu) }}>{p.cpu.toFixed(1)}</td>
              <td className="num">{p.mem.toFixed(1)}</td>
              <td className="num">{fmtBytes(p.rss, 0)}</td>
              <td className="num faint">{p.etime}</td>
              <td className="mono faint">{p.stat}</td>
              <td className="mono ellipsis-cell" title={p.args}>{p.args}</td>
              <td className="act">
                <button className="icon-btn" title="结束" onClick={() => setTarget({ p, force: false })}>
                  <X />
                </button>
                <button className="icon-btn" title="强制结束" onClick={() => setTarget({ p, force: true })}>
                  <Skull />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {target && (
        <Confirm
          title={target.force ? "强制结束进程" : "结束进程"}
          danger
          confirmText={target.force ? "强制结束" : "结束"}
          message={
            <>
              {target.force ? "发送 SIGKILL 给" : "发送 SIGTERM 给"} <span className="mono">{target.p.args.slice(0, 120)}</span>（PID{" "}
              <span className="mono">{target.p.pid}</span>）？
            </>
          }
          onConfirm={kill}
          onCancel={() => setTarget(null)}
        />
      )}
    </Sec>
  );
}
