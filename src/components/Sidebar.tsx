// Left sidebar: search on top, then page links (首页 / 终端), the host list, and Agent / 设置 at the bottom.
import { Bot, House, Settings, SquareTerminal } from "lucide-react";
import { HostSidebar } from "../features/hosts/HostSidebar";
import { type ToolModal, type View, useApp } from "../store";

const PAGES: { view: View; label: string; icon: typeof House }[] = [
  { view: "home", label: "首页", icon: House },
  { view: "terminal", label: "终端", icon: SquareTerminal },
];

const TOOLS: { modal: ToolModal; label: string; icon: typeof House }[] = [{ modal: "agent", label: "Agent", icon: Bot }];

export function Sidebar() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  const sessions = useApp((s) => s.tabs.length);

  return (
    <div className="sb">

      <div className="sb-hosts">
        <HostSidebar
          header={
            <nav className="sb-pages">
              {PAGES.map((p) => (
                <button key={p.view} className={"sb-item" + (view === p.view ? " on" : "")} onClick={() => setView(p.view)}>
                  <p.icon />
                  <span>{p.label}</span>
                  {p.view === "terminal" && sessions > 0 && <span className="sb-count">{sessions}</span>}
                </button>
              ))}
            </nav>
          }
        />
      </div>

      <nav className="sb-tools">
        {TOOLS.map((t) => (
          <button key={t.modal} className={"sb-item" + (modal === t.modal ? " on" : "")} onClick={() => setModal(t.modal)}>
            <t.icon />
            <span>{t.label}</span>
          </button>
        ))}
        <button className={"sb-item" + (modal === "settings" ? " on" : "")} onClick={() => setModal("settings")}>
          <Settings />
          <span>设置</span>
        </button>
      </nav>
    </div>
  );
}
