// Docker side panel: containers, images and Compose projects on the panel host.
// Lists refresh on their own (read-only). Start/stop/restart run straight from the row (command in the
// tooltip); every other change shows its full command and risk before it runs.
import {
  ChevronRight, Copy, Info, LoaderCircle, Pause, Play, Plus, RefreshCw, RotateCw, ScrollText, Square, SquareTerminal, Trash2,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { CommandPreview, ExecOutput, type Risk, RunButton } from "../../components/CommandPreview";
import { Empty } from "../../components/ui";
import { errMsg, type ExecResult } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { usePanelItems } from "../side/panelMenu";
import { useContextMenu } from "../terminal/ContextMenu";
import {
  detectEnv, type RemoteEnv, runAsLabel, runInTerminal, runScript, setSudoPassword, shq, useNeedsSudoPassword,
} from "../../lib/remote";
import { FieldInput, ToolForm } from "../toolbox/ToolboxPanel";
import { TOOLS, type Values } from "../toolbox/tools";
import "./docker.css";

interface Container { id: string; name: string; image: string; state: string; status: string; ports: string }
interface Stat { cpu: string; mem: string }
interface Image { id: string; repo: string; tag: string; size: string; created: string }
interface Project { name: string; status: string; files: string }

/** A change waiting for confirmation. */
export interface Action { key: string; label: string; script: string; risk: Risk; note?: string; term?: boolean; timeout?: number }

type Tab = "containers" | "images" | "compose" | "system";
const TABS: [Tab, string][] = [
  ["containers", "容器"],
  ["images", "镜像"],
  ["compose", "Compose"],
  ["system", "系统"],
];

const jsonLines = <T,>(text: string): T[] =>
  text
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });

/** "0.0.0.0:8080->80/tcp, :::8080->80/tcp" -> "8080→80" */
const shortPorts = (p: string) =>
  [...new Set(p.split(",").map((x) => x.trim().replace(/^(0\.0\.0\.0|\[?::\]?):/, "").replace("->", "→").replace("/tcp", "")))]
    .filter(Boolean)
    .join(" ");

