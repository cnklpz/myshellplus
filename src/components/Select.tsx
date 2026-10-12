// Custom dropdown replacing native <select>, so every dropdown shares the app's floating-menu style.
import { Check, ChevronDown } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SelectOption<T extends string | number> {
  value: T;
  label: ReactNode;
  /** Plain text used for type-ahead and the button when `label` is not a string */
  text?: string;
  hint?: ReactNode;
  disabled?: boolean;
}

export function Select<T extends string | number>(props: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
  width?: number | string;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const typed = useRef({ s: "", t: 0 });

  const current = props.options.find((o) => o.value === props.value);
  const textOf = (o: SelectOption<T>) => o.text ?? (typeof o.label === "string" ? o.label : String(o.value));

  const openMenu = () => {
    if (props.disabled) return;
    const i = props.options.findIndex((o) => o.value === props.value);
    setHi(i >= 0 ? i : 0);
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };
  const pick = (o: SelectOption<T>) => {
    if (o.disabled) return;
    props.onChange(o.value);
    close();
  };

  // Position under the button; flip above when there is no room below.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const h = Math.min(320, props.options.length * 32 + 8);
    const up = r.bottom + 4 + h > window.innerHeight - 8 && r.top - 4 - h > 8;
    setPos({ left: r.left, top: up ? r.top - 4 - h : r.bottom + 4, width: r.width, up });
  }, [open, props.options.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) close(false);
    };
    const onBlur = () => close(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onBlur);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onBlur);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, hi]);

  const move = (d: number) => {
    const n = props.options.length;
    if (!n) return;
    let i = hi;
    for (let k = 0; k < n; k++) {
      i = (i + d + n) % n;
      if (!props.options[i].disabled) break;
    }
    setHi(i);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't close the surrounding dialog
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = props.options[hi];
      if (o) pick(o);
    } else if (e.key === "Tab") {
      close(false);
    } else if (e.key.length === 1) {
      // type-ahead
      const now = Date.now();
      typed.current.s = (now - typed.current.t > 700 ? "" : typed.current.s) + e.key.toLowerCase();
      typed.current.t = now;
      const i = props.options.findIndex((o) => textOf(o).toLowerCase().startsWith(typed.current.s));
      if (i >= 0) setHi(i);
    }
  };

  const size = props.size ?? "md";
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`select-btn ${size}${open ? " open" : ""}${props.className ? " " + props.className : ""}`}
        style={{ width: props.width, ...props.style }}
        disabled={props.disabled}
        title={props.title}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKey}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={"select-value ellipsis" + (current ? "" : " faint")}>{current ? current.label : props.placeholder ?? ""}</span>
        <ChevronDown className="select-chevron" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="select-menu"
            role="listbox"
            style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {props.options.map((o, i) => (
              <div
                key={String(o.value)}
                data-i={i}
                role="option"
                aria-selected={o.value === props.value}
                className={
                  "select-item" + (i === hi ? " hi" : "") + (o.value === props.value ? " on" : "") + (o.disabled ? " disabled" : "")
                }
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(o)}
              >
                <span className="select-check">{o.value === props.value && <Check />}</span>
                <span className="grow ellipsis">{o.label}</span>
                {o.hint && <span className="select-hint">{o.hint}</span>}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
