// Shared UI building blocks. Prefer these + base.css classes over ad-hoc styles.
import { Search, X } from "lucide-react";
import { createContext, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref, useContext, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { isMobile } from "../lib/platform";
import { level, PCT_ERR, PCT_WARN } from "../lib/level";
import { useTweenText } from "../lib/motion";
import { useApp, type Toast, type ToastAction } from "../store";

// Layers that close on Esc. The topmost is the deepest nested one, then the latest mounted. Ordering by
// enable time is wrong: when a hidden page modal reopens, child effects re-enable before the parent's.
interface EscEntry {
  depth: number;
  seq: number;
  enabled: boolean;
}
const escLayers: EscEntry[] = [];
let escSeq = 0;
const EscDepth = createContext(0);

function topEsc(): EscEntry | undefined {
  let top: EscEntry | undefined;
  for (const e of escLayers) {
    if (e.enabled && (!top || e.depth > top.depth || (e.depth === top.depth && e.seq > top.seq))) top = e;
  }
  return top;
}

/** Wrap the content of a layer that uses `useEscClose`, so layers opened inside it rank above it. */
export function EscLayer(props: { children: ReactNode }) {
  const depth = useContext(EscDepth);
  return <EscDepth.Provider value={depth + 1}>{props.children}</EscDepth.Provider>;
}

/** Close on Esc, but only when this is the topmost dialog/modal. */
export function useEscClose(onClose: () => void, enabled = true) {
  const ref = useRef(onClose);
  ref.current = onClose;
  const depth = useContext(EscDepth);
  const me = useRef<EscEntry | null>(null);
  useEffect(() => {
    const entry: EscEntry = { depth, seq: ++escSeq, enabled };
    me.current = entry;
    escLayers.push(entry);
    return () => {
      escLayers.splice(escLayers.indexOf(entry), 1);
      me.current = null;
    };
  }, [depth]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (me.current) me.current.enabled = enabled;
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && me.current && topEsc() === me.current) {
        e.stopPropagation();
        ref.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** True inside a hidden (but still mounted) page modal: its portaled dialogs must hide too. */
export const HiddenContext = createContext(false);

/** Wrap content that stays mounted while hidden (display: none), so its portaled dialogs hide with it. */
export function HideDialogs(props: { when: boolean; children: ReactNode }) {
  const parent = useContext(HiddenContext);
  return <HiddenContext.Provider value={parent || props.when}>{props.children}</HiddenContext.Provider>;
}

/**
 * Portaled to <body>: a transformed or draggable ancestor must neither offset `position: fixed` nor
 * receive the dialog's native events. React events still bubble to the owner, so owners with pointer /
 * context-menu handlers should ignore targets outside their own DOM.
 */
export function Dialog(props: {
  title: ReactNode;
  width?: number;
  onClose: () => void;
  footer?: ReactNode;
  /** Extra class on the overlay, e.g. for a custom enter/leave animation. */
  className?: string;
  children: ReactNode;
}) {
  const hidden = useContext(HiddenContext);
  useEscClose(props.onClose, !hidden);
  const width = props.width ?? 520;
  // Phones: form-sized dialogs fill the screen; small confirmations stay centered.
  const full = isMobile && width > 440;
  return createPortal(
    <div
      className={"overlay" + (full ? " full" : "") + (props.className ? " " + props.className : "")}
      style={hidden ? { display: "none" } : undefined}
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div className={"dialog" + (full ? " full" : "")} style={full ? undefined : { width }}>
        <DialogHeader title={props.title} onClose={props.onClose} />
        <EscLayer>
          <div className="dialog-body">{props.children}</div>
          {props.footer && <div className="dialog-footer">{props.footer}</div>}
        </EscLayer>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The one dialog header: title on the --sp-6 content line, optional extra controls (`children`, placed
 * between title and close button), close button at the right. Use it in custom dialog shells too.
 */
export function DialogHeader(props: { title: ReactNode; onClose?: () => void; children?: ReactNode }) {
  return (
    <div className="dialog-header">
      <span className="dialog-title">{props.title}</span>
      {props.children}
      {props.onClose && (
        <button className="icon-btn" onClick={props.onClose} title="关闭">
          <X />
        </button>
      )}
    </div>
  );
}

/** Search input with a leading icon (.search-box). Width comes from the container or `className`. */
export function SearchBox(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** "sm" = --h-sm input (default --h-md) */
  size?: "sm" | "md";
  /** borderless row at the top of a popover / picker list */
  flat?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
}) {
  const sm = props.size === "sm";
  return (
    <div className={"search-box" + (sm ? " sm" : "") + (props.flat ? " flat" : "") + (props.className ? " " + props.className : "")}>
      <Search />
      <input
        ref={props.inputRef}
        className={"input" + (sm ? " sm" : "")}
        value={props.value}
        placeholder={props.placeholder ?? "搜索"}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={props.onKeyDown}
      />
    </div>
  );
}

export function Field(props: { label: ReactNode; hint?: ReactNode; top?: boolean; children: ReactNode }) {
  return (
    <>
      <div className={"field" + (props.top ? " top" : "")}>
        <label>{props.label}</label>
        <div className="row">{props.children}</div>
      </div>
      {props.hint && (
        <div className="field">
          <span />
          <div className="field-hint">{props.hint}</div>
        </div>
      )}
    </>
  );
}

export function Toggle(props: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={"toggle" + (props.on ? " on" : "")}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
    />
  );
}

/** Empty state: optional icon, one short line, optional action button. `sm` for compact spots. */
export function Empty(props: { icon?: ReactNode; text: ReactNode; action?: ReactNode; sm?: boolean; className?: string }) {
  return (
    <div className={"empty" + (props.sm ? " sm" : "") + (props.className ? " " + props.className : "")}>
      {props.icon}
      <div>{props.text}</div>
      {props.action}
    </div>
  );
}

/** Usage bar colored by level (warn/err thresholds). `thin` = 4px variant. */
export function Bar(props: { value: number; max?: number; thin?: boolean }) {
  const pct = Math.max(0, Math.min(100, (props.value / (props.max ?? 100)) * 100));
  const l = level(pct, PCT_WARN, PCT_ERR);
  const cls = l === "ok" ? "" : " " + l;
  return (
    <div className={"bar" + (props.thin ? " thin" : "") + cls}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A number whose text eases to each new value (rAF, no React re-render per frame). */
export function TweenNum(props: { value: number; fmt: (v: number) => string; className?: string; title?: string; style?: CSSProperties }) {
  const ref = useTweenText<HTMLSpanElement>(props.value, props.fmt);
  return <span ref={ref} className={props.className} title={props.title} style={props.style} />;
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={"toast " + t.kind} onClick={() => dismiss(t.id)}>
          <span className="grow selectable">{t.text}</span>
          {t.action && (
            <button
              className="btn sm ghost toast-action"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Confirm dialog helper rendered inline by the caller. */
export function Confirm(props: {
  title: string;
  message: ReactNode;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      title={props.title}
      width={420}
      onClose={props.onCancel}
      footer={
        <>
          <button className="btn" onClick={props.onCancel}>取消</button>
          <button className={"btn " + (props.danger ? "danger solid" : "primary")} onClick={props.onConfirm}>
            {props.confirmText ?? "确定"}
          </button>
        </>
      }
    >
      <div className="muted selectable">{props.message}</div>
    </Dialog>
  );
}

export const toast = (text: string, kind?: Toast["kind"], action?: ToastAction) => useApp.getState().toast(text, kind, action);
