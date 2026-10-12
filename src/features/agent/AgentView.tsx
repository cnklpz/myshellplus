// Agent page: MCP server config + client setup snippets, tool list, host policies, audit log.
import { Copy, Eye, EyeOff, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Toggle, toast } from "../../components/ui";
import { type AgentPolicy, type AuditEntry, type McpSettings, api, errMsg } from "../../lib/api";
import { fmtTime } from "../../lib/format";
import { useApp } from "../../store";
import "./agent.css";

const TOOLS: { name: string; desc: string }[] = [
  { name: "list_hosts", desc: "列出服务器" },
  { name: "run_command", desc: "执行命令" },
  { name: "batch_run", desc: "批量执行" },
  { name: "host_status", desc: "主机状态" },
  { name: "list_dir", desc: "列出目录" },
  { name: "read_file", desc: "读取文件" },
  { name: "write_file", desc: "写入文件" },
  { name: "list_terminals", desc: "列出终端" },
  { name: "read_terminal", desc: "读取终端输出" },
  { name: "send_terminal", desc: "向终端输入" },
];

const POLICY: Record<AgentPolicy, { label: string; cls: string }> = {
  deny: { label: "禁止", cls: "t-faint" },
  readonly: { label: "只读", cls: "t-ok" },
  ask: { label: "每次询问", cls: "" },
  auto: { label: "自动", cls: "t-warn" },
};

const RESULT_LABEL: Record<string, string> = {
  "allowed: policy": "允许",
  "approved: user": "已批准",
  "denied: policy": "禁止访问",
  "denied: readonly": "只读拒绝",
  "denied: user": "用户拒绝",
};

function resultCls(r: string) {
  if (r.startsWith("allowed") || r.startsWith("approved") || r === "ok") return "t-ok";
  if (r.startsWith("denied") || r.startsWith("error")) return "t-err";
  return "t-muted";
}

