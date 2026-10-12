// Command snippets list (side panel); click inserts into the active terminal.
import { ChevronRight, Copy, CopyPlus, CornerDownLeft, FolderInput, Pencil, Play, Plus, ScrollText, RefreshCw, Sparkles, Tag, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Confirm, Dialog, Empty, Field, SearchBox, toast } from "../../components/ui";
import { api, errMsg, type Snippet } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { termBus } from "../../lib/termBus";
import { Combobox } from "../../components/Combobox";
import { Select } from "../../components/Select";
import { useApp } from "../../store";
import { usePanelItems } from "../side/panelMenu";
import { useContextMenu } from "../terminal/ContextMenu";
import "./snippets.css";

// {{name}} or {{name:default}}
const VAR_RE = /\{\{\s*([\w.-]+)\s*(?::([^}]*))?\}\}/g;

export interface SnippetVar { name: string; def: string }

export function parseVars(cmd: string): SnippetVar[] {
  const out: SnippetVar[] = [];
  for (const m of cmd.matchAll(VAR_RE)) {
    if (!out.some((v) => v.name === m[1])) out.push({ name: m[1], def: (m[2] ?? "").trim() });
  }
  return out;
}

export function fillVars(cmd: string, values: Record<string, string>): string {
  return cmd.replace(VAR_RE, (_, name: string) => values[name] ?? "");
}

type Mode = "run" | "paste";

