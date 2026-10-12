// Agent page: MCP server config + client setup snippets, tool list, host policies, audit log.
import { BookOpen, Copy, Eye, EyeOff, RefreshCw, ScrollText, Search, Server, Shield, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Field, Toggle, toast } from "../../components/ui";
import { type AgentPolicy, type AuditEntry, type McpSettings, api, errMsg } from "../../lib/api";
import { fmtTime } from "../../lib/format";
import { useApp } from "../../store";
import "./agent.css";

const TOOLS: { name: string; desc: string }[] = [
  { name: "list_hosts", desc: "列出可用服务器（分组、地址、权限、连接状态）" },
  { name: "run_command", desc: "在服务器上执行非交互命令，返回输出和退出码" },
  { name: "batch_run", desc: "在多台服务器上并发执行同一命令" },
  { name: "host_status", desc: "获取 CPU、内存、负载、网络、磁盘和进程" },
  { name: "list_dir", desc: "列出远程目录" },
  { name: "read_file", desc: "读取远程文本文件（≤5MB）" },
  { name: "write_file", desc: "覆盖写入远程文本文件" },
  { name: "list_terminals", desc: "列出当前打开的终端会话" },
  { name: "read_terminal", desc: "读取终端最近的输出" },
  { name: "send_terminal", desc: "向终端输入文本（用于交互式程序）" },
];

const POLICY: Record<AgentPolicy, { label: string; cls: string }> = {
  deny: { label: "禁止", cls: "" },
  readonly: { label: "只读", cls: "ok" },
  ask: { label: "每次询问", cls: "accent" },
  auto: { label: "自动", cls: "warn" },
};

const RESULT_LABEL: Record<string, string> = {
  "allowed: policy": "允许",
  "approved: user": "已批准",
  "denied: policy": "禁止访问",
  "denied: readonly": "只读拒绝",
  "denied: user": "用户拒绝",
};

function resultCls(r: string) {
  if (r.startsWith("allowed") || r.startsWith("approved") || r === "ok") return "ok";
  if (r.startsWith("denied") || r.startsWith("error")) return "err";
  return "";
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
        <span className="faint">通过 MCP 让 Claude Code 等 AI Agent 操作你的服务器</span>
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

  return (
    <>
      <div className="card agent-card">
        <div className="agent-card-head">
          <Server />
          <span className="grow">MCP 服务</span>
          {running ? (
            <span className="badge ok">
              <span className="dot ok" />
              运行中 · 127.0.0.1:{running}
            </span>
          ) : (
            <span className="badge">
              <span className="dot" />
              未运行
            </span>
          )}
        </div>
        <Field label="启用">
          <Toggle on={draft.enabled} disabled={busy} onChange={(v) => persist({ ...saved, enabled: v })} />
          <span className="agent-note">仅监听本机 127.0.0.1</span>
        </Field>
        <Field label="端口">
          <input
            className="input mono"
            style={{ width: 120 }}
            inputMode="numeric"
            value={draft.port || ""}
            onChange={(e) => setDraft({ ...draft, port: Number(e.target.value.replace(/\D/g, "")) || 0 })}
          />
          <button className="btn" disabled={!dirty || !portValid || busy} onClick={() => persist(draft)}>
            保存
          </button>
        </Field>
        <Field label="Token" hint="Agent 需在请求头携带此 Token。重新生成后旧配置立即失效。">
          <input className="input mono" readOnly value={shown} />
          <button className="icon-btn md" title={reveal ? "隐藏" : "显示"} onClick={() => setReveal(!reveal)}>
            {reveal ? <EyeOff /> : <Eye />}
          </button>
          <button className="icon-btn md" title="复制" onClick={() => copy(saved.token)}>
            <Copy />
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              try {
                await persist({ ...saved, token: await api.mcpNewToken() });
              } catch (e) {
                toast(errMsg(e), "error");
              }
            }}
          >
            <RefreshCw />
            重新生成
          </button>
        </Field>
      </div>

      <div className="card agent-card">
        <div className="agent-card-head">
          <BookOpen />
          <span>接入指南</span>
        </div>
        <div className="code-label">Claude Code（在终端执行）</div>
        <CodeBox display={cli(shown)} value={cli(saved.token)} />
        <div className="code-label">其他支持 MCP 的客户端（JSON 配置）</div>
        <CodeBox display={json(shown)} value={json(saved.token)} />
      </div>
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
    <div className="card agent-card">
      <div className="agent-card-head">
        <Wrench />
        <span>可用工具</span>
      </div>
      <div className="agent-table-wrap">
        <table className="table">
          <colgroup>
            <col style={{ width: 160 }} />
            <col />
          </colgroup>
          <tbody>
            {TOOLS.map((t) => (
              <tr key={t.name}>
                <td className="mono">{t.name}</td>
                <td className="muted">{t.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- policies

function PolicyCard() {
  const hosts = useApp((s) => s.hosts);
  return (
    <div className="card agent-card">
      <div className="agent-card-head">
        <Shield />
        <span>权限</span>
      </div>
      <div className="agent-note">
        每台服务器的 Agent 权限在服务器编辑器中设置：禁止（不可见）、只读（仅查看类命令和读文件）、每次询问（每个操作弹窗确认）、自动（仅危险命令需确认）。点击行可编辑。
      </div>
      {hosts.length === 0 ? (
        <div className="agent-note">暂无服务器</div>
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
                  <tr key={h.id} className="click" onClick={() => useApp.getState().openEditor(h.id)}>
                    <td title={h.name}>{h.name}</td>
                    <td className="muted">{h.groupName || "-"}</td>
                    <td className="mono muted" title={`${h.username}@${h.host}:${h.port}`}>
                      {h.username}@{h.host}:{h.port}
                    </td>
                    <td>
                      <span className={"badge " + p.cls}>{p.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
    <div className="card agent-card">
      <div className="agent-card-head">
        <ScrollText />
        <span className="grow">审计日志</span>
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
        <div className="row gap-1" style={{ width: 200 }}>
          <Search style={{ width: "var(--icon-sm)", height: "var(--icon-sm)", flex: "none" }} className="faint" />
          <input className="input sm" placeholder="搜索" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="icon-btn" title="刷新" onClick={load}>
          <RefreshCw />
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="agent-note">没有记录</div>
      ) : (
        <div className="agent-table-wrap tall">
          <table className="table">
            <colgroup>
              <col style={{ width: 148 }} />
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
                    <td className="mono muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {fmtTime(e.ts)}
                    </td>
                    <td>
                      <span className={"badge " + (e.source === "agent" ? "accent" : "")}>{e.source === "agent" ? "Agent" : "用户"}</span>
                    </td>
                    <td title={hn}>{hn}</td>
                    <td className="mono" title={e.action}>
                      {e.action}
                    </td>
                    <td className="mono selectable" title={e.detail}>
                      {e.detail}
                    </td>
                    <td>
                      <span className={"badge " + resultCls(e.result)} title={e.result}>
                        {RESULT_LABEL[e.result] ?? e.result}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
