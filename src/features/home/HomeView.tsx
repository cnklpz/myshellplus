// Home page: server overview — summary stats + grouped host cards.
import { listen } from "@tauri-apps/api/event";
import {
  Download,
  Link,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  SquareTerminal,
  Trash2,
  Unplug,
  Zap,
} from "lucide-react";
import { type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Confirm, toast } from "../../components/ui";
import { api, errMsg, type Host } from "../../lib/api";
import { useApp } from "../../store";
import { openTerminal } from "../terminal/open";
import "./home.css";
import { useLatencyHistory } from "./latencyHistory";

const UNGROUPED = "未分组";
const TUNNEL_POLL_MS = 5000;

function matches(h: Host, q: string, os: string | undefined) {
  if (!q) return true;
  const hay = [h.name, h.host, h.username, h.notes, os ?? "", ...h.tags].join("\n").toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

type ConnKind = "connected" | "connecting" | "error" | "disconnected";
const DOT: Record<ConnKind, string> = { connected: "ok", connecting: "warn", error: "err", disconnected: "" };
const STATE_LABEL: Record<ConnKind, string> = {
  connected: "已连接",
  connecting: "连接中",
  error: "错误",
  disconnected: "未连接",
};

type Tier = "ok" | "warn" | "err";
const tierOf = (ms: number | null): Tier => (ms === null || ms >= 200 ? "err" : ms >= 60 ? "warn" : "ok");

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

/** Remote OS name per host id: initial fetch + live "host-os" events (payload = full map). */
function useHostOs() {
  const [map, setMap] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    api
      .hostOsMap()
      .then((m) => alive && setMap(m))
      .catch(() => {});
    const un = listen<Record<string, string>>("host-os", (e) => {
      if (alive) setMap(e.payload);
    });
    return () => {
      alive = false;
      un.then((f) => f()).catch(() => {});
    };
  }, []);
  return map;
}

export function HomeView() {
  const hosts = useApp((s) => s.hosts);
  const conn = useApp((s) => s.conn);
  const tabs = useApp((s) => s.tabs);
  const openEditor = useApp((s) => s.openEditor);
  const setImportOpen = useApp((s) => s.setImportOpen);
  const tunnels = useRunningTunnels();
  const osMap = useHostOs();
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<Host | null>(null);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const map = new Map<string, Host[]>();
    for (const h of hosts) {
      if (!matches(h, q, osMap[h.id])) continue;
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
  }, [hosts, q, osMap]);

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
        <button className="btn" onClick={() => openEditor("")}>
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
                  <HostCard key={h.id} host={h} os={osMap[h.id]} onDelete={() => setDeleting(h)} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {deleting && (
        <Confirm
          title="删除服务器"
          message={`删除「${deleting.name}」及其保存的密码，并断开连接。`}
          confirmText="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const h = deleting;
            setDeleting(null);
            try {
              await api.hostDelete(h.id);
              await useApp.getState().refreshHosts();
            } catch (e) {
              toast(errMsg(e), "error");
            }
          }}
        />
      )}
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

const SPARK_W = 48;
const SPARK_H = 16;

