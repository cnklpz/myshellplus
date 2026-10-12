// Floating right-click menu. Keyboard is captured at window level while open, so the terminal keeps focus.
import { type MouseEvent as ReactMouseEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
  /** Destructive action: shown in the error colour. */
  danger?: boolean;
  onSelect: () => void;
}
export type MenuItem = MenuAction | "sep" | false | null | undefined;

const EDGE = 4;

/** Drop falsy items and leading / trailing / doubled separators. */
function normalize(items: MenuItem[]): (MenuAction | "sep")[] {
  const out: (MenuAction | "sep")[] = [];
  for (const it of items) {
    if (!it) continue;
    if (it === "sep" && (out.length === 0 || out[out.length - 1] === "sep")) continue;
    out.push(it);
  }
  while (out[out.length - 1] === "sep") out.pop();
  return out;
}

export function ContextMenu(props: {
  x: number;
  y: number;
  items: MenuItem[];
  /** `refocus` is true when the menu was dismissed from the keyboard (Esc). */
  onClose: (refocus: boolean) => void;
}) {
  const items = normalize(props.items);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y, ready: false });
  const [active, setActive] = useState(-1);

  const live = useRef({ items, active, onClose: props.onClose });
  live.current = { items, active, onClose: props.onClose };

  // Keep inside the viewport: flip to the other side of the cursor when there is no room.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = props.x;
    let top = props.y;
    if (left + w > vw - EDGE) left = Math.max(EDGE, left - w);
    if (top + h > vh - EDGE) top = Math.max(EDGE, Math.min(top - h, vh - EDGE - h));
    setPos({ left, top, ready: true });
  }, [props.x, props.y]);

  useEffect(() => {
    const close = () => live.current.onClose(false);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const step = (from: number, d: number) => {
      const its = live.current.items;
      for (let n = 1; n <= its.length; n++) {
        const i = (from + d * n + its.length * 2) % its.length;
        const it = its[i];
        if (it !== "sep" && !it.disabled) return i;
      }
      return from;
    };
    const onKey = (e: KeyboardEvent) => {
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const { items: its, active: a } = live.current;
      const k = e.key;
      if (k === "Escape" || k === "Tab") live.current.onClose(true);
      else if (k === "ArrowDown") setActive(step(a < 0 ? -1 : a, 1));
      else if (k === "ArrowUp") setActive(step(a < 0 ? its.length : a, -1));
      else if (k === "Enter" && a >= 0) {
        const it = its[a];
        if (it && it !== "sep" && !it.disabled) {
          live.current.onClose(false);
          it.onSelect();
        }
      } else {
        // Any other key goes to the terminal as usual and dismisses the menu.
        close();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, []);

  // Portal: a transformed ancestor (dialog animation) would otherwise offset `position: fixed`.
  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
      // Portaled, but React events still bubble to the owner: keep them from reaching row / drag handlers.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onMouseLeave={() => setActive(-1)}
    >
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={"ctx-item" + (i === active ? " active" : "") + (it.danger ? " danger" : "")}
            disabled={it.disabled}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(it.disabled ? -1 : i)}
            onClick={() => {
              props.onClose(false);
              it.onSelect();
            }}
          >
            <span className="ctx-icon">{it.icon}</span>
            <span className="ellipsis">{it.label}</span>
            <span className="ctx-hint">{it.hint}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Row-level right-click menu: `open(e, items)` from onContextMenu, render `node` anywhere. */
export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = useCallback((e: ReactMouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);
  const node = menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />;
  return { open, node };
}
