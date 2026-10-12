// Configurable monitor cards: metric (trend / gauge / number), mount point, NIC, command output,
// systemd service status, app / container usage and a note. Built-in sections live in MonitorPanel.
import { ArrowDown, ArrowUp, ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Bar, TweenNum } from "../../components/ui";
import { api, errMsg, type Sample, type SysInfo } from "../../lib/api";
import { fmtBytes, fmtRate } from "../../lib/format";
import { levelColor, pctColor, PCT_ERR, PCT_WARN } from "../../lib/level";
import { shq } from "../../lib/remote";
import { type CardInst, cardTitle, DEFAULT_APPS, METRICS, type MetricKey, upsertCard } from "./cards";
import type { DetailKind } from "./MonitorDetail";
import { Sparkline } from "./Sparkline";

export interface CardCtx {
  hostId: string;
  history: Sample[];
  cur: Sample;
  info: SysInfo | null;
  open: (k: DetailKind) => void;
}

/** Props that make a block open a detail dialog (click or Enter/Space). */
export function linkProps(open: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: open,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        open();
      }
    },
  };
}

export const Go = () => <ChevronRight className="mon-go" />;

/** Cards whose sparkline sits flush with the bottom edge. */
export const isTile = (c: CardInst) =>
  (c.type === "metric" && (c.cfg.view ?? "trend") === "trend") || (c.type === "command" && c.cfg.output === "number");

export function metricThresholds(c: CardInst) {
  const pct = METRICS[c.cfg.metric ?? "cpu"].pct;
  return { warn: c.cfg.warn ?? (pct ? PCT_WARN : undefined), err: c.cfg.err ?? (pct ? PCT_ERR : undefined) };
}

/** Gauge only makes sense with a fixed maximum. */
export function gaugeMax(metric: MetricKey, cur: Sample, info: SysInfo | null) {
  if (METRICS[metric].pct) return 100;
  if (metric.startsWith("load")) return cur.cores.length || info?.cores || 1;
  return 0;
}

export function MetricCard({ card, ctx }: { card: CardInst; ctx: CardCtx }) {
  const key = card.cfg.metric ?? "cpu";
  const base = METRICS[key];
  const { cur, history, info } = ctx;
  // rx / tx can follow a single NIC instead of the total.
  const nic = (key === "rx" || key === "tx") && card.cfg.nic ? card.cfg.nic : "";
  const m = useMemo(
    () =>
      nic
        ? { ...base, get: (s: Sample) => s.nets.find((n) => n.name === nic)?.[key === "rx" ? "rxRate" : "txRate"] ?? 0, sub: () => nic }
        : base,
    [base, nic, key],
  );
  const v = m.get(cur, info);
  const values = useMemo(() => history.map((s) => m.get(s, info)), [history, m, info]);
  const { warn, err } = metricThresholds(card);
  const color = `var(--chart-${card.cfg.color ?? 1})`;
  const tone = levelColor(v, warn, err);
  const max = gaugeMax(key, cur, info);
  const view = card.cfg.view === "gauge" && !max ? "trend" : card.cfg.view ?? "trend";
  const sub = m.sub?.(cur, info) ?? "";
  const valueFmt = m.pct ? fmt0 : m.fmt;

  return (
    <div className={"mon-tile link v-" + view} {...linkProps(() => ctx.open(m.detail))}>
      <span className="lbl">
        <span className="ellipsis">{cardTitle(card)}</span>
        <Go />
      </span>
      {view === "gauge" ? (
        <Gauge value={v} max={max} color={tone ?? color}>
          <TweenNum className="gauge-val" value={v} fmt={valueFmt} style={{ color: tone }} />
          {m.pct && <small>%</small>}
        </Gauge>
      ) : (
        <span className={"big" + (m.pct ? "" : " long")} style={{ color: tone }}>
          <TweenNum value={v} fmt={valueFmt} />
          {m.pct && <small>%</small>}
        </span>
      )}
      {sub && <span className="sub ellipsis" title={sub}>{sub}</span>}
      {view === "trend" && <Sparkline series={[{ values, color }]} max={m.pct ? 100 : undefined} floor={m.pct ? undefined : 1} height={28} />}
    </div>
  );
}

const fmt0 = (v: number) => v.toFixed(0);

