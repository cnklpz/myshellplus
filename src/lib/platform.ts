// Platform detection: the Android build shares the desktop UI and switches layout with `isMobile`
// (also set as the `mobile` class on <html> for CSS).
import { useSyncExternalStore } from "react";

export const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Soft keyboard: the webview shrinks while it is shown. The tallest height seen per orientation is
// the keyboard-less height; anything clearly shorter means the keyboard is up.
const tallest = new Map<string, number>();
const orient = () => (window.innerWidth > window.innerHeight ? "l" : "p");
function keyboardOpen(): boolean {
  if (!isMobile) return false;
  const h = window.innerHeight;
  const key = orient();
  const max = Math.max(tallest.get(key) ?? 0, h);
  tallest.set(key, max);
  return h < max - 120;
}
let kb = keyboardOpen();
const subs = new Set<() => void>();
if (isMobile) {
  window.addEventListener("resize", () => {
    const next = keyboardOpen();
    if (next === kb) return;
    kb = next;
    subs.forEach((f) => f());
  });
}

/** True while the soft keyboard is shown (always false on desktop). */
export function useKeyboardOpen(): boolean {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => kb,
  );
}
