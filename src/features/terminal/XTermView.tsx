// One xterm.js instance bound to one Rust terminal session. Output is written straight into xterm from the
// IPC channel (never through React state); React only renders the overlays (popup, search, AI bar).
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AtSign,
  BookmarkPlus,
  ClipboardPaste,
  Copy,
  Eraser,
  History,
  Layers,
  ListChecks,
  Network,
  RotateCcw,
  RotateCw,
  ScrollText,
  Search,
  Sparkles,
  SquarePlus,
  TextCursorInput,
  TextSelect,
  Unplug,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { termBus } from "../../lib/termBus";
import { hostById, type TermTab, useApp } from "../../store";
import { AiBar, ExplainCard } from "./AiBar";
import { BatchDialog, useBatchRun } from "./CommandBar";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { HistoryDialog, SaveSnippetDialog } from "./HistoryDialog";
import { onThemeChange, termTheme } from "../../lib/themes";
import { refreshAiPredict, savedFontSize, TERM_OPTIONS } from "./config";
import { Highlighter } from "./highlight";
import { LocalEcho } from "./localEcho";
import { openTerminal, reopenTerminal } from "./open";
import { PredictPopup } from "./PredictPopup";
import { type PopupState, Predictor } from "./predictor";
import { SearchBox } from "./SearchBox";

interface Inst {
  term: Terminal;
  search: SearchAddon;
  predictor: Predictor;
  fit: () => void;
  copy: () => void;
  paste: () => void;
  /** Clear the screen (keeps the prompt line) or fully reset the emulator. */
  clear: (full: boolean) => void;
}

