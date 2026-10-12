// Privacy mode: hide the middle of host addresses (and of host names that are addresses) on screen.
import { useApp } from "../store";

const IPV4 = /\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.(\d{1,3})\b/g;

/** "192.168.1.10" -> "192.*.*.10"; other addresses keep a few chars at each end. */
export function maskAddr(addr: string): string {
  const a = addr.trim();
  if (!a) return a;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return a.replace(IPV4, "$1.*.*.$2");
  if (a.includes(":")) {
    const parts = a.split(":").filter(Boolean);
    return parts.length > 2 ? `${parts[0]}:*:${parts[parts.length - 1]}` : "*:*";
  }
  const keep = Math.max(1, Math.floor(a.length / 4));
  return a.length <= 3 ? "*".repeat(a.length) : a.slice(0, keep) + "***" + a.slice(-keep);
}

/** Mask a display text: the host's own address and any IPv4 inside it. */
export function maskText(text: string, addr?: string): string {
  let t = text;
  if (addr && addr.trim() && t.includes(addr.trim())) t = t.split(addr.trim()).join(maskAddr(addr));
  return t.replace(IPV4, "$1.*.*.$2");
}

/** True when the name already shows the address (so it need not be shown twice). */
export function nameIsAddr(name: string, addr: string): boolean {
  const n = name.trim().replace(/ \(\d+\)$/, "");
  return !!addr.trim() && n === addr.trim();
}

/** Reactive helpers bound to the current privacy flag. */
export function usePrivacy() {
  const on = useApp((s) => s.privacy);
  return {
    on,
    addr: (a: string) => (on ? maskAddr(a) : a),
    text: (t: string, addr?: string) => (on ? maskText(t, addr) : t),
  };
}
