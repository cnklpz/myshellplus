// Live connect progress for a tab that is (re)connecting: one row per backend step with its duration.
import { Check, LoaderCircle, X } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { DialogHeader, HiddenContext, useEscClose } from "../../components/ui";
import { fmtMs } from "../../lib/format";
import { usePrivacy } from "../../lib/privacy";
import { DiagnosisView, exportConnLog, useDiagnose } from "../diagnostics/connLog";
import { type TermTab, useApp } from "../../store";
import { cancelConnect, retryConnect } from "./open";

/** Steps whose detail is an address (masked in privacy mode). */
const ADDR_STEPS = new Set(["解析地址", "TCP 连接", "经跳板机连接目标", "连接代理", "经代理连接目标"]);

export function ConnectDialog({ tab }: { tab: TermTab }) {
  const p = tab.connect!;
  const hosts = useApp((s) => s.hosts);
  const priv = usePrivacy();
  const failed = p.error !== undefined;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (failed) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [failed]);
  useEscClose(() => cancelConnect(tab.id), !useContext(HiddenContext));
  const diag = useDiagnose(tab.hostId);
  const { reset } = diag;
  useEffect(() => {
    if (!failed) reset();
  }, [failed, reset]);

  const host = hosts.find((h) => h.id === tab.hostId);
  const end = failed ? (p.failedAt ?? now) : now;
  const nameOf = (id: string) => {
    const h = hosts.find((x) => x.id === id);
    return h ? priv.text(h.name, h.host) : "";
  };
  const steps = p.steps.length ? p.steps : [{ hostId: tab.hostId, label: "准备连接", detail: null, at: p.started }];

  return (
    <div className="conn-dialog" role="dialog">
      <DialogHeader title={<>{failed ? "连接失败" : "正在连接"} {host ? priv.text(host.name, host.host) : priv.hostText(tab.title, tab.hostId)}</>}>
        <span className="conn-elapsed">{fmtMs(Math.max(0, end - p.started))}</span>
      </DialogHeader>
      <div className="conn-steps">
        {steps.map((s, i) => {
          const last = i === steps.length - 1;
          const state = !last ? "ok" : failed ? "err" : "run";
          const dur = (last ? end : steps[i + 1].at) - s.at;
          const jump = s.hostId !== tab.hostId;
          return (
            <div key={i} className={"conn-step " + state}>
              <span className="conn-step-icon">
                {state === "ok" ? <Check /> : state === "err" ? <X /> : <LoaderCircle className="spin" />}
              </span>
              <span className="conn-step-label">
                {jump && <span className="conn-step-jump">{nameOf(s.hostId)}</span>}
                {s.label}
              </span>
              <span className="conn-step-detail mono ellipsis">
                {s.detail && (ADDR_STEPS.has(s.label) ? priv.addr(s.detail) : priv.hostText(s.detail, tab.hostId))}
              </span>
              <span className="conn-step-dur">{fmtMs(Math.max(0, dur))}</span>
            </div>
          );
        })}
      </div>
      {failed && <div className="conn-error">{priv.hostText(p.error ?? "", tab.hostId)}</div>}
      {failed && (diag.busy || diag.text || diag.error) && (
        <div className="conn-diag">
          <DiagnosisView d={diag} hostId={tab.hostId} />
        </div>
      )}
      <div className="dialog-footer">
        {failed ? (
          <>
            <button className="btn sm" onClick={() => exportConnLog(tab.hostId)}>
              导出日志
            </button>
            <button className="btn sm" disabled={diag.busy} onClick={diag.run}>
              AI 诊断
            </button>
            <span className="spacer" />
            <button className="btn sm" onClick={() => cancelConnect(tab.id)}>
              关闭
            </button>
            <button className="btn sm primary" autoFocus onClick={() => retryConnect(tab.id)}>
              重试
            </button>
          </>
        ) : (
          <button className="btn sm" onClick={() => cancelConnect(tab.id)}>
            取消
          </button>
        )}
      </div>
    </div>
  );
}
