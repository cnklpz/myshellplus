// Host right-click menu, shared by the sidebar host rows, the home host cards, the overview and the
// terminal tabs, so every place lists the same items in the same order.
import { CopyPlus, Gauge, Link, Pencil, Plug, SquareTerminal, Stethoscope, Trash2, Unplug } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useState } from "react";
import { Confirm, toast } from "../../components/ui";
import { api, errMsg, type Host } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { useApp } from "../../store";
import { usePrivacy } from "../../lib/privacy";
import { DiagnoseDialog } from "../diagnostics/connLog";
import { ContextMenu, type MenuItem } from "../terminal/ContextMenu";
import { openTerminal } from "../terminal/open";
import { probeHosts } from "../home/probe";

/** "user@host" plus ":port" when it is not 22. */
export function hostAddr(h: Host) {
  return `${h.username}@${h.host}` + (h.port !== 22 ? `:${h.port}` : "");
}

/** Copy the real address; the toast never shows it, so privacy mode holds. */
export function copyHostAddr(h: Host) {
  return copyText(hostAddr(h), "地址");
}

async function duplicateHost(h: Host) {
  await api.hostSave({ ...h, id: "", name: h.name + " 副本", passwordSecret: null, proxySecret: null, updatedAt: 0 });
  await useApp.getState().refreshHosts();
  toast(h.passwordSecret || h.proxySecret ? "已创建副本，密码需重新填写" : "已创建副本", "success");
}

function run(fn: () => unknown) {
  return () => {
    Promise.resolve()
      .then(fn)
      .catch((e) => toast(errMsg(e), "error"));
  };
}

/** Place-specific items, appended to the matching group of the shared menu. */
export interface HostMenuExtra {
  /** After 打开终端 / 连接. */
  open?: MenuItem[];
  /** After 编辑 / 创建副本 / 复制地址. */
  edit?: MenuItem[];
  /** After 测速 / 连接诊断. */
  own?: MenuItem[];
  /** A group of its own just before the danger item (e.g. closing tabs). */
  tail?: MenuItem[];
}

export function hostMenuItems(
  h: Host,
  opts: {
    /** Connection state from `conn[h.id]?.state`. */
    state?: string;
    /** Set when the last connect failed; the item stays visible but disabled otherwise. */
    onDiagnose?: () => void;
    onDelete: () => void;
    /** Show the sidebar's list shortcuts (Enter / Delete) as hints. */
    listKeys?: boolean;
    extra?: HostMenuExtra;
  },
): MenuItem[] {
  const up = opts.state === "connected" || opts.state === "connecting";
  const x = opts.extra ?? {};
  return [
    { label: "打开终端", icon: <SquareTerminal />, hint: opts.listKeys ? "Enter" : undefined, onSelect: run(() => openTerminal(h.id)) },
    up
      ? { label: "断开", icon: <Unplug />, onSelect: run(() => api.connDisconnect(h.id)) }
      : { label: "连接", icon: <Plug />, onSelect: run(() => api.connConnect(h.id)) },
    ...(x.open ?? []),
    "sep",
    { label: "编辑…", icon: <Pencil />, onSelect: () => useApp.getState().openEditor(h.id) },
    { label: "创建副本", icon: <CopyPlus />, onSelect: run(() => duplicateHost(h)) },
    { label: "复制地址", icon: <Link />, onSelect: () => void copyHostAddr(h) },
    ...(x.edit ?? []),
    "sep",
    { label: "测速", icon: <Gauge />, onSelect: run(() => probeHosts([h.id])) },
    { label: "连接诊断…", icon: <Stethoscope />, disabled: !opts.onDiagnose, onSelect: () => opts.onDiagnose?.() },
    ...(x.own ?? []),
    "sep",
    ...(x.tail ?? []),
    "sep",
    { label: "删除…", icon: <Trash2 />, hint: opts.listKeys ? "Del" : undefined, danger: true, onSelect: opts.onDelete },
  ];
}

/** The delete confirmation and diagnose dialog behind a host menu, for places that have neither. */
export function useHostDialogs() {
  const [deleting, setDeleting] = useState<Host | null>(null);
  const [diagnosing, setDiagnosing] = useState<Host | null>(null);
  const priv = usePrivacy();

  /** `hostMenuItems` options wired to these dialogs. */
  const optsFor = (h: Host) => {
    const { conn, failures } = useApp.getState();
    const st = conn[h.id]?.state;
    return {
      state: st,
      onDiagnose: failures[h.id] || st === "error" ? () => setDiagnosing(h) : undefined,
      onDelete: () => setDeleting(h),
    };
  };

  const node = (
    <>
      {diagnosing && (
        <DiagnoseDialog
          hostId={diagnosing.id}
          name={priv.text(diagnosing.name, diagnosing.host)}
          error={useApp.getState().failures[diagnosing.id]?.error ?? useApp.getState().conn[diagnosing.id]?.error ?? undefined}
          onClose={() => setDiagnosing(null)}
        />
      )}
      {deleting && (
        <Confirm
          title="删除服务器"
          message={`删除「${priv.text(deleting.name, deleting.host)}」及其保存的密码，并断开连接。`}
          confirmText="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const h = deleting;
            setDeleting(null);
            run(async () => {
              await api.hostDelete(h.id);
              await useApp.getState().refreshHosts();
            })();
          }}
        />
      )}
    </>
  );
  return { optsFor, node };
}

/** Host menu with its own delete confirmation and diagnose dialog, for lists that have neither. */
export function useHostMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; host: Host } | null>(null);
  const dialogs = useHostDialogs();

  const open = (e: ReactMouseEvent, host: Host) => {
    if (e.isDefaultPrevented() || !(e.currentTarget as Node).contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, host });
  };

  const items: MenuItem[] = menu ? hostMenuItems(menu.host, dialogs.optsFor(menu.host)) : [];

  const node = (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {dialogs.node}
    </>
  );
  return { open, node };
}
