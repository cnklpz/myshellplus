// AI chat about the panel host. Commands in replies can be inserted into the terminal (never run directly).
import { ArrowUp, Copy, CornerDownLeft, LoaderCircle, Pencil, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "../../components/Markdown";
import { Empty, Toggle, toast } from "../../components/ui";
import { api, type ChatMsg, errMsg } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { termBus } from "../../lib/termBus";
import { useApp } from "../../store";
import { usePanelItems } from "../side/panelMenu";
import { type MenuItem, useContextMenu } from "../terminal/ContextMenu";
import "./ai.css";

/** First fenced code block in a reply. */
const firstCode = (md: string) => /```[^\n]*\n([\s\S]*?)```/.exec(md)?.[1]?.trim() ?? "";


// Conversations survive switching panels or hosts (memory only).
const chats = new Map<string, ChatMsg[]>();

function hostTerm(hostId: string) {
  const { tabs, activeTab } = useApp.getState();
  const t = tabs.find((x) => x.id === activeTab && x.hostId === hostId) ?? tabs.find((x) => x.hostId === hostId);
  return t ? termBus.get(t.id) : undefined;
}

export function AiPanel({ hostId }: { hostId: string }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>(() => chats.get(hostId) ?? []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [withScreen, setWithScreen] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const panelExtra = usePanelItems();

  useEffect(() => {
    chats.set(hostId, msgs);
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    const next: ChatMsg[] = [...msgs, { role: "user", content: q }];
    setMsgs(next);
    setText("");
    setErr(null);
    setBusy(true);
    try {
      const screen = withScreen ? hostTerm(hostId)?.screenText(40) : undefined;
      const reply = await api.aiChat(hostId, next, screen);
      setMsgs([...next, { role: "assistant", content: reply || "（无回复）" }]);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const insert = (code: string) => {
    const t = hostTerm(hostId);
    if (!t) return toast("请先打开该服务器的终端", "error");
    t.paste(code.trim());
    t.focus();
  };

  const codeActions = (code: string) => (
    <div className="aip-code-actions">
      <button className="btn sm ghost" title="插入终端，回车后才会执行" onClick={() => insert(code)}>
        <CornerDownLeft />
        插入终端
      </button>
      <button
        className="btn sm ghost"
        onClick={() => void copyText(code.trim(), "命令")}
      >
        <Copy />
        复制
      </button>
    </div>
  );

  const clear = () => (setMsgs([]), setErr(null));
  const clearItem = (): MenuItem => ({ label: "清空对话", icon: <Trash2 />, danger: true, disabled: msgs.length === 0, onSelect: clear });
  // Selected text keeps the global copy / search menu.
  const onMsgMenu = (e: React.MouseEvent, m: ChatMsg) => {
    if (window.getSelection()?.toString().trim()) return;
    const code = m.role === "assistant" ? firstCode(m.content) : "";
    menu.open(e, [
      { label: "复制", icon: <Copy />, onSelect: () => void copyText(m.content.trim()) },
      m.role === "assistant" && { label: "复制命令", icon: <Copy />, disabled: !code, onSelect: () => void copyText(code.trim(), "命令") },
      m.role === "assistant" && { label: "插入终端", icon: <CornerDownLeft />, disabled: !code, onSelect: () => insert(code) },
      m.role === "user" && { label: "编辑后重问", icon: <Pencil />, onSelect: () => setText(m.content) },
      "sep",
      clearItem(),
    ]);
  };

  return (
    <div className="aip-root">
      <div
        className="aip-list"
        ref={listRef}
        onContextMenu={(e) => {
          if (window.getSelection()?.toString().trim()) return;
          menu.open(e, [clearItem(), ...panelExtra()]);
        }}
      >
        {msgs.length === 0 && !busy && <Empty text="问一个关于这台服务器的问题" />}
        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="aip-user selectable" onContextMenu={(e) => onMsgMenu(e, m)}>{m.content}</div>
          ) : (
            <div key={i} className="aip-reply-wrap" onContextMenu={(e) => onMsgMenu(e, m)}>
              <Markdown className="aip-reply selectable" text={m.content} codeActions={codeActions} />
            </div>
          ),
        )}
        {busy && (
          <div className="aip-wait faint">
            <LoaderCircle className="spin" />
            思考中
          </div>
        )}
        {err && (
          <div className="aip-err">
            <TriangleAlert />
            <span className="selectable">{err}</span>
            {/未配置|API Key/.test(err) && (
              <button className="btn sm" onClick={() => useApp.getState().openSettings("ai")}>去设置</button>
            )}
          </div>
        )}
      </div>
      {menu.node}
      <div className="aip-composer">
        <textarea
          className="aip-text"
          rows={2}
          placeholder="nginx 为什么启动失败"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="aip-tools">
          <label className="aip-opt">
            <Toggle on={withScreen} onChange={setWithScreen} />
            <span>附带终端输出</span>
          </label>
          <span className="grow" />
          {msgs.length > 0 && (
            <button className="icon-btn" title="清空对话" onClick={clear}>
              <Trash2 />
            </button>
          )}
          <button className="btn sm primary aip-send" title="发送 (Enter)" disabled={!text.trim() || busy} onClick={send}>
            {busy ? <LoaderCircle className="spin" /> : <ArrowUp />}
          </button>
        </div>
      </div>
    </div>
  );
}
