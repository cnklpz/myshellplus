// Import wizard dialog (driven by store.importOpen): choose source -> preview/select -> result.
import { open, save } from "@tauri-apps/plugin-dialog";
import { CircleX, Download, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog, Field, Toggle, toast } from "../../components/ui";
import { type ImportCandidate, type ImportPreview, type ImportResult, type ImportSource, api, errMsg } from "../../lib/api";
import { useApp } from "../../store";
import "./import.css";

type Kind = "file" | "dir" | "none";

const SOURCES: {
  id: ImportSource;
  name: string;
  hint: string;
  kind: Kind;
  filters?: { name: string; extensions: string[] }[];
}[] = [
  { id: "openssh", name: "OpenSSH", hint: "~/.ssh/config", kind: "file" },
  { id: "putty", name: "PuTTY", hint: "注册表", kind: "none" },
  { id: "xshell", name: "Xshell", hint: "*.xsh 文件夹", kind: "dir" },
  { id: "mobaxterm", name: "MobaXterm", hint: "MobaXterm.ini", kind: "file", filters: [{ name: "MobaXterm 配置", extensions: ["ini"] }] },
  { id: "finalshell", name: "FinalShell", hint: "conn 文件夹", kind: "dir" },
  { id: "csv", name: "CSV", hint: "*.csv", kind: "file", filters: [{ name: "CSV", extensions: ["csv"] }] },
  { id: "backup", name: "MyShell+ 备份", hint: "*.json", kind: "file", filters: [{ name: "MyShell+ 备份", extensions: ["json"] }] },
];

const CSV_TEMPLATE = "name,group,host,port,username,password,key,notes,tags\nweb-01,生产,10.0.0.11,22,root,,C:\\Users\\me\\.ssh\\id_ed25519,Nginx,web;nginx\ndb-01,生产,10.0.0.21,22,admin,P@ssw0rd,,,db\n";

type Step = "source" | "preview" | "done";

