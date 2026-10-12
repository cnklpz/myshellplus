// Overview: a live wall of every server — status, CPU / memory / disk, network — with bulk and per-group connect.
import {
  LoaderCircle,
  Plug,
  SlidersHorizontal,
  SquareTerminal,
  Unplug,
} from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useState } from "react";
import {
  Bar,
  Confirm,
  Dialog,
  Empty,
  Field,
  Toggle,
  toast,
} from "../../components/ui";
import { api, type Host, type Sample } from "../../lib/api";
import { fmtPct, fmtRate, fmtUptime } from "../../lib/format";
import { sortByGroupOrder, useGroupOrder } from "../../lib/groupOrder";
import { usePrivacy } from "../../lib/privacy";
import { useApp } from "../../store";
import { GroupTabs } from "../home/GroupTabs";
import { useHostMenu } from "../hosts/hostMenu";
import { useContextMenu } from "../terminal/ContextMenu";
import { Sparkline } from "../monitor/Sparkline";
import { openTerminal } from "../terminal/open";
import {
  type BulkState,
  connectHosts,
  type HostLive,
  isQueued,
  useBulkConnect,
  useMonitors,
} from "./live";
import {
  getOverviewPrefs,
  type MetricKey,
  METRICS,
  type OverviewPrefs,
  setOverviewPrefs,
  useOverviewPrefs,
} from "./prefs";
import "./overview.css";

const UNGROUPED = "未分组";
const ALL = "";
const groupOf = (h: Host) => h.groupName.trim() || UNGROUPED;

/** Groups whose auto-connect already ran in this app session. */
const autoDone = new Set<string>();

interface Stats {
  cpu: number;
  mem: number;
  disk: number;
  rx: number;
  tx: number;
  load: number;
  uptime: number;
}

function statsOf(s: Sample): Stats {
  // Root filesystem; other mounts (WSL's /mnt/*, read-only images) would skew it.
  const root = s.disks.find((d) => d.mount === "/") ?? s.disks[0];
  const disk = root && root.total > 0 ? (root.used / root.total) * 100 : 0;
  return {
    cpu: s.cpu,
    mem: s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : 0,
    disk,
    rx: s.rxRate,
    tx: s.txRate,
    load: s.load[0],
    uptime: s.uptime,
  };
}

type Status =
  "offline" | "connecting" | "failed" | "loading" | "error" | "alert" | "ok";

interface Row {
  host: Host;
  status: Status;
  stats: Stats | null;
  live: HostLive | undefined;
  /** Why it is offline / why monitoring fails */
  reason?: string;
}

function onBulkDone(s: BulkState) {
  const ok = s.done - s.failed;
  toast(
    s.failed ? `已连接 ${ok} 台，${s.failed} 台无法连接` : `已连接 ${ok} 台`,
    s.failed && !ok ? "error" : "success",
  );
}

