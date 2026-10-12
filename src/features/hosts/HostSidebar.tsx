// Left sidebar: grouped host list, search, context menu, drag to regroup, hidden groups.
import { ChevronDown, ChevronRight, Copy, Eye, EyeOff, Link, Pencil, Plug, Plus, SquareTerminal, Trash2, Unplug } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Confirm, Empty, toast } from "../../components/ui";
import { api, errMsg, type Host } from "../../lib/api";
import { flip, hideDiscard, hideSlot, settle, showDiscard, showSlot, snapshotRects } from "../../lib/dragSlot";
import { setGroupOrder, sortByGroupOrder, useGroupOrder } from "../../lib/groupOrder";
import { nameIsAddr, usePrivacy } from "../../lib/privacy";
import { useApp } from "../../store";
import { openTerminal } from "../terminal/open";
import "./hosts.css";
import { GlobalSearch } from "../../components/GlobalSearch";

const UNGROUPED = "未分组";
const COLLAPSE_KEY = "hostGroupsCollapsed";
const HIDDEN_KEY = "hostGroupsHidden";
/** Collapse key of the "已隐藏" section (cannot clash with a group name). */
const HIDDEN_SECTION = "\u0000hidden";

function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
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

/** Save several hosts: the list updates at once, then each is saved (all rolled back on failure). */
async function saveHosts(list: Host[]) {
  const st = useApp.getState();
  const before = st.hosts;
  const patch = new Map(list.map((h) => [h.id, h]));
  useApp.setState({ hosts: before.map((h) => patch.get(h.id) ?? h) });
  try {
    for (const h of list) await api.hostSave(h);
  } catch (e) {
    useApp.setState({ hosts: before });
    throw e;
  }
  await st.refreshHosts().catch(() => {});
}