export function DockerPanel({ hostId }: { hostId: string }) {
  const [env, setEnv] = useState<RemoteEnv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("containers");
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
      <Empty icon={<LoaderCircle className="spin" />} text="正在检测 Docker" />
    );
  if (!env.linux) return <Empty text="仅支持 Linux 服务器" />;
  if (!env.docker) {
    const install = TOOLS.find((t) => t.id === "docker")!;
    return (
      <div className="dk-root">
        <div className="dk-install">
          <div className="dk-install-title">未安装 Docker</div>
          <ToolForm tool={install} hostId={hostId} env={env} />
          <button className="btn sm ghost" onClick={() => load(true)}>
            <RefreshCw />
            重新检测
          </button>
        </div>
      </div>
    );
  }

  const priv = !env.dockerDirect && !env.root;
  const blocked = priv && needPw;
  return (
    <div className="dk-root">
      <div className="dk-top">
        <div className="seg dk-seg">
          {TABS.map(([id, label]) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        {blocked && <SudoLine hostId={hostId} />}
      </div>
      {!blocked &&
        (tab === "containers" ? (
          <Containers hostId={hostId} env={env} priv={priv} />
        ) : tab === "images" ? (
          <Images hostId={hostId} env={env} priv={priv} />
        ) : tab === "compose" ? (
          <Compose hostId={hostId} env={env} priv={priv} />
        ) : (
          <SystemTab hostId={hostId} env={env} priv={priv} />
        ))}
    </div>
  );
}

function SudoLine(props: { hostId: string }) {
  const [pw, setPw] = useState("");
  return (
    <form
      className="dk-sudo"
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

export interface TabProps { hostId: string; env: RemoteEnv; priv: boolean }

/** Polls a read-only listing; `reload` forces a refresh (e.g. after an action). */
function usePoll<T>(p: TabProps, script: string, parse: (out: string) => T, everyMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    runScript(p.hostId, p.env, script, { priv: p.priv, quiet: true, timeout: 30 }).then(
      (r) => {
        if (n !== seq.current) return;
        if (r.exitCode !== 0 && !r.stdout.trim()) setError(r.stderr.trim() || `退出码 ${r.exitCode}`);
        else {
          setError(null);
          setData(parse(r.stdout));
        }
      },
      (e) => n === seq.current && setError(errMsg(e)),
    );
  }, [p.hostId, script]);
  useEffect(() => {
    reload();
    if (!everyMs) return;
    const t = setInterval(() => document.visibilityState === "visible" && reload(), everyMs);
    return () => clearInterval(t);
  }, [reload, everyMs]);
  return { data, error, reload };
}

/** Preview + run + output for one pending action. */
export function ActionBox(props: TabProps & { action: Action; onDone: () => void; onCancel: () => void }) {
  const { action, hostId, env, priv } = props;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setErr(null);
    setResult(null);
    if (action.term) {
      try {
        runInTerminal(hostId, env, action.script, priv);
        props.onCancel();
      } catch (e) {
        setErr(errMsg(e));
      }
      return;
    }
    setBusy(true);
    try {
      const r = await runScript(hostId, env, action.script, { priv, timeout: action.timeout ?? 120 });
      setResult(r);
      props.onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dk-action">
      <CommandPreview
        script={action.script}
        runAs={action.term ? `在终端${priv ? "通过 sudo " : ""}执行` : runAsLabel(env, priv)}
        risk={action.risk}
        note={action.note}
      />
      <div className="row">
        <RunButton risk={action.risk} busy={busy} term={action.term} label={result ? "再次执行" : undefined} onRun={run} />
        <button className="btn sm ghost" onClick={props.onCancel}>{result || err ? "关闭" : "取消"}</button>
      </div>
      <ExecOutput result={result} error={err} />
    </div>
  );
}

/** One-click start/stop/restart from a list row. A failure opens the row and shows the output. */
export interface Quick { kind: "start" | "stop" | "restart"; script: string; priv?: boolean }
const QUICK_ICON = { start: Play, stop: Square, restart: RotateCw };
const QUICK_LABEL = { start: "启动", stop: "停止", restart: "重启" };

export function useQuick(p: TabProps, onDone: () => void) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [fail, setFail] = useState<{ key: string; result: ExecResult | null; error: string | null } | null>(null);
  const run = async (key: string, q: Quick) => {
    setBusy((b) => ({ ...b, [key]: true }));
    setFail((f) => (f?.key === key ? null : f));
    try {
      const r = await runScript(p.hostId, p.env, q.script, { priv: q.priv ?? p.priv, timeout: 120 });
      if (r.exitCode !== 0) setFail({ key, result: r, error: null });
    } catch (e) {
      setFail({ key, result: null, error: errMsg(e) });
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
      onDone();
    }
  };
  return { busy, fail, run, clear: () => setFail(null) };
}

/** Fixed-width control column so names and stats line up whatever buttons a row shows. */
export function QuickBtns(props: { items: Quick[]; busy: boolean; onRun: (q: Quick) => void }) {
  return (
    <span className="dk-ctl" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {props.busy ? (
        <LoaderCircle className="spin dk-ctl-spin" />
      ) : (
        props.items.map((q) => {
          const Icon = QUICK_ICON[q.kind];
          return (
            <button key={q.kind} className={"icon-btn sm" + (q.kind === "start" ? " ok" : q.kind === "stop" ? " danger" : "")} title={`${QUICK_LABEL[q.kind]}\n${q.script}`} onClick={() => props.onRun(q)}>
              <Icon />
            </button>
          );
        })
      )}
    </span>
  );
}

function ListHead(props: { count?: number; label: string; onReload: () => void; children?: ReactNode }) {
  return (
    <div className="dk-listhead">
      <span className="faint">{props.label}{props.count != null ? ` ${props.count}` : ""}</span>
      <span className="grow" />
      {props.children}
      <button className="icon-btn" title="刷新" onClick={props.onReload}>
        <RefreshCw />
      </button>
    </div>
  );
}

// ---------------- containers ----------------

