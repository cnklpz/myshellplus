// Upload/download progress strip shown at the bottom of the files panel.
import { listen } from "@tauri-apps/api/event";
import { ArrowDownToLine, ArrowUpFromLine, Check, Copy, FolderOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Bar, toast } from "../../components/ui";
import { api, errMsg, type TransferInfo } from "../../lib/api";
import { fmtBytes, fmtRate } from "../../lib/format";
import { useApp } from "../../store";
import { useContextMenu } from "../terminal/ContextMenu";

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Subscribes to transfer events; `onFinished` fires once per transfer that reaches "done". */
export function Transfers(props: { hostId: string; onFinished?: (t: TransferInfo) => void }) {
  const [map, setMap] = useState<Record<string, TransferInfo>>({});
  const menu = useContextMenu();
  const finishedCb = useRef(props.onFinished);
  finishedCb.current = props.onFinished;
  const seen = useRef(new Map<string, TransferInfo["state"]>());

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    listen<TransferInfo>("transfer", (e) => {
      const t = e.payload;
      if (t.hostId !== props.hostId) return;
      const prev = seen.current.get(t.id);
      seen.current.set(t.id, t.state);
      if (t.state === "done" && prev !== "done") finishedCb.current?.(t);
      if (t.state === "error" && prev !== "error") toast(`传输失败：${t.error ?? baseName(t.remote)}`, "error");
      setMap((m) => ({ ...m, [t.id]: t }));
    }).then((f) => (alive ? (unlisten = f) : f()));
    api
      .transferList()
      .then((list) => {
        if (!alive) return;
        setMap((m) => {
          const next = { ...m };
          for (const t of list)
            if (t.hostId === props.hostId && !next[t.id]) {
              next[t.id] = t;
              if (!seen.current.has(t.id)) seen.current.set(t.id, t.state);
            }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [props.hostId]);

  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast("已复制路径", "success"),
      () => toast("复制失败", "error"),
    );
  const cancel = (id: string) => api.transferCancel(id).catch((e) => toast(errMsg(e), "error"));

  const list = Object.values(map).sort((a, b) => (a.state === "running" ? 0 : 1) - (b.state === "running" ? 0 : 1));
  if (list.length === 0) return null;
  const running = list.filter((t) => t.state === "running").length;

  const clear = async () => {
    try {
      await api.transferClear();
      setMap((m) => Object.fromEntries(Object.entries(m).filter(([, t]) => t.state === "running")));
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  return (
    <div className="fp-tx">
      <div className="section-title">
        传输 {running > 0 && <span className="count">{running}/{list.length}</span>}
        <span className="spacer" />
        {running < list.length && (
          <button className="btn ghost sm" onClick={clear}>清除</button>
        )}
      </div>
      {list.map((t) => {
        const name = baseName(t.direction === "upload" ? t.local : t.remote);
        const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : t.state === "done" ? 100 : 0;
        const Icon = t.direction === "upload" ? ArrowUpFromLine : ArrowDownToLine;
        return (
          <div
            className="fp-tx-item"
            key={t.id}
            title={`${t.local}\n${t.remote}`}
            onContextMenu={(e) =>
              menu.open(e, [
                t.state === "running" && { label: "取消", icon: <X />, danger: true, onSelect: () => cancel(t.id) },
                t.state === "running" && "sep",
                {
                  label: "打开远程目录",
                  icon: <FolderOpen />,
                  onSelect: () => useApp.getState().openFilesAt(props.hostId, t.remote.replace(/\/[^/]*$/, "") || "/"),
                },
                { label: "复制远程路径", icon: <Copy />, onSelect: () => copy(t.remote) },
                { label: "复制本地路径", icon: <Copy />, onSelect: () => copy(t.local) },
              ])
            }
          >
            <Icon />
            <span className="ellipsis">{name}</span>
            <span className="meta num">
              {t.state === "running" || t.state === "done" ? fmtBytes(t.total) : t.state === "cancelled" ? "已取消" : ""}
            </span>
            {t.state === "running" ? (
              <button className="icon-btn" title="取消" onClick={() => cancel(t.id)}>
                <X />
              </button>
            ) : t.state === "done" ? (
              <Check className="ok" />
            ) : (
              <X className={t.state === "error" ? "err" : ""} />
            )}
            {t.state === "running" && (
              <div className="prog">
                <Bar value={pct} />
                <span className="num">{pct.toFixed(0)}%</span>
                <span className="num">{fmtRate(t.speed)}</span>
              </div>
            )}
            {t.state === "error" && (
              <div className="prog" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
                <span className="ellipsis selectable err" title={t.error ?? ""}>{t.error || "失败"}</span>
              </div>
            )}
          </div>
        );
      })}
      {menu.node}
    </div>
  );
}
