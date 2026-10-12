// Add / edit a monitor card: type list (add only), live preview and per-type settings.
import { Check } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Dialog, Field, Toggle } from "../../components/ui";
import { Select } from "../../components/Select";
import {
  type CardCfg,
  type CardInst,
  type CardSize,
  type CardType,
  cardTitle,
  DEFAULT_INFO_FIELDS,
  INFO_FIELDS,
  METRICS,
  type MetricKey,
  newCard,
  TYPE_GROUPS,
  TYPE_META,
} from "./cards";
import { type CardCtx, gaugeMax, isTile } from "./CardViews";

const SIZES: [CardSize, string][] = [
  ["s", "1/3"],
  ["m", "1/2"],
  ["l", "整行"],
];

const PRESETS: { label: string; title: string; cfg: CardCfg }[] = [
  { label: "Docker 容器", title: "容器", cfg: { command: "docker ps --format '{{.Names}}  {{.Status}}'", output: "text", lines: 8 } },
  { label: "监听端口", title: "监听端口", cfg: { command: "ss -tlnH | awk '{print $4}' | sort -u", output: "text", lines: 8 } },
  { label: "登录用户", title: "登录用户", cfg: { command: "who", output: "text", lines: 6 } },
  { label: "错误日志", title: "错误日志", cfg: { command: "journalctl -p err -n 6 --no-pager -o short-iso 2>/dev/null", output: "text", lines: 6, interval: 60 } },
  { label: "进程总数", title: "进程数", cfg: { command: "ps -e --no-headers | wc -l", output: "number" } },
  { label: "已建立连接", title: "已建立连接", cfg: { command: "ss -tnH state established | wc -l", output: "number" } },
  { label: "CPU 温度", title: "CPU 温度", cfg: { command: "awk '{printf \"%.1f\", $1/1000}' /sys/class/thermal/thermal_zone0/temp", output: "number", unit: "°C", warn: 70, err: 85 } },
  { label: "打开文件数", title: "打开文件", cfg: { command: "awk '{print $1}' /proc/sys/fs/file-nr", output: "number" } },
];

