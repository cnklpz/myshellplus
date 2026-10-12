// Tiny inline-SVG sparkline. Responsive width (viewBox + preserveAspectRatio="none"),
// smooth curve, low-opacity area fill. Supports several series sharing one scale.
import { useId } from "react";

export interface SparkSeries {
  values: number[];
  /** CSS color, e.g. "var(--chart-1)" */
  color: string;
}

const W = 100;

/** Midpoint-quadratic smoothing: passes near every point, never overshoots much. */
function pathFor(pts: [number, number][]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const mx = (x + pts[i + 1][0]) / 2;
    const my = (y + pts[i + 1][1]) / 2;
    d += ` Q${x.toFixed(2)},${y.toFixed(2)} ${mx.toFixed(2)},${my.toFixed(2)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last[0].toFixed(2)},${last[1].toFixed(2)}`;
  return d;
}

export function Sparkline(props: {
  series: SparkSeries[];
  height?: number;
  /** Fixed maximum (e.g. 100 for percentages). Otherwise auto from data, never below `floor`. */
  max?: number;
  floor?: number;
  /** Number of slots on the x axis; data is right-aligned so the chart fills from the right. */
  slots?: number;
  fill?: boolean;
}) {
  const h = props.height ?? 32;
  const slots = Math.max(2, props.slots ?? 60);
  const gid = useId().replace(/:/g, "");
  let max = props.max ?? 0;
  if (props.max === undefined) {
    for (const s of props.series) for (const v of s.values) if (v > max) max = v;
    max = Math.max(max * 1.15, props.floor ?? 1);
  }
  const pad = 1.5; // keep the stroke inside the box
  const step = W / (slots - 1);
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" style={{ height: h }} aria-hidden>
      {props.series.map((s, si) => {
        const vals = s.values.slice(-slots);
        if (vals.length === 0) return null;
        const x0 = W - (vals.length - 1) * step;
        const pts: [number, number][] = vals.map((v, i) => [
          x0 + i * step,
          h - pad - (Math.max(0, Math.min(v, max)) / max) * (h - pad * 2),
        ]);
        const line = pathFor(pts);
        const area = `${line} L${pts[pts.length - 1][0].toFixed(2)},${h} L${pts[0][0].toFixed(2)},${h} Z`;
        return (
          <g key={si}>
            {props.fill !== false && (
              <>
                <defs>
                  <linearGradient id={`${gid}-${si}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" style={{ stopColor: s.color, stopOpacity: 0.24 }} />
                    <stop offset="1" style={{ stopColor: s.color, stopOpacity: 0 }} />
                  </linearGradient>
                </defs>
                <path d={area} fill={`url(#${gid}-${si})`} stroke="none" />
              </>
            )}
            <path d={line} fill="none" style={{ stroke: s.color }} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          </g>
        );
      })}
    </svg>
  );
}
