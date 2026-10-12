// Dialogs for backend prompts: host key confirmation and agent approvals.
// Pending prompts are re-fetched on mount, so a webview reload doesn't lose them.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog, toast } from "../../components/ui";
import { api, errMsg, type AgentPrompt, type HostKeyPrompt, type PromptEvent } from "../../lib/api";
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
      listen<PromptEvent>("prompt", (e) => add([e.payload])),
      listen<string>("prompt-closed", (e) => remove(e.payload)),
    ];
    api
      .promptList()
      .then((list) => alive && add(list))
      .catch(() => {});
    return () => {
      alive = false;
      un.forEach((p) => p.then((f) => f()));
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
  const addr = `${d.host}:${d.port}`;
  return (
    <Dialog
      title={d.changed ? `服务器指纹已改变 ${addr}` : `首次连接 ${addr}`}
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
        {d.changed ? (
          <div className="pc-alert">
            <ShieldAlert />
            <span>服务器指纹已改变，可能存在中间人攻击。除非你确认服务器重装过或更换了密钥，否则请拒绝。</span>
          </div>
        ) : (
          <div className="muted">尚未信任此服务器的主机密钥。请核对指纹后再继续。</div>
        )}
        <div className="pc-kv">
          <span>算法</span>
          <span className="mono selectable">{d.algo}</span>
          {d.changed && (
            <>
              <span>原指纹</span>
              <span className="mono selectable pc-fp pc-old">{d.oldFingerprint ?? "—"}</span>
            </>
          )}
          <span>{d.changed ? "新指纹" : "指纹"}</span>
          <span className="mono selectable pc-fp">{d.fingerprint}</span>
        </div>
      </div>
    </Dialog>
  );
}

function AgentDialog(props: { ev: PromptEvent<AgentPrompt>; more: number; onAnswer: (v: unknown) => void }) {
  const d = props.ev.data;
  const left = useCountdown(props.ev.expires);
  return (
    <Dialog
      title={
        <span className="row">
          Agent 请求执行操作
          {d.dangerous && <span className="badge err">高风险</span>}
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
        <div className="pc-kv">
          <span>服务器</span>
          <span className="ellipsis">
            {d.hostName} <span className="faint mono">{d.host}</span>
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
        <pre className={"pc-detail mono selectable" + (d.dangerous ? " danger" : "")}>{d.detail}</pre>
      </div>
    </Dialog>
  );
}
