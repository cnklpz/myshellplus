// Connection failure tools: export the last connect attempt's log, and ask AI what went wrong.
import { save } from "@tauri-apps/plugin-dialog";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "../../components/Markdown";
import { Dialog, toast } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { usePrivacy } from "../../lib/privacy";
import { useApp } from "../../store";
import "./logs.css";

/** "20261012-1403" for file names. */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Save the host's last connect attempt; redacted while privacy mode is on. */
export async function exportConnLog(hostId: string) {
  try {
    const path = await save({ defaultPath: `myshellplus-conn-${fileStamp()}.log`, filters: [{ name: "日志", extensions: ["log", "txt"] }] });
    if (!path) return;
    await api.connLogExport(hostId, path, useApp.getState().privacy);
    toast("日志已导出", "success");
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export type Diagnosis = { busy: boolean; text: string | null; error: string | null };

/** AI diagnosis of a host's last failed connect. `reset` clears it (e.g. on retry). */
export function useDiagnose(hostId: string) {
  const [state, setState] = useState<Diagnosis>({ busy: false, text: null, error: null });
  const seq = useRef(0);
  useEffect(() => () => void seq.current++, []);
  const run = useCallback(async () => {
    const my = ++seq.current;
    setState({ busy: true, text: null, error: null });
    try {
      const text = await api.connDiagnose(hostId);
      if (my === seq.current) setState({ busy: false, text, error: null });
    } catch (e) {
      if (my === seq.current) setState({ busy: false, text: null, error: errMsg(e) });
    }
  }, [hostId]);
  const reset = useCallback(() => {
    seq.current++;
    setState({ busy: false, text: null, error: null });
  }, []);
  return { ...state, run, reset };
}

/** `hostId` masks that connection's addresses in privacy mode. */
export function DiagnosisView(props: { d: Diagnosis; hostId: string }) {
  const { d } = props;
  const priv = usePrivacy();
  if (d.busy)
    return (
      <div className="diag-out diag-busy">
        <LoaderCircle className="spin" />
        AI 分析中…
      </div>
    );
  if (d.error) return <div className="diag-out diag-err selectable">{priv.hostText(d.error, props.hostId)}</div>;
  if (d.text) return <Markdown className="diag-out diag-md selectable" text={priv.hostText(d.text, props.hostId)} />;
  return null;
}

/** Last failure of a host + AI diagnosis (opened from the host card menu). */
export function DiagnoseDialog(props: { hostId: string; name: string; error?: string; onClose: () => void }) {
  const diag = useDiagnose(props.hostId);
  const { run } = diag;
  const priv = usePrivacy();
  useEffect(() => {
    run();
  }, [run]);
  return (
    <Dialog
      title={`连接诊断 · ${props.name}`}
      width={560}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={() => exportConnLog(props.hostId)}>
            导出日志
          </button>
          <span className="spacer" />
          <button className="btn" disabled={diag.busy} onClick={run}>
            重新诊断
          </button>
          <button className="btn primary" onClick={props.onClose}>
            关闭
          </button>
        </>
      }
    >
      <div className="stack gap-3">
        {props.error && <div className="diag-out diag-err selectable">{priv.hostText(props.error, props.hostId)}</div>}
        <DiagnosisView d={diag} hostId={props.hostId} />
      </div>
    </Dialog>
  );
}
