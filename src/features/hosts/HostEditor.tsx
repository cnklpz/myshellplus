// Add/edit host dialog (driven by store.editingHost: "" = new, id = edit).
// Two panes: live preview + section nav on the left, scrolling form on the right.
import {
  Ban, Bot, CircleCheck, CircleX, Eye, EyeOff, Fingerprint, KeyRound, LoaderCircle, Lock, Network, Palette, Server, X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Select } from "../../components/Select";
import { toast, useEscClose } from "../../components/ui";
import { api, errMsg, type AgentKey, type AgentPolicy, type Host, type KeyEntry, type OpHost, type OpStatus } from "../../lib/api";
import { useApp } from "../../store";
import { KeyManager } from "./KeyManager";
import { OnePasswordImport } from "./OnePasswordImport";
import "./hosts.css";

// Host label colors are stored per host (user data), so they are literal values, not theme tokens.
const COLORS = ["#ef6b6b", "#e5a54b", "#4cc38a", "#3fb6a8", "#5fa8f5", "#c58af0"];

const POLICIES: { id: AgentPolicy; label: string; desc: string }[] = [
  { id: "deny", label: "禁止", desc: "Agent 不可见" },
  { id: "readonly", label: "只读", desc: "仅允许查看类命令" },
  { id: "ask", label: "询问", desc: "每次操作需确认" },
  { id: "auto", label: "自动", desc: "仅危险命令需确认" },
];

type SecId = "basic" | "auth" | "net" | "look" | "agent";
const SECTIONS: { id: SecId; label: string; icon: ReactNode }[] = [
  { id: "basic", label: "基本信息", icon: <Server /> },
  { id: "auth", label: "认证", icon: <KeyRound /> },
  { id: "net", label: "网络", icon: <Network /> },
  { id: "look", label: "外观与备注", icon: <Palette /> },
  { id: "agent", label: "Agent 权限", icon: <Bot /> },
];

function blankHost(): Host {
  return {
    id: "", name: "", groupName: "", host: "", port: 22, username: "root", authType: "password",
    passwordSecret: null, keyId: null, jumpHostId: null, tags: [], color: "", notes: "",
    agentPolicy: "ask", sort: 0, updatedAt: 0,
  };
}

type ErrKey = "host" | "port" | "username" | "key";
type Errors = Partial<Record<ErrKey, string>>;
const ERR_SECTION: Record<ErrKey, SecId> = { host: "basic", port: "basic", username: "auth", key: "auth" };

type TestState = { state: "idle" | "run" | "ok" | "err"; msg?: string };

const splitTags = (s: string) => s.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
const uniq = (a: string[]) => [...new Set(a)];

function Label(props: { text: string; action?: ReactNode }) {
  return (
    <div className="he-label">
      <span>{props.text}</span>
      {props.action}
    </div>
  );
}

function Err(props: { text?: string }) {
  return props.text ? <div className="he-err">{props.text}</div> : null;
}

