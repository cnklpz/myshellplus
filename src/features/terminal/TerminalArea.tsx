// Terminal tabs + xterm sessions, command prediction, AI command bar.
// Two-level tab bar: group tabs (derived from the hosts of open sessions) above the session tabs.
import { PanelBottom, Plus, Search, Server, X } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { type TermTab, useApp } from "../../store";
import { installAiPredictWatcher } from "./config";
import { closeTerminal, openTerminal } from "./open";
import { XTermView } from "./XTermView";
import "./terminal.css";

/** Group of a session = its host's group ("" = ungrouped / unknown host). */
function tabGroup(t: TermTab): string {
  return useApp.getState().hosts.find((h) => h.id === t.hostId)?.groupName ?? "";
}

/** Sessions shown in the session bar for the current group filter. */
function visibleTabs(): TermTab[] {
  const { tabs, termGroup } = useApp.getState();
  return termGroup ? tabs.filter((t) => tabGroup(t) === termGroup) : tabs;
}

export function TerminalArea() {
  const tabs = useApp((s) => s.tabs);
  const hosts = useApp((s) => s.hosts);
  const activeTab = useApp((s) => s.activeTab);
  const view = useApp((s) => s.view);
  const termGroup = useApp((s) => s.termGroup);
  const setActiveTab = useApp((s) => s.setActiveTab);
  const setTermGroup = useApp((s) => s.setTermGroup);
  const composerOpen = useApp((s) => s.composerOpen);
  const setComposerOpen = useApp((s) => s.setComposerOpen);
  const [picker, setPicker] = useState(false);

  useEffect(() => installAiPredictWatcher(), []);

  const groupOf = useMemo(() => {
    const m = new Map(hosts.map((h) => [h.id, h.groupName]));
    return (t: TermTab) => m.get(t.hostId) ?? "";
  }, [hosts]);

  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tabs) {
      const g = groupOf(t);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (a.name === "" ? 1 : b.name === "" ? -1 : a.name.localeCompare(b.name)));
  }, [tabs, groupOf]);

  const showGroups = groups.length > 1;
  const shown = termGroup ? tabs.filter((t) => groupOf(t) === termGroup) : tabs;

  // Keep the filter valid: drop a group that has no sessions left (or when the group bar is hidden).
  useEffect(() => {
    if (termGroup && (!showGroups || !groups.some((g) => g.name === termGroup))) setTermGroup("");
  }, [termGroup, groups, showGroups, setTermGroup]);

  // A newly activated session outside the filter (new tab, sidebar open...) switches to its group.
  useEffect(() => {
    const t = useApp.getState().tabs.find((x) => x.id === activeTab);
    const { termGroup } = useApp.getState();
    if (t && termGroup && tabGroup(t) !== termGroup) setTermGroup(tabGroup(t));
  }, [activeTab, setTermGroup]);

  const selectGroup = (g: string) => {
    setTermGroup(g);
    const { tabs, activeTab } = useApp.getState();
    const inGroup = g ? tabs.filter((t) => tabGroup(t) === g) : tabs;
    if (inGroup.length && !inGroup.some((t) => t.id === activeTab)) setActiveTab(inGroup[0].id);
  };

  /** Close a session; if it was active, prefer a neighbour inside the visible group. */
  const closeTab = (id: string) => {
    const { activeTab } = useApp.getState();
    const vis = visibleTabs();
    const idx = vis.findIndex((t) => t.id === id);
    const rest = vis.filter((t) => t.id !== id);
    closeTerminal(id);
    if (activeTab === id && rest.length) setActiveTab(rest[Math.min(idx, rest.length - 1)].id);
  };

  /** Ctrl+Tab / Ctrl+Shift+Tab: cycle within the visible group. */
  const switchTab = (delta: number) => {
    const vis = visibleTabs();
    if (vis.length < 2) return;
    const idx = vis.findIndex((t) => t.id === useApp.getState().activeTab);
    setActiveTab(vis[(idx + delta + vis.length) % vis.length].id);
  };

  const addBtn = (
    <div className={"term-add" + (showGroups ? " end" : "")}>
      <button className={"icon-btn" + (picker ? " active" : "")} title="新建终端" onClick={() => setPicker(!picker)}>
        <Plus />
      </button>
      {picker && <HostPicker group={termGroup} onClose={() => setPicker(false)} />}
    </div>
  );

  return (
    <div className="term-area">
      {showGroups && (
        <div className="term-groups">
          <div className="term-grouplist">
            <GroupTab label="全部" count={tabs.length} on={termGroup === ""} onClick={() => selectGroup("")} />
            {groups.map((g) => (
              <GroupTab
                key={g.name}
                label={g.name || "未分组"}
                count={g.count}
                on={termGroup === g.name}
                onClick={() => selectGroup(g.name)}
              />
            ))}
          </div>
          {addBtn}
        </div>
      )}

      <div className="tabs term-tabs">
        <div className="term-tablist">
          {shown.map((t) => (
            <TabItem key={t.id} tab={t} active={t.id === activeTab} onSelect={() => setActiveTab(t.id)} onClose={() => closeTab(t.id)} />
          ))}
        </div>
        {!showGroups && addBtn}
        {tabs.length > 0 && (
          <div className="term-tools">
            <button
              className={"icon-btn" + (composerOpen ? " active" : "")}
              title="批量执行"
              onClick={() => setComposerOpen(!composerOpen)}
            >
              <PanelBottom />
            </button>
          </div>
        )}
      </div>

      <div className="term-stack">
        {tabs.map((t) => (
          <XTermView
            key={t.id}
            tab={t}
            active={t.id === activeTab && view === "terminal"}
            onClose={() => closeTab(t.id)}
            onSwitch={switchTab}
          />
        ))}
        {tabs.length === 0 && <EmptyState onNew={() => setPicker(true)} />}
      </div>
    </div>
  );
}

