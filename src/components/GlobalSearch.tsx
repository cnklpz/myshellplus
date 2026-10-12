// Global search (Ctrl+P): a centered palette over servers, terminals, saved commands, history,
// tunnels, settings and app actions. The sidebar shows a trigger that opens it.
import {
  Activity, ArrowRight, Bot, Clock, Cloud, Database, Download, FolderOpen, House, Info, KeyRound, Layers, ListChecks,
  Lock, Network, Palette, Plus, ScrollText, Search, Server, Settings, ShieldCheck, Sparkles, SquareTerminal, Type,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openTerminal } from "../features/terminal/open";
import { api, type HistoryHit, type Snippet, type TunnelDef, type TunnelStatus } from "../lib/api";
import { termBus } from "../lib/termBus";
import { applyTheme, currentTheme, THEMES } from "../lib/themes";
import { useApp } from "../store";
import { toast, useEscClose } from "./ui";

interface Item {
  key: string;
  group: string;
  icon: ReactNode;
  title: string;
  /** extra words that should match but aren't shown */
  keywords?: string;
  sub?: string;
  /** Enter */
  run: () => void;
  /** Ctrl+Enter */
  alt?: () => void;
  altLabel?: string;
}

const GROUP_ORDER = ["服务器", "终端", "命令", "历史", "隧道", "设置", "操作"];

function score(hay: string, q: string): number {
  const h = hay.toLowerCase();
  if (!q) return 1;
  if (h.startsWith(q)) return 4;
  if (h.split(/[\s/@:._-]+/).some((w) => w.startsWith(q))) return 3;
  if (h.includes(q)) return 2;
  let i = 0; // all query chars in order
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
  setTimeout(() => t.focus(), 0);
}

/** Sidebar trigger: looks like a search field, opens the palette. */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState("");

  // Opened from the global context menu ("搜索…").
  useEffect(() => {
    const onOpen = (e: Event) => {
      setInitial(String((e as CustomEvent).detail ?? ""));
      setOpen(true);
    };
    window.addEventListener("msp:open-search", onOpen);
    return () => window.removeEventListener("msp:open-search", onOpen);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.ctrlKey && !e.altKey && ((k === "p" && !e.shiftKey) || (k === "f" && e.shiftKey))) {
        e.preventDefault();
        e.stopPropagation();
        setInitial("");
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <>
      <button type="button" className="gs-trigger" onClick={() => (setInitial(""), setOpen(true))}>
        <Search />
        <span className="grow">搜索</span>
        <kbd>Ctrl P</kbd>
      </button>
      {open && <SearchPalette initial={initial} onClose={() => setOpen(false)} />}
    </>
  );
}

