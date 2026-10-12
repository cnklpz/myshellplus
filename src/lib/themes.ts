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
  /** "classic" = color scheme borrowed from a well-known editor / terminal (ANSI palette kept as published) */
  group?: "classic";
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

  // ---- classic schemes from well-known editors / terminals
  {
    id: "vscode-dark", name: "VS Code 深色", dark: true, group: "classic",
    ui: {
      chrome: "#181818", bg0: "#1f1f1f", bg1: "#252526", bg2: "#2b2b2b", bg3: "#313131", bg4: "#3c3c3c",
      fg0: "#d4d4d4", fg1: "#9d9d9d", fg2: "#6e6e6e", accent: "#0078d4", accentFg: "#ffffff",
      ok: "#23d18b", warn: "#cca700", err: "#f14c4c", charts: ["#3b8eea", "#23d18b", "#d670d6", "#cca700"],
    },
    ansi: ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
           "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"],
  },
  {
    id: "vscode-light", name: "VS Code 浅色", dark: false, group: "classic",
    ui: {
      chrome: "#ececec", bg0: "#ffffff", bg1: "#f8f8f8", bg2: "#ffffff", bg3: "#f0f0f0", bg4: "#e4e4e4",
      fg0: "#1f1f1f", fg1: "#616161", fg2: "#8b8b8b", accent: "#005fb8", accentFg: "#ffffff",
      ok: "#388a34", warn: "#bf8803", err: "#e51400", charts: ["#005fb8", "#388a34", "#bc05bc", "#bf8803"],
    },
    ansi: ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555",
           "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"],
  },
  {
    id: "one-dark", name: "One Dark", dark: true, group: "classic",
    ui: {
      chrome: "#1b1d23", bg0: "#282c34", bg1: "#2c313a", bg2: "#323842", bg3: "#383e4a", bg4: "#3e4451",
      fg0: "#dcdfe4", fg1: "#abb2bf", fg2: "#6b717d", accent: "#61afef", accentFg: "#1b1d23",
      ok: "#98c379", warn: "#e5c07b", err: "#e06c75", charts: ["#61afef", "#98c379", "#c678dd", "#e5c07b"],
    },
    ansi: ["#3f4451", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
           "#5c6370", "#e06c75", "#98c379", "#d19a66", "#61afef", "#c678dd", "#56b6c2", "#ffffff"],
  },
  {
    id: "dracula", name: "Dracula", dark: true, group: "classic",
    ui: {
      chrome: "#191a21", bg0: "#282a36", bg1: "#2d2f3d", bg2: "#343746", bg3: "#3c3f51", bg4: "#44475a",
      fg0: "#f8f8f2", fg1: "#b6b9cf", fg2: "#6272a4", accent: "#bd93f9", accentFg: "#191a21",
      ok: "#50fa7b", warn: "#ffb86c", err: "#ff5555", charts: ["#bd93f9", "#50fa7b", "#ff79c6", "#ffb86c"],
    },
    ansi: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
           "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"],
  },
  {
    id: "monokai", name: "Monokai", dark: true, group: "classic",
    ui: {
      chrome: "#1e1f1c", bg0: "#272822", bg1: "#2d2e27", bg2: "#34352d", bg3: "#3b3c34", bg4: "#49483e",
      fg0: "#f8f8f2", fg1: "#c2c1b4", fg2: "#75715e", accent: "#a6e22e", accentFg: "#1e1f1c",
      ok: "#a6e22e", warn: "#e6db74", err: "#f92672", charts: ["#66d9ef", "#a6e22e", "#ae81ff", "#e6db74"],
    },
    ansi: ["#3e3d32", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2",
           "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"],
  },
  {
    id: "github-dark", name: "GitHub 深色", dark: true, group: "classic",
    ui: {
      chrome: "#010409", bg0: "#0d1117", bg1: "#151b23", bg2: "#1c2229", bg3: "#212830", bg4: "#2a313c",
      fg0: "#e6edf3", fg1: "#9198a1", fg2: "#656c76", accent: "#4493f8", accentFg: "#ffffff",
      ok: "#3fb950", warn: "#d29922", err: "#f85149", charts: ["#4493f8", "#3fb950", "#bc8cff", "#d29922"],
    },
    ansi: ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
           "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"],
  },
  {
    id: "solarized-dark", name: "Solarized 深色", dark: true, group: "classic",
    ui: {
      chrome: "#00212b", bg0: "#002b36", bg1: "#04313d", bg2: "#073642", bg3: "#0d3f4c", bg4: "#154956",
      fg0: "#a7b4b4", fg1: "#839496", fg2: "#586e75", accent: "#268bd2", accentFg: "#fdf6e3",
      ok: "#859900", warn: "#b58900", err: "#dc322f", charts: ["#268bd2", "#859900", "#d33682", "#b58900"],
    },
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
           "#586e75", "#cb4b16", "#859900", "#b58900", "#268bd2", "#6c71c4", "#2aa198", "#fdf6e3"],
  },
  {
    id: "solarized-light", name: "Solarized 浅色", dark: false, group: "classic",
    ui: {
      chrome: "#e8e1cc", bg0: "#fdf6e3", bg1: "#f7f0dc", bg2: "#fffbef", bg3: "#eee8d5", bg4: "#e4ddc8",
      fg0: "#3b4d54", fg1: "#657b83", fg2: "#93a1a1", accent: "#268bd2", accentFg: "#ffffff",
      ok: "#859900", warn: "#b58900", err: "#dc322f", charts: ["#268bd2", "#859900", "#d33682", "#b58900"],
    },
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#93a1a1",
           "#586e75", "#cb4b16", "#859900", "#b58900", "#268bd2", "#6c71c4", "#2aa198", "#657b83"],
  },
  {
    id: "campbell", name: "Campbell", dark: true, group: "classic",
    ui: {
      chrome: "#080808", bg0: "#0c0c0c", bg1: "#151515", bg2: "#1c1c1c", bg3: "#242424", bg4: "#2e2e2e",
      fg0: "#d9d9d9", fg1: "#9a9a9a", fg2: "#666666", accent: "#3b78ff", accentFg: "#ffffff",
      ok: "#16c60c", warn: "#c19c00", err: "#e74856", charts: ["#3b78ff", "#16c60c", "#b4009e", "#c19c00"],
    },
    ansi: ["#0c0c0c", "#c50f1f", "#13a10e", "#c19c00", "#0037da", "#881798", "#3a96dd", "#cccccc",
           "#767676", "#e74856", "#16c60c", "#f9f1a5", "#3b78ff", "#b4009e", "#61d6d6", "#f2f2f2"],
  },
  {
    id: "gruvbox", name: "Gruvbox", dark: true, group: "classic",
    ui: {
      chrome: "#1d2021", bg0: "#282828", bg1: "#2e2c2b", bg2: "#32302f", bg3: "#3c3836", bg4: "#504945",
      fg0: "#ebdbb2", fg1: "#bdae93", fg2: "#7c6f64", accent: "#fabd2f", accentFg: "#1d2021",
      ok: "#b8bb26", warn: "#fabd2f", err: "#fb4934", charts: ["#83a598", "#b8bb26", "#d3869b", "#fabd2f"],
    },
    ansi: ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
           "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"],
  },
  {
    id: "tokyo-night", name: "Tokyo Night", dark: true, group: "classic",
    ui: {
      chrome: "#16161e", bg0: "#1a1b26", bg1: "#1f2030", bg2: "#24283b", bg3: "#292e42", bg4: "#343a55",
      fg0: "#c0caf5", fg1: "#a9b1d6", fg2: "#565f89", accent: "#7aa2f7", accentFg: "#16161e",
      ok: "#9ece6a", warn: "#e0af68", err: "#f7768e", charts: ["#7aa2f7", "#9ece6a", "#bb9af7", "#e0af68"],
    },
    ansi: ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
           "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"],
  },
  {
    id: "catppuccin", name: "Catppuccin", dark: true, group: "classic",
    ui: {
      chrome: "#11111b", bg0: "#1e1e2e", bg1: "#232334", bg2: "#28283b", bg3: "#313244", bg4: "#45475a",
      fg0: "#cdd6f4", fg1: "#a6adc8", fg2: "#6c7086", accent: "#cba6f7", accentFg: "#11111b",
      ok: "#a6e3a1", warn: "#f9e2af", err: "#f38ba8", charts: ["#89b4fa", "#a6e3a1", "#cba6f7", "#f9e2af"],
    },
    ansi: ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
           "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"],
  },
];

