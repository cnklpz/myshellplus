// Shared drag helpers: the dashed "drop slot" box that previews where a dragged item will land,
// and FLIP sibling animation. Every sortable drag keeps the dragged element in flow at its target
// slot (so siblings make room) and translates it to follow the pointer; the slot box marks the gap.

let slot: HTMLDivElement | null = null;

/**
 * Draw the slot box over `item`'s layout box (offset*, which ignores transforms) inside its
 * offsetParent, which must be positioned. Glides between positions via CSS transition.
 */
export function showSlot(item: HTMLElement, opts: { radius?: string } = {}) {
  const parent = item.offsetParent as HTMLElement | null;
  if (!parent) return hideSlot();
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "drop-slot";
  }
  const fresh = slot.parentElement !== parent;
  if (fresh) {
    slot.style.transition = "none";
    parent.appendChild(slot);
  }
  slot.style.left = `${item.offsetLeft}px`;
  slot.style.top = `${item.offsetTop}px`;
  slot.style.width = `${item.offsetWidth}px`;
  slot.style.height = `${item.offsetHeight}px`;
  slot.style.borderRadius = opts.radius ?? getComputedStyle(item).borderRadius;
  if (fresh) {
    void slot.offsetWidth;
    slot.style.transition = "";
  }
}

export function hideSlot() {
  slot?.remove();
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Rects of `els` before a reorder, for `flip`. */
export function snapshotRects<K>(els: Map<K, HTMLElement>) {
  const m = new Map<K, DOMRect>();
  els.forEach((el, k) => m.set(k, el.getBoundingClientRect()));
  return m;
}

/** Animate every element (except `skip`) from its snapshotted rect to where it is now. */
export function flip<K>(els: Map<K, HTMLElement>, before: Map<K, DOMRect>, skip?: K, ms = 180) {
  if (reduced()) return;
  els.forEach((el, k) => {
    if (k === skip) return;
    const b = before.get(k);
    if (!b) return;
    const a = el.getBoundingClientRect();
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    if (!dx && !dy) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
      duration: ms,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
  });
}

/** Settle a released element from its drag transform back into its slot. */
export function settle(el: HTMLElement, ms = 160) {
  const from = el.style.transform;
  el.style.transform = "";
  if (from && !reduced()) el.animate([{ transform: from }, { transform: "none" }], { duration: ms, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
}

// ---------- discard ghost ----------
// When a drag leaves its area, the real item slides home and a red copy follows the pointer
// (fixed, above everything, so nothing clips it). Releasing there abandons the move.

const UNDO_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';

let ghost: HTMLDivElement | null = null;

/**
 * Show (or move) the discard ghost: a copy of `src` whose top-left sits at (x, y).
 * `wrapClass` re-creates ancestor classes the item's styles depend on (e.g. "hs-list").
 */
export function showDiscard(src: HTMLElement, x: number, y: number, wrapClass = "") {
  if (!ghost) {
    ghost = document.createElement("div");
    ghost.className = "drag-discard " + wrapClass;
    ghost.style.width = `${src.offsetWidth}px`;
    const copy = src.cloneNode(true) as HTMLElement;
    copy.style.transform = "";
    copy.style.transition = "";
    copy.classList.remove("dragging", "selected");
    copy.classList.add("drag-discard-item");
    const label = document.createElement("div");
    label.className = "drag-discard-label";
    label.innerHTML = `${UNDO_SVG}<span>放弃</span>`;
    label.style.borderRadius = getComputedStyle(src).borderRadius;
    ghost.append(copy, label);
    document.body.appendChild(ghost);
  }
  ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

export function hideDiscard() {
  ghost?.remove();
  ghost = null;
}
