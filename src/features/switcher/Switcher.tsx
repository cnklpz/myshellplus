// The hold-to-pick terminal switcher (its own small always-on-top window, label "switcher").
// Rust shows it on the hotkey and sends "switcher-commit" when the hotkey's modifiers are released.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type SwitcherShow, type SwitcherTarget } from "../../lib/api";
import { maskAddr, maskText } from "../../lib/privacy";
import { Empty } from "../../components/ui";
import { useApp } from "../../store";
import { onTauriEvent } from "../../lib/events";
import { lsGet } from "../../lib/storage";
import { applyTheme } from "../../lib/themes";
import { readSnapshot } from "./sync";
import "./switcher.css";

interface Item {
  key: string;
  target: SwitcherTarget;
  title: string;
  meta: string;
  /** "ok" connected terminal, "off" exited terminal, "host" server without a terminal */
  kind: "ok" | "off" | "host";
}

async function loadItems(openOnly: boolean): Promise<Item[]> {
  const tabs = readSnapshot()?.tabs ?? [];
  const hosts = await api.hostList().catch(() => []);
  const mask = useApp.getState().privacy;
  const addr = (id: string) => {
    const h = hosts.find((x) => x.id === id);
    if (!h) return "";
    return `${h.username}@${mask ? maskAddr(h.host) : h.host}`;
  };
  const name = (title: string, hostId: string) => {
    const h = hosts.find((x) => x.id === hostId);
    return mask ? maskText(title, h?.host) : title;
  };
  const items: Item[] = tabs.map((t) => ({
    key: "t:" + t.id,
    target: { tabId: t.id },
    title: name(t.title, t.hostId),
    meta: addr(t.hostId),
    kind: t.alive ? "ok" : "off",
  }));
  if (!openOnly) {
    const open = new Set(tabs.map((t) => t.hostId));
    for (const h of hosts) {
      if (!open.has(h.id)) items.push({ key: "h:" + h.id, target: { hostId: h.id }, title: name(h.name, h.id), meta: addr(h.id), kind: "host" });
    }
  }
  return items;
}

export function Switcher() {
  const [items, setItems] = useState<Item[]>([]);
  const [sel, setSel] = useState(0);
  /** Sequence number of the opening whose list is rendered */
  const [rendered, setRendered] = useState(0);
  const st = useRef({ items, sel, visible: false, seq: 0 });
  st.current.items = items;
  st.current.sel = sel;
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const move = (d: number) => {
    const n = st.current.items.length;
    if (n) setSel((s) => (s + d + n) % n);
  };
  const hide = () => {
    st.current.visible = false;
    st.current.seq++;
    void api.switcherHide();
  };
  const commit = (i = st.current.sel) => {
    if (!st.current.visible) return;
    st.current.visible = false;
    const it = st.current.items[i];
    void api.switcherPick(it ? it.target : ({} as SwitcherTarget));
  };

  const open = async (p: SwitcherShow) => {
    const seq = ++st.current.seq;
    applyTheme(lsGet("theme") ?? "");
    const next = await loadItems(p.openOnly);
    if (seq !== st.current.seq) return;
    const snap = readSnapshot();
    // Like Alt+Tab: from the terminal already in front, start on the previous one.
    const skipCurrent = p.mainFocused && snap?.terminalView && next.length > 1 && next[0].key === "t:" + snap.active;
    setItems(next);
    setSel(skipCurrent ? 1 : 0);
    setRendered(seq);
  };

  // Size and show the window once the list of this opening has rendered.
  useLayoutEffect(() => {
    if (!rendered || rendered !== st.current.seq) return;
    st.current.visible = true;
    void api.switcherPresent(root.current?.offsetHeight ?? 120);
  }, [rendered]);

  useEffect(() => {
    list.current?.querySelector(".sw-row.on")?.scrollIntoView({ block: "nearest" });
  }, [sel, items]);

  useEffect(() => {
    const un = [
      onTauriEvent<SwitcherShow>("switcher-show", (e) => void open(e.payload)),
      onTauriEvent("switcher-next", () => move(1)),
      onTauriEvent("switcher-commit", () => commit()),
    ];
    let unFocus: (() => void) | null = null;
    let gone = false;
    getCurrentWindow()
      .onFocusChanged((e) => {
        if (!e.payload && st.current.visible) hide();
      })
      .then((f) => (gone ? f() : (unFocus = f)), () => {});
    // Summoned while this window was still loading.
    api.switcherPending().then((p) => p && open(p));
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "ArrowDown" || (k === "Tab" && !e.shiftKey)) move(1);
      else if (k === "ArrowUp" || (k === "Tab" && e.shiftKey)) move(-1);
      else if (k === "Home") setSel(0);
      else if (k === "End") setSel(Math.max(0, st.current.items.length - 1));
      else if (k === "Enter") commit();
      else if (k === "Escape") hide();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      gone = true;
      un.forEach((f) => f());
      unFocus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const firstHost = items.findIndex((i) => i.kind === "host");
  return (
    <div className="sw" ref={root}>
      {items.length === 0 ? (
        <Empty sm text="没有打开的终端" />
      ) : (
        <div className="sw-list" ref={list}>
          {items.map((it, i) => (
            <div key={it.key}>
              {i === firstHost && <div className="sw-sep">服务器</div>}
              <div className={"sw-row" + (i === sel ? " on" : "")} onMouseMove={() => i !== sel && setSel(i)} onClick={() => commit(i)}>
                <span className={"dot" + (it.kind === "ok" ? " ok" : it.kind === "host" ? " sw-hollow" : "")} />
                <span className="sw-title ellipsis">{it.title}</span>
                <span className="sw-meta ellipsis">{it.meta}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