/**
 * Host label colors. Stored per host as literal values (user data), so they are the same in every
 * theme; they are only ever used as a tint or marker, never as a text-on-fill background.
 */
export const LABEL_COLORS = ["#ef6b6b", "#e5a54b", "#4cc38a", "#3fb6a8", "#5fa8f5", "#c58af0"] as const;

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
  set("--on-accent", p.accentFg); // text/icons on a solid --accent fill
  // Solid danger fill (destructive confirm, window close): pastel dark-theme reds are darkened so
  // white text on them stays readable.
  set("--danger-solid", t.dark ? `color-mix(in srgb, ${p.err} 72%, #000)` : p.err);
  set("--on-danger", "#ffffff");
  set("--accent-soft", `color-mix(in srgb, ${p.accent} ${t.dark ? 14 : 11}%, transparent)`);
  set("--info", p.accent);
  set("--ok", p.ok);
  set("--warn", p.warn);
  set("--err", p.err);
  p.charts.forEach((c, i) => set(`--chart-${i + 1}`, c));
  const ink = t.dark ? "255, 255, 255" : "15, 20, 30";
  set("--line", `rgba(${ink}, ${t.dark ? 0.055 : 0.07})`);
  set("--line-strong", `rgba(${ink}, ${t.dark ? 0.1 : 0.13})`);
  // Dim layer behind dialogs; always darkens, also on light themes.
  set("--scrim", t.dark ? "rgba(4, 6, 8, 0.6)" : "rgba(15, 20, 30, 0.32)");
  set("--shadow-sm", t.dark ? "0 1px 2px rgba(0, 0, 0, 0.3)" : "0 1px 2px rgba(15, 20, 30, 0.08)");
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
