import { listen } from "@tauri-apps/api/event";
import { Activity, Bot, FolderOpen, Layers, Lock, Network, ScrollText, Settings, SquareTerminal, X } from "lucide-react";
import { useEffect } from "react";
import { Toasts } from "./components/ui";
import { AgentView } from "./features/agent/AgentView";
import { PromptCenter } from "./features/agent/PromptCenter";
import { BatchView } from "./features/batch/BatchView";
import { FilesPanel } from "./features/files/FilesPanel";
import { HostEditor } from "./features/hosts/HostEditor";
import { HostSidebar } from "./features/hosts/HostSidebar";
import { ImportDialog } from "./features/import/ImportDialog";
import { MonitorPanel } from "./features/monitor/MonitorPanel";
import { SettingsView } from "./features/settings/SettingsView";
import { SnippetsPanel } from "./features/snippets/SnippetsPanel";
import { TerminalArea } from "./features/terminal/TerminalArea";
import { TunnelsView } from "./features/tunnels/TunnelsView";
import { VaultGate } from "./features/vault/VaultGate";
import { api, type ConnState } from "./lib/api";
import { type SidePanel, type View, useApp } from "./store";
import "./App.css";

const NAV: { view: View; icon: typeof SquareTerminal; label: string }[] = [
  { view: "terminal", icon: SquareTerminal, label: "终端" },
  { view: "batch", icon: Layers, label: "批量执行" },
  { view: "tunnels", icon: Network, label: "隧道" },
  { view: "agent", icon: Bot, label: "Agent" },
  { view: "settings", icon: Settings, label: "设置" },
];

const PANELS: { id: Exclude<SidePanel, null>; icon: typeof Activity; label: string }[] = [
  { id: "monitor", icon: Activity, label: "状态" },
  { id: "files", icon: FolderOpen, label: "文件" },
  { id: "snippets", icon: ScrollText, label: "片段" },
];

/** Restore state from the backend: sessions survive a webview reload. */
async function bootstrap() {
  const s = useApp.getState();
  await s.refreshVault();
  await s.refreshHosts();
  for (const id of await api.connList()) s.setConn({ hostId: id, state: "connected" });
  const hosts = useApp.getState().hosts;
  const sessions = await api.termList();
  for (const t of sessions) {
    if (useApp.getState().tabs.some((x) => x.id === t.id)) continue;
    const h = hosts.find((x) => x.id === t.hostId);
    useApp.getState().addTab({ id: t.id, hostId: t.hostId, title: h?.name ?? "终端", alive: t.alive });
  }
}

export default function App() {
  const vault = useApp((s) => s.vault);
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const sidePanel = useApp((s) => s.sidePanel);
  const setSidePanel = useApp((s) => s.setSidePanel);
  const panelHostId = useApp((s) => s.panelHostId);
  const editingHost = useApp((s) => s.editingHost);
  const importOpen = useApp((s) => s.importOpen);
  const panelHost = useApp((s) => s.hosts.find((h) => h.id === s.panelHostId));

  useEffect(() => {
    const theme = localStorageGet("theme");
    if (theme) document.documentElement.dataset.theme = theme;
    bootstrap();
    // Watchdog heartbeat: the backend reloads the webview if this stops while the window is visible.
    api.uiHeartbeat();
    const beat = setInterval(() => api.uiHeartbeat().catch(() => {}), 5000);
    const un = [
      listen<ConnState>("conn-state", (e) => useApp.getState().setConn(e.payload)),
      listen<string>("term-exit", (e) => useApp.getState().updateTab(e.payload, { alive: false })),
    ];
    return () => {
      clearInterval(beat);
      un.forEach((p) => p.then((f) => f()));
    };
  }, []);

  if (!vault) return null;
  const locked = !vault.unlocked;
  const showSide = view === "terminal" && sidePanel !== null;

  return (
    <div className={"app" + (showSide ? " with-side" : "")}>
      <nav className="nav-rail">
        {NAV.map((n) => (
          <button key={n.view} className={"icon-btn md" + (view === n.view ? " active" : "")} title={n.label} onClick={() => setView(n.view)}>
            <n.icon />
          </button>
        ))}
        <span className="spacer" />
        <button
          className="icon-btn md"
          title="锁定"
          onClick={async () => {
            await api.vaultLock();
            await useApp.getState().refreshVault();
          }}
        >
          <Lock />
        </button>
      </nav>

      <aside className="sidebar">
        <HostSidebar />
      </aside>

      <main className="main">
        {/* Terminals stay mounted while other views are shown so xterm state is kept. */}
        <div className="view" style={{ display: view === "terminal" ? "flex" : "none" }}>
          <TerminalArea />
          {view === "terminal" && sidePanel === null && (
            <div className="side-toggles">
              {PANELS.map((p) => (
                <button key={p.id} className="icon-btn" title={p.label} onClick={() => setSidePanel(p.id)}>
                  <p.icon />
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Batch stays mounted so a running batch and its history survive view switches. */}
        <div className="view" style={{ display: view === "batch" ? "flex" : "none" }}>
          <BatchView />
        </div>
        {view === "tunnels" && <TunnelsView />}
        {view === "agent" && <AgentView />}
        {view === "settings" && <SettingsView />}
      </main>

      {showSide && (
        <aside className="side panel">
          <div className="panel-header">
            <div className="seg">
              {PANELS.map((p) => (
                <button key={p.id} className={sidePanel === p.id ? "on" : ""} onClick={() => setSidePanel(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
            <span className="grow ellipsis faint" style={{ fontWeight: 400, fontSize: "var(--fs-sm)" }}>
              {panelHost?.name}
            </span>
            <button className="icon-btn" title="收起" onClick={() => setSidePanel(null)}>
              <X />
            </button>
          </div>
          {sidePanel === "snippets" ? (
            <SnippetsPanel hostId={panelHostId} />
          ) : panelHostId ? (
            sidePanel === "monitor" ? (
              <MonitorPanel key={panelHostId} hostId={panelHostId} />
            ) : (
              <FilesPanel key={panelHostId} hostId={panelHostId} />
            )
          ) : (
            <div className="empty">打开一个终端后显示该服务器的{sidePanel === "monitor" ? "状态" : "文件"}</div>
          )}
        </aside>
      )}

      {editingHost !== null && <HostEditor />}
      {importOpen && <ImportDialog />}
      <PromptCenter />
      <Toasts />
      {locked && <VaultGate />}
    </div>
  );
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
