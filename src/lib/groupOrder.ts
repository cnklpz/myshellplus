// User-defined order of host groups (drag the home group tabs). Per-viewer preference in localStorage.
import { useSyncExternalStore } from "react";

const KEY = "msp.groupOrder";
const listeners = new Set<() => void>();

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

let order = read();

export const getGroupOrder = () => order;

export function setGroupOrder(next: string[]) {
  order = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ordering just won't persist */
  }
  listeners.forEach((l) => l());
}

export function useGroupOrder(): string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => order,
  );
}

/** Groups in the saved order first; groups never ordered keep their incoming (default) order after them. */
export function sortByGroupOrder<T extends { name: string }>(list: T[], saved: string[]): T[] {
  const rank = new Map(saved.map((n, i) => [n, i]));
  return list
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (rank.get(a.g.name) ?? saved.length + a.i) - (rank.get(b.g.name) ?? saved.length + b.i))
    .map((x) => x.g);
}
