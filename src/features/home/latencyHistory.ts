// Per-host ring buffer of recent latency samples, fed by store.latency changes.
// Module level so history survives page switches.
import { useSyncExternalStore } from "react";
import { useApp } from "../../store";

const HISTORY_LEN = 20;
const EMPTY: readonly (number | null)[] = [];

const buffers = new Map<string, readonly (number | null)[]>();
const listeners = new Set<() => void>();

useApp.subscribe((s, prev) => {
  if (s.latency === prev.latency) return;
  let changed = false;
  for (const [id, ms] of Object.entries(s.latency)) {
    // An identical repeated value is indistinguishable from "no new sample"; skip it.
    if (id in prev.latency && prev.latency[id] === ms) continue;
    const old = buffers.get(id) ?? EMPTY;
    buffers.set(id, [...old.slice(-(HISTORY_LEN - 1)), ms]);
    changed = true;
  }
  if (changed) listeners.forEach((l) => l());
});

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Recent samples for one host, oldest first (null = timeout). */
export function useLatencyHistory(hostId: string) {
  return useSyncExternalStore(subscribe, () => buffers.get(hostId) ?? EMPTY);
}
