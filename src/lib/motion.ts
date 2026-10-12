// Small animation helpers. Everything here writes to the DOM from requestAnimationFrame,
// so a tween never re-renders React components per frame.
import { useEffect, useLayoutEffect, useRef } from "react";

export const reducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** Duration of value/chart tweens (ms). */
export const TWEEN_MS = 450;

/**
 * Animates the text of the returned span between successive `value`s.
 * Usage: `const ref = useTweenText(value, fmt); <span ref={ref} />` — React never owns the text.
 */
export function useTweenText<E extends HTMLElement>(value: number, fmt: (v: number) => string) {
  const ref = useRef<E>(null);
  const st = useRef({ shown: value, raf: 0 });
  const fmtRef = useRef(fmt);
  fmtRef.current = fmt;

  useLayoutEffect(() => {
    const el = ref.current;
    const s = st.current;
    cancelAnimationFrame(s.raf);
    const from = s.shown;
    const to = value;
    if (!el) return;
    if (from === to || !Number.isFinite(from) || !Number.isFinite(to) || reducedMotion()) {
      s.shown = to;
      el.textContent = fmtRef.current(to);
      return;
    }
    const t0 = performance.now();
    const frame = (now: number) => {
      const p = Math.min(1, (now - t0) / TWEEN_MS);
      s.shown = p < 1 ? from + (to - from) * easeOut(p) : to;
      el.textContent = fmtRef.current(s.shown);
      if (p < 1) s.raf = requestAnimationFrame(frame);
    };
    s.raf = requestAnimationFrame(frame);
  }, [value]);

  useEffect(() => () => cancelAnimationFrame(st.current.raf), []);
  return ref;
}

export type Pt = [number, number];

/**
 * How `next` follows from `prev`: `d` oldest samples dropped, `k` new ones appended.
 * Null when the data isn't a simple shift (new host, reset) — then the chart just snaps.
 */
function shiftOf(prev: number[][], next: number[][]): { d: number; k: number } | null {
  if (!prev.length || prev.length !== next.length) return null;
  const P = prev[0].length;
  const N = next[0].length;
  if (prev.some((s) => s.length !== P) || next.some((s) => s.length !== N)) return null;
  for (let k = 0; k <= 4; k++) {
    const m = N - k;
    const d = P - m;
    if (m < 1 || d < 0) continue;
    let ok = true;
    for (let s = 0; s < prev.length && ok; s++) {
      for (let i = 0; i < m; i++) {
        if (prev[s][d + i] !== next[s][i]) {
          ok = false;
          break;
        }
      }
    }
    if (ok) return { d, k };
  }
  return null;
}

const samePts = (a: Pt[][], b: Pt[][]) =>
  a.length === b.length && a.every((s, i) => s.length === b[i].length && s.every((p, j) => p[0] === b[i][j][0] && p[1] === b[i][j][1]));

/**
 * Smoothly moves chart geometry between data updates. `vals`/`pts` are per series (same length).
 * React renders the final paths; this effect draws the in-between frames through `apply`
 * (which should set `d` attributes directly). Retained samples slide to their new x, new samples
 * enter from the right edge and dropped ones slide out to the left (clip the plot area).
 */
export function useChartTween(vals: number[][], pts: Pt[][], apply: (pts: Pt[][]) => void) {
  const st = useRef<{ vals: number[][]; target: Pt[][]; shown: Pt[][]; raf: number } | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useLayoutEffect(() => {
    const prev = st.current;
    if (prev && samePts(prev.target, pts)) return; // unrelated re-render (hover): keep animating
    const wasRunning = !!prev?.raf;
    if (prev?.raf) cancelAnimationFrame(prev.raf);
    const cur = { vals, target: pts, shown: pts, raf: 0 };
    st.current = cur;
    const snap = () => {
      if (wasRunning) applyRef.current(pts);
    };
    if (!prev || reducedMotion()) return snap();
    const sh = shiftOf(prev.vals, vals);
    if (!sh || (sh.d === 0 && sh.k === 0)) return snap();
    const { d, k } = sh;
    const from: Pt[][] = [];
    const to: Pt[][] = [];
    for (let s = 0; s < pts.length; s++) {
      const old = prev.shown[s];
      const nw = pts[s];
      if (!old || old.length !== prev.vals[s].length || !old.length) return snap();
      const m = nw.length - k;
      const dx = nw[0][0] - old[d][0];
      const last = old[old.length - 1];
      const step = old.length > 1 ? last[0] - old[old.length - 2][0] : 0;
      const f: Pt[] = [];
      const t: Pt[] = [];
      for (let i = 0; i < d; i++) {
        f.push(old[i]);
        t.push([old[i][0] + dx, old[i][1]]);
      }
      for (let i = 0; i < m; i++) {
        f.push(old[d + i]);
        t.push(nw[i]);
      }
      for (let i = 0; i < k; i++) {
        f.push([last[0] + step * (i + 1), last[1]]);
        t.push(nw[m + i]);
      }
      from.push(f);
      to.push(t);
    }
    cur.shown = from.map((s) => s.slice(d));
    applyRef.current(from);
    const t0 = performance.now();
    const frame = (now: number) => {
      const p = Math.min(1, (now - t0) / TWEEN_MS);
      if (p >= 1) {
        cur.raf = 0;
        cur.shown = pts;
        applyRef.current(pts);
        return;
      }
      const e = easeOut(p);
      const mix = from.map((f, s) => f.map((a, i): Pt => [a[0] + (to[s][i][0] - a[0]) * e, a[1] + (to[s][i][1] - a[1]) * e]));
      cur.shown = mix.map((s) => s.slice(d));
      applyRef.current(mix);
      cur.raf = requestAnimationFrame(frame);
    };
    cur.raf = requestAnimationFrame(frame);
  });

  useEffect(() => () => {
    if (st.current?.raf) cancelAnimationFrame(st.current.raf);
  }, []);
}
