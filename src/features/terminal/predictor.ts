// Command prediction for one terminal: tracks the line being typed (read back from the xterm buffer, so the
// shell's own echo/editing is the source of truth), asks the backend for local/AI suggestions and drives a
// popup through a single `emit` callback. Nothing here touches React state per output chunk.
import type { Terminal } from "@xterm/xterm";
import { toast } from "../../components/ui";
import { api, errMsg, type Suggestion } from "../../lib/api";
import { aiPredictEnabled } from "./config";

export interface PopupState {
  items: Suggestion[];
  selected: number;
  input: string;
  left: number;
  top?: number;
  bottom?: number;
  aiLoading: boolean;
}

const MAX_ROWS = 6;
const MAX_AI = 3;
const LOCAL_DEBOUNCE = 120;
const AI_IDLE = 600;
const MAX_INPUT = 300;
/** Popup inner offset from its left edge to the command text (padding + icon column + gap). */
export const POPUP_TEXT_OFFSET = 4 + 8 + 16 + 8;
const POPUP_ROW_H = 28;
const POPUP_WIDTH = 520;

interface Pos { x: number; y: number }

export class Predictor {
  private start: Pos | null = null;
  private input = "";
  private suppressed = false;
  private local: Suggestion[] = [];
  private localInput: string | null = null;
  private ai: Suggestion[] = [];
  private aiInput: string | null = null;
  private aiLoading = false;
  private selected = -1;
  private shown: Suggestion[] = [];
  private seq = 0;
  private aiSeq = 0;
  private timer: number | undefined;
  private aiTimer: number | undefined;
  private disposed = false;

  constructor(
    private term: Terminal,
    private wrapper: HTMLElement,
    private tabId: string,
    private hostId: string,
    private screenText: (lines: number) => string,
    private emit: (p: PopupState | null) => void,
  ) {}

  // ---------- buffer helpers ----------
  private alt() {
    return this.term.buffer.active.type === "alternate";
  }

  private cursor(): Pos {
    const b = this.term.buffer.active;
    return { x: b.cursorX, y: b.baseY + b.cursorY };
  }

  /** Text from the tracked line start to the cursor (spans wrapped rows). null = tracking is invalid. */
  private readInput(): string | null {
    const s = this.start;
    if (!s) return null;
    const b = this.term.buffer.active;
    const c = this.cursor();
    if (c.y < s.y || (c.y === s.y && c.x < s.x) || c.y - s.y > 8) return null;
    let out = "";
    for (let y = s.y; y <= c.y; y++) {
      const line = b.getLine(y);
      if (!line) return null;
      out += line.translateToString(false, y === s.y ? s.x : 0, y === c.y ? c.x : this.term.cols);
    }
    return out;
  }

  private cursorAtEnd(): boolean {
    const b = this.term.buffer.active;
    const line = b.getLine(b.baseY + b.cursorY);
    return !line || line.translateToString(true, b.cursorX).length === 0;
  }