export function OverviewView() {
  const hosts = useApp((s) => s.hosts);
  const conn = useApp((s) => s.conn);
  const failures = useApp((s) => s.failures);
  const prefs = useOverviewPrefs();
  const groupOrder = useGroupOrder();
  const bulk = useBulkConnect();
  const [group, setGroup] = useState(ALL);
  const [customizing, setCustomizing] = useState(false);
  const menu = useContextMenu();
  const [disconnecting, setDisconnecting] = useState<{
    name: string;
    ids: string[];
    all?: boolean;
  } | null>(null);

  const isOn = (id: string) => conn[id]?.state === "connected";
  const visibleHosts = useMemo(
    () => hosts.filter((h) => !prefs.hiddenGroups.includes(groupOf(h))),
    [hosts, prefs.hiddenGroups],
  );
  const live = useMonitors(
    visibleHosts.filter((h) => isOn(h.id)).map((h) => h.id),
  );

  // Auto-connect the configured groups the first time the page opens.
  useEffect(() => {
    if (!hosts.length) return;
    const ids: string[] = [];
    for (const g of prefs.autoGroups) {
      if (autoDone.has(g)) continue;
      autoDone.add(g);
      ids.push(...hosts.filter((h) => groupOf(h) === g).map((h) => h.id));
    }
    if (ids.length) connectHosts(ids, onBulkDone);
  }, [hosts, prefs.autoGroups]);

  const groupTabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of visibleHosts)
      counts.set(groupOf(h), (counts.get(groupOf(h)) ?? 0) + 1);
    const list = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) =>
        a.name === UNGROUPED
          ? 1
          : b.name === UNGROUPED
            ? -1
            : a.name.localeCompare(b.name, "zh-CN"),
      );
    return sortByGroupOrder(list, groupOrder);
  }, [visibleHosts, groupOrder]);
  const activeGroup = groupTabs.some((g) => g.name === group) ? group : ALL;

  const rows: Row[] = visibleHosts.map((h) => {
    const st = conn[h.id]?.state;
    const l = live[h.id];
    const cur = l?.history[l.history.length - 1];
    if (st !== "connected") {
      if (st === "connecting" || isQueued(h.id))
        return { host: h, status: "connecting", stats: null, live: l };
      const reason = conn[h.id]?.error || failures[h.id]?.error;
      return {
        host: h,
        status: reason ? "failed" : "offline",
        stats: null,
        live: l,
        reason: reason ?? undefined,
      };
    }
    if (!cur)
      return l?.error
        ? { host: h, status: "error", stats: null, live: l, reason: l.error }
        : { host: h, status: "loading", stats: null, live: l };
    const stats = statsOf(cur);
    const alert =
      stats.cpu >= prefs.alertPct ||
      stats.mem >= prefs.alertPct ||
      stats.disk >= prefs.alertPct;
    return {
      host: h,
      status: l?.error ? "error" : alert ? "alert" : "ok",
      stats,
      live: l,
      reason: l?.error ?? undefined,
    };
  });

  const scoped = rows.filter(
    (r) => activeGroup === ALL || groupOf(r.host) === activeGroup,
  );
  const shown = prefs.onlyConnected
    ? scoped.filter(
        (r) => r.stats || r.status === "loading" || r.status === "error",
      )
    : scoped;

  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of shown) {
      const g = prefs.grouped ? groupOf(r.host) : ALL;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(r);
    }
    const online = (r: Row) =>
      r.stats || r.status === "loading" || r.status === "error" ? 0 : 1;
    const list = [...map.entries()].map(([name, items]) => ({
      name,
      items: items.sort(
        (a, b) =>
          online(a) - online(b) ||
          a.host.sort - b.host.sort ||
          a.host.name.localeCompare(b.host.name, "zh-CN"),
      ),
    }));
    list.sort((a, b) =>
      a.name === UNGROUPED
        ? 1
        : b.name === UNGROUPED
          ? -1
          : a.name.localeCompare(b.name, "zh-CN"),
    );
    return sortByGroupOrder(list, groupOrder);
  }, [shown, groupOrder, prefs.grouped]); // eslint-disable-line react-hooks/exhaustive-deps

  // Summary over the current group scope.
  const withStats = scoped.filter((r) => r.stats);
  const avg = (f: (s: Stats) => number) =>
    withStats.length
      ? withStats.reduce((a, r) => a + f(r.stats!), 0) / withStats.length
      : null;
  const sum = (f: (s: Stats) => number) =>
    withStats.length ? withStats.reduce((a, r) => a + f(r.stats!), 0) : null;
  const onlineCount = scoped.filter((r) => isOn(r.host.id)).length;
  const alerts = scoped.filter(
    (r) => r.status === "alert" || r.status === "error",
  ).length;
  const cpu = avg((s) => s.cpu);
  const mem = avg((s) => s.mem);
  const rx = sum((s) => s.rx);
  const tx = sum((s) => s.tx);

  const connectScope = (ids: string[]) => {
    if (!connectHosts(ids, onBulkDone)) toast("已全部连接", "info");
  };
  const scopeIds = scoped.map((r) => r.host.id);
  const allOn = !bulk && scopeIds.length > 0 && onlineCount === scopeIds.length;

  return (
    <div className="page ov">
      <div className="page-header">
        <h1>概览</h1>
        <div className="spacer" />
        <div className="seg">
          <button
            className={prefs.layout === "grid" ? "on" : ""}
            onClick={() => setOverviewPrefs({ layout: "grid" })}
          >
            卡片
          </button>
          <button
            className={prefs.layout === "list" ? "on" : ""}
            onClick={() => setOverviewPrefs({ layout: "list" })}
          >
            列表
          </button>
        </div>
        <button className="btn" onClick={() => setCustomizing(true)}>
          <SlidersHorizontal /> 自定义…
        </button>
        {allOn ? (
          <button
            className="btn"
            onClick={() =>
              setDisconnecting({
                name: activeGroup,
                ids: scopeIds,
                all: activeGroup === ALL,
              })
            }
          >
            <Unplug /> {activeGroup === ALL ? "断开全部" : "断开本组"}
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={!scopeIds.length || !!bulk}
            onClick={() => connectScope(scopeIds)}
          >
            {bulk ? <LoaderCircle className="spin" /> : <Plug />}
            {bulk
              ? `连接中 ${bulk.done}/${bulk.total}`
              : activeGroup === ALL
                ? "连接全部"
                : "连接本组"}
          </button>
        )}
      </div>

      <div className="page-body">
        <div className="ov-stats">
          <Stat
            label="在线"
            value={`${onlineCount}`}
            sub={`/ ${scoped.length}`}
          />
          <Stat
            label="告警"
            value={`${alerts}`}
            tone={alerts ? "err" : undefined}
          />
          <Stat
            label="平均 CPU"
            value={cpu === null ? "—" : fmtPct(cpu)}
            pct={cpu}
          />
          <Stat
            label="平均内存"
            value={mem === null ? "—" : fmtPct(mem)}
            pct={mem}
          />
          <Stat label="总下行" value={rx === null ? "—" : fmtRate(rx)} />
          <Stat label="总上行" value={tx === null ? "—" : fmtRate(tx)} />
        </div>

        {groupTabs.length > 1 && (
          <GroupTabs
            allCount={visibleHosts.length}
            tabs={groupTabs}
            active={activeGroup}
            onSelect={setGroup}
          />
        )}

        {visibleHosts.length === 0 ? (
          <Empty
            text={hosts.length ? "所有分组都已隐藏" : "还没有服务器"}
            action={
              hosts.length > 0 && (
                <button className="btn sm" onClick={() => setCustomizing(true)}>
                  自定义…
                </button>
              )
            }
          />
        ) : groups.length === 0 ? (
          <Empty
            text="没有已连接的服务器"
            action={
              <button
                className="btn sm"
                disabled={!!bulk}
                onClick={() => connectScope(scopeIds)}
              >
                <Plug /> 连接全部
              </button>
            }
          />
        ) : (
          groups.map((g) => {
            const all = rows.filter((r) => groupOf(r.host) === g.name);
            const on = all.filter((r) => isOn(r.host.id));
            return (
              <section key={g.name} className="ov-group">
                {prefs.grouped && (
                  <div
                    className="section-title ov-group-title"
                    onContextMenu={(e) =>
                      menu.open(e, [
                        {
                          label: "连接本组",
                          icon: <Plug />,
                          disabled: !!bulk || on.length === all.length,
                          onSelect: () => connectScope(all.map((r) => r.host.id)),
                        },
                        {
                          label: "断开本组…",
                          icon: <Unplug />,
                          disabled: !on.length,
                          onSelect: () => setDisconnecting({ name: g.name, ids: on.map((r) => r.host.id) }),
                        },
                      ])
                    }
                  >
                    <span className="ellipsis">{g.name}</span>
                    <span className="count">
                      {on.length}/{all.length}
                    </span>
                    <div className="spacer" />
                    <button
                      className="btn ghost sm"
                      disabled={on.length === all.length}
                      onClick={() => connectScope(all.map((r) => r.host.id))}
                    >
                      <Plug /> 连接
                    </button>
                    <button
                      className="btn ghost sm"
                      disabled={!on.length}
                      onClick={() =>
                        setDisconnecting({
                          name: g.name,
                          ids: on.map((r) => r.host.id),
                        })
                      }
                    >
                      <Unplug /> 断开
                    </button>
                  </div>
                )}
                {prefs.layout === "grid" ? (
                  <div className="ov-grid">
                    {g.items.map((r) => (
                      <Tile key={r.host.id} row={r} prefs={prefs} />
                    ))}
                  </div>
                ) : (
                  <ListTable rows={g.items} prefs={prefs} />
                )}
              </section>
            );
          })
        )}
      </div>

      {menu.node}
      {customizing && (
        <CustomizeDialog hosts={hosts} onClose={() => setCustomizing(false)} />
      )}
      {disconnecting && (
        <Confirm
          title={disconnecting.all ? "断开全部" : "断开分组"}
          message={
            disconnecting.all
              ? `断开全部 ${disconnecting.ids.length} 台服务器，并关闭其终端。`
              : `断开「${disconnecting.name}」的 ${disconnecting.ids.length} 台服务器，并关闭其终端。`
          }
          confirmText="断开"
          danger
          onCancel={() => setDisconnecting(null)}
          onConfirm={() => {
            const ids = disconnecting.ids;
            setDisconnecting(null);
            for (const id of ids) api.connDisconnect(id).catch(() => {});
          }}
        />
      )}
    </div>
  );
}

