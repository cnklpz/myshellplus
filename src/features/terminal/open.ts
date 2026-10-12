// Opening / reopening terminal sessions. Called by the host sidebar, the home cards, the tab bar "+"
// picker and the "重新连接" bar. The tab appears at once; while it connects, its `connect` field
// collects the backend's "conn-step" events and ConnectDialog shows them (and any error).
import { toast } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { type ConnectProgress, hostById, type TermTab, useApp } from "../../store";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

/** Tab title for a new session of this host: "name", then "name (2)", "name (3)"... */
function nextTitle(hostId: string, name: string, ignoreTabId?: string): string {
  const n = useApp.getState().tabs.filter((t) => t.hostId === hostId && t.id !== ignoreTabId).length;
  return n === 0 ? name : `${name} (${n + 1})`;
}

const findTab = (id: string) => useApp.getState().tabs.find((t) => t.id === id);
const fresh = (): ConnectProgress => ({ started: Date.now(), steps: [] });
export const isPending = (tabId: string) => tabId.startsWith("pending-");

/** Swap a tab for its new session, keeping its position in the tab bar. */
function replaceTab(oldId: string, tab: TermTab) {
  useApp.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === oldId ? tab : t)),
    activeTab: s.activeTab === oldId ? tab.id : s.activeTab,
    panelHostId: s.activeTab === oldId ? tab.hostId : s.panelHostId,
  }));
}

/**
 * Run one connect attempt for a tab that already has `connect` set. The attempt is identified by
 * `connect.started`: if the tab was closed or the attempt cancelled/replaced meanwhile, the new
 * session is thrown away.
 */
async function attempt(tabId: string, cols: number, rows: number): Promise<string | null> {
  const tab = findTab(tabId);
  if (!tab?.connect) return null;
  const token = tab.connect.started;
  const current = () => {
    const t = findTab(tabId);
    return t?.connect?.started === token ? t : null;
  };
  try {
    const info = await api.termOpen(tab.hostId, cols, rows);
    const t = current();
    if (!t) {
      api.termClose(info.id).catch(() => {});
      return null;
    }
    if (!isPending(tabId)) api.termClose(tabId).catch(() => {});
    replaceTab(tabId, { id: info.id, hostId: t.hostId, title: t.title, alive: true });
    return info.id;
  } catch (e) {
    const t = current();
    if (t?.connect) useApp.getState().updateTab(tabId, { connect: { ...t.connect, error: errMsg(e), failedAt: Date.now() } });
    return null;
  }
}

let pendingSeq = 0;
const recent = new Map<string, number>();

/** Open a new terminal tab for a host. Duplicate tabs per host are allowed. Resolves to the session id. */
export async function openTerminal(hostId: string): Promise<string | null> {
  const host = hostById(hostId);
  if (!host) {
    toast("服务器不存在", "error");
    return null;
  }
  // Guard against a double-click spawning two tabs.
  const now = Date.now();
  if (now - (recent.get(hostId) ?? 0) < 500) return null;
  recent.set(hostId, now);
  const id = `pending-${++pendingSeq}`;
  useApp.getState().addTab({ id, hostId, title: nextTitle(hostId, host.name), alive: false, connect: fresh() });
  return attempt(id, DEFAULT_COLS, DEFAULT_ROWS);
}

/** Replace an exited tab with a fresh session for the same host, keeping its position in the tab bar. */
export async function reopenTerminal(oldTabId: string, cols = DEFAULT_COLS, rows = DEFAULT_ROWS): Promise<boolean> {
  if (!findTab(oldTabId)) return false;
  useApp.getState().updateTab(oldTabId, { connect: fresh() });
  return (await attempt(oldTabId, cols, rows)) !== null;
}

/** Retry after a failed connect (from the connect dialog). */
export function retryConnect(tabId: string) {
  if (!findTab(tabId)) return;
  useApp.getState().updateTab(tabId, { connect: fresh() });
  void attempt(tabId, DEFAULT_COLS, DEFAULT_ROWS);
}

/** Dismiss the connect dialog: a tab that never connected is closed, a reconnecting one stays as it was. */
export function cancelConnect(tabId: string) {
  if (isPending(tabId)) useApp.getState().closeTab(tabId);
  else useApp.getState().updateTab(tabId, { connect: undefined });
}

/** Close a tab and its backend session. */
export function closeTerminal(tabId: string) {
  if (!isPending(tabId)) api.termClose(tabId).catch(() => {});
  useApp.getState().closeTab(tabId);
}
