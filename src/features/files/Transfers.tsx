// Upload/download queue: a card floating over the bottom of the files list. Collapsed it shows the
// overall progress; clicking it expands the full task list.
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, ChevronUp, CircleAlert, Copy, FolderDown, FolderOpen, FolderUp, Loader2, Minus, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Bar, toast } from "../../components/ui";
import { api, errMsg, type TransferInfo } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { onTauriEvent } from "../../lib/events";
import { baseName, fmtBytes, fmtRate } from "../../lib/format";
import { chainAddrs, maskText, usePrivacy } from "../../lib/privacy";
import { useApp } from "../../store";
import { useContextMenu } from "../terminal/ContextMenu";

const active = (t: TransferInfo) => t.state === "running" || t.state === "queued";
const ORDER: Record<TransferInfo["state"], number> = { running: 0, queued: 1, error: 2, cancelled: 3, skipped: 4, done: 5 };

/** Subscribes to transfer events; `onFinished` fires once per transfer that reaches "done". */
export function Transfers(props: { hostId: string; onFinished?: (t: TransferInfo) => void }) {
  const [map, setMap] = useState<Record<string, TransferInfo>>({});
  const [open, setOpen] = useState(false);
  const menu = useContextMenu();
  const priv = usePrivacy();
  const finishedCb = useRef(props.onFinished);
  finishedCb.current = props.onFinished;
  const seen = useRef(new Map<string, TransferInfo["state"]>());

  useEffect(() => {
    let alive = true;
    const unlisten = onTauriEvent<TransferInfo>("transfer", (e) => {
      const t = e.payload;
      if (t.hostId !== props.hostId) return;
      const prev = seen.current.get(t.id);
      seen.current.set(t.id, t.state);
      if (t.state === "done" && prev !== "done") finishedCb.current?.(t);
      if (t.state === "error" && prev !== "error") {
        const why = t.error ?? baseName(t.remote);
        toast(`传输失败：${useApp.getState().privacy ? maskText(why, chainAddrs(t.hostId)) : why}`, "error");
      }
      setMap((m) => ({ ...m, [t.id]: t }));
    });
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
      unlisten();
    };
  }, [props.hostId]);

  const copy = (text: string) => copyText(text, "路径");
  const cancel = (id: string) => api.transferCancel(id).catch((e) => toast(errMsg(e), "error"));
  const retry = (id: string) => api.transferRetry(id).catch((e) => toast(errMsg(e), "error"));
  const reveal = (path: string) => revealItemInDir(path).catch((e) => toast(errMsg(e), "error"));

  const list = Object.values(map).sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  if (list.length === 0) return null;
  const busy = list.filter(active).length;
  const failedCount = list.filter((t) => t.state === "error").length;
  // Only running jobs know their size; queued ones would make the percentage jump back as they start.
  const running = list.filter((t) => t.state === "running");
  const queued = busy - running.length;
  const runTotal = running.reduce((n, t) => n + t.total, 0);
  const runPct = runTotal ? Math.min(100, (running.reduce((n, t) => n + t.done, 0) / runTotal) * 100) : 0;
  const runSpeed = running.reduce((n, t) => n + t.speed, 0);
  const summary =
    running.length > 0 ? `${running.length} 项传输中${queued ? `，${queued} 项排队` : ""}`
    : queued > 0 ? `${queued} 项排队中`
    : failedCount > 0 ? `${failedCount} 项失败`
    : `${list.length} 项已完成`;

  const clear = async () => {
    try {
      await api.transferClear();
      setMap((m) => Object.fromEntries(Object.entries(m).filter(([, t]) => active(t))));
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  return (
    <div className={"fp-tx" + (open ? " open" : "")}>
      {open && (
      <div className="fp-tx-list">
      {list.map((t) => {
        const up = t.direction === "upload";
        const name = baseName(up ? t.local : t.remote);
        const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : t.state === "done" ? 100 : 0;
        const Icon = t.isDir ? (up ? FolderUp : FolderDown) : up ? ArrowUpFromLine : ArrowDownToLine;
        const failed = t.state === "error" || t.state === "cancelled";
        const meta =
          t.state === "queued" ? "排队中"
          : t.state === "skipped" ? "已跳过"
          : t.state === "cancelled" ? "已取消"
          : t.state === "error" ? ""
          : t.isDir && t.state === "running" ? `${t.filesDone}/${t.filesTotal}`
          : fmtBytes(t.total);
        return (
          <div
            className="fp-tx-item"
            key={t.id}
            title={`${t.local}\n${t.remote}`}
            onContextMenu={(e) =>
              menu.open(e, [
                { label: "重试", icon: <RotateCw />, disabled: !failed, onSelect: () => retry(t.id) },
                {
                  label: "打开远程目录",
                  icon: <FolderOpen />,
                  onSelect: () => useApp.getState().openFilesAt(props.hostId, t.remote.replace(/\/[^/]*$/, "") || "/"),
                },
                !up && { label: "打开本地目录", icon: <FolderOpen />, disabled: t.state !== "done", onSelect: () => reveal(t.local) },
                "sep",
                { label: "复制远程路径", icon: <Copy />, onSelect: () => copy(t.remote) },
                { label: "复制本地路径", icon: <Copy />, onSelect: () => copy(t.local) },
                "sep",
                { label: "取消", icon: <X />, danger: true, disabled: !active(t), onSelect: () => cancel(t.id) },
              ])
            }
          >
            <Icon />
            <span className="ellipsis">{name}</span>
            <span className="meta num">{meta}</span>
            {active(t) ? (
              <button className="icon-btn sm" title="取消" onClick={() => cancel(t.id)}>
                <X />
              </button>
            ) : failed ? (
              <button className="icon-btn sm" title="重试" onClick={() => retry(t.id)}>
                <RotateCw />
              </button>
            ) : t.state === "done" ? (
              <Check className="ok" />
            ) : (
              <Minus />
            )}
            {t.state === "running" && (
              <div className="prog">
                <Bar value={pct} thin />
                <span className="num">{pct.toFixed(0)}%</span>
                <span className="num">{fmtRate(t.speed)}</span>
              </div>
            )}
            {t.state === "error" && (
              <div className="prog msg">
                <span className="ellipsis selectable err" title={priv.hostText(t.error ?? "", t.hostId)}>{t.error ? priv.hostText(t.error, t.hostId) : "失败"}</span>
              </div>
            )}
          </div>
        );
      })}
      </div>
      )}
      <div
        className="fp-tx-head"
        role="button"
        tabIndex={0}
        title={open ? "收起" : "展开全部任务"}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open))}
      >
        {busy > 0 ? <Loader2 className="spin" /> : failedCount > 0 ? <CircleAlert className="err" /> : <Check className="ok" />}
        <span className="ellipsis">{summary}</span>
        {running.length > 0 ? (
          <span className="meta num">
            {runPct.toFixed(0)}% · {fmtRate(runSpeed)}
          </span>
        ) : busy > 0 ? (
          <span />
        ) : (
          <button
            className="btn ghost sm"
            onClick={(e) => {
              e.stopPropagation();
              clear();
              setOpen(false);
            }}
          >
            清除
          </button>
        )}
        {open ? <ChevronDown /> : <ChevronUp />}
        {running.length > 0 && <div className="fp-tx-bar"><Bar value={runPct} thin /></div>}
      </div>
      {menu.node}
    </div>
  );
}
