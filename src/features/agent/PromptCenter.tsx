// Dialogs for backend prompts: host key confirmation and agent approvals.
// Pending prompts are re-fetched on mount, so a webview reload doesn't lose them.
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog, toast } from "../../components/ui";
import { api, errMsg, type AgentPrompt, type HostKeyPrompt, type PromptEvent } from "../../lib/api";
import { onTauriEvent } from "../../lib/events";
import { usePrivacy } from "../../lib/privacy";
import "./PromptCenter.css";

const ACTIONS: Record<string, string> = {
  run_command: "执行命令",
  write_file: "写入文件",
  read_file: "读取文件",
  terminal_input: "向终端输入",
};

async function attention() {
  try {
    const w = getCurrentWindow();
    await w.requestUserAttention(UserAttentionType.Critical);
    await w.setFocus();
  } catch {
    /* permission missing or unsupported */
  }
}

export function PromptCenter() {
  const [queue, setQueue] = useState<PromptEvent[]>([]);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    let alive = true;
    const add = (evs: PromptEvent[]) =>
      setQueue((q) => {
        const ids = new Set(q.map((p) => p.id));
        const next = [...q, ...evs.filter((e) => !ids.has(e.id))];
        return next.sort((a, b) => a.created - b.created);
      });
    const remove = (id: string) => setQueue((q) => q.filter((p) => p.id !== id));
    const un = [
      onTauriEvent<PromptEvent>("prompt", (e) => add([e.payload])),
      onTauriEvent<string>("prompt-closed", (e) => remove(e.payload)),
    ];
    api
      .promptList()
      .then((list) => alive && add(list))
      .catch(() => {});
    return () => {
      alive = false;
      un.forEach((f) => f());
    };
  }, []);

  // Flash the window once for each new prompt.
  useEffect(() => {
    const fresh = queue.filter((p) => !seen.current.has(p.id));
    if (!fresh.length) return;
    fresh.forEach((p) => seen.current.add(p.id));
    attention();
  }, [queue]);

  const current = queue[0];
  if (!current) return null;
  const more = queue.length - 1;

  const answer = async (value: unknown) => {
    setQueue((q) => q.filter((p) => p.id !== current.id));
    try {
      await api.promptAnswer(current.id, value);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  if (current.kind === "hostkey") {
    return <HostKeyDialog key={current.id} ev={current as PromptEvent<HostKeyPrompt>} more={more} onAnswer={answer} />;
  }
  return <AgentDialog key={current.id} ev={current as PromptEvent<AgentPrompt>} more={more} onAnswer={answer} />;
}

function Pending({ n }: { n: number }) {
  return n > 0 ? <span className="faint pc-more">还有 {n} 个待处理</span> : null;
}

function useCountdown(expires: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.ceil((expires - now) / 1000));
}

function fmtSecs(s: number) {
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s} 秒`;
}

function HostKeyDialog(props: { ev: PromptEvent<HostKeyPrompt>; more: number; onAnswer: (v: unknown) => void }) {
  const d = props.ev.data;
  const left = useCountdown(props.ev.expires);
  const priv = usePrivacy();
  const addr = `${priv.addr(d.host)}:${d.port}`;
  return (
    <Dialog
      title={d.changed ? `主机密钥已改变 · ${addr}` : `首次连接 · ${addr}`}
      width={520}
      onClose={() => props.onAnswer(false)}
      footer={
        <>
          <Pending n={props.more} />
          <span className="spacer" />
          <span className="faint pc-timer">{fmtSecs(left)}</span>
          {d.changed ? (
            <>
              <button className="btn danger" onClick={() => props.onAnswer(true)}>仍然信任</button>
              <button className="btn primary" autoFocus onClick={() => props.onAnswer(false)}>拒绝</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => props.onAnswer(false)}>拒绝</button>
              <button className="btn primary" autoFocus onClick={() => props.onAnswer(true)}>信任并连接</button>
            </>
          )}
        </>
      }
    >
      <div className="stack gap-3">
        {d.changed && (
          <div className="pc-alert">
            <ShieldAlert />
            <span>可能遭到中间人攻击，未确认请拒绝</span>
          </div>
        )}
        <div className="kv loose">
          <span>算法</span>
          <span className="mono selectable">{d.algo}</span>
          {d.changed && (
            <>
              <span>原指纹</span>
              <code className="pc-code selectable pc-old">{d.oldFingerprint ?? "—"}</code>
            </>
          )}
          <span>{d.changed ? "新指纹" : "指纹"}</span>
          <code className="pc-code selectable">{d.fingerprint}</code>
        </div>
      </div>
    </Dialog>
  );
}

function AgentDialog(props: { ev: PromptEvent<AgentPrompt>; more: number; onAnswer: (v: unknown) => void }) {
  const d = props.ev.data;
  const left = useCountdown(props.ev.expires);
  const priv = usePrivacy();
  return (
    <Dialog
      title={
        <span className="row">
          Agent 请求
          {d.dangerous && <span className="pc-danger">高风险</span>}
        </span>
      }
      width={560}
      onClose={() => props.onAnswer({ approve: false })}
      footer={
        <>
          <Pending n={props.more} />
          <span className="spacer" />
          <span className="faint pc-timer">{fmtSecs(left)} 后自动拒绝</span>
          <button className="btn" autoFocus={d.dangerous} onClick={() => props.onAnswer({ approve: false })}>拒绝</button>
          <button
            className={"btn " + (d.dangerous ? "danger solid" : "primary")}
            autoFocus={!d.dangerous}
            onClick={() => props.onAnswer({ approve: true })}
          >
            允许
          </button>
        </>
      }
    >
      <div className="stack gap-3">
        <div className="kv loose">
          <span>服务器</span>
          <span className="ellipsis">
            {priv.text(d.hostName, d.host)} <span className="faint mono">{priv.addr(d.host)}</span>
          </span>
          <span>操作</span>
          <span>{ACTIONS[d.action] ?? d.action}</span>
          {d.reason && (
            <>
              <span>原因</span>
              <span className="muted selectable">{d.reason}</span>
            </>
          )}
        </div>
        <pre className={"pc-code pc-detail selectable" + (d.dangerous ? " danger" : "")}>{d.detail}</pre>
      </div>
    </Dialog>
  );
}
