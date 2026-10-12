// Keyword highlighting (设置 → 外观 → 高亮). Colors matching text in the visible rows with xterm
// decorations, so the output stream itself is never modified. Skipped in the alternate screen (vim, top…).
import type { IBufferCell, IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { currentTheme, onThemeChange, type Theme } from "../../lib/themes";

export type HlColor = "red" | "yellow" | "green" | "blue" | "magenta" | "cyan";

export interface HlRule {
  id: string;
  pattern: string;
  regex: boolean;
  color: HlColor;
  on: boolean;
}

export interface HlSettings {
  enabled: boolean;
  /** Active template id from HL_PRESETS, or "custom" */
  preset: string;
  /** Active rules (what the terminal uses) */
  rules: HlRule[];
  /** The user's own rule set, kept while another template is active */
  custom?: HlRule[];
}

/** Colors map to the theme's ANSI palette, so rules follow theme changes. */
export const HL_COLORS: { value: HlColor; label: string; ansi: number }[] = [
  { value: "red", label: "红色", ansi: 1 },
  { value: "yellow", label: "黄色", ansi: 3 },
  { value: "green", label: "绿色", ansi: 2 },
  { value: "blue", label: "蓝色", ansi: 4 },
  { value: "magenta", label: "紫色", ansi: 5 },
  { value: "cyan", label: "青色", ansi: 6 },
];

export function hlColor(c: HlColor, t: Theme = currentTheme()): string {
  return t.ansi[HL_COLORS.find((x) => x.value === c)?.ansi ?? 1];
}

type PresetRule = Omit<HlRule, "id" | "on">;
const re = (pattern: string, color: HlColor): PresetRule => ({ pattern, regex: true, color });

const IPV4 = re("\\b\\d{1,3}(\\.\\d{1,3}){3}\\b", "blue");
const ERR = re("\\b(error|errors|failed|failure|fatal|denied|refused)\\b|错误|失败", "red");
const WARN = re("\\b(warn|warning|warnings)\\b|警告", "yellow");

/** Starting points; applying one replaces the rule list, which stays fully editable. Later rules win on overlap. */
export const HL_PRESETS: { id: string; label: string; rules: PresetRule[] }[] = [
  {
    id: "general",
    label: "通用",
    rules: [ERR, WARN, re("\\b(success|successful|succeeded|passed|done)\\b|成功", "green"), IPV4],
  },
  {
    id: "log",
    label: "日志",
    rules: [
      re("\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}([.,]\\d+)?", "magenta"),
      re("\\b(debug|trace)\\b", "cyan"),
      re("\\b(info|notice)\\b", "green"),
      WARN,
      re("\\b(error|err|fatal|crit|critical|panic|exception)\\b", "red"),
      IPV4,
    ],
  },
  {
    id: "ops",
    label: "运维",
    rules: [
      re("\\b\\d+(\\.\\d+)?%", "magenta"),
      re("\\b(active|running|enabled|online|healthy|listen)\\b", "green"),
      re("\\b(inactive|dead|disabled|stopped|exited|offline|unhealthy)\\b", "red"),
      ERR,
      WARN,
      IPV4,
    ],
  },
  {
    id: "net",
    label: "网络",
    rules: [
      re("\\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\\b", "magenta"),
      re("\\b([0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\\b", "cyan"),
      IPV4,
      re(":\\d{2,5}\\b", "yellow"),
      re("\\b(timeout|timed out|unreachable|refused|reset)\\b", "red"),
    ],
  },
];

export function presetRules(id: string): HlRule[] {
  const p = HL_PRESETS.find((x) => x.id === id) ?? HL_PRESETS[0];
  const t = Date.now().toString(36);
  return p.rules.map((r, i) => ({ ...r, id: `${p.id}-${t}-${i}`, on: true }));
}

const KEY = "termHighlight";
const EVENT = "term-highlight-change";

export function highlightSettings(): HlSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as HlSettings;
      if (Array.isArray(s.rules)) {
        // Older saves had no template: treat their rules as the custom set.
        if (!s.preset) return { enabled: s.enabled !== false, preset: "custom", rules: s.rules, custom: s.rules };
        return { ...s, enabled: s.enabled !== false };
      }
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return { enabled: true, preset: "general", rules: presetRules("general") };
}

