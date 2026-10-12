// Startup update prompt: release notes + install. Installing restarts the app.
import { Markdown } from "../../components/Markdown";
import { Dialog } from "../../components/ui";
import { closeUpdateDialog, installUpdate, useUpdate, useUpdateDialog } from "../../lib/updater";

export function UpdateDialog() {
  const open = useUpdateDialog();
  const u = useUpdate();
  if (!open || (u.phase !== "available" && u.phase !== "downloading" && u.phase !== "error")) return null;
  const downloading = u.phase === "downloading";
  const close = () => !downloading && closeUpdateDialog();
  return (
    <Dialog
      title={u.phase === "error" ? "更新失败" : `新版本 ${u.version}`}
      width={560}
      onClose={close}
      footer={
        <>
          <span className={"grow upd-note" + (u.phase === "error" ? " set-err" : "")}>
            {u.phase === "error" ? u.message : downloading ? `下载中 ${u.pct ?? 0}%` : "安装后将重启，SSH 连接会断开"}
          </span>
          <button className="btn" disabled={downloading} onClick={close}>
            {u.phase === "error" ? "关闭" : "稍后"}
          </button>
          {u.phase !== "error" && (
            <button className="btn primary" disabled={downloading} onClick={() => installUpdate()}>
              安装并重启
            </button>
          )}
        </>
      }
    >
      {u.phase === "available" && (u.notes.trim() ? <Markdown text={u.notes.trim()} className="upd-notes" /> : <div className="upd-note">无更新说明</div>)}
      {downloading && (
        <div className="bar thin">
          <i style={{ width: `${u.pct ?? 0}%` }} />
        </div>
      )}
    </Dialog>
  );
}
