// Left sidebar: grouped host list, search, context menu, drag to regroup.
import { ChevronDown, ChevronRight, Copy, Download, Link, Pencil, Plug, Plus, Search, SquareTerminal, Trash2, Unplug } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Confirm, Empty, toast } from "../../components/ui";
import { api, errMsg, type Host } from "../../lib/api";
import { useApp } from "../../store";
import { openTerminal } from "../terminal/open";
import "./hosts.css";

const UNGROUPED = "未分组";
const COLLAPSE_KEY = "hostGroupsCollapsed";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}") ?? {};
  } catch {
    return {};
  }
}
function saveCollapsed(v: Record<string, boolean>) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

function matches(h: Host, q: string) {
  if (!q) return true;
  const hay = [h.name, h.host, h.username, h.groupName, ...h.tags].join("\n").toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

function connDot(state?: string) {
  if (state === "connected") return "dot ok";
  if (state === "connecting") return "dot warn";
  if (state === "error") return "dot err";
  return "dot";
}

async function saveHost(h: Host, password?: string) {
  await api.hostSave(h, password);
  await useApp.getState().refreshHosts();
}

async function openTerm(id: string) {
  try {
    await openTerminal(id);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

interface Menu { x: number; y: number; host: Host }

export function HostSidebar() {
  const hosts = useApp((s) => s.hosts);
  const conn = useApp((s) => s.conn);
  const openEditor = useApp((s) => s.openEditor);
  const setImportOpen = useApp((s) => s.setImportOpen);
  const setPanelHost = useApp((s) => s.setPanelHost);

  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Ctrl+P / Ctrl+Shift+F focus search (capture phase so the terminal doesn't eat it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.ctrlKey && !e.altKey && ((k === "p" && !e.shiftKey) || (k === "f" && e.shiftKey))) {
        e.preventDefault();
        e.stopPropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const map = new Map<string, Host[]>();
    for (const h of hosts) {
      if (!matches(h, q)) continue;
      const g = h.groupName.trim() || UNGROUPED;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(h);
    }
    const list = [...map.entries()].map(([name, items]) => ({
      name,
      items: items.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "zh-CN")),
    }));
    list.sort((a, b) => (a.name === UNGROUPED ? 1 : b.name === UNGROUPED ? -1 : a.name.localeCompare(b.name, "zh-CN")));
    return list;
  }, [hosts, q]);

  // Hosts in display order (searching expands every group).
  const visible = useMemo(() => groups.flatMap((g) => (q || !collapsed[g.name] ? g.items : [])), [groups, collapsed, q]);

  const toggleGroup = (name: string) => {
    const next = { ...collapsed, [name]: !collapsed[name] };
    setCollapsed(next);
    saveCollapsed(next);
  };

  const select = (id: string) => {
    setSelected(id);
    setPanelHost(id);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (!visible.length) return;
    const idx = visible.findIndex((h) => h.id === selected);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(visible.length - 1, idx + 1) : Math.max(0, idx < 0 ? 0 : idx - 1);
      select(visible[next].id);
      listRef.current?.querySelector(`[data-host="${visible[next].id}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && idx >= 0) {
      e.preventDefault();
      openTerm(visible[idx].id);
    } else if (e.key === "Delete" && idx >= 0) {
      setDeleting(visible[idx]);
    }
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setQuery("");
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Enter" && visible[0]) {
      e.preventDefault();
      openTerm((visible.find((h) => h.id === selected) ?? visible[0]).id);
    } else if (e.key === "ArrowDown" && visible[0]) {
      e.preventDefault();
      select(visible[0].id);
      listRef.current?.focus();
    }
  };

  // Pointer-based drag (HTML5 DnD is swallowed by the webview's file-drop handler on Windows).
  const startDrag = (e: React.MouseEvent, host: Host) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    let over: string | null = null;
    const move = (ev: MouseEvent) => {
      if (!active && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return;
      active = true;
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-group]");
      over = el?.dataset.group ?? null;
      setDrag({ id: host.id, over });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDrag(null);
      if (!active || over === null) return;
      const groupName = over === UNGROUPED ? "" : over;
      if ((host.groupName.trim() || "") === groupName) return;
      saveHost({ ...host, groupName })
        .then(() => toast(`已移动到「${over}」`, "success"))
        .catch((err) => toast(errMsg(err), "error"));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const connected = hosts.filter((h) => conn[h.id]?.state === "connected").length;

  return (
    <div className="hs">
      <div className="panel-header">
        <span className="grow">服务器</span>
        <button className="icon-btn" title="新建服务器" onClick={() => openEditor("")}>
          <Plus />
        </button>
        <button className="icon-btn" title="导入" onClick={() => setImportOpen(true)}>
          <Download />
        </button>
      </div>

      {hosts.length === 0 ? (
        <Empty
          text="还没有服务器"
          action={
            <div className="row">
              <button className="btn sm primary" onClick={() => openEditor("")}>
                <Plus /> 新建服务器
              </button>
              <button className="btn sm" onClick={() => setImportOpen(true)}>
                <Download /> 导入
              </button>
            </div>
          }
        />
      ) : (
        <>
          <div className="hs-search">
            <div className="hs-search-box">
              <Search />
              <input
                ref={searchRef}
                className="input sm"
                placeholder="搜索  Ctrl+P"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKey}
                spellCheck={false}
              />
            </div>
          </div>

          <div className="hs-list" ref={listRef} tabIndex={0} onKeyDown={onListKey}>
            {groups.length === 0 && <div className="empty">没有匹配的服务器</div>}
            {groups.map((g) => {
              const isCollapsed = !q && !!collapsed[g.name];
              return (
                <div key={g.name}>
                  <div
                    className={"list-row hs-group" + (drag && drag.over === g.name ? " drop" : "")}
                    data-group={g.name}
                    onClick={() => toggleGroup(g.name)}
                  >
                    <span className="hs-icon">{isCollapsed ? <ChevronRight /> : <ChevronDown />}</span>
                    <span className="grow ellipsis">{g.name}</span>
                    <span className="meta">{g.items.length}</span>
                  </div>
                  {!isCollapsed &&
                    g.items.map((h) => (
                      <div
                        key={h.id}
                        data-host={h.id}
                        data-group={g.name}
                        className={
                          "list-row hs-host" +
                          (selected === h.id ? " selected" : "") +
                          (drag?.id === h.id ? " dragging" : "")
                        }
                        title={`${h.username}@${h.host}:${h.port}`}
                        onMouseDown={(e) => startDrag(e, h)}
                        onClick={() => {
                          select(h.id);
                          listRef.current?.focus();
                        }}
                        onDoubleClick={() => openTerm(h.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          select(h.id);
                          setMenu({ x: e.clientX, y: e.clientY, host: h });
                        }}
                      >
                        {h.color && <span className="stripe" style={{ background: h.color }} />}
                        <span className="hs-icon">
                          <span className={connDot(conn[h.id]?.state)} />
                        </span>
                        <span className="name ellipsis">{h.name}</span>
                        <span className="meta">{h.host}</span>
                      </div>
                    ))}
                </div>
              );
            })}
          </div>

          <div className="hs-footer">
            {hosts.length} 台服务器 · {connected} 已连接
          </div>
        </>
      )}

      {menu && (
        <HostMenu
          menu={menu}
          state={conn[menu.host.id]?.state}
          onClose={() => setMenu(null)}
          onDelete={() => setDeleting(menu.host)}
        />
      )}

      {deleting && (
        <Confirm
          title="删除服务器"
          message={`确定删除「${deleting.name}」？保存的密码会一并删除，已打开的连接会断开。`}
          confirmText="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const h = deleting;
            setDeleting(null);
            try {
              await api.hostDelete(h.id);
              await useApp.getState().refreshHosts();
              if (selected === h.id) setSelected(null);
            } catch (e) {
              toast(errMsg(e), "error");
            }
          }}
        />
      )}
    </div>
  );
}

function HostMenu(props: { menu: Menu; state?: string; onClose: () => void; onDelete: () => void }) {
  const { menu, onClose } = props;
  const h = menu.host;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // Keep the menu inside the window.
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 4),
      y: Math.min(menu.y, window.innerHeight - r.height - 4),
    });
  }, [menu.x, menu.y]);

  const run = (fn: () => unknown) => async () => {
    onClose();
    try {
      await fn();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const isUp = props.state === "connected" || props.state === "connecting";

  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      <button onClick={run(() => openTerminal(h.id))}>
        <SquareTerminal /> 打开终端
      </button>
      {isUp ? (
        <button onClick={run(() => api.connDisconnect(h.id))}>
          <Unplug /> 断开
        </button>
      ) : (
        <button onClick={run(() => api.connConnect(h.id))}>
          <Plug /> 连接
        </button>
      )}
      <hr />
      <button onClick={run(() => useApp.getState().openEditor(h.id))}>
        <Pencil /> 编辑
      </button>
      <button
        onClick={run(async () => {
          await saveHost({ ...h, id: "", name: h.name + " 副本", passwordSecret: null, updatedAt: 0 });
          toast(h.passwordSecret ? "已复制（密码未复制，请编辑后填写）" : "已复制", "success");
        })}
      >
        <Copy /> 复制
      </button>
      <button
        onClick={run(async () => {
          const addr = `${h.username}@${h.host}` + (h.port !== 22 ? ` -p ${h.port}` : "");
          await navigator.clipboard.writeText(addr);
          toast("已复制 " + addr, "success");
        })}
      >
        <Link /> 复制地址
      </button>
      <hr />
      <button
        className="danger"
        onClick={() => {
          onClose();
          props.onDelete();
        }}
      >
        <Trash2 /> 删除
      </button>
    </div>
  );
}
