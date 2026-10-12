// Color themes. Each theme sets the UI tokens (CSS variables) and the terminal ANSI palette together.
import type { ITheme } from "@xterm/xterm";

interface Palette {
  chrome: string; bg0: string; bg1: string; bg2: string; bg3: string; bg4: string;
  fg0: string; fg1: string; fg2: string;
  accent: string; accentFg: string;
  ok: string; warn: string; err: string;
  charts: [string, string, string, string];
}

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  ui: Palette;
  /** 16 ANSI colors: black red green yellow blue magenta cyan white, then bright variants */
  ansi: string[];
}

export const THEMES: Theme[] = [
  {
    id: "graphite", name: "石墨", dark: true,
    ui: {
      chrome: "#0a0c0f", bg0: "#101317", bg1: "#14181d", bg2: "#1a1f25", bg3: "#20262d", bg4: "#28303a",
      fg0: "#eceef1", fg1: "#9aa2ad", fg2: "#626a75", accent: "#8ea6ff", accentFg: "#0a0c0f",
      ok: "#5fd4a0", warn: "#f0b45e", err: "#f07a7d", charts: ["#8ea6ff", "#5fd4a0", "#c79bf2", "#f0b45e"],
    },
    ansi: ["#2a3038", "#f07a7d", "#5fd4a0", "#f0c46e", "#8ea6ff", "#c79bf2", "#6fcfd6", "#c9ced6",
           "#4b5360", "#ff9a9c", "#86e8bb", "#ffd98f", "#b0c1ff", "#dcb9ff", "#97e3e8", "#f3f5f7"],
  },
  {
    id: "midnight", name: "午夜", dark: true,
    ui: {
      chrome: "#070b14", bg0: "#0c1322", bg1: "#101829", bg2: "#152033", bg3: "#1b283f", bg4: "#22324d",
      fg0: "#e6edf8", fg1: "#93a3bd", fg2: "#5b6a84", accent: "#4cc2ff", accentFg: "#04111c",
      ok: "#4fd6a2", warn: "#f5bd5c", err: "#ff7b8a", charts: ["#4cc2ff", "#4fd6a2", "#a78bfa", "#f5bd5c"],
    },
    ansi: ["#1c2840", "#ff7b8a", "#4fd6a2", "#f5cd6b", "#4cc2ff", "#a78bfa", "#56e0e0", "#c8d3e6",
           "#3a4a68", "#ff9eaa", "#7ce8bf", "#ffdf94", "#86d6ff", "#c4b0ff", "#8ef0f0", "#f2f6fc"],
  },
  {
    id: "nord", name: "北境", dark: true,
    ui: {
      chrome: "#242933", bg0: "#2e3440", bg1: "#323946", bg2: "#3b4252", bg3: "#424a5b", bg4: "#4c566a",
      fg0: "#eceff4", fg1: "#b4bccb", fg2: "#7b8496", accent: "#88c0d0", accentFg: "#1f2530",
      ok: "#a3be8c", warn: "#ebcb8b", err: "#bf616a", charts: ["#88c0d0", "#a3be8c", "#b48ead", "#ebcb8b"],
    },
    ansi: ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
           "#4c566a", "#d0767e", "#b5cf9e", "#f2d9a5", "#94b3d1", "#c6a2c0", "#8fbcbb", "#eceff4"],
  },
  {
    id: "dusk", name: "暮紫", dark: true,
    ui: {
      chrome: "#16141f", bg0: "#1d1b28", bg1: "#221f2f", bg2: "#2a2738", bg3: "#322e43", bg4: "#3c3750",
      fg0: "#f1eefb", fg1: "#aaa3c4", fg2: "#6f6889", accent: "#c3a6ff", accentFg: "#16141f",
      ok: "#7ee0a8", warn: "#f7c873", err: "#ff7aa2", charts: ["#c3a6ff", "#7ee0a8", "#ff9ecb", "#f7c873"],
    },
    ansi: ["#2e2a3d", "#ff7aa2", "#7ee0a8", "#f7d47e", "#9fb4ff", "#c3a6ff", "#8be9fd", "#e2def0",
           "#4d4766", "#ff9dbb", "#a3edc2", "#fbe2a5", "#c0cdff", "#dac7ff", "#b0f1fe", "#faf8ff"],
  },
  {
    id: "moss", name: "苔原", dark: true,
    ui: {
      chrome: "#0c0f0d", bg0: "#121614", bg1: "#161b18", bg2: "#1c221e", bg3: "#232a25", bg4: "#2c352f",
      fg0: "#e9eee9", fg1: "#9eaa9f", fg2: "#66716a", accent: "#9fd49a", accentFg: "#0c0f0d",
      ok: "#9fd49a", warn: "#e6c06a", err: "#ec8072", charts: ["#9fd49a", "#7cc4c0", "#d0a2d8", "#e6c06a"],
    },
    ansi: ["#262d28", "#ec8072", "#9fd49a", "#e6c06a", "#7fb4d9", "#d0a2d8", "#7cc4c0", "#cfd6cf",
           "#46514a", "#f4a093", "#bce6b6", "#f0d494", "#a4cbe6", "#e0bde6", "#a2d9d5", "#f2f5f2"],
  },
  {
    id: "ember", name: "余烬", dark: true,
    ui: {
      chrome: "#100d0b", bg0: "#171310", bg1: "#1c1714", bg2: "#231d19", bg3: "#2b241f", bg4: "#362d27",
      fg0: "#f3ece6", fg1: "#b3a597", fg2: "#7a6d61", accent: "#ffad66", accentFg: "#1a0f06",
      ok: "#a9d08e", warn: "#ffcf66", err: "#ff7a6b", charts: ["#ffad66", "#a9d08e", "#e59bc0", "#ffcf66"],
    },
    ansi: ["#2f2722", "#ff7a6b", "#a9d08e", "#ffcf66", "#8fb4e0", "#e59bc0", "#86cbbf", "#ddd3ca",
           "#54483f", "#ff9d90", "#c3e2ad", "#ffdd8f", "#b0cbec", "#efbbd5", "#a8ddd3", "#f8f3ee"],
  },
  {
    id: "paper", name: "纸白", dark: false,
    ui: {
      chrome: "#e8eaee", bg0: "#ffffff", bg1: "#f7f8fa", bg2: "#ffffff", bg3: "#f0f2f5", bg4: "#e5e8ee",
      fg0: "#16191d", fg1: "#535b66", fg2: "#8a919b", accent: "#4561e6", accentFg: "#ffffff",
      ok: "#1f9d63", warn: "#c27a12", err: "#d64545", charts: ["#4561e6", "#1f9d63", "#9a5cd6", "#c27a12"],
    },
    ansi: ["#2b2f36", "#d64545", "#1f9d63", "#b5770e", "#3555d6", "#9a4fc9", "#0e8a96", "#c6cad1",
           "#6b7280", "#e05d5d", "#2bb575", "#cf8d1f", "#5470e8", "#b06ad9", "#18a3b0", "#e8eaee"],
  },
  {
    id: "latte", name: "拿铁", dark: false,
    ui: {
      chrome: "#ebe5dd", bg0: "#fbf8f4", bg1: "#f5f0ea", bg2: "#fffdfa", bg3: "#efe8df", bg4: "#e6ddd1",
      fg0: "#2a221b", fg1: "#6a5d50", fg2: "#9a8c7e", accent: "#c0622e", accentFg: "#ffffff",
      ok: "#4f8a3b", warn: "#b77b10", err: "#c4413a", charts: ["#c0622e", "#4f8a3b", "#8a5aa8", "#b77b10"],
    },
    ansi: ["#3a3029", "#c4413a", "#4f8a3b", "#a8700e", "#3e6fa8", "#8a5aa8", "#2f8a86", "#cfc5b8",
           "#7a6d61", "#d65a52", "#64a34e", "#c48a22", "#5585bd", "#a173bf", "#43a19c", "#ebe5dd"],
  },
];

