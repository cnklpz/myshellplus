// Panel group appended to every right-click menu inside a side panel: hide the panel, pin / unpin its tab.
// Kept apart from SidePanels.tsx so the panels can import it without an import cycle.
import { PanelRightClose, Pin, PinOff } from "lucide-react";
import { createContext, useCallback, useContext } from "react";
import { isMobile } from "../../lib/platform";
import { type SidePanelId, useApp } from "../../store";
import type { MenuItem } from "../terminal/ContextMenu";

/** Tab order of the side panels; pins follow it. */
export const PANEL_ORDER: SidePanelId[] = ["monitor", "files", "toolbox", "docker", "ai", "snippets"];

/** The side panel a component is rendered in (null outside the side panel). */
export const SidePanelCtx = createContext<SidePanelId | null>(null);

export function togglePin(id: SidePanelId) {
  const s = useApp.getState();
  const pins = s.sidePins;
  const next = pins.includes(id) ? pins.filter((x) => x !== id) : PANEL_ORDER.filter((x) => x === id || pins.includes(x));
  if (next.length) s.setSidePins(next);
}

export function panelItems(id: SidePanelId): MenuItem[] {
  // Mobile panels are full-screen sheets with every tab shown: nothing to hide or pin.
  if (isMobile) return [];
  const s = useApp.getState();
  const pinned = s.sidePins.includes(id);
  return [
    { label: "隐藏面板", icon: <PanelRightClose />, disabled: s.sidePanel !== id, onSelect: () => s.setSidePanel(null) },
    pinned
      ? { label: "从标签栏移除", icon: <PinOff />, disabled: s.sidePins.length === 1, onSelect: () => togglePin(id) }
      : { label: "固定到标签栏", icon: <Pin />, onSelect: () => togglePin(id) },
  ];
}

/** `extra()` returns a separator plus the panel group when rendered in a side panel, else nothing. */
export function usePanelItems() {
  const id = useContext(SidePanelCtx);
  return useCallback((): MenuItem[] => (id ? ["sep", ...panelItems(id)] : []), [id]);
}
