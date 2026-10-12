// SFTP file browser + transfers for one host (side panel).
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpFromLine,
  Copy,
  Download,
  Eye,
  EyeOff,
  File,
  FileCode,
  FilePlus,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  Home,
  KeyRound,
  Pencil,
  RefreshCw,
  SquareTerminal,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Confirm, Empty, toast } from "../../components/ui";
import { api, errMsg, type FileEntry, type TransferInfo } from "../../lib/api";
import { fmtBytes, fmtPerms, fmtTime } from "../../lib/format";
import { termBus } from "../../lib/termBus";
import { ChmodDialog, EditorDialog, NamePrompt } from "./FileDialogs";
import { Transfers } from "./Transfers";
import "./files.css";

type SortKey = "name" | "size" | "mtime";

const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
const parentOf = (p: string) => {
  if (!p || p === "/") return "/";
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
};
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const BINARY_EXT = new Set(
  "png jpg jpeg gif bmp ico webp zip gz tgz bz2 xz 7z rar tar jar war iso img bin exe dll so o a class pdf mp3 mp4 mkv avi mov wav flac woff woff2 ttf otf db sqlite pyc deb rpm".split(" "),
);
const isBinaryName = (n: string) => BINARY_EXT.has(n.split(".").pop()?.toLowerCase() ?? "");