function GroupTab(props: { label: string; count: number; on: boolean; onClick: () => void }) {
  return (
    <button className={"term-group" + (props.on ? " on" : "")} title={props.label} onClick={props.onClick}>
      <span className="ellipsis">{props.label}</span>
      <span className="term-group-count">{props.count}</span>
    </button>
  );
}

function TabItem(props: { tab: TermTab; active: boolean; onSelect: () => void; onClose: () => void }) {
  const { tab, active } = props;
  const color = useApp((s) => s.hosts.find((h) => h.id === tab.hostId)?.color);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <div
      ref={ref}
      className={"tab term-tab" + (active ? " active" : "")}
      style={color ? ({ "--host-color": color } as CSSProperties) : undefined}
      title={tab.title + (tab.alive ? "" : "（已断开）")}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
      }}
      onAuxClick={(e) => {
        if (e.button === 1) props.onClose();
      }}
      onClick={props.onSelect}
    >
      <span className={"dot " + (tab.alive ? "ok" : "err")} />
      <span className="ellipsis grow">{tab.title}</span>
      {tab.alive && <LatencyTag hostId={tab.hostId} />}
      <button
        className="icon-btn term-tab-close"
        title="关闭 (Ctrl+W)"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        <X />
      </button>
    </div>
  );
}

/** Network round trip, shown only when it is noticeable. */
function LatencyTag({ hostId }: { hostId: string }) {
  const ms = useApp((s) => s.latency[hostId]);
  if (ms === undefined) return null;
  if (ms === null) return <span className="term-latency err">超时</span>;
  if (ms < 60) return null;
  return <span className={"term-latency" + (ms >= 200 ? " err" : " warn")}>{ms}ms</span>;
}

/** `group`: the selected terminal group; its hosts are listed first. */
function HostPicker(props: { group: string; onClose: () => void }) {
  const hosts = useApp((s) => s.hosts);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    const g = props.group;
    const rank = (groupName: string) => (g && groupName === g ? 0 : 1);
    const sorted = [...hosts].sort(
      (a, b) =>
        rank(a.groupName) - rank(b.groupName) ||
        a.groupName.localeCompare(b.groupName) ||
        a.sort - b.sort ||
        a.name.localeCompare(b.name),
    );
    if (!k) return sorted;
    return sorted.filter((h) =>
      [h.name, h.host, h.username, h.groupName, ...h.tags].some((s) => s.toLowerCase().includes(k)),
    );
  }, [hosts, q, props.group]);

  useEffect(() => setSel(0), [q]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = boxRef.current;
      if (el && !el.parentElement!.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [props.onClose]);

  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const pick = (id: string | undefined) => {
    if (!id) return;
    props.onClose();
    openTerminal(id);
  };

  return (
    <div ref={boxRef} className="host-picker">
      <div className="host-picker-search row">
        <Search className="host-picker-icon" />
        <input
          autoFocus
          className="grow"
          placeholder="搜索服务器"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, list.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(list[sel]?.id);
            } else if (e.key === "Escape") {
              e.preventDefault();
              props.onClose();
            }
          }}
        />
      </div>
      <div className="host-picker-list" ref={listRef}>
        {list.map((h, i) => (
          <div
            key={h.id}
            className={"list-row" + (i === sel ? " selected" : "")}
            onMouseEnter={() => setSel(i)}
            onClick={() => pick(h.id)}
          >
            {h.color ? <span className="host-picker-color"><span className="dot" style={{ background: h.color }} /></span> : <Server />}
            <span className="ellipsis grow">{h.name}</span>
            <span className="meta ellipsis mono host-picker-addr">
              {h.username}@{h.host}
              {h.port !== 22 ? `:${h.port}` : ""}
            </span>
          </div>
        ))}
        {list.length === 0 && <div className="host-picker-empty faint">{hosts.length ? "无匹配服务器" : "还没有服务器"}</div>}
      </div>
    </div>
  );
}

function EmptyState(props: { onNew: () => void }) {
  return (
    <div className="term-empty">
      <span>双击左侧服务器开始</span>
      <button className="btn sm" onClick={props.onNew}>
        <Plus />
        新建终端
      </button>
    </div>
  );
}