export function SnippetsPanel({ hostId }: { hostId: string | null }) {
  const [list, setList] = useState<Snippet[] | null>(null);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  /** all = global + this host; host = only this host's */
  const [scope, setScope] = useState<"all" | "host">("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<Partial<Snippet> | null>(null);
  const [deleting, setDeleting] = useState<Snippet | null>(null);
  const [asking, setAsking] = useState<{ snippet: Snippet; mode: Mode } | null>(null);

  const menu = useContextMenu();
  const panelExtra = usePanelItems();

  const refresh = useCallback(async () => {
    try {
      setList(await api.snippetList());
    } catch (e) {
      toast(errMsg(e), "error");
      setList([]);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Snippets bound to another host are hidden here.
  const visible = useMemo(() => (list ?? []).filter((s) => !s.hostId || s.hostId === hostId), [list, hostId]);
  const groups = useMemo(
    () => [...new Set((list ?? []).map((s) => s.groupName ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN")),
    [list],
  );

  const tags = useMemo(() => {
    const s = new Set<string>();
    visible.forEach((x) => x.tags.forEach((t) => s.add(t)));
    return [...s].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [visible]);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return visible
      .filter((s) => scope === "all" || s.hostId === hostId)
      .filter((s) => !tag || s.tags.includes(tag))
      .filter((s) => !k || s.name.toLowerCase().includes(k) || s.command.toLowerCase().includes(k) || s.tags.some((t) => t.toLowerCase().includes(k)))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [visible, q, tag, scope, hostId]);

  /** [group, items] with named groups first, ungrouped last. */
  const sections = useMemo(() => {
    const m = new Map<string, Snippet[]>();
    for (const s of shown) {
      const g = s.groupName ?? "";
      m.set(g, [...(m.get(g) ?? []), s]);
    }
    return [...m.entries()].sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b, "zh-CN")));
  }, [shown]);

  const moveTo = async (s: Snippet, groupName: string) => {
    try {
      await api.snippetSave({ ...s, groupName });
      await refresh();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const send = (cmd: string, mode: Mode) => {
    const term = termBus.active();
    if (!term) {
      toast("请先打开终端", "error");
      return;
    }
    if (mode === "run") term.run(cmd);
    else term.paste(cmd);
    term.focus();
  };

  const use = (s: Snippet, mode: Mode) => {
    if (!termBus.active()) {
      toast("请先打开终端", "error");
      return;
    }
    if (parseVars(s.command).length) setAsking({ snippet: s, mode });
    else send(s.command, mode);
  };

  return (
    <div className="sn-root">
      <div className="sn-top">
        <div className="row">
          <SearchBox className="grow" size="sm" placeholder="搜索命令" value={q} onChange={setQ} />
          {hostId && (
            <div className="seg">
              <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>全部</button>
              <button className={scope === "host" ? "on" : ""} onClick={() => setScope("host")}>本机</button>
            </div>
          )}
          <button className="icon-btn" title="新建命令" onClick={() => setEditing({ name: "", command: "", tags: [] })}>
            <Plus />
          </button>
        </div>
        {tags.length > 0 && (
          <div className="sn-tags">
            <button className={"sn-chip" + (tag === null ? " on" : "")} onClick={() => setTag(null)}>
              全部
            </button>
            {tags.map((t) => (
              <button key={t} className={"sn-chip" + (tag === t ? " on" : "")} onClick={() => setTag(tag === t ? null : t)}>
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        className="sn-body"
        onContextMenu={(e) =>
          menu.open(e, [
            { label: "新建…", icon: <Plus />, onSelect: () => setEditing({ name: "", command: "", tags: [] }) },
            { label: "刷新", icon: <RefreshCw />, onSelect: () => void refresh() },
            { label: "显示全部", icon: <Tag />, disabled: tag === null, onSelect: () => setTag(null) },
            ...panelExtra(),
          ])
        }
      >
        {list && list.length === 0 ? (
          <Empty
            icon={<ScrollText />}
            text="还没有命令"
            action={
              <button className="btn sm" onClick={() => setEditing({ name: "", command: "", tags: [] })}>
                <Plus />
                新建
              </button>
            }
          />
        ) : list && shown.length === 0 ? (
          <Empty text="无匹配" />
        ) : (
          sections.map(([g, items]) => (
            <div key={g} className="sn-group">
              {(sections.length > 1 || g) && (
                <button
                  className={"section-title sn-group-head" + (collapsed.has(g) ? " closed" : "")}
                  onClick={() => {
                    const next = new Set(collapsed);
                    if (next.has(g)) next.delete(g);
                    else next.add(g);
                    setCollapsed(next);
                  }}
                >
                  <ChevronRight />
                  <span className="grow ellipsis">{g || "未分组"}</span>
                  <span className="count">{items.length}</span>
                </button>
              )}
              {!collapsed.has(g) &&
                items.map((s) => (
                <div
                  key={s.id}
                  className="sn-item"
                  onClick={() => use(s, "paste")}
                  title="点击插入"
                  onContextMenu={(e) =>
                    menu.open(e, [
                      { label: "运行", icon: <Play />, onSelect: () => use(s, "run") },
                      { label: "插入", icon: <CornerDownLeft />, onSelect: () => use(s, "paste") },
                      { label: "复制命令", icon: <Copy />, onSelect: () => void copyText(s.command, "命令") },
                      "sep",
                      { label: "编辑…", icon: <Pencil />, onSelect: () => setEditing({ ...s }) },
                      { label: "创建副本…", icon: <CopyPlus />, onSelect: () => setEditing({ ...s, id: undefined, name: `${s.name} 副本` }) },
                      ...s.tags.map((t) => ({ label: `只看「${t}」`, icon: <Tag />, onSelect: () => setTag(t) })),
                      "sep",
                      ...groups
                        .filter((g) => g !== (s.groupName ?? ""))
                        .map((g) => ({ label: `移到「${g}」`, icon: <FolderInput />, onSelect: () => moveTo(s, g) })),
                      !!s.groupName && { label: "移出分组", icon: <FolderInput />, onSelect: () => moveTo(s, "") },
                      "sep",
                      { label: "删除…", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(s) },
                    ])
                  }
                >
                  <div className="sn-line">
                    <span className="grow ellipsis sn-name">{s.name || "未命名"}</span>
                    {(s.hostId || s.tags.length > 0) && (
                      <span className="ellipsis sn-tagline">{[s.hostId ? "本机" : "", ...s.tags].filter(Boolean).join(" · ")}</span>
                    )}
                    <div className="sn-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn sm" title="运行" onClick={() => use(s, "run")}>
                        <Play />
                      </button>
                      <button className="icon-btn sm" title="插入" onClick={() => use(s, "paste")}>
                        <CornerDownLeft />
                      </button>
                      <button className="icon-btn sm" title="编辑" onClick={() => setEditing({ ...s })}>
                        <Pencil />
                      </button>
                      <button className="icon-btn sm danger" title="删除" onClick={() => setDeleting(s)}>
                        <Trash2 />
                      </button>
                    </div>
                  </div>
                  <div className="mono faint ellipsis sn-cmd">{s.command.replace(/\s*\n\s*/g, " ⏎ ")}</div>
                </div>
                ))}
            </div>
          ))
        )}
      </div>

      {menu.node}
      {editing && (
        <SnippetEditor
          initial={editing}
          hostId={hostId}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="删除命令"
          message={`删除「${deleting.name}」？`}
          confirmText="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const s = deleting;
            setDeleting(null);
            try {
              await api.snippetDelete(s.id);
              await refresh();
            } catch (e) {
              toast(errMsg(e), "error");
            }
          }}
        />
      )}
      {asking && (
        <VarsDialog
          title={asking.snippet.name}
          command={asking.snippet.command}
          confirmText={asking.mode === "run" ? "运行" : "插入"}
          onCancel={() => setAsking(null)}
          onDone={(cmd) => {
            const mode = asking.mode;
            setAsking(null);
            send(cmd, mode);
          }}
        />
      )}
    </div>
  );
}

/** Asks for each {{var}} value, then returns the substituted command. */
export function VarsDialog(props: { title: string; command: string; confirmText?: string; onCancel: () => void; onDone: (cmd: string) => void }) {
  const vars = useMemo(() => parseVars(props.command), [props.command]);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(vars.map((v) => [v.name, v.def])));
  const result = fillVars(props.command, values);
  const submit = () => props.onDone(result);
  return (
    <Dialog
      title={`填写变量 · ${props.title}`}
      width={480}
      onClose={props.onCancel}
      footer={
        <>
          <button className="btn" onClick={props.onCancel}>取消</button>
          <button className="btn primary" onClick={submit}>{props.confirmText ?? "确定"}</button>
        </>
      }
    >
      <form
        className="stack gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {vars.map((v, i) => (
          <Field key={v.name} label={<span className="mono">{v.name}</span>}>
            <input
              className="input mono"
              autoFocus={i === 0}
              value={values[v.name] ?? ""}
              onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
            />
          </Field>
        ))}
        <Field label="预览" top>
          <pre className="mono sn-preview selectable">{result}</pre>
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function SnippetEditor(props: { initial: Partial<Snippet>; hostId: string | null; groups: string[]; onClose: () => void; onSaved: () => void }) {
  const init = props.initial;
  const hosts = useApp((s) => s.hosts);
  const [scopeHost, setScopeHost] = useState<string>(init.hostId ?? "");
  const [group, setGroup] = useState(init.groupName ?? "");
  const scopeOptions = [
    { value: "", label: "所有服务器" },
    ...[...new Set([props.hostId, init.hostId].filter((x): x is string => !!x))].map((id) => ({
      value: id,
      label: `仅「${hosts.find((h) => h.id === id)?.name ?? "已删除的服务器"}」`,
    })),
  ];
  const [name, setName] = useState(init.name ?? "");
  const [command, setCommand] = useState(init.command ?? "");
  const [tags, setTags] = useState((init.tags ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [ask, setAsk] = useState("");
  const [gen, setGen] = useState<{ busy: boolean; note: string; danger: boolean }>({ busy: false, note: "", danger: false });
  const vars = parseVars(command);
  const ok = name.trim() !== "" && command.trim() !== "";

  const save = async () => {
    if (!ok) return;
    setSaving(true);
    try {
      const tagList = [...new Set(tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean))];
      await api.snippetSave({ ...init, name: name.trim(), command, tags: tagList, hostId: scopeHost || null, groupName: group.trim() });
      props.onSaved();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setSaving(false);
    }
  };

  /** Natural language -> command via the configured AI service; host context is optional. */
  const generate = async () => {
    const prompt = ask.trim();
    if (!prompt || gen.busy) return;
    setGen({ busy: true, note: "", danger: false });
    try {
      const r = await api.aiNl2Cmd(props.hostId ?? "", prompt);
      if (!r.command) throw new Error(r.explanation || "AI 未返回命令");
      setCommand(r.command);
      if (!name.trim()) setName(prompt.slice(0, 24));
      setGen({ busy: false, note: r.explanation, danger: r.dangerous });
    } catch (e) {
      setGen({ busy: false, note: "", danger: false });
      toast(errMsg(e), "error");
    }
  };

  return (
    <Dialog
      title={init.id ? "编辑命令" : "新建命令"}
      width={560}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn primary" disabled={!ok || saving} onClick={save}>保存</button>
        </>
      }
    >
      <div className="stack gap-3">
        <Field label="名称">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field
          label="AI 生成"
          hint={gen.note ? <span className={"selectable" + (gen.danger ? " sn-ai-danger" : "")}>{gen.danger ? "高风险：" : ""}{gen.note}</span> : undefined}
        >
          <input
            className="input"
            value={ask}
            placeholder="查看占用 80 端口的进程"
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                generate();
              }
            }}
          />
          <button className="btn" disabled={!ask.trim() || gen.busy} onClick={generate}>
            <Sparkles />
            {gen.busy ? "生成中…" : "生成"}
          </button>
        </Field>
        <Field
          label="命令"
          top
          hint={
            vars.length ? `变量：${vars.map((v) => v.name).join("、")}` : "支持 {{变量:默认值}}"
          }
        >
          <textarea
            className="textarea mono"
            rows={6}
            spellCheck={false}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
        </Field>
        <Field label="分组">
          <Combobox value={group} options={props.groups} placeholder="部署" onChange={setGroup} />
        </Field>
        <Field label="范围">
          <Select value={scopeHost} options={scopeOptions} width="100%" onChange={setScopeHost} disabled={scopeOptions.length < 2} />
        </Field>
        <Field label="标签">
          <input className="input" value={tags} placeholder="docker, 日志" onChange={(e) => setTags(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
