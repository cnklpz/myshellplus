// Live data for the overview: monitor samples for many hosts, and a bulk connect queue.
import { onTauriEvent } from "../../lib/events";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, type Sample, type SysInfo } from "../../lib/api";
import { useApp } from "../../store";

const KEEP = 40;

export interface HostLive {
  history: Sample[];
  info: SysInfo | null;
  error: string | null;
}

interface MonitorEvent {
  hostId: string;
  sample?: Sample;
  info?: SysInfo | null;
  error?: string;
}

/**
 * Subscribe to the monitor of every host in `ids`. Pass connected hosts only: the backend does not connect
 * for a monitor and stops it on disconnect, so a host that reconnects re-enters the list and is subscribed
 * again. Renders are batched to one per animation frame.
 */
export function useMonitors(ids: string[]): Record<string, HostLive> {
  const data = useRef<Record<string, HostLive>>({});
  const [, setTick] = useState(0);
  const frame = useRef(0);
  const bump = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setTick((t) => t + 1);
    });
  };

  // One event listener for all hosts.
  useEffect(() => {
    const un = onTauriEvent<MonitorEvent>("monitor", (e) => {
      const p = e.payload;
      const cur = data.current[p.hostId];
      if (!cur) return;
      let history = cur.history;
      if (p.sample && !(history.length && history[history.length - 1].ts >= p.sample.ts)) {
        history = [...history.slice(-(KEEP - 1)), p.sample];
      }
      data.current = {
        ...data.current,
        [p.hostId]: { history, info: p.info ?? cur.info, error: p.error ?? (p.sample ? null : cur.error) },
      };
      bump();
    });
    return () => {
      un();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);

  // Subscribe each host while it is in the list (diffed, so other hosts keep their history).
  const subscribed = useRef(new Set<string>());
  const key = [...ids].sort().join(",");
  useEffect(() => {
    const want = new Set(key ? key.split(",") : []);
    for (const id of subscribed.current) {
      if (want.has(id)) continue;
      subscribed.current.delete(id);
      api.monitorUnsubscribe(id).catch(() => {});
      const { [id]: _, ...rest } = data.current;
      data.current = rest;
    }
    for (const id of want) {
      if (subscribed.current.has(id)) continue;
      subscribed.current.add(id);
      data.current = { ...data.current, [id]: { history: [], info: null, error: null } };
      api
        .monitorSubscribe(id)
        .then((snap) => {
          const cur = data.current[id];
          if (!cur) return;
          const last = snap.history.length ? snap.history[snap.history.length - 1].ts : 0;
          data.current = {
            ...data.current,
            [id]: {
              history: [...snap.history, ...cur.history.filter((s) => s.ts > last)].slice(-KEEP),
              info: snap.info ?? cur.info,
              error: snap.error ?? cur.error,
            },
          };
          bump();
        })
        .catch(() => {});
    }
    bump();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      for (const id of subscribed.current) api.monitorUnsubscribe(id).catch(() => {});
      subscribed.current.clear();
      data.current = {};
    },
    [],
  );

  return data.current;
}

// ---------- bulk connect ----------

const CONCURRENCY = 6;

export interface BulkState {
  total: number;
  done: number;
  failed: number;
}

let bulk: BulkState | null = null;
const queue: string[] = [];
const bulkListeners = new Set<() => void>();
const emit = () => bulkListeners.forEach((l) => l());
let workers = 0;
let doneCb: ((s: BulkState) => void) | null = null;

export function useBulkConnect(): BulkState | null {
  return useSyncExternalStore(
    (l) => {
      bulkListeners.add(l);
      return () => {
        bulkListeners.delete(l);
      };
    },
    () => bulk,
  );
}

/**
 * Connect hosts in the background. Already connected / connecting hosts are skipped and
 * failures are only counted (the per-host error shows on its tile).
 */
export function connectHosts(ids: string[], onDone?: (s: BulkState) => void) {
  const { conn } = useApp.getState();
  const todo = ids.filter((id) => {
    const st = conn[id]?.state;
    return st !== "connected" && st !== "connecting" && !queue.includes(id);
  });
  if (!todo.length) return 0;
  queue.push(...todo);
  bulk = { total: (bulk?.total ?? 0) + todo.length, done: bulk?.done ?? 0, failed: bulk?.failed ?? 0 };
  emit();
  const work = async () => {
    workers++;
    while (queue.length) {
      const id = queue.shift()!;
      let ok = true;
      try {
        await api.connConnect(id);
      } catch {
        ok = false;
      }
      bulk = { ...bulk!, done: bulk!.done + 1, failed: bulk!.failed + (ok ? 0 : 1) };
      emit();
    }
    workers--;
    if (workers === 0 && bulk) {
      const final = bulk;
      bulk = null;
      emit();
      const cb = doneCb;
      doneCb = null;
      cb?.(final);
    }
  };
  if (onDone) doneCb = onDone;
  const spawn = Math.min(CONCURRENCY - workers, todo.length);
  for (let i = 0; i < spawn; i++) void work();
  return todo.length;
}

/** Ids queued for a bulk connect that has not started yet. */
export const isQueued = (id: string) => queue.includes(id);
