// Main window side of the terminal switcher: publishes the tab list in most-recently-used order
// (the switcher window reads it from the shared localStorage) and handles its pick.
import { listen } from "@tauri-apps/api/event";
import type { SwitcherTarget } from "../../lib/api";
import { termBus } from "../../lib/termBus";
import { useApp } from "../../store";
import { openTerminal } from "../terminal/open";

const SNAPSHOT_KEY = "switcherTabs";

export interface SwitcherSnapshot {
  active: string | null;
  terminalView: boolean;
  tabs: { id: string; hostId: string; title: string; alive: boolean }[];
}

export function readSnapshot(): SwitcherSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as SwitcherSnapshot) : null;
  } catch {
    return null;
  }
}

/** Start publishing; returns a stop function. */
export function startSwitcherSync(): () => void {
  let mru: string[] = [];
  const publish = () => {
    const s = useApp.getState();
    if (s.activeTab) mru = [s.activeTab, ...mru.filter((id) => id !== s.activeTab)];
    const rank = (id: string) => {
      const i = mru.indexOf(id);
      return i < 0 ? mru.length : i;
    };
    const tabs = [...s.tabs].sort((a, b) => rank(a.id) - rank(b.id));
    const snap: SwitcherSnapshot = {
      active: s.activeTab,
      terminalView: s.view === "terminal" && !s.modal,
      tabs: tabs.map((t) => ({ id: t.id, hostId: t.hostId, title: t.title, alive: t.alive })),
    };
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
    } catch {
      /* storage unavailable */
    }
  };
  publish();
  const unsub = useApp.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs || s.activeTab !== prev.activeTab || s.view !== prev.view || s.modal !== prev.modal) publish();
  });
  const unlisten = listen<SwitcherTarget>("switcher-pick", (e) => {
    const t = e.payload;
    const s = useApp.getState();
    if ("tabId" in t) {
      if (!s.tabs.some((x) => x.id === t.tabId)) return;
      s.setModal(null);
      s.setActiveTab(t.tabId);
      s.setView("terminal");
      setTimeout(() => termBus.get(t.tabId)?.focus(), 50);
    } else if ("hostId" in t) {
      s.setModal(null);
      void openTerminal(t.hostId);
    }
  });
  return () => {
    unsub();
    unlisten.then((f) => f());
  };
}
