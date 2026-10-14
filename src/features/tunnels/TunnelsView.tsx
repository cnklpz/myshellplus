// Tunnel (port forwarding) management page.
import { Copy, CopyPlus, Network, Pencil, Play, Plus, Power, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Select } from "../../components/Select";
import { Confirm, Dialog, Empty, Field, Toggle, toast } from "../../components/ui";
import { api, errMsg, type TunnelDef, type TunnelStatus } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { useTauriEvent } from "../../lib/events";
import { fmtBytes } from "../../lib/format";
import { usePrivacy } from "../../lib/privacy";
import { useApp } from "../../store";
import { type MenuItem, useContextMenu } from "../terminal/ContextMenu";
import "./tunnels.css";

type Kind = TunnelDef["kind"];

const KIND_LABEL: Record<Kind, string> = { local: "本地 -L", remote: "远程 -R", dynamic: "动态 -D" };

/** `addr` masks the target host in privacy mode. */
function mapping(t: TunnelDef, addr: (a: string) => string = (a) => a, st?: TunnelStatus): string {
  // -R on port 0: the server picks the port; show it once the tunnel reports it.
  const port = t.kind === "remote" && t.bindPort === 0 && st?.remotePort ? st.remotePort : t.bindPort;
  const bind = `${t.bindAddr}:${port}`;
  if (t.kind === "dynamic") return `SOCKS5 ${bind}`;
  return `${bind} → ${addr(t.targetHost)}:${t.targetPort}`;
}