function Stat(props: {
  label: string;
  value: string;
  sub?: string;
  pct?: number | null;
  tone?: "err";
}) {
  return (
    <div className="ov-stat">
      <span className="stat-label">{props.label}</span>
      <span className={"stat-value" + (props.tone ? " " + props.tone : "")}>
        {props.value}
        {props.sub && <span className="ov-stat-sub">{props.sub}</span>}
      </span>
      {props.pct !== undefined && <Bar value={props.pct ?? 0} />}
    </div>
  );
}

const DOT: Record<Status, string> = {
  offline: "",
  connecting: "warn",
  failed: "err",
  loading: "ok",
  error: "warn",
  alert: "err",
  ok: "ok",
};

function statusText(r: Row): string {
  switch (r.status) {
    case "offline":
      return "未连接";
    case "connecting":
      return "连接中";
    case "failed":
      return r.reason ?? "连接失败";
    case "loading":
      return "读取中";
    case "error":
      return r.reason ?? "监控失败";
    default:
      return "";
  }
}

const tierOf = (ms: number | null) =>
  ms === null || ms >= 200 ? "err" : ms >= 60 ? "warn" : "ok";

function Latency({ hostId }: { hostId: string }) {
  const ms = useApp((s) => s.latency[hostId]);
  if (ms === undefined) return null;
  return (
    <span className={"ov-latency " + tierOf(ms)}>
      {ms === null ? "超时" : `${Math.max(1, Math.round(ms))} ms`}
    </span>
  );
}