function SearchPalette(props: { initial: string; onClose: () => void }) {
  const hosts = useApp((s) => s.hosts);
  const tabs = useApp((s) => s.tabs);
  const [query, setQuery] = useState(props.initial);
  const [hi, setHi] = useState(0);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [history, setHistory] = useState<HistoryHit[]>([]);
  const [tunnels, setTunnels] = useState<{ def: TunnelDef; st?: TunnelStatus }[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  useEscClose(props.onClose);

  useEffect(() => {
    api.snippetList().then(setSnippets).catch(() => {});
    Promise.all([api.tunnelList(), api.tunnelStatus()])
      .then(([defs, st]) => setTunnels(defs.map((d) => ({ def: d, st: st.find((x) => x.id === d.id) }))))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      api.historyList("", query.trim(), q ? 8 : 5).then(setHistory).catch(() => setHistory([]));
    }, 100);
    return () => clearTimeout(t);
  }, [query]);

  const items = useMemo<Item[]>(() => {
    const s = useApp.getState();
    const all: (Item & { s: number })[] = [];
    const push = (it: Item, max?: number) => {
      const sc = Math.max(score(it.title, q), it.keywords ? score(it.keywords, q) : 0, it.sub ? Math.min(2, score(it.sub, q)) : 0);
      if (sc > 0) all.push({ ...it, s: sc + (max ?? 0) * 0 });
    };

    for (const h of hosts)
      push({
        key: "h:" + h.id, group: "服务器", icon: <Server />, title: h.name,
        sub: `${h.username}@${h.host}${h.port !== 22 ? ":" + h.port : ""}`,
        keywords: [h.groupName, h.tags.join(" "), h.notes].join(" "),
        run: () => openTerminal(h.id), alt: () => s.openEditor(h.id), altLabel: "编辑",
      });
    for (const t of tabs)
      push({
        key: "t:" + t.id, group: "终端", icon: <SquareTerminal />, title: t.title, sub: t.alive ? "已打开" : "已断开",
        run: () => {
          s.setView("terminal");
          s.setActiveTab(t.id);
          setTimeout(() => termBus.get(t.id)?.focus(), 0);
        },
      });
    for (const c of snippets)
      push({
        key: "c:" + c.id, group: "命令", icon: <ScrollText />, title: c.name, sub: c.command, keywords: c.tags.join(" "),
        run: () => sendToTerminal(c.command, false), alt: () => sendToTerminal(c.command, true), altLabel: "执行",
      });
    for (const h of history)
      push({
        key: "hi:" + h.command, group: "历史", icon: <Clock />, title: h.command, sub: `×${h.count}`,
        run: () => sendToTerminal(h.command, false), alt: () => sendToTerminal(h.command, true), altLabel: "执行",
      });
    for (const { def, st } of tunnels)
      push({
        key: "tu:" + def.id, group: "隧道", icon: <Network />, title: def.name,
        sub: `${st?.running ? "运行中" : "已停止"} · ${def.bindPort}${def.kind === "dynamic" ? " SOCKS5" : " → " + def.targetHost + ":" + def.targetPort}`,
        keywords: "隧道 tunnel 转发",
        run: () =>
          (st?.running ? api.tunnelStop(def.id) : api.tunnelStart(def.id)).then(
            () => toast(st?.running ? `已停止 ${def.name}` : `已启动 ${def.name}`, "success"),
            (e) => toast(String(e), "error"),
          ),
        alt: () => s.setModal("tunnels"), altLabel: "管理",
      });

    const settings: [string, string, ReactNode, string][] = [
      ["AI 服务", "ai", <Sparkles />, "claude openai deepseek 模型 api key 预测"],
      ["安全 · 主密码", "security", <ShieldCheck />, "密码 锁定 加密 保险库"],
      ["外观 · 主题", "appearance", <Palette />, "颜色 配色 深色 浅色"],
      ["终端字号", "appearance", <Type />, "字体 大小 font"],
      ["本地回显", "appearance", <ArrowRight />, "延迟 预测 echo"],
      ["备份与导入", "backup", <Database />, "导出 恢复 backup"],
      ["云同步", "sync", <Cloud />, "sync"],
      ["关于", "about", <Info />, "版本 version"],
    ];
    for (const [title, sec, icon, kw] of settings)
      push({ key: "s:" + title, group: "设置", icon, title, keywords: "设置 " + kw, run: () => s.openSettings(sec) });

    const actions: Item[] = [
      { key: "a:home", group: "操作", icon: <House />, title: "首页", run: () => s.setView("home") },
      { key: "a:term", group: "操作", icon: <SquareTerminal />, title: "终端", run: () => s.setView("terminal") },
      { key: "a:new", group: "操作", icon: <Plus />, title: "新建服务器", keywords: "添加 主机", run: () => s.openEditor("") },
      { key: "a:import", group: "操作", icon: <Download />, title: "导入服务器", keywords: "ssh config putty xshell csv", run: () => s.setImportOpen(true) },
      { key: "a:batch", group: "操作", icon: <ListChecks />, title: "批量执行", keywords: "多行 命令", run: () => {
        if (!termBus.active()) return toast("请先打开终端", "error");
        s.setView("terminal");
        setTimeout(() => window.dispatchEvent(new Event("msp:open-batch")), 0);
      } },
      { key: "a:multi", group: "操作", icon: <Layers />, title: "多机执行", keywords: "批量 多台", run: () => s.setModal("batch") },
      { key: "a:tunnels", group: "操作", icon: <Network />, title: "隧道管理", keywords: "端口 转发 socks", run: () => s.setModal("tunnels") },
      { key: "a:cmds", group: "操作", icon: <ScrollText />, title: "命令管理", keywords: "收藏 片段 snippet", run: () => s.setModal("snippets") },
      { key: "a:status", group: "操作", icon: <Activity />, title: "状态面板", keywords: "cpu 内存 监控", run: () => { s.setView("terminal"); s.setSidePanel("monitor"); } },
      { key: "a:files", group: "操作", icon: <FolderOpen />, title: "文件面板", keywords: "sftp 上传 下载", run: () => { s.setView("terminal"); s.setSidePanel("files"); } },
      { key: "a:agent", group: "操作", icon: <Bot />, title: "Agent", keywords: "mcp claude 审计", run: () => s.setModal("agent") },
      { key: "a:keys", group: "操作", icon: <KeyRound />, title: "密钥管理", keywords: "ssh key 公钥", run: () => s.openEditor(s.hosts[0]?.id ?? "") },
      { key: "a:settings", group: "操作", icon: <Settings />, title: "设置", run: () => s.openSettings("ai") },
      ...(s.vault?.passwordEnabled
        ? [{ key: "a:lock", group: "操作", icon: <Lock />, title: "锁定", run: () => api.vaultLock().then(() => s.refreshVault()) }]
        : []),
      ...THEMES.map((t) => ({
        key: "theme:" + t.id, group: "操作", icon: <Palette />, title: `主题：${t.name}`, keywords: "主题 配色 theme",
        sub: t.id === currentTheme().id ? "当前" : undefined, run: () => applyTheme(t.id),
      })),
    ];
    for (const a of actions) push(a);

    // Group in a fixed order; within a group best match first. Without a query keep it short.
    const limit: Record<string, number> = q
      ? { 服务器: 6, 终端: 5, 命令: 5, 历史: 6, 隧道: 5, 设置: 4, 操作: 8 }
      : { 服务器: 5, 终端: 5, 命令: 0, 历史: 5, 隧道: 0, 设置: 0, 操作: 6 };
    const out: Item[] = [];
    for (const g of GROUP_ORDER) {
      const inG = all.filter((x) => x.group === g).sort((a, b) => b.s - a.s);
      out.push(...inG.slice(0, limit[g]));
    }
    return out;
  }, [hosts, tabs, snippets, history, tunnels, q]);

  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const exec = (it: Item | undefined, alt = false) => {
    if (!it) return;
    props.onClose();
    (alt && it.alt ? it.alt : it.run)();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(items.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      exec(items[hi], e.ctrlKey);
    } else if (e.key === "Tab") {
      e.preventDefault();
      // jump to the next group
      const g = items[hi]?.group;
      const next = items.findIndex((x, i) => i > hi && x.group !== g);
      setHi(next >= 0 ? next : 0);
    }
  };

  const cur = items[hi];
  let lastGroup = "";
  return createPortal(
    <div className="pal-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="pal" role="dialog" aria-label="搜索">
        <div className="pal-input-row">
          <Search />
          <input
            autoFocus
            className="pal-input"
            placeholder="搜索服务器、命令、历史、隧道、设置…"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" ref={listRef}>
          {items.length === 0 && <div className="pal-empty">无匹配</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.key}>
                {head && <div className="pal-group">{head}</div>}
                <div
                  data-i={i}
                  className={"pal-item" + (i === hi ? " hi" : "")}
                  onMouseMove={() => i !== hi && setHi(i)}
                  onClick={(e) => exec(it, e.ctrlKey)}
                >
                  <span className="pal-icon">{it.icon}</span>
                  <span className="pal-title ellipsis">{it.title}</span>
                  {it.sub && <span className="pal-sub ellipsis">{it.sub}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="pal-foot">
          <span><kbd>↑↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 打开</span>
          {cur?.alt && <span><kbd>Ctrl ↵</kbd> {cur.altLabel}</span>}
          <span><kbd>Tab</kbd> 下一组</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