export function saveHighlightSettings(s: HlSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** null when the rule's pattern is empty or not a valid regex. */
export function compileRule(r: Pick<HlRule, "pattern" | "regex">): RegExp | null {
  if (!r.pattern) return null;
  try {
    const src = r.regex ? r.pattern : r.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(src, "gi");
  } catch {
    return null;
  }
}

/** Upper bound on decorations per refresh; dense output stays cheap. */
const MAX_DECOS = 600;
const THROTTLE_MS = 60;

export class Highlighter {
  private rules: { re: RegExp; color: string }[] = [];
  private decos: IDecoration[] = [];
  private markers: IMarker[] = [];
  private timer: number | undefined;
  private cell: IBufferCell | undefined;
  private subs: { dispose(): void }[] = [];
  private unTheme: () => void;
  private onSettings = () => this.load();

  constructor(private term: Terminal) {
    this.load();
    this.unTheme = onThemeChange(() => this.load());
    window.addEventListener(EVENT, this.onSettings);
    this.subs.push(
      term.onWriteParsed(() => this.schedule()),
      term.onScroll(() => this.schedule()),
      term.onResize(() => this.schedule()),
      term.buffer.onBufferChange(() => this.schedule()),
    );
  }

  private load() {
    const s = highlightSettings();
    const t = currentTheme();
    this.rules = s.enabled
      ? s.rules.flatMap((r) => {
          const re = r.on ? compileRule(r) : null;
          return re ? [{ re, color: hlColor(r.color, t) }] : [];
        })
      : [];
    this.schedule();
  }

  /** Throttled, not debounced: continuous output still gets highlighted while it streams. */
  schedule() {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, THROTTLE_MS);
  }

  private clear() {
    this.decos.forEach((d) => d.dispose());
    this.markers.forEach((m) => m.dispose());
    this.decos = [];
    this.markers = [];
  }

  private refresh() {
    this.clear();
    const term = this.term;
    const b = term.buffer.active;
    if (!this.rules.length || b.type !== "normal") return;
    this.cell ??= b.getNullCell();
    const cursorAbs = b.baseY + b.cursorY;

    for (let row = 0; row < term.rows; row++) {
      const y = b.viewportY + row;
      const line = b.getLine(y);
      if (!line) break;
      // Text of the row plus the start column of each UTF-16 unit (wide chars take 2 columns).
      let text = "";
      const cols: number[] = [];
      for (let x = 0; x < line.length; x++) {
        const c = line.getCell(x, this.cell);
        if (!c) break;
        if (c.getWidth() === 0) continue;
        const ch = c.getChars() || " ";
        for (let k = 0; k < ch.length; k++) cols.push(x);
        text += ch;
      }
      cols.push(line.length);
      if (!text.trim()) continue;

      let marker: IMarker | undefined;
      for (const { re, color } of this.rules) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          if (!m[0]) {
            re.lastIndex++;
            continue;
          }
          if (this.decos.length >= MAX_DECOS) return;
          const x = cols[m.index];
          const width = cols[m.index + m[0].length] - x;
          if (!marker) {
            marker = term.registerMarker(y - cursorAbs);
            if (!marker) break;
            this.markers.push(marker);
          }
          const d = term.registerDecoration({ marker, x, width, foregroundColor: color });
          if (d) this.decos.push(d);
        }
      }
    }
  }

  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.subs.forEach((s) => s.dispose());
    this.unTheme();
    window.removeEventListener(EVENT, this.onSettings);
    this.clear();
  }
}