function HostActions({ row }: { row: Row }) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  const id = row.host.id;
  const online =
    !!row.stats || row.status === "loading" || row.status === "error";
  return (
    <div className="ov-actions" onDoubleClick={stop}>
      <button
        className="icon-btn"
        title="打开终端"
        onClick={() => openTerminal(id)}
      >
        <SquareTerminal />
      </button>
      {online && (
        <button
          className="icon-btn"
          title="断开"
          onClick={() => api.connDisconnect(id).catch(() => {})}
        >
          <Unplug />
        </button>
      )}
    </div>
  );
}

function Tile({ row, prefs }: { row: Row; prefs: OverviewPrefs }) {
  const h = row.host;
  const priv = usePrivacy();
  const has = (k: MetricKey) => prefs.metrics.includes(k);
  const s = row.stats;
  const hist = row.live?.history ?? [];
  const name = priv.text(h.name, h.host);
  const addr =
    `${h.username}@${priv.addr(h.host)}` + (h.port !== 22 ? `:${h.port}` : "");
  const text = statusText(row);
  const menu = useHostMenu();

  return (
    <>
      <div
        className={
          "ov-tile" + (s ? "" : " off") + (row.status === "alert" ? " alert" : "")
        }
        onDoubleClick={() => openTerminal(h.id)}
        onContextMenu={(e) => menu.open(e, h)}
      >
        <div className="ov-tile-head">
          <span className={"dot " + DOT[row.status]} />
          <span className="ov-name ellipsis" title={name}>
            {name}
          </span>
          <div className="spacer" />
          {has("latency") && s && <Latency hostId={h.id} />}
          <HostActions row={row} />
        </div>
        {row.live?.info?.os ? (
          <div className="ov-addr ellipsis" title={`${addr} · ${row.live.info.os}`}>
            <span className="mono">{priv.addr(h.host)}</span>
            {" · "}
            {row.live.info.os}
          </div>
        ) : (
          <div className="ov-addr mono ellipsis" title={addr}>
            {addr}
          </div>
        )}

        {s ? (
          <>
            <div className="ov-meters">
              {has("cpu") && (
                <Meter label="CPU" pct={s.cpu} alert={prefs.alertPct} />
              )}
              {has("mem") && (
                <Meter label="内存" pct={s.mem} alert={prefs.alertPct} />
              )}
              {has("disk") && (
                <Meter label="磁盘" pct={s.disk} alert={prefs.alertPct} />
              )}
            </div>
            {has("chart") && (
              <div className="ov-chart">
                <Sparkline
                  height={36}
                  max={100}
                  slots={40}
                  series={[
                    { values: hist.map((x) => x.cpu), color: "var(--chart-1)" },
                    {
                      values: hist.map((x) =>
                        x.memTotal ? (x.memUsed / x.memTotal) * 100 : 0,
                      ),
                      color: "var(--chart-2)",
                    },
                  ]}
                />
              </div>
            )}
            {(has("net") || has("load") || has("uptime")) && (
              <div className="ov-foot">
                {has("net") && (
                  <>
                    <span title="下行">↓ {fmtRate(s.rx)}</span>
                    <span title="上行">↑ {fmtRate(s.tx)}</span>
                  </>
                )}
                {has("load") && (
                  <span title="1 分钟负载">负载 {s.load.toFixed(2)}</span>
                )}
                {has("uptime") && (
                  <span title="运行时间">{fmtUptime(s.uptime)}</span>
                )}
              </div>
            )}
          </>
        ) : (
          <div
            className={
              "ov-off-row" +
              (row.status === "failed" || row.status === "error" ? " err" : "")
            }
          >
            {row.status === "connecting" || row.status === "loading" ? (
              <LoaderCircle className="spin" />
            ) : null}
            <span className="ellipsis grow selectable" title={text}>
              {text}
            </span>
            {(row.status === "offline" || row.status === "failed") && (
              <button
                className="btn sm"
                onClick={() => connectHosts([h.id])}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <Plug /> 连接
              </button>
            )}
          </div>
        )}
      </div>
      {menu.node}
    </>
  );
}

