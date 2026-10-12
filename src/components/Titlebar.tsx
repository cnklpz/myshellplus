// Custom window chrome: app mark, view switcher, window controls. The bar itself is the drag region.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { type View, useApp } from "../store";

const VIEWS: { view: View; label: string }[] = [
  { view: "terminal", label: "终端" },
  { view: "batch", label: "批量" },
  { view: "tunnels", label: "隧道" },
  { view: "agent", label: "Agent" },
  { view: "settings", label: "设置" },
];

const inTauri = "__TAURI_INTERNALS__" in window;

function win() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function Titlebar() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const w = win();
    if (!w || !inTauri) return;
    const sync = () => w.isMaximized().then(setMaximized).catch(() => {});
    sync();
    const un = w.onResized(sync);
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="tb-brand" data-tauri-drag-region>
        <svg viewBox="0 0 24 24" className="tb-mark" aria-hidden>
          <rect x="1" y="1" width="22" height="22" rx="6" />
          <path d="M7 8.5 10.5 12 7 15.5M12.5 15.5H17" />
        </svg>
        <span data-tauri-drag-region>MyShell+</span>
      </div>

      <nav className="tb-nav">
        {VIEWS.map((v) => (
          <button key={v.view} className={view === v.view ? "on" : ""} onClick={() => setView(v.view)}>
            {v.label}
          </button>
        ))}
      </nav>

      <div className="spacer" data-tauri-drag-region />

      <button
        className="tb-btn"
        title="锁定"
        onClick={async () => {
          await api.vaultLock();
          await useApp.getState().refreshVault();
        }}
      >
        <Lock />
      </button>
      <div className="tb-sep" />
      <button className="tb-btn" title="最小化" onClick={() => win()?.minimize()}>
        <svg viewBox="0 0 12 12"><path d="M2 6h8" /></svg>
      </button>
      <button className="tb-btn" title={maximized ? "还原" : "最大化"} onClick={() => win()?.toggleMaximize()}>
        {maximized ? (
          <svg viewBox="0 0 12 12"><path d="M3.5 4.5h4v4h-4zM4.5 4.5V3.5h4v4h-1" /></svg>
        ) : (
          <svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" /></svg>
        )}
      </button>
      <button className="tb-btn close" title="关闭" onClick={() => win()?.close()}>
        <svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" /></svg>
      </button>
    </header>
  );
}
