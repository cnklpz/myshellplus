// Settings page: AI providers, security, appearance, shortcuts, backup/import, sync, about.
import { getVersion } from "@tauri-apps/api/app";
import { appDataDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, Copy, Lock, Plus, Power, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Select } from "../../components/Select";
import { Dialog, Empty, Field, Toggle, toast } from "../../components/ui";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { type AiProvider, type AiSettings, api, errMsg, type HotkeySettings, type HotkeyStatus, type KnownHost, type LogEntry } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { fmtMs } from "../../lib/format";
import { usePrivacy } from "../../lib/privacy";
import { fileStamp } from "../diagnostics/connLog";
import { useApp } from "../../store";
import { useContextMenu } from "../terminal/ContextMenu";
import "./settings.css";
import "../diagnostics/logs.css";
import { autoCheckEnabled, checkUpdate, installUpdate, setAutoCheck, useUpdate } from "../../lib/updater";
import { applyTheme, currentTheme, type Theme, THEMES } from "../../lib/themes";
import {
  compileRule,
  HL_COLORS,
  type HlRule,
  type HlSettings,
  hlColor,
  highlightSettings,
  HL_PRESETS,
  presetRules,
  saveHighlightSettings,
} from "../terminal/highlight";
import { type EchoMode, echoSettings, saveEchoSettings } from "../terminal/localEcho";

type Section = "ai" | "security" | "appearance" | "keys" | "backup" | "sync" | "logs" | "about";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "ai", label: "AI 服务" },
  { id: "security", label: "安全" },
  { id: "appearance", label: "外观" },
  { id: "keys", label: "快捷键" },
  { id: "backup", label: "备份" },
  { id: "sync", label: "云同步" },
  { id: "logs", label: "日志" },
  { id: "about", label: "关于" },
];

