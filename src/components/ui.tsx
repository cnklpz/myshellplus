// Shared UI building blocks. Prefer these + base.css classes over ad-hoc styles.
import { X } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { useTweenText } from "../lib/motion";
import { useApp, type Toast, type ToastAction } from "../store";

// Open dialogs, innermost last: only the topmost one reacts to Esc.
const dialogStack: symbol[] = [];

/** Close on Esc, but only when this is the topmost dialog/modal. */
export function useEscClose(onClose: () => void, enabled = true) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    const me = Symbol();
    dialogStack.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dialogStack[dialogStack.length - 1] === me) {
        e.stopPropagation();
        ref.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      dialogStack.splice(dialogStack.indexOf(me), 1);
    };
  }, [enabled]);
}

export function Dialog(props: {
  title: ReactNode;
  width?: number;
  onClose: () => void;
  footer?: ReactNode;
  /** Extra class on the overlay, e.g. for a custom enter/leave animation. */
  className?: string;
  children: ReactNode;
}) {
  useEscClose(props.onClose);
  return (
    <div className={"overlay" + (props.className ? " " + props.className : "")} onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog" style={{ width: props.width ?? 520 }}>
        <div className="dialog-header">
          <span className="grow ellipsis">{props.title}</span>
          <button className="icon-btn" onClick={props.onClose} title="关闭">
            <X />
          </button>
        </div>
        <div className="dialog-body">{props.children}</div>
        {props.footer && <div className="dialog-footer">{props.footer}</div>}
      </div>
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
          <div className="field-hint" style={{ marginTop: 0 }}>{props.hint}</div>
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

export function Empty(props: { icon?: ReactNode; text: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {props.icon}
      <div>{props.text}</div>
      {props.action}
    </div>
  );
}

export function Bar(props: { value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (props.value / (props.max ?? 100)) * 100));
  const cls = pct >= 90 ? " err" : pct >= 75 ? " warn" : "";
  return (
    <div className={"bar" + cls}>
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