async function openTerm(id: string) {
  try {
    await openTerminal(id);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

interface Menu { x: number; y: number; host: Host }
interface GroupMenu { x: number; y: number; group: string }
/** Live arrangement while dragging a host: group order and host ids per group. */
interface Arrange { order: string[]; items: Record<string, string[]> }
interface Group { name: string; items: Host[] }

/** `header` renders between the search bar and the host list (the sidebar puts page links there). */
export function HostSidebar(props: { header?: ReactNode } = {}) {
  const hosts = useApp((s) => s.hosts);
  const conn = useApp((s) => s.conn);
  const openEditor = useApp((s) => s.openEditor);
  const priv = usePrivacy();

  // Search lives in the global palette (Ctrl+P); the list itself is unfiltered.
  const query = "";
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const c = load<Record<string, boolean>>(COLLAPSE_KEY, {});
    return HIDDEN_SECTION in c ? c : { ...c, [HIDDEN_SECTION]: true };
  });
  const [hidden, setHidden] = useState<string[]>(() => load<string[]>(HIDDEN_KEY, []));
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenu | null>(null);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const [live, setLive] = useState<Arrange | null>(null);
  const [groupLive, setGroupLive] = useState<string[] | null>(null);
  const [dragHost, setDragHost] = useState<string | null>(null);
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [dropInto, setDropInto] = useState<string | null>(null);
  const groupOrder = useGroupOrder();
  const listRef = useRef<HTMLDivElement>(null);


  const q = query.trim().toLowerCase();
  const baseGroups = useMemo(() => {
    const map = new Map<string, Host[]>();
    for (const h of hosts) {
      if (!matches(h, q)) continue;
      const g = h.groupName.trim() || UNGROUPED;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(h);
    }
    const list: Group[] = [...map.entries()].map(([name, items]) => ({
      name,
      items: items.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "zh-CN")),
    }));
    list.sort((a, b) => (a.name === UNGROUPED ? 1 : b.name === UNGROUPED ? -1 : a.name.localeCompare(b.name, "zh-CN")));
    return sortByGroupOrder(list, groupOrder);
  }, [hosts, q, groupOrder]);

  const arrangement = useMemo<Arrange>(
    () => ({ order: baseGroups.map((g) => g.name), items: Object.fromEntries(baseGroups.map((g) => [g.name, g.items.map((h) => h.id)])) }),
    [baseGroups],
  );

  // While dragging, render the live arrangement instead of the saved one.
  const groups = useMemo(() => {
    if (!live && !groupLive) return baseGroups;
    const byId = new Map(hosts.map((h) => [h.id, h]));
    const byName = new Map(baseGroups.map((g) => [g.name, g]));
    return (groupLive ?? live!.order)
      .filter((name) => byName.has(name))
      .map((name) => ({
        name,
        items: live ? live.items[name].map((id) => byId.get(id)).filter((h): h is Host => !!h) : byName.get(name)!.items,
      }));
  }, [baseGroups, live, groupLive, hosts]);

  const shownGroups = useMemo(() => groups.filter((g) => !hidden.includes(g.name)), [groups, hidden]);
  const hiddenGroups = useMemo(() => groups.filter((g) => hidden.includes(g.name)), [groups, hidden]);
  const hiddenOpen = !!q || !collapsed[HIDDEN_SECTION];

  // Hosts in display order (searching expands every group).
  const visible = useMemo(
    () => [...shownGroups, ...(hiddenOpen ? hiddenGroups : [])].flatMap((g) => (q || !collapsed[g.name] ? g.items : [])),
    [shownGroups, hiddenGroups, hiddenOpen, collapsed, q],
  );

  const toggleGroup = (name: string) => {
    const next = { ...collapsed, [name]: !collapsed[name] };
    setCollapsed(next);
    save(COLLAPSE_KEY, next);
  };

  const setGroupHidden = (name: string, hide: boolean) => {
    const next = hidden.filter((g) => g !== name);
    if (hide) next.push(name);
    setHidden(next);
    save(HIDDEN_KEY, next);
  };

  // Selection only highlights the row; the side panel follows the active terminal tab, not clicks here.
  const select = (id: string) => setSelected(id);

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


  // Pointer-based sortable drag (HTML5 DnD is swallowed by the webview's file-drop handler on Windows).
  // The dragged row stays in flow at its target slot (siblings make room, FLIP) and is translated to
  // follow the pointer; a dashed slot box marks where it lands. React re-renders only when the slot changes.
  const els = useRef(new Map<string, HTMLElement>());
  const flipFrom = useRef<Map<string, DOMRect> | null>(null);
  const dragRef = useRef<{ key: string; place: () => void } | null>(null);
  const suppressClick = useRef(false);
  const reg = (key: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(key, el);
    else els.current.delete(key);
  };

  // After each slot change: slide siblings, keep the dragged row glued to the pointer, move the slot box.
  useLayoutEffect(() => {
    const from = flipFrom.current;
    flipFrom.current = null;
    if (from) flip(els.current, from, dragRef.current?.key);
    dragRef.current?.place();
  }, [live, groupLive]);

  /** Common drag loop: threshold, rAF-throttled place + hitTest, edge auto-scroll, settle on release. */
  const runDrag = (
    e: React.MouseEvent,
    key: string,
    opts: {
      start: () => void;
      hitTest: (x: number, y: number) => void;
      /** Back to the arrangement from before the drag (pointer left the list). */
      reset: () => void;
      drop: (committed: boolean) => void;
    },
  ) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const r0 = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const grabX = sx - r0.left;
    const grabY = sy - r0.top;
    let active = false;
    let px = sx;
    let py = sy;
    let frame = 0;
    let scrollTimer = 0;
    let out = false;

    const place = () => {
      const el = els.current.get(key);
      const list = listRef.current;
      if (!el || !list || out) return;
      const lr = list.getBoundingClientRect();
      const slotY = lr.top + list.clientTop + el.offsetTop - list.scrollTop;
      // Vertical list: move on the y axis only, kept inside the list so it is never clipped.
      const top = lr.top + list.clientTop;
      const y = Math.max(top, Math.min(py - grabY, top + list.clientHeight - el.offsetHeight));
      el.style.transform = `translate3d(0, ${y - slotY}px, 0)`;
      showSlot(el);
    };
    const autoScroll = () => {
      const list = listRef.current;
      if (list && !out) {
        const r = list.getBoundingClientRect();
        const edge = 32;
        const dy = py < r.top + edge ? py - (r.top + edge) : py > r.bottom - edge ? py - (r.bottom - edge) : 0;
        if (dy) {
          const before = list.scrollTop;
          list.scrollTop += Math.max(-16, Math.min(16, dy / 2));
          if (list.scrollTop !== before) {
            place();
            opts.hitTest(px, py);
          }
        }
      }
      scrollTimer = requestAnimationFrame(autoScroll);
    };
    const move = (ev: MouseEvent) => {
      px = ev.clientX;
      py = ev.clientY;
      if (!active) {
        if (Math.abs(px - sx) + Math.abs(py - sy) < 4) return;
        active = true;
        dragRef.current = { key, place };
        document.body.classList.add("hs-dragging");
        window.getSelection()?.removeAllRanges();
        opts.start();
        scrollTimer = requestAnimationFrame(autoScroll);
      }
      ev.preventDefault();
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const r = listRef.current?.getBoundingClientRect();
        const nowOut = !r || px < r.left || px > r.right || py < r.top || py > r.bottom;
        if (nowOut !== out) {
          out = nowOut;
          const el = els.current.get(key);
          if (out) {
            // Outside the list: the row slides home, a red "放弃" copy follows the pointer.
            hideSlot();
            if (el) {
              showDiscard(el, px - grabX, py - grabY, "hs-list");
              settle(el);
            }
            flipFrom.current = snapshotRects(els.current);
            opts.reset();
          } else hideDiscard();
        }
        if (out) showDiscard(els.current.get(key)!, px - grabX, py - grabY, "hs-list");
        if (out) return;
        place();
        opts.hitTest(px, py);
      });
    };
    const end = (committed: boolean) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", key_, true);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(scrollTimer);
      if (!active) return;
      document.body.classList.remove("hs-dragging");
      dragRef.current = null;
      hideDiscard();
      hideSlot();
      const el = els.current.get(key);
      if (el) settle(el);
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false));
      opts.drop(committed);
    };
    const up = () => end(!out);
    const key_ = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && active) {
        ev.preventDefault();
        ev.stopPropagation();
        end(false);
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", key_, true);
  };

  /** Layout midpoint of a row (ignores FLIP transforms, so sliding rows can't make the target flicker). */
  const rowMid = (el: HTMLElement) => {
    const list = listRef.current!;
    return list.getBoundingClientRect().top + list.clientTop + el.offsetTop - list.scrollTop + el.offsetHeight / 2;
  };

  const startHostDrag = (e: React.MouseEvent, host: Host) => {
    let arr: Arrange = arrangement;
    let into: string | null = null; // collapsed group under the pointer: drop appends there
    runDrag(e, "h:" + host.id, {
      start: () => {
        setDragHost(host.id);
        setLive(arr);
      },
      reset: () => {
        arr = arrangement;
        setLive(arr);
        if (into) setDropInto((into = null));
      },
      hitTest: (x, y) => {
        const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-host], [data-group-head]");
        if (!hit) return;
        let group: string;
        let at: number;
        if (hit.dataset.host) {
          if (hit.dataset.host === host.id) return;
          group = hit.dataset.group!;
          const ids = arr.items[group].filter((id) => id !== host.id);
          at = ids.indexOf(hit.dataset.host) + (y > rowMid(hit) ? 1 : 0);
        } else {
          group = hit.dataset.groupHead!;
          if (collapsed[group]) {
            if (into !== group) setDropInto((into = group));
            return;
          }
          at = 0;
        }
        if (into) setDropInto((into = null));
        const items: Record<string, string[]> = {};
        for (const g of arr.order) items[g] = arr.items[g].filter((id) => id !== host.id);
        items[group] = [...items[group].slice(0, at), host.id, ...items[group].slice(at)];
        if (arr.order.every((g) => items[g].join() === arr.items[g].join())) return;
        arr = { order: arr.order, items };
        flipFrom.current = snapshotRects(els.current);
        setLive(arr);
      },
      drop: (committed) => {
        setDragHost(null);
        setDropInto(null);
        setLive(null);
        if (!committed) return;
        const target = into ?? arr.order.find((g) => arr.items[g].includes(host.id))!;
        const ids = into ? [...arr.items[into].filter((id) => id !== host.id), host.id] : arr.items[target];
        const groupName = target === UNGROUPED ? "" : target;
        const byId = new Map(hosts.map((h) => [h.id, h]));
        const changed = ids
          .map((id) => byId.get(id)!)
          .map((h, i) => ({ before: h, after: { ...h, groupName: h.id === host.id ? groupName : h.groupName, sort: i * 10 } }))
          .filter(({ before, after }) => before.sort !== after.sort || before.groupName !== after.groupName);
        const moved = host.groupName.trim() !== groupName;
        if (!changed.length || (!moved && ids.join() === arrangement.items[target]?.join())) return;
        const msg = moved ? `已移动到「${target}」` : "已调整顺序";
        saveHosts(changed.map((c) => c.after))
          .then(() =>
            toast(msg, "success", {
              label: "撤回",
              run: () => saveHosts(changed.map((c) => c.before)).catch((err) => toast(errMsg(err), "error")),
            }),
          )
          .catch((err) => toast(errMsg(err), "error"));
      },
    });
  };

  const startGroupDrag = (e: React.MouseEvent, name: string) => {
    const isHidden = hidden.includes(name);
    const initial = groups.map((g) => g.name);
    let order = initial;
    runDrag(e, "g:" + name, {
      start: () => {
        setDragGroup(name);
        setGroupLive(order);
      },
      reset: () => {
        order = initial;
        setGroupLive(order);
      },
      hitTest: (_x, y) => {
        // Only reorder within the same section (shown / hidden); compare against layout midpoints.
        const others = order.filter((n) => n !== name && hidden.includes(n) === isHidden);
        let idx = others.length;
        for (let i = 0; i < others.length; i++) {
          const el = els.current.get("g:" + others[i]);
          if (el && y < rowMid(el)) {
            idx = i;
            break;
          }
        }
        const section = [...others.slice(0, idx), name, ...others.slice(idx)];
        const rest = order.filter((n) => hidden.includes(n) !== isHidden);
        const next = isHidden ? [...rest, ...section] : [...section, ...rest];
        if (next.join("\n") === order.join("\n")) return;
        order = next;
        flipFrom.current = snapshotRects(els.current);
        setGroupLive(order);
      },
      drop: (committed) => {
        setDragGroup(null);
        setGroupLive(null);
        if (!committed || order.join("\n") === initial.join("\n")) return;
        const saved = groupOrder;
        setGroupOrder(order);
        toast("已调整分组顺序", "success", { label: "撤回", run: () => setGroupOrder(saved) });
      },
    });
  };

  const renderGroup = (g: Group) => {
    const isCollapsed = !!dragGroup || (!q && !!collapsed[g.name]);
    return (
      <div key={g.name}>
        <div
          ref={reg("g:" + g.name)}
          className={
            "list-row hs-group" + (dropInto === g.name ? " drop" : "") + (dragGroup === g.name ? " dragging" : "")
          }
          data-group-head={g.name}
          onMouseDown={(e) => startGroupDrag(e, g.name)}
          onClick={() => !suppressClick.current && toggleGroup(g.name)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setGroupMenu({ x: e.clientX, y: e.clientY, group: g.name });
          }}
        >
          <span className="hs-icon">{isCollapsed ? <ChevronRight /> : <ChevronDown />}</span>
          <span className="grow ellipsis">{g.name}</span>
          <span className="meta">{g.items.length}</span>
        </div>
        {!isCollapsed &&
          g.items.map((h) => (
            <div
              key={h.id}
              ref={reg("h:" + h.id)}
              data-host={h.id}
              data-group={g.name}
              className={
                "list-row hs-host" + (selected === h.id ? " selected" : "") + (dragHost === h.id ? " dragging" : "")
              }
              title={`${h.username}@${priv.addr(h.host)}:${h.port}`}
              onMouseDown={(e) => startHostDrag(e, h)}
              onClick={() => {
                if (suppressClick.current) return;
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
              {h.color && <span className="marker" style={{ background: h.color }} />}
              <span className="hs-icon">
                <span className={connDot(conn[h.id]?.state)} />
              </span>
              <span className="name ellipsis">{priv.text(h.name, h.host)}</span>
              {!nameIsAddr(h.name, h.host) && <span className="meta hs-addr">{priv.addr(h.host)}</span>}
            </div>
          ))}
      </div>
    );
  };

  return (
    <div className="hs">
      <div className="hs-bar">
        <GlobalSearch />
        <button className="icon-btn md" title="新建服务器" onClick={() => openEditor("")}>
          <Plus />
        </button>
      </div>

      {props.header}

      {hosts.length === 0 ? (
        <Empty
          text="还没有服务器"
          action={
            <button className="btn sm primary" onClick={() => openEditor("")}>
              <Plus /> 新建服务器
            </button>
          }
        />
      ) : (
        <>
          <div className="hs-list" ref={listRef} tabIndex={0} onKeyDown={onListKey}>
            {groups.length === 0 && <div className="empty">无匹配结果</div>}
            {shownGroups.map(renderGroup)}
            {hiddenGroups.length > 0 && (
              <div className="hs-hidden">
                <div className="list-row hs-group" onClick={() => toggleGroup(HIDDEN_SECTION)}>
                  <span className="hs-icon">{hiddenOpen ? <ChevronDown /> : <ChevronRight />}</span>
                  <span className="grow ellipsis">已隐藏</span>
                  <span className="meta">{hiddenGroups.length}</span>
                </div>
                {hiddenOpen && <div className="hs-hidden-body">{hiddenGroups.map(renderGroup)}</div>}
              </div>
            )}
          </div>
        </>
      )}

      {groupMenu && (
        <MenuBox x={groupMenu.x} y={groupMenu.y} onClose={() => setGroupMenu(null)}>
          {hidden.includes(groupMenu.group) ? (
            <button
              onClick={() => {
                setGroupMenu(null);
                setGroupHidden(groupMenu.group, false);
              }}
            >
              <Eye /> 取消隐藏
            </button>
          ) : (
            <button
              onClick={() => {
                setGroupMenu(null);
                setGroupHidden(groupMenu.group, true);
              }}
            >
              <EyeOff /> 隐藏分组
            </button>
          )}
        </MenuBox>
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
          message={`删除「${deleting.name}」及其保存的密码，并断开连接。`}
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

/** Context menu shell: closes on outside click / Esc / blur and stays inside the window. */
function MenuBox(props: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const { x, y, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

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
      x: Math.min(x, window.innerWidth - r.width - 4),
      y: Math.min(y, window.innerHeight - r.height - 4),
    });
  }, [x, y]);

  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {props.children}
    </div>
  );
}

function HostMenu(props: { menu: Menu; state?: string; onClose: () => void; onDelete: () => void }) {
  const { menu, onClose } = props;
  const h = menu.host;

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
    <MenuBox x={menu.x} y={menu.y} onClose={onClose}>
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
          toast(h.passwordSecret ? "已复制，密码需重新填写" : "已复制", "success");
        })}
      >
        <Copy /> 复制
      </button>
      <button
        onClick={run(async () => {
          const addr = `${h.username}@${h.host}` + (h.port !== 22 ? ` -p ${h.port}` : "");
          await navigator.clipboard.writeText(addr);
          toast("已复制 " + (useApp.getState().privacy ? "地址" : addr), "success");
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
    </MenuBox>
  );
}
