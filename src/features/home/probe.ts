// Manual latency tests (card menu / "全部测速"). Module level so results survive page switches.
import { useSyncExternalStore } from "react";
import { toast } from "../../components/ui";
import { api, errMsg, type Probe } from "../../lib/api";

export interface ProbeState {
  busy: boolean;
  result?: Probe;
}

const states = new Map<string, ProbeState>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useProbe(hostId: string): ProbeState | undefined {
  return useSyncExternalStore(subscribe, () => states.get(hostId));
}

let running = 0;
const runningListeners = new Set<() => void>();
export function useProbing() {
  return useSyncExternalStore(
    (l) => {
      runningListeners.add(l);
      return () => {
        runningListeners.delete(l);
      };
    },
    () => running > 0,
  );
}

export async function probeHosts(ids: string[]) {
  ids = ids.filter((id) => !states.get(id)?.busy);
  if (!ids.length) return;
  for (const id of ids) states.set(id, { ...states.get(id), busy: true });
  running++;
  runningListeners.forEach((l) => l());
  emit();
  try {
    const list = await api.hostProbe(ids);
    for (const p of list) states.set(p.hostId, { busy: false, result: p });
  } catch (e) {
    toast(errMsg(e), "error");
  } finally {
    for (const id of ids) if (states.get(id)?.busy) states.set(id, { ...states.get(id), busy: false });
    running--;
    runningListeners.forEach((l) => l());
    emit();
  }
}
