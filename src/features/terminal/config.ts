// xterm options/theme (values mirror the dark tokens in base.css) and a shared cache of the AI-predict flag.
import type { ITerminalOptions } from "@xterm/xterm";
import { api } from "../../lib/api";

export const TERM_FONT = '"JetBrains Mono","Cascadia Mono",Consolas,"Microsoft YaHei Mono",monospace';

export const TERM_THEME: NonNullable<ITerminalOptions["theme"]> = {
  background: "#0d1014", // --bg-0
  foreground: "#e6e9ee", // --fg-0
  cursor: "#3fb6a8", // --accent
  cursorAccent: "#0d1014",
  selectionBackground: "#3fb6a855",
  selectionInactiveBackground: "#3fb6a830",
  scrollbarSliderBackground: "#2c333d99", // --bg-4
  scrollbarSliderHoverBackground: "#353d48cc",
  scrollbarSliderActiveBackground: "#353d48",
  black: "#1a1f26",
  red: "#ef6b6b",
  green: "#4cc38a",
  yellow: "#e5a54b",
  blue: "#5fa8f5",
  magenta: "#c58af0",
  cyan: "#3fb6a8",
  white: "#aab2bd",
  brightBlack: "#737d8a",
  brightRed: "#ff8a8a",
  brightGreen: "#6fd9a3",
  brightYellow: "#f0c070",
  brightBlue: "#86bef8",
  brightMagenta: "#d6a8f5",
  brightCyan: "#6fd0c4",
  brightWhite: "#e6e9ee",
};

/** Font size chosen in 设置 → 外观 (applies to newly opened terminals). */
function savedFontSize(): number {
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
  allowProposedApi: true,
  theme: TERM_THEME,
};

/** Search highlight colors (#RRGGBB required by addon-search). */
export const SEARCH_DECORATIONS = {
  matchBackground: "#2c333d",
  matchBorder: "#5fa8f5",
  matchOverviewRuler: "#5fa8f5",
  activeMatchBackground: "#1f5a53",
  activeMatchBorder: "#3fb6a8",
  activeMatchColorOverviewRuler: "#3fb6a8",
};

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
