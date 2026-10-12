// Terminal tabs + xterm sessions, command prediction, AI command bar.
import { Plus, Search, Server, X } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { type TermTab, useApp } from "../../store";
import { installAiPredictWatcher } from "./config";
import { closeTerminal, openTerminal } from "./open";
import { XTermView } from "./XTermView";
import "./terminal.css";

export function TerminalArea() {
  const tabs = useApp((s) => s.tabs);
  const activeTab = useApp((s) => s.activeTab);
  const view = useApp((s) => s.view);
  const setActiveTab = useApp((s) => s.setActiveTab);
  const [picker, setPicker] = useState(false);

  useEffect(() => installAiPredictWatcher(), []);

  const switchTab = (delta: number) => {
    const { tabs, activeTab } = useApp.getState();
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === activeTab);
    setActiveTab(tabs[(idx + delta + tabs.length) % tabs.length].id);
  };

  return (
    <div className="term-area">
      <div className="tabs term-tabs">
        <div className="term-tablist">
          {tabs.map((t) => (
            <TabItem key={t.id} tab={t} active={t.id === activeTab} onSelect={() => setActiveTab(t.id)} onClose={() => closeTerminal(t.id)} />
          ))}
        </div>
        <div className="term-add">
          <button className={"icon-btn" + (picker ? " active" : "")} title="新建终端" onClick={() => setPicker(!picker)}>
            <Plus />
          </button>
          {picker && <HostPicker onClose={() => setPicker(false)} />}
        </div>
      </div>

      <div className="term-stack">
        {tabs.map((t) => (
          <XTermView
            key={t.id}
            tab={t}
            active={t.id === activeTab && view === "terminal"}
            onClose={() => closeTerminal(t.id)}
            onSwitch={switchTab}
          />
        ))}
        {tabs.length === 0 && <EmptyState onNew={() => setPicker(true)} />}
      </div>
    </div>
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

function HostPicker(props: { onClose: () => void }) {
  const hosts = useApp((s) => s.hosts);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    const sorted = [...hosts].sort((a, b) => a.groupName.localeCompare(b.groupName) || a.sort - b.sort || a.name.localeCompare(b.name));
    if (!k) return sorted;
    return sorted.filter((h) =>
      [h.name, h.host, h.username, h.groupName, ...h.tags].some((s) => s.toLowerCase().includes(k)),
    );
  }, [hosts, q]);

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