function Seg<T extends string | number>(props: { value: T; options: [T, string, boolean?][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {props.options.map(([v, label, disabled]) => (
        <button key={String(v)} type="button" className={v === props.value ? "on" : ""} disabled={disabled} onClick={() => props.onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function NumInput(props: { value?: number; placeholder?: string; onChange: (v: number | undefined) => void }) {
  return (
    <input
      className="input sm mon-num-input"
      inputMode="decimal"
      value={props.value ?? ""}
      placeholder={props.placeholder}
      onChange={(e) => {
        const t = e.target.value.trim();
        const n = Number(t);
        props.onChange(t === "" || Number.isNaN(n) ? undefined : n);
      }}
    />
  );
}

const sizeClass = (s: CardSize) => "mon-card size-" + s;


export function CardDialog(props: {
  initial?: CardInst;
  /** Pick a new type for this card; it keeps its place (uid) and scope. */
  replace?: CardInst;
  hostId: string;
  ctx: CardCtx | null;
  render: (c: CardInst) => ReactNode;
  onSave: (c: CardInst) => void;
  onClose: () => void;
}) {
  const adding = !props.initial;
  const [card, setCard] = useState<CardInst>(
    () => props.initial ?? newCard(props.replace?.type === "metric" ? "load" : "metric", props.replace && { uid: props.replace.uid, host: props.replace.host }),
  );
  // A width the user picked survives switching type.
  const sizeTouched = useRef(false);
  // Commands only run when asked (typing a command must not execute every prefix).
  const execs = card.type === "command" || card.type === "service";
  const [probe, setProbe] = useState<CardCfg>(card.cfg);
  useEffect(() => setProbe(card.cfg), [card.type]); // eslint-disable-line react-hooks/exhaustive-deps

  const cfg = card.cfg;
  // The scope the card already has gets the primary button.
  const local = !!card.host;
  const set = (patch: Partial<CardInst>) => setCard((c) => ({ ...c, ...patch }));
  const setCfg = (patch: Partial<CardCfg>) => setCard((c) => ({ ...c, cfg: { ...c.cfg, ...patch } }));
  const pickType = (t: CardType) => {
    const c = newCard(t, { uid: card.uid, host: props.replace?.host });
    if (sizeTouched.current) c.size = card.size;
    if (t === "disk" && props.ctx) c.cfg.mount = props.ctx.cur.disks.find((d) => d.mount === "/")?.mount ?? props.ctx.cur.disks[0]?.mount;
    if (t === "nic" && props.ctx) c.cfg.nic = props.ctx.cur.nets[0]?.name;
    if (t === "note") c.host = props.hostId;
    setCard(c);
  };

  const preview: CardInst = execs ? { ...card, cfg: { ...cfg, command: probe.command, services: probe.services } } : card;
  const dirty = execs && (probe.command !== cfg.command || probe.services !== cfg.services);
  const ctx = props.ctx;
  const metric = cfg.metric ?? "cpu";
  const canGauge = ctx ? gaugeMax(metric, ctx.cur, ctx.info) > 0 : !!METRICS[metric].pct;

  const form = (
    <div className="stack mon-cfg">
      <Field label="标题">
        <input className="input sm" value={card.title ?? ""} placeholder={cardTitle({ ...card, title: "" })} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <Field label="宽度">
        <Seg value={card.size} options={SIZES.map(([v, l]) => [v, l] as [CardSize, string])} onChange={(size) => {
            sizeTouched.current = true;
            set({ size });
          }} />
      </Field>

      {card.type === "info" && (
        <>
          <Field label="标题行">
            <Toggle on={!cfg.noHead} onChange={(on) => setCfg({ noHead: on ? undefined : true })} />
          </Field>
          <Field label="显示" top>
            <div className="mon-fields">
              {INFO_FIELDS.map(([f, label]) => {
                const cur = cfg.fields ?? DEFAULT_INFO_FIELDS;
                const on = cur.includes(f);
                return (
                  <button
                    key={f}
                    type="button"
                    className={on ? "on" : ""}
                    aria-pressed={on}
                    onClick={() => setCfg({ fields: on ? cur.filter((x) => x !== f) : [...cur, f] })}
                  >
                    <span className="box">{on && <Check />}</span>
                    {label}
                  </button>
                );
              })}
            </div>
          </Field>
        </>
      )}

      {card.type === "metric" && (
        <>
          <Field label="指标">
            <Select
              size="sm"
              value={metric}
              options={(Object.keys(METRICS) as MetricKey[]).map((k) => ({ value: k, label: METRICS[k].label }))}
              onChange={(m) => setCfg({ metric: m, warn: undefined, err: undefined, view: cfg.view === "gauge" && !METRICS[m].pct && !m.startsWith("load") ? "trend" : cfg.view })}
            />
          </Field>
          {(metric === "rx" || metric === "tx") && (
            <Field label="网卡">
              <Select
                size="sm"
                value={cfg.nic ?? ""}
                options={[{ value: "", label: "全部网卡" }, ...(ctx?.cur.nets ?? []).map((n) => ({ value: n.name, label: n.name }))]}
                onChange={(nic) => setCfg({ nic: nic || undefined })}
              />
            </Field>
          )}
          <Field label="样式">
            <Seg
              value={cfg.view ?? "trend"}
              options={[
                ["trend", "趋势"],
                ["gauge", "仪表", !canGauge],
                ["number", "数字"],
              ]}
              onChange={(view) => setCfg({ view })}
            />
          </Field>
        </>
      )}

      {(card.type === "metric" || card.type === "disk" || (card.type === "command" && cfg.output === "number")) && (
        <Field label="颜色">
          <div className="mon-swatches">
            {([1, 2, 3, 4] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={"mon-swatch" + ((cfg.color ?? (card.type === "disk" ? 4 : 1)) === c ? " on" : "")}
                style={{ background: `var(--chart-${c})` }}
                title={`颜色 ${c}`}
                onClick={() => setCfg({ color: c })}
              />
            ))}
          </div>
        </Field>
      )}

      {card.type === "disk" && (
        <Field label="挂载点">
          <Select
            size="sm"
            value={cfg.mount ?? ""}
            placeholder="/"
            options={(ctx?.cur.disks ?? []).map((d) => ({ value: d.mount, label: d.mount }))}
            onChange={(mount) => setCfg({ mount })}
          />
        </Field>
      )}

      {card.type === "net" && (
        <Field label="折线图">
          <Select
            size="sm"
            value={cfg.nic ?? ""}
            options={[{ value: "", label: "全部网卡" }, ...(ctx?.cur.nets ?? []).map((n) => ({ value: n.name, label: n.name }))]}
            onChange={(nic) => setCfg({ nic: nic || undefined })}
          />
        </Field>
      )}

      {card.type === "nic" && (
        <Field label="网卡">
          <Select
            size="sm"
            value={cfg.nic ?? ""}
            placeholder="eth0"
            options={(ctx?.cur.nets ?? []).map((n) => ({ value: n.name, label: n.name }))}
            onChange={(nic) => setCfg({ nic })}
          />
        </Field>
      )}

      {card.type === "procs" && (
        <>
          <Field label="数量">
            <Seg value={cfg.limit ?? 10} options={[[5, "5"], [10, "10"], [20, "20"]]} onChange={(limit) => setCfg({ limit })} />
          </Field>
          <Field label="排序">
            <Seg value={cfg.sort ?? "cpu"} options={[["cpu", "CPU"], ["mem", "内存"]]} onChange={(sort) => setCfg({ sort })} />
          </Field>
          <Field label="过滤">
            <input className="input sm" value={cfg.filter ?? ""} placeholder="nginx" onChange={(e) => setCfg({ filter: e.target.value })} />
          </Field>
        </>
      )}

      {card.type === "command" && (
        <>
          <Field label="示例" top>
            <div className="mon-presets">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="btn sm ghost"
                  onClick={() => {
                    const next = { ...TYPE_META.command.cfg, ...p.cfg };
                    setCard((c) => ({ ...c, title: p.title, size: p.cfg.output === "number" ? "s" : "l", cfg: next }));
                    setProbe(next);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="命令" top>
            <textarea
              className="textarea mono mon-cmd"
              rows={3}
              value={cfg.command ?? ""}
              placeholder="df -h /"
              spellCheck={false}
              onChange={(e) => setCfg({ command: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) setProbe(cfg);
              }}
            />
          </Field>
          <Field label="显示">
            <Seg value={cfg.output ?? "text"} options={[["text", "文本"], ["number", "数值"]]} onChange={(output) => setCfg({ output })} />
          </Field>
          {cfg.output === "number" ? (
            <Field label="单位">
              <input className="input sm mon-num-input" value={cfg.unit ?? ""} placeholder="ms" onChange={(e) => setCfg({ unit: e.target.value })} />
            </Field>
          ) : (
            <Field label="行数">
              <Seg value={cfg.lines ?? 6} options={[[3, "3"], [6, "6"], [10, "10"], [20, "20"]]} onChange={(lines) => setCfg({ lines })} />
            </Field>
          )}
        </>
      )}

      {card.type === "service" && (
        <Field label="服务" top hint="systemd 服务名，空格分隔">
          <input className="input sm mono" value={cfg.services ?? ""} placeholder="nginx docker sshd" onChange={(e) => setCfg({ services: e.target.value })} />
        </Field>
      )}

      {(execs || card.type === "gpu") && (
        <Field label="刷新">
          <Seg value={cfg.interval ?? 30} options={[[5, "5 秒"], [10, "10 秒"], [30, "30 秒"], [60, "1 分"], [300, "5 分"]]} onChange={(interval) => setCfg({ interval })} />
        </Field>
      )}

      {(card.type === "metric" || card.type === "disk" || (card.type === "command" && cfg.output === "number")) && (
        <Field label="告警">
          <NumInput value={cfg.warn} placeholder={card.type === "command" || !METRICS[metric].pct ? "警告" : "75"} onChange={(warn) => setCfg({ warn })} />
          <NumInput value={cfg.err} placeholder={card.type === "command" || !METRICS[metric].pct ? "危险" : "90"} onChange={(err) => setCfg({ err })} />
        </Field>
      )}

      {card.type === "note" && (
        <Field label="内容" top>
          <textarea className="textarea" rows={4} value={cfg.text ?? ""} placeholder="生产库，重启前先通知" onChange={(e) => setCfg({ text: e.target.value })} />
        </Field>
      )}

    </div>
  );

  const previewBox = (
    <div className="mon mon-preview">
      <div className="mon-preview-head">
        <span className="section-title">预览</span>
        {execs && (
          <button className={"btn sm" + (dirty ? " primary" : "")} type="button" onClick={() => setProbe(cfg)}>
            运行
          </button>
        )}
      </div>
      <div className="mon-cards mon-preview-cards">
        {ctx ? <div className={sizeClass(card.size) + (isTile(card) ? " tile" : "")}>{props.render(preview)}</div> : <div className="mon-muted">暂无数据</div>}
      </div>
    </div>
  );

  return (
    <Dialog
      title={props.replace ? `替换「${cardTitle(props.replace)}」` : adding ? "添加卡片" : "编辑卡片"}
      width={adding ? 760 : 560}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button
            className={"btn" + (local ? " primary" : "")}
            title="只在这台服务器显示"
            onClick={() => props.onSave({ ...card, host: props.hostId })}
          >
            {adding && !props.replace ? "添加到本机" : "保存本机"}
          </button>
          <button
            className={"btn" + (local ? "" : " primary")}
            title="所有服务器都显示"
            onClick={() => props.onSave({ ...card, host: undefined })}
          >
            {adding && !props.replace ? "添加到全局" : "保存全局"}
          </button>
        </>
      }
    >
      <div className={"mon-dlg" + (adding ? " adding" : "")}>
        {adding && (
          <div className="mon-types">
            {TYPE_GROUPS.map((g) => (
              <div key={g} className="mon-type-group">
                <div className="mon-type-head">{g}</div>
                {(Object.keys(TYPE_META) as CardType[])
                  .filter((t) => TYPE_META[t].group === g)
                  .map((t) => (
                    <button key={t} type="button" className={"list-row mon-type" + (card.type === t ? " selected" : "")} onClick={() => pickType(t)}>
                      {TYPE_META[t].label}
                    </button>
                  ))}
              </div>
            ))}
          </div>
        )}
        <div className="mon-dlg-main">
          {previewBox}
          {form}
        </div>
      </div>
    </Dialog>
  );
}