function Containers(p: TabProps) {
  const list = usePoll(
    p,
    "docker ps -a --format '{{json .}}'",
    (out) =>
      jsonLines<Record<string, string>>(out).map<Container>((c) => ({
        id: c.ID,
        name: c.Names,
        image: c.Image,
        state: c.State || (c.Status?.startsWith("Up") ? "running" : "exited"),
        status: c.Status,
        ports: c.Ports ?? "",
      })),
    5000,
  );
  const stats = usePoll(
    p,
    "docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'",
    (out) =>
      Object.fromEntries(
        out
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [n, cpu, mem] = l.split("\t");
            return [n, { cpu, mem: (mem ?? "").split("/")[0].trim() }];
          }),
      ) as Record<string, Stat>,
    10000,
  );
  const [open, setOpen] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [creating, setCreating] = useState(false);
  const quick = useQuick(p, () => (list.reload(), stats.reload()));
  const menu = useContextMenu();
  const panelExtra = usePanelItems();

  const act = (c: Container, kind: string): Action => {
    const n = shq(c.name);
    switch (kind) {
      case "start":
        return { key: c.id, label: "启动", script: `docker start ${n}`, risk: "change" };
      case "stop":
        return { key: c.id, label: "停止", script: `docker stop ${n}`, risk: "change", note: "容器内服务会中断" };
      case "restart":
        return { key: c.id, label: "重启", script: `docker restart ${n}`, risk: "change", note: "容器内服务会短暂中断" };
      case "pause":
        return { key: c.id, label: "暂停", script: `docker pause ${n}`, risk: "change", note: "冻结容器内所有进程" };
      case "unpause":
        return { key: c.id, label: "恢复", script: `docker unpause ${n}`, risk: "change" };
      case "logs":
        return { key: c.id, label: "日志", script: `docker logs --tail 200 --timestamps ${n} 2>&1`, risk: "read" };
      case "follow":
        return { key: c.id, label: "实时日志", script: `docker logs -f --tail 100 ${n}`, risk: "read", term: true, note: "Ctrl+C 退出" };
      case "shell":
        return {
          key: c.id,
          label: "进入容器",
          script: `docker exec -it ${n} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`,
          risk: "change",
          term: true,
          note: "exit 退出",
        };
      case "inspect":
        return { key: c.id, label: "详情", script: `docker inspect ${n}`, risk: "read" };
      default:
        return { key: c.id, label: "删除", script: `docker rm -f ${n}`, risk: "high", note: "强制删除容器，未挂载到卷的数据会丢失" };
    }
  };

  if (list.error && !list.data) return <Empty text={list.error} />;
  if (!list.data)
    return (
      <Empty icon={<LoaderCircle className="spin" />} text="加载中…" />
    );
  const running = list.data.filter((c) => c.state === "running").length;
  return (
    <div
      className="dk-body"
      onContextMenu={(e) =>
        menu.open(e, [
          { label: "新建容器…", icon: <Plus />, onSelect: () => setCreating(true) },
          { label: "刷新", icon: <RefreshCw />, onSelect: () => (list.reload(), stats.reload()) },
          ...panelExtra(),
        ])
      }
    >
      <ListHead label={`运行 ${running} / 共`} count={list.data.length} onReload={() => (list.reload(), stats.reload())}>
        <button className={"btn sm ghost" + (creating ? " on" : "")} onClick={() => setCreating(!creating)}>
          <Plus />
          新建
        </button>
      </ListHead>
      {creating && <RunForm {...p} onDone={list.reload} />}
      {list.data.length === 0 && !creating && <Empty text="没有容器" />}
      {list.data.map((c) => {
        const st = stats.data?.[c.name];
        const failed = quick.fail?.key === c.id ? quick.fail : null;
        const isOpen = open === c.id || !!failed;
        const up = c.state === "running";
        const paused = c.state === "paused";
        const n = shq(c.name);
        const quicks: Quick[] = up
          ? [{ kind: "stop", script: `docker stop ${n}` }, { kind: "restart", script: `docker restart ${n}` }]
          : [{ kind: "start", script: paused ? `docker unpause ${n}` : `docker start ${n}` }];
        const toggle = () => (setOpen(isOpen ? null : c.id), setAction(null), failed && quick.clear());
        // Same rule as the row: start/stop/restart run at once, everything else opens its command preview.
        const preview = (k: string) => (setOpen(c.id), setAction(act(c, k)));
        const busy = !!quick.busy[c.id];
        const onMenu = (e: React.MouseEvent) =>
          menu.open(e, [
            up
              ? { label: "停止", icon: <Square />, disabled: busy, onSelect: () => quick.run(c.id, quicks[0]) }
              : { label: paused ? "恢复" : "启动", icon: <Play />, disabled: busy, onSelect: () => quick.run(c.id, quicks[0]) },
            { label: "重启", icon: <RotateCw />, disabled: busy || !up, onSelect: () => quick.run(c.id, quicks[1]) },
            { label: "暂停…", icon: <Pause />, disabled: !up, onSelect: () => preview("pause") },
            "sep",
            { label: "复制名称", icon: <Copy />, onSelect: () => copyText(c.name, "名称") },
            { label: "复制 ID", icon: <Copy />, onSelect: () => copyText(c.id, " ID") },
            "sep",
            { label: "进入容器…", icon: <SquareTerminal />, disabled: !up, onSelect: () => preview("shell") },
            { label: "日志…", icon: <ScrollText />, onSelect: () => preview("logs") },
            { label: "实时日志…", icon: <ScrollText />, disabled: !up, onSelect: () => preview("follow") },
            { label: "详情…", icon: <Info />, onSelect: () => preview("inspect") },
            "sep",
            { label: "删除…", icon: <Trash2 />, danger: true, onSelect: () => preview("rm") },
          ]);
        return (
          <div key={c.id} className={"dk-item" + (isOpen ? " open" : "")}>
            <div
              className="dk-row"
              role="button"
              tabIndex={0}
              onClick={toggle}
              onKeyDown={(e) => e.key === "Enter" && toggle()}
              onContextMenu={onMenu}
            >
              <span className={"dot " + (up ? "ok" : paused || c.state === "restarting" ? "warn" : "")} />
              <span className="dk-name ellipsis">{c.name}</span>
              <span className="dk-sub ellipsis grow">{c.image}</span>
              {up && st && (
                <span className="dk-nums" title="CPU / 内存">
                  <span>{st.cpu}</span>
                  <span>{st.mem}</span>
                </span>
              )}
              <QuickBtns items={quicks} busy={!!quick.busy[c.id]} onRun={(q) => quick.run(c.id, q)} />
              <ChevronRight className="dk-chev" />
            </div>
            {isOpen && (
              <div className="dk-detail">
                {failed && <ExecOutput result={failed.result} error={failed.error} />}
                <div className="kv">
                  <span>状态</span>
                  <span className="ellipsis">{c.status}</span>
                  {c.ports && (
                    <>
                      <span>端口</span>
                      <span className="mono ellipsis" title={c.ports}>{shortPorts(c.ports)}</span>
                    </>
                  )}
                  <span>ID</span>
                  <span className="mono">{c.id.slice(0, 12)}</span>
                </div>
                <div className="dk-btns">
                  {(up
                    ? ["stop", "restart", "pause", "shell", "logs", "follow", "inspect", "rm"]
                    : paused
                      ? ["unpause", "stop", "logs", "inspect", "rm"]
                      : ["start", "logs", "inspect", "rm"]).map((k) => {
                    const a = act(c, k);
                    return (
                      <button
                        key={k}
                        className={"btn sm" + (action?.label === a.label ? " on" : "") + (a.risk === "high" ? " danger" : "")}
                        onClick={() => setAction(action?.label === a.label ? null : a)}
                      >
                        {a.term && <SquareTerminal />}
                        {a.label}
                      </button>
                    );
                  })}
                </div>
                {action && action.key === c.id && (
                  <ActionBox key={action.label} {...p} action={action} onDone={list.reload} onCancel={() => setAction(null)} />
                )}
              </div>
            )}
          </div>
        );
      })}
      {menu.node}
    </div>
  );
}