export function HostEditor() {
  const editingId = useApp((s) => s.editingHost);
  const hosts = useApp((s) => s.hosts);
  const openEditor = useApp((s) => s.openEditor);
  const existing = hosts.find((h) => h.id === editingId);
  const isNew = !existing;

  const [h, setH] = useState<Host>(() => (existing ? { ...existing } : blankHost()));
  const [tags, setTags] = useState<string[]>(() => existing?.tags ?? []);
  const [tagDraft, setTagDraft] = useState("");
  const [port, setPort] = useState(() => String(existing?.port ?? 22));
  /** undefined = untouched (keep), "" = clear, other = new password */
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [showPw, setShowPw] = useState(false);
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [keyMgr, setKeyMgr] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [test, setTest] = useState<TestState>({ state: "idle" });
  const [active, setActive] = useState<SecId>("basic");
  const [op, setOp] = useState<OpStatus | null>(null);
  /** null = not loaded; error text when the agent is unreachable */
  const [agentKeys, setAgentKeys] = useState<AgentKey[] | null>(null);
  const [agentErr, setAgentErr] = useState("");

  const mainRef = useRef<HTMLFormElement>(null);
  const secRefs = useRef<Partial<Record<SecId, HTMLElement | null>>>({});
  const navLock = useRef(0);

  useEffect(() => {
    api.keyList().then(setKeys).catch((e) => toast(errMsg(e), "error"));
    api.opStatus().then(setOp).catch(() => setOp(null));
  }, []);

  const loadAgentKeys = () => {
    setAgentErr("");
    api
      .agentKeys()
      .then(setAgentKeys)
      .catch((e) => {
        setAgentKeys([]);
        setAgentErr(errMsg(e));
      });
  };
  useEffect(() => {
    if (h.authType === "agent" && agentKeys === null) loadAgentKeys();
  }, [h.authType]);

  const groups = useMemo(() => [...new Set(hosts.map((x) => x.groupName.trim()).filter(Boolean))].sort(), [hosts]);
  const jumpCandidates = hosts.filter((x) => x.id !== h.id);
  const set = <K extends keyof Host>(k: K, v: Host[K]) => setH((p) => ({ ...p, [k]: v }));
  const clearErr = (k: ErrKey) => setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  const close = () => openEditor(null);
  const hasSavedPw = !!existing?.passwordSecret;
  const showAgent = !!op?.agent || !!op?.detected || h.authType === "agent";
  const agentLabel = op?.detected ? "1Password" : "SSH Agent";

  // key_id means a key-list id for "key" and a fingerprint for "agent", so it never carries over.
  const setAuth = (t: Host["authType"]) => setH((p) => (p.authType === t ? p : { ...p, authType: t, keyId: null }));

  const fromOnePassword = (o: OpHost) => {
    setH((p) => ({
      ...p,
      name: p.name.trim() ? p.name : o.title || p.name,
      host: o.host || p.host,
      username: o.username || p.username,
      ...(o.keyFingerprint ? { authType: "agent" as const, keyId: o.keyFingerprint } : o.password ? { authType: "password" as const, keyId: null } : {}),
    }));
    if (o.port) setPort(String(o.port));
    if (!o.keyFingerprint && o.password) setPassword(o.password);
    setErrors({});
  };

  useEscClose(close);

  // A finished test result goes stale as soon as connection-relevant fields change.
  useEffect(() => {
    setTest((t) => (t.state === "run" || t.state === "idle" ? t : { state: "idle" }));
  }, [h.host, port, h.username, h.authType, h.keyId, h.jumpHostId, password]);

  // Highlight the nav item of the section at the top of the scroll pane.
  useEffect(() => {
    const root = mainRef.current;
    if (!root) return;
    const visible = new Set<string>();
    const pick = () => {
      if (Date.now() < navLock.current) return;
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) {
        setActive(SECTIONS[SECTIONS.length - 1].id);
        return;
      }
      const first = SECTIONS.find((s) => visible.has(s.id));
      if (first) setActive(first.id);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.sec!;
          if (e.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        pick();
      },
      { root, rootMargin: "0px 0px -60% 0px", threshold: 0 },
    );
    for (const s of SECTIONS) {
      const el = secRefs.current[s.id];
      if (el) io.observe(el);
    }
    root.addEventListener("scroll", pick, { passive: true });
    return () => {
      io.disconnect();
      root.removeEventListener("scroll", pick);
    };
  }, []);

  const goto = (id: SecId) => {
    const root = mainRef.current;
    const el = secRefs.current[id];
    if (!root || !el) return;
    navLock.current = Date.now() + 700;
    setActive(id);
    const pad = parseFloat(getComputedStyle(root).paddingTop) || 0;
    root.scrollTo({ top: el.offsetTop - pad, behavior: "smooth" });
  };

  const addTags = (raw: string) => {
    const add = splitTags(raw);
    if (add.length) setTags((t) => uniq([...t, ...add]));
  };

  const validate = (): Host | null => {
    const e: Errors = {};
    if (!h.host.trim()) e.host = "请填写地址";
    else if (/\s/.test(h.host.trim())) e.host = "地址不能包含空格";
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) e.port = "端口 1–65535";
    if (!h.username.trim()) e.username = "请填写用户名";
    if (h.authType === "key" && !h.keyId) e.key = "请选择密钥";
    setErrors(e);
    const bad = Object.keys(e) as ErrKey[];
    if (bad.length) {
      goto(ERR_SECTION[bad[0]]);
      return null;
    }
    const allTags = uniq([...tags, ...splitTags(tagDraft)]);
    setTags(allTags);
    setTagDraft("");
    return {
      ...h,
      name: h.name.trim() || h.host.trim(),
      groupName: h.groupName.trim(),
      host: h.host.trim(),
      username: h.username.trim(),
      port: p,
      tags: allTags,
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
    if (busy) return;
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
    if (busy) return;
    setBusy("test");
    setTest({ state: "run" });
    try {
      const saved = await save();
      if (!saved) {
        setTest({ state: "idle" });
        return;
      }
      await api.connConnect(saved.id);
      setTest({ state: "ok" });
    } catch (e) {
      setTest({ state: "err", msg: errMsg(e) });
    } finally {
      setBusy("");
    }
  };

  // Ctrl+S / Ctrl+Enter saves — only while no nested dialog (key manager) is on top.
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  useEffect(() => {
    if (keyMgr) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "s" || e.key === "S" || e.key === "Enter") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyMgr]);

  const pwPlaceholder = hasSavedPw && password === undefined ? "已保存" : password === "" && hasSavedPw ? "将清除" : "";
  const secErr = (id: SecId) => (Object.keys(errors) as ErrKey[]).some((k) => errors[k] && ERR_SECTION[k] === id);
  const secRef = (id: SecId) => (el: HTMLElement | null) => {
    secRefs.current[id] = el;
  };

  // Preview
  const pvName = h.name.trim() || h.host.trim();
  const pvAddr = `${h.username.trim() || "root"}@${h.host.trim() || "host"}${port && port !== "22" ? `:${port}` : ""}`;
  const tint = h.color ? { background: `color-mix(in srgb, ${h.color} 16%, transparent)`, color: h.color } : undefined;

  return (
    <>
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div className="he-dialog" role="dialog" aria-label={isNew ? "新建服务器" : "编辑服务器"}>
          <header className="he-head">
            <span className="grow ellipsis">{isNew ? "新建服务器" : `编辑 · ${existing?.name}`}</span>
            <button className="icon-btn" onClick={close} title="关闭">
              <X />
            </button>
          </header>

          <div className="he-body">
            <aside className="he-side">
              <div className="he-preview">
                {h.color && <span className="he-preview-marker" style={{ background: h.color }} />}
                <div className="he-tile" style={tint}>
                  <Server />
                </div>
                <div className="he-preview-text">
                  <div className={"he-preview-name ellipsis" + (pvName ? "" : " is-empty")}>{pvName || "新服务器"}</div>
                  <div className="he-preview-addr mono ellipsis">{pvAddr}</div>
                  <div className="he-preview-group ellipsis">{h.groupName.trim() || "未分组"}</div>
                </div>
              </div>

              <nav className="he-nav">
                {SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={"he-nav-item" + (active === s.id ? " on" : "")}
                    onClick={() => goto(s.id)}
                  >
                    {s.icon}
                    <span className="grow ellipsis">{s.label}</span>
                    {secErr(s.id) && <span className="dot err" />}
                  </button>
                ))}
              </nav>
            </aside>

            <form
              className="he-main"
              ref={mainRef}
              onSubmit={(e) => {
                e.preventDefault();
                onSave();
              }}
            >
              {isNew && op?.detected && <OnePasswordImport status={op} onPick={fromOnePassword} />}

              <section className="he-sec" data-sec="basic" ref={secRef("basic")}>
                <h3 className="he-sec-title">基本信息</h3>
                <div className="he-grid">
                  <div className="he-field">
                    <Label text="名称" />
                    <input className="input" autoFocus value={h.name} onChange={(e) => set("name", e.target.value)} placeholder="web-01" />
                  </div>
                  <div className="he-field">
                    <Label text="分组" />
                    <input className="input" list="he-groups" value={h.groupName} onChange={(e) => set("groupName", e.target.value)} placeholder="生产" />
                    <datalist id="he-groups">
                      {groups.map((g) => (
                        <option key={g} value={g} />
                      ))}
                    </datalist>
                  </div>
                </div>
                <div className="he-grid addr">
                  <div className="he-field">
                    <Label text="地址" />
                    <input
                      className={"input mono" + (errors.host ? " invalid" : "")}
                      value={h.host}
                      onChange={(e) => {
                        set("host", e.target.value);
                        clearErr("host");
                      }}
                      placeholder="192.168.1.10"
                      spellCheck={false}
                    />
                    <Err text={errors.host} />
                  </div>
                  <div className="he-field">
                    <Label text="端口" />
                    <input
                      className={"input num mono" + (errors.port ? " invalid" : "")}
                      value={port}
                      inputMode="numeric"
                      onChange={(e) => {
                        setPort(e.target.value.replace(/\D/g, ""));
                        clearErr("port");
                      }}
                    />
                    <Err text={errors.port} />
                  </div>
                </div>
              </section>

              <section className="he-sec" data-sec="auth" ref={secRef("auth")}>
                <h3 className="he-sec-title">认证</h3>
                <div className="he-field">
                  <Label text="用户名" />
                  <input
                    className={"input" + (errors.username ? " invalid" : "")}
                    value={h.username}
                    onChange={(e) => {
                      set("username", e.target.value);
                      clearErr("username");
                    }}
                    placeholder="root"
                    spellCheck={false}
                  />
                  <Err text={errors.username} />
                </div>
                <div className="he-field">
                  <Label text="认证方式" />
                  <div className={"he-grid" + (showAgent ? " three" : "")}>
                    <button
                      type="button"
                      className={"he-choice" + (h.authType === "password" ? " on" : "")}
                      aria-pressed={h.authType === "password"}
                      onClick={() => setAuth("password")}
                    >
                      <span className="he-choice-icon"><Lock /></span>
                      密码
                    </button>
                    <button
                      type="button"
                      className={"he-choice" + (h.authType === "key" ? " on" : "")}
                      aria-pressed={h.authType === "key"}
                      onClick={() => setAuth("key")}
                    >
                      <span className="he-choice-icon"><KeyRound /></span>
                      密钥
                    </button>
                    {showAgent && (
                      <button
                        type="button"
                        className={"he-choice" + (h.authType === "agent" ? " on" : "")}
                        aria-pressed={h.authType === "agent"}
                        onClick={() => setAuth("agent")}
                      >
                        <span className="he-choice-icon"><Fingerprint /></span>
                        {agentLabel}
                      </button>
                    )}
                  </div>
                </div>
                {h.authType === "password" ? (
                  <div className="he-field">
                    <Label
                      text="密码"
                      action={
                        hasSavedPw &&
                        (password === undefined ? (
                          <button type="button" className="link-btn" onClick={() => setPassword("")}>清除</button>
                        ) : (
                          <button type="button" className="link-btn" onClick={() => setPassword(undefined)}>撤销</button>
                        ))
                      }
                    />
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
                  </div>
                ) : h.authType === "agent" ? (
                  <div className="he-field">
                    <Label
                      text="Agent 密钥"
                      action={<button type="button" className="link-btn" onClick={loadAgentKeys}>刷新</button>}
                    />
                    <Select
                      width="100%"
                      value={h.keyId ?? ""}
                      options={[
                        { value: "", label: "任意密钥" },
                        // Keep a saved fingerprint selectable even when the agent is locked or unreachable.
                        ...(h.keyId && !agentKeys?.some((k) => k.fingerprint === h.keyId) ? [{ value: h.keyId, label: h.keyId }] : []),
                        ...(agentKeys ?? []).map((k) => ({ value: k.fingerprint, label: k.comment || k.fingerprint, text: k.comment, hint: k.algo })),
                      ]}
                      onChange={(v) => set("keyId", v || null)}
                    />
                    <Err text={agentErr} />
                  </div>
                ) : (
                  <div className="he-field">
                    <Label text="密钥" />
                    <div className="row">
                      <Select
                        width="100%"
                        className={errors.key ? "invalid" : undefined}
                        value={h.keyId ?? ""}
                        options={[{ value: "", label: keys.length ? "选择密钥" : "无密钥" }, ...keys.map((k) => ({ value: k.id, label: k.name }))]}
                        onChange={(v) => {
                          set("keyId", v || null);
                          clearErr("key");
                        }}
                      />
                      <button type="button" className="btn" style={{ flex: "none" }} onClick={() => setKeyMgr(true)}>
                        <KeyRound /> 管理
                      </button>
                    </div>
                    <Err text={errors.key} />
                  </div>
                )}
              </section>

              <section className="he-sec" data-sec="net" ref={secRef("net")}>
                <h3 className="he-sec-title">网络</h3>
                <div className="he-field">
                  <Label text="跳板机" />
                  <Select
                    width="100%"
                    value={h.jumpHostId ?? ""}
                    options={[{ value: "", label: "无" }, ...jumpCandidates.map((x) => ({ value: x.id, label: `${x.name} (${x.host})` }))]}
                    onChange={(v) => set("jumpHostId", v || null)}
                  />
                </div>
              </section>

              <section className="he-sec" data-sec="look" ref={secRef("look")}>
                <h3 className="he-sec-title">外观与备注</h3>
                <div className="he-field">
                  <Label text="颜色" />
                  <div className="he-swatches">
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
                  </div>
                </div>
                <div className="he-field">
                  <Label text="标签" />
                  <div className="he-chips" onMouseDown={(e) => {
                    if (e.target === e.currentTarget) {
                      e.preventDefault();
                      (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus();
                    }
                  }}>
                    {tags.map((t) => (
                      <span className="he-chip" key={t}>
                        <span className="ellipsis">{t}</span>
                        <button type="button" title="移除" onClick={() => setTags((a) => a.filter((x) => x !== t))}>
                          <X />
                        </button>
                      </span>
                    ))}
                    <input
                      value={tagDraft}
                      placeholder={tags.length ? "" : "prod"}
                      spellCheck={false}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (/[,，]/.test(v)) {
                          const parts = v.split(/[,，]/);
                          addTags(parts.slice(0, -1).join(","));
                          setTagDraft(parts[parts.length - 1]);
                        } else setTagDraft(v);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && tagDraft.trim()) {
                          e.preventDefault();
                          addTags(tagDraft);
                          setTagDraft("");
                        } else if (e.key === "Backspace" && !tagDraft && tags.length) {
                          e.preventDefault();
                          setTags((a) => a.slice(0, -1));
                        }
                      }}
                      onBlur={() => {
                        if (tagDraft.trim()) {
                          addTags(tagDraft);
                          setTagDraft("");
                        }
                      }}
                    />
                  </div>
                </div>
                <div className="he-field">
                  <Label text="备注" />
                  <textarea className="textarea" rows={3} value={h.notes} onChange={(e) => set("notes", e.target.value)} />
                </div>
              </section>

              <section className="he-sec" data-sec="agent" ref={secRef("agent")}>
                <div className="he-sec-head">
                  <h3 className="he-sec-title">Agent 权限</h3>
                  <div className="he-sec-caption">AI 助手在此服务器上可执行的操作</div>
                </div>
                <div className="he-options" role="radiogroup">
                  {POLICIES.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={h.agentPolicy === p.id}
                      className={"he-option" + (h.agentPolicy === p.id ? " on" : "")}
                      onClick={() => set("agentPolicy", p.id)}
                    >
                      <span className="he-radio" />
                      <span className="he-option-title">{p.label}</span>
                      <span className="he-option-desc ellipsis">{p.desc}</span>
                    </button>
                  ))}
                </div>
              </section>
              <button type="submit" hidden />
            </form>
          </div>

          <footer className="he-foot">
            <button className="btn" disabled={!!busy} onClick={onTest}>测试连接</button>
            <span className={"he-test " + test.state} title={test.msg}>
              {test.state === "run" && (
                <>
                  <LoaderCircle className="spin" /> 连接中…
                </>
              )}
              {test.state === "ok" && (
                <>
                  <CircleCheck /> 连接成功
                </>
              )}
              {test.state === "err" && (
                <>
                  <CircleX /> <span className="ellipsis selectable">{test.msg}</span>
                </>
              )}
            </span>
            <button className="btn" onClick={close}>取消</button>
            <button className="btn primary" disabled={!!busy} onClick={onSave} title="保存 (Ctrl+S)">
              {busy === "save" ? "保存中…" : "保存"}
            </button>
          </footer>
        </div>
      </div>

      {keyMgr && (
        <KeyManager
          onClose={() => setKeyMgr(false)}
          onChanged={(list, created) => {
            setKeys(list);
            if (created) clearErr("key");
            setH((p) =>
              created ? { ...p, keyId: created.id } : p.keyId && !list.some((k) => k.id === p.keyId) ? { ...p, keyId: null } : p,
            );
          }}
        />
      )}
    </>
  );
}
