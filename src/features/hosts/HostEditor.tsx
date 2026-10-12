// Add/edit host dialog (driven by store.editingHost: "" = new, id = edit).
import { Ban, Eye, EyeOff, KeyRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Dialog, Field, toast } from "../../components/ui";
import { api, errMsg, type AgentPolicy, type Host, type KeyEntry } from "../../lib/api";
import { useApp } from "../../store";
import { KeyManager } from "./KeyManager";
import "./hosts.css";

const COLORS = ["#ef6b6b", "#e5a54b", "#4cc38a", "#3fb6a8", "#5fa8f5", "#c58af0"];

const POLICIES: { id: AgentPolicy; label: string; desc: string }[] = [
  { id: "deny", label: "禁止", desc: "Agent 看不到此服务器" },
  { id: "readonly", label: "只读", desc: "只允许查看类命令" },
  { id: "ask", label: "每次询问", desc: "每个操作都要你确认" },
  { id: "auto", label: "自动", desc: "高风险命令才询问" },
];

function blankHost(): Host {
  return {
    id: "", name: "", groupName: "", host: "", port: 22, username: "root", authType: "password",
    passwordSecret: null, keyId: null, jumpHostId: null, tags: [], color: "", notes: "",
    agentPolicy: "ask", sort: 0, updatedAt: 0,
  };
}

type Errors = Partial<Record<"host" | "port" | "username" | "key", string>>;