function Meter({
  label,
  pct,
  alert,
}: {
  label: string;
  pct: number;
  alert: number;
}) {
  return (
    <div className="ov-meter">
      <span className="ov-meter-label">{label}</span>
      <Bar value={pct} />
      <span className={"ov-meter-value" + (pct >= alert ? " err" : "")}>
        {fmtPct(pct)}
      </span>
    </div>
  );
}

function ListTable({ rows, prefs }: { rows: Row[]; prefs: OverviewPrefs }) {
  const priv = usePrivacy();
  const menu = useHostMenu();
  const has = (k: MetricKey) => prefs.metrics.includes(k);
  const pctCell = (v: number | undefined) => (
    <td
      className={
        "num" + (v !== undefined && v >= prefs.alertPct ? " ov-err" : "")
      }
    >
      {v === undefined ? "" : fmtPct(v)}
    </td>
  );
  return (
    <div className="ov-table-wrap">
      <table className="table ov-table">
        <colgroup>
          <col className="c-name" />
          {has("cpu") && <col className="c-pct" />}
          {has("mem") && <col className="c-pct" />}
          {has("disk") && <col className="c-pct" />}
          {has("net") && <col className="c-rate" />}
          {has("net") && <col className="c-rate" />}
          {has("load") && <col className="c-load" />}
          {has("uptime") && <col className="c-up" />}
          {has("latency") && <col className="c-lat" />}
          <col className="c-act" />
        </colgroup>
        <thead>
          <tr>
            <th>名称</th>
            {has("cpu") && <th className="num">CPU</th>}
            {has("mem") && <th className="num">内存</th>}
            {has("disk") && <th className="num">磁盘</th>}
            {has("net") && <th className="num">下行</th>}
            {has("net") && <th className="num">上行</th>}
            {has("load") && <th className="num">负载</th>}
            {has("uptime") && <th className="num">运行</th>}
            {has("latency") && <th className="num">延迟</th>}
            <th className="ov-col-actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = r.stats;
            const text = statusText(r);
            return (
              <tr
                key={r.host.id}
                className={s ? "" : "off"}
                onDoubleClick={() => openTerminal(r.host.id)}
                onContextMenu={(e) => menu.open(e, r.host)}
              >
                <td>
                  <div className="ov-cell-name">
                    <span className={"dot " + DOT[r.status]} />
                    <span className="ellipsis">
                      {priv.text(r.host.name, r.host.host)}
                    </span>
                    {!s && (
                      <span
                        className={
                          "ov-cell-status ellipsis" +
                          (r.status === "failed" || r.status === "error"
                            ? " ov-err"
                            : "")
                        }
                        title={text}
                      >
                        {text}
                      </span>
                    )}
                  </div>
                </td>
                {has("cpu") && pctCell(s?.cpu)}
                {has("mem") && pctCell(s?.mem)}
                {has("disk") && pctCell(s?.disk)}
                {has("net") && (
                  <td className="num">{s ? fmtRate(s.rx) : ""}</td>
                )}
                {has("net") && (
                  <td className="num">{s ? fmtRate(s.tx) : ""}</td>
                )}
                {has("load") && (
                  <td className="num">{s ? s.load.toFixed(2) : ""}</td>
                )}
                {has("uptime") && (
                  <td className="num">{s ? fmtUptime(s.uptime) : ""}</td>
                )}
                {has("latency") && (
                  <td className="num">
                    {s ? <Latency hostId={r.host.id} /> : ""}
                  </td>
                )}
                <td className="ov-col-actions">
                  {s || r.status === "loading" || r.status === "error" ? (
                    <HostActions row={r} />
                  ) : r.status === "offline" || r.status === "failed" ? (
                    <button
                      className="btn ghost sm"
                      onClick={() => connectHosts([r.host.id])}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <Plug /> 连接
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {menu.node}
    </div>
  );
}

function CustomizeDialog({
  hosts,
  onClose,
}: {
  hosts: Host[];
  onClose: () => void;
}) {
  const prefs = useOverviewPrefs();
  const groupOrder = useGroupOrder();
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of hosts)
      counts.set(groupOf(h), (counts.get(groupOf(h)) ?? 0) + 1);
    const list = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) =>
        a.name === UNGROUPED
          ? 1
          : b.name === UNGROUPED
            ? -1
            : a.name.localeCompare(b.name, "zh-CN"),
      );
    return sortByGroupOrder(list, groupOrder);
  }, [hosts, groupOrder]);

  const toggleIn = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const toggleMetric = (k: MetricKey) => {
    const cur = getOverviewPrefs().metrics;
    setOverviewPrefs({
      metrics: METRICS.map((m) => m.key).filter((m) =>
        m === k ? !cur.includes(m) : cur.includes(m),
      ),
    });
  };

  return (
    <Dialog
      title="自定义概览"
      width={560}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          完成
        </button>
      }
    >
      <div className="stack gap-4">
        <Field label="指标" top>
          <div className="ov-chips">
            {METRICS.map((m) => (
              <button
                key={m.key}
                className={
                  "ov-chip" + (prefs.metrics.includes(m.key) ? " on" : "")
                }
                onClick={() => toggleMetric(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="告警线">
          <div className="seg">
            {[80, 90, 95].map((p) => (
              <button
                key={p}
                className={prefs.alertPct === p ? "on" : ""}
                onClick={() => setOverviewPrefs({ alertPct: p })}
              >
                {p}%
              </button>
            ))}
          </div>
        </Field>
        <Field label="仅已连接">
          <Toggle
            on={prefs.onlyConnected}
            onChange={(v) => setOverviewPrefs({ onlyConnected: v })}
          />
        </Field>
        <Field label="按分组">
          <Toggle
            on={prefs.grouped}
            onChange={(v) => setOverviewPrefs({ grouped: v })}
          />
        </Field>
        <Field label="分组" top>
          <div className="ov-groups">
            <div className="ov-groups-head">
              <span className="grow">名称</span>
              <span className="ov-groups-col">显示</span>
              <span className="ov-groups-col">打开时连接</span>
            </div>
            {groups.map((g) => (
              <div key={g.name} className="ov-groups-row">
                <span className="grow ellipsis">{g.name}</span>
                <span className="ov-groups-num">{g.count}</span>
                <span className="ov-groups-col">
                  <input
                    type="checkbox"
                    checked={!prefs.hiddenGroups.includes(g.name)}
                    onChange={() =>
                      setOverviewPrefs({
                        hiddenGroups: toggleIn(
                          getOverviewPrefs().hiddenGroups,
                          g.name,
                        ),
                      })
                    }
                  />
                </span>
                <span className="ov-groups-col">
                  <input
                    type="checkbox"
                    checked={prefs.autoGroups.includes(g.name)}
                    onChange={() =>
                      setOverviewPrefs({
                        autoGroups: toggleIn(
                          getOverviewPrefs().autoGroups,
                          g.name,
                        ),
                      })
                    }
                  />
                </span>
              </div>
            ))}
          </div>
        </Field>
      </div>
    </Dialog>
  );
}
