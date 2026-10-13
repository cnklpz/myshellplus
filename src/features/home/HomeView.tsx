// Home page: server overview — summary stats + grouped host cards.
import {
  Download,
  Gauge,
  Upload,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Search,
  SquareTerminal,
  X,
  Zap,
} from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { Confirm, Empty, toast } from "../../components/ui";
import { sortByGroupOrder, useGroupOrder } from "../../lib/groupOrder";
import { ExportDialog } from "../settings/SettingsView";
import { DiagnoseDialog } from "../diagnostics/connLog";
import { GroupTabs } from "./GroupTabs";
import { api, errMsg, type Host } from "../../lib/api";
import { useApp } from "../../store";
import { openTerminal } from "../terminal/open";
import { ContextMenu } from "../terminal/ContextMenu";
import { hostMenuItems } from "../hosts/hostMenu";
import "./home.css";
import { useLatencyHistory } from "./latencyHistory";
import { probeHosts, useProbe, useProbing } from "./probe";
import { usePrivacy } from "../../lib/privacy";
import { isMobile } from "../../lib/platform";
import { useTauriEvent } from "../../lib/events";
import { fmtMs } from "../../lib/format";
import { lsGet, lsSet } from "../../lib/storage";

const UNGROUPED = "未分组";
const ALL = "";
const GROUP_KEY = "msp.home.group";

const loadGroup = () => lsGet(GROUP_KEY) ?? ALL;
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
    return () => {
      alive = false;
    };
  }, []);
  useTauriEvent<Record<string, string>>("host-os", (e) => setMap(e.payload));
  return map;
}

