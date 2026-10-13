// Mobile: bottom navigation (replaces the title bar and sidebar) and the "更多" sheet with the tools.
import { Bot, Ellipsis, Eye, EyeOff, House, Layers, LayoutDashboard, Lock, Network, ScrollText, Settings, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { api, errMsg } from "../lib/api";
import { useKeyboardOpen } from "../lib/platform";
import { type ToolModal, type View, useApp } from "../store";
import { toast, useEscClose } from "./ui";

const PAGES: { view: View; label: string; icon: typeof House }[] = [
  { view: "home", label: "主机", icon: House },
  { view: "terminal", label: "终端", icon: SquareTerminal },
  { view: "overview", label: "概览", icon: LayoutDashboard },
];

const TOOLS: { modal: ToolModal; label: string; icon: typeof House }[] = [
  { modal: "snippets", label: "命令", icon: ScrollText },
  { modal: "tunnels", label: "隧道", icon: Network },
  { modal: "batch", label: "多机执行", icon: Layers },
  { modal: "agent", label: "Agent", icon: Bot },
  { modal: "settings", label: "设置", icon: Settings },
];

export function MobileNav() {
  const view = useApp((s) => s.view);
  const sessions = useApp((s) => s.tabs.length);
  const [more, setMore] = useState(false);
  // Keyboard up: the terminal needs every row.
  if (useKeyboardOpen()) return null;
  const go = (v: View) => {
    const s = useApp.getState();
    s.setModal(null);
    s.setSidePanel(null);
    s.setView(v);
  };
  return (
    <>
      <nav className="mnav">
        {PAGES.map((p) => (
          <button key={p.view} className={"mnav-item" + (view === p.view && !more ? " on" : "")} onClick={() => go(p.view)}>
            <span className="mnav-icon">
              <p.icon />
              {p.view === "terminal" && sessions > 0 && <span className="badge count">{sessions}</span>}
            </span>
            <span>{p.label}</span>
          </button>
        ))}
        <button className={"mnav-item" + (more ? " on" : "")} onClick={() => setMore(!more)}>
          <span className="mnav-icon">
            <Ellipsis />
          </span>
          <span>更多</span>
        </button>
      </nav>
      {more && <MoreSheet onClose={() => setMore(false)} />}
    </>
  );
}

function MoreSheet(props: { onClose: () => void }) {
  const privacy = useApp((s) => s.privacy);
  const passwordOn = useApp((s) => !!s.vault?.passwordEnabled);
  useEscClose(props.onClose, true);
  const pick = (run: () => void) => {
    props.onClose();
    run();
  };
  return (
    <div className="overlay msheet-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="msheet">
        {TOOLS.map((t) => (
          <button key={t.modal} className="msheet-item" onClick={() => pick(() => useApp.getState().setModal(t.modal))}>
            <t.icon />
            <span>{t.label}</span>
          </button>
        ))}
        <div className="msheet-sep" />
        <button className="msheet-item" onClick={() => pick(() => useApp.getState().setPrivacy(!privacy))}>
          {privacy ? <EyeOff /> : <Eye />}
          <span>{privacy ? "关闭隐私模式" : "隐私模式"}</span>
        </button>
        {passwordOn && (
          <button
            className="msheet-item"
            onClick={() =>
              pick(async () => {
                try {
                  await api.vaultLock();
                  await useApp.getState().refreshVault();
                } catch (e) {
                  toast(errMsg(e), "error");
                }
              })
            }
          >
            <Lock />
            <span>锁定</span>
          </button>
        )}
      </div>
    </div>
  );
}
