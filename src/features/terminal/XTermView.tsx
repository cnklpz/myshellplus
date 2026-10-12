// One xterm.js instance bound to one Rust terminal session. Output is written straight into xterm from the
// IPC channel (never through React state); React only renders the overlays (popup, search, AI bar).
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { RotateCw, Sparkles, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { termBus } from "../../lib/termBus";
import { type TermTab, useApp } from "../../store";
import { AiBar, ExplainCard } from "./AiBar";
import { CommandBar } from "./CommandBar";
import { onThemeChange, termTheme } from "../../lib/themes";
import { refreshAiPredict, savedFontSize, TERM_OPTIONS } from "./config";
import { LocalEcho } from "./localEcho";
import { reopenTerminal } from "./open";
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
  const composerOpen = useApp((s) => s.composerOpen);

  // Latest props/actions for handlers registered once at mount.
  const live = useRef({ props, alive: tab.alive, explainSel: () => {}, reconnect: () => {} });
  live.current.props = props;
  live.current.alive = tab.alive;

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

    inst.current = { term, search, predictor, fit, copy, paste };

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
      if (term.hasSelection()) {
        copy();
        term.clearSelection();
      } else paste();
      term.focus();
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
      unLatency();
      unTheme();
      window.removeEventListener("term-font-change", onFont);
      subs.forEach((s) => s.dispose());
      inst.current = null;
      term.dispose();
    };
    // One terminal per session id; hostId never changes for a given session.
  }, [tab.id]);

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

  const focusTerm = () => inst.current?.term.focus();
  const i = inst.current;

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

        {popup && i && (
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
      {composerOpen && <CommandBar tab={tab} active={active} />}
    </div>
  );
}
