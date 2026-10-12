// Free-text input with a suggestion menu, replacing native <datalist> so suggestions share the Select menu style.
import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function Combobox(props: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // false right after opening: show every option; true once the user types.
  const [filtering, setFiltering] = useState(false);
  const [hi, setHi] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const q = props.value.trim().toLowerCase();
  const items = filtering && q ? props.options.filter((o) => o.toLowerCase().includes(q)) : props.options;
  const show = open && items.length > 0;

  const openMenu = () => {
    setFiltering(false);
    setHi(props.options.indexOf(props.value));
    setOpen(true);
  };
  const pick = (v: string) => {
    props.onChange(v);
    setOpen(false);
    inputRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!show || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    const h = Math.min(320, items.length * 32 + 8);
    const up = r.bottom + 4 + h > window.innerHeight - 8 && r.top - 4 - h > 8;
    setPos({ left: r.left, top: up ? r.top - 4 - h : r.bottom + 4, width: r.width });
  }, [show, items.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !wrapRef.current?.contains(t)) setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onBlur = () => setOpen(false);
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
    if (show && hi >= 0) menuRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [show, hi]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openMenu();
      const n = items.length;
      if (n) setHi((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
    } else if (e.key === "Enter" && show && hi >= 0 && items[hi] !== undefined) {
      e.preventDefault();
      pick(items[hi]);
    } else if (e.key === "Escape" && show) {
      e.preventDefault();
      e.stopPropagation(); // don't close the surrounding dialog
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className={"combo" + (show ? " open" : "")}>
      <input
        ref={inputRef}
        className="input"
        value={props.value}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        onChange={(e) => {
          props.onChange(e.target.value);
          setFiltering(true);
          setHi(-1);
          setOpen(true);
        }}
        onClick={() => !open && openMenu()}
        onKeyDown={onKey}
        aria-autocomplete="list"
        aria-expanded={show}
      />
      {props.options.length > 0 && (
        <button
          type="button"
          className="combo-toggle"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open) setOpen(false);
            else openMenu();
            inputRef.current?.focus();
          }}
        >
          <ChevronDown />
        </button>
      )}
      {show &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="select-menu"
            role="listbox"
            style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {items.map((o, i) => (
              <div
                key={o}
                data-i={i}
                role="option"
                aria-selected={o === props.value}
                className={"select-item" + (i === hi ? " hi" : "") + (o === props.value ? " on" : "")}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(o)}
              >
                <span className="grow ellipsis">{o}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
