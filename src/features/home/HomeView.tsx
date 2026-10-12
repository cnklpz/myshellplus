// Home page: server overview — summary stats + grouped host cards.
import { Download, Pencil, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type Host } from "../../lib/api";
import { useApp } from "../../store";
import { openTerminal } from "../terminal/open";
import "./home.css";

const UNGROUPED = "未分组";
const TUNNEL_POLL_MS = 5000;

function matches(h: Host, q: string) {
  if (!q) return true;
  const hay = [h.name, h.host, h.username, ...h.tags].join("\n").toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

function connDot(state?: string) {
  if (state === "connected") return "dot ok";
  if (state === "connecting") return "dot warn";
  if (state === "error") return "dot err";
  return "dot";
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
                  <HostCard key={h.id} host={h} />
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

function Latency({ ms }: { ms: number | null | undefined }) {
  if (ms === undefined) return null;
  if (ms === null) return <span className="home-latency err">超时</span>;
  const cls = ms >= 200 ? " err" : ms >= 60 ? " warn" : "";
  return <span className={"home-latency" + cls}>{Math.round(ms)} ms</span>;
}

function HostCard({ host: h }: { host: Host }) {
  const state = useApp((s) => s.conn[h.id]?.state);
  const latency = useApp((s) => s.latency[h.id]);
  const openEditor = useApp((s) => s.openEditor);
  const addr = `${h.username}@${h.host}:${h.port}`;

  return (
    <div className="home-card" onDoubleClick={() => openTerminal(h.id)}>
      {h.color && <span className="home-marker" style={{ background: h.color }} />}
      <div className="home-card-top">
        <span className={connDot(state)} />
        <span className="home-name ellipsis" title={h.name}>
          {h.name}
        </span>
        {state === "connected" && <Latency ms={latency} />}
      </div>
      <div className="home-addr mono ellipsis" title={addr}>
        {addr}
      </div>
      <div className="home-tags ellipsis">{h.tags.join(" · ")}</div>
      <div className="home-card-actions">
        <button className="btn sm" onClick={() => openTerminal(h.id)} onDoubleClick={(e) => e.stopPropagation()}>
          连接
        </button>
        <div className="spacer" />
        <button
          className="icon-btn"
          title="编辑"
          onClick={() => openEditor(h.id)}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Pencil />
        </button>
      </div>
    </div>
  );
}
