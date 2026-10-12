// Larger area chart for the detail dialogs: measured width (ResizeObserver) so text and strokes
// stay crisp, y-axis labels in a fixed gutter, faint gridlines, hover crosshair with a tooltip.
import { useEffect, useId, useRef, useState } from "react";
import { pathFor } from "./Sparkline";

export interface ChartSeries {
  label: string;
  values: number[];
  /** CSS color, e.g. "var(--chart-1)" */
  color: string;
}

const GUTTER = 72; // y-label column
const TOP = 8;

/** Round up to 1/2/2.5/5 × 10^k, inside the 1024-step unit when `bytes` is set. */
function niceCeil(v: number, bytes: boolean): number {
  if (v <= 0) return 1;
  let unit = 1;
  if (bytes) while (v / unit >= 1024) unit *= 1024;
  const m = v / unit;
  const p = Math.pow(10, Math.floor(Math.log10(m)));
  const f = m / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * p * unit;
}

const hhmmss = (ms: number) => {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function AreaChart(props: {
  series: ChartSeries[];
  /** Sample timestamps (ms), aligned with the values. */
  ts?: number[];
  height?: number;
  /** Fixed scale maximum, e.g. 100 for percentages. Otherwise a rounded data max, never below `floor`. */
  max?: number;
  floor?: number;
  /** Byte-based values: round the auto scale in 1024 steps. */
  bytes?: boolean;
  slots?: number;
  fmt: (v: number) => string;
  /** Axis labels; defaults to `fmt`. */
  axisFmt?: (v: number) => string;
  /** Label for the left end of the time axis, e.g. "3 分钟". */
  span?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, "");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const h = props.height ?? 200;
  const slots = Math.max(2, props.slots ?? 60);
  const n = Math.min(slots, Math.max(0, ...props.series.map((s) => s.values.length)));
  let max = props.max ?? 0;
  if (props.max === undefined) {
    for (const s of props.series) for (const v of s.values.slice(-slots)) if (v > max) max = v;
    max = niceCeil(Math.max(max * 1.05, props.floor ?? 1), !!props.bytes);
  }
  const axis = props.axisFmt ?? props.fmt;
  const bottom = h - 1;
  const pw = Math.max(1, w - GUTTER);
  const step = pw / (slots - 1);
  const xAt = (i: number) => GUTTER + (slots - n + i) * step;
  const yAt = (v: number) => bottom - (Math.max(0, Math.min(v, max)) / max) * (bottom - TOP);
  const ticks = [0, max / 2, max];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const slot = Math.round((e.clientX - r.left - GUTTER) / step);
    const i = slot - (slots - n);
    setHover(i >= 0 && i < n ? i : null);
  };

  const hx = hover !== null ? xAt(hover) : 0;
  const flip = hx > GUTTER + pw / 2;

  return (
    <div className="mon-area">
      <div className="mon-legend">
        {props.series.map((s) => {
          const vals = s.values.slice(-slots);
          const v = hover !== null ? vals[hover - (n - vals.length)] : vals[vals.length - 1];
          return (
            <span key={s.label} className="item">
              <i style={{ background: s.color }} />
              <span className="lbl">{s.label}</span>
              <span className="val">{v === undefined ? "-" : props.fmt(v)}</span>
            </span>
          );
        })}
      </div>
      <div className="mon-area-plot" ref={ref} style={{ height: h }}>
        {w > 0 && (
          <svg width={w} height={h} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            {ticks.map((t, i) => {
              const y = Math.round(yAt(t)) + 0.5;
              return (
                <g key={i}>
                  <line x1={GUTTER} x2={w} y1={y} y2={y} style={{ stroke: "var(--line-strong)" }} strokeDasharray={i === 0 ? undefined : "2 3"} />
                  <text x={GUTTER - 8} y={y} textAnchor="end" dominantBaseline="middle" className="mon-axis">
                    {axis(t)}
                  </text>
                </g>
              );
            })}
            {props.series.map((s, si) => {
              const vals = s.values.slice(-slots);
              if (!vals.length) return null;
              const off = n - vals.length;
              const pts: [number, number][] = vals.map((v, i) => [xAt(i + off), yAt(v)]);
              const line = pathFor(pts);
              const last = pts[pts.length - 1];
              const area = `${line} L${last[0].toFixed(2)},${bottom} L${pts[0][0].toFixed(2)},${bottom} Z`;
              return (
                <g key={si}>
                  <defs>
                    <linearGradient id={`${gid}-${si}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" style={{ stopColor: s.color, stopOpacity: 0.22 }} />
                      <stop offset="1" style={{ stopColor: s.color, stopOpacity: 0 }} />
                    </linearGradient>
                  </defs>
                  <path d={area} fill={`url(#${gid}-${si})`} stroke="none" />
                  <path d={line} fill="none" style={{ stroke: s.color }} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
                </g>
              );
            })}
            {hover !== null && (
              <g pointerEvents="none">
                <line x1={hx} x2={hx} y1={TOP} y2={bottom} style={{ stroke: "var(--fg-2)" }} strokeDasharray="2 2" />
                {props.series.map((s, si) => {
                  const vals = s.values.slice(-slots);
                  const v = vals[hover - (n - vals.length)];
                  if (v === undefined) return null;
                  return <circle key={si} cx={hx} cy={yAt(v)} r={3} style={{ fill: s.color, stroke: "var(--bg-1)" }} strokeWidth={1.5} />;
                })}
              </g>
            )}
          </svg>
        )}
        {hover !== null && props.ts && props.ts.length > 0 && (
          <div className={"mon-tip" + (flip ? " flip" : "")} style={{ left: hx }}>
            {hhmmss(props.ts.slice(-slots)[hover - (n - Math.min(slots, props.ts.length))] ?? 0)}
          </div>
        )}
      </div>
      {props.span && (
        <div className="mon-area-x">
          <span>{props.span}</span>
          <span>现在</span>
        </div>
      )}
    </div>
  );
}