/** docker run form. */
function RunForm(p: TabProps & { onDone: () => void }) {
  const [v, setV] = useState<Values>({ image: "", name: "", ports: "", volumes: "", env: "", restart: "unless-stopped", extra: "" });
  const s = (k: string) => String(v[k] ?? "").trim();
  const split = (k: string) => s(k).split(/[\s,，]+/).filter(Boolean);
  const args = ["docker run -d"];
  if (s("name")) args.push(`--name ${shq(s("name"))}`);
  if (s("restart") !== "no") args.push(`--restart ${s("restart")}`);
  split("ports").forEach((x) => args.push(`-p ${shq(x)}`));
  split("volumes").forEach((x) => args.push(`-v ${shq(x)}`));
  s("env")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((x) => args.push(`-e ${shq(x)}`));
  if (s("extra")) args.push(s("extra"));
  args.push(s("image") ? shq(s("image")) : "<镜像>");
  const script = args.join(" \\\n  ");
  const bad = s("name") && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s("name")) ? "名称只能包含字母、数字、_ . -" : null;
  const f = (key: string, label: string, placeholder: string) => (
    <FieldInput key={key} f={{ key, label, type: "text", placeholder }} value={v[key]} onChange={(x) => setV({ ...v, [key]: x })} />
  );
  return (
    <div className="dk-form">
      {f("image", "镜像", "nginx:latest")}
      {f("name", "名称", "web")}
      {f("ports", "端口", "8080:80 8443:443")}
      {f("volumes", "挂载", "/data/web:/usr/share/nginx/html")}
      <div className="field top tb-field">
        <label>环境变量</label>
        <textarea
          className="textarea mono dk-env"
          rows={2}
          placeholder="TZ=Asia/Shanghai"
          spellCheck={false}
          value={String(v.env)}
          onChange={(e) => setV({ ...v, env: e.target.value })}
        />
      </div>
      <FieldInput
        f={{
          key: "restart",
          label: "重启策略",
          type: "select",
          options: [
            { value: "unless-stopped", label: "除非手动停止" },
            { value: "always", label: "总是" },
            { value: "on-failure", label: "失败时" },
            { value: "no", label: "不重启" },
          ],
        }}
        value={v.restart}
        onChange={(x) => setV({ ...v, restart: x })}
      />
      {f("extra", "其他参数", "--network host")}
      {bad && <div className="tb-err">{bad}</div>}
      {s("image") && !bad ? (
        <ActionBox
          key={script}
          {...p}
          action={{ key: "run", label: "创建", script, risk: "change", timeout: 600 }}
          onDone={p.onDone}
          onCancel={() => setV({ ...v, image: "" })}
        />
      ) : (
        <CommandPreview script={script} runAs={runAsLabel(p.env, p.priv)} risk="change" />
      )}
    </div>
  );
}

