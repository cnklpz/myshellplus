// Command history of a terminal's host (or all hosts): search, insert, run, copy, delete.
import { Copy, CornerDownLeft, Play, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog, toast } from "../../components/ui";
import { api, errMsg, type HistoryHit } from "../../lib/api";
import { termBus } from "../../lib/termBus";
import { type TermTab, useApp } from "../../store";

type Scope = "host" | "all";
const LIMIT = 500;
const SCOPE_KEY = "history.scope";

function loadScope(): Scope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "host";
  } catch {
    return "host";
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

export function relTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} 天前`;
  const d = new Date(ms);
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

export function HistoryDialog(props: { tab: TermTab; onClose: () => void }) {
  const { tab } = props;
  const hostName = useApp((s) => s.hosts.find((h) => h.id === tab.hostId)?.name ?? tab.title);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>(loadScope);
  const [items, setItems] = useState<HistoryHit[] | null>(null);
  const [sel, setSel] = useState(0);
  const [nonce, setNonce] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const first = useRef(true);
  const keepSel = useRef(false);

  const scopeHost = scope === "host" ? tab.hostId : "";

  useEffect(() => {
    const my = ++seq.current;
    const load = () =>
      api
        .historyList(scopeHost, q.trim(), LIMIT)
        .then((r) => {
          if (my !== seq.current) return;
          setItems(r);
          const keep = keepSel.current;
          keepSel.current = false;
          setSel((s) => (keep ? Math.min(s, Math.max(0, r.length - 1)) : 0));
        })
        .catch((e) => {
          if (my === seq.current) {
            setItems([]);
            toast(errMsg(e), "error");
          }
        });
    // First load is immediate; typing is debounced.
    const t = window.setTimeout(load, first.current ? 0 : 150);
    first.current = false;
    return () => clearTimeout(t);
    // nonce: refresh after delete (keeps the selection index)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, scopeHost, nonce]);

  // Keep the selected row visible.
  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [sel, items]);

  const setScopePref = (s: Scope) => {
    setScope(s);
    try {
      localStorage.setItem(SCOPE_KEY, s);
    } catch {
      /* storage unavailable */
    }
  };

  const insert = (cmd: string) => {
    props.onClose();
    const h = termBus.get(tab.id);
    if (!h) return toast("终端未就绪", "error");
    h.paste(cmd);
  };
  const run = (cmd: string) => {
    props.onClose();
    const h = termBus.get(tab.id);
    if (!h) return toast("终端未就绪", "error");
    h.run(cmd);
    h.focus();
  };
  const copy = (cmd: string) =>
    navigator.clipboard
      .writeText(cmd)
      .then(() => toast("已复制", "success"))
      .catch(() => toast("复制失败", "error"));
  const remove = (cmd: string) =>
    api
      .historyDelete(scopeHost, cmd)
      .then(() => {
        keepSel.current = true;
        setNonce((n) => n + 1);
      })
      .catch((e) => toast(errMsg(e), "error"));

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const list = items ?? [];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!list.length) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setSel((s) => Math.max(0, Math.min(list.length - 1, s + d)));
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      const d = e.key === "PageDown" ? 10 : -10;
      setSel((s) => Math.max(0, Math.min(list.length - 1, s + d)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = list[sel];
      if (!it || !tab.alive) return;
      if (e.ctrlKey) run(it.command);
      else insert(it.command);
    }
  };

  const now = Date.now();
  const dead = !tab.alive;

  return (
    <Dialog title={`命令历史 · ${hostName}`} width={720} onClose={props.onClose}>
      <div className="stack gap-3">
        <div className="row">
          <div className="hist-search grow row">
            <Search />
            <input
              autoFocus
              className="grow mono"
              spellCheck={false}
              placeholder="docker ps"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
            />
          </div>
          <div className="seg">
            <button className={scope === "host" ? "on" : ""} onClick={() => setScopePref("host")}>
              本机
            </button>
            <button className={scope === "all" ? "on" : ""} onClick={() => setScopePref("all")}>
              全部
            </button>
          </div>
        </div>
        <div className="hist-list" ref={listRef}>
          {items?.length === 0 && <div className="hist-empty">没有记录</div>}
          {items?.map((it, i) => (
            <div
              key={it.command}
              className={"hist-row" + (i === sel ? " selected" : "")}
              onMouseMove={() => i !== sel && setSel(i)}
              onDoubleClick={() => !dead && insert(it.command)}
            >
              <span className="hist-cmd mono ellipsis" title={it.command}>
                {it.command}
              </span>
              <span className="hist-meta">
                <span className="hist-count">×{it.count}</span>
                <span className="hist-time">{relTime(it.lastUsed, now)}</span>
              </span>
              <span className="hist-actions" onDoubleClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title="插入 (Enter)" disabled={dead} onClick={() => insert(it.command)}>
                  <CornerDownLeft />
                </button>
                <button className="icon-btn" title="执行 (Ctrl+Enter)" disabled={dead} onClick={() => run(it.command)}>
                  <Play />
                </button>
                <button className="icon-btn" title="复制" onClick={() => copy(it.command)}>
                  <Copy />
                </button>
                <button className="icon-btn danger" title="删除" onClick={() => remove(it.command)}>
                  <Trash2 />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

/** Save a piece of terminal text as a 命令 (snippet). */
export function SaveSnippetDialog(props: { text: string; onClose: () => void }) {
  const firstLine = props.text.trim().split(/\r?\n/)[0] ?? "";
  const [name, setName] = useState(() => firstLine.slice(0, 24).trim());
  const [command, setCommand] = useState(() => props.text.trim());
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim() || !command.trim() || busy) return;
    setBusy(true);
    try {
      await api.snippetSave({ name: name.trim(), command: command.trim(), tags: [] });
      toast("已加入命令", "success");
      props.onClose();
    } catch (e) {
      toast(errMsg(e), "error");
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="加入命令"
      width={520}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn ghost" onClick={props.onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || !command.trim()} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="stack gap-3">
        <div className="field">
          <label>名称</label>
          <input
            autoFocus
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              }
            }}
          />
        </div>
        <div className="field top">
          <label>命令</label>
          <textarea
            className="textarea mono"
            rows={Math.min(8, Math.max(2, command.split("\n").length))}
            spellCheck={false}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault();
                save();
              }
            }}
          />
        </div>
      </div>
    </Dialog>
  );
}