function Sparkline({ samples }: { samples: readonly (number | null)[] }) {
  if (samples.length < 2) return null;
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

/** Top-right latency readout: sparkline + value when connected, "—" otherwise. */
function Latency({ hostId, connected }: { hostId: string; connected: boolean }) {
  const latency = useApp((s) => s.latency[hostId]);
  const samples = useLatencyHistory(hostId);
  if (!connected || latency === undefined) return <span className="home-latency idle">—</span>;
  return (
    <span className={"home-latency " + tierOf(latency)}>
      <Sparkline samples={samples} />
      <span className="home-latency-value">{latency === null ? "超时" : `${Math.round(latency)} ms`}</span>
    </span>
  );
}

function HostCard({ host: h, os, onDelete }: { host: Host; os: string | undefined; onDelete: () => void }) {
  const conn = useApp((s) => s.conn[h.id]);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const kind: ConnKind = conn?.state ?? "disconnected";
  const addr = `${h.username}@${h.host}` + (h.port !== 22 ? `:${h.port}` : "");
  const note = h.notes.trim().split("\n")[0];
  const stop = (e: MouseEvent) => e.stopPropagation();
  const stateTitle = kind === "error" && conn?.error ? `${STATE_LABEL[kind]}：${conn.error}` : STATE_LABEL[kind];

  return (
    <div className="home-card" onDoubleClick={() => openTerminal(h.id)}>
      <div className="home-card-top">
        <span
          className="home-icon"
          style={h.color ? { color: h.color, background: `color-mix(in srgb, ${h.color} 14%, var(--bg-2))` } : undefined}
        >
          <SquareTerminal />
        </span>
        <div className="spacer" />
        <Latency hostId={h.id} connected={kind === "connected"} />
        <button
          className={"icon-btn home-more" + (menu ? " open" : "")}
          title="更多"
          onMouseDown={(e) => menu && e.stopPropagation()}
          onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}
          onDoubleClick={stop}
        >
          <MoreHorizontal />
        </button>
      </div>

      <div className="home-name-row">
        <span className="home-name ellipsis" title={h.name}>
          {h.name}
        </span>
        <span className="home-proto">SSH</span>
        <span className={"dot " + DOT[kind]} title={stateTitle} />
      </div>
      <div className="home-addr mono ellipsis" title={addr}>
        {addr}
      </div>

      {os && (
        <div className="home-os-row">
          <span className="home-os ellipsis" title={os}>
            {os}
          </span>
        </div>
      )}

      <div className={"home-notes ellipsis" + (note ? "" : " is-empty")} title={note ? h.notes : undefined}>
        {note || "暂无备注"}
      </div>

      {h.tags.length > 0 ? (
        <div className="home-tags">
          {h.tags.map((t) => (
            <span key={t} className="home-tag" title={t}>
              {t}
            </span>
          ))}
        </div>
      ) : (
        <div className="home-tags-empty">无标签</div>
      )}

      <button className="btn primary home-connect" onClick={() => openTerminal(h.id)} onDoubleClick={stop}>
        <Zap /> 快速连接
      </button>

      {menu && (
        <CardMenu
          anchor={menu}
          host={h}
          connected={kind === "connected" || kind === "connecting"}
          onClose={() => setMenu(null)}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

function CardMenu(props: {
  anchor: DOMRect;
  host: Host;
  connected: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { anchor, host: h, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: anchor.right, y: anchor.bottom + 4 });

  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  // Right-align to the button; flip above it when there is no room below.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const below = anchor.bottom + 4;
    setPos({
      x: Math.max(4, anchor.right - r.width),
      y: below + r.height > window.innerHeight - 4 ? Math.max(4, anchor.top - 4 - r.height) : below,
    });
  }, [anchor]);

  const run = (fn: () => unknown) => async () => {
    onClose();
    try {
      await fn();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  return createPortal(
    <div
      className="home-menu"
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button onClick={run(() => useApp.getState().openEditor(h.id))}>
        <Pencil /> 编辑
      </button>
      <button
        onClick={run(async () => {
          const addr = `${h.username}@${h.host}`;
          await navigator.clipboard.writeText(addr);
          toast("已复制 " + addr, "success");
        })}
      >
        <Link /> 复制地址
      </button>
      <button onClick={run(() => openTerminal(h.id))}>
        <SquareTerminal /> 新建终端
      </button>
      {props.connected && (
        <button onClick={run(() => api.connDisconnect(h.id))}>
          <Unplug /> 断开
        </button>
      )}
      <hr />
      <button
        className="danger"
        onClick={() => {
          onClose();
          props.onDelete();
        }}
      >
        <Trash2 /> 删除
      </button>
    </div>,
    document.body,
  );
}