export function HostEditor() {
  const editingId = useApp((s) => s.editingHost);
  const hosts = useApp((s) => s.hosts);
  const openEditor = useApp((s) => s.openEditor);
  const existing = hosts.find((h) => h.id === editingId);
  const isNew = !existing;

  const [h, setH] = useState<Host>(() => (existing ? { ...existing } : blankHost()));
  const [tags, setTags] = useState(() => (existing?.tags ?? []).join(", "));
  const [port, setPort] = useState(() => String(existing?.port ?? 22));
  /** undefined = untouched (keep), "" = clear, other = new password */
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [showPw, setShowPw] = useState(false);
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [keyMgr, setKeyMgr] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<"" | "save" | "test">("");

  useEffect(() => {
    api.keyList().then(setKeys).catch((e) => toast(errMsg(e), "error"));
  }, []);

  const groups = useMemo(() => [...new Set(hosts.map((x) => x.groupName.trim()).filter(Boolean))].sort(), [hosts]);
  const jumpCandidates = hosts.filter((x) => x.id !== h.id);
  const set = <K extends keyof Host>(k: K, v: Host[K]) => setH((p) => ({ ...p, [k]: v }));
  const close = () => openEditor(null);
  const hasSavedPw = !!existing?.passwordSecret;
  const policy = POLICIES.find((p) => p.id === h.agentPolicy) ?? POLICIES[2];

  const validate = (): Host | null => {
    const e: Errors = {};
    if (!h.host.trim()) e.host = "请填写地址";
    else if (/\s/.test(h.host.trim())) e.host = "地址不能包含空格";
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) e.port = "端口 1–65535";
    if (!h.username.trim()) e.username = "请填写用户名";
    if (h.authType === "key" && !h.keyId) e.key = "请选择密钥";
    setErrors(e);
    if (Object.keys(e).length) return null;
    return {
      ...h,
      name: h.name.trim() || h.host.trim(),
      groupName: h.groupName.trim(),
      host: h.host.trim(),
      username: h.username.trim(),
      port: p,
      tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      keyId: h.keyId ?? null,
    };
  };

  /** Saves and returns the stored host; keeps the dialog in "edit" mode afterwards. */
  const save = async (): Promise<Host | null> => {
    const data = validate();
    if (!data) return null;
    const saved = await api.hostSave(data, password);
    await useApp.getState().refreshHosts();
    setH(saved);
    setPassword(undefined);
    if (isNew) openEditor(saved.id);
    return saved;
  };

  const onSave = async () => {
    setBusy("save");
    try {
      if (await save()) close();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  const onTest = async () => {
    setBusy("test");
    try {
      const saved = await save();
      if (!saved) return;
      await api.connConnect(saved.id);
      toast(`已连接到 ${saved.name}`, "success");
    } catch (e) {
      toast("连接失败：" + errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  const pwPlaceholder = hasSavedPw && password === undefined ? "已保存，留空不修改" : password === "" && hasSavedPw ? "将清除已保存的密码" : "";

  return (
    <>
      <Dialog
        title={isNew ? "新建服务器" : `编辑 ${existing?.name}`}
        width={560}
        onClose={keyMgr ? () => {} : close}
        footer={
          <>
            <button className="btn" disabled={!!busy} onClick={onTest}>
              {busy === "test" ? "连接中…" : "测试连接"}
            </button>
            <span className="spacer" />
            <button className="btn" onClick={close}>取消</button>
            <button className="btn primary" disabled={!!busy} onClick={onSave}>
              {busy === "save" ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        <form
          className="he-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <Field label="名称">
            <input className="input" autoFocus value={h.name} onChange={(e) => set("name", e.target.value)} placeholder="留空使用地址" />
          </Field>
          <Field label="分组">
            <input className="input" list="he-groups" value={h.groupName} onChange={(e) => set("groupName", e.target.value)} placeholder="未分组" />
            <datalist id="he-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
          <Field label="地址" hint={errors.host || errors.port ? <span className="he-err">{errors.host ?? errors.port}</span> : undefined}>
            <input
              className="input mono"
              value={h.host}
              onChange={(e) => set("host", e.target.value)}
              placeholder="192.168.1.10 或 example.com"
              spellCheck={false}
            />
            <span className="faint" style={{ whiteSpace: "nowrap", flex: "none" }}>端口</span>
            <input
              className="input num"
              style={{ width: 80, flex: "none" }}
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Field label="用户名" hint={errors.username && <span className="he-err">{errors.username}</span>}>
            <input className="input" value={h.username} onChange={(e) => set("username", e.target.value)} spellCheck={false} />
          </Field>
          <Field label="认证方式">
            <div className="seg">
              <button type="button" className={h.authType === "password" ? "on" : ""} onClick={() => set("authType", "password")}>
                密码
              </button>
              <button type="button" className={h.authType === "key" ? "on" : ""} onClick={() => set("authType", "key")}>
                密钥
              </button>
            </div>
          </Field>
          {h.authType === "password" ? (
            <Field label="密码">
              <div className="pw-wrap">
                <input
                  className="input"
                  type={showPw ? "text" : "password"}
                  value={password ?? ""}
                  placeholder={pwPlaceholder}
                  onChange={(e) => setPassword(e.target.value === "" ? undefined : e.target.value)}
                  autoComplete="new-password"
                />
                <button type="button" className="icon-btn" title={showPw ? "隐藏" : "显示"} onClick={() => setShowPw(!showPw)}>
                  {showPw ? <EyeOff /> : <Eye />}
                </button>
              </div>
              {hasSavedPw && password === undefined && (
                <button type="button" className="link-btn" onClick={() => setPassword("")}>清除</button>
              )}
              {hasSavedPw && password !== undefined && (
                <button type="button" className="link-btn" onClick={() => setPassword(undefined)}>撤销</button>
              )}
            </Field>
          ) : (
            <Field label="密钥" hint={errors.key && <span className="he-err">{errors.key}</span>}>
              <select className="select" value={h.keyId ?? ""} onChange={(e) => set("keyId", e.target.value || null)}>
                <option value="">{keys.length ? "选择密钥" : "还没有密钥"}</option>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>{k.name}</option>
                ))}
              </select>
              <button type="button" className="btn" style={{ flex: "none" }} onClick={() => setKeyMgr(true)}>
                <KeyRound /> 管理密钥
              </button>
            </Field>
          )}
          <Field label="跳板机">
            <select className="select" value={h.jumpHostId ?? ""} onChange={(e) => set("jumpHostId", e.target.value || null)}>
              <option value="">无</option>
              {jumpCandidates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} ({x.host})
                </option>
              ))}
            </select>
          </Field>
          <Field label="颜色">
            <button type="button" className={"swatch none" + (!h.color ? " on" : "")} title="无" onClick={() => set("color", "")}>
              <Ban />
            </button>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={"swatch" + (h.color === c ? " on" : "")}
                style={{ background: c }}
                onClick={() => set("color", c)}
              />
            ))}
          </Field>
          <Field label="标签">
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="逗号分隔，如 prod, web" />
          </Field>
          <Field label="备注" top>
            <textarea className="textarea" rows={2} value={h.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          <Field label="Agent 权限" hint={policy.desc}>
            <div className="seg">
              {POLICIES.map((p) => (
                <button key={p.id} type="button" className={h.agentPolicy === p.id ? "on" : ""} onClick={() => set("agentPolicy", p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
          </Field>
          <button type="submit" hidden />
        </form>
      </Dialog>

      {keyMgr && (
        <KeyManager
          onClose={() => setKeyMgr(false)}
          onChanged={(list, created) => {
            setKeys(list);
            setH((p) =>
              created ? { ...p, keyId: created.id } : p.keyId && !list.some((k) => k.id === p.keyId) ? { ...p, keyId: null } : p,
            );
          }}
        />
      )}
    </>
  );
}
