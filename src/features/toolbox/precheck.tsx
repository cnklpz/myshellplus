// Pre-run checks: a read-only script built from the form values runs (debounced) before the Run button
// unlocks; its key=value output becomes a list of issues. "err" issues block running.
import { LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { errMsg } from "../../lib/api";
import { hasSudoPassword, parseKv, type RemoteEnv, runScript } from "../../lib/remote";
import type { Issue } from "./tools";

/** Privileged when that needs no prompt; otherwise as the login user (some facts may be unreadable). */
export const canPriv = (hostId: string, e: RemoteEnv) => e.root || e.sudo === "nopass" || (e.sudo === "pass" && hasSudoPassword(hostId));

export function usePreCheck(hostId: string, env: RemoteEnv, script: string | null, priv = true) {
  const [s, setS] = useState<{ script: string; r?: Record<string, string>; error?: string } | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!script) return;
    let live = true;
    const t = setTimeout(() => {
      runScript(hostId, env, script, { priv: priv && canPriv(hostId, env), quiet: true, timeout: 20 }).then(
        (r) => live && setS({ script, r: parseKv(r.stdout) }),
        (e) => live && setS({ script, error: errMsg(e) }),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [script, n]);
  const cur = script && s?.script === script ? s : null;
  return { result: cur?.r, error: cur?.error, pending: !!script && !cur, retry: () => setN((x) => x + 1) };
}

export function CheckList(props: { issues: Issue[]; pending: boolean; error?: string; onRetry: () => void; children?: ReactNode }) {
  return (
    <div className="tb-check">
      <div className="tb-check-title">执行前检查</div>
      {props.pending ? (
        <div className="tb-check-row faint">
          <LoaderCircle className="spin" />
          检查中
        </div>
      ) : props.error ? (
        <div className="tb-check-row">
          <span className="dot warn" />
          <span className="grow">检查失败：{props.error}</span>
          <button className="btn sm" onClick={props.onRetry}>重试</button>
        </div>
      ) : (
        (props.issues.length ? props.issues : [{ level: "ok", text: "未发现问题" } as Issue]).map((i) => (
          <div key={i.text} className="tb-check-row">
            <span className={"dot " + i.level} />
            <span>{i.text}</span>
          </div>
        ))
      )}
      {props.children}
    </div>
  );
}