const DEFAULT = "graphite";
const listeners = new Set<(t: Theme) => void>();

export function themeById(id: string | null | undefined): Theme {
  // Migrate old "dark"/"light" values.
  if (id === "light") id = "paper";
  if (id === "dark") id = DEFAULT;
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

let current: Theme = themeById(readSaved());

function readSaved(): string | null {
  try {
    return localStorage.getItem("theme");
  } catch {
    return null;
  }
}

export function currentTheme(): Theme {
  return current;
}

export function applyTheme(id: string) {
  const t = themeById(id);
  current = t;
  const p = t.ui;
  const root = document.documentElement;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set("--chrome", p.chrome);
  set("--bg-0", p.bg0);
  set("--bg-1", p.bg1);
  set("--bg-2", p.bg2);
  set("--bg-3", p.bg3);
  set("--bg-4", p.bg4);
  set("--fg-0", p.fg0);
  set("--fg-1", p.fg1);
  set("--fg-2", p.fg2);
  set("--accent", p.accent);
  set("--accent-fg", p.accentFg);
  set("--accent-soft", `color-mix(in srgb, ${p.accent} ${t.dark ? 14 : 11}%, transparent)`);
  set("--info", p.accent);
  set("--ok", p.ok);
  set("--warn", p.warn);
  set("--err", p.err);
  p.charts.forEach((c, i) => set(`--chart-${i + 1}`, c));
  const ink = t.dark ? "255, 255, 255" : "15, 20, 30";
  set("--line", `rgba(${ink}, ${t.dark ? 0.055 : 0.07})`);
  set("--line-strong", `rgba(${ink}, ${t.dark ? 0.1 : 0.13})`);
  set(
    "--shadow",
    t.dark
      ? "0 12px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06)"
      : "0 12px 40px rgba(15, 20, 30, 0.14), 0 0 0 1px rgba(15, 20, 30, 0.06)",
  );
  root.style.colorScheme = t.dark ? "dark" : "light";
  root.dataset.theme = t.id;
  try {
    localStorage.setItem("theme", t.id);
  } catch {
    /* ignore */
  }
  listeners.forEach((f) => f(t));
}

export function onThemeChange(f: (t: Theme) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function termTheme(t: Theme = current): ITheme {
  const a = t.ansi;
  return {
    background: t.ui.bg0,
    foreground: t.ui.fg0,
    cursor: t.ui.accent,
    cursorAccent: t.ui.bg0,
    selectionBackground: t.ui.accent + (t.dark ? "40" : "33"),
    scrollbarSliderBackground: t.ui.bg4 + "99",
    scrollbarSliderHoverBackground: t.ui.bg4,
    scrollbarSliderActiveBackground: t.ui.fg2,
    black: a[0], red: a[1], green: a[2], yellow: a[3], blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
    brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11],
    brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
  };
}
