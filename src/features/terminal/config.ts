// xterm options (theme follows lib/themes.ts) and a shared cache of the AI-predict flag.
import type { ITerminalOptions } from "@xterm/xterm";
import { api } from "../../lib/api";
import { currentTheme, termTheme } from "../../lib/themes";

export const TERM_FONT = '"JetBrains Mono Variable","Noto Sans SC Variable","Cascadia Mono",Consolas,monospace';

/** Font size chosen in 设置 → 外观 (applies to newly opened terminals). */
export function savedFontSize(): number {
  try {
    const n = Number(localStorage.getItem("termFontSize"));
    return n >= 10 && n <= 24 ? n : 14;
  } catch {
    return 14;
  }
}

export const TERM_OPTIONS: ITerminalOptions = {
  fontFamily: TERM_FONT,
  get fontSize() {
    return savedFontSize();
  },
  lineHeight: 1.15,
  scrollback: 5000,
  cursorBlink: true,
  cursorStyle: "bar",
  cursorWidth: 2,
  cursorInactiveStyle: "outline",
  allowProposedApi: true,
  get theme() {
    return termTheme();
  },
};

/** Search highlight colors (#RRGGBB required by addon-search), derived from the current theme. */
export function searchDecorations() {
  const t = currentTheme().ui;
  return {
    matchBackground: t.bg4,
    matchBorder: t.fg2,
    matchOverviewRuler: t.fg2,
    activeMatchBackground: t.bg4,
    activeMatchBorder: t.accent,
    activeMatchColorOverviewRuler: t.accent,
  };
}

// ---------- AI prediction flag (cached, refreshed when the window regains focus) ----------
let aiPredict = false;
let loading: Promise<void> | null = null;

export function refreshAiPredict(): Promise<void> {
  if (!loading) {
    loading = api
      .aiSettingsGet()
      .then((s) => {
        aiPredict = !!s.aiPredictEnabled;
      })
      .catch(() => {
        aiPredict = false;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

export const aiPredictEnabled = () => aiPredict;

let installed = false;
/** Load once and keep in sync with the settings page (refresh on window focus). */
export function installAiPredictWatcher() {
  if (installed) return;
  installed = true;
  refreshAiPredict();
  window.addEventListener("focus", () => void refreshAiPredict());
}