export function TunnelsView() {
  const hosts = useApp((s) => s.hosts);
  const panelHostId = useApp((s) => s.panelHostId);
  /** The host of the current SSH tab, if it still exists. */
  const curHost = panelHostId && hosts.some((h) => h.id === panelHostId) ? panelHostId : null;
  const [scope, setScope] = useState<"all" | "host">("host");
  const [list, setList] = useState<TunnelDef[] | null>(null);
  const [status, setStatus] = useState<Record<string, TunnelStatus>>({});
  const [editing, setEditing] = useState<Partial<TunnelDef> | null>(null);
  const [deleting, setDeleting] = useState<TunnelDef | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const refreshStatus = useCallback(async () => {
    try {
      const st = await api.tunnelStatus();
      setStatus(Object.fromEntries(st.map((s) => [s.id, s])));
    } catch {
      /* ignore polling errors */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setList(await api.tunnelList());
    } catch (e) {
      toast(errMsg(e), "error");
      setList([]);
    }
    await refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refreshStatus, 2000);
    return () => clearInterval(timer);
  }, [refresh, refreshStatus]);
  useTauriEvent("tunnels-changed", () => void refresh());

  const priv = usePrivacy();
  const hostName = (id: string) => {
    const h = hosts.find((x) => x.id === id);
    return h ? priv.text(h.name, h.host) : "（已删除）";
  };

  const toggleRun = async (t: TunnelDef) => {
    setBusy((b) => ({ ...b, [t.id]: true }));
    try {
      if (status[t.id]?.running) await api.tunnelStop(t.id);
      else await api.tunnelStart(t.id);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy((b) => ({ ...b, [t.id]: false }));
      refreshStatus();
    }
  };

  const setAuto = async (t: TunnelDef, autoStart: boolean) => {
    try {
      await api.tunnelSave({ ...t, autoStart });
      await refresh();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const menu = useContextMenu();
  const rowMenu = (t: TunnelDef): MenuItem[] => {
    const running = !!status[t.id]?.running;
    const port = t.kind === "remote" && t.bindPort === 0 && status[t.id]?.remotePort ? status[t.id]!.remotePort : t.bindPort;
    const bind = `${t.bindAddr}:${port}`;
    return [
      { label: running ? "停止" : "启动", icon: running ? <Square /> : <Play />, disabled: busy[t.id], onSelect: () => toggleRun(t) },
      { label: "编辑…", icon: <Pencil />, onSelect: () => setEditing({ ...t }) },
      { label: "复制隧道", icon: <CopyPlus />, onSelect: () => setEditing({ ...t, id: undefined, name: t.name ? `${t.name} 副本` : "", autoStart: false }) },
      "sep",
      { label: t.kind === "remote" ? "复制远程地址" : "复制本地地址", icon: <Copy />, onSelect: () => void copyText(bind, "地址") },
      t.kind !== "dynamic" && { label: "复制目标地址", icon: <Copy />, onSelect: () => void copyText(`${t.targetHost}:${t.targetPort}`, "地址") },
      { label: t.autoStart ? "关闭自启" : "打开自启", icon: <Power />, onSelect: () => setAuto(t, !t.autoStart) },
      "sep",
      { label: "删除…", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(t) },
    ];
  };

  const shown = useMemo(() => (list ?? []).filter((t) => scope === "all" || !curHost || t.hostId === curHost), [list, scope, curHost]);

  const newTunnel = () =>
    setEditing({ name: "", hostId: curHost ?? hosts[0]?.id ?? "", kind: "local", bindAddr: "127.0.0.1", bindPort: 8080, targetHost: "127.0.0.1", targetPort: 80, autoStart: false });

  return (
    <div className="page">
      <div className="page-header">
        <h1>隧道</h1>
        <span className="spacer" />
        {curHost && (
          <div className="seg">
            <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>全部</button>
            <button className={scope === "host" ? "on" : ""} onClick={() => setScope("host")}>当前</button>
          </div>
        )}
        <button className="btn primary sm" onClick={newTunnel}>
          <Plus />
          新建
        </button>
      </div>
      <div className="page-body">
        {list && shown.length === 0 ? (
          <Empty
            icon={<Network />}
            text={list.length === 0 ? "还没有隧道" : "当前服务器没有隧道"}
            action={
              <button className="btn sm" onClick={newTunnel}>
                <Plus />
                新建隧道
              </button>
            }
          />
        ) : (
          <div className="tn-list">
            <div className="tn-grid tn-head">
              <span />
              <span>名称</span>
              <span>类型</span>
              <span>服务器</span>
              <span className="num">流量 ↑ / ↓</span>
              <span className="num">连接</span>
              <span>自启</span>
              <span />
            </div>
            {shown.map((t) => {
              const st = status[t.id];
              const running = !!st?.running;
              const dot = st?.error ? "err" : running ? "ok" : "";
              return (
                <div key={t.id} className="tn-item hover-host" onContextMenu={(e) => menu.open(e, rowMenu(t))} onDoubleClick={(e) => !(e.target as Element).closest("button, input") && setEditing({ ...t })}>
                  <div className="tn-grid tn-row">
                    <span className={"dot " + dot} title={st?.error ? "出错" : running ? "运行中" : "已停止"} />
                    <div className="tn-main">
                      <span className="ellipsis tn-name" title={t.name}>{t.name || "未命名"}</span>
                      <span className="mono ellipsis selectable tn-map" title={mapping(t, priv.addr, st)}>{mapping(t, priv.addr, st)}</span>
                    </div>
                    <span className="tn-quiet">{KIND_LABEL[t.kind]}</span>
                    <span className="ellipsis tn-quiet" title={hostName(t.hostId)}>{hostName(t.hostId)}</span>
                    <span className="num tn-quiet">
                      {fmtBytes(st?.up ?? 0)} / {fmtBytes(st?.down ?? 0)}
                    </span>
                    <span className="num tn-quiet">{st?.active ?? 0}</span>
                    <Toggle on={t.autoStart} onChange={(v) => setAuto(t, v)} />
                    <div className="row gap-1 tn-actions">
                      <button className="btn sm tn-run" disabled={busy[t.id]} onClick={() => toggleRun(t)}>
                        {running ? <Square /> : <Play />}
                        {running ? "停止" : "启动"}
                      </button>
                      <button className="icon-btn hover-reveal" title="编辑" onClick={() => setEditing({ ...t })}>
                        <Pencil />
                      </button>
                      <button className="icon-btn danger hover-reveal" title="删除" onClick={() => setDeleting(t)}>
                        <Trash2 />
                      </button>
                    </div>
                  </div>
                  {st?.error && <div className="tn-err selectable">{st.error}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {menu.node}
      {editing && (
        <TunnelEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="删除隧道"
          message={`删除「${deleting.name || mapping(deleting, priv.addr)}」？运行中会先停止。`}
          confirmText="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const t = deleting;
            setDeleting(null);
            try {
              await api.tunnelDelete(t.id);
              await refresh();
            } catch (e) {
              toast(errMsg(e), "error");
            }
          }}
        />
      )}
    </div>
  );
}

/** Only where the user is likely to get it wrong; the flow line below explains the rest. */
const KIND_RISK: Partial<Record<Kind, string>> = {
  remote: "外部访问需开启 GatewayPorts",
};

const validPort = (s: string) => /^\d+$/.test(s) && +s >= 1 && +s <= 65535;

function TunnelEditor(props: { initial: Partial<TunnelDef>; onClose: () => void; onSaved: () => void }) {
  const hosts = useApp((s) => s.hosts);
  const init = props.initial;
  const [name, setName] = useState(init.name ?? "");
  const [hostId, setHostId] = useState(init.hostId ?? "");
  const [kind, setKind] = useState<Kind>(init.kind ?? "local");
  const [bindAddr, setBindAddr] = useState(init.bindAddr ?? "127.0.0.1");
  const [bindPort, setBindPort] = useState(String(init.bindPort ?? ""));
  const [targetHost, setTargetHost] = useState(init.targetHost ?? "127.0.0.1");
  const [targetPort, setTargetPort] = useState(String(init.targetPort ?? ""));
  const [autoStart, setAutoStart] = useState(!!init.autoStart);
  const [saving, setSaving] = useState(false);

  const needTarget = kind !== "dynamic";
  const errors: string[] = [];
  if (!hostId) errors.push("请选择服务器");
  if (!bindAddr.trim()) errors.push("请填写监听地址");
  if (!validPort(bindPort)) errors.push("监听端口需为 1-65535");
  if (needTarget && !targetHost.trim()) errors.push("请填写目标地址");
  if (needTarget && !validPort(targetPort)) errors.push("目标端口需为 1-65535");

  const save = async () => {
    if (errors.length) return;
    setSaving(true);
    try {
      await api.tunnelSave({
        ...init,
        name: name.trim(),
        hostId,
        kind,
        bindAddr: bindAddr.trim(),
        bindPort: +bindPort,
        targetHost: needTarget ? targetHost.trim() : "",
        targetPort: needTarget ? +targetPort : 0,
        autoStart,
      });
      props.onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const server = hosts.find((h) => h.id === hostId)?.name || "服务器";
  const bind = `${bindAddr.trim() || "?"}:${bindPort || "?"}`;
  const target = `${targetHost.trim() || "?"}:${targetPort || "?"}`;
  const flow =
    kind === "local" ? ["本机 " + bind, server, target] : kind === "remote" ? [server + " " + bind, "本机", target] : ["本机 " + bind, server, "任意地址"];

  const portCls = (s: string) => "input tn-port" + (s && !validPort(s) ? " tn-invalid" : "");

  return (
    <Dialog
      title={init.id ? "编辑隧道" : "新建隧道"}
      width={560}
      onClose={props.onClose}
      footer={
        <>
          {errors.length > 0 && <span className="grow ellipsis tn-foot-err">{errors[0]}</span>}
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn primary" disabled={saving || errors.length > 0} onClick={save}>保存</button>
        </>
      }
    >
      <div className="stack gap-3">
        <Field label="名称">
          <input className="input" value={name} placeholder="数据库" onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="服务器">
          <Select
            width="100%"
            value={hostId}
            placeholder="选择服务器"
            options={hosts.map((h) => ({ value: h.id, label: `${h.groupName ? `${h.groupName} / ` : ""}${h.name}` }))}
            onChange={setHostId}
          />
        </Field>
        <Field
          label="类型"
          hint={
            <div className="tn-kind-hint">
              {KIND_RISK[kind] && <span>{KIND_RISK[kind]}</span>}
              <span className="tn-flow mono">
                {flow.map((x, i) => (
                  <span key={i}>
                    {i > 0 && <span className="tn-arrow">→</span>}
                    {x}
                  </span>
                ))}
              </span>
            </div>
          }
        >
          <div className="seg">
            {(["local", "remote", "dynamic"] as Kind[]).map((k) => (
              <button key={k} type="button" className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </Field>
        <Field label={kind === "remote" ? "远程监听" : "本机监听"}>
          <input className="input mono" value={bindAddr} onChange={(e) => setBindAddr(e.target.value)} />
          <span className="faint">:</span>
          <input className={portCls(bindPort)} value={bindPort} placeholder="8080" inputMode="numeric" onChange={(e) => setBindPort(e.target.value.trim())} />
        </Field>
        {needTarget && (
          <Field label="目标地址">
            <input className="input mono" value={targetHost} onChange={(e) => setTargetHost(e.target.value)} />
            <span className="faint">:</span>
            <input className={portCls(targetPort)} value={targetPort} placeholder="80" inputMode="numeric" onChange={(e) => setTargetPort(e.target.value.trim())} />
          </Field>
        )}
        <Field label="自动启动">
          <Toggle on={autoStart} onChange={setAutoStart} />
        </Field>
      </div>
    </Dialog>
  );
}