const mask = (t: string) => (t.length > 8 ? t.slice(0, 4) + "•".repeat(12) + t.slice(-2) : "•".repeat(12));

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制", "success");
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export function AgentView() {
  return (
    <div className="page">
      <div className="page-header">
        <h1>Agent</h1>
      </div>
      <div className="page-body">
        <div className="agent-inner">
          <McpCard />
          <ToolsCard />
          <PolicyCard />
          <AuditCard />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- MCP status + guide

function McpCard() {
  const [saved, setSaved] = useState<McpSettings | null>(null);
  const [draft, setDraft] = useState<McpSettings | null>(null);
  const [running, setRunning] = useState<number | null>(null);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api.mcpSettingsGet();
      setSaved(r.settings);
      setDraft(r.settings);
      setRunning(r.runningPort);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  useEffect(() => {
    load();
  }, []);

  const persist = async (next: McpSettings) => {
    setBusy(true);
    setDraft(next);
    try {
      await api.mcpSettingsSave(next);
      toast(next.enabled ? `MCP 服务已在端口 ${next.port} 运行` : "已保存", "success");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
      await load();
    }
  };

  if (!draft || !saved) return null;
  const portValid = Number.isInteger(draft.port) && draft.port > 0 && draft.port < 65536;
  const dirty = draft.port !== saved.port || draft.token !== saved.token || draft.enabled !== saved.enabled;
  const url = `http://127.0.0.1:${saved.port}/mcp`;
  const cli = (t: string) => `claude mcp add --transport http myshellplus ${url} --header "Authorization: Bearer ${t}"`;
  const json = (t: string) =>
    JSON.stringify({ mcpServers: { myshellplus: { type: "http", url, headers: { Authorization: `Bearer ${t}` } } } }, null, 2);
  const shown = reveal ? saved.token : mask(saved.token);

  const regen = async () => {
    try {
      await persist({ ...saved, token: await api.mcpNewToken() });
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  return (
    <>
      <section className="agent-sec">
        <div className="agent-sec-head">
          <h2 className="grow">MCP 服务</h2>
          <span className="agent-status">
            <span className={"dot" + (running ? " ok" : "")} />
            {running ? `运行中 · 127.0.0.1:${running}` : "未运行"}
          </span>
        </div>
        <div className="agent-strip">
          <div className="grp">
            <Toggle on={draft.enabled} disabled={busy} onChange={(v) => persist({ ...saved, enabled: v })} />
            <span className="lbl">启用</span>
          </div>
          <span className="agent-sep" />
          <div className="grp">
            <span className="lbl">端口</span>
            <input
              className="input mono num"
              style={{ width: 88 }}
              inputMode="numeric"
              value={draft.port || ""}
              onChange={(e) => setDraft({ ...draft, port: Number(e.target.value.replace(/\D/g, "")) || 0 })}
            />
            {dirty && (
              <button className="btn" disabled={!portValid || busy} onClick={() => persist(draft)}>
                保存
              </button>
            )}
          </div>
          <span className="agent-sep" />
          <div className="grp grow">
            <span className="lbl">Token</span>
            <input className="input mono" readOnly value={shown} />
            <button className="icon-btn md" title={reveal ? "隐藏" : "显示"} onClick={() => setReveal(!reveal)}>
              {reveal ? <EyeOff /> : <Eye />}
            </button>
            <button className="icon-btn md" title="复制" onClick={() => copy(saved.token)}>
              <Copy />
            </button>
            <button className="icon-btn md" disabled={busy} title="重新生成（旧 Token 立即失效）" onClick={regen}>
              <RefreshCw />
            </button>
          </div>
        </div>
      </section>

      <section className="agent-sec">
        <div className="agent-sec-head">
          <h2>接入</h2>
        </div>
        <div className="code-label">Claude Code</div>
        <CodeBox display={cli(shown)} value={cli(saved.token)} />
        <div className="code-label">JSON 配置</div>
        <CodeBox display={json(shown)} value={json(saved.token)} />
      </section>
    </>
  );
}

function CodeBox(props: { display: string; value: string }) {
  return (
    <div className="code-box">
      <pre>{props.display}</pre>
      <button className="icon-btn" title="复制" onClick={() => copy(props.value)}>
        <Copy />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- tools

function ToolsCard() {
  return (
    <section className="agent-sec">
      <div className="agent-sec-head">
        <h2>工具</h2>
      </div>
      <div className="agent-tools">
        {TOOLS.map((t) => (
          <div key={t.name}>
            <span className="mono ellipsis">{t.name}</span>
            <span className="d ellipsis">{t.desc}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- policies

function PolicyCard() {
  const hosts = useApp((s) => s.hosts);
  return (
    <section className="agent-sec">
      <div className="agent-sec-head">
        <h2>权限</h2>
      </div>
      {hosts.length === 0 ? (
        <div className="agent-empty">暂无服务器</div>
      ) : (
        <div className="agent-table-wrap">
          <table className="table">
            <colgroup>
              <col style={{ width: "28%" }} />
              <col style={{ width: "20%" }} />
              <col />
              <col style={{ width: 104 }} />
            </colgroup>
            <thead>
              <tr>
                <th>名称</th>
                <th>分组</th>
                <th>地址</th>
                <th>权限</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((h) => {
                const p = POLICY[h.agentPolicy] ?? POLICY.ask;
                return (
                  <tr key={h.id} className="click" title="编辑权限" onClick={() => useApp.getState().openEditor(h.id)}>
                    <td title={h.name}>{h.name}</td>
                    <td className="muted">{h.groupName || "-"}</td>
                    <td className="mono muted" title={`${h.username}@${h.host}:${h.port}`}>
                      {h.username}@{h.host}:{h.port}
                    </td>
                    <td className={p.cls}>{p.label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- audit

type SourceFilter = "all" | "agent" | "user";

function AuditCard() {
  const hosts = useApp((s) => s.hosts);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [q, setQ] = useState("");

  const load = async () => {
    try {
      setEntries(await api.auditList(500));
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const hostName = useMemo(() => new Map(hosts.map((h) => [h.id, h.name])), [hosts]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter !== "all" && e.source !== filter) return false;
      if (!needle) return true;
      const hn = e.hostId ? hostName.get(e.hostId) ?? "" : "";
      return [e.action, e.detail, e.result, hn].some((s) => s.toLowerCase().includes(needle));
    });
  }, [entries, filter, q, hostName]);

  return (
    <section className="agent-sec">
      <div className="agent-sec-head">
        <h2 className="grow">审计日志</h2>
        <div className="seg">
          {(
            [
              ["all", "全部"],
              ["agent", "Agent"],
              ["user", "用户"],
            ] as [SourceFilter, string][]
          ).map(([v, l]) => (
            <button key={v} className={filter === v ? "on" : ""} onClick={() => setFilter(v)}>
              {l}
            </button>
          ))}
        </div>
        <div className="agent-search">
          <Search />
          <input className="input sm" placeholder="搜索" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="icon-btn" title="刷新" onClick={load}>
          <RefreshCw />
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="agent-empty">没有记录</div>
      ) : (
        <div className="agent-table-wrap tall">
          <table className="table">
            <colgroup>
              <col style={{ width: 168 }} />
              <col style={{ width: 72 }} />
              <col style={{ width: 128 }} />
              <col style={{ width: 112 }} />
              <col />
              <col style={{ width: 96 }} />
            </colgroup>
            <thead>
              <tr>
                <th>时间</th>
                <th>来源</th>
                <th>服务器</th>
                <th>操作</th>
                <th>内容</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const hn = e.hostId ? hostName.get(e.hostId) ?? e.hostId : "-";
                return (
                  <tr key={e.id}>
                    <td className="agent-time">{fmtTime(e.ts)}</td>
                    <td className={e.source === "agent" ? "" : "t-muted"}>{e.source === "agent" ? "Agent" : "用户"}</td>
                    <td title={hn}>{hn}</td>
                    <td className="mono t-muted" title={e.action}>
                      {e.action}
                    </td>
                    <td className="mono selectable" title={e.detail}>
                      {e.detail}
                    </td>
                    <td className={resultCls(e.result)} title={e.result}>
                      {RESULT_LABEL[e.result] ?? e.result}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
