// Live connect progress for a tab that is (re)connecting: one row per backend step with its duration.
import { Check, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useEscClose } from "../../components/ui";
import { usePrivacy } from "../../lib/privacy";
import { type TermTab, useApp } from "../../store";
import { cancelConnect, retryConnect } from "./open";

/** Steps whose detail is an address (masked in privacy mode). */
const ADDR_STEPS = new Set(["解析地址", "TCP 连接", "经跳板机连接目标"]);
const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

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
  useEscClose(() => cancelConnect(tab.id));

  const host = hosts.find((h) => h.id === tab.hostId);
  const end = failed ? (p.failedAt ?? now) : now;
  const nameOf = (id: string) => {
    const h = hosts.find((x) => x.id === id);
    return h ? priv.text(h.name, h.host) : "";
  };
  const steps = p.steps.length ? p.steps : [{ hostId: tab.hostId, label: "准备连接", detail: null, at: p.started }];

  return (
    <div className="conn-dialog" role="dialog">
      <div className="conn-head">
        <span className="ellipsis grow">
          {failed ? "连接失败" : "正在连接"} {host ? priv.text(host.name, host.host) : tab.title}
        </span>
        <span className="conn-elapsed">{fmtMs(Math.max(0, end - p.started))}</span>
      </div>
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
                {s.detail && ADDR_STEPS.has(s.label) ? priv.addr(s.detail) : s.detail}
              </span>
              <span className="conn-step-dur">{fmtMs(Math.max(0, dur))}</span>
            </div>
          );
        })}
      </div>
      {failed && <div className="conn-error">{p.error}</div>}
      <div className="conn-foot">
        {failed ? (
          <>
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
