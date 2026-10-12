// Terminal tabs + xterm sessions, command prediction, AI command bar.
import {
  Activity, ArrowRightToLine, Copy, CopyPlus, FolderOpen, ListX, Pencil, Plus, RotateCw, Search, Settings2, X, XCircle,
} from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "../../components/ui";
import { nameIsAddr, usePrivacy } from "../../lib/privacy";
import { type TermTab, useApp } from "../../store";
import { installAiPredictWatcher } from "./config";
import { ConnectDialog } from "./ConnectDialog";
import { type MenuItem, useContextMenu } from "./ContextMenu";
import { closeTerminal, isPending, openTerminal, reopenTerminal } from "./open";
import { XTermView } from "./XTermView";
import "./terminal.css";

export function TerminalArea() {
  const tabs = useApp((s) => s.tabs);
  const activeTab = useApp((s) => s.activeTab);
  const view = useApp((s) => s.view);
  const setActiveTab = useApp((s) => s.setActiveTab);
  const [picker, setPicker] = useState(false);

  useEffect(() => installAiPredictWatcher(), []);

  const connecting = view === "terminal" ? tabs.find((t) => t.id === activeTab && t.connect) : undefined;

  /** Close a session; if it was active, activate a neighbour. */
  const closeTab = (id: string) => {
    const { activeTab, tabs: vis } = useApp.getState();
    const idx = vis.findIndex((t) => t.id === id);
    const rest = vis.filter((t) => t.id !== id);
    closeTerminal(id);
    if (activeTab === id && rest.length) setActiveTab(rest[Math.min(idx, rest.length - 1)].id);
  };

  /** Ctrl+Tab / Ctrl+Shift+Tab: cycle through sessions. */
  const switchTab = (delta: number) => {
    const vis = useApp.getState().tabs;
    if (vis.length < 2) return;
    const idx = vis.findIndex((t) => t.id === useApp.getState().activeTab);
    setActiveTab(vis[(idx + delta + vis.length) % vis.length].id);
  };

  const menu = useContextMenu();
  const [renaming, setRenaming] = useState<string | null>(null);

  const tabMenu = (t: TermTab): MenuItem[] => {
    const { tabs: all, hosts } = useApp.getState();
    const h = hosts.find((x) => x.id === t.hostId);
    const idx = all.findIndex((x) => x.id === t.id);
    const connecting = !!t.connect && !t.connect.error;
    const side = (p: "monitor" | "files") => {
      setActiveTab(t.id);
      useApp.getState().setPanelHost(t.hostId);
      useApp.getState().setSidePanel(p);
    };
    return [
      { label: "复制会话", icon: <CopyPlus />, onSelect: () => void openTerminal(t.hostId) },
      { label: "重新连接", icon: <RotateCw />, disabled: connecting || isPending(t.id), onSelect: () => void reopenTerminal(t.id) },
      { label: "重命名", icon: <Pencil />, onSelect: () => setRenaming(t.id) },
      "sep",
      { label: "服务器状态", icon: <Activity />, onSelect: () => side("monitor") },
      { label: "文件", icon: <FolderOpen />, onSelect: () => side("files") },
      h && { label: "编辑服务器", icon: <Settings2 />, onSelect: () => useApp.getState().openEditor(h.id) },
      h && {
        label: "复制地址",
        icon: <Copy />,
        onSelect: () =>
          navigator.clipboard.writeText(`${h.username}@${h.host}${h.port !== 22 ? `:${h.port}` : ""}`).then(
            () => toast("已复制地址", "success"),
            () => toast("复制失败", "error"),
          ),
      },
      "sep",
      { label: "关闭", icon: <X />, hint: "Ctrl+W", onSelect: () => closeTab(t.id) },
      { label: "关闭其他", icon: <XCircle />, disabled: all.length < 2, onSelect: () => all.filter((x) => x.id !== t.id).forEach((x) => closeTab(x.id)) },
      {
        label: "关闭右侧",
        icon: <ArrowRightToLine />,
        disabled: idx === all.length - 1,
        onSelect: () => all.slice(idx + 1).forEach((x) => closeTab(x.id)),
      },
      { label: "关闭所有", icon: <ListX />, onSelect: () => all.forEach((x) => closeTab(x.id)) },
    ];
  };

  const addBtn = (
    <div className="term-add">
      <button className={"icon-btn" + (picker ? " active" : "")} title="新建终端" onClick={() => setPicker(!picker)}>
        <Plus />
      </button>
      {picker && <HostPicker onClose={() => setPicker(false)} />}
    </div>
  );

  return (
    <div className="term-area">
      <div className="tabs term-tabs">
        <div className="term-tablist">
          {tabs.map((t) => (
            <TabItem
              key={t.id}
              tab={t}
              active={t.id === activeTab}
              renaming={renaming === t.id}
              onRenamed={() => setRenaming(null)}
              onSelect={() => setActiveTab(t.id)}
              onClose={() => closeTab(t.id)}
              onMenu={(e) => menu.open(e, tabMenu(t))}
            />
          ))}
        </div>
        {addBtn}
      </div>
      {menu.node}

      <div className="term-stack">
        {tabs.map((t) =>
          isPending(t.id) ? (
            <div key={t.id} className="term-view" style={{ display: t.id === activeTab ? "flex" : "none" }} />
          ) : (
            <XTermView
              key={t.id}
              tab={t}
              active={t.id === activeTab && view === "terminal"}
              onClose={() => closeTab(t.id)}
              onSwitch={switchTab}
            />
          ),
        )}
        {connecting?.connect && <ConnectDialog key={connecting.id + connecting.connect.started} tab={connecting} />}
        {tabs.length === 0 && <EmptyState onNew={() => setPicker(true)} />}
      </div>
    </div>
  );
}

