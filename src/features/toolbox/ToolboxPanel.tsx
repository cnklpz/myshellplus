// Toolbox side panel: common Linux admin tasks, adapted to the detected system.
import { Dices, Eye, EyeOff, LoaderCircle, RefreshCw, ScanSearch, SquareMousePointer } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CommandPreview, ExecOutput, RunButton } from "../../components/CommandPreview";
import { Select } from "../../components/Select";
import { Dialog, Empty, Toggle } from "../../components/ui";
import { errMsg, type ExecResult } from "../../lib/api";
import {
  detectEnv, genPassword, parseKv, type RemoteEnv, runAsLabel, runInTerminal, runScript, setSudoPassword, useNeedsSudoPassword,
} from "../../lib/remote";
import { useApp } from "../../store";
import { usePanelItems } from "../side/panelMenu";
import { useContextMenu } from "../terminal/ContextMenu";
import { AddUserForm } from "./AddUser";
import { CheckList, usePreCheck } from "./precheck";
import { type Ctx, defaults, DESCS, type FieldDef, GROUPS, noteOf, privOf, riskOf, type Tool, TOOLS, type Values } from "./tools";
import { OtherServices, useServiceList, WebServices } from "./services";
import { VIEWS } from "./views";
import "./toolbox.css";

export function ToolboxPanel({ hostId }: { hostId: string }) {
  const [env, setEnv] = useState<RemoteEnv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const needPw = useNeedsSudoPassword(hostId, env);
  const seq = useRef(0);

  const load = (force = false) => {
    const my = ++seq.current;
    setError(null);
    if (force) setEnv(null);
    detectEnv(hostId, force).then(
      (e) => my === seq.current && setEnv(e),
      (e) => my === seq.current && setError(errMsg(e)),
    );
  };
  useEffect(() => {
    load();
    return () => void seq.current++;
  }, [hostId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error)
    return (
      <Empty text={error} action={<button className="btn sm" onClick={() => load(true)}>重试</button>} />
    );
  if (!env)
    return (
      <Empty icon={<LoaderCircle className="spin" />} text="正在识别系统" />
    );
  if (!env.linux) return <Empty text={`工具仅支持 Linux（当前：${env.name}）`} />;

  const tools = TOOLS.filter((t) => !t.when || t.when(env));
  const cur = tools.find((t) => t.id === open);
  return (
    <div className="tb-root">
      <div className="tb-env">
        <div className="tb-env-line">
          <span className="ellipsis grow tb-env-name" title={env.name}>{env.name}</span>
          <button className="icon-btn sm" title="重新识别" onClick={() => load(true)}>
            <RefreshCw />
          </button>
        </div>
        <div className="tb-env-meta faint">
          {[env.arch, env.pkg, env.root ? "root" : `${env.user} · ${env.sudo === "nopass" ? "免密 sudo" : env.sudo === "pass" ? "sudo" : "无 sudo"}`]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {needPw && <SudoPrompt hostId={hostId} />}
      </div>

      <ToolboxBody hostId={hostId} env={env} tools={tools} onOpen={setOpen} onRedetect={() => load(true)} />
      {cur && (
        <Dialog title={cur.label} width={560} onClose={() => setOpen(null)}>
          {cur.custom === "adduser" ? <AddUserForm hostId={hostId} env={env} /> : <ToolForm tool={cur} hostId={hostId} env={env} />}
        </Dialog>
      )}
    </div>
  );
}

/** Web stack on top, tool cards by group, detected services at the bottom. */
function ToolboxBody(props: { hostId: string; env: RemoteEnv; tools: Tool[]; onOpen: (id: string) => void; onRedetect: () => void }) {
  const { hostId, env, tools } = props;
  const list = useServiceList(hostId, env);
  const menu = useContextMenu();
  const panelExtra = usePanelItems();
  return (
    <div
      className="tb-body"
      onContextMenu={(e) =>
        menu.open(e, [
          { label: "刷新服务", icon: <RefreshCw />, onSelect: list.reload },
          { label: "重新识别", icon: <ScanSearch />, onSelect: props.onRedetect },
          ...panelExtra(),
        ])
      }
    >
      <WebServices hostId={hostId} env={env} list={list} />
      {GROUPS.map((g) => {
        const items = tools.filter((t) => t.group === g);
        if (!items.length) return null;
        return (
          <div key={g} className="tb-group">
            <div className="section-title tb-group-title">{g}</div>
            <div className="tb-grid">
              {items.map((t) => (
                <button
                  key={t.id}
                  className="tb-card"
                  title={DESCS[t.id]}
                  onClick={() => props.onOpen(t.id)}
                  onContextMenu={(e) =>
                    menu.open(e, [{ label: "打开…", icon: <SquareMousePointer />, onSelect: () => props.onOpen(t.id) }, ...panelExtra()])
                  }
                >
                  <span className="tb-card-label ellipsis">{t.label}</span>
                  {t.meta?.(env) && <span className="tb-card-meta ellipsis">{t.meta(env)}</span>}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <OtherServices hostId={hostId} env={env} list={list} />
      {menu.node}
    </div>
  );
}

/** Sudo password for this session (memory only). */
function SudoPrompt(props: { hostId: string }) {
  const [pw, setPw] = useState("");
  return (
    <form
      className="tb-sudo"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pw) return;
        setSudoPassword(props.hostId, pw);
      }}
    >
      <input className="input sm grow" type="password" placeholder="sudo 密码" value={pw} onChange={(e) => setPw(e.target.value)} />
      <button className="btn sm" type="submit" disabled={!pw}>确定</button>
    </form>
  );
}

export function ToolForm(props: { tool: Tool; hostId: string; env: RemoteEnv }) {
  const { tool, hostId, env } = props;
  const host = useApp((s) => s.hosts.find((h) => h.id === hostId));
  const [cur, setCur] = useState<Record<string, string> | null>(tool.probe ? null : {});
  const [probeErr, setProbeErr] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const needPw = useNeedsSudoPassword(hostId, env);
  // Only the latest probe may set the form's "current" values (a retry or a post-run refresh can overlap).
  const probeSeq = useRef(0);
  useEffect(() => () => void probeSeq.current++, []);

  const probe = () => {
    if (!tool.probe) return;
    const my = ++probeSeq.current;
    setCur(null);
    setProbeErr(null);
    runScript(hostId, env, tool.probe(env), { priv: tool.probePriv, quiet: true, timeout: 20 }).then(
      (r) => my === probeSeq.current && setCur(parseKv(r.stdout)),
      (e) => my === probeSeq.current && setProbeErr(errMsg(e)),
    );
  };
  useEffect(probe, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx: Ctx | null = cur && { env, cur, host };
  const fields = useMemo(() => (ctx && tool.fields ? tool.fields(ctx, values) : []), [cur, values]);
  // Fill defaults once the probe is in, and for fields that appear later (e.g. after picking an action).
  useEffect(() => {
    const missing = fields.filter((f) => !(f.key in values));
    if (missing.length) setValues((v) => ({ ...defaults(missing), ...v }));
  }, [fields]);

  // Pre-run check once the form builds a runnable script.
  const built = ctx ? (tool.build?.(values, ctx) ?? null) : null;
  const runnable = !!built && typeof built !== "string";
  const checkScript = ctx && runnable && tool.check?.script ? tool.check.script(values, ctx) : null;
  const chk = usePreCheck(hostId, env, checkScript);
  const issues =
    ctx && runnable && tool.check && (!checkScript || chk.result) ? tool.check.issues(chk.result ?? {}, values, ctx) : [];
  const checkBlocks = chk.pending || issues.some((i) => i.level === "err");

  if (probeErr)
    return (
      <div className="tb-form">
        <div className="tb-err">{probeErr}</div>
        <button className="btn sm" onClick={probe}>重试</button>
      </div>
    );
  if (!ctx)
    return (
      <div className="tb-form tb-loading faint">
        <LoaderCircle className="spin" />
        读取当前配置
      </div>
    );

  const risk = riskOf(tool, values, ctx);
  const priv = privOf(tool, values, ctx);
  const blocked = priv && needPw;

  const run = async () => {
    if (!built || typeof built === "string" || checkBlocks) return;
    setRunErr(null);
    setResult(null);
    if (tool.term) {
      try {
        runInTerminal(hostId, env, built.script, priv);
      } catch (e) {
        setRunErr(errMsg(e));
      }
      return;
    }
    setBusy(true);
    try {
      const r = await runScript(hostId, env, built.script, { priv, stdin: built.stdin, timeout: tool.timeout });
      setResult(r);
      if (r.exitCode === 0 && tool.after) {
        const msg = await tool.after(values, ctx);
        if (msg) setResult({ ...r, stdout: `${r.stdout.trimEnd()}\n${msg}` });
      }
      if (r.exitCode === 0 && tool.probe) probeQuiet();
      if (checkScript) chk.retry();
    } catch (e) {
      setRunErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  // Refresh the "current" values after a change without resetting the form.
  const probeQuiet = () => {
    if (!tool.probe) return;
    const my = ++probeSeq.current;
    runScript(hostId, env, tool.probe(env), { priv: tool.probePriv, quiet: true, timeout: 20 }).then(
      (r) => my === probeSeq.current && setCur(parseKv(r.stdout)),
      () => {},
    );
  };

  return (
    <div className="tb-form">
      {tool.current?.(ctx.cur) && <div className="tb-cur faint">{tool.current(ctx.cur)}</div>}
      {fields.map((f) => (
        <FieldInput key={f.key} f={f} value={values[f.key]} onChange={(x) => setValues({ ...values, [f.key]: x })} />
      ))}
      {typeof built === "string" && <div className="tb-err">{built}</div>}
      {runnable && tool.check && (checkScript || issues.length > 0) && (
        <CheckList issues={issues} pending={chk.pending} error={chk.error} onRetry={chk.retry} />
      )}
      {built && typeof built !== "string" && (
        <CommandPreview
          script={built.script}
          runAs={tool.term ? `在终端${priv && !env.root ? "通过 sudo " : ""}执行` : runAsLabel(env, priv)}
          risk={risk}
          note={noteOf(tool, values, ctx)}
        />
      )}
      <div className="tb-actions">
        <RunButton
          risk={risk}
          busy={busy}
          term={tool.term}
          disabled={!runnable || checkBlocks || (blocked && !tool.term)}
          label={!built && tool.fields ? "无变化" : chk.pending ? "检查中" : undefined}
          onRun={run}
        />
        {blocked && !tool.term && <span className="faint tb-hint">先输入 sudo 密码</span>}
      </div>
      <ExecOutput result={result} error={runErr} view={VIEWS[tool.id]} />
    </div>
  );
}

export function FieldInput(props: { f: FieldDef; value: Values[string] | undefined; onChange: (v: string | boolean | string[]) => void }) {
  const { f, value } = props;
  const [show, setShow] = useState(false);
  let input;
  switch (f.type) {
    case "check":
      input = <Toggle on={!!value} onChange={props.onChange} />;
      break;
    case "select":
      input = (
        <Select size="sm" width="100%" value={String(value ?? "")} options={f.options ?? []} onChange={(v) => props.onChange(v)} />
      );
      break;
    case "multi": {
      const set = new Set((value as string[]) ?? []);
      input = (
        <div className="tb-multi">
          {(f.options ?? []).map((o) => (
            <button
              key={o.value}
              type="button"
              className={"tb-chip" + (set.has(o.value) ? " on" : "")}
              onClick={() => {
                set.has(o.value) ? set.delete(o.value) : set.add(o.value);
                props.onChange([...set]);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      );
      break;
    }
    case "secret":
      input = (
        <>
          <input
            className="input sm grow mono"
            type={show ? "text" : "password"}
            value={String(value ?? "")}
            autoComplete="new-password"
            onChange={(e) => props.onChange(e.target.value)}
          />
          <button type="button" className="icon-btn" title={show ? "隐藏" : "显示"} onClick={() => setShow(!show)}>
            {show ? <EyeOff /> : <Eye />}
          </button>
          {f.gen && (
            <button
              type="button"
              className="icon-btn"
              title="生成随机密码"
              onClick={() => {
                props.onChange(genPassword());
                setShow(true);
              }}
            >
              <Dices />
            </button>
          )}
        </>
      );
      break;
    default:
      input = (
        <input
          className="input sm grow"
          inputMode={f.type === "number" ? "numeric" : undefined}
          value={String(value ?? "")}
          placeholder={f.placeholder}
          spellCheck={false}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
  }
  return (
    <div className={"field tb-field" + (f.type === "multi" ? " top" : "")}>
      <label>{f.label}</label>
      <div className="row">{input}</div>
    </div>
  );
}