/** 270° ring gauge. */
export function Gauge(props: { value: number; max: number; color: string; children?: React.ReactNode }) {
  const r = 34;
  const len = 2 * Math.PI * r * 0.75;
  const frac = Math.max(0, Math.min(1, props.value / (props.max || 1)));
  return (
    <div className="mon-gauge">
      <svg viewBox="0 0 80 80">
        <circle className="track" cx="40" cy="40" r={r} strokeDasharray={`${len} 999`} />
        <circle
          className="fill"
          cx="40"
          cy="40"
          r={r}
          stroke={props.color}
          strokeDasharray={`${len} 999`}
          strokeDashoffset={len * (1 - frac)}
        />
      </svg>
      <span className="mon-gauge-text">{props.children}</span>
    </div>
  );
}

export function DiskCard({ card, ctx }: { card: CardInst; ctx: CardCtx }) {
  const d = ctx.cur.disks.find((x) => x.mount === card.cfg.mount);
  const pct = d && d.total ? (d.used / d.total) * 100 : 0;
  const tone = levelColor(pct, card.cfg.warn ?? PCT_WARN, card.cfg.err ?? PCT_ERR);
  return (
    <div className="mon-tile link v-gauge" {...linkProps(() => ctx.open("disk"))}>
      <span className="lbl">
        <span className="ellipsis mono">{cardTitle(card)}</span>
        <Go />
      </span>
      {d ? (
        <>
          <Gauge value={pct} max={100} color={tone ?? `var(--chart-${card.cfg.color ?? 4})`}>
            <TweenNum className="gauge-val" value={pct} fmt={fmt0} style={{ color: tone }} />
            <small>%</small>
          </Gauge>
          <span className="sub ellipsis" title={d.fs}>
            {fmtBytes(d.used)} / {fmtBytes(d.total)}
          </span>
        </>
      ) : (
        <span className="sub">未找到挂载点</span>
      )}
    </div>
  );
}

export function NicCard({ card, ctx }: { card: CardInst; ctx: CardCtx }) {
  const name = card.cfg.nic;
  const n = ctx.cur.nets.find((x) => x.name === name);
  const rx = useMemo(() => ctx.history.map((s) => s.nets.find((x) => x.name === name)?.rxRate ?? 0), [ctx.history, name]);
  const tx = useMemo(() => ctx.history.map((s) => s.nets.find((x) => x.name === name)?.txRate ?? 0), [ctx.history, name]);
  return (
    <div className="mon-sec link" {...linkProps(() => ctx.open("net"))}>
      <div className="section-title">
        <span className="ellipsis mono">{cardTitle(card)}</span>
        <Go />
      </div>
      {n ? (
        <>
          <div className="mon-rate">
            <ArrowDown className="c2" />
            <TweenNum className="ellipsis" title="下行" value={n.rxRate} fmt={fmtRate} />
            <ArrowUp className="c1" />
            <TweenNum className="ellipsis" title="上行" value={n.txRate} fmt={fmtRate} />
          </div>
          <div className="mon-chart">
            <Sparkline
              series={[
                { values: rx, color: "var(--chart-2)" },
                { values: tx, color: "var(--chart-1)" },
              ]}
              floor={1024}
              height={36}
            />
          </div>
          <div className="mon-nic-kv">
            <span>累计下行</span>
            <span className="num">{fmtBytes(n.rxTotal)}</span>
            <span>累计上行</span>
            <span className="num">{fmtBytes(n.txTotal)}</span>
          </div>
        </>
      ) : (
        <div className="mon-muted">未找到网卡</div>
      )}
    </div>
  );
}

// ---------- polled commands ----------

interface PollState {
  out: string;
  error: string | null;
  at: number;
  busy: boolean;
}

/**
 * Runs `command` on the host every `interval` seconds while mounted and the window is visible.
 * Only the first run of a command is written to the audit log.
 */