export function ImportDialog() {
  const close = () => useApp.getState().setImportOpen(false);
  const [step, setStep] = useState<Step>("source");
  const [source, setSource] = useState<ImportSource | null>(null);
  const [path, setPath] = useState("");
  const [password, setPassword] = useState("");
  const [needPw, setNeedPw] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [skipDup, setSkipDup] = useState(true);
  const [group, setGroup] = useState("");
  const [withSnippets, setWithSnippets] = useState(true);
  const [result, setResult] = useState<ImportResult | null>(null);

  const src = SOURCES.find((s) => s.id === source);

  const pick = async (id: ImportSource) => {
    setSource(id);
    setError("");
    setNeedPw(false);
    setPassword("");
    setPath("");
    try {
      setPath((await api.importDefaultPath(id)) ?? "");
    } catch {
      /* no default */
    }
  };

  const browse = async () => {
    if (!src) return;
    try {
      const r = await open({
        directory: src.kind === "dir",
        multiple: false,
        defaultPath: path || undefined,
        filters: src.kind === "file" ? [...(src.filters ?? []), { name: "所有文件", extensions: ["*"] }] : undefined,
      });
      if (typeof r === "string") setPath(r);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const saveTemplate = async () => {
    try {
      const p = await save({ defaultPath: "myshellplus-hosts.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!p) return;
      // BOM so Excel opens the Chinese text as UTF-8
      await api.localWriteText(p, "\uFEFF" + CSV_TEMPLATE);
      toast("模板已保存", "success");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const runPreview = async () => {
    if (!source) return;
    setBusy(true);
    setError("");
    try {
      const p = await api.importPreview(source, path, password || undefined);
      setPreview(p);
      setSelected(new Set(p.hosts.map((h, i) => (h.duplicate && skipDup ? -1 : i)).filter((i) => i >= 0)));
      setStep("preview");
    } catch (e) {
      const m = errMsg(e);
      if (source === "backup" && (m.includes("NEED_PASSWORD") || m.includes("备份密码错误"))) {
        setNeedPw(true);
        setError(m.includes("NEED_PASSWORD") ? "备份已加密，请输入密码" : "备份密码错误");
      } else {
        setError(m);
      }
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview || !source) return;
    setBusy(true);
    try {
      const g = group.trim();
      const hosts: ImportCandidate[] = preview.hosts.filter((_, i) => selected.has(i)).map((h) => (g ? { ...h, group: g } : h));
      const r = await api.importApply(
        hosts,
        withSnippets ? preview.snippets : [],
        source === "backup" ? path : undefined,
        source === "backup" ? password || undefined : undefined,
      );
      setResult(r);
      setStep("done");
      await useApp.getState().refreshHosts();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const canPreview = !!src && !busy && (src.kind === "none" || path.trim() !== "") && (!needPw || password !== "");

  const footer =
    step === "source" ? (
      <>
        <button className="btn" onClick={close}>
          取消
        </button>
        <button className="btn primary" disabled={!canPreview} onClick={runPreview}>
          {busy ? "读取中…" : "下一步"}
        </button>
      </>
    ) : step === "preview" ? (
      <>
        <button className="btn" onClick={() => setStep("source")}>
          上一步
        </button>
        <span className="spacer" />
        <button className="btn" onClick={close}>
          取消
        </button>
        <button className="btn primary" disabled={busy || (selected.size === 0 && !(withSnippets && preview?.snippets.length))} onClick={apply}>
          {busy ? "导入中…" : `导入 ${selected.size} 台`}
        </button>
      </>
    ) : (
      <button className="btn primary" onClick={close}>
        完成
      </button>
    );

  return (
    <Dialog
      title={
        <div className="row gap-3">
          <span>导入服务器</span>
          <div className="imp-steps">
            <span className={step === "source" ? "on" : ""}>1 来源</span>
            <span>·</span>
            <span className={step === "preview" ? "on" : ""}>2 预览</span>
            <span>·</span>
            <span className={step === "done" ? "on" : ""}>3 完成</span>
          </div>
        </div>
      }
      width={860}
      onClose={close}
      footer={footer}
    >
      {step === "source" && (
        <div className="stack gap-4">
          <div className="imp-tiles">
            {SOURCES.map((s) => (
              <button key={s.id} type="button" className={"imp-tile" + (source === s.id ? " on" : "")} onClick={() => pick(s.id)}>
                <span className="name">{s.name}</span>
                <span className="hint ellipsis">{s.hint}</span>
              </button>
            ))}
          </div>

          {src && (
            <div className="stack gap-3">
              {src.kind === "none" ? (
                <Field label="来源">
                  <span className="mono muted selectable">{path || "注册表"}</span>
                </Field>
              ) : (
                <Field label={src.kind === "dir" ? "文件夹" : "文件"} hint={path ? undefined : "未找到默认位置"}>
                  <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} />
                  <button className="btn" onClick={browse}>
                    浏览
                  </button>
                </Field>
              )}

              {source === "backup" && needPw && (
                <Field label="备份密码">
                  <input
                    className="input"
                    type="password"
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && canPreview && runPreview()}
                  />
                </Field>
              )}

              {source === "csv" && (
                <Field
                  label="格式"
                  top
                  hint="首行为表头，仅 host 必填"
                >
                  <div className="stack grow">
                    <pre className="imp-template">{CSV_TEMPLATE}</pre>
                    <div className="row">
                      <button className="btn sm" onClick={saveTemplate}>
                        <Download />
                        模板
                      </button>
                    </div>
                  </div>
                </Field>
              )}

              {error && (
                <Field label="">
                  <span className="imp-error">
                    <CircleX />
                    <span className="selectable">{error}</span>
                  </span>
                </Field>
              )}
            </div>
          )}
        </div>
      )}

      {step === "preview" && preview && (
        <PreviewStep
          preview={preview}
          selected={selected}
          setSelected={setSelected}
          skipDup={skipDup}
          setSkipDup={setSkipDup}
          group={group}
          setGroup={setGroup}
          withSnippets={withSnippets}
          setWithSnippets={setWithSnippets}
        />
      )}

      {step === "done" && result && <DoneStep result={result} />}
    </Dialog>
  );
}

function PreviewStep(props: {
  preview: ImportPreview;
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  skipDup: boolean;
  setSkipDup: (v: boolean) => void;
  group: string;
  setGroup: (v: string) => void;
  withSnippets: boolean;
  setWithSnippets: (v: boolean) => void;
}) {
  const { preview, selected, setSelected, skipDup } = props;
  const hosts = preview.hosts;
  const aliasName = useMemo(() => new Map(hosts.map((h) => [h.alias, h.name || h.host])), [hosts]);
  const dupCount = hosts.filter((h) => h.duplicate).length;
  const selectable = hosts.map((h, i) => (skipDup && h.duplicate ? -1 : i)).filter((i) => i >= 0);
  const allOn = selectable.length > 0 && selectable.every((i) => selected.has(i));

  const toggle = (i: number) => {
    const n = new Set(selected);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    setSelected(n);
  };
  const setSkip = (v: boolean) => {
    props.setSkipDup(v);
    const n = new Set(selected);
    hosts.forEach((h, i) => {
      if (!h.duplicate) return;
      if (v) n.delete(i);
      else n.add(i);
    });
    setSelected(n);
  };

  return (
    <div className="stack gap-3">
      {preview.warnings.length > 0 && (
        <div className="imp-msgs">
          {preview.warnings.map((w, i) => (
            <div key={i}>
              <TriangleAlert />
              <span className="selectable ellipsis" title={w}>
                {w}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="imp-bar">
        <div className="row">
          <span className="lbl">分组</span>
          <input className="input sm" style={{ width: 160 }} placeholder="保留原分组" value={props.group} onChange={(e) => props.setGroup(e.target.value)} />
        </div>
        {dupCount > 0 && (
          <div className="row">
            <Toggle on={skipDup} onChange={setSkip} />
            <span className="lbl">跳过已存在 {dupCount}</span>
          </div>
        )}
        {preview.snippets.length > 0 && (
          <div className="row">
            <Toggle on={props.withSnippets} onChange={props.setWithSnippets} />
            <span className="lbl">命令 {preview.snippets.length}</span>
          </div>
        )}
        <span className="spacer" />
        <span className="count">
          {selected.size} / {hosts.length}
        </span>
      </div>

      {hosts.length === 0 ? (
        <div className="empty">未找到服务器</div>
      ) : (
        <div className="imp-table">
          <table className="table">
            <colgroup>
              <col style={{ width: 36 }} />
              <col style={{ width: "22%" }} />
              <col style={{ width: "14%" }} />
              <col />
              <col style={{ width: 64 }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: 72 }} />
            </colgroup>
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={allOn} onChange={() => setSelected(new Set(allOn ? [] : selectable))} />
                </th>
                <th>名称</th>
                <th>分组</th>
                <th>地址</th>
                <th>认证</th>
                <th>跳板机</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((h, i) => {
                const disabled = skipDup && h.duplicate;
                const auth = h.keyPath || h.keyText ? "密钥" : h.password ? "密码" : "无";
                const addr = `${h.username || "root"}@${h.host}:${h.port || 22}`;
                const jump = h.jumpAlias ? aliasName.get(h.jumpAlias) ?? h.jumpAlias : "";
                return (
                  <tr key={i} className={disabled ? "off" : undefined} onClick={() => !disabled && toggle(i)}>
                    <td>
                      <input type="checkbox" disabled={disabled} checked={selected.has(i)} onChange={() => toggle(i)} onClick={(e) => e.stopPropagation()} />
                    </td>
                    <td title={h.name}>{h.name || h.host}</td>
                    <td className="muted" title={props.group.trim() || h.group}>
                      {props.group.trim() || h.group || "-"}
                    </td>
                    <td className="mono" title={addr}>
                      {addr}
                    </td>
                    <td className="muted">{auth}</td>
                    <td className="muted" title={jump}>
                      {jump || "-"}
                    </td>
                    <td className={h.duplicate ? "st-dup" : "st-new"}>{h.duplicate ? "已存在" : "新"}</td>
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

function DoneStep(props: { result: ImportResult }) {
  const r = props.result;
  const stats: [string, number][] = [
    ["服务器", r.hosts],
    ["密钥", r.keys],
    ["命令", r.snippets],
    ["隧道", r.tunnels],
  ];
  return (
    <div className="stack gap-4">
      <div className="imp-stats">
        {stats.map(([l, v]) => (
          <div key={l} className="imp-stat">
            <div className="v">{v}</div>
            <div className="l">{l}</div>
          </div>
        ))}
      </div>
      {r.errors.length > 0 && (
        <div className="stack gap-1">
          <div className="section-title">失败 {r.errors.length} 项</div>
          <div className="imp-msgs err tall">
            {r.errors.map((e, i) => (
              <div key={i}>
                <CircleX />
                <span className="selectable ellipsis" title={e}>
                  {e}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
