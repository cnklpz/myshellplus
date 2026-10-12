// Global search (Ctrl+P): servers, open terminals, saved commands, command history and app actions.
import {
  Bot, Clock, Download, House, Layers, Network, Palette, Plus, ScrollText, Search, Server, Settings, SquareTerminal,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openTerminal } from "../features/terminal/open";
import { api, type HistoryHit, type Snippet } from "../lib/api";
import { termBus } from "../lib/termBus";
import { applyTheme, THEMES } from "../lib/themes";
import { useApp } from "../store";
import { toast } from "./ui";

interface Item {
  key: string;
  group: string;
  icon: ReactNode;
  title: string;
  sub?: string;
  /** Enter */
  run: () => void;
  /** Ctrl+Enter (falls back to run) */
  alt?: () => void;
}

const norm = (s: string) => s.toLowerCase();

function score(hay: string, q: string): number {
  const h = norm(hay);
  if (!q) return 1;
  if (h.startsWith(q)) return 3;
  if (h.includes(q)) return 2;
  // all query chars in order
  let i = 0;
  for (const c of h) if (c === q[i]) i++;
  return i === q.length ? 1 : 0;
}

function sendToTerminal(text: string, run: boolean) {
  const t = termBus.active();
  if (!t) {
    toast("请先打开终端", "error");
    return;
  }
  useApp.getState().setView("terminal");
  if (run) t.run(text);
  else t.paste(text);
  t.focus();
}

export function GlobalSearch(props: { value: string; onChange: (v: string) => void }) {
  const hosts = useApp((s) => s.hosts);
  const tabs = useApp((s) => s.tabs);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [history, setHistory] = useState<HistoryHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const q = norm(props.value.trim());

  // Ctrl+P / Ctrl+Shift+F focus (capture phase so the terminal doesn't eat it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.ctrlKey && !e.altKey && ((k === "p" && !e.shiftKey) || (k === "f" && e.shiftKey))) {
        e.preventDefault();
        e.stopPropagation();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Fresh commands when opened; history follows the query.
  useEffect(() => {
    if (open) api.snippetList().then(setSnippets).catch(() => {});
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api.historyList("", props.value.trim(), 8).then(setHistory).catch(() => setHistory([]));
    }, 120);
    return () => clearTimeout(t);
  }, [open, props.value]);

  useEffect(() => {
    if (!open) return;
    const place = () => inputRef.current && setRect(inputRef.current.getBoundingClientRect());
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !inputRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    inputRef.current?.blur();
  };

  const items = useMemo<Item[]>(() => {
    const s = useApp.getState();
    const out: Item[] = [];
    const add = (list: (Item & { s: number })[], max: number) =>
      out.push(...list.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, max));

    add(
      hosts.map((h) => ({
        key: "h:" + h.id,
        group: "服务器",
        icon: <Server />,
        title: h.name,
        sub: `${h.username}@${h.host}${h.port !== 22 ? ":" + h.port : ""}`,
        s: Math.max(score(h.name, q), score(h.host, q), score(h.tags.join(" "), q), score(h.groupName, q) && 1, score(h.notes, q) && 1),
        run: () => openTerminal(h.id),
        alt: () => s.openEditor(h.id),
      })),
      q ? 6 : 4,
    );
    add(
      tabs.map((t) => ({
        key: "t:" + t.id,
        group: "终端",
        icon: <SquareTerminal />,
        title: t.title,
        sub: t.alive ? "已打开" : "已断开",
        s: score(t.title, q),
        run: () => {
          s.setView("terminal");
          s.setActiveTab(t.id);
          termBus.get(t.id)?.focus();
        },
      })),
      5,
    );
    if (q) {
      add(
        snippets.map((c) => ({
          key: "c:" + c.id,
          group: "命令",
          icon: <ScrollText />,
          title: c.name,
          sub: c.command,
          s: Math.max(score(c.name, q), score(c.command, q), score(c.tags.join(" "), q) && 1),
          run: () => sendToTerminal(c.command, false),
          alt: () => sendToTerminal(c.command, true),
        })),
        5,
      );
      out.push(
        ...history.slice(0, 6).map((h) => ({
          key: "hi:" + h.command,
          group: "历史",
          icon: <Clock />,
          title: h.command,
          sub: `×${h.count}`,
          run: () => sendToTerminal(h.command, false),
          alt: () => sendToTerminal(h.command, true),
        })),
      );
    }
    const actions: (Omit<Item, "group" | "key"> & { k?: string })[] = [
      { icon: <House />, title: "首页", run: () => s.setView("home") },
      { icon: <SquareTerminal />, title: "终端", run: () => s.setView("terminal") },
      { icon: <Plus />, title: "新建服务器", run: () => s.openEditor("") },
      { icon: <Download />, title: "导入服务器", run: () => s.setImportOpen(true) },
      { icon: <Layers />, title: "多机执行", run: () => s.setModal("batch") },
      { icon: <Network />, title: "隧道", run: () => s.setModal("tunnels") },
      { icon: <ScrollText />, title: "命令", run: () => s.setModal("snippets") },
      { icon: <Bot />, title: "Agent", run: () => s.setModal("agent") },
      { icon: <Settings />, title: "设置", run: () => s.setModal("settings") },
      ...THEMES.map((t) => ({ k: "theme:" + t.id, icon: <Palette />, title: `主题：${t.name}`, run: () => applyTheme(t.id) })),
    ];
    add(
      actions.map((a) => ({ ...a, key: "a:" + (a.k ?? a.title), group: "操作", s: score(a.title, q) })),
      q ? 6 : 5,
    );
    return out;
  }, [hosts, tabs, snippets, history, q]);

  useEffect(() => setHi(0), [q, open]);
  useEffect(() => {
    panelRef.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const exec = (it: Item | undefined, alt = false) => {
    if (!it) return;
    close();
    props.onChange("");
    (alt && it.alt ? it.alt : it.run)();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHi((h) => Math.min(items.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      exec(items[hi], e.ctrlKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (props.value) props.onChange("");
      else close();
    }
  };

  let lastGroup = "";
  return (
    <div className="gs">
      <Search className="gs-icon" />
      <input
        ref={inputRef}
        className="input gs-input"
        placeholder="搜索  Ctrl+P"
        value={props.value}
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          props.onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKey}
      />
      {open &&
        rect &&
        createPortal(
          <div
            ref={panelRef}
            className="gs-panel"
            style={{ left: rect.left, top: rect.bottom + 6 }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {items.length === 0 && <div className="gs-empty">无匹配</div>}
            {items.map((it, i) => {
              const head = it.group !== lastGroup ? it.group : null;
              lastGroup = it.group;
              return (
                <div key={it.key}>
                  {head && <div className="gs-group">{head}</div>}
                  <div
                    data-i={i}
                    className={"gs-item" + (i === hi ? " hi" : "")}
                    onMouseEnter={() => setHi(i)}
                    onClick={(e) => exec(it, e.ctrlKey)}
                  >
                    <span className="gs-item-icon">{it.icon}</span>
                    <span className="gs-title ellipsis">{it.title}</span>
                    {it.sub && <span className="gs-sub ellipsis">{it.sub}</span>}
                  </div>
                </div>
              );
            })}
            <div className="gs-foot">
              <span>↵ 打开</span>
              <span>Ctrl+↵ {items[hi]?.group === "服务器" ? "编辑" : "执行"}</span>
              <span>Esc 关闭</span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
