// Agent page: MCP server config + client setup snippets, tool list, host policies, audit log.
import { usePrivacy } from "../../lib/privacy";
import { Copy, Eye, EyeOff, Link, Pencil, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, SearchBox, Toggle, toast } from "../../components/ui";
import { type AgentPolicy, type AuditEntry, type McpSettings, api, errMsg } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { fmtTime } from "../../lib/format";
import { useApp } from "../../store";
import { copyHostAddr } from "../hosts/hostMenu";
import { useContextMenu } from "../terminal/ContextMenu";
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
  // Stored settings are unreadable: the form shows defaults and saving overwrites the bad row.
  const [loadError, setLoadError] = useState<string | null>(null);
  const shownError = useRef<string | null>(null);

  const load = async () => {
    try {
      const r = await api.mcpSettingsGet();
      setSaved(r.settings);
      setDraft(r.settings);
      setRunning(r.runningPort);
      setLoadError(r.error ?? null);
      if (r.error && shownError.current !== r.error) {
        shownError.current = r.error;
        toast(r.error, "error");
      }
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
  const dirty =
    !!loadError || draft.port !== saved.port || draft.token !== saved.token || draft.enabled !== saved.enabled;
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
        <div className="section-title">
          <span className="grow">MCP 服务</span>
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
              className="input mono num agent-port"
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
            <button className="icon-btn md" title="复制" onClick={() => void copyText(saved.token, "令牌")}>
              <Copy />
            </button>
            <button className="icon-btn md" disabled={busy} title="重新生成（旧 Token 立即失效）" onClick={regen}>
              <RefreshCw />
            </button>
          </div>
        </div>
      </section>

      <section className="agent-sec">
        <div className="section-title">
          <span>接入</span>
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
      <button className="icon-btn" title="复制" onClick={() => void copyText(props.value)}>
        <Copy />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- tools


function ToolsCard() {
  const menu = useContextMenu();
  return (
    <section className="agent-sec">
      <div className="section-title">
        <span>工具</span>
      </div>
      <div className="agent-tools">
        {TOOLS.map((t) => (
          <div key={t.name} onContextMenu={(e) => menu.open(e, [{ label: "复制工具名", icon: <Copy />, onSelect: () => void copyText(t.name, "工具名") }])}>
            <span className="mono ellipsis">{t.name}</span>
            <span className="d ellipsis">{t.desc}</span>
          </div>
        ))}
      </div>
      {menu.node}
    </section>
  );
}

// ---------------------------------------------------------------- policies

function PolicyCard() {
  const hosts = useApp((s) => s.hosts);
  const menu = useContextMenu();
  const priv = usePrivacy();
  const setPolicy = async (h: (typeof hosts)[number], agentPolicy: AgentPolicy) => {
    try {
      await api.hostSave({ ...h, agentPolicy });
      await useApp.getState().refreshHosts();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <section className="agent-sec">
      <div className="section-title">
        <span>权限</span>
      </div>
      {hosts.length === 0 ? (
        <Empty sm text="暂无服务器" />
      ) : (
        <div className="agent-table-wrap">
          <table className="table agent-policy">
            <colgroup>
              <col className="c-name" />
              <col className="c-group" />
              <col />
              <col className="c-policy" />
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
                  <tr
                    key={h.id}
                    className="click"
                    title="编辑权限"
                    onClick={() => useApp.getState().openEditor(h.id)}
                    onContextMenu={(e) =>
                      menu.open(e, [
                        { label: "编辑权限…", icon: <Pencil />, onSelect: () => useApp.getState().openEditor(h.id) },
                        "sep",
                        ...(Object.keys(POLICY) as AgentPolicy[]).map((k) => ({
                          label: `设为${POLICY[k].label}`,
                          icon: <ShieldCheck />,
                          disabled: (h.agentPolicy ?? "ask") === k,
                          onSelect: () => void setPolicy(h, k),
                        })),
                        "sep",
                        { label: "复制地址", icon: <Link />, onSelect: () => void copyHostAddr(h) },
                      ])
                    }
                  >
                    <td title={priv.text(h.name, h.host)}>{priv.text(h.name, h.host)}</td>
                    <td className="muted">{h.groupName || "-"}</td>
                    <td className="mono muted" title={`${h.username}@${priv.addr(h.host)}:${h.port}`}>
                      {h.username}@{priv.addr(h.host)}:{h.port}
                    </td>
                    <td className={p.cls}>{p.label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {menu.node}
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
  const menu = useContextMenu();

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
      <div className="section-title">
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
        <SearchBox size="sm" className="agent-search" value={q} onChange={setQ} />
        <button className="icon-btn" title="刷新" onClick={load}>
          <RefreshCw />
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty sm text="没有记录" />
      ) : (
        <div className="agent-table-wrap tall">
          <table className="table agent-audit">
            <colgroup>
              <col className="c-time" />
              <col className="c-src" />
              <col className="c-host" />
              <col className="c-action" />
              <col />
              <col className="c-result" />
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
                  <tr
                    key={e.id}
                    onContextMenu={(ev) => {
                      if (window.getSelection()?.toString().trim()) return;
                      menu.open(ev, [
                        { label: "复制内容", icon: <Copy />, disabled: !e.detail, onSelect: () => void copyText(e.detail, "内容") },
                        {
                          label: "复制整行",
                          icon: <Copy />,
                          onSelect: () => void copyText([fmtTime(e.ts), e.source, hn, e.action, e.detail, e.result].join("\t")),
                        },
                        "sep",
                        { label: "只看此服务器", icon: <Search />, disabled: !e.hostId, onSelect: () => setQ(hn) },
                        { label: "刷新", icon: <RefreshCw />, onSelect: () => void load() },
                      ]);
                    }}
                  >
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
      {menu.node}
    </section>
  );
}