// ---------------- images ----------------

function Images(p: TabProps) {
  const list = usePoll(
    p,
    "docker images --format '{{json .}}'",
    (out) =>
      jsonLines<Record<string, string>>(out).map<Image>((i) => ({
        id: i.ID,
        repo: i.Repository,
        tag: i.Tag,
        size: i.Size,
        created: i.CreatedSince,
      })),
    0,
  );
  const [action, setAction] = useState<Action | null>(null);
  const [pull, setPull] = useState("");
  const ref = (i: Image) => (i.repo === "<none>" ? i.id : `${i.repo}:${i.tag}`);
  const menu = useContextMenu();
  const panelExtra = usePanelItems();
  const rmi = (i: Image): Action => ({ key: i.id + i.tag, label: "删除", script: `docker rmi ${shq(ref(i))}`, risk: "high", note: "被容器使用时会失败" });

  if (list.error && !list.data) return <Empty text={list.error} />;
  return (
    <div
      className="dk-body"
      onContextMenu={(e) => menu.open(e, [{ label: "刷新", icon: <RefreshCw />, onSelect: list.reload }, ...panelExtra()])}
    >
      <form
        className="dk-pull"
        onSubmit={(e) => {
          e.preventDefault();
          if (pull.trim()) setAction({ key: "pull", label: "拉取", script: `docker pull ${shq(pull.trim())}`, risk: "change", term: true });
        }}
      >
        <input className="input sm grow mono" placeholder="redis:7" value={pull} spellCheck={false} onChange={(e) => setPull(e.target.value)} />
        <button className="btn sm" type="submit" disabled={!pull.trim()}>拉取</button>
      </form>
      {action?.key === "pull" && <ActionBox {...p} action={action} onDone={list.reload} onCancel={() => setAction(null)} />}
      <ListHead label="镜像" count={list.data?.length} onReload={list.reload} />
      {!list.data && (
        <Empty icon={<LoaderCircle className="spin" />} text="加载中…" />
      )}
      {list.data?.map((i) => (
        <div key={i.id + i.repo + i.tag} className={"dk-item" + (action?.key === i.id + i.tag ? " open" : "")}>
          <div
            className="dk-row static"
            onContextMenu={(e) =>
              menu.open(e, [
                { label: "复制名称", icon: <Copy />, onSelect: () => copyText(ref(i), "名称") },
                { label: "复制 ID", icon: <Copy />, onSelect: () => copyText(i.id, " ID") },
                "sep",
                { label: "删除…", icon: <Trash2 />, danger: true, onSelect: () => setAction(rmi(i)) },
              ])
            }
          >
            <span className="dk-name ellipsis grow mono" title={ref(i)}>
              {i.repo}
              <span className="faint">:{i.tag}</span>
            </span>
            <span className="dk-nums">
              <span>{i.size}</span>
            </span>
            <button
              className="btn sm ghost dk-del"
              onClick={() => setAction(rmi(i))}
            >
              删除
            </button>
          </div>
          {action?.key === i.id + i.tag && (
            <div className="dk-detail">
              <ActionBox {...p} action={action} onDone={list.reload} onCancel={() => setAction(null)} />
            </div>
          )}
        </div>
      ))}
      {menu.node}
    </div>
  );
}