export function SettingsView() {
  const wanted = useApp((s) => s.settingsSection) as Section | null;
  const [section, setSection] = useState<Section>(wanted ?? "ai");
  useEffect(() => {
    if (wanted) {
      setSection(wanted);
      useApp.setState({ settingsSection: null });
    }
  }, [wanted]);
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
            {section === "keys" && <KeysSection />}
            {section === "backup" && <BackupSection />}
            {section === "sync" && <SyncSection />}
            {section === "logs" && <LogsSection />}
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
        <div className="section-title">
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

const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

/** Quick picks for a provider's model fields (any other model name can be typed). */
function modelsFor(p: AiProvider): string[] {
  if (p.kind === "anthropic") return CLAUDE_MODELS;
  const url = p.baseUrl.toLowerCase();
  if (url.includes("deepseek")) return ["deepseek-chat", "deepseek-reasoner"];
  if (url.includes("dashscope")) return ["qwen-flash", "qwen-turbo", "qwen-plus", "qwen-max"];
  return [];
}

function AiSection() {
  const [s, setS] = useState<AiSettings | null>(null);
  /** providerId -> new key; "" = clear on save. Only edited providers are present. */
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
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
  const add = (preset: number) => {
    const id = "p" + Date.now().toString(36);
    // New service goes first so it is visible without scrolling.
    const providers = [{ id, ...PRESETS[preset].p }, ...s.providers];
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
      const t0 = performance.now();
      const took = () => fmtMs(performance.now() - t0);
      try {
        const r = await api.aiNl2Cmd("", "列出当前目录");
        toast(`${p.name} 可用（${took()}）：${r.command || r.explanation}`, "success");
      } catch (e) {
        toast(`${p.name} 测试失败（${took()}）：${errMsg(e)}`, "error");
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

  const predictProvider = s.providers.find((p) => p.id === (s.predictProvider || s.active));
  const predictModels = predictProvider ? modelsFor(predictProvider) : [];
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
            <Select
              size="sm"
              width={128}
              value={-1}
              placeholder="添加服务"
              options={PRESETS.map((p, i) => ({ value: i, label: p.label }))}
              onChange={add}
            />
          </>
        }
      >
        <div className="set-stack">
          {s.providers.length === 0 && (
            <div className="set-group">
              <Empty sm text="未添加服务" />
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
                  {modelsFor(p).length > 0 && (
                    <Select
                      width={128}
                      value=""
                      placeholder="常用模型"
                      options={modelsFor(p).map((m) => ({ value: m, label: m.replace("claude-", "") }))}
                      onChange={(model) => updateProvider(p.id, { model })}
                    />
                  )}
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
          <Field label="预测模型">
            <input
              className="input mono"
              value={s.predictModel ?? ""}
              placeholder={predictProvider?.model || "同服务模型"}
              spellCheck={false}
              onChange={(e) => update({ predictModel: e.target.value || null })}
            />
            {predictModels.length > 0 && (
              <Select
                width={128}
                value=""
                placeholder="常用模型"
                options={predictModels.map((m) => ({ value: m, label: m.replace("claude-", "") }))}
                onChange={(predictModel) => update({ predictModel })}
              />
            )}
          </Field>
          <Field label="深度思考">
            <Toggle on={!!s.thinking} onChange={(v) => update({ thinking: v })} />
            <span className="set-note">更准但更慢，补全始终不思考</span>
          </Field>
          <Field label="本地预测">
            <Toggle on={s.predictEnabled} onChange={(v) => update({ predictEnabled: v })} />
          </Field>
          <Field label="AI 预测">
            <Toggle on={s.aiPredictEnabled} onChange={(v) => update({ aiPredictEnabled: v })} />
            <span className="set-note">会发送当前输入和屏幕内容</span>
          </Field>
          <Field label="中文转命令">
            <Toggle on={s.nlPredictEnabled !== false} onChange={(v) => update({ nlPredictEnabled: v })} />
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
              <button className="btn" onClick={lock}>
                <Lock />
                立即锁定
              </button>
            </Field>
          </>
        )}
      </div>
      <KnownHostsBlock />
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
      {pwDialog && <PasswordModeDialog mode={pwDialog} onClose={() => setPwDialog(null)} />}
    </>
  );
}

/** Trusted server host keys. Removing one makes the next connection ask again. */
function KnownHostsBlock() {
  const [list, setList] = useState<KnownHost[] | null>(null);
  const menu = useContextMenu();
  useEffect(() => {
    api.knownHostList().then(setList, (e) => toast(errMsg(e), "error"));
  }, []);
  const remove = async (k: KnownHost) => {
    try {
      await api.knownHostDelete(k.host, k.port);
      setList((l) => l?.filter((x) => x.host !== k.host || x.port !== k.port) ?? null);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <Block title="服务器指纹">
      <div className="set-group">
        {list?.length === 0 && <Empty sm text="暂无记录" />}
        {list?.map((k) => (
          <div
            key={`${k.host}:${k.port}`}
            className="kh-row"
            onContextMenu={(e) => {
              if (window.getSelection()?.toString().trim()) return;
              menu.open(e, [
                { label: "复制指纹", icon: <Copy />, onSelect: () => void copyText(k.fingerprint, "指纹") },
                { label: "复制地址", icon: <Copy />, onSelect: () => void copyText(k.port !== 22 ? `${k.host}:${k.port}` : k.host, "地址") },
                "sep",
                { label: "删除", icon: <Trash2 />, danger: true, onSelect: () => void remove(k) },
              ]);
            }}
          >
            <span className="mono ellipsis selectable" title={`${k.host}:${k.port}`}>
              {k.host}
              {k.port !== 22 && <span className="faint">:{k.port}</span>}
            </span>
            <span className="kh-algo">{k.algo}</span>
            <code className="kh-fp ellipsis selectable" title={k.fingerprint}>
              {k.fingerprint}
            </code>
            <button className="icon-btn" title="删除" onClick={() => remove(k)}>
              <Trash2 />
            </button>
          </div>
        ))}
      </div>
      {menu.node}
    </Block>
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
            <Field
              label="自动解锁"
              hint={
                <span className={tooShort || mismatch ? "set-err" : undefined}>
                  {tooShort ? "至少 8 位" : mismatch ? "两次输入不一致" : "开启后每次启动需要输入；主密码无法找回"}
                </span>
              }
            >
              <Toggle on={remember} onChange={setRemember} />
            </Field>
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
      <Block
        title="主题"
        actions={
          <Select
            size="sm"
            width={176}
            value={THEMES.some((t) => t.id === themeId && t.group === "classic") ? themeId : ""}
            placeholder="经典配色"
            options={THEMES.filter((t) => t.group === "classic").map((t) => ({
              value: t.id,
              text: t.name,
              label: (
                <span className="theme-opt">
                  <span className="ellipsis">{t.name}</span>
                  <span className="theme-dots">
                    {[t.ui.bg0, t.ui.accent, t.ansi[1], t.ansi[2], t.ansi[3]].map((c, i) => (
                      <i key={i} style={{ background: c }} />
                    ))}
                  </span>
                </span>
              ),
            }))}
            onChange={pick}
          />
        }
      >
        <ThemeGrid themes={THEMES.filter((t) => !t.group)} value={themeId} onPick={pick} />
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
      <HighlightBlock themeId={themeId} />
    </>
  );
}

function ThemeGrid(props: { themes: Theme[]; value: string; onPick: (id: string) => void }) {
  return (
    <div className="theme-grid">
      {props.themes.map((t) => (
        <button key={t.id} className={"theme-tile" + (t.id === props.value ? " on" : "")} onClick={() => props.onPick(t.id)}>
          <div className="theme-preview" style={{ background: t.ui.chrome }}>
            <div className="tp-side" />
            <div className="tp-main" style={{ background: t.ui.bg0 }}>
              <span style={{ background: t.ansi[2] }} />
              <span style={{ background: t.ui.fg2 }} />
              <span style={{ background: t.ansi[4] }} />
              <span style={{ background: t.ui.accent }} />
            </div>
          </div>
          <div className="theme-name">
            <span className="ellipsis">{t.name}</span>
            <span className="theme-dots">
              {[t.ui.accent, t.ansi[1], t.ansi[2], t.ansi[3]].map((c, i) => (
                <i key={i} style={{ background: c }} />
              ))}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

function HighlightBlock(props: { themeId: string }) {
  const [hl, setHlState] = useState<HlSettings>(highlightSettings);
  const setHl = (v: HlSettings) => {
    setHlState(v);
    saveHighlightSettings(v);
  };
  /** Any edit to the rules turns them into the custom set (a template stays as shipped). */
  const setRules = (rules: HlRule[]) => setHl({ ...hl, preset: "custom", rules, custom: rules });
  const setRule = (id: string, patch: Partial<HlRule>) => setRules(hl.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = () =>
    setRules([...hl.rules, { id: "r" + Date.now().toString(36), pattern: "", regex: false, color: "magenta", on: true }]);
  const pickPreset = (id: string) =>
    setHl({ ...hl, enabled: true, preset: id, rules: id === "custom" ? (hl.custom ?? []) : presetRules(id) });
  const theme = THEMES.find((t) => t.id === props.themeId) ?? currentTheme();
  const menu = useContextMenu();
  const move = (i: number, d: -1 | 1) => {
    const next = [...hl.rules];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setRules(next);
  };

  return (
    <Block
      title="高亮"
      actions={
        <>
          <Select
            size="sm"
            width={112}
            value={hl.preset}
            placeholder="模板"
            options={[
              ...HL_PRESETS.map((p) => ({ value: p.id, label: p.label })),
              ...(hl.custom ? [{ value: "custom", label: "自定义" }] : []),
            ]}
            onChange={pickPreset}
          />
          <button className="btn sm" onClick={add}>
            <Plus />
            添加
          </button>
        </>
      }
    >
      <div className="set-group">
        <Field label="关键词高亮">
          <Toggle on={hl.enabled} onChange={(enabled) => setHl({ ...hl, enabled })} />
        </Field>
        {hl.enabled && hl.rules.length === 0 && <Empty sm text="未添加规则" />}
        {hl.enabled &&
          hl.rules.map((r, i) => {
            const bad = r.pattern !== "" && !compileRule(r);
            return (
              <div
                key={r.id}
                className="hl-rule"
                onContextMenu={(e) =>
                  menu.open(e, [
                    { label: r.on ? "停用" : "启用", icon: <Power />, onSelect: () => setRule(r.id, { on: !r.on }) },
                    "sep",
                    { label: "上移", icon: <ArrowUp />, disabled: i === 0, onSelect: () => move(i, -1) },
                    { label: "下移", icon: <ArrowDown />, disabled: i === hl.rules.length - 1, onSelect: () => move(i, 1) },
                    "sep",
                    { label: "删除", icon: <Trash2 />, danger: true, onSelect: () => setRules(hl.rules.filter((x) => x.id !== r.id)) },
                  ])
                }
              >
                <Toggle on={r.on} onChange={(on) => setRule(r.id, { on })} />
                <input
                  className={"input sm mono" + (bad ? " set-err" : "")}
                  style={bad ? undefined : { color: hlColor(r.color, theme) }}
                  value={r.pattern}
                  placeholder={r.regex ? "\\bERROR\\b" : "timeout"}
                  spellCheck={false}
                  title={bad ? "正则无效" : undefined}
                  onChange={(e) => setRule(r.id, { pattern: e.target.value })}
                />
                <Seg
                  value={r.regex ? "re" : "text"}
                  options={[
                    { value: "text", label: "文本" },
                    { value: "re", label: "正则" },
                  ]}
                  onChange={(v) => setRule(r.id, { regex: v === "re" })}
                />
                <Select
                  size="sm"
                  width={96}
                  value={r.color}
                  options={HL_COLORS.map((c) => ({
                    value: c.value,
                    text: c.label,
                    label: (
                      <span className="hl-color">
                        <i style={{ background: theme.ansi[c.ansi] }} />
                        {c.label}
                      </span>
                    ),
                  }))}
                  onChange={(color) => setRule(r.id, { color })}
                />
                <button className="icon-btn" title="删除" onClick={() => setRules(hl.rules.filter((x) => x.id !== r.id))}>
                  <Trash2 />
                </button>
              </div>
            );
          })}
      </div>
      {menu.node}
    </Block>
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

export function ExportDialog(props: { onClose: () => void }) {
  const [secrets, setSecrets] = useState(false);
  const [encrypt, setEncrypt] = useState(true);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const usePw = secrets && encrypt;
  const ok = !busy && (!usePw || (pw !== "" && pw === pw2));

  const run = async () => {
    if (!ok) return;
    try {
      const path = await save({ defaultPath: "myshellplus-backup.json", filters: [{ name: "MyShell+ 备份", extensions: ["json"] }] });
      if (!path) return;
      setBusy(true);
      const n = await api.exportBackup(path, secrets, usePw ? pw : undefined);
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
          <Field label="加密备份" hint={encrypt ? undefined : "密码密钥将以明文保存"}>
            <Toggle on={encrypt} onChange={setEncrypt} />
          </Field>
        )}
        {usePw && (
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
        <Empty sm text="即将推出" />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- shortcuts

// Mirrors the handlers in main.tsx, GlobalSearch, XTermView, predictor, AiBar, CommandBar,
// HostEditor and FileDialogs — keep in sync when a binding changes.
const KEY_GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "全局",
    keys: [
      ["搜索", "Ctrl+P"],
      ["搜索（备用）", "Ctrl+Shift+F"],
      ["重新加载界面", "Ctrl+Shift+R"],
      ["重新加载界面（备用）", "F5"],
    ],
  },
  {
    title: "终端",
    keys: [
      ["复制", "Ctrl+Shift+C"],
      ["粘贴", "Ctrl+Shift+V"],
      ["复制或粘贴", "Shift+右键"],
      ["粘贴选中内容", "中键"],
      ["清屏", "Ctrl+Shift+L"],
      ["清除缓冲区并重置", "Ctrl+Shift+K"],
      ["终端内搜索", "Ctrl+F"],
      ["AI 生成命令", "Ctrl+K"],
      ["AI 解释选中内容", "Ctrl+Shift+E"],
      ["命令历史", "Ctrl+Shift+H"],
      ["下一个终端", "Ctrl+Tab"],
      ["上一个终端", "Ctrl+Shift+Tab"],
      ["关闭终端", "Ctrl+W"],
    ],
  },
  {
    title: "命令补全",
    keys: [
      ["AI 补全", "Ctrl+Space"],
      ["选择候选", "↑/↓"],
      ["采用候选", "Tab"],
      ["采用第一个候选", "→"],
      ["中文描述转命令", "Enter"],
      ["关闭候选", "Esc"],
    ],
  },
  {
    title: "编辑与对话框",
    keys: [
      ["执行命令", "Ctrl+Enter"],
      ["上一条/下一条历史", "Ctrl+↑/↓"],
      ["保存服务器/文件", "Ctrl+S"],
      ["关闭", "Esc"],
    ],
  },
];

function Keys(props: { combo: string }) {
  return (
    <span className="set-keys">
      {props.combo.split("+").map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

const CODE_LABELS: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc",
};

/** "Ctrl+Alt+KeyM" -> "Ctrl+Alt+M" */
function hotkeyLabel(spec: string): string {
  return spec
    .split("+")
    .map((k) => CODE_LABELS[k] ?? k.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ").replace("Super", "Win"))
    .join("+");
}

const MOD_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/** Global hotkey in the global-shortcut syntax, or null while only modifiers are held. */
function hotkeyFromEvent(e: KeyboardEvent): string | null {
  if (MOD_CODES.test(e.code) || !e.code) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  return [...mods, e.code].join("+");
}

/** Click, then press a combination. Esc cancels, Backspace clears. */
function HotkeyInput(props: { value: string; onChange: (v: string) => void }) {
  const [rec, setRec] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!rec) return;
    // Saving re-registers the hotkeys itself; otherwise resume them when recording ends.
    let saved = false;
    const done = (v: string) => {
      saved = true;
      setRec(false);
      props.onChange(v);
    };
    void api.hotkeySuspend(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
      if (plain && e.code === "Escape") return setRec(false);
      if (plain && (e.code === "Backspace" || e.code === "Delete")) return done("");
      const spec = hotkeyFromEvent(e);
      if (!spec) return;
      if (!/^F\d+$/.test(e.code) && !e.ctrlKey && !e.altKey && !e.metaKey) return setErr("需要 Ctrl、Alt 或 Win");
      done(spec);
    };
    const stop = () => setRec(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", stop);
      setErr("");
      if (!saved) void api.hotkeySuspend(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec]);
  return (
    <>
      <button type="button" className={"btn sm hotkey-input" + (rec ? " rec" : "")} onClick={() => setRec(!rec)}>
        {rec ? <span className="faint">{err || "按下组合键"}</span> : props.value ? <Keys combo={hotkeyLabel(props.value)} /> : <span className="faint">未设置</span>}
      </button>
      {props.value && !rec && (
        <button type="button" className="btn sm ghost" onClick={() => props.onChange("")}>
          清除
        </button>
      )}
    </>
  );
}

function GlobalHotkeys() {
  const [s, setS] = useState<HotkeySettings | null>(null);
  const [status, setStatus] = useState<HotkeyStatus>({});
  useEffect(() => {
    api.hotkeyGet().then((r) => {
      setS(r.settings);
      setStatus(r.status);
    }, (e) => toast(errMsg(e), "error"));
  }, []);
  if (!s) return null;
  const save = async (patch: Partial<HotkeySettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    try {
      setStatus(await api.hotkeySave(next));
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const errHint = (e?: string | null) => (e ? <span className="set-err">{e}</span> : undefined);
  return (
    <div className="set-block">
      <div className="section-title">系统</div>
      <div className="set-group set-keys-group">
        <Field label="显隐主界面" hint={errHint(status.toggleError)}>
          <HotkeyInput value={s.toggle} onChange={(toggle) => save({ toggle })} />
        </Field>
        <Field label="切换终端" hint={errHint(status.switcherError)}>
          <HotkeyInput value={s.switcher} onChange={(switcher) => save({ switcher })} />
        </Field>
        <Field label="仅列已开终端">
          <Toggle on={s.openOnly} onChange={(openOnly) => save({ openOnly })} disabled={!s.switcher} />
        </Field>
      </div>
    </div>
  );
}

function KeysSection() {
  return (
    <>
      <Title text="快捷键" />
      <GlobalHotkeys />
      {KEY_GROUPS.map((g) => (
        <div key={g.title} className="set-block">
          <div className="section-title">{g.title}</div>
          <div className="set-group set-keys-group">
            {g.keys.map(([label, combo]) => (
              <Field key={label} label={label}>
                <Keys combo={combo} />
              </Field>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- logs

type LogFilter = "all" | "crash" | "perf" | "conn";

function logKind(e: LogEntry): { kind: Exclude<LogFilter, "all"> | "other"; label: string } {
  if (e.target === "crash") return { kind: "crash", label: "崩溃" };
  if (e.target === "ui") return { kind: "crash", label: "界面" };
  if (e.target === "perf") return { kind: "perf", label: "掉帧" };
  if (e.target.startsWith("conn:")) return { kind: "conn", label: "连接" };
  return { kind: "other", label: "后台" };
}

function LogsSection() {
  const hosts = useApp((s) => s.hosts);
  const priv = usePrivacy();
  const [events, setEvents] = useState<LogEntry[] | null>(null);
  const [filter, setFilter] = useState<LogFilter>("all");
  const [open, setOpen] = useState<number | null>(null);
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.logEvents(300).then((v) => setEvents(v ?? []), () => setEvents([]));
  useEffect(() => {
    load();
    api.logDir().then((d) => setDir(d ?? ""), () => {});
  }, []);

  const exportAll = async () => {
    try {
      const path = await save({ defaultPath: `myshellplus-log-${fileStamp()}.log`, filters: [{ name: "日志", extensions: ["log", "txt"] }] });
      if (!path) return;
      setBusy(true);
      await api.logExport(path);
      toast("日志已导出", "success");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const hostName = (target: string) => {
    const h = hosts.find((x) => "conn:" + x.id === target);
    return h ? priv.text(h.name, h.host) : "";
  };
  const shown = (events ?? []).filter((e) => filter === "all" || logKind(e).kind === filter);

  return (
    <>
      <Title text="日志" />
      <div className="set-group">
        <Field label="导出日志" hint="地址、用户名已脱敏">
          <button className="btn" disabled={busy} onClick={exportAll}>
            导出
          </button>
        </Field>
        <Field label="日志目录">
          <span className="set-path set-note">{dir || "-"}</span>
          <button className="btn" disabled={!dir} onClick={() => revealItemInDir(dir + "\\myshellplus.log").catch((e) => toast(errMsg(e), "error"))}>
            打开
          </button>
        </Field>
      </div>
      <Block
        title="异常事件"
        actions={
          <>
            <Seg
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "全部" },
                { value: "crash", label: "崩溃" },
                { value: "perf", label: "掉帧" },
                { value: "conn", label: "连接" },
              ]}
            />
            <button className="btn sm" onClick={load}>
              刷新
            </button>
          </>
        }
      >
        <div className="set-group">
          {events === null ? null : shown.length === 0 ? (
            <Empty sm text="暂无异常事件" />
          ) : (
            <div className="log-list">
              {shown.map((e, i) => {
                const k = logKind(e);
                const name = k.kind === "conn" ? hostName(e.target) : "";
                return (
                  <div key={i} className={"log-row" + (open === i ? " open" : "")} onClick={() => setOpen(open === i ? null : i)}>
                    <span className="log-ts">{e.ts.slice(5, 19)}</span>
                    <span className="log-kind">
                      <span className={"dot " + (e.level === "ERROR" ? "err" : "warn")} />
                      {k.label}
                    </span>
                    <span className="log-msg">{name ? `${name} · ${e.msg}` : e.msg}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Block>
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
      <UpdateBlock />
    </>
  );
}

function UpdateBlock() {
  const u = useUpdate();
  const [auto, setAuto] = useState(autoCheckEnabled);
  const busy = u.phase === "checking" || u.phase === "downloading";
  const status =
    u.phase === "checking" ? "检查中…"
    : u.phase === "latest" ? "已是最新版本"
    : u.phase === "available" ? `新版本 ${u.version}`
    : u.phase === "downloading" ? `下载中 ${u.pct ?? 0}%`
    : u.phase === "error" ? u.message
    : "";
  return (
    <div className="set-block">
      <div className="section-title">更新</div>
      <div className="set-group">
        <Field label="检查更新" hint={u.phase === "available" ? "安装后将重启，SSH 连接会断开" : undefined}>
          <span className={"set-note set-upd" + (u.phase === "error" ? " set-err" : "")}>{status}</span>
          {u.phase === "available" || u.phase === "downloading" ? (
            <button className="btn primary" disabled={busy} onClick={() => installUpdate()}>
              安装并重启
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => checkUpdate()}>
              检查更新
            </button>
          )}
        </Field>
        {u.phase === "available" && u.notes.trim() && (
          <Field label="更新内容" top>
            <div className="set-notes selectable">{u.notes.trim()}</div>
          </Field>
        )}
        <Field label="启动时检查">
          <Toggle
            on={auto}
            onChange={(v) => {
              setAuto(v);
              setAutoCheck(v);
            }}
          />
        </Field>
      </div>
    </div>
  );
}
