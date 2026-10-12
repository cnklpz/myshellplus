// Tauri event listening with a synchronous unsubscribe: `listen()` resolves later, so an effect that is
// cleaned up before it resolves must still unlisten once it does.
import { type Event, type EventCallback, listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

/** Subscribe now; the returned function may be called at any time, even before `listen` resolves. */
export function onTauriEvent<T>(name: string, handler: EventCallback<T>): () => void {
  let done = false;
  let un: (() => void) | null = null;
  listen<T>(name, handler).then(
    (f) => {
      if (done) f();
      else un = f;
    },
    () => {},
  );
  return () => {
    done = true;
    un?.();
    un = null;
  };
}

/** Listen for the lifetime of the component; the latest `handler` is always called. */
export function useTauriEvent<T>(name: string, handler: (e: Event<T>) => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    return onTauriEvent<T>(name, (e) => ref.current(e));
  }, [name, enabled]);
}