// ---------------- compose ----------------

function Compose(p: TabProps) {
  const list = usePoll(
    p,
    "docker compose ls -a --format json 2>/dev/null || echo NOCOMPOSE",
    (out): Project[] | "none" => {
      if (out.includes("NOCOMPOSE")) return "none";
      try {
        return (JSON.parse(out) as Record<string, string>[]).map<Project>((x) => ({ name: x.Name, status: x.Status, files: x.ConfigFiles }));
      } catch {
        return [];
      }
    },
    10000,
  );
  const [open, setOpen] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const quick = useQuick(p, list.reload);
  const menu = useContextMenu();
  const panelExtra = usePanelItems();

  if (list.error && !list.data) return <Empty text={list.error} />;
  if (!list.data)
    return (
      <Empty icon={<LoaderCircle className="spin" />} text="加载中…" />
    );
  if (list.data === "none") return <Empty text="未安装 docker compose 插件" />;

  const composeBase = (pr: Project) => `docker compose -f ${shq(pr.files.split(",")[0])}`;
  const act = (pr: Project, kind: string): Action => {
    const base = composeBase(pr);
    switch (kind) {
      case "up":
        return { key: pr.name, label: "启动", script: `${base} up -d`, risk: "change", timeout: 600 };
      case "stop":
        return { key: pr.name, label: "停止", script: `${base} stop`, risk: "change", note: "只停止容器，不删除" };
      case "down":
        return { key: pr.name, label: "停止并移除", script: `${base} down`, risk: "high", note: "停止并删除项目的容器和网络，卷会保留" };
      case "restart":
        return { key: pr.name, label: "重启", script: `${base} restart`, risk: "change", note: "项目内服务会短暂中断" };
      case "update":
        return { key: pr.name, label: "更新", script: `${base} pull && ${base} up -d`, risk: "change", term: true };
      default:
        return { key: pr.name, label: "日志", script: `${base} logs --tail 100 2>&1`, risk: "read" };
    }
  };

  return (
    <div
      className="dk-body"
      onContextMenu={(e) => menu.open(e, [{ label: "刷新", icon: <RefreshCw />, onSelect: list.reload }, ...panelExtra()])}
    >
      <ListHead label="项目" count={list.data.length} onReload={list.reload} />
      {list.data.length === 0 && <Empty text="没有 Compose 项目" />}
      {list.data.map((pr) => {
        const failed = quick.fail?.key === pr.name ? quick.fail : null;
        const isOpen = open === pr.name || !!failed;
        const up = pr.status.startsWith("running");
        const base = composeBase(pr);
        const quicks: Quick[] = up
          ? [{ kind: "stop", script: `${base} stop` }, { kind: "restart", script: `${base} restart` }]
          : [{ kind: "start", script: `${base} start` }];
        const toggle = () => (setOpen(isOpen ? null : pr.name), setAction(null), failed && quick.clear());
        const preview = (k: string) => (setOpen(pr.name), setAction(act(pr, k)));
        const busy = !!quick.busy[pr.name];
        const onMenu = (e: React.MouseEvent) =>
          menu.open(e, [
            up
              ? { label: "停止", icon: <Square />, disabled: busy, onSelect: () => quick.run(pr.name, quicks[0]) }
              : { label: "启动", icon: <Play />, disabled: busy, onSelect: () => quick.run(pr.name, quicks[0]) },
            { label: "重启", icon: <RotateCw />, disabled: busy || !up, onSelect: () => quick.run(pr.name, quicks[1]) },
            "sep",
            { label: "复制配置路径", icon: <Copy />, onSelect: () => copyText(pr.files.split(",")[0], "路径") },
            "sep",
            { label: "更新…", icon: <SquareTerminal />, onSelect: () => preview("update") },
            { label: "日志…", icon: <ScrollText />, onSelect: () => preview("logs") },
            "sep",
            { label: "停止并移除…", icon: <Trash2 />, danger: true, onSelect: () => preview("down") },
          ]);
        return (
          <div key={pr.name} className={"dk-item" + (isOpen ? " open" : "")}>
            <div
              className="dk-row"
              role="button"
              tabIndex={0}
              onClick={toggle}
              onKeyDown={(e) => e.key === "Enter" && toggle()}
              onContextMenu={onMenu}
            >
              <span className={"dot " + (up ? "ok" : "")} />
              <span className="dk-name ellipsis">{pr.name}</span>
              <span className="dk-sub ellipsis grow">{pr.status}</span>
              <QuickBtns items={quicks} busy={!!quick.busy[pr.name]} onRun={(q) => quick.run(pr.name, q)} />
              <ChevronRight className="dk-chev" />
            </div>
            {isOpen && (
              <div className="dk-detail">
                {failed && <ExecOutput result={failed.result} error={failed.error} />}
                <div className="kv">
                  <span>配置</span>
                  <span className="mono ellipsis" title={pr.files}>{pr.files}</span>
                </div>
                <div className="dk-btns">
                  {(up ? ["stop", "restart", "update", "logs", "down"] : ["up", "update", "logs", "down"]).map((k) => {
                    const a = act(pr, k);
                    return (
                      <button
                        key={k}
                        className={"btn sm" + (action?.label === a.label ? " on" : "") + (a.risk === "high" ? " danger" : "")}
                        onClick={() => setAction(action?.label === a.label ? null : a)}
                      >
                        {a.term && <SquareTerminal />}
                        {a.label}
                      </button>
                    );
                  })}
                </div>
                {action?.key === pr.name && (
                  <ActionBox key={action.label} {...p} action={action} onDone={list.reload} onCancel={() => setAction(null)} />
                )}
              </div>
            )}
          </div>
        );
      })}
      {menu.node}
    </div>
  );
}