/** Header button text: phones show the icon only (the title attribute keeps the name). */
const label = (text: string) => (isMobile ? null : " " + text);

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
  const [exporting, setExporting] = useState(false);
  const [group, setGroupState] = useState(loadGroup);
  const setGroup = (g: string) => {
    setGroupState(g);
    lsSet(GROUP_KEY, g);
  };
  const probing = useProbing();

  const q = query.trim().toLowerCase();
  const groupOrder = useGroupOrder();
  /** Every group with its host count (unfiltered), for the tab bar. */
  const groupTabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of hosts) {
      const g = h.groupName.trim() || UNGROUPED;
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    const list = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (a.name === UNGROUPED ? 1 : b.name === UNGROUPED ? -1 : a.name.localeCompare(b.name, "zh-CN")));
    return sortByGroupOrder(list, groupOrder);
  }, [hosts, groupOrder]);
  const activeGroup = groupTabs.some((g) => g.name === group) ? group : ALL;

  const groups = useMemo(() => {
    const map = new Map<string, Host[]>();
    for (const h of hosts) {
      if (!matches(h, q, osMap[h.id])) continue;
      const g = h.groupName.trim() || UNGROUPED;
      if (activeGroup !== ALL && g !== activeGroup) continue;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(h);
    }
    const list = [...map.entries()].map(([name, items]) => ({
      name,
      items: items.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "zh-CN")),
    }));
    list.sort((a, b) => (a.name === UNGROUPED ? 1 : b.name === UNGROUPED ? -1 : a.name.localeCompare(b.name, "zh-CN")));
    return sortByGroupOrder(list, groupOrder);
  }, [hosts, q, osMap, activeGroup, groupOrder]);

  const connected = hosts.filter((h) => conn[h.id]?.state === "connected").length;

  return (
    <div className="page home">
      <div className="page-header">
        <h1>服务器</h1>
        <div className="spacer" />
        <div className="search-box home-search">
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
        <button
          className="btn"
          title="全部测速"
          disabled={hosts.length === 0 || probing}
          onClick={() => probeHosts(groups.flatMap((g) => g.items.map((h) => h.id)))}
        >
          {probing ? <LoaderCircle className="spin" /> : <Gauge />}
          {label("全部测速")}
        </button>
        <button className="btn" title="导入…" onClick={() => setImportOpen(true)}>
          <Download />
          {label("导入…")}
        </button>
        <button className="btn" title="导出…" disabled={hosts.length === 0} onClick={() => setExporting(true)}>
          <Upload />
          {label("导出…")}
        </button>
        <button className="btn" title="新建…" onClick={() => openEditor("")}>
          <Plus />
          {label("新建…")}
        </button>
      </div>

      <div className="page-body">
        <div className="home-stats">
          <Stat value={hosts.length} label="服务器" />
          <Stat value={connected} label="已连接" />
          <Stat value={tabs.length} label="终端" />
          <Stat value={tunnels} label="运行中隧道" />
        </div>

        {groupTabs.length > 1 && (
          <GroupTabs
            allCount={hosts.length}
            tabs={groupTabs}
            active={activeGroup}
            onSelect={setGroup}
            onProbe={(g) => probeHosts(hosts.filter((h) => !g || (h.groupName.trim() || UNGROUPED) === g).map((h) => h.id))}
          />
        )}

        {hosts.length === 0 ? (
          <Empty
            text="还没有服务器"
            action={
              <button className="btn sm primary" onClick={() => openEditor("")}>
                <Plus /> 新建…
              </button>
            }
          />
        ) : groups.length === 0 ? (
          <Empty text="无匹配" />
        ) : (
          groups.map((g) => (
            <section key={g.name} className="home-group">
              <div className="section-title">
                <span className="ellipsis">{g.name}</span>
                <span className="count">{g.items.length}</span>
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

      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
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
      <span className="stat-value">{props.value ?? "—"}</span>
      <span className="stat-label">{props.label}</span>
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
    <svg className="home-spark" width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Top-right latency readout: live SSH ping when connected, else the last manual test; click to test. */
function Latency({ hostId, connected }: { hostId: string; connected: boolean }) {
  const latency = useApp((s) => s.latency[hostId]);
  const samples = useLatencyHistory(hostId);
  const probe = useProbe(hostId);
  const test = (e: MouseEvent) => {
    e.stopPropagation();
    probeHosts([hostId]);
  };
  if (probe?.busy)
    return (
      <span className="home-latency idle">
        <LoaderCircle className="spin" />
      </span>
    );
  if (connected && latency !== undefined)
    return (
      <span className={"home-latency " + tierOf(latency)} title="SSH 往返延迟，点击测速" onClick={test} onDoubleClick={test}>
        <Sparkline samples={samples} />
        <span className="home-latency-value">{latency === null ? "超时" : fmtMs(latency)}</span>
      </span>
    );
  const r = probe?.result;
  if (!r)
    return (
      <span className="home-latency idle" title="点击测速" onClick={test} onDoubleClick={test}>
        —
      </span>
    );
  const title = r.ms === null ? r.error || "超时" : r.via === "tcp" ? "TCP 握手延迟，点击重测" : "SSH 往返延迟，点击重测";
  return (
    <span className={"home-latency " + tierOf(r.ms)} title={title} onClick={test} onDoubleClick={test}>
      <span className="home-latency-value">{r.ms === null ? (r.error === "超时" || !r.error ? "超时" : "不可达") : fmtMs(r.ms)}</span>
    </span>
  );
}

/** "14:03" today, else "10-11 14:03". */
function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/** Last failed connect, kept until the host connects again; click to dismiss. */
function FailMark({ hostId }: { hostId: string }) {
  const fail = useApp((s) => s.failures[hostId]);
  const priv = usePrivacy();
  if (!fail) return null;
  const dismiss = (e: MouseEvent) => {
    e.stopPropagation();
    const { failures, setFailures } = useApp.getState();
    const { [hostId]: _, ...rest } = failures;
    setFailures(rest);
    api.connFailureDismiss(hostId).catch(() => {});
  };
  return (
    <button className="home-fail" title={`${priv.hostText(fail.error, hostId)}
点击忽略`} onClick={dismiss} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="dot err" />
      <span className="ellipsis grow">上次连接失败 · {fmtWhen(fail.at)}</span>
      <X className="home-fail-x" />
    </button>
  );
}

function HostCard({ host: h, os, onDelete }: { host: Host; os: string | undefined; onDelete: () => void }) {
  const conn = useApp((s) => s.conn[h.id]);
  const [menu, setMenu] = useState<{ x: number; y: number; anchor?: DOMRect } | null>(null);
  const menuWasOpen = useRef(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const fail = useApp((s) => s.failures[h.id]);
  const kind: ConnKind = conn?.state ?? "disconnected";
  const priv = usePrivacy();
  const addr = `${h.username}@${priv.addr(h.host)}` + (h.port !== 22 ? `:${h.port}` : "");
  const name = priv.text(h.name, h.host);
  const note = h.notes.trim().split("\n")[0];
  const stop = (e: MouseEvent) => e.stopPropagation();
  const stateTitle = kind === "error" && conn?.error ? `${STATE_LABEL[kind]}：${priv.hostText(conn.error, h.id)}` : STATE_LABEL[kind];

  return (
    <div
      className="home-card"
      // The card's dialogs are portaled but still bubble here: only react to the card's own DOM.
      onDoubleClick={(e) => e.currentTarget.contains(e.target as Node) && openTerminal(h.id)}
      onContextMenu={(e) => {
        if (e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
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
          // The menu closes itself on this mousedown; remember it so the click does not reopen it.
          onMouseDown={() => (menuWasOpen.current = !!menu?.anchor)}
          onClick={(e) => {
            if (menuWasOpen.current) return void (menuWasOpen.current = false);
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right, y: r.bottom, anchor: r });
          }}
          onDoubleClick={stop}
        >
          <MoreHorizontal />
        </button>
      </div>

      <div className="home-name-row">
        <span className="home-name ellipsis" title={name}>
          {name}
        </span>
        <span className="badge mono">SSH</span>
        <span className={"dot " + DOT[kind]} title={stateTitle} />
      </div>
      <div className="home-addr mono ellipsis" title={addr}>
        {addr}
      </div>

      {os && (
        <div className="home-os-row">
          <span className="badge trunc" title={os}>
            {os}
          </span>
        </div>
      )}

      <FailMark hostId={h.id} />

      <div className={"home-notes ellipsis" + (note ? "" : " is-empty")} title={note ? h.notes : undefined}>
        {note || "暂无备注"}
      </div>

      {h.tags.length > 0 ? (
        <div className="home-tags">
          {h.tags.map((t) => (
            <span key={t} className="badge trunc" title={t}>
              {t}
            </span>
          ))}
        </div>
      ) : (
        <div className="home-tags-empty">无标签</div>
      )}

      <button className="btn home-connect" onClick={() => openTerminal(h.id)} onDoubleClick={stop}>
        <Zap /> 快速连接
      </button>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor}
          items={hostMenuItems(h, {
            state: kind,
            onDiagnose: fail || kind === "error" ? () => setDiagnosing(true) : undefined,
            onDelete,
          })}
          onClose={() => setMenu(null)}
        />
      )}
      {diagnosing && (
        <DiagnoseDialog hostId={h.id} name={name} error={fail?.error ?? conn?.error ?? undefined} onClose={() => setDiagnosing(false)} />
      )}
    </div>
  );
}
