// Settings page: AI providers, security, appearance, backup/import, sync, about.
import { getVersion } from "@tauri-apps/api/app";
import { appDataDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { Lock, Plus, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Select } from "../../components/Select";
import { Dialog, Field, Toggle, toast } from "../../components/ui";
import { type AiProvider, type AiSettings, api, errMsg } from "../../lib/api";
import { useApp } from "../../store";
import "./settings.css";
import { applyTheme, currentTheme, THEMES } from "../../lib/themes";
import { type EchoMode, echoSettings, saveEchoSettings } from "../terminal/localEcho";

type Section = "ai" | "security" | "appearance" | "backup" | "sync" | "about";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "ai", label: "AI 服务" },
  { id: "security", label: "安全" },
  { id: "appearance", label: "外观" },
  { id: "backup", label: "备份" },
  { id: "sync", label: "云同步" },
  { id: "about", label: "关于" },
];

export function SettingsView() {
  const [section, setSection] = useState<Section>("ai");
  return (
    <div className="page">
      <div className="set-layout">
        <nav className="set-nav">
          <div className="set-nav-head">
            <h1>设置</h1>
          </div>
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={section === s.id ? "on" : ""} onClick={() => setSection(s.id)}>
              <span className="ellipsis">{s.label}</span>
            </button>
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

/** Optional small heading + content (usually one .set-group card). */
function Block(props: { title?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="set-block">
      {(props.title || props.actions) && (
        <div className="set-block-head">
          <span className="grow">{props.title}</span>
          {props.actions}
        </div>
      )}
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

  const providerOptions = s.providers.map((p) => ({ value: p.id, label: p.name || p.id }));

  return (
    <>
      <Title text="AI 服务">
        {dirty && <span className="set-note">未保存</span>}
        <button className="btn primary" disabled={!dirty || busy !== null} onClick={saveAll}>
          保存
        </button>
      </Title>

      <Block
        title="服务"
        actions={
          <>
            <Select size="sm" width={128} value={preset} options={PRESETS.map((p, i) => ({ value: i, label: p.label }))} onChange={setPreset} />
            <button className="btn sm" onClick={add}>
              <Plus />
              添加
            </button>
          </>
        }
      >
        <div className="set-stack">
          {s.providers.length === 0 && (
            <div className="set-group">
              <div className="set-empty">未添加服务</div>
            </div>
          )}
          {s.providers.map((p) => {
            const k = keys[p.id];
            const placeholder = k === "" ? "保存后清除" : p.apiKeySecret ? "已保存" : "未设置";
            return (
              <div key={p.id} className="set-group">
                <Field label="名称">
                  <input className="input" value={p.name} onChange={(e) => updateProvider(p.id, { name: e.target.value })} />
                  <button className="btn" disabled={busy !== null} onClick={() => test(p)} title="保存并测试">
                    <Zap />
                    {busy === p.id ? "测试中…" : "测试"}
                  </button>
                  <button className="icon-btn md" onClick={() => remove(p.id)} title="删除">
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
                  <input
                    className="input mono"
                    value={p.baseUrl}
                    placeholder="https://api.example.com"
                    onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })}
                  />
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
      </Block>

      <Block title="用途">
        <div className="set-group">
          <Field label="默认服务">
            <Select
              width="100%"
              value={s.active ?? ""}
              options={[{ value: "", label: "未选择" }, ...providerOptions]}
              onChange={(v) => update({ active: v || null })}
            />
          </Field>
          <Field label="预测服务">
            <Select
              width="100%"
              value={s.predictProvider ?? ""}
              options={[{ value: "", label: "同默认服务" }, ...providerOptions]}
              onChange={(v) => update({ predictProvider: v || null })}
            />
          </Field>
          <Field label="本地预测">
            <Toggle on={s.predictEnabled} onChange={(v) => update({ predictEnabled: v })} />
          </Field>
          <Field label="AI 预测">
            <Toggle on={s.aiPredictEnabled} onChange={(v) => update({ aiPredictEnabled: v })} />
            <span className="set-note">会发送当前输入和屏幕内容</span>
          </Field>
        </div>
      </Block>
    </>
  );
}

// ---------------------------------------------------------------- security

function SecuritySection() {
  const vault = useApp((s) => s.vault);
  const [changing, setChanging] = useState(false);
  const [pwDialog, setPwDialog] = useState<"enable" | "disable" | null>(null);

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

  const pwOn = !!vault?.passwordEnabled;

  return (
    <>
      <Title text="安全" />
      <div className="set-group">
        <Field label="凭据加密">
          <span className="dot ok" />
          <span>已加密</span>
          <span className="faint">{pwOn ? "主密码" : "Windows 账户"}</span>
        </Field>
        <Field label="主密码保护">
          <Toggle on={pwOn} onChange={(on) => setPwDialog(on ? "enable" : "disable")} />
        </Field>
        {pwOn && (
          <>
            <Field label="自动解锁">
              <Toggle on={!!vault?.remembered} onChange={remember} />
            </Field>
            <Field label="主密码">
              <button className="btn" onClick={() => setChanging(true)}>
                修改
              </button>
              <span className="spacer" />
              <button className="btn" onClick={lock}>
                <Lock />
                立即锁定
              </button>
            </Field>
          </>
        )}
      </div>
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
      {pwDialog && <PasswordModeDialog mode={pwDialog} onClose={() => setPwDialog(null)} />}
    </>
  );
}

/** Turn master password protection on (set a password) or off (verify the current one). */
function PasswordModeDialog(props: { mode: "enable" | "disable"; onClose: () => void }) {
  const enable = props.mode === "enable";
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const tooShort = enable && pw !== "" && pw.length < 8;
  const mismatch = enable && confirm !== "" && pw !== confirm;
  const ok = !busy && pw !== "" && (!enable || (pw.length >= 8 && pw === confirm));

  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      if (enable) await api.vaultSetup(pw, remember);
      else await api.vaultDisablePassword(pw);
      await useApp.getState().refreshVault();
      toast(enable ? "已开启主密码保护" : "已关闭主密码保护", "success");
      props.onClose();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={enable ? "开启主密码保护" : "关闭主密码保护"}
      width={440}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className={"btn " + (enable ? "primary" : "danger solid")} disabled={!ok} onClick={submit}>
            {enable ? "开启" : "关闭"}
          </button>
        </>
      }
    >
      <div className="stack gap-3">
        <Field label={enable ? "主密码" : "当前主密码"}>
          <input
            className="input"
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </Field>
        {enable && (
          <>
            <Field label="确认">
              <input
                className="input"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </Field>
            <Field label="自动解锁">
              <Toggle on={remember} onChange={setRemember} />
            </Field>
            <div className={"field-hint " + (tooShort || mismatch ? "set-err" : "")} style={{ gridColumn: "auto" }}>
              {tooShort ? "至少 8 位" : mismatch ? "两次输入不一致" : "开启后每次启动需要输入；主密码无法找回"}
            </div>
          </>
        )}
      </div>
    </Dialog>
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
        <Field label="新密码" hint="主密码遗失后无法找回">
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
  const [themeId, setThemeId] = useState(currentTheme().id);
  const [fontSize, setFontSize] = useState(lsGet("termFontSize") ?? "14");

  const [echo, setEchoState] = useState(echoSettings());
  const setEcho = (v: { mode: EchoMode; threshold: number }) => {
    setEchoState(v);
    saveEchoSettings(v.mode, v.threshold);
  };
  const pick = (id: string) => {
    setThemeId(id);
    applyTheme(id);
  };
  const applyFont = (v: string) => {
    setFontSize(v);
    lsSet("termFontSize", v);
    window.dispatchEvent(new Event("term-font-change"));
  };

  return (
    <>
      <Title text="外观" />
      <Block title="主题">
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button key={t.id} className={"theme-tile" + (t.id === themeId ? " on" : "")} onClick={() => pick(t.id)}>
              <div className="theme-preview" style={{ background: t.ui.chrome }}>
                <div className="tp-side" />
                <div className="tp-main" style={{ background: t.ui.bg0 }}>
                  <span style={{ background: t.ansi[2], width: "38%" }} />
                  <span style={{ background: t.ui.fg2, width: "62%" }} />
                  <span style={{ background: t.ansi[4], width: "48%" }} />
                  <span style={{ background: t.ui.accent, width: "22%" }} />
                </div>
              </div>
              <div className="theme-name">
                <span>{t.name}</span>
                <span className="theme-dots">
                  {[t.ui.accent, t.ansi[1], t.ansi[2], t.ansi[3]].map((c, i) => (
                    <i key={i} style={{ background: c }} />
                  ))}
                </span>
              </div>
            </button>
          ))}
        </div>
      </Block>
      <Block title="终端">
        <div className="set-group">
          <Field label="字号">
            <Select
              width={120}
              value={fontSize}
              options={["12", "13", "14", "15", "16", "18"].map((n) => ({ value: n, label: `${n} px` }))}
              onChange={applyFont}
            />
          </Field>
          <Field label="本地回显">
            <Seg
              value={echo.mode}
              options={[
                { value: "off", label: "关闭" },
                { value: "auto", label: "自动" },
                { value: "on", label: "始终" },
              ]}
              onChange={(m) => setEcho({ ...echo, mode: m as EchoMode })}
            />
          </Field>
          {echo.mode === "auto" && (
            <Field label="延迟阈值">
              <Select
                width={120}
                value={echo.threshold}
                options={[50, 80, 120, 200].map((n) => ({ value: n, label: `${n} ms` }))}
                onChange={(v) => setEcho({ ...echo, threshold: v })}
              />
            </Field>
          )}
        </div>
      </Block>
    </>
  );
}

// ---------------------------------------------------------------- backup

function BackupSection() {
  const [exporting, setExporting] = useState(false);
  return (
    <>
      <Title text="备份" />
      <div className="set-group">
        <Field label="导入服务器">
          <button className="btn" onClick={() => useApp.getState().setImportOpen(true)}>
            导入
          </button>
        </Field>
        <Field label="导出备份">
          <button className="btn" onClick={() => setExporting(true)}>
            导出
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
            导出
          </button>
        </>
      }
    >
      <div className="stack gap-3">
        <Field label="含密码密钥">
          <Toggle on={secrets} onChange={setSecrets} />
        </Field>
        {secrets && (
          <>
            <Field label="备份密码" hint="遗失后无法解密备份">
              <input className="input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
            </Field>
            <Field label="确认密码" hint={pw2 !== "" && pw !== pw2 ? "两次输入不一致" : undefined}>
              <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </Field>
          </>
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
      <div className="set-group">
        <div className="set-empty">即将推出</div>
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
      <div className="set-group">
        <Field label="版本">
          <span className="mono selectable">MyShell+ {version}</span>
        </Field>
        <Field label="数据目录">
          <span className="set-path">{dir || "-"}</span>
        </Field>
      </div>
    </>
  );
}