// ---------------- system ----------------

const REGISTRY_MIRRORS = [
  { value: "https://docker.m.daocloud.io", label: "DaoCloud" },
  { value: "https://docker.1ms.run", label: "1ms" },
  { value: "https://dockerproxy.net", label: "DockerProxy" },
];

function SystemTab(p: TabProps) {
  const df = usePoll(p, "docker system df", (out) => out, 0);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [mirror, setMirror] = useState(REGISTRY_MIRRORS[0].value);
  const items: Action[] = [
    { key: "prune", label: "清理停止的容器和悬空镜像", script: "docker system prune -f", risk: "change" },
    {
      key: "prune-all",
      label: "深度清理（含未使用镜像）",
      script: "docker system prune -af",
      risk: "high",
      note: "未被使用的镜像全部删除，需重新拉取",
      timeout: 600,
    },
    {
      key: "mirror",
      label: "镜像加速",
      script: [
        "F=/etc/docker/daemon.json; mkdir -p /etc/docker",
        `M=${shq(mirror)}`,
        'if [ ! -s "$F" ]; then printf \'{\\n  "registry-mirrors": ["%s"]\\n}\\n\' "$M" > "$F"',
        'elif command -v jq >/dev/null 2>&1; then cp "$F" "$F.myshell.bak"; jq --arg m "$M" \'."registry-mirrors" = [$m]\' "$F.myshell.bak" > "$F"',
        'else echo "已有 $F 且未安装 jq，请手动编辑" >&2; exit 1; fi',
        "cat \"$F\"",
        "systemctl daemon-reload && systemctl restart docker",
      ].join("\n"),
      risk: "high",
      note: "需重启 Docker，部分容器会停止",
    },
  ];
  return (
    <div className="dk-body">
      <ListHead label="磁盘占用" onReload={df.reload} />
      <pre className="cp-code mono selectable dk-df">{df.data ?? df.error ?? "…"}</pre>
      {items.map((a) => (
        <div key={a.key} className={"dk-item" + (openKey === a.key ? " open" : "")}>
          <button className="dk-row" onClick={() => setOpenKey(openKey === a.key ? null : a.key)}>
            <span className="grow ellipsis">{a.label}</span>
            <ChevronRight className="dk-chev" />
          </button>
          {openKey === a.key && (
            <div className="dk-detail">
              {a.key === "mirror" && (
                <FieldInput
                  f={{ key: "m", label: "加速地址", type: "select", options: REGISTRY_MIRRORS }}
                  value={mirror}
                  onChange={(x) => setMirror(String(x))}
                />
              )}
              <ActionBox key={a.script} {...p} action={a} onDone={df.reload} onCancel={() => setOpenKey(null)} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
