// Opening / reopening terminal sessions. Called by the host sidebar, the tab bar "+" picker and the
// "重新连接" bar. All errors (vault locked, auth failure, host key rejected...) surface as a toast.
import { toast } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { hostById, type TermTab, useApp } from "../../store";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

/** Tab title for a new session of this host: "name", then "name (2)", "name (3)"... */
function nextTitle(hostId: string, name: string, ignoreTabId?: string): string {
  const n = useApp.getState().tabs.filter((t) => t.hostId === hostId && t.id !== ignoreTabId).length;
  return n === 0 ? name : `${name} (${n + 1})`;
}

const opening = new Set<string>();

/** Open a new terminal tab for a host. Duplicate tabs per host are allowed. Returns the tab id. */
export async function openTerminal(hostId: string): Promise<string | null> {
  const host = hostById(hostId);
  if (!host) {
    toast("服务器不存在", "error");
    return null;
  }
  // Guard against double-clicks spawning two sessions at once.
  if (opening.has(hostId)) return null;
  opening.add(hostId);
  try {
    const info = await api.termOpen(hostId, DEFAULT_COLS, DEFAULT_ROWS);
    useApp.getState().addTab({ id: info.id, hostId, title: nextTitle(hostId, host.name), alive: true });
    return info.id;
  } catch (e) {
    toast(`连接 ${host.name} 失败：${errMsg(e)}`, "error");
    return null;
  } finally {
    opening.delete(hostId);
  }
}

/** Replace an exited tab with a fresh session for the same host, keeping its position in the tab bar. */
export async function reopenTerminal(oldTabId: string, cols = DEFAULT_COLS, rows = DEFAULT_ROWS): Promise<boolean> {
  const old = useApp.getState().tabs.find((t) => t.id === oldTabId);
  if (!old) return false;
  const host = hostById(old.hostId);
  if (!host) {
    toast("服务器不存在", "error");
    return false;
  }
  try {
    const info = await api.termOpen(old.hostId, cols, rows);
    api.termClose(oldTabId).catch(() => {});
    const tab: TermTab = { id: info.id, hostId: old.hostId, title: old.title, alive: true };
    useApp.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === oldTabId ? tab : t)),
      activeTab: s.activeTab === oldTabId ? tab.id : s.activeTab,
      panelHostId: tab.hostId,
    }));
    return true;
  } catch (e) {
    toast(`重新连接 ${host.name} 失败：${errMsg(e)}`, "error");
    return false;
  }
}

/** Close a tab and its backend session. */
export function closeTerminal(tabId: string) {
  api.termClose(tabId).catch(() => {});
  useApp.getState().closeTab(tabId);
}
