// Lets other features (snippets, batch, AI) talk to the visible terminals without importing them.
// TerminalArea registers a handle per tab; everyone else calls the helpers below.
import { useApp } from "../store";

export interface TermHandle {
  /** Type text into the shell (no newline added). */
  paste: (text: string) => void;
  /** Send text and press Enter. */
  run: (command: string) => void;
  /** Plain text of the last `lines` screen lines. */
  screenText: (lines?: number) => string;
  /** Currently selected text in the terminal. */
  selection: () => string;
  focus: () => void;
}

const handles = new Map<string, TermHandle>();

export const termBus = {
  register(tabId: string, h: TermHandle) {
    handles.set(tabId, h);
    return () => {
      if (handles.get(tabId) === h) handles.delete(tabId);
    };
  },
  get(tabId: string) {
    return handles.get(tabId);
  },
  active(): TermHandle | undefined {
    const id = useApp.getState().activeTab;
    return id ? handles.get(id) : undefined;
  },
};
