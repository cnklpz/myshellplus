import { useCallback, useEffect, useState } from "react";
import { GlobalContextMenu } from "./components/GlobalContextMenu";
import { PageModal } from "./components/PageModal";
import { Sidebar } from "./components/Sidebar";
import { Titlebar } from "./components/Titlebar";
import { HideDialogs, toast, Toasts } from "./components/ui";
import { AgentView } from "./features/agent/AgentView";
import { PromptCenter } from "./features/agent/PromptCenter";
import { BatchView } from "./features/batch/BatchView";
import { HostEditor } from "./features/hosts/HostEditor";
import { HomeView } from "./features/home/HomeView";
import { OverviewView } from "./features/overview/OverviewView";
import { ImportDialog } from "./features/import/ImportDialog";
import { SideBody, SideRail, SideTabs } from "./features/side/SidePanels";
import { SettingsView } from "./features/settings/SettingsView";
import { UpdateDialog } from "./features/settings/UpdateDialog";
import { SnippetsPanel } from "./features/snippets/SnippetsPanel";
import { startSwitcherSync } from "./features/switcher/sync";
import { TerminalArea } from "./features/terminal/TerminalArea";
import { TunnelsView } from "./features/tunnels/TunnelsView";
import { VaultGate } from "./features/vault/VaultGate";
import { startupCheck } from "./lib/updater";
import { api, type ConnFailure, type ConnState, type ConnStep, errMsg, type Latency } from "./lib/api";
import { onTauriEvent } from "./lib/events";
import { type ToolModal, useApp } from "./store";
import "./App.css";

/** One restore step: a failure is reported but does not stop the others. */
async function step(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    toast(errMsg(e), "error");
    return false;
  }
}

/**
 * Restore state from the backend: sessions survive a webview reload.
 * Resolves to the vault status error, if any (the app cannot render without it).
 */
async function bootstrap(): Promise<string | null> {
  const s = useApp.getState();
  try {
    await s.refreshVault();
  } catch (e) {
    // The backend is unreachable: the vault error screen says so; skip the rest instead of a toast each.
    return errMsg(e);
  }
  await step(() => s.refreshHosts());
  await step(async () => {
    for (const id of await api.connList()) s.setConn({ hostId: id, state: "connected" });
  });
  await step(async () => {
    for (const l of await api.connLatency()) s.setLatency(l.hostId, l.ms, l.since);
  });
  await step(async () => s.setFailures((await api.connFailures()) ?? {}));
  await step(async () => {
    const hosts = useApp.getState().hosts;
    for (const t of await api.termList()) {
      if (useApp.getState().tabs.some((x) => x.id === t.id)) continue;
      const h = hosts.find((x) => x.id === t.hostId);
      useApp.getState().addTab({ id: t.id, hostId: t.hostId, title: h?.name ?? "终端", alive: t.alive });
    }
  });
  return null;
}

export default function App() {
  const vault = useApp((s) => s.vault);
  const view = useApp((s) => s.view);
  const modal = useApp((s) => s.modal);
  const sidePanel = useApp((s) => s.sidePanel);
  const editingHost = useApp((s) => s.editingHost);
  const importOpen = useApp((s) => s.importOpen);
  const [bootErr, setBootErr] = useState<string | null>(null);

  const boot = useCallback(() => {
    setBootErr(null);
    void bootstrap().then(setBootErr);
  }, []);

  useEffect(() => {
    boot();
    try {
      startupCheck();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    // Watchdog heartbeat: the backend reloads the webview if this stops while the window is visible.
    const beat = () => void api.uiHeartbeat().catch(() => {});
    beat();
    const timer = setInterval(beat, 5000);
    const stopSwitcher = startSwitcherSync();
    const un = [
      onTauriEvent<ConnState>("conn-state", (e) => useApp.getState().setConn(e.payload)),
      onTauriEvent<ConnStep>("conn-step", (e) => useApp.getState().pushConnStep(e.payload)),
      onTauriEvent<Record<string, ConnFailure>>("conn-failures", (e) => useApp.getState().setFailures(e.payload)),
      onTauriEvent<Latency>("latency", (e) => useApp.getState().setLatency(e.payload.hostId, e.payload.ms, e.payload.since)),
      onTauriEvent<string>("term-exit", (e) => useApp.getState().updateTab(e.payload, { alive: false })),
    ];
    return () => {
      clearInterval(timer);
      stopSwitcher();
      un.forEach((f) => f());
    };
  }, [boot]);

  if (!vault)
    return bootErr ? (
      <div className="crash">
        <div className="crash-card">
          <div className="crash-title">无法读取密钥库</div>
          <pre className="crash-msg selectable">{bootErr}</pre>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn primary" onClick={boot}>重试</button>
          </div>
        </div>
      </div>
    ) : null;
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
            <HideDialogs when={!onTerminal}>
              <TerminalArea />
            </HideDialogs>
          </div>
          {view === "home" && (
            <div className="view" style={{ display: "flex" }}>
              <HomeView />
            </div>
          )}
          {view === "overview" && (
            <div className="view" style={{ display: "flex" }}>
              <OverviewView />
            </div>
          )}
        </main>

        {showSide && (
          <aside className="side">
            <SideTabs />
            <div className="side-body">
              <SideBody />
            </div>
          </aside>
        )}

        {onTerminal && !showSide && (
          <aside className="side-rail">
            <SideRail />
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
      <UpdateDialog />
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
