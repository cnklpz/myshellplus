// xterm options (theme follows lib/themes.ts) and a shared cache of the AI-predict flag.
import type { ITerminalOptions } from "@xterm/xterm";
import { api } from "../../lib/api";
import { lsGet, lsSet } from "../../lib/storage";
import { isMobile } from "../../lib/platform";
import { currentTheme, termTheme } from "../../lib/themes";

export const TERM_FONT = '"JetBrains Mono Variable","Noto Sans SC Variable","Cascadia Mono",Consolas,monospace';

/** Default terminal font size: phones get more columns out of a narrow screen. */
export const DEFAULT_FONT_SIZE = isMobile ? 12 : 14;

/** Font size chosen in 设置 → 外观 (applies to newly opened terminals). */
export function savedFontSize(): number {
  try {
    const n = Number(localStorage.getItem("termFontSize"));
    return n >= 10 && n <= 24 ? n : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
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

// ---------- prediction flags (cached, refreshed when the window regains focus) ----------
let localPredict = true;
let aiPredict = false;
let nlPredict = false;
let loading: Promise<void> | null = null;

export function refreshAiPredict(): Promise<void> {
  if (!loading) {
    loading = api
      .aiSettingsGet()
      .then((s) => {
        localPredict = s.predictEnabled !== false;
        const configured = s.providers.some((p) => p.apiKeySecret || p.kind === "openai");
        aiPredict = configured && !!s.aiPredictEnabled;
        nlPredict = configured && s.nlPredictEnabled !== false;
      })
      .catch(() => {
        aiPredict = false;
        nlPredict = false;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** How predictions show: gray text after the cursor (list on ↓), or a menu that opens while typing. */
export type PredictStyle = "inline" | "menu";
export const predictStyle = (): PredictStyle => (lsGet("predictStyle") === "menu" ? "menu" : "inline");
export const setPredictStyle = (v: PredictStyle) => lsSet("predictStyle", v);

/** History / server commands / paths. */
export const localPredictEnabled = () => localPredict;
export const aiPredictEnabled = () => aiPredict;
/** Chinese (natural language) typed at the prompt asks the AI for a command. */
export const nlPredictEnabled = () => nlPredict;

let installed = false;
/** Load once and keep in sync with the settings page (refresh on window focus). */
export function installAiPredictWatcher() {
  if (installed) return;
  installed = true;
  refreshAiPredict();
  window.addEventListener("focus", () => void refreshAiPredict());
  window.addEventListener("msp:ai-settings", () => void refreshAiPredict());
}
