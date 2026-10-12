// Full command shown before anything runs on a server, with how it runs and its risk.
import { Copy, LoaderCircle, Play, SquareTerminal } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { ExecResult } from "../lib/api";
import { copyText } from "../lib/clipboard";
import "./command-preview.css";

export type Risk = "read" | "change" | "high";

const RISK: Record<Risk, string> = { read: "只读", change: "修改系统", high: "高风险" };

export function CommandPreview(props: {
  script: string;
  /** "通过 sudo 执行" etc. */
  runAs: string;
  risk: Risk;
  note?: string;
  /** Secrets passed on stdin, described (never shown). */
}) {
  return (
    <div className="cp">
      <div className="cp-head">
        <span className={"cp-risk " + props.risk}>{RISK[props.risk]}</span>
        <span className="faint">{props.runAs}</span>
        <span className="grow" />
        <button
          className="icon-btn sm"
          title="复制命令"
          onClick={() => void copyText(props.script, "命令")}
        >
          <Copy />
        </button>
      </div>
      <pre className="cp-code mono selectable">{props.script}</pre>
      {props.note && (
        <div className={"cp-note" + (props.risk === "high" ? " high" : "")}>
          {props.note}
        </div>
      )}
    </div>
  );
}

/** Run button: high-risk commands need a second click to confirm. */
export function RunButton(props: { risk: Risk; busy: boolean; disabled?: boolean; term?: boolean; label?: string; onRun: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const high = props.risk === "high";
  return (
    <button
      className={"btn sm" + (high ? " danger" + (armed ? " solid" : "") : " primary")}
      disabled={props.busy || props.disabled}
      onClick={() => {
        if (high && !armed) return setArmed(true);
        setArmed(false);
        props.onRun();
      }}
    >
      {props.busy ? <LoaderCircle className="spin" /> : props.term ? <SquareTerminal /> : <Play />}
      {props.busy ? "执行中…" : armed ? "确认执行" : (props.label ?? (props.term ? "在终端执行" : "执行"))}
    </button>
  );
}

/** Output of a finished command. `view` renders stdout visually (null = not parseable); a toggle switches to raw text. */
export function ExecOutput(props: { result: ExecResult | null; error?: string | null; view?: (stdout: string) => ReactNode | null }) {
  const r = props.result;
  const [raw, setRaw] = useState(false);
  const visual = useMemo(() => {
    if (!r || !props.view || !r.stdout.trim()) return null;
    try {
      return props.view(r.stdout);
    } catch {
      return null;
    }
  }, [r, props.view]);
  if (!r && !props.error) return null;
  const ok = r && r.exitCode === 0 && !r.timedOut;
  const text = props.error ?? [r!.stdout.trimEnd(), r!.stderr.trimEnd()].filter(Boolean).join("\n");
  const showVisual = !!visual && !raw && !props.error;
  return (
    <div className="cp-out">
      <div className="cp-out-head">
        <span className={"dot " + (ok ? "ok" : "err")} />
        <span className={ok ? "" : "cp-fail"}>
          {props.error ? "失败" : r!.timedOut ? "超时" : ok ? "完成" : `退出码 ${r!.exitCode ?? "?"}`}
        </span>
        {r && <span className="faint cp-ms">{(r.durationMs / 1000).toFixed(1)}s</span>}
        {visual && !props.error && (
          <div className="seg cp-seg">
            <button className={raw ? "" : "on"} onClick={() => setRaw(false)}>视图</button>
            <button className={raw ? "on" : ""} onClick={() => setRaw(true)}>原始</button>
          </div>
        )}
      </div>
      {showVisual ? <div className="cp-view">{visual}</div> : text && <pre className="cp-code mono selectable">{text}</pre>}
    </div>
  );
}
