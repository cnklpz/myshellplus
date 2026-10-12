// Predictive local echo (mosh-style). On a slow link, typed characters are drawn immediately as an
// underlined overlay at the cursor; when the server's echo arrives, confirmed characters drop out of
// the overlay. Nothing is ever written into the xterm buffer, so a wrong guess can't corrupt output.
import type { Terminal } from "@xterm/xterm";
import { termTheme } from "../../lib/themes";

export type EchoMode = "off" | "auto" | "on";

const SETTINGS_EVENT = "local-echo-change";

export function echoSettings(): { mode: EchoMode; threshold: number } {
  try {
    const m = localStorage.getItem("localEcho");
    const t = Number(localStorage.getItem("localEchoMs"));
    return { mode: m === "off" || m === "on" ? m : "auto", threshold: t >= 20 && t <= 1000 ? t : 80 };
  } catch {
    return { mode: "auto", threshold: 80 };
  }
}

export function saveEchoSettings(mode: EchoMode, threshold: number) {
  try {
    localStorage.setItem("localEcho", mode);
    localStorage.setItem("localEchoMs", String(threshold));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(SETTINGS_EVENT));
}

/** Display width of a string in terminal cells (CJK / fullwidth = 2). */
function cellWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w +=
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
        ? 2
        : 1;
  }
  return w;
}

const PRINTABLE = /^[^\x00-\x1f\x7f]+$/;

export class LocalEcho {
  private pending = "";
  /** Absolute buffer position where the first pending char will appear. */
  private anchor: { x: number; y: number } | null = null;
  private overlay: HTMLDivElement;
  private samples: number[] = [];
  private sentAt = 0;
  private networkMs = 0;
  /** Set when typed text was not echoed (password prompt etc.); cleared on Enter. */
  private noEcho = false;
  private noEchoTimer: number | undefined;
  private settings = echoSettings();
  private onSettings = () => {
    this.settings = echoSettings();
    if (!this.enabled()) this.clear();
  };

  /** Hides/restores the real cursor while predicted text is drawn. */
  private cursorHidden = false;
  private setCursorHidden(hide: boolean) {
    if (hide === this.cursorHidden) return;
    this.cursorHidden = hide;
    const theme = { ...termTheme() };
    if (hide) {
      theme.cursor = "transparent";
      theme.cursorAccent = "transparent";
    }
    this.term.options.theme = theme;
  }

  constructor(private term: Terminal) {
    this.overlay = document.createElement("div");
    this.overlay.className = "local-echo";
    this.overlay.style.display = "none";
    window.addEventListener(SETTINGS_EVENT, this.onSettings);
  }

  /** Must be called after term.open(). */
  mount() {
    const screen = this.term.element?.querySelector(".xterm-screen");
    screen?.appendChild(this.overlay);
  }

  dispose() {
    window.removeEventListener(SETTINGS_EVENT, this.onSettings);
    clearTimeout(this.noEchoTimer);
    this.overlay.remove();
  }

  /** Network RTT from the backend's SSH ping. */
  setNetworkLatency(ms: number | null) {
    this.networkMs = ms ?? 0;
  }

