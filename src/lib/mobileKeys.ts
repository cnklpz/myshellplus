// Latched Ctrl / Alt of the mobile key row: the next key typed on the soft keyboard gets the modifier.
import { useSyncExternalStore } from "react";

export interface Mods {
  ctrl: boolean;
  alt: boolean;
}

let mods: Mods = { ctrl: false, alt: false };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function useMods(): Mods {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => mods,
  );
}

export function toggleMod(m: keyof Mods) {
  mods = { ...mods, [m]: !mods[m] };
  emit();
}

/** Apply and clear the latched modifiers to terminal input `data`. */
export function applyMods(data: string): string {
  if (!mods.ctrl && !mods.alt) return data;
  let out = data;
  if (mods.ctrl && data.length === 1) {
    const c = data.toLowerCase().charCodeAt(0);
    // a-z → 0x01-0x1a; @ [ \ ] ^ _ → 0x00, 0x1b-0x1f; space → NUL; ? → DEL
    if (c >= 0x61 && c <= 0x7a) out = String.fromCharCode(c - 0x60);
    else if (c >= 0x40 && c <= 0x5f) out = String.fromCharCode(c - 0x40);
    else if (data === " ") out = "\x00";
    else if (data === "?") out = "\x7f";
  }
  if (mods.alt) out = "\x1b" + out;
  mods = { ctrl: false, alt: false };
  emit();
  return out;
}
