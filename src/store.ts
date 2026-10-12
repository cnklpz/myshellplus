// Global UI state. Backend state (sessions, connections) lives in Rust; this store mirrors it.
import { create } from "zustand";
import { api, type ConnFailure, type ConnState, type ConnStep, type Host, type VaultStatus } from "./lib/api";

/** Main pages switched from the sidebar. */
export type View = "home" | "overview" | "terminal";
/** Tools opened as large modals from the sidebar footer. */
export type ToolModal = "batch" | "tunnels" | "snippets" | "agent" | "settings";
export type SidePanel = "monitor" | "files" | "snippets" | null;

export interface TermTab {
  /** Rust terminal session id ("pending-N" while the first connect is in flight) */
  id: string;
  hostId: string;
  title: string;
  alive: boolean;
  /** Set while (re)connecting: drives the connect progress dialog. */
  connect?: ConnectProgress;
}

export interface ConnectProgress {
  started: number;
  steps: (ConnStep & { at: number })[];
  error?: string;
  failedAt?: number;
}

/** A host followed by its jump hosts (connect steps of any of them belong to the host). */
export function hostChain(hostId: string, hosts: Host[]): string[] {
  const out: string[] = [];
  for (let id: string | null | undefined = hostId; id && !out.includes(id) && out.length < 6; ) {
    out.push(id);
    id = hosts.find((h) => h.id === id)?.jumpHostId;
  }
  return out;
}

export interface ToastAction { label: string; run: () => void }
export interface Toast { id: number; kind: "info" | "success" | "error"; text: string; action?: ToastAction }

interface AppState {
  vault: VaultStatus | null;
  hosts: Host[];
  conn: Record<string, ConnState>;
  /** host id -> last connect failure, until it connects again or is dismissed */
  failures: Record<string, ConnFailure>;
  /** SSH ping round trip per host (ms), null = no reply */
  latency: Record<string, number | null>;
  /** host id -> unix ms the SSH connection was established */
  since: Record<string, number>;
  tabs: TermTab[];
  activeTab: string | null;
  view: View;
  modal: ToolModal | null;
  /** Settings page to show when the settings modal opens */
  settingsSection: string | null;
  /** Terminal page group filter ("" = all) */
  sidePanel: SidePanel;
  /** Host shown in the side panel (defaults to the active tab's host) */
  panelHostId: string | null;
  /** Request for the files panel to show a directory (n changes on every request). */
  filesJump: { hostId: string; path: string; n: number } | null;
  toasts: Toast[];
  /** Host editor dialog: null = closed, "" = new host, id = edit */
  editingHost: string | null;
  importOpen: boolean;
  /** Mask host addresses on screen */
  privacy: boolean;

  refreshVault: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  setConn: (s: ConnState) => void;
  setFailures: (f: Record<string, ConnFailure>) => void;
  /** Append a backend connect step to every tab connecting through that host. */
  pushConnStep: (s: ConnStep) => void;
  setLatency: (hostId: string, ms: number | null, since?: number) => void;
  setView: (v: View) => void;
  setModal: (m: ToolModal | null) => void;
  openSettings: (section: string) => void;
  setSidePanel: (p: SidePanel) => void;
  setPanelHost: (id: string | null) => void;
  openFilesAt: (hostId: string, path: string) => void;
  addTab: (t: TermTab) => void;
  updateTab: (id: string, patch: Partial<TermTab>) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  openEditor: (hostId: string | null) => void;
  setImportOpen: (open: boolean) => void;
  setPrivacy: (on: boolean) => void;
  toast: (text: string, kind?: Toast["kind"], action?: ToastAction) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

const PRIVACY_KEY = "privacyMode";
function loadPrivacy(): boolean {
  try {
    return localStorage.getItem(PRIVACY_KEY) === "1";
  } catch {
    return false;
  }
}

export const useApp = create<AppState>((set, get) => ({
  vault: null,
  hosts: [],
  conn: {},
  failures: {},
  latency: {},
  since: {},
  tabs: [],
  activeTab: null,
  view: "home",
  modal: null,
  settingsSection: null,
  sidePanel: "monitor",
  panelHostId: null,
  filesJump: null,
  toasts: [],
  editingHost: null,
  importOpen: false,
  privacy: loadPrivacy(),

  refreshVault: async () => set({ vault: await api.vaultStatus() }),
  refreshHosts: async () => set({ hosts: await api.hostList() }),
  setConn: (s) => {
    const since = { ...get().since };
    // Provisional until the backend's timestamp arrives with the next latency event.
    if (s.state === "connected") since[s.hostId] ??= Date.now();
    else if (s.state !== "connecting") delete since[s.hostId];
    set({ conn: { ...get().conn, [s.hostId]: s }, since });
  },
  setFailures: (failures) => set({ failures }),
  pushConnStep: (s) => {
    const { tabs, hosts } = get();
    const at = Date.now();
    if (!tabs.some((t) => t.connect && !t.connect.error)) return;
    // Several callers may wait on the same connect: drop repeats of the last step.
    const same = (a: ConnStep | undefined) => a?.hostId === s.hostId && a.label === s.label && a.detail === s.detail;
    set({
      tabs: tabs.map((t) =>
        t.connect && !t.connect.error && hostChain(t.hostId, hosts).includes(s.hostId) && !same(t.connect.steps[t.connect.steps.length - 1])
          ? { ...t, connect: { ...t.connect, steps: [...t.connect.steps, { ...s, at }] } }
          : t,
      ),
    });
  },
  setLatency: (hostId, ms, since) =>
    set({
      latency: { ...get().latency, [hostId]: ms },
      ...(since && get().since[hostId] !== since ? { since: { ...get().since, [hostId]: since } } : {}),
    }),
  setView: (view) => set({ view }),
  setModal: (modal) => set({ modal }),
  openSettings: (settingsSection) => set({ modal: "settings", settingsSection }),
  setSidePanel: (sidePanel) => set({ sidePanel }),
  setPanelHost: (panelHostId) => set({ panelHostId }),
  openFilesAt: (hostId, path) =>
    set({ sidePanel: "files", panelHostId: hostId, filesJump: { hostId, path, n: (get().filesJump?.n ?? 0) + 1 } }),
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
  setPrivacy: (privacy) => {
    try {
      localStorage.setItem(PRIVACY_KEY, privacy ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ privacy });
  },
  toast: (text, kind = "info", action) => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, kind, text, action }] });
    setTimeout(() => get().dismissToast(id), kind === "error" || action ? 6000 : 3000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const hostById = (id: string | null | undefined) => useApp.getState().hosts.find((h) => h.id === id);