  /** Median keystroke → echo delay observed on this terminal. */
  echoLatency(): number {
    if (!this.samples.length) return 0;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  private enabled(): boolean {
    const { mode, threshold } = this.settings;
    if (mode === "off" || this.noEcho) return false;
    if (this.term.buffer.active.type === "alternate") return false; // vim, htop, less…
    if (mode === "on") return true;
    return Math.max(this.echoLatency(), this.networkMs) >= threshold;
  }

  private cursor() {
    const b = this.term.buffer.active;
    return { x: b.cursorX, y: b.baseY + b.cursorY };
  }

  /** Called with user input right before it is sent to the server. */
  onInput(data: string) {
    if (PRINTABLE.test(data) && data.length <= 256) {
      if (!this.sentAt) this.sentAt = performance.now();
      this.armNoEchoDetector();
      if (!this.enabled()) return;
      if (!this.pending) this.anchor = this.cursor();
      this.pending += data;
      this.render();
      return;
    }
    if (data === "\x7f" || data === "\b") {
      if (this.pending) {
        this.pending = [...this.pending].slice(0, -1).join("");
        this.render();
      }
      return;
    }
    // Enter, Ctrl-keys, arrows, Tab…: the server decides what happens next.
    if (data === "\r") {
      this.noEcho = false;
      clearTimeout(this.noEchoTimer);
    }
    this.clear();
  }

  /** Called after the terminal has parsed a chunk of server output. */
  onOutput() {
    if (this.sentAt) {
      this.samples.push(performance.now() - this.sentAt);
      if (this.samples.length > 15) this.samples.shift();
      this.sentAt = 0;
      clearTimeout(this.noEchoTimer);
    }
    if (!this.pending || !this.anchor) return;
    if (this.term.buffer.active.type === "alternate") return this.clear();
    const cols = this.term.cols;
    const cur = this.cursor();
    const advanced = (cur.y - this.anchor.y) * cols + (cur.x - this.anchor.x);
    if (advanced === 0) return; // echo not here yet
    if (advanced < 0) return this.clear();
    // Drop as many predicted chars as the cursor advanced, if the buffer shows the same text.
    let used = 0;
    let n = 0;
    for (const ch of this.pending) {
      const w = cellWidth(ch);
      if (used + w > advanced) break;
      used += w;
      n += ch.length;
    }
    const confirmed = this.pending.slice(0, n);
    const line = this.term.buffer.active.getLine(this.anchor.y)?.translateToString(false, this.anchor.x, this.anchor.x + used) ?? "";
    if (used !== advanced || (this.anchor.y === cur.y && line.replace(/ /g, "") !== confirmed.replace(/ /g, ""))) {
      // The server did something else (completion, redraw, prompt change): trust the server.
      return this.clear();
    }
    this.pending = this.pending.slice(n);
    this.anchor = cur;
    this.render();
  }

  clear() {
    this.pending = "";
    this.anchor = null;
    this.overlay.style.display = "none";
    this.setCursorHidden(false);
  }

  /** Typed but nothing came back for a while: probably echo is off (password prompt). */
  private armNoEchoDetector() {
    clearTimeout(this.noEchoTimer);
    const wait = Math.max(1500, this.echoLatency() * 4, this.networkMs * 4);
    this.noEchoTimer = window.setTimeout(() => {
      if (this.sentAt) {
        this.noEcho = true;
        this.sentAt = 0;
        this.clear();
      }
    }, wait);
  }

  private render() {
    if (!this.pending || !this.anchor) {
      this.overlay.style.display = "none";
      this.setCursorHidden(false);
      return;
    }
    const screen = this.overlay.parentElement;
    if (!screen) return;
    const cw = screen.clientWidth / this.term.cols;
    const ch = screen.clientHeight / this.term.rows;
    const viewportY = this.term.buffer.active.viewportY;
    const row = this.anchor.y - viewportY;
    if (row < 0 || row >= this.term.rows) {
      this.overlay.style.display = "none";
      return;
    }
    const o = this.overlay;
    o.textContent = this.pending;
    o.style.display = "block";
    this.setCursorHidden(true);
    o.style.left = `${this.anchor.x * cw}px`;
    o.style.top = `${row * ch}px`;
    o.style.height = `${ch}px`;
    o.style.lineHeight = `${ch}px`;
    o.style.fontSize = `${this.term.options.fontSize}px`;
    o.style.fontFamily = this.term.options.fontFamily ?? "monospace";
    o.style.letterSpacing = `${Math.max(0, cw - this.measure(cw))}px`;
    o.style.maxWidth = `${(this.term.cols - this.anchor.x) * cw}px`;
  }

  private glyphW = 0;
  /** Natural advance width of one mono glyph at the current font, to pad up to the cell width. */
  private measure(cw: number): number {
    if (!this.glyphW) {
      const c = document.createElement("canvas").getContext("2d");
      if (!c) return cw;
      c.font = `${this.term.options.fontSize}px ${this.term.options.fontFamily}`;
      this.glyphW = c.measureText("M").width || cw;
    }
    return this.glyphW;
  }
}
