// Settings page: AI providers, security, appearance, backup/import, sync, about.
import { getVersion } from "@tauri-apps/api/app";
import { appDataDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { Archive, Bot, Cloud, Info, Lock, Palette, Plus, Shield, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog, Field, Toggle, toast } from "../../components/ui";
import { type AiProvider, type AiSettings, api, errMsg } from "../../lib/api";
import { useApp } from "../../store";
import "./settings.css";

type Section = "ai" | "security" | "appearance" | "backup" | "sync" | "about";

const SECTIONS: { id: Section; icon: typeof Bot; label: string }[] = [
  { id: "ai", icon: Bot, label: "AI 服务" },
  { id: "security", icon: Shield, label: "安全" },
  { id: "appearance", icon: Palette, label: "外观" },
  { id: "backup", icon: Archive, label: "备份与导入" },
  { id: "sync", icon: Cloud, label: "云同步" },
  { id: "about", icon: Info, label: "关于" },
];

export function SettingsView() {
  const [section, setSection] = useState<Section>("ai");
  return (
    <div className="page">
      <div className="page-header">
        <h1>设置</h1>
      </div>
      <div className="set-layout">
        <nav className="set-nav">
          {SECTIONS.map((s) => (
            <div key={s.id} className={"list-row" + (section === s.id ? " selected" : "")} onClick={() => setSection(s.id)}>
              <s.icon />
              <span className="ellipsis">{s.label}</span>
            </div>
          ))}
        </nav>
        <div className="set-content">
          <div className="set-inner">
            {section === "ai" && <AiSection />}
            {section === "security" && <SecuritySection />}
            {section === "appearance" && <AppearanceSection />}
            {section === "backup" && <BackupSection />}
            {section === "sync" && <SyncSection />}
            {section === "about" && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Title(props: { text: string; children?: React.ReactNode }) {
  return (
    <div className="set-title">
      <h2>{props.text}</h2>
      <span className="spacer" />
      {props.children}
    </div>
  );
}

function Seg<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {props.options.map((o) => (
        <button key={o.value} type="button" className={props.value === o.value ? "on" : ""} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- AI

const PRESETS: { label: string; p: Omit<AiProvider, "id"> }[] = [
  { label: "Claude", p: { name: "Claude", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" } },
  { label: "DeepSeek", p: { name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" } },
  { label: "通义千问", p: { name: "通义千问", kind: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" } },
  { label: "Ollama 本地", p: { name: "Ollama", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder" } },
  { label: "自定义", p: { name: "自定义服务", kind: "openai", baseUrl: "", model: "" } },
];

function AiSection() {
  const [s, setS] = useState<AiSettings | null>(null);
  /** providerId -> new key; "" = clear on save. Only edited providers are present. */
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [preset, setPreset] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      setS(await api.aiSettingsGet());
      setKeys({});
      setDirty(false);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  useEffect(() => {
    load();
  }, []);

  if (!s) return <Title text="AI 服务" />;

  const update = (patch: Partial<AiSettings>) => {
    setS({ ...s, ...patch });
    setDirty(true);
  };
  const updateProvider = (id: string, patch: Partial<AiProvider>) =>
    update({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const setKey = (id: string, v: string | null) => {
    const next = { ...keys };
    if (v === null) delete next[id];
    else next[id] = v;
    setKeys(next);
    setDirty(true);
  };
  const add = () => {
    const id = "p" + Date.now().toString(36);
    const providers = [...s.providers, { id, ...PRESETS[preset].p }];
    update({
      providers,
      active: s.active && providers.some((p) => p.id === s.active) ? s.active : id,
      predictProvider: s.predictProvider && providers.some((p) => p.id === s.predictProvider) ? s.predictProvider : id,
    });
  };
  const remove = (id: string) => {
    const providers = s.providers.filter((p) => p.id !== id);
    const fallback = providers[0]?.id ?? null;
    update({
      providers,
      active: s.active === id ? fallback : s.active,
      predictProvider: s.predictProvider === id ? fallback : s.predictProvider,
    });
    setKey(id, null);
  };

  const saveAll = async () => {
    setBusy("save");
    try {
      await api.aiSettingsSave(s, keys);
      toast("已保存", "success");
      await load();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  };

  /** Save with this provider as default, run a trivial request, then restore the default. */
  const test = async (p: AiProvider) => {
    setBusy(p.id);
    try {
      await api.aiSettingsSave({ ...s, active: p.id }, keys);
      try {
        const r = await api.aiNl2Cmd("", "列出当前目录");
        toast(`${p.name} 可用：${r.command || r.explanation}`, "success");
      } catch (e) {
        toast(`${p.name} 测试失败：${errMsg(e)}`, "error");
      } finally {
        await api.aiSettingsSave(s, {});
      }
      await load();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const providerOptions = s.providers.map((p) => (
    <option key={p.id} value={p.id}>
      {p.name || p.id}
    </option>
  ));

  return (
    <>
      <Title text="AI 服务">
        {dirty && <span className="faint">有未保存的修改</span>}
        <button className="btn primary" disabled={!dirty || busy !== null} onClick={saveAll}>
          保存
        </button>
      </Title>

      <div className="card set-card">
        <div className="set-card-head">
          <Bot />
          <span className="grow">服务</span>
          <select className="select sm" style={{ width: 128 }} value={preset} onChange={(e) => setPreset(Number(e.target.value))}>
            {PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
          <button className="btn sm" onClick={add}>
            <Plus />
            添加服务
          </button>
        </div>
        {s.providers.length === 0 && <div className="set-note">尚未添加 AI 服务</div>}
        {s.providers.map((p) => {
          const k = keys[p.id];
          const placeholder = k === "" ? "保存后清除" : p.apiKeySecret ? "已保存" : "未设置";
          return (
            <div key={p.id} className="set-sub">
              <Field label="名称">
                <input className="input" value={p.name} onChange={(e) => updateProvider(p.id, { name: e.target.value })} />
                <button className="btn" disabled={busy !== null} onClick={() => test(p)} title="保存后用此服务生成一条命令">
                  <Zap />
                  {busy === p.id ? "测试中…" : "测试"}
                </button>
                <button className="btn danger" onClick={() => remove(p.id)} title="删除服务">
                  <Trash2 />
                </button>
              </Field>
              <Field label="类型">
                <Seg
                  value={p.kind}
                  options={[
                    { value: "anthropic", label: "Anthropic" },
                    { value: "openai", label: "OpenAI 兼容" },
                  ]}
                  onChange={(kind) => updateProvider(p.id, { kind })}
                />
              </Field>
              <Field label="Base URL">
                <input className="input mono" value={p.baseUrl} onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })} />
              </Field>
              <Field label="模型">
                <input className="input mono" value={p.model} onChange={(e) => updateProvider(p.id, { model: e.target.value })} />
              </Field>
              <Field label="API Key">
                <input
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  value={k ?? ""}
                  placeholder={placeholder}
                  onChange={(e) => setKey(p.id, e.target.value === "" ? null : e.target.value)}
                />
                <button className="btn" disabled={!p.apiKeySecret && !k} onClick={() => setKey(p.id, p.apiKeySecret ? "" : null)}>
                  清除
                </button>
              </Field>
            </div>
          );
        })}
      </div>

      <div className="card set-card">
        <div className="set-card-head">
          <Zap />
          <span>用途</span>
        </div>
        <Field label="默认服务">
          <select className="select" value={s.active ?? ""} onChange={(e) => update({ active: e.target.value || null })}>
            <option value="">未选择</option>
            {providerOptions}
          </select>
        </Field>
        <Field label="预测服务" hint="命令预测建议选响应快的模型，例如 claude-haiku-5-5">
          <select className="select" value={s.predictProvider ?? ""} onChange={(e) => update({ predictProvider: e.target.value || null })}>
            <option value="">同默认服务</option>
            {providerOptions}
          </select>
        </Field>
        <Field label="本地命令预测">
          <Toggle on={s.predictEnabled} onChange={(v) => update({ predictEnabled: v })} />
          <span className="set-note">根据历史命令和片段补全</span>
        </Field>
        <Field label="AI 命令预测">
          <Toggle on={s.aiPredictEnabled} onChange={(v) => update({ aiPredictEnabled: v })} />
          <span className="set-note">会把当前输入和屏幕内容发送给预测服务</span>
        </Field>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- security

function SecuritySection() {
  const vault = useApp((s) => s.vault);
  const [changing, setChanging] = useState(false);

  const remember = async (on: boolean) => {
    try {
      await api.vaultRemember(on);
      await useApp.getState().refreshVault();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const lock = async () => {
    try {
      await api.vaultLock();
      await useApp.getState().refreshVault();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  return (
    <>
      <Title text="安全" />
      <div className="card set-card">
        <div className="set-card-head">
          <Lock />
          <span>保险库</span>
        </div>
        <Field label="状态">
          <span className={"dot " + (vault?.unlocked ? "ok" : "warn")} />
          <span>{vault?.unlocked ? "已解锁" : "已锁定"}</span>
        </Field>
        <Field label="记住主密码" hint="开启后启动时自动解锁（密钥经 Windows DPAPI 加密保存，仅当前用户可用）">
          <Toggle on={!!vault?.remembered} onChange={remember} />
          <span className="set-note">在此设备上记住主密码</span>
        </Field>
        <Field label="主密码">
          <button className="btn" onClick={() => setChanging(true)}>
            修改主密码
          </button>
          <button className="btn" onClick={lock}>
            <Lock />
            立即锁定
          </button>
        </Field>
      </div>
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
    </>
  );
}

function ChangePasswordDialog(props: { onClose: () => void }) {
  const [old, setOld] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const mismatch = confirm !== "" && next !== confirm;
  const ok = old !== "" && next !== "" && next === confirm && !busy;

  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      await api.vaultChangePassword(old, next);
      toast("主密码已修改", "success");
      props.onClose();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="修改主密码"
      width={440}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!ok} onClick={submit}>
            修改
          </button>
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
        <Field label="当前密码">
          <input className="input" type="password" autoFocus value={old} onChange={(e) => setOld(e.target.value)} />
        </Field>
        <Field label="新密码">
          <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="确认新密码" hint={mismatch ? "两次输入不一致" : undefined}>
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- appearance

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
}

function AppearanceSection() {
  const [theme, setTheme] = useState<"dark" | "light">(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [fontSize, setFontSize] = useState(lsGet("termFontSize") ?? "14");

  const applyTheme = (t: "dark" | "light") => {
    setTheme(t);
    if (t === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    lsSet("theme", t);
  };
  const applyFont = (v: string) => {
    setFontSize(v);
    lsSet("termFontSize", v);
  };

  return (
    <>
      <Title text="外观" />
      <div className="card set-card">
        <Field label="主题">
          <Seg
            value={theme}
            options={[
              { value: "dark", label: "深色" },
              { value: "light", label: "浅色" },
            ]}
            onChange={applyTheme}
          />
        </Field>
        <Field label="终端字号" hint="新打开的终端生效">
          <select className="select" style={{ width: 120 }} value={fontSize} onChange={(e) => applyFont(e.target.value)}>
            {["13", "14", "15", "16"].map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </select>
        </Field>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- backup

function BackupSection() {
  const [exporting, setExporting] = useState(false);
  return (
    <>
      <Title text="备份与导入" />
      <div className="card set-card">
        <Field label="导入服务器" hint="支持 OpenSSH、PuTTY、Xshell、MobaXterm、FinalShell、CSV 和 MyShell+ 备份">
          <button className="btn" onClick={() => useApp.getState().setImportOpen(true)}>
            导入服务器
          </button>
        </Field>
        <Field label="导出备份" hint="导出服务器、分组、片段和隧道，可选包含密码和密钥">
          <button className="btn" onClick={() => setExporting(true)}>
            导出备份
          </button>
        </Field>
      </div>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </>
  );
}

function ExportDialog(props: { onClose: () => void }) {
  const [secrets, setSecrets] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = !busy && (!secrets || (pw !== "" && pw === pw2));

  const run = async () => {
    if (!ok) return;
    try {
      const path = await save({ defaultPath: "myshellplus-backup.json", filters: [{ name: "MyShell+ 备份", extensions: ["json"] }] });
      if (!path) return;
      setBusy(true);
      const n = await api.exportBackup(path, secrets ? pw : undefined);
      toast(`已导出 ${n} 台服务器`, "success");
      props.onClose();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="导出备份"
      width={480}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!ok} onClick={run}>
            选择位置并导出
          </button>
        </>
      }
    >
      <div className="stack gap-3">
        <Field label="包含密码和密钥">
          <Toggle on={secrets} onChange={setSecrets} />
        </Field>
        {secrets ? (
          <>
            <Field label="备份密码" hint="密码和私钥会用此密码加密，导入时需要输入。请妥善保管，遗失无法恢复。">
              <input className="input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
            </Field>
            <Field label="确认密码" hint={pw2 !== "" && pw !== pw2 ? "两次输入不一致" : undefined}>
              <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </Field>
          </>
        ) : (
          <Field label="">
            <span className="set-note">不包含任何密码和私钥，导入后需要重新填写。</span>
          </Field>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- sync

function SyncSection() {
  return (
    <>
      <Title text="云同步" />
      <div className="card set-card">
        <div className="set-note">即将推出：使用自己的服务器进行端到端加密同步</div>
        <Field label="服务器地址">
          <input className="input" disabled placeholder="https://sync.example.com" />
        </Field>
        <Field label="启用">
          <Toggle on={false} onChange={() => {}} disabled />
        </Field>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- about

function AboutSection() {
  const [version, setVersion] = useState("");
  const [dir, setDir] = useState("");
  useEffect(() => {
    getVersion().then(setVersion, () => {});
    appDataDir().then(setDir, () => {});
  }, []);
  return (
    <>
      <Title text="关于" />
      <div className="card set-card">
        <Field label="版本">
          <span className="mono selectable">MyShell+ {version}</span>
        </Field>
        <Field label="数据目录" hint="数据库与加密保险库保存在这里，备份时可整体复制">
          <span className="set-path">{dir || "-"}</span>
        </Field>
      </div>
    </>
  );
}
