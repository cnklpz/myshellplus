// Privacy mode: hide the middle of host addresses (and of host names that are addresses) on screen.
import { hostChain, useApp } from "../store";

const IPV4 = /\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.(\d{1,3})\b/g;

/** "192.168.1.10" -> "192.*.*.10"; "host:22" keeps the port; other addresses keep a few chars at each end. */
export function maskAddr(addr: string): string {
  const a = addr.trim();
  if (!a) return a;
  // host:port / [v6]:port -> mask the host only.
  const hp = /^\[(.+)\]:(\d{1,5})$/.exec(a) ?? /^([^:]+):(\d{1,5})$/.exec(a);
  if (hp) return `${maskAddr(hp[1])}:${hp[2]}`;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return a.replace(IPV4, "$1.*.*.$2");
  if (a.includes(":")) {
    const parts = a.split(":").filter(Boolean);
    return parts.length > 2 ? `${parts[0]}:*:${parts[parts.length - 1]}` : "*:*";
  }
  const keep = Math.max(1, Math.floor(a.length / 4));
  return a.length <= 3 ? "*".repeat(a.length) : a.slice(0, keep) + "***" + a.slice(-keep);
}

/** Mask a display text: the given addresses (a host's own, its jump hosts', its proxy) and any IPv4 inside it. */
export function maskText(text: string, addr?: string | (string | null | undefined)[]): string {
  let t = text;
  const list = (Array.isArray(addr) ? addr : [addr]).map((a) => (a ?? "").trim()).filter(Boolean);
  // Longest first, so "db.example.com" is masked before "example.com".
  for (const a of list.sort((x, y) => y.length - x.length)) if (t.includes(a)) t = t.split(a).join(maskAddr(a));
  return t.replace(IPV4, "$1.*.*.$2");
}

/** True when the name already shows the address (so it need not be shown twice). */
export function nameIsAddr(name: string, addr: string): boolean {
  const n = name.trim().replace(/ \(\d+\)$/, "");
  return !!addr.trim() && n === addr.trim();
}

/** Every address a connection to `hostId` touches: the host, its jump hosts and their proxies. */
export function chainAddrs(hostId: string): string[] {
  const hosts = useApp.getState().hosts;
  const out: string[] = [];
  for (const id of hostChain(hostId, hosts)) {
    const h = hosts.find((x) => x.id === id);
    if (!h) continue;
    out.push(h.host);
    if (h.proxyHost) out.push(h.proxyHost);
  }
  return out;
}

/** Reactive helpers bound to the current privacy flag. */
export function usePrivacy() {
  const on = useApp((s) => s.privacy);
  return {
    on,
    addr: (a: string) => (on ? maskAddr(a) : a),
    text: (t: string, addr?: string | (string | null | undefined)[]) => (on ? maskText(t, addr) : t),
    /** Text about a connection to `hostId` (errors, logs, AI output). */
    hostText: (t: string, hostId: string) => (on ? maskText(t, chainAddrs(hostId)) : t),
  };
}
