// GitHub release updates: tauri-plugin-updater reads latest.json from the latest release.
// State lives at module level so the startup check and the About page share one result.
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useSyncExternalStore } from "react";
import { toast } from "../components/ui";
import { errMsg } from "./api";
import { lsGet, lsSet } from "./storage";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "latest" }
  | { phase: "available"; version: string; notes: string }
  | { phase: "downloading"; version: string; pct: number | null }
  | { phase: "error"; message: string };

const AUTO_KEY = "updater.auto";
const CHECKED_KEY = "updater.checked"; // per process: the watchdog may reload the webview
const LAST_VERSION_KEY = "updater.lastVersion";

let state: UpdateState = { phase: "idle" };
let pending: Update | null = null;
let dialog = false;
const subs = new Set<() => void>();
const subscribe = (f: () => void) => (subs.add(f), () => subs.delete(f));
const emit = () => subs.forEach((f) => f());

function set(next: UpdateState) {
  state = next;
  emit();
}

/** Startup prompt with the release notes. */
export function useUpdateDialog(): boolean {
  return useSyncExternalStore(subscribe, () => dialog);
}

export function closeUpdateDialog() {
  dialog = false;
  emit();
}

export function useUpdate(): UpdateState {
  return useSyncExternalStore(subscribe, () => state);
}

export const autoCheckEnabled = () => lsGet(AUTO_KEY) !== "0";

export const setAutoCheck = (on: boolean) => lsSet(AUTO_KEY, on ? "1" : "0");

export async function checkUpdate(): Promise<UpdateState> {
  if (state.phase === "checking" || state.phase === "downloading") return state;
  set({ phase: "checking" });
  try {
    const u = await check({ timeout: 15000 });
    pending = u;
    set(u ? { phase: "available", version: u.version, notes: u.body ?? "" } : { phase: "latest" });
  } catch (e) {
    set({ phase: "error", message: errMsg(e) });
  }
  return state;
}

/** Downloads, installs and restarts. Restarting closes all SSH sessions. */
export async function installUpdate() {
  const u = pending;
  if (!u) return;
  let total = 0;
  let got = 0;
  set({ phase: "downloading", version: u.version, pct: null });
  try {
    await u.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        set({ phase: "downloading", version: u.version, pct: total ? Math.min(100, Math.round((got / total) * 100)) : null });
      }
    });
    // On Windows the installer exits the app itself; relaunch covers the other platforms.
    await relaunch();
  } catch (e) {
    set({ phase: "error", message: errMsg(e) });
  }
}

/** Once per app run: announce a just-installed version, then check quietly and
 *  open the release-notes dialog only when a new version exists. */
export function startupCheck() {
  announceUpdated();
  if (import.meta.env.DEV || !autoCheckEnabled()) return;
  try {
    if (sessionStorage.getItem(CHECKED_KEY)) return;
    sessionStorage.setItem(CHECKED_KEY, "1");
  } catch {}
  setTimeout(async () => {
    const s = await checkUpdate();
    if (s.phase === "available") {
      dialog = true;
      emit();
    } else if (s.phase === "error") {
      set({ phase: "idle" });
    }
  }, 3000);
}

async function announceUpdated() {
  try {
    const v = await getVersion();
    const prev = lsGet(LAST_VERSION_KEY);
    lsSet(LAST_VERSION_KEY, v);
    if (prev && prev !== v) toast(`已更新到 ${v}`, "success");
  } catch {}
}