export function usePoll(hostId: string, command: string, interval: number, onValue?: (out: string) => void) {
  const [st, setSt] = useState<PollState>({ out: "", error: null, at: 0, busy: false });
  const [tick, setTick] = useState(0);
  const cb = useRef(onValue);
  cb.current = onValue;

  useEffect(() => {
    if (!command.trim()) {
      setSt({ out: "", error: null, at: 0, busy: false });
      return;
    }
    let alive = true;
    let timer = 0;
    let first = true;
    const run = async () => {
      if (document.hidden) {
        timer = window.setTimeout(run, 1000);
        return;
      }
      setSt((s) => ({ ...s, busy: true }));
      try {
        const r = await api.execRun(hostId, command, Math.min(30, Math.max(5, interval)), !first);
        if (!alive) return;
        first = false;
        const failed = r.exitCode !== 0 && !r.stdout.trim();
        const out = r.stdout.replace(/\s+$/, "");
        setSt({
          out,
          error: failed ? (r.stderr.trim() || (r.timedOut ? "超时" : `退出码 ${r.exitCode}`)) : null,
          at: Date.now(),
          busy: false,
        });
        if (!failed) cb.current?.(out);
      } catch (e) {
        if (!alive) return;
        setSt((s) => ({ ...s, error: errMsg(e), at: Date.now(), busy: false }));
      }
      if (alive) timer = window.setTimeout(run, Math.max(5, interval) * 1000);
    };
    run();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [hostId, command, interval, tick]);

  return { ...st, refresh: () => setTick((t) => t + 1) };
}

const hhmmss = (t: number) => (t ? new Date(t).toLocaleTimeString("zh-CN", { hour12: false }) : "");

function PollHead(props: { title: string; at: number; busy: boolean; refresh: () => void }) {
  return (
    <div className="section-title">
      <span className="ellipsis">{props.title}</span>
      <span className="meta">{hhmmss(props.at)}</span>
      <button
        className="icon-btn mon-refresh"
        title={props.at ? `刷新（${hhmmss(props.at)}）` : "刷新"}
        disabled={props.busy}
        onClick={(e) => {
          e.stopPropagation();
          props.refresh();
        }}
      >
        {props.busy ? <LoaderCircle className="spin" /> : <RefreshCw />}
      </button>
    </div>
  );
}

export function CommandCard({ card, ctx }: { card: CardInst; ctx: CardCtx }) {
  const cfg = card.cfg;
  const isNum = cfg.output === "number";
  const [series, setSeries] = useState<number[]>([]);
  useEffect(() => setSeries([]), [cfg.command, ctx.hostId]);
  const p = usePoll(ctx.hostId, cfg.command ?? "", cfg.interval ?? 30, (out) => {
    if (!isNum) return;
    const n = parseNum(out);
    if (n !== null) setSeries((s) => [...s.slice(-59), n]);
  });

  if (!cfg.command?.trim())
    return (
      <div className="mon-sec">
        <div className="section-title">{cardTitle(card)}</div>
        <div className="mon-muted">右键编辑以设置命令</div>
      </div>
    );

  if (isNum) {
    const v = parseNum(p.out);
    const tone = v === null ? undefined : levelColor(v, cfg.warn, cfg.err);
    return (
      <div className="mon-tile">
        <PollHead title={cardTitle(card)} at={p.at} busy={p.busy} refresh={p.refresh} />
        {p.error ? (
          <span className="sub err ellipsis selectable" title={p.error}>{p.error}</span>
        ) : (
          <span className="big long" style={{ color: tone }}>
            {v === null ? "-" : <TweenNum value={v} fmt={fmtAuto} />}
            {cfg.unit && <small>{cfg.unit}</small>}
          </span>
        )}
        <Sparkline series={[{ values: series, color: `var(--chart-${cfg.color ?? 1})` }]} floor={1} height={28} />
      </div>
    );
  }

  const lines = p.out ? p.out.split("\n") : [];
  const max = cfg.lines ?? 6;
  return (
    <div className="mon-sec">
      <PollHead title={cardTitle(card)} at={p.at} busy={p.busy} refresh={p.refresh} />
      {p.error ? (
        <pre className="mon-out err selectable">{p.error}</pre>
      ) : (
        <pre className="mon-out selectable" title={lines.length > max ? `共 ${lines.length} 行` : undefined}>
          {p.at ? (lines.length ? lines.slice(0, max).join("\n") : "(无输出)") : "…"}
          {lines.length > max && <span className="more">{`\n… 另有 ${lines.length - max} 行`}</span>}
        </pre>
      )}
    </div>
  );
}

function parseNum(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
const fmtAuto = (v: number) => (Number.isInteger(v) || Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));

// ---------- GPU ----------

const GPU_CMD =
  "command -v nvidia-smi >/dev/null 2>&1 || { echo NO_GPU; exit 0; }; " +
  "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits";

interface Gpu {
  index: string;
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  temp: number;
  power: number;
  powerLimit: number;
}

function parseGpus(out: string): Gpu[] {
  const n = (s: string | undefined) => {
    const v = Number(s?.trim());
    return Number.isFinite(v) ? v : NaN;
  };
  return out
    .split("\n")
    .map((l) => l.split(","))
    .filter((f) => f.length >= 5)
    .map((f) => ({
      index: f[0].trim(),
      name: f[1].trim().replace(/^NVIDIA\s+/, ""),
      util: n(f[2]),
      memUsed: n(f[3]) * 1024 * 1024,
      memTotal: n(f[4]) * 1024 * 1024,
      temp: n(f[5]),
      power: n(f[6]),
      powerLimit: n(f[7]),
    }));
}

const GPU_COLORS = [1, 2, 3, 4] as const;

export function GpuCard({ card, ctx }: { card: CardInst; ctx: CardCtx }) {
  const [hist, setHist] = useState<Record<string, number[]>>({});
  useEffect(() => setHist({}), [ctx.hostId]);
  const p = usePoll(ctx.hostId, GPU_CMD, card.cfg.interval ?? 5, (out) => {
    const gpus = parseGpus(out);
    setHist((h) => {
      const next: Record<string, number[]> = {};
      for (const g of gpus) next[g.index] = [...(h[g.index] ?? []).slice(-59), Number.isNaN(g.util) ? 0 : g.util];
      return next;
    });
  });
  const none = p.out.trim() === "NO_GPU";
  const gpus = none ? [] : parseGpus(p.out);
  const series = gpus.map((g, i) => ({ values: hist[g.index] ?? [], color: `var(--chart-${GPU_COLORS[i % 4]})` }));

  return (
    <div className="mon-sec">
      <PollHead title={cardTitle(card)} at={p.at} busy={p.busy} refresh={p.refresh} />
      {p.error ? (
        <div className="mon-muted err selectable">{p.error}</div>
      ) : none ? (
        <div className="mon-muted">未检测到 NVIDIA GPU</div>
      ) : !p.at ? (
        <div className="mon-muted">…</div>
      ) : (
        <>
          {series.some((s) => s.values.length > 1) && (
            <div className="mon-chart">
              <Sparkline series={series} max={100} height={36} />
            </div>
          )}
          <div>
            {gpus.map((g, i) => {
              const memPct = g.memTotal ? (g.memUsed / g.memTotal) * 100 : 0;
              return (
                <div className="mon-gpu" key={g.index}>
                  <div className="mon-disk-head">
                    <span className="ellipsis" title={g.name}>
                      <span className="dot" style={{ background: series[i].color }} />
                      {g.index} · {g.name}
                    </span>
                    <span className="size">
                      {Number.isNaN(g.temp) ? "" : <span style={{ color: levelColor(g.temp, 75, 85) }}>{g.temp}°C</span>}
                      {!Number.isNaN(g.power) && (
                        <>
                          {"  "}
                          {g.power.toFixed(0)}
                          {Number.isNaN(g.powerLimit) ? "" : ` / ${g.powerLimit.toFixed(0)}`} W
                        </>
                      )}
                    </span>
                    <span className="pct" style={{ color: levelColor(g.util, 75, 90) }}>
                      {Number.isNaN(g.util) ? "-" : `${g.util.toFixed(0)}%`}
                    </span>
                  </div>
                  <Bar value={Number.isNaN(g.util) ? 0 : g.util} thin />
                  <div className="mon-disk-head mon-gpu-mem">
                    <span>显存</span>
                    <span className="size">
                      {fmtBytes(g.memUsed)} / {fmtBytes(g.memTotal)}
                    </span>
                    <span className="pct" style={{ color: pctColor(memPct) }}>{memPct.toFixed(0)}%</span>
                  </div>
                  <Bar value={memPct} thin />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const SERVICE_RE = /^[\w@.:-]+$/;
export const parseServices = (s: string) =>
  s
    .split(/[\s,，]+/)
    .map((x) => x.trim())
    .filter((x) => x && SERVICE_RE.test(x));

export function ServiceCard({ card, ctx }: { card: CardInst; ctx: CardCtx }) {
  const names = parseServices(card.cfg.services ?? "");
  // Names are validated against SERVICE_RE, so they are safe to splice into the shell command.
  const command = names.length
    ? `for s in ${names.join(" ")}; do printf '%s ' "$s"; systemctl is-active "$s" 2>/dev/null || true; done`
    : "";
  const p = usePoll(ctx.hostId, command, card.cfg.interval ?? 30);
  const states = new Map<string, string>();
  for (const line of p.out.split("\n")) {
    const [n, st] = line.trim().split(/\s+/);
    if (n) states.set(n, st || "unknown");
  }
  if (!names.length)
    return (
      <div className="mon-sec">
        <div className="section-title">{cardTitle(card)}</div>
        <div className="mon-muted">右键编辑以添加服务</div>
      </div>
    );
  const up = names.filter((n) => states.get(n) === "active").length;
  return (
    <div className="mon-sec">
      <PollHead title={cardTitle(card)} at={p.at} busy={p.busy} refresh={p.refresh} />
      {p.error && <div className="mon-muted err selectable">{p.error}</div>}
      <div className="mon-svcs">
        {names.map((n) => {
          const st = states.get(n);
          const cls = st === "active" ? "ok" : st === "failed" ? "err" : st === "activating" || st === "reloading" ? "warn" : "";
          return (
            <div className="mon-svc" key={n}>
              <span className={"dot " + cls} />
              <span className="ellipsis mono">{n}</span>
              <span className={"st " + cls}>{st ? STATE_LABEL[st] ?? st : "…"}</span>
            </div>
          );
        })}
      </div>
      {p.at > 0 && (
        <div className="mon-svc-sum">
          {up} / {names.length} 运行中
        </div>
      )}
    </div>
  );
}

// ---------- app / container usage ----------

/** One usage row. CPU follows top / docker stats: 100% = one core. */
interface Usage {
  name: string;
  count?: number;
  cpu: number;
  mem: string;
  memTitle?: string;
}

const fmtCpu = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));

function UsageRows({ rows, cores }: { rows: Usage[]; cores: number }) {
  return (
    <div>
      {rows.map((u) => (
        <div className="mon-disk" key={u.name}>
          <div className="mon-disk-head">
            <span className="ellipsis mono" title={u.name}>
              {u.name}
              {(u.count ?? 0) > 1 && <span className="faint">{` ×${u.count}`}</span>}
            </span>
            <span className="size" title={u.memTitle ?? "内存"}>{u.mem}</span>
            <span className="pct" title="CPU，100% 为一个核心" style={{ color: pctColor(u.cpu / cores) }}>
              {fmtCpu(u.cpu)}%
            </span>
          </div>
          <Bar value={u.cpu} max={100 * cores} thin />
        </div>
      ))}
    </div>
  );
}

const cpuCount = (ctx: CardCtx) => ctx.cur.cores.length || ctx.info?.cores || 1;

// Two /proc snapshots one second apart; per app: process count, CPU (jiffies delta over total
// jiffies, scaled to cores) and RSS. An app matches a comm equal to its name or followed by a
// version / suffix (php-fpm8.1, containerd-shim) but not by a letter or "_" (node_exporter).
const APPS_AWK = String.raw`BEGIN { ph = 0; n = split(names, N, " ") }
/^@@$/ { ph = 1; next }
/^cpu / { t = 0; for (i = 2; i <= NF; i++) t += $i; T[ph] = t; next }
/^cpu[0-9]/ { if (!ph) nc++; next }
{
  i = index($0, "("); if (!i || !match($0, /\) [A-Za-z] /)) next
  c = substr($0, i + 1, RSTART - i - 1); k = ""
  for (j = 1; j <= n; j++) if (index(c, N[j]) == 1 && substr(c, length(N[j]) + 1, 1) !~ /[A-Za-z_]/) { k = N[j]; break }
  if (k == "") next
  split(substr($0, RSTART + 2), f, " "); u = f[12] + f[13]
  if (!ph) { U[$1] = u; next }
  cnt[k]++; rss[k] += f[22] * pg; if ($1 in U) d[k] += u - U[$1]
}
END {
  dt = T[1] - T[0]; if (dt <= 0) dt = 1; if (nc < 1) nc = 1
  for (j = 1; j <= n; j++) { k = N[j]; if (cnt[k]) printf "%s\t%d\t%.1f\t%.0f\n", k, cnt[k], d[k] * 100 * nc / dt, rss[k] }
}`;

function appsCommand(names: string[]) {
  if (!names.length) return "";
  const script =
    "s() { grep '^cpu' /proc/stat; cat /proc/[0-9]*/stat 2>/dev/null; }\n" +
    "a=$(s); sleep 1; b=$(s)\n" +
    `printf '%s\\n@@\\n%s\\n' "$a" "$b" | awk -v pg="$(getconf PAGESIZE 2>/dev/null || echo 4096)" -v names=${shq(names.join(" "))} ${shq(APPS_AWK)}`;
  return `sh -c ${shq(script)}`;
}

export function AppsCard({ card, ctx }: { card: CardInst; ctx: CardCtx }) {
  // Names are validated against SERVICE_RE.
  const names = parseServices(card.cfg.apps ?? DEFAULT_APPS);
  const p = usePoll(ctx.hostId, appsCommand(names), card.cfg.interval ?? 10);
  if (!names.length)
    return (
      <div className="mon-sec">
        <div className="section-title">{cardTitle(card)}</div>
        <div className="mon-muted">右键编辑以添加进程</div>
      </div>
    );
  const rows: Usage[] = p.out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((f) => f.length >= 4)
    .map((f) => ({ name: f[0], count: Number(f[1]) || 0, cpu: Number(f[2]) || 0, mem: fmtBytes(Number(f[3]) || 0) }))
    .sort((a, b) => b.cpu - a.cpu);
  return (
    <div className="mon-sec">
      <PollHead title={cardTitle(card)} at={p.at} busy={p.busy} refresh={p.refresh} />
      {p.error ? (
        <div className="mon-muted err selectable">{p.error}</div>
      ) : !p.at ? (
        <div className="mon-muted">…</div>
      ) : rows.length ? (
        <UsageRows rows={rows} cores={cpuCount(ctx)} />
      ) : (
        <div className="mon-muted">未发现匹配的进程</div>
      )}
    </div>
  );
}

const DOCKER_FMT = "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}";
// Falls back to passwordless sudo when the user is not in the docker group.
const DOCKER_CMD = `sh -c ${shq(
  "command -v docker >/dev/null 2>&1 || { echo NO_DOCKER; exit 0; }\n" +
    `F=${shq(DOCKER_FMT)}\n` +
    'e=$(docker stats --no-stream --format "$F" 2>&1) && { printf \'%s\\n\' "$e"; exit 0; }\n' +
    'sudo -n docker stats --no-stream --format "$F" 2>/dev/null && exit 0\n' +
    'printf \'%s\\n\' "$e" >&2; exit 1',
)}`;

export function DockerCard({ card, ctx }: { card: CardInst; ctx: CardCtx }) {
  const p = usePoll(ctx.hostId, DOCKER_CMD, card.cfg.interval ?? 10);
  const none = p.out.trim() === "NO_DOCKER";
  const all: Usage[] = none
    ? []
    : p.out
        .split("\n")
        .map((l) => l.split("\t"))
        .filter((f) => f.length >= 3 && f[0])
        .map((f) => ({ name: f[0], cpu: parseFloat(f[1]) || 0, mem: f[2].split("/")[0].trim(), memTitle: f[2].trim() }))
        .sort((a, b) => b.cpu - a.cpu);
  const limit = card.cfg.limit ?? 10;
  const rows = all.slice(0, limit);
  return (
    <div className="mon-sec">
      <PollHead title={cardTitle(card)} at={p.at} busy={p.busy} refresh={p.refresh} />
      {p.error ? (
        <div className="mon-muted err selectable">{p.error}</div>
      ) : none ? (
        <div className="mon-muted">未安装 Docker</div>
      ) : !p.at ? (
        <div className="mon-muted">…</div>
      ) : rows.length ? (
        <>
          <UsageRows rows={rows} cores={cpuCount(ctx)} />
          {all.length > limit && <div className="mon-svc-sum">另有 {all.length - limit} 个容器</div>}
        </>
      ) : (
        <div className="mon-muted">没有运行中的容器</div>
      )}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  active: "运行中",
  inactive: "已停止",
  failed: "失败",
  activating: "启动中",
  deactivating: "停止中",
  reloading: "重载中",
  unknown: "未知",
};

export function NoteCard({ card }: { card: CardInst }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(card.cfg.text ?? "");
  const commit = () => {
    setEditing(false);
    if (draft !== (card.cfg.text ?? "")) upsertCard({ ...card, cfg: { ...card.cfg, text: draft } });
  };
  return (
    <div className="mon-sec">
      <div className="section-title">{cardTitle(card)}</div>
      {editing ? (
        <textarea
          className="textarea mon-note-edit"
          autoFocus
          value={draft}
          rows={Math.max(3, draft.split("\n").length)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(card.cfg.text ?? "");
              setEditing(false);
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commit();
          }}
        />
      ) : (
        <div
          className={"mon-note selectable" + (card.cfg.text ? "" : " blank")}
          title="双击编辑"
          onDoubleClick={() => {
            setDraft(card.cfg.text ?? "");
            setEditing(true);
          }}
        >
          {card.cfg.text || "双击编辑"}
        </div>
      )}
    </div>
  );
}