export function XTermView(props: {
  tab: TermTab;
  active: boolean;
  onClose: () => void;
  onSwitch: (delta: number) => void;
}) {
  const { tab, active } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const inst = useRef<Inst | null>(null);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [explain, setExplain] = useState<string | null>(null);
  const [hasSel, setHasSel] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // undefined = closed; string = open (prefilled with that text when non-empty)
  const [batchOpen, setBatchOpen] = useState<string | undefined>(undefined);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saveText, setSaveText] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; sel: string } | null>(null);
  const batchRun = useBatchRun(tab.id);

  // Latest props/actions for handlers registered once at mount.
  const live = useRef({
    props,
    alive: tab.alive,
    overlay: false,
    explainSel: () => {},
    reconnect: () => {},
  });
  live.current.props = props;
  live.current.alive = tab.alive;
  live.current.overlay = popup !== null || aiOpen;

  const reconnect = async () => {
    if (reconnecting) return;
    setReconnecting(true);
    const t = inst.current?.term;
    const ok = await reopenTerminal(tab.id, t?.cols, t?.rows);
    if (!ok) setReconnecting(false);
  };
  live.current.reconnect = reconnect;

  const explainSelection = () => {
    const sel = inst.current?.term.getSelection().trim();
    if (!sel) {
      toast("先选中要解释的文本");
      return;
    }
    setExplain(sel.length > 4000 ? sel.slice(-4000) : sel);
  };
  live.current.explainSel = explainSelection;

  useEffect(() => {
    const hostEl = hostRef.current!;
    const wrapEl = wrapRef.current!;
    const id = tab.id;
    const hostId = tab.hostId;
    let disposed = false;

    const term = new Terminal(TERM_OPTIONS);
    // Live theme / font size changes from 设置 → 外观.
    const unTheme = onThemeChange((t) => {
      term.options.theme = termTheme(t);
    });
    const onFont = () => {
      term.options.fontSize = savedFontSize();
      if (hostEl.offsetParent !== null) fitAddon.fit();
    };
    window.addEventListener("term-font-change", onFont);
    const fitAddon = new FitAddon();
    const search = new SearchAddon({ highlightLimit: 500 });
    term.loadAddon(fitAddon);
    term.loadAddon(search);
    term.loadAddon(
      new WebLinksAddon((ev, uri) => {
        ev.preventDefault();
        openUrl(uri).catch((e) => toast(`无法打开链接：${errMsg(e)}`, "error"));
      }),
    );
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(hostEl);
    const echo = new LocalEcho(term);
    echo.mount();
    const highlighter = new Highlighter(term);
    echo.setNetworkLatency(useApp.getState().latency[hostId] ?? null);
    const unLatency = useApp.subscribe((s) => echo.setNetworkLatency(s.latency[hostId] ?? null));
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose()); // xterm falls back to the DOM renderer
      term.loadAddon(gl);
    } catch {
      /* WebGL unavailable: DOM renderer */
    }

    const fit = () => {
      if (disposed || hostEl.offsetParent === null) return;
      try {
        fitAddon.fit();
      } catch {
        /* not measurable yet */
      }
    };

    const screenText = (lines = 50) => {
      const b = term.buffer.active;
      let end = Math.min(b.length, b.baseY + term.rows) - 1;
      while (end > 0 && !b.getLine(end)?.translateToString(true)) end--;
      const out: string[] = [];
      for (let y = Math.max(0, end - lines + 1); y <= end; y++) out.push(b.getLine(y)?.translateToString(true) ?? "");
      return out.join("\n");
    };

    const predictor = new Predictor(term, wrapEl, id, hostId, screenText, setPopup);

    const copy = () => {
      const s = term.getSelection();
      if (s) navigator.clipboard.writeText(s).catch(() => toast("复制失败", "error"));
    };
    const paste = () => {
      navigator.clipboard
        .readText()
        .then((t) => t && term.paste(t))
        .catch(() => toast("无法读取剪贴板", "error"));
    };

    const clear = (full: boolean) => {
      predictor.reset();
      echo.clear();
      if (full) term.reset();
      else term.clear();
    };

    inst.current = { term, search, predictor, fit, copy, paste, clear };

    // Fit before attaching so the replayed buffer is laid out at the real width.
    fit();
    api
      .termAttach(id, (data) => {
        if (!disposed) term.write(new Uint8Array(data));
      })
      .then((info) => {
        if (!info.alive && !disposed) useApp.getState().updateTab(id, { alive: false });
      })
      .catch(() => {
        if (!disposed) useApp.getState().updateTab(id, { alive: false });
      });

    const subs = [
      term.onData((data) => {
        if (!live.current.alive) {
          if (data === "\r") live.current.reconnect();
          return;
        }
        predictor.onData(data);
        echo.onInput(data);
        api.termWrite(id, data).catch(() => {});
      }),
      term.onResize(({ cols, rows }) => {
        predictor.reset();
        echo.clear();
        if (live.current.alive) api.termResize(id, cols, rows).catch(() => {});
      }),
      term.onWriteParsed(() => {
        echo.onOutput();
        predictor.onWriteParsed();
      }),
      term.onCursorMove(() => predictor.onCursorMove()),
      term.onScroll(() => predictor.onWriteParsed()),
      term.onSelectionChange(() => setHasSel(term.hasSelection())),
    ];

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const k = ev.key.toLowerCase();
      const L = live.current;
      if (ev.ctrlKey && ev.shiftKey && !ev.altKey) {
        if (k === "c") {
          ev.preventDefault();
          copy();
          return false;
        }
        if (k === "v") {
          ev.preventDefault();
          paste();
          return false;
        }
        if (k === "h" && !L.overlay) {
          ev.preventDefault();
          setHistoryOpen(true);
          return false;
        }
        if (k === "e") {
          ev.preventDefault();
          L.explainSel();
          return false;
        }
      }
      if (ev.ctrlKey && !ev.altKey && ev.key === "Tab") {
        ev.preventDefault();
        L.props.onSwitch(ev.shiftKey ? -1 : 1);
        return false;
      }
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
        if (k === "w") {
          ev.preventDefault();
          L.props.onClose();
          return false;
        }
        if (k === "f") {
          ev.preventDefault();
          setSearchOpen(true);
          return false;
        }
        if (k === "k") {
          ev.preventDefault();
          predictor.reset();
          setAiOpen(true);
          return false;
        }
      }
      return predictor.handleKey(ev);
    });

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      // Shift+right-click: quick copy-or-paste.
      if (e.shiftKey) {
        if (term.hasSelection()) {
          copy();
          term.clearSelection();
        } else paste();
        term.focus();
        return;
      }
      setMenu({ x: e.clientX, y: e.clientY, sel: term.getSelection() });
    };
    hostEl.addEventListener("contextmenu", onContextMenu);

    let rt: number | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(rt);
      rt = window.setTimeout(fit, 80);
    });
    ro.observe(hostEl);

    const unregister = termBus.register(id, {
      paste: (text) => {
        term.paste(text);
        term.focus();
      },
      run: (command) => {
        if (!live.current.alive) {
          toast("连接已断开", "error");
          return;
        }
        predictor.onRun();
        echo.clear();
        api.termWrite(id, command + "\r").catch((e) => toast(errMsg(e), "error"));
        const c = command.trim();
        if (c && !c.includes("\n")) api.historyRecord(hostId, c).catch(() => {});
        term.scrollToBottom();
      },
      screenText,
      selection: () => term.getSelection(),
      focus: () => term.focus(),
    });

    return () => {
      disposed = true;
      clearTimeout(rt);
      ro.disconnect();
      hostEl.removeEventListener("contextmenu", onContextMenu);
      unregister();
      predictor.dispose();
      echo.dispose();
      highlighter.dispose();
      unLatency();
      unTheme();
      window.removeEventListener("term-font-change", onFont);
      subs.forEach((s) => s.dispose());
      inst.current = null;
      term.dispose();
    };
    // One terminal per session id; hostId never changes for a given session.
  }, [tab.id]);

  // Global search "批量执行" targets the visible terminal.
  useEffect(() => {
    if (!active) return;
    const open = () => setBatchOpen("");
    window.addEventListener("msp:open-batch", open);
    return () => window.removeEventListener("msp:open-batch", open);
  }, [active]);

  // Becoming visible: fit to the (possibly changed) size and take focus.
  useEffect(() => {
    if (!active) return;
    refreshAiPredict();
    const raf = requestAnimationFrame(() => {
      inst.current?.fit();
      inst.current?.term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  // Session gone (disconnected or its host deleted): drop any open prediction.
  useEffect(() => {
    if (!tab.alive) inst.current?.predictor.reset();
  }, [tab.alive]);

  const focusTerm = () => inst.current?.term.focus();
  const i = inst.current;

  const menuItems = (sel: string): MenuItem[] => {
    const has = sel.trim().length > 0;
    const t = inst.current?.term;
    const host = hostById(tab.hostId);
    const alive = tab.alive;
    const copyText = (text: string, ok?: string) =>
      navigator.clipboard
        .writeText(text)
        .then(() => ok && toast(ok, "success"))
        .catch(() => toast("复制失败", "error"));
    return [
      { label: "复制", icon: <Copy />, hint: "Ctrl+Shift+C", disabled: !has, onSelect: () => copyText(sel) },
      { label: "粘贴", icon: <ClipboardPaste />, hint: "Ctrl+Shift+V", disabled: !alive, onSelect: () => inst.current?.paste() },
      has && { label: "粘贴选中内容", icon: <TextCursorInput />, disabled: !alive, onSelect: () => t?.paste(sel) },
      { label: "全选", icon: <TextSelect />, onSelect: () => t?.selectAll() },
      "sep",
      { label: "搜索", icon: <Search />, hint: "Ctrl+F", onSelect: () => setSearchOpen(true) },
      { label: "清屏", icon: <Eraser />, onSelect: () => inst.current?.clear(false) },
      { label: "清除缓冲区并重置", icon: <RotateCcw />, onSelect: () => inst.current?.clear(true) },
      "sep",
      has && {
        label: "AI 解释",
        icon: <Sparkles />,
        hint: "Ctrl+Shift+E",
        onSelect: () => {
          const s = sel.trim();
          setExplain(s.length > 4000 ? s.slice(-4000) : s);
        },
      },
      has && { label: "发送到批量执行", icon: <ListChecks />, onSelect: () => setBatchOpen(sel.replace(/\s+$/, "")) },
      has && { label: "加入命令", icon: <BookmarkPlus />, onSelect: () => setSaveText(sel) },
      "sep",
      { label: "命令历史", icon: <History />, hint: "Ctrl+Shift+H", onSelect: () => setHistoryOpen(true) },
      host && {
        label: "复制主机地址",
        icon: <AtSign />,
        onSelect: () => copyText(`${host.username}@${host.host}`, "已复制"),
      },
      "sep",
      { label: "新建同主机终端", icon: <SquarePlus />, onSelect: () => void openTerminal(tab.hostId) },
      { label: "重新连接", icon: <RotateCw />, disabled: reconnecting, onSelect: () => void reconnect() },
      { label: "关闭终端", icon: <X />, hint: "Ctrl+W", onSelect: () => props.onClose() },
    ];
  };

  return (
    <div className="term-view" style={{ display: active ? "flex" : "none" }}>
      {!tab.alive && (
        <div className="term-exit row">
          <Unplug />
          <span>连接已断开</span>
          <span className="spacer" />
          <button className="btn sm primary" title="Enter" disabled={reconnecting} onClick={reconnect}>
            <RotateCw className={reconnecting ? "spin" : undefined} />
            重新连接
          </button>
        </div>
      )}
      <div className="term-wrap" ref={wrapRef}>
        <div className="term-host" ref={hostRef} />

        {popup && i && tab.alive && (
          <PredictPopup state={popup} onPick={(n) => i.predictor.accept(n)} onHover={(n) => i.predictor.select(n)} />
        )}

        {searchOpen && i && (
          <SearchBox
            search={i.search}
            onClose={() => {
              setSearchOpen(false);
              focusTerm();
            }}
          />
        )}

        {explain !== null && (
          <ExplainCard
            hostId={tab.hostId}
            text={explain}
            onClose={() => {
              setExplain(null);
              focusTerm();
            }}
          />
        )}

        {hasSel && !aiOpen && explain === null && (
          <button className="btn sm explain-fab" onMouseDown={(e) => e.preventDefault()} onClick={explainSelection} title="Ctrl+Shift+E">
            <Sparkles />
            AI 解释
          </button>
        )}

        {aiOpen && (
          <AiBar
            hostId={tab.hostId}
            onClose={() => {
              setAiOpen(false);
              focusTerm();
            }}
            onInsert={(cmd) => {
              setAiOpen(false);
              i?.term.paste(cmd);
              focusTerm();
            }}
            onRun={(cmd) => {
              setAiOpen(false);
              termBus.get(tab.id)?.run(cmd);
              focusTerm();
            }}
            extra={
              hasSel && (
                <button className="btn sm ghost" onMouseDown={(e) => e.preventDefault()} onClick={explainSelection} title="Ctrl+Shift+E">
                  <Sparkles />
                  AI 解释
                </button>
              )
            }
          />
        )}
      </div>
      <div className="term-toolbar">
        <button className="term-tool" onClick={() => setBatchOpen("")} title="多行命令发送到此终端">
          <ListChecks />
          <span>批量执行</span>
          {batchRun && (
            <span className="term-tool-badge num">
              {batchRun.done}/{batchRun.total}
            </span>
          )}
        </button>
        <button className="term-tool" onClick={() => useApp.getState().setModal("batch")}>
          <Layers />
          <span>多机执行</span>
        </button>
        <button className="term-tool" onClick={() => useApp.getState().setModal("snippets")}>
          <ScrollText />
          <span>命令</span>
        </button>
        <button className="term-tool" title="Ctrl+Shift+H" onClick={() => setHistoryOpen(true)}>
          <History />
          <span>历史</span>
        </button>
        <button className="term-tool" onClick={() => useApp.getState().setModal("tunnels")}>
          <Network />
          <span>隧道</span>
        </button>
        <span className="term-tool-sep" />
        <button
          className="term-tool"
          title="Ctrl+K"
          onClick={() => {
            inst.current?.predictor.reset();
            setAiOpen(true);
          }}
        >
          <Sparkles />
          <span>AI 命令</span>
        </button>
        <button className="term-tool" title="Ctrl+F" onClick={() => setSearchOpen(true)}>
          <Search />
          <span>搜索</span>
        </button>
      </div>
      {batchOpen !== undefined && (
        <BatchDialog
          tab={tab}
          initialText={batchOpen || undefined}
          onClose={() => {
            setBatchOpen(undefined);
            inst.current?.term.focus();
          }}
        />
      )}
      {historyOpen && (
        <HistoryDialog
          tab={tab}
          onClose={() => {
            setHistoryOpen(false);
            focusTerm();
          }}
        />
      )}
      {saveText !== null && (
        <SaveSnippetDialog
          text={saveText}
          onClose={() => {
            setSaveText(null);
            focusTerm();
          }}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.sel)}
          onClose={(refocus) => {
            setMenu(null);
            if (refocus) focusTerm();
          }}
        />
      )}
    </div>
  );
}