function fmtMtime(sec: number): string {
  if (!sec) return "-";
  const d = new Date(sec * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  if (d.getFullYear() === new Date().getFullYear()) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function EntryIcon({ e }: { e: FileEntry }) {
  if (e.isDir) return e.isLink ? <FolderSymlink className="dir" /> : <Folder className="dir" />;
  if (e.isLink) return <FileSymlink />;
  return <File />;
}

interface Menu {
  x: number;
  y: number;
}

type Modal =
  | { kind: "edit"; entry: FileEntry }
  | { kind: "chmod"; entries: FileEntry[] }
  | { kind: "delete"; entries: FileEntry[] }
  | { kind: "mkdir" }
  | { kind: "touch" }
  | null;

export function FilesPanel({ hostId }: { hostId: string }) {
  const [cwd, setCwd] = useState("");
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [back, setBack] = useState<string[]>([]);
  const [fwd, setFwd] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const reqSeq = useRef(0);

  const load = useCallback(
    async (path: string, opts?: { push?: boolean; keepSel?: boolean }) => {
      const seq = ++reqSeq.current;
      setLoading(true);
      try {
        const r = await api.sftpList(hostId, path);
        if (seq !== reqSeq.current) return;
        const prev = cwdRef.current;
        if (opts?.push && prev && prev !== r.path) {
          setBack((b) => [...b.slice(-49), prev]);
          setFwd([]);
        }
        setCwd(r.path);
        setInput(r.path);
        setEntries(r.entries);
        setLoadError(null);
        setLoaded(true);
        if (!opts?.keepSel || prev !== r.path) {
          setSel(new Set());
          setAnchor(null);
          if (prev !== r.path) {
            setFilter("");
            listRef.current?.scrollTo(0, 0);
          }
        } else {
          const live = new Set(r.entries.map((e) => e.path));
          setSel((s) => new Set([...s].filter((p) => live.has(p))));
        }
      } catch (e) {
        if (seq !== reqSeq.current) return;
        const msg = errMsg(e);
        if (!cwdRef.current) setLoadError(msg);
        else toast(msg, "error");
        setInput(cwdRef.current);
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [hostId],
  );

  const refresh = useCallback(() => load(cwdRef.current, { keepSel: true }), [load]);

  useEffect(() => {
    load("");
  }, [load]);

  const navigate = (path: string) => load(path, { push: true });
  const goBack = () => {
    const p = back[back.length - 1];
    if (p === undefined) return;
    setBack(back.slice(0, -1));
    setFwd([...fwd, cwd]);
    load(p);
  };
  const goFwd = () => {
    const p = fwd[fwd.length - 1];
    if (p === undefined) return;
    setFwd(fwd.slice(0, -1));
    setBack([...back, cwd]);
    load(p);
  };

  // ---------- derived list ----------
  const view = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = entries.filter((e) => (showHidden || !e.name.startsWith(".")) && (!q || e.name.toLowerCase().includes(q)));
    const dir = sort.desc ? -1 : 1;
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let c = 0;
      if (sort.key === "size") c = a.size - b.size;
      else if (sort.key === "mtime") c = a.mtime - b.mtime;
      if (c === 0) c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      return c * dir;
    });
    return list;
  }, [entries, filter, showHidden, sort]);

  const selected = useMemo(() => view.filter((e) => sel.has(e.path)), [view, sel]);

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" }));

  // ---------- selection ----------
  const onRowClick = (e: React.MouseEvent, entry: FileEntry) => {
    if (e.shiftKey && anchor) {
      const a = view.findIndex((x) => x.path === anchor);
      const b = view.findIndex((x) => x.path === entry.path);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = view.slice(lo, hi + 1).map((x) => x.path);
        setSel(e.ctrlKey || e.metaKey ? new Set([...sel, ...range]) : new Set(range));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(sel);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      setSel(next);
    } else {
      setSel(new Set([entry.path]));
    }
    setAnchor(entry.path);
  };

  const openEntry = (entry: FileEntry) => {
    if (entry.isDir) navigate(entry.path);
    else if (isBinaryName(entry.name)) toast("二进制文件不支持在线编辑，请下载", "info");
    else setModal({ kind: "edit", entry });
  };

  // ---------- context menu ----------
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const onRowMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    if (!sel.has(entry.path)) {
      setSel(new Set([entry.path]));
      setAnchor(entry.path);
    }
    setMenu({ x: e.clientX, y: e.clientY });
  };
  const onBlankMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setSel(new Set());
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // ---------- actions ----------
  const download = async (list: FileEntry[]) => {
    const files = list.filter((e) => !e.isDir);
    if (files.length < list.length) toast("暂不支持下载文件夹", "info");
    if (!files.length) return;
    try {
      if (files.length === 1) {
        const local = await saveDialog({ defaultPath: files[0].name });
        if (!local) return;
        await api.transferStart(hostId, "download", local, files[0].path);
      } else {
        const dir = await openDialog({ directory: true, title: "选择保存目录" });
        if (!dir || Array.isArray(dir)) return;
        const sep = dir.includes("\\") ? "\\" : "/";
        for (const f of files) await api.transferStart(hostId, "download", dir.replace(/[\\/]+$/, "") + sep + f.name, f.path);
      }
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const uploadPaths = useCallback(
    async (paths: string[]) => {
      const dir = cwdRef.current;
      if (!dir || !paths.length) return;
      try {
        for (const p of paths) await api.transferStart(hostId, "upload", p, joinPath(dir, baseName(p)));
      } catch (e) {
        toast(errMsg(e), "error");
      }
    },
    [hostId],
  );

  const pickUpload = async () => {
    try {
      const r = await openDialog({ multiple: true, title: "上传文件" });
      if (!r) return;
      uploadPaths(Array.isArray(r) ? r : [r]);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const copyPath = async (list: FileEntry[]) => {
    const text = list.length ? list.map((e) => e.path).join("\n") : cwd;
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制路径", "success");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const cdInTerminal = (target: FileEntry | undefined) => {
    const t = termBus.active();
    if (!t) return toast("没有活动的终端", "error");
    const dir = target ? (target.isDir ? target.path : parentOf(target.path)) : cwd;
    t.run(`cd ${shQuote(dir)}`);
    t.focus();
  };

  const doRename = async (entry: FileEntry, name: string) => {
    setRenaming(null);
    const n = name.trim();
    if (!n || n === entry.name) return;
    if (n.includes("/")) return toast("名称不能包含 /", "error");
    try {
      await api.sftpRename(hostId, entry.path, joinPath(parentOf(entry.path), n));
      await refresh();
      setSel(new Set([joinPath(parentOf(entry.path), n)]));
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const doDelete = async (list: FileEntry[]) => {
    setModal(null);
    try {
      await api.sftpRemove(hostId, list.map((e) => e.path));
      toast(`已删除 ${list.length} 项`, "success");
      refresh();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const onTransferDone = useCallback(
    (t: TransferInfo) => {
      if (t.direction === "upload" && parentOf(t.remote) === cwdRef.current) refresh();
      if (t.direction === "download") toast(`已下载 ${baseName(t.local)}`, "success");
    },
    [refresh],
  );

  // ---------- OS drag & drop ----------
  useEffect(() => {
    let alive = true;
    let un: (() => void) | null = null;
    const inside = (pos: { x: number; y: number }) => {
      const el = rootRef.current;
      if (!el || el.offsetParent === null) return false;
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = pos.x / dpr;
      const y = pos.y / dpr;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === "enter" || p.type === "over") setDragOver(inside(p.position));
        else if (p.type === "leave") setDragOver(false);
        else if (p.type === "drop") {
          setDragOver(false);
          if (inside(p.position)) uploadPaths(p.paths);
        }
      })
      .then((f) => (alive ? (un = f) : f()))
      .catch(() => {});
    return () => {
      alive = false;
      un?.();
    };
  }, [uploadPaths]);

  // ---------- keyboard on the list ----------
  const onListKey = (e: React.KeyboardEvent) => {
    if (renaming || modal) return;
    if (e.key === "Delete" && selected.length) setModal({ kind: "delete", entries: selected });
    else if (e.key === "F2" && selected.length === 1) setRenaming(selected[0].path);
    else if (e.key === "Enter" && selected.length === 1) openEntry(selected[0]);
    else if (e.key === "Backspace") navigate(parentOf(cwd));
    else if (e.key === "F5") {
      e.preventDefault();
      refresh();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSel(new Set(view.map((x) => x.path)));
    } else return;
  };

  const one = selected.length === 1 ? selected[0] : undefined;
  const SortIcon = sort.desc ? ArrowDown : ArrowUp;
  const hiddenCount = showHidden ? 0 : entries.filter((e) => e.name.startsWith(".")).length;

  return (
    <div className="fp" ref={rootRef}>
      <div className="fp-bar">
        <div className="row">
          <button className="icon-btn" title="后退" disabled={!back.length} onClick={goBack}>
            <ArrowLeft />
          </button>
          <button className="icon-btn" title="前进" disabled={!fwd.length} onClick={goFwd}>
            <ArrowRight />
          </button>
          <button className="icon-btn" title="上级目录" disabled={!cwd || cwd === "/"} onClick={() => navigate(parentOf(cwd))}>
            <ArrowUp />
          </button>
          <button className="icon-btn" title="主目录" onClick={() => navigate("")}>
            <Home />
          </button>
          <input
            className="input sm mono grow"
            value={input}
            spellCheck={false}
            placeholder="路径"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(input.trim());
              else if (e.key === "Escape") setInput(cwd);
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button className={"icon-btn" + (loading ? " spin" : "")} title="刷新 (F5)" onClick={refresh}>
            <RefreshCw />
          </button>
        </div>
        <div className="row">
          <input className="input sm grow" placeholder="筛选" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button
            className={"icon-btn" + (showHidden ? " active" : "")}
            title={showHidden ? "隐藏点文件" : `显示隐藏文件${hiddenCount ? ` (${hiddenCount})` : ""}`}
            onClick={() => setShowHidden(!showHidden)}
          >
            {showHidden ? <Eye /> : <EyeOff />}
          </button>
          <button className="icon-btn" title="新建文件夹" disabled={!cwd} onClick={() => setModal({ kind: "mkdir" })}>
            <FolderPlus />
          </button>
          <button className="icon-btn" title="上传文件（也可拖放到此处）" disabled={!cwd} onClick={pickUpload}>
            <Upload />
          </button>
        </div>
      </div>

      <div className="fp-head fp-cols">
        <span />
        <button className={sort.key === "name" ? "on" : ""} onClick={() => toggleSort("name")}>
          名称 {sort.key === "name" && <SortIcon />}
        </button>
        <button className={"num" + (sort.key === "size" ? " on" : "")} onClick={() => toggleSort("size")}>
          {sort.key === "size" && <SortIcon />} 大小
        </button>
        <button className={"num" + (sort.key === "mtime" ? " on" : "")} onClick={() => toggleSort("mtime")}>
          {sort.key === "mtime" && <SortIcon />} 修改时间
        </button>
      </div>

      <div
        ref={listRef}
        className={"fp-list" + (loading && loaded ? " loading" : "")}
        tabIndex={0}
        onKeyDown={onListKey}
        onContextMenu={onBlankMenu}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && e.button === 0) setSel(new Set());
        }}
      >
        {loadError && !loaded ? (
          <Empty
            text={<span className="selectable">{loadError}</span>}
            action={
              <button className="btn sm" onClick={() => load("")}>
                <RefreshCw /> 重试
              </button>
            }
          />
        ) : !loaded ? (
          <div className="faint" style={{ padding: "var(--sp-2)", fontSize: "var(--fs-sm)" }}>加载中…</div>
        ) : view.length === 0 ? (
          <Empty text={filter ? "无匹配项" : "空目录"} />
        ) : (
          view.map((e) => (
            <div
              key={e.path}
              className={"list-row fp-cols" + (sel.has(e.path) ? " selected" : "")}
              onClick={(ev) => onRowClick(ev, e)}
              onDoubleClick={() => openEntry(e)}
              onContextMenu={(ev) => onRowMenu(ev, e)}
              title={`${e.name}\n${fmtPerms(e.perms, e.isDir)}  ${e.owner}\n${fmtTime(e.mtime * 1000)}`}
            >
              <EntryIcon e={e} />
              {renaming === e.path ? (
                <RenameInput initial={e.name} onDone={(n) => (n === null ? setRenaming(null) : doRename(e, n))} />
              ) : (
                <span className={"ellipsis" + (e.isLink ? " link" : "")}>{e.name}</span>
              )}
              <span className="num">{e.isDir ? "" : fmtBytes(e.size)}</span>
              <span className="num">{fmtMtime(e.mtime)}</span>
            </div>
          ))
        )}
      </div>

      <Transfers hostId={hostId} onFinished={onTransferDone} />

      {dragOver && <div className="fp-drop">松开以上传到 {baseName(cwd) || "/"}</div>}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {selected.length > 0 && (
            <>
              <MenuItem icon={one?.isDir ? FolderOpen : FileCode} disabled={!one} onClick={() => one && openEntry(one)}>
                {one?.isDir ? "打开" : "编辑"}
              </MenuItem>
              <MenuItem icon={Download} onClick={() => download(selected)}>下载</MenuItem>
              <MenuItem icon={Pencil} disabled={!one} onClick={() => one && setRenaming(one.path)}>重命名</MenuItem>
              <MenuItem icon={KeyRound} onClick={() => setModal({ kind: "chmod", entries: selected })}>修改权限</MenuItem>
              <MenuItem icon={Copy} onClick={() => copyPath(selected)}>复制路径</MenuItem>
              <MenuItem icon={SquareTerminal} disabled={selected.length > 1} onClick={() => cdInTerminal(one)}>在终端中 cd</MenuItem>
              <MenuItem icon={Trash2} danger onClick={() => setModal({ kind: "delete", entries: selected })}>删除</MenuItem>
              <hr />
            </>
          )}
          <MenuItem icon={FolderPlus} onClick={() => setModal({ kind: "mkdir" })}>新建文件夹</MenuItem>
          <MenuItem icon={FilePlus} onClick={() => setModal({ kind: "touch" })}>新建文件</MenuItem>
          <MenuItem icon={ArrowUpFromLine} onClick={pickUpload}>上传文件</MenuItem>
          {selected.length === 0 && (
            <>
              <MenuItem icon={Copy} onClick={() => copyPath([])}>复制当前路径</MenuItem>
              <MenuItem icon={SquareTerminal} onClick={() => cdInTerminal(undefined)}>在终端中 cd</MenuItem>
              <MenuItem icon={RefreshCw} onClick={refresh}>刷新</MenuItem>
            </>
          )}
        </ContextMenu>
      )}

      {modal?.kind === "edit" && (
        <EditorDialog hostId={hostId} path={modal.entry.path} name={modal.entry.name} onClose={() => setModal(null)} onSaved={refresh} />
      )}
      {modal?.kind === "chmod" && <ChmodDialog hostId={hostId} entries={modal.entries} onClose={() => setModal(null)} onDone={refresh} />}
      {modal?.kind === "delete" && (
        <Confirm
          title="删除"
          danger
          confirmText="删除"
          message={
            modal.entries.length === 1 ? (
              <>
                确定删除 <span className="mono">{modal.entries[0].path}</span>
                {modal.entries[0].isDir ? " 及其全部内容" : ""}？此操作不可撤销。
              </>
            ) : (
              <>确定删除选中的 {modal.entries.length} 项？文件夹将连同内容一起删除，此操作不可撤销。</>
            )
          }
          onCancel={() => setModal(null)}
          onConfirm={() => doDelete(modal.entries)}
        />
      )}
      {(modal?.kind === "mkdir" || modal?.kind === "touch") && (
        <NamePrompt
          title={modal.kind === "mkdir" ? "新建文件夹" : "新建文件"}
          label="名称"
          confirmText="创建"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            const p = joinPath(cwd, name);
            if (entries.some((e) => e.name === name)) throw "已存在同名项";
            if (modal.kind === "mkdir") await api.sftpMkdir(hostId, p);
            else await api.sftpWrite(hostId, p, "");
            await refresh();
            setSel(new Set([p]));
          }}
        />
      )}
    </div>
  );
}

function RenameInput(props: { initial: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = props.initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : props.initial.length);
  }, [props.initial]);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    props.onDone(v);
  };
  return (
    <input
      ref={ref}
      className="input sm mono"
      defaultValue={props.initial}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

function ContextMenu(props: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      left: Math.max(pad, Math.min(props.x, window.innerWidth - r.width - pad)),
      top: Math.max(pad, Math.min(props.y, window.innerHeight - r.height - pad)),
    });
  }, [props.x, props.y]);
  return (
    <div
      ref={ref}
      className="fp-menu"
      style={pos}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onClick={props.onClose}
    >
      {props.children}
    </div>
  );
}

function MenuItem(props: { icon: typeof File; danger?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={props.danger ? "danger" : ""} disabled={props.disabled} onClick={props.onClick}>
      <props.icon />
      {props.children}
    </button>
  );
}
