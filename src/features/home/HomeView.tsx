// Home page: server overview — summary stats + grouped host cards.
import { Copy, Download, Pencil, Plus, Search } from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useState } from "react";
import { toast } from "../../components/ui";
import { type AgentPolicy, api, errMsg, type Host } from "../../lib/api";
import { useApp } from "../../store";
import { openTerminal } from "../terminal/open";
import "./home.css";
import { useLatencyHistory } from "./latencyHistory";

const UNGROUPED = "未分组";
const TUNNEL_POLL_MS = 5000;

function matches(h: Host, q: string) {
  if (!q) return true;
  const hay = [h.name, h.host, h.username, ...h.tags].join("\n").toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

type ConnKind = "connected" | "connecting" | "error" | "disconnected";
const CONN: Record<ConnKind, { dot: string; label: string }> = {
  connected: { dot: "ok", label: "已连接" },
  connecting: { dot: "warn", label: "连接中" },
  error: { dot: "err", label: "错误" },
  disconnected: { dot: "", label: "未连接" },
};

const POLICY: Record<AgentPolicy, string> = { deny: "禁止", readonly: "只读", ask: "询问", auto: "自动" };

type Tier = "ok" | "warn" | "err";
const tierOf = (ms: number | null): Tier => (ms === null || ms >= 200 ? "err" : ms >= 60 ? "warn" : "ok");
/** Filled bars (of 5) for the signal meter. */
const barsOf = (ms: number | null) =>
  ms === null ? 0 : ms < 30 ? 5 : ms < 60 ? 4 : ms < 120 ? 3 : ms < 200 ? 2 : 1;

/** Key id -> name, fetched once per mount. */
function useKeyNames() {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    api
      .keyList()
      .then((list) => alive && setNames(Object.fromEntries(list.map((k) => [k.id, k.name]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return names;
}

/** Running tunnel count, polled while the page is mounted. */
function useRunningTunnels() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .tunnelStatus()
        .then((list) => alive && setCount(list.filter((t) => t.running).length))
        .catch(() => alive && setCount(null));
    tick();
    const timer = setInterval(tick, TUNNEL_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return count;
}

export function HomeView() {
  const hosts = useApp((s) => s.hosts);
  const conn = useApp((s) => s.conn);
  const tabs = useApp((s) => s.tabs);
  const openEditor = useApp((s) => s.openEditor);
  const setImportOpen = useApp((s) => s.setImportOpen);
  const tunnels = useRunningTunnels();
  const keyNames = useKeyNames();
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const map = new Map<string, Host[]>();
    for (const h of hosts) {
      if (!matches(h, q)) continue;
      const g = h.groupName.trim() || UNGROUPED;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(h);
    }
    const list = [...map.entries()].map(([name, items]) => ({
      name,
      items: items.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "zh-CN")),
    }));
    list.sort((a, b) => (a.name === UNGROUPED ? 1 : b.name === UNGROUPED ? -1 : a.name.localeCompare(b.name, "zh-CN")));
    return list;
  }, [hosts, q]);

  const connected = hosts.filter((h) => conn[h.id]?.state === "connected").length;

  return (
    <div className="page home">
      <div className="page-header">
        <h1>服务器</h1>
        <div className="spacer" />
        <div className="home-search">
          <Search />
          <input
            className="input"
            placeholder="搜索"
            value={query}
            disabled={hosts.length === 0}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            spellCheck={false}
          />
        </div>
        <button className="btn" onClick={() => setImportOpen(true)}>
          <Download /> 导入
        </button>
        <button className="btn primary" onClick={() => openEditor("")}>
          <Plus /> 新建
        </button>
      </div>

      <div className="page-body">
        <div className="home-stats">
          <Stat value={hosts.length} label="服务器" />
          <Stat value={connected} label="已连接" />
          <Stat value={tabs.length} label="终端" />
          <Stat value={tunnels} label="运行中隧道" />
        </div>

        {hosts.length === 0 ? (
          <div className="empty home-empty">
            <div>还没有服务器</div>
            <div className="row">
              <button className="btn sm primary" onClick={() => openEditor("")}>
                <Plus /> 新建
              </button>
              <button className="btn sm" onClick={() => setImportOpen(true)}>
                <Download /> 导入
              </button>
            </div>
          </div>
        ) : groups.length === 0 ? (
          <div className="empty home-empty">无匹配</div>
        ) : (
          groups.map((g) => (
            <section key={g.name} className="home-group">
              <div className="section-title">
                <span className="ellipsis">{g.name}</span>
                <span className="home-count">{g.items.length}</span>
              </div>
              <div className="home-grid">
                {g.items.map((h) => (
                  <HostCard key={h.id} host={h} keyNames={keyNames} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function Stat(props: { value: number | null; label: string }) {
  return (
    <div className="home-stat">
      <span className="home-stat-value">{props.value ?? "—"}</span>
      <span className="home-stat-label">{props.label}</span>
    </div>
  );
}

function Signal({ bars }: { bars: number }) {
  return (
    <svg className="home-signal" viewBox="0 0 19 12" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <rect
          key={i}
          x={i * 4}
          y={12 - (4 + i * 2)}
          width={3}
          height={4 + i * 2}
          rx={0.5}
          className={i < bars ? "on" : undefined}
        />
      ))}
    </svg>
  );
}

const SPARK_W = 100;
const SPARK_H = 24;

function Sparkline({ samples }: { samples: readonly (number | null)[] }) {
  if (samples.length < 2) return <div className="home-spark" />;
  const vals = samples.filter((v): v is number => v !== null);
  const top = Math.max(60, ...vals) * 1.15;
  const step = SPARK_W / (samples.length - 1);
  const pts = samples
    .map((v, i) => {
      const y = v === null ? 1 : SPARK_H - 1 - (Math.min(v, top) / top) * (SPARK_H - 2);
      return `${(i * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="home-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function LatencyBlock({ hostId, connected }: { hostId: string; connected: boolean }) {
  const latency = useApp((s) => s.latency[hostId]);
  const samples = useLatencyHistory(hostId);
  if (!connected || latency === undefined) {
    return (
      <div className="home-latency idle">
        <span className="home-latency-value">—</span>
      </div>
    );
  }
  const tier = tierOf(latency);
  return (
    <div className={"home-latency " + tier}>
      <span className="home-latency-value">
        {latency === null ? (
          "超时"
        ) : (
          <>
            {Math.round(latency)}
            <span className="home-latency-unit">ms</span>
          </>
        )}
      </span>
      <Signal bars={barsOf(latency)} />
      <Sparkline samples={samples} />
    </div>
  );
}

function HostCard({ host: h, keyNames }: { host: Host; keyNames: Record<string, string> }) {
  const conn = useApp((s) => s.conn[h.id]);
  const jumpName = useApp((s) => (h.jumpHostId ? s.hosts.find((x) => x.id === h.jumpHostId)?.name : undefined));
  const sessions = useApp((s) => s.tabs.filter((t) => t.hostId === h.id && t.alive).length);
  const openEditor = useApp((s) => s.openEditor);
  const kind: ConnKind = conn?.state ?? "disconnected";
  const st = CONN[kind];
  const addr = `${h.username}@${h.host}:${h.port}`;

  const auth = h.authType === "key" ? (h.keyId && keyNames[h.keyId]) || "密钥" : "密码";
  const meta = [
    `认证 ${auth}`,
    jumpName && `跳板 ${jumpName}`,
    sessions > 0 && `${sessions} 个终端`,
    `Agent ${POLICY[h.agentPolicy] ?? h.agentPolicy}`,
  ].filter(Boolean) as string[];

  const copyAddr = async () => {
    try {
      await navigator.clipboard.writeText(h.host);
      toast("已复制", "success");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <div className="home-card" onDoubleClick={() => openTerminal(h.id)}>
      {h.color && <span className="home-marker" style={{ background: h.color }} />}
      <div className="home-card-top">
        <span className={"dot " + st.dot} />
        <span className="home-name ellipsis" title={h.name}>
          {h.name}
        </span>
        <span className={"home-state " + kind} title={kind === "error" ? (conn?.error ?? undefined) : undefined}>
          {st.label}
        </span>
      </div>
      <div className="home-addr mono ellipsis" title={addr}>
        {addr}
      </div>

      <LatencyBlock hostId={h.id} connected={kind === "connected"} />

      <div className="home-meta ellipsis" title={meta.join(" · ")}>
        {meta.join(" · ")}
      </div>
      {h.tags.length > 0 && (
        <div className="home-tags">
          {h.tags.map((t) => (
            <span key={t} className="home-tag" title={t}>
              {t}
            </span>
          ))}
        </div>
      )}
      {h.notes.trim() && (
        <div className="home-notes ellipsis" title={h.notes}>
          {h.notes.trim().split("\n")[0]}
        </div>
      )}

      <div className="home-card-actions">
        <button className="btn home-connect" onClick={() => openTerminal(h.id)} onDoubleClick={stop}>
          连接
        </button>
        <button className="icon-btn" title="复制地址" onClick={copyAddr} onDoubleClick={stop}>
          <Copy />
        </button>
        <button className="icon-btn" title="编辑" onClick={() => openEditor(h.id)} onDoubleClick={stop}>
          <Pencil />
        </button>
      </div>
    </div>
  );
}