function TabItem(props: {
  tab: TermTab;
  active: boolean;
  renaming: boolean;
  onRenamed: () => void;
  onSelect: () => void;
  onClose: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const { tab, active } = props;
  const host = useApp((s) => s.hosts.find((h) => h.id === tab.hostId));
  const color = host?.color;
  const priv = usePrivacy();
  const addr = host?.host ?? "";
  const title = priv.text(tab.title, addr);
  const showAddr = !!addr && !nameIsAddr(tab.title, addr);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <div
      ref={ref}
      className={"tab term-tab" + (active ? " active" : "")}
      style={color ? ({ "--host-color": color } as CSSProperties) : undefined}
      title={title + (showAddr ? ` ${priv.addr(addr)}` : "") + (tab.connect && !tab.connect.error ? "（连接中）" : tab.alive ? "" : "（已断开）")}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
      }}
      onAuxClick={(e) => {
        if (e.button === 1) props.onClose();
      }}
      onClick={props.onSelect}
      onContextMenu={props.onMenu}
    >
      <span className={"dot " + (tab.connect && !tab.connect.error ? "warn" : tab.alive ? "ok" : "err")} />
      {props.renaming ? (
        <input
          className="term-tab-rename"
          autoFocus
          defaultValue={tab.title}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== tab.title) useApp.getState().updateTab(tab.id, { title: v });
            props.onRenamed();
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.currentTarget.value = tab.title;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <span className="ellipsis term-tab-name">{title}</span>
      )}
      {showAddr && <span className="ellipsis term-tab-addr">{priv.addr(addr)}</span>}
      <span className="grow" />
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

/** Connection state → [dot/text class, label]; idle hosts have no entry. */
const CONN_LABEL: Record<string, [string, string]> = {
  connected: ["ok", "已连接"],
  connecting: ["warn", "连接中"],
  error: ["err", "失败"],
};
/** Picker order: connected, then connecting, then the rest. */
const connRank = (s?: string) => (s === "connected" ? 0 : s === "connecting" ? 1 : 2);

function HostPicker(props: { onClose: () => void }) {
  const hosts = useApp((s) => s.hosts);
  const conn = useApp((s) => s.conn);
  const priv = usePrivacy();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    const sorted = [...hosts].sort(
      (a, b) =>
        connRank(conn[a.id]?.state) - connRank(conn[b.id]?.state) ||
        a.groupName.localeCompare(b.groupName) ||
        a.sort - b.sort ||
        a.name.localeCompare(b.name),
    );
    if (!k) return sorted;
    return sorted.filter((h) =>
      [h.name, h.host, h.username, h.groupName, ...h.tags].some((s) => s.toLowerCase().includes(k)),
    );
  }, [hosts, conn, q]);

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
        {list.map((h, i) => {
          const st = CONN_LABEL[conn[h.id]?.state ?? ""];
          return (
          <div
            key={h.id}
            className={"list-row" + (i === sel ? " selected" : "")}
            style={h.color ? ({ "--host-color": h.color } as CSSProperties) : undefined}
            onMouseEnter={() => setSel(i)}
            onClick={() => pick(h.id)}
          >
            <span className="host-picker-state" title={st?.[1] ?? "未连接"}>
              <span className={"dot" + (st ? " " + st[0] : "")} />
            </span>
            <span className="ellipsis grow">{priv.text(h.name, h.host)}</span>
            {st && <span className={"host-picker-status " + st[0]}>{st[1]}</span>}
            <span className="meta ellipsis mono host-picker-addr">
              {h.username}@{priv.addr(h.host)}
              {h.port !== 22 ? `:${h.port}` : ""}
            </span>
          </div>
          );
        })}
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