  // ---------- lifecycle ----------
  reset() {
    this.start = null;
    this.input = "";
    this.suppressed = false;
    this.local = [];
    this.localInput = null;
    this.ai = [];
    this.aiInput = null;
    this.aiLoading = false;
    this.selected = -1;
    this.seq++;
    this.aiSeq++;
    clearTimeout(this.timer);
    clearTimeout(this.aiTimer);
    this.hide();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.aiTimer);
  }

  private hide() {
    this.selected = -1;
    if (this.shown.length || this.aiLoading) this.shown = [];
    this.emit(null);
  }

  private suppress() {
    this.suppressed = true;
    this.aiLoading = false;
    this.aiSeq++;
    clearTimeout(this.aiTimer);
    this.hide();
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), LOCAL_DEBOUNCE);
  }

  // ---------- events from XTermView ----------
  /** User input (term.onData), before it is sent to the shell. */
  onData(data: string) {
    if (this.alt()) {
      if (this.start) this.reset();
      return;
    }
    if (data === "\r") {
      if (this.start) {
        const input = this.readInput();
        const cmd = input?.trim();
        if (cmd && !input!.startsWith(" ")) api.historyRecord(this.hostId, cmd).catch(() => {});
      }
      this.reset();
      return;
    }
    if (data.includes("\r") || data.includes("\n")) {
      // multi-line paste: the command ran, nothing reliable to record
      this.reset();
      return;
    }
    // Ctrl+C, Ctrl+U, Ctrl+L, Ctrl+D, Ctrl+Z, Ctrl+G
    if (data === "\x03" || data === "\x15" || data === "\x0c" || data === "\x04" || data === "\x1a" || data === "\x07") {
      this.reset();
      return;
    }
    if (data.startsWith("\x1b")) {
      // Up/Down reached the shell: it is browsing its own history, get out of the way.
      if (data === "\x1b[A" || data === "\x1b[B" || data === "\x1bOA" || data === "\x1bOB") this.suppress();
      if (this.start) this.schedule();
      return;
    }
    const c = data.charCodeAt(0);
    if (c >= 0x20 && c !== 0x7f) {
      if (!this.start) this.start = this.cursor();
      this.suppressed = false;
      this.schedule();
      return;
    }
    // Backspace, Tab completion, other control keys: the line changed in some way.
    if (this.start) this.schedule();
  }

  /** Output was parsed: the echo of what was typed may have arrived. */
  onWriteParsed() {
    if (this.start) this.schedule();
  }

  onCursorMove() {
    if (!this.start) return;
    const s = this.start;
    const c = this.cursor();
    if (c.y < s.y || (c.y === s.y && c.x < s.x)) this.reset();
  }

  /** Programmatic command (termBus.run) — tracking state is meaningless afterwards. */
  onRun() {
    this.reset();
  }

  // ---------- prediction ----------
  private refresh() {
    if (this.disposed) return;
    if (!this.start || this.alt()) return this.reset();
    const input = this.readInput();
    if (input === null) return this.reset();
    this.input = input;
    if (this.suppressed) return;
    if (input.trim().length < 2 || input.length > MAX_INPUT) {
      this.local = [];
      this.localInput = null;
      this.render();
      return;
    }
    if (input !== this.localInput) {
      const seq = ++this.seq;
      api
        .predictLocal(this.hostId, input)
        .then((r) => {
          if (seq !== this.seq || this.disposed) return;
          this.local = r;
          this.localInput = input;
          this.selected = -1;
          this.render();
        })
        .catch(() => {});
    }
    this.render();
    clearTimeout(this.aiTimer);
    if (aiPredictEnabled() && input.trim().length >= 3 && input !== this.aiInput) {
      this.aiTimer = window.setTimeout(() => this.runAi(false), AI_IDLE);
    }
  }

  /** Ask the AI now (Ctrl+Space) or after idle typing. */
  runAi(force: boolean) {
    if (this.disposed || this.alt()) return;
    if (!this.start) {
      if (!force) return;
      this.start = this.cursor();
    }
    const input = this.readInput();
    if (input === null) return this.reset();
    this.input = input;
    if (input.length > MAX_INPUT) return;
    this.suppressed = false;
    clearTimeout(this.aiTimer);
    const seq = ++this.aiSeq;
    if (force) {
      this.aiLoading = true;
      this.render();
    }
    api
      .predictAi(this.hostId, input, this.screenText(30))
      .then((r) => {
        if (seq !== this.aiSeq || this.disposed) return;
        this.ai = r.map((s) => ({ ...s, source: "ai" as const }));
        this.aiInput = input;
        if (force && this.ai.length === 0) toast("AI 无预测结果");
      })
      .catch((e) => {
        if (force && seq === this.aiSeq) toast(`AI 预测失败：${errMsg(e)}`, "error");
      })
      .finally(() => {
        if (seq !== this.aiSeq || this.disposed) return;
        this.aiLoading = false;
        this.render();
      });
  }

  private items(): Suggestion[] {
    const input = this.input;
    const fits = (s: Suggestion) => s.command.startsWith(input) && s.command.length > input.length;
    const local = (this.localInput === input ? this.local.filter((s) => s.command !== input) : this.local.filter(fits));
    const seen = new Set(local.map((s) => s.command));
    const ai = (this.aiInput === input ? this.ai : this.ai.filter(fits))
      .filter((s) => s.command !== input && !seen.has(s.command))
      .slice(0, MAX_AI);
    return [...local.slice(0, MAX_ROWS - ai.length), ...ai];
  }

  private position(rows: number): Pick<PopupState, "left" | "top" | "bottom"> | null {
    const b = this.term.buffer.active;
    if (b.viewportY !== b.baseY) return null; // scrolled up: the cursor is off screen
    const screen = this.term.element?.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen || !this.start) return null;
    const wr = this.wrapper.getBoundingClientRect();
    const sr = screen.getBoundingClientRect();
    if (!sr.width || !sr.height) return null;
    const cw = sr.width / this.term.cols;
    const ch = sr.height / this.term.rows;
    // Align the popup's command column with the first typed character.
    const startX = this.start.y === b.baseY + b.cursorY ? this.start.x : 0;
    let left = sr.left - wr.left + startX * cw - POPUP_TEXT_OFFSET;
    left = Math.max(4, Math.min(left, wr.width - Math.min(POPUP_WIDTH, wr.width - 8) - 4));
    const rowTop = sr.top - wr.top + b.cursorY * ch;
    const estH = rows * POPUP_ROW_H + 8;
    if (rowTop + ch + estH + 4 > wr.height && rowTop > estH) return { left, bottom: wr.height - rowTop + 2 };
    return { left, top: rowTop + ch + 2 };
  }

  private render() {
    if (this.disposed) return;
    if (this.suppressed || !this.start) return this.hide();
    const items = this.items();
    this.shown = items;
    if (!items.length && !this.aiLoading) return this.emit(null);
    if (this.selected >= items.length) this.selected = items.length - 1;
    const pos = this.position(items.length + (this.aiLoading ? 1 : 0));
    if (!pos) return this.emit(null);
    this.emit({ items, selected: this.selected, input: this.input, aiLoading: this.aiLoading, ...pos });
  }

  /** Write the rest of suggestion `i` to the shell. */
  accept(i: number) {
    const s = this.shown[i];
    if (!s) return;
    const input = this.input;
    // Suggestions that don't extend the typed prefix replace the whole line (Ctrl+U first).
    const data = s.command.startsWith(input) ? s.command.slice(input.length) : "\x15" + s.command;
    if (data) api.termWrite(this.tabId, data).catch(() => {});
    this.suppress();
    this.term.focus();
  }

  select(i: number) {
    this.selected = i;
    this.render();
  }

  /** Custom key handler hook. Returns false when the key was consumed by the popup. */
  handleKey(ev: KeyboardEvent): boolean {
    if (ev.type !== "keydown" || ev.isComposing) return true;
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && (ev.code === "Space" || ev.key === " ")) {
      ev.preventDefault();
      this.runAi(true);
      return false;
    }
    const n = this.shown.length;
    if (!n || ev.ctrlKey || ev.altKey || ev.metaKey) {
      if (n === 0 && this.aiLoading && ev.key === "Escape") {
        this.suppress();
        return false;
      }
      return true;
    }
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        this.select(this.selected < n - 1 ? this.selected + 1 : 0);
        return false;
      case "ArrowUp":
        if (this.selected < 0) {
          this.suppress(); // let the shell's own history take it
          return true;
        }
        ev.preventDefault();
        this.select(this.selected - 1);
        return false;
      case "Tab":
        if (this.selected < 0 || ev.shiftKey) return true; // shell completion
        ev.preventDefault();
        this.accept(this.selected);
        return false;
      case "ArrowRight":
        if (ev.shiftKey || !this.cursorAtEnd()) return true;
        ev.preventDefault();
        this.accept(Math.max(0, this.selected));
        return false;
      case "Escape":
        ev.preventDefault();
        this.suppress();
        return false;
    }
    return true;
  }
}
