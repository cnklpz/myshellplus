// Home group filter tabs, reorderable by dragging. Same drag model as the sidebar: window mouse listeners,
// a 4px threshold, the dragged tab follows the cursor via a direct DOM transform (no React render per move),
// and React only re-renders when the insertion index changes. Siblings slide into place (FLIP).
import { ArrowLeft, ArrowRight, Gauge, SquareMousePointer } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { toast } from "../../components/ui";
import { useContextMenu } from "../terminal/ContextMenu";
import { hideSlot, showSlot } from "../../lib/dragSlot";
import { getGroupOrder, setGroupOrder } from "../../lib/groupOrder";

export interface GroupTab {
  name: string;
  count: number;
}

export function GroupTabs(props: {
  allCount: number;
  tabs: GroupTab[];
  active: string;
  onSelect: (name: string) => void;
  /** Latency test for a group ("" = every host). */
  onProbe?: (name: string) => void;
}) {
  const menu = useContextMenu();
  const [order, setOrder] = useState<string[] | null>(null); // live order while dragging
  const [dragging, setDragging] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const suppressClick = useRef(false);

  const byName = new Map(props.tabs.map((t) => [t.name, t]));
  const names = order ?? props.tabs.map((t) => t.name);

  // FLIP: animate siblings from their previous position to the new one after each reorder.
  useLayoutEffect(() => {
    const prev = prevRects.current;
    for (const [name, el] of refs.current) {
      const before = prev.get(name);
      if (!before || name === dragging) continue;
      const after = el.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (!dx && !dy) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160,
        easing: "cubic-bezier(.2,.7,.3,1)",
      });
    }
    prevRects.current = new Map();
  }, [JSON.stringify(names)]); // eslint-disable-line react-hooks/exhaustive-deps

  const snapshot = () => {
    const m = new Map<string, DOMRect>();
    for (const [name, el] of refs.current) m.set(name, el.getBoundingClientRect());
    prevRects.current = m;
  };

  const startDrag = (e: React.MouseEvent<HTMLButtonElement>, name: string) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    let px = sx;
    let py = sy;
    let frame = 0;
    let live = props.tabs.map((t) => t.name);
    // Layout offsets (offsetLeft/Top) ignore transforms, so sliding siblings can't make the target flicker.
    const box = el.parentElement!;
    const ox = el.offsetLeft;
    const oy = el.offsetTop;

    const place = () => {
      el.style.transform = `translate3d(${px - sx + ox - el.offsetLeft}px, ${py - sy + oy - el.offsetTop}px, 0)`;
      showSlot(el);
    };
    const hitTest = () => {
      const r = box.getBoundingClientRect();
      const cx = px - r.left;
      const cy = py - r.top;
      // Insert before the first other tab whose center is past the cursor (row-aware for wrapped tabs).
      const others = live.filter((n) => n !== name);
      let idx = others.length;
      for (let i = 0; i < others.length; i++) {
        const t = refs.current.get(others[i]);
        if (!t) continue;
        const sameRow = cy >= t.offsetTop && cy <= t.offsetTop + t.offsetHeight;
        if ((sameRow && cx < t.offsetLeft + t.offsetWidth / 2) || cy < t.offsetTop) {
          idx = i;
          break;
        }
      }
      const next = [...others.slice(0, idx), name, ...others.slice(idx)];
      if (JSON.stringify(next) !== JSON.stringify(live)) {
        live = next;
        snapshot();
        setOrder(next);
        requestAnimationFrame(place); // the slot moved: keep the tab glued to the cursor
      }
    };
    const move = (ev: MouseEvent) => {
      px = ev.clientX;
      py = ev.clientY;
      if (!active) {
        if (Math.abs(px - sx) + Math.abs(py - sy) < 4) return;
        active = true;
        document.body.classList.add("home-tab-dragging");
        window.getSelection()?.removeAllRanges();
        setDragging(name);
        setOrder(live);
      }
      ev.preventDefault();
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
        hitTest();
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      cancelAnimationFrame(frame);
      document.body.classList.remove("home-tab-dragging");
      if (!active) return;
      hideSlot();
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false));
      // Settle the dragged tab into its slot.
      const from = el.style.transform;
      el.style.transform = "";
      if (from) el.animate([{ transform: from }, { transform: "none" }], { duration: 140, easing: "ease-out" });
      setDragging(null);
      setOrder(null);
      const initial = props.tabs.map((t) => t.name);
      if (JSON.stringify(live) === JSON.stringify(initial)) return;
      const saved = getGroupOrder();
      setGroupOrder(live);
      toast("已调整分组顺序", "success", { label: "撤回", run: () => setGroupOrder(saved) });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** Same result as dragging the tab one place left / right. */
  const shift = (name: string, d: -1 | 1) => {
    const cur = props.tabs.map((t) => t.name);
    const i = cur.indexOf(name);
    const j = i + d;
    if (i < 0 || j < 0 || j >= cur.length) return;
    [cur[i], cur[j]] = [cur[j], cur[i]];
    const saved = getGroupOrder();
    setGroupOrder(cur);
    toast("已调整分组顺序", "success", { label: "撤回", run: () => setGroupOrder(saved) });
  };
  const openMenu = (e: React.MouseEvent, name: string) => {
    const i = props.tabs.findIndex((t) => t.name === name);
    menu.open(e, [
      { label: "查看", icon: <SquareMousePointer />, disabled: props.active === name, onSelect: () => props.onSelect(name) },
      props.onProbe && { label: name ? "本组测速" : "全部测速", icon: <Gauge />, onSelect: () => props.onProbe?.(name) },
      name !== "" && "sep",
      name !== "" && { label: "左移", icon: <ArrowLeft />, disabled: i <= 0, onSelect: () => shift(name, -1) },
      name !== "" && { label: "右移", icon: <ArrowRight />, disabled: i >= props.tabs.length - 1, onSelect: () => shift(name, 1) },
    ]);
  };

  return (
    <div className="home-tabs" role="tablist">
      <button
        role="tab"
        aria-selected={props.active === ""}
        className={"home-tab" + (props.active === "" ? " on" : "")}
        onClick={() => props.onSelect("")}
        onContextMenu={(e) => openMenu(e, "")}
      >
        <span className="ellipsis">全部</span>
        <span className="home-tab-count">{props.allCount}</span>
      </button>
      {names.map((n) => {
        const t = byName.get(n);
        if (!t) return null;
        return (
          <button
            key={n}
            ref={(el) => {
              if (el) refs.current.set(n, el);
              else refs.current.delete(n);
            }}
            role="tab"
            aria-selected={n === props.active}
            className={"home-tab" + (n === props.active ? " on" : "") + (dragging === n ? " dragging" : "")}
            onMouseDown={(e) => startDrag(e, n)}
            onClick={() => !suppressClick.current && props.onSelect(n)}
            onContextMenu={(e) => openMenu(e, n)}
          >
            <span className="ellipsis">{n}</span>
            <span className="home-tab-count">{t.count}</span>
          </button>
        );
      })}
      {menu.node}
    </div>
  );
}
