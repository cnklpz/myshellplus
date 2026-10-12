import { Copy, CornerDownLeft, LoaderCircle, Play, Sparkles, TextCursorInput, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "../../components/ui";
import { api, errMsg, type NlCommand } from "../../lib/api";

/** Ctrl+K: natural language -> command. */
export function AiBar(props: {
  hostId: string;
  onClose: () => void;
  onInsert: (cmd: string) => void;
  onRun: (cmd: string) => void;
  /** Extra controls shown at the right of the input row (e.g. "AI 解释"). */
  extra?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<NlCommand | null>(null);
  const [cmd, setCmd] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      seq.current++; // drop in-flight responses
    };
  }, []);

  const ask = async () => {
    const prompt = text.trim();
    if (!prompt || loading) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    setResult(null);
    setConfirm(false);
    try {
      const r = await api.aiNl2Cmd(props.hostId, prompt);
      if (my !== seq.current) return;
      setResult(r);
      setCmd(r.command);
    } catch (e) {
      if (my === seq.current) setError(errMsg(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  };

  const run = () => {
    const c = cmd.trim();
    if (!c) return;
    if (result?.dangerous && !confirm) {
      setConfirm(true);
      return;
    }
    props.onRun(c);
  };

  return (
    <div
      className="ai-bar"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      {result && (
        <div className="ai-result stack">
          <textarea
            className="textarea mono ai-cmd"
            spellCheck={false}
            rows={Math.min(6, Math.max(1, cmd.split("\n").length))}
            value={cmd}
            onChange={(e) => {
              setCmd(e.target.value);
              setConfirm(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault();
                run();
              }
            }}
          />
          {result.explanation && <div className="ai-expl muted selectable">{result.explanation}</div>}
          <div className="row">
            {result.dangerous && (
              <span className="row gap-1 ai-risk">
                <TriangleAlert />
                高风险命令
              </span>
            )}
            <span className="spacer" />
            <button
              className="btn sm ghost"
              onClick={() => navigator.clipboard.writeText(cmd).then(() => toast("已复制", "success"), () => toast("复制失败", "error"))}
            >
              <Copy />
              复制
            </button>
            <button className="btn sm" onClick={() => cmd.trim() && props.onInsert(cmd)}>
              <TextCursorInput />
              插入
            </button>
            <button className={"btn sm " + (confirm ? "danger solid" : "primary")} title="Ctrl+Enter" onClick={run}>
              <Play />
              {confirm ? "确认执行" : "执行"}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="ai-error row">
          <TriangleAlert />
          <span className="grow selectable">{error}</span>
        </div>
      )}
      <div className="ai-input row">
        <Sparkles className="ai-input-icon" />
        <input
          ref={inputRef}
          className="grow"
          placeholder="描述要执行的操作"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              ask();
            }
          }}
        />
        {props.extra}
        {loading ? (
          <LoaderCircle className="ai-input-icon spin" />
        ) : (
          <button className="icon-btn" title="生成 (Enter)" onClick={ask} disabled={!text.trim()}>
            <CornerDownLeft />
          </button>
        )}
        <button className="icon-btn" title="关闭 (Esc)" onClick={props.onClose}>
          <X />
        </button>
      </div>
    </div>
  );
}

/** "AI 解释" result card for the selected terminal text. */
export function ExplainCard(props: { hostId: string; text: string; onClose: () => void }) {
  const [out, setOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setOut(null);
    setError(null);
    api
      .aiExplain(props.hostId, props.text)
      .then((r) => live && setOut(r))
      .catch((e) => live && setError(errMsg(e)));
    return () => {
      live = false;
    };
  }, [props.hostId, props.text]);

  return (
    <div
      className="explain-card"
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div className="explain-head row">
        <span>AI 解释</span>
        <span className="grow ellipsis mono faint explain-src">{props.text.replace(/\s+/g, " ")}</span>
        <button className="icon-btn" title="关闭" onClick={props.onClose}>
          <X />
        </button>
      </div>
      <div className="explain-body selectable">
        {error ? (
          <div className="ai-error row">
            <TriangleAlert />
            <span className="grow">{error}</span>
          </div>
        ) : out === null ? (
          <div className="row faint">
            <LoaderCircle className="ai-input-icon spin" />
            分析中…
          </div>
        ) : (
          <div className="explain-text">{out}</div>
        )}
      </div>
    </div>
  );
}
