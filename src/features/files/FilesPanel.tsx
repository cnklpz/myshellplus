// SFTP file browser + transfers for one host (side panel).
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpFromLine,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileCode,
  FilePlus,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  FolderSync,
  FolderUp,
  Home,
  KeyRound,
  Link2,
  Loader2,
  PackageOpen,
  Pencil,
  RefreshCw,
  Scissors,
  SquareTerminal,
  Trash2,
  Upload,
} from "lucide-react";
import { usePanelItems } from "../side/panelMenu";
import { useContextMenu } from "../terminal/ContextMenu";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Confirm, Empty, SearchBox, toast } from "../../components/ui";
import { api, errMsg, type Conflict, type FileEntry, type TransferInfo } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { onTauriEvent } from "../../lib/events";
import { baseName, fmtBytes, fmtPerms, fmtTime } from "../../lib/format";
import { shq } from "../../lib/remote";
import { lsGet, lsSet } from "../../lib/storage";
import { termBus } from "../../lib/termBus";
import { useApp } from "../../store";
import { ChmodDialog, ConflictDialog, EditorDialog, NamePrompt } from "./FileDialogs";
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
const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;
/** A remote file name made safe as a local file name (mirrors `local_name` in transfer.rs). */
const localName = (name: string) => {
  let n = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
  // Windows drops trailing dots/spaces, and device names (nul, con.txt) open the device.
  const kept = n.replace(/[. ]+$/, "");
  if (kept.length < n.length) n = kept + "_";
  return WIN_RESERVED.test(n.split(".")[0].trimEnd()) ? "_" + n : n;
};
const localParent = (p: string) => p.replace(/[\\/][^\\/]*$/, "") || p;
const joinLocal = (dir: string, name: string) => {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
};

/** Formats `sftp_extract` understands (compound suffixes first), mirrored from transfer.rs. */
const ARCHIVE_EXT = [".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar.zst", ".tar", ".zip", ".jar", ".war", ".7z", ".rar", ".gz", ".bz2", ".xz", ".zst"];
const archiveStem = (name: string) => {
  const l = name.toLowerCase();
  const ext = ARCHIVE_EXT.find((x) => l.endsWith(x) && l.length > x.length);
  return ext ? name.slice(0, -ext.length) : null;
};
const clip16 = (s: string) => (s.length > 16 ? s.slice(0, 15) + "…" : s);

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

type Modal =
  | { kind: "edit"; entry: FileEntry }
  | { kind: "chmod"; entries: FileEntry[] }
  | { kind: "delete"; entries: FileEntry[] }
  | { kind: "mkdir" }
  | { kind: "touch" }
  | null;

let consumedJump = 0;

