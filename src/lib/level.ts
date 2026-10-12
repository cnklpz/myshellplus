// Threshold -> status level / colour, shared by bars, monitor numbers and cards.

export type Level = "ok" | "warn" | "err";

/** Default thresholds for percentages. */
export const PCT_WARN = 75;
export const PCT_ERR = 90;

/** Explicit thresholds; an undefined threshold never triggers. */
export function level(v: number, warn?: number, err?: number): Level {
  if (err !== undefined && v >= err) return "err";
  if (warn !== undefined && v >= warn) return "warn";
  return "ok";
}

/** Status colour for a value, undefined when it is fine (keeps the normal text colour). */
export function levelColor(v: number, warn?: number, err?: number): string | undefined {
  const l = level(v, warn, err);
  return l === "ok" ? undefined : `var(--${l})`;
}

/** Percentage colour with the default 75 / 90 thresholds. */
export const pctColor = (p: number) => levelColor(p, PCT_WARN, PCT_ERR);
