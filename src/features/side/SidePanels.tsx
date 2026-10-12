// Right-hand side panel: configurable tab row (pinned panels), "+" menu for the rest, and the panel body.
import { Activity, Bot, Box, FolderOpen, PanelRightClose, Plus, ScrollText, SquareMousePointer, Wrench } from "lucide-react";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { Empty } from "../../components/ui";
import { type SidePanelId, useApp } from "../../store";
import { AiPanel } from "../ai/AiPanel";
import { DockerPanel } from "../docker/DockerPanel";
import { FilesPanel } from "../files/FilesPanel";
import { MonitorPanel } from "../monitor/MonitorPanel";
import { SnippetsPanel } from "../snippets/SnippetsPanel";
import { useContextMenu } from "../terminal/ContextMenu";
import { ToolboxPanel } from "../toolbox/ToolboxPanel";
import { panelItems, SidePanelCtx, togglePin } from "./panelMenu";
import "./side.css";

interface PanelDef {
  id: SidePanelId;
  icon: typeof Activity;
  label: string;
  /** Rendered with the panel host; null host shows "未选择服务器" unless `global`. */
  Body: ComponentType<{ hostId: string }>;
  global?: boolean;
}

export const PANELS: PanelDef[] = [
  { id: "monitor", icon: Activity, label: "状态", Body: MonitorPanel },
  { id: "files", icon: FolderOpen, label: "文件", Body: FilesPanel },
  { id: "toolbox", icon: Wrench, label: "工具", Body: ToolboxPanel },
  { id: "docker", icon: Box, label: "Docker", Body: DockerPanel },
  { id: "ai", icon: Bot, label: "AI", Body: AiPanel },
  { id: "snippets", icon: ScrollText, label: "命令", Body: ({ hostId }) => <SnippetsPanel hostId={hostId || null} />, global: true },
];

const def = (id: SidePanelId) => PANELS.find((p) => p.id === id)!;

export function SideTabs() {
  const sidePanel = useApp((s) => s.sidePanel);
  const pins = useApp((s) => s.sidePins);
  const setSidePanel = useApp((s) => s.setSidePanel);
  const [menu, setMenu] = useState(false);
  const ctx = useContextMenu();
  // An unpinned panel opened from the "+" menu shows as a temporary tab at the end.
  const tabs = [...pins, ...(sidePanel && !pins.includes(sidePanel) ? [sidePanel] : [])].map(def);
  return (
    <div className={"side-tabs" + (tabs.length > 4 ? " compact" : "")}>
      {tabs.map((p) => (
        <button
          key={p.id}
          className={sidePanel === p.id ? "on" : ""}
          title={p.label}
          onClick={() => setSidePanel(p.id)}
          onContextMenu={(e) =>
            ctx.open(e, [
              { label: "打开面板", icon: <SquareMousePointer />, disabled: sidePanel === p.id, onSelect: () => setSidePanel(p.id) },
              "sep",
              ...panelItems(p.id),
            ])
          }
        >
          <p.icon />
          <span>{p.label}</span>
        </button>
      ))}
      <div className="side-more">
        <button className={"side-collapse" + (menu ? " open" : "")} title="更多面板" onClick={() => setMenu(!menu)}>
          <Plus />
        </button>
        {menu && <PanelMenu onClose={() => setMenu(false)} />}
      </div>
      <button className="side-collapse" title="收起" onClick={() => setSidePanel(null)}>
        <PanelRightClose />
      </button>
      {ctx.node}
    </div>
  );
}

/** Every panel: click opens it, the check pins it to the tab row. */
function PanelMenu(props: { onClose: () => void }) {
  const pins = useApp((s) => s.sidePins);
  const sidePanel = useApp((s) => s.sidePanel);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement!.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [props.onClose]);

  return (
    <div ref={ref} className="side-menu">
      {PANELS.map((p) => {
        const pinned = pins.includes(p.id);
        return (
          <div key={p.id} className={"list-row" + (sidePanel === p.id ? " selected" : "")}>
            <button
              className="side-menu-open"
              onClick={() => {
                useApp.getState().setSidePanel(p.id);
                props.onClose();
              }}
            >
              <p.icon />
              <span className="grow ellipsis">{p.label}</span>
            </button>
            <label className="side-menu-pin" title={pinned ? "从标签栏移除" : "固定到标签栏"}>
              <input type="checkbox" checked={pinned} disabled={pinned && pins.length === 1} onChange={() => togglePin(p.id)} />
            </label>
          </div>
        );
      })}
    </div>
  );
}

export function SideBody() {
  const sidePanel = useApp((s) => s.sidePanel);
  const hostId = useApp((s) => s.panelHostId);
  const ctx = useContextMenu();
  if (!sidePanel) return null;
  const p = def(sidePanel);
  // Blank space in any panel: the panel group. Rows and panels with their own menus append it themselves;
  // text fields and selected text fall through to the global menu.
  const onBlank = (e: React.MouseEvent) => {
    if (e.isDefaultPrevented()) return; // a row or panel already showed its own menu
    if (!(e.currentTarget as Element).contains(e.target as Node)) return; // bubbled from a portaled dialog
    const t = e.target as Element;
    if (t.closest("input, textarea, select, [contenteditable='true']") || window.getSelection()?.toString().trim()) return;
    ctx.open(e, panelItems(p.id));
  };
  return (
    <SidePanelCtx.Provider value={p.id}>
      <div className="side-body-menu" onContextMenu={onBlank}>
        {!hostId && !p.global ? <Empty text="未选择服务器" /> : <p.Body key={hostId ?? ""} hostId={hostId ?? ""} />}
      </div>
      {ctx.node}
    </SidePanelCtx.Provider>
  );
}

/** Collapsed side panel: icons of the pinned panels. */
export function SideRail() {
  const pins = useApp((s) => s.sidePins);
  return (
    <>
      {pins.map(def).map((p) => (
        <button key={p.id} className="side-rail-btn" title={p.label} onClick={() => useApp.getState().setSidePanel(p.id)}>
          <p.icon />
        </button>
      ))}
    </>
  );
}
