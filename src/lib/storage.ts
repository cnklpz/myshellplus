// localStorage access that never throws (private mode, quota, blocked storage).

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** Parsed JSON value, or `fallback` when missing / unparsable / null. */
export function lsGetJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return (JSON.parse(raw) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export function lsSetJson(key: string, value: unknown): void {
  lsSet(key, JSON.stringify(value));
}
