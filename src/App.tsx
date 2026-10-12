import { listen } from "@tauri-apps/api/event";
import { Activity, FolderOpen, PanelRightClose, ScrollText } from "lucide-react";
import { useEffect } from "react";
import { GlobalContextMenu } from "./components/GlobalContextMenu";
import { PageModal } from "./components/PageModal";
import { Sidebar } from "./components/Sidebar";
import { Titlebar } from "./components/Titlebar";
import { Toasts } from "./components/ui";
import { AgentView } from "./features/agent/AgentView";
import { PromptCenter } from "./features/agent/PromptCenter";
import { BatchView } from "./features/batch/BatchView";
import { FilesPanel } from "./features/files/FilesPanel";
import { HostEditor } from "./features/hosts/HostEditor";
import { HomeView } from "./features/home/HomeView";
import { ImportDialog } from "./features/import/ImportDialog";
import { MonitorPanel } from "./features/monitor/MonitorPanel";
import { SettingsView } from "./features/settings/SettingsView";
import { SnippetsPanel } from "./features/snippets/SnippetsPanel";
import { TerminalArea } from "./features/terminal/TerminalArea";
import { TunnelsView } from "./features/tunnels/TunnelsView";
import { VaultGate } from "./features/vault/VaultGate";
import { api, type ConnState, type Latency } from "./lib/api";
import { type SidePanel, type ToolModal, useApp } from "./store";
import "./App.css";

const PANELS: { id: Exclude<SidePanel, null>; icon: typeof Activity; label: string }[] = [
  { id: "monitor", icon: Activity, label: "状态" },
  { id: "files", icon: FolderOpen, label: "文件" },
  { id: "snippets", icon: ScrollText, label: "命令" },
];

/** Restore state from the backend: sessions survive a webview reload. */
async function bootstrap() {
  const s = useApp.getState();
  await s.refreshVault();
  await s.refreshHosts();
  for (const id of await api.connList()) s.setConn({ hostId: id, state: "connected" });
  for (const l of await api.connLatency()) s.setLatency(l.hostId, l.ms);
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
  const modal = useApp((s) => s.modal);
  const sidePanel = useApp((s) => s.sidePanel);
  const setSidePanel = useApp((s) => s.setSidePanel);
  const panelHostId = useApp((s) => s.panelHostId);
  const editingHost = useApp((s) => s.editingHost);
  const importOpen = useApp((s) => s.importOpen);

  useEffect(() => {
    bootstrap();
    // Watchdog heartbeat: the backend reloads the webview if this stops while the window is visible.
    api.uiHeartbeat();
    const beat = setInterval(() => api.uiHeartbeat().catch(() => {}), 5000);
    const un = [
      listen<ConnState>("conn-state", (e) => useApp.getState().setConn(e.payload)),
      listen<Latency>("latency", (e) => useApp.getState().setLatency(e.payload.hostId, e.payload.ms)),
      listen<string>("term-exit", (e) => useApp.getState().updateTab(e.payload, { alive: false })),
    ];
    return () => {
      clearInterval(beat);
      un.forEach((p) => p.then((f) => f()));
    };
  }, []);

  if (!vault) return null;
  const locked = !vault.unlocked;
  const onTerminal = view === "terminal";
  const showSide = onTerminal && sidePanel !== null;
  const closeModal = () => useApp.getState().setModal(null);

  return (
    <div className="shell">
      <Titlebar />
      <div className={"app" + (showSide ? " with-side" : "") + (onTerminal && !showSide ? " with-rail" : "")}>
        <aside className="sidebar">
          <Sidebar />
        </aside>

        <main className="main">
          {/* Terminals stay mounted on every page so xterm state is kept. */}
          <div className="view" style={{ display: onTerminal ? "flex" : "none" }}>
            <TerminalArea />
          </div>
          {view === "home" && (
            <div className="view" style={{ display: "flex" }}>
              <HomeView />
            </div>
          )}
        </main>

        {showSide && (
          <aside className="side">
            <div className="side-tabs">
              {PANELS.map((p) => (
                <button key={p.id} className={sidePanel === p.id ? "on" : ""} onClick={() => setSidePanel(p.id)}>
                  <p.icon />
                  <span>{p.label}</span>
                </button>
              ))}
              <button className="side-collapse" title="收起" onClick={() => setSidePanel(null)}>
                <PanelRightClose />
              </button>
            </div>
            <div className="side-body">
              {sidePanel === "snippets" ? (
                <SnippetsPanel hostId={panelHostId} />
              ) : panelHostId ? (
                sidePanel === "monitor" ? (
                  <MonitorPanel key={panelHostId} hostId={panelHostId} />
                ) : (
                  <FilesPanel key={panelHostId} hostId={panelHostId} />
                )
              ) : (
                <div className="empty">未选择服务器</div>
              )}
            </div>
          </aside>
        )}

        {onTerminal && !showSide && (
          <aside className="side-rail">
            {PANELS.map((p) => (
              <button key={p.id} className="side-rail-btn" title={p.label} onClick={() => setSidePanel(p.id)}>
                <p.icon />
              </button>
            ))}
          </aside>
        )}
      </div>

      {(["batch", "tunnels", "snippets", "agent", "settings"] as ToolModal[]).map((m) => (
        <PageModal key={m} open={modal === m} onClose={closeModal} width={m === "snippets" ? 720 : 1120}>
          {m === "batch" && <BatchView />}
          {m === "tunnels" && modal === m && <TunnelsView />}
          {m === "snippets" && modal === m && <SnippetsModal />}
          {m === "agent" && modal === m && <AgentView />}
          {m === "settings" && modal === m && <SettingsView />}
        </PageModal>
      ))}

      {editingHost !== null && <HostEditor />}
      {importOpen && <ImportDialog />}
      <PromptCenter />
      <GlobalContextMenu />
      <Toasts />
      {locked && <VaultGate />}
    </div>
  );
}

/** Snippets as a full page inside the modal. */
function SnippetsModal() {
  const hostId = useApp((s) => s.panelHostId);
  return (
    <div className="page">
      <div className="page-header">
        <h1>命令</h1>
      </div>
      <div className="snippets-modal-body">
        <SnippetsPanel hostId={hostId} />
      </div>
    </div>
  );
}
