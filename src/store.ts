// Global UI state. Backend state (sessions, connections) lives in Rust; this store mirrors it.
import { create } from "zustand";
import { api, type ConnState, type Host, type VaultStatus } from "./lib/api";

/** Main pages switched from the sidebar. */
export type View = "home" | "terminal";
/** Tools opened as large modals from the sidebar footer. */
export type ToolModal = "batch" | "tunnels" | "snippets" | "agent" | "settings";
export type SidePanel = "monitor" | "files" | "snippets" | null;

export interface TermTab {
  /** Rust terminal session id */
  id: string;
  hostId: string;
  title: string;
  alive: boolean;
}

export interface Toast { id: number; kind: "info" | "success" | "error"; text: string }

interface AppState {
  vault: VaultStatus | null;
  hosts: Host[];
  conn: Record<string, ConnState>;
  /** SSH ping round trip per host (ms), null = no reply */
  latency: Record<string, number | null>;
  tabs: TermTab[];
  activeTab: string | null;
  view: View;
  modal: ToolModal | null;
  /** Settings page to show when the settings modal opens */
  settingsSection: string | null;
  /** Terminal page group filter ("" = all) */
  termGroup: string;
  sidePanel: SidePanel;
  /** Host shown in the side panel (defaults to the active tab's host) */
  panelHostId: string | null;
  toasts: Toast[];
  /** Host editor dialog: null = closed, "" = new host, id = edit */
  editingHost: string | null;
  importOpen: boolean;

  refreshVault: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  setConn: (s: ConnState) => void;
  setLatency: (hostId: string, ms: number | null) => void;
  setView: (v: View) => void;
  setModal: (m: ToolModal | null) => void;
  openSettings: (section: string) => void;
  setTermGroup: (g: string) => void;
  setSidePanel: (p: SidePanel) => void;
  setPanelHost: (id: string | null) => void;
  addTab: (t: TermTab) => void;
  updateTab: (id: string, patch: Partial<TermTab>) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  openEditor: (hostId: string | null) => void;
  setImportOpen: (open: boolean) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

export const useApp = create<AppState>((set, get) => ({
  vault: null,
  hosts: [],
  conn: {},
  latency: {},
  tabs: [],
  activeTab: null,
  view: "home",
  modal: null,
  settingsSection: null,
  termGroup: "",
  sidePanel: "monitor",
  panelHostId: null,
  toasts: [],
  editingHost: null,
  importOpen: false,

  refreshVault: async () => set({ vault: await api.vaultStatus() }),
  refreshHosts: async () => set({ hosts: await api.hostList() }),
  setConn: (s) => set({ conn: { ...get().conn, [s.hostId]: s } }),
  setLatency: (hostId, ms) => set({ latency: { ...get().latency, [hostId]: ms } }),
  setView: (view) => set({ view }),
  setModal: (modal) => set({ modal }),
  openSettings: (settingsSection) => set({ modal: "settings", settingsSection }),
  setTermGroup: (termGroup) => set({ termGroup }),
  setSidePanel: (sidePanel) => set({ sidePanel }),
  setPanelHost: (panelHostId) => set({ panelHostId }),
  addTab: (t) => set({ tabs: [...get().tabs, t], activeTab: t.id, view: "terminal", panelHostId: t.hostId }),
  updateTab: (id, patch) => set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),
  closeTab: (id) => {
    const tabs = get().tabs;
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    let active = get().activeTab;
    if (active === id) active = next[Math.min(idx, next.length - 1)]?.id ?? null;
    const activeHost = next.find((t) => t.id === active)?.hostId ?? get().panelHostId;
    set({ tabs: next, activeTab: active, panelHostId: activeHost });
  },
  setActiveTab: (id) => {
    const t = get().tabs.find((x) => x.id === id);
    set({ activeTab: id, panelHostId: t?.hostId ?? get().panelHostId });
  },
  openEditor: (editingHost) => set({ editingHost }),
  setImportOpen: (importOpen) => set({ importOpen }),
  toast: (text, kind = "info") => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => get().dismissToast(id), kind === "error" ? 6000 : 3000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const hostById = (id: string | null | undefined) => useApp.getState().hosts.find((h) => h.id === id);