const FOLLOW_KEY = "files.followTerm";
const DL_KEY = "files.downloadDir";
const readFollow = () => lsGet(FOLLOW_KEY) === "1";

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
  const menu = useContextMenu();
  const panelExtra = usePanelItems();
  const [modal, setModal] = useState<Modal>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const [clip, setClip] = useState<{ mov: boolean; dir: string; paths: string[] } | null>(null);
  const [op, setOp] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ names: string[]; resolve: (c: Conflict | null) => void } | null>(null);
  const askConflict = useCallback((names: string[]) => new Promise<Conflict | null>((resolve) => setAsk({ names, resolve })), []);
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

  // "Open in files" from elsewhere (monitor). Runs after the initial load, so its request wins.
  const jump = useApp((s) => s.filesJump);
  useEffect(() => {
    if (!jump || jump.hostId !== hostId || jump.n === consumedJump) return;
    consumedJump = jump.n;
    load(jump.path, { push: true });
  }, [jump, hostId, load]);

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

  // ---------- terminal sync ----------
  // Paired terminal: the active tab when it's on this host, else the newest live tab for the host.
  const termTab = useApp((s) => {
    const a = s.tabs.find((t) => t.id === s.activeTab);
    if (a?.hostId === hostId && a.alive) return a.id;
    return [...s.tabs].reverse().find((t) => t.hostId === hostId && t.alive && !t.id.startsWith("pending"))?.id ?? null;
  });
  const [follow, setFollow] = useState(readFollow);
  const followWarned = useRef(false);
  const toggleFollow = () => {
    const next = !follow;
    setFollow(next);
    followWarned.current = false;
    lsSet(FOLLOW_KEY, next ? "1" : "0");
  };

  const pullTermCwd = useCallback(async () => {
    if (!termTab) return;
    try {
      const dir = await api.termCwd(termTab);
      if (!dir) {
        if (!followWarned.current) toast("无法获取终端目录", "error");
        followWarned.current = true;
      } else if (dir !== cwdRef.current) load(dir, { push: true });
    } catch {}
  }, [termTab, load]);

  // Follow: re-check after each Enter in the paired terminal (twice, to catch slower commands).
  useEffect(() => {
    if (!follow || !termTab) return;
    pullTermCwd();
    const timers: number[] = [];
    const un = onTauriEvent<string>("term-enter", (e) => {
      if (e.payload !== termTab) return;
      timers.push(window.setTimeout(pullTermCwd, 300), window.setTimeout(pullTermCwd, 1500));
    });
    return () => {
      un();
      timers.forEach(clearTimeout);
    };
  }, [follow, termTab, pullTermCwd]);

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
    else if (isBinaryName(entry.name)) toast("二进制文件无法编辑", "info");
    else setModal({ kind: "edit", entry });
  };

  // ---------- context menu ----------
  // Right-click on an unselected row selects just that row; on a selected row it acts on the whole selection.
  const onRowMenu = (e: React.MouseEvent, entry: FileEntry) => {
    let list = selected;
    if (!sel.has(entry.path)) {
      setSel(new Set([entry.path]));
      setAnchor(entry.path);
      list = [entry];
    }
    const one = list.length === 1 ? list[0] : undefined;
    const stem = one && !one.isDir ? archiveStem(one.name) : null;
    menu.open(e, [
      { label: one?.isDir ? "打开" : "编辑…", icon: one?.isDir ? <FolderOpen /> : <FileCode />, hint: "Enter", disabled: !one, onSelect: () => one && openEntry(one) },
      { label: "下载…", icon: <Download />, onSelect: () => download(list) },
      "sep",
      { label: "重命名", icon: <Pencil />, hint: "F2", disabled: !one, onSelect: () => one && setRenaming(one.path) },
      { label: "剪切", icon: <Scissors />, hint: "Ctrl+X", onSelect: () => toClip(list, true) },
      { label: "复制", icon: <Copy />, hint: "Ctrl+C", onSelect: () => toClip(list, false) },
      { label: "粘贴", icon: <ClipboardPaste />, hint: "Ctrl+V", disabled: !clip, onSelect: paste },
      "sep",
      { label: "复制路径", icon: <ClipboardCopy />, onSelect: () => copyPath(list) },
      "sep",
      one && stem !== null && { label: "解压到此处", icon: <PackageOpen />, disabled: !!op, onSelect: () => extract(one, false) },
      one && stem !== null && { label: "解压到文件夹", icon: <FolderOpen />, hint: clip16(stem) + "/", disabled: !!op, onSelect: () => extract(one, true) },
      { label: "压缩", icon: <FileArchive />, hint: "tar.gz", disabled: !!op, onSelect: () => compress(list) },
      { label: "修改权限…", icon: <KeyRound />, onSelect: () => setModal({ kind: "chmod", entries: list }) },
      { label: "终端 cd", icon: <SquareTerminal />, disabled: !termTab || !one, onSelect: () => cdInTerminal(one) },
      "sep",
      { label: "删除…", icon: <Trash2 />, hint: "Del", danger: true, onSelect: () => setModal({ kind: "delete", entries: list }) },
    ]);
  };
  const onBlankMenu = (e: React.MouseEvent) => {
    setSel(new Set());
    menu.open(e, [
      { label: "新建文件夹…", icon: <FolderPlus />, onSelect: () => setModal({ kind: "mkdir" }) },
      { label: "新建文件…", icon: <FilePlus />, onSelect: () => setModal({ kind: "touch" }) },
      "sep",
      { label: "上传文件…", icon: <ArrowUpFromLine />, onSelect: pickUpload },
      { label: "上传文件夹…", icon: <FolderUp />, onSelect: pickUploadDir },
      { label: "粘贴", icon: <ClipboardPaste />, hint: "Ctrl+V", disabled: !clip, onSelect: paste },
      "sep",
      { label: "复制路径", icon: <ClipboardCopy />, onSelect: () => copyPath([]) },
      { label: "终端 cd", icon: <SquareTerminal />, disabled: !termTab || !cwd, onSelect: () => cdInTerminal(undefined) },
      { label: "刷新", icon: <RefreshCw />, hint: "F5", onSelect: refresh },
      ...panelExtra(),
    ]);
  };

  // ---------- actions ----------
  /** Ask about the clashing names (if any). Returns the policy, or null when cancelled. */
  const resolveClash = async (clash: string[]): Promise<Conflict | null> => (clash.length ? askConflict(clash) : "rename");

  const download = async (list: FileEntry[]) => {
    if (!list.length) return;
    try {
      const last = lsGet(DL_KEY) ?? undefined;
      if (list.length === 1 && !list[0].isDir) {
        const name = localName(list[0].name);
        const local = await saveDialog({ defaultPath: last ? joinLocal(last, name) : name });
        if (!local) return;
        lsSet(DL_KEY, localParent(local));
        // The save dialog already asked about overwriting.
        await api.transferStart(hostId, "download", local, list[0].path, "overwrite");
        return;
      }
      const dir = await openDialog({ directory: true, title: "保存到", defaultPath: last });
      if (!dir || Array.isArray(dir)) return;
      lsSet(DL_KEY, dir);
      // Remote names may hold "\", ":" or be ".." on a hostile server: never let them leave the chosen folder.
      const targets = list.map((f) => ({ f, local: joinLocal(dir, localName(f.name)) }));
      const exists = await api.localExists(targets.map((t) => t.local));
      const policy = await resolveClash(targets.filter((_, i) => exists[i]).map((t) => t.f.name));
      if (!policy) return;
      for (const [i, t] of targets.entries()) {
        if (exists[i] && policy === "skip") continue;
        await api.transferStart(hostId, "download", t.local, t.f.path, exists[i] ? policy : "rename");
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
        const names = new Set(entriesRef.current.map((e) => e.name));
        const clash = paths.filter((p) => names.has(baseName(p)));
        const policy = clash.length ? await askConflict(clash.map(baseName)) : "rename";
        if (!policy) return;
        for (const p of paths) {
          const hit = names.has(baseName(p));
          if (hit && policy === "skip") continue;
          // "rename" for names not seen in the listing: something created meanwhile is never clobbered.
          await api.transferStart(hostId, "upload", p, joinPath(dir, baseName(p)), hit ? policy : "rename");
        }
      } catch (e) {
        toast(errMsg(e), "error");
      }
    },
    [hostId, askConflict],
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

  const pickUploadDir = async () => {
    try {
      const r = await openDialog({ directory: true, multiple: true, title: "上传文件夹" });
      if (!r) return;
      uploadPaths(Array.isArray(r) ? r : [r]);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  /** One remote shell operation at a time, shown under the list while it runs. */
  const runOp = async (label: string, fn: () => Promise<void>) => {
    if (op) return toast("有操作正在进行", "info");
    setOp(label);
    try {
      await fn();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setOp(null);
    }
  };

  const toClip = (list: FileEntry[], mov: boolean) => {
    if (!list.length) return;
    setClip({ mov, dir: cwd, paths: list.map((e) => e.path) });
    toast(`已${mov ? "剪切" : "复制"} ${list.length} 项`, "info");
  };

  const paste = async () => {
    const c = clip;
    const dest = cwdRef.current;
    if (!c || !dest) return;
    if (c.mov && c.dir === dest) return;
    const names = new Set(entriesRef.current.map((e) => e.name));
    // Copies into the same folder always get numbered names (the backend handles that).
    const clash = c.dir === dest ? [] : c.paths.filter((p) => names.has(baseName(p)));
    const policy = await resolveClash(clash.map(baseName));
    if (!policy) return;
    const srcs = policy === "skip" ? c.paths.filter((p) => !clash.includes(p)) : c.paths;
    if (!srcs.length) return;
    await runOp(`${c.mov ? "移动" : "复制"} ${srcs.length} 项`, async () => {
      await api.sftpPaste(hostId, srcs, dest, c.mov, policy);
      if (c.mov) setClip(null);
      toast(`已${c.mov ? "移动" : "复制"} ${srcs.length} 项`, "success");
      await refresh();
    });
  };

  const extract = (entry: FileEntry, toFolder: boolean) =>
    runOp(`解压 ${entry.name}`, async () => {
      const dest = await api.sftpExtract(hostId, entry.path, toFolder);
      toast("已解压", "success");
      await refresh();
      if (toFolder) setSel(new Set([dest]));
    });

  const compress = (list: FileEntry[]) =>
    runOp(`压缩 ${list.length === 1 ? list[0].name : `${list.length} 项`}`, async () => {
      const archive = await api.sftpCompress(hostId, list.map((e) => e.path));
      toast(`已压缩为 ${baseName(archive)}`, "success");
      await refresh();
      setSel(new Set([archive]));
    });

  const copyPath = async (list: FileEntry[]) => {
    await copyText(list.length ? list.map((e) => e.path).join("\n") : cwd, "路径");
  };

  const cdInTerminal = (target: FileEntry | undefined) => {
    const t = termTab ? termBus.get(termTab) : undefined;
    if (!t) return toast("没有活动的终端", "error");
    const dir = target ? (target.isDir ? target.path : parentOf(target.path)) : cwd;
    t.run(`cd ${shq(dir)}`);
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
      if (t.direction === "download") toast(`已下载 ${baseName(t.local)}${t.isDir ? `（${t.filesDone} 个文件）` : ""}`, "success");
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
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x") && selected.length) {
      e.preventDefault();
      toClip(selected, e.key.toLowerCase() === "x");
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && clip) {
      e.preventDefault();
      paste();
    } else if (e.key === "Escape" && clip) {
      setClip(null);
    } else return;
  };

  const cutSet = useMemo(() => new Set(clip?.mov ? clip.paths : []), [clip]);
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
          <span className="fp-sep" />
          <input
            className="fp-path"
            value={input}
            spellCheck={false}
            placeholder="/home/user"
            title={cwd}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(input.trim());
              else if (e.key === "Escape") setInput(cwd);
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button className="icon-btn" title="刷新 (F5)" onClick={refresh}>
            <RefreshCw className={loading ? "spin" : undefined} />
          </button>
          <button
            className={"icon-btn" + (follow ? " active" : "")}
            title={follow ? "停止跟随终端目录" : "跟随终端目录"}
            disabled={!termTab}
            onClick={toggleFollow}
          >
            <Link2 />
          </button>
          <button className="icon-btn" title="终端 cd 到此目录" disabled={!termTab || !cwd} onClick={() => cdInTerminal(undefined)}>
            <FolderSync />
          </button>
        </div>
        <div className="row">
          <SearchBox size="sm" className="grow" placeholder="筛选" value={filter} onChange={setFilter} />
          <button
            className={"icon-btn" + (showHidden ? " active" : "")}
            title={showHidden ? "不显示隐藏文件" : `显示隐藏文件${hiddenCount ? ` (${hiddenCount})` : ""}`}
            onClick={() => setShowHidden(!showHidden)}
          >
            {showHidden ? <Eye /> : <EyeOff />}
          </button>
          <button className="icon-btn" title="新建文件夹" disabled={!cwd} onClick={() => setModal({ kind: "mkdir" })}>
            <FolderPlus />
          </button>
          <button
            className="icon-btn"
            title="上传"
            disabled={!cwd}
            onClick={(e) =>
              menu.open(e, [
                { label: "上传文件…", icon: <ArrowUpFromLine />, onSelect: pickUpload },
                { label: "上传文件夹…", icon: <FolderUp />, onSelect: pickUploadDir },
              ])
            }
          >
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
          {sort.key === "mtime" && <SortIcon />} 修改
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
          <div className="fp-loading">加载中…</div>
        ) : view.length === 0 ? (
          <Empty text={filter ? "无匹配项" : "空目录"} />
        ) : (
          view.map((e) => (
            <div
              key={e.path}
              className={"list-row fp-cols" + (sel.has(e.path) ? " selected" : "") + (cutSet.has(e.path) ? " cut" : "")}
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
              <span className="num size">{e.isDir ? "" : fmtBytes(e.size)}</span>
              <span className="num time">{fmtMtime(e.mtime)}</span>
            </div>
          ))
        )}
      </div>

      <div className="fp-float">
        {op && (
          <div className="fp-op">
            <Loader2 className="spin" />
            <span className="ellipsis">{op}…</span>
          </div>
        )}
        <Transfers hostId={hostId} onFinished={onTransferDone} />
      </div>

      {dragOver && <div className="fp-drop">上传到 {baseName(cwd) || "/"}</div>}

      {menu.node}

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
                删除 <span className="mono">{modal.entries[0].path}</span>
                {modal.entries[0].isDir ? " 及其全部内容" : ""}？无法恢复。
              </>
            ) : (
              <>删除 {modal.entries.length} 项（含文件夹内容）？无法恢复。</>
            )
          }
          onCancel={() => setModal(null)}
          onConfirm={() => doDelete(modal.entries)}
        />
      )}
      {ask && (
        <ConflictDialog
          names={ask.names}
          onChoose={(c) => {
            ask.resolve(c);
            setAsk(null);
          }}
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
