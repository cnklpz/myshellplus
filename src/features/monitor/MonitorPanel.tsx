// Server status dashboard for one host (side panel).
import { AlertTriangle, ArrowDown, ArrowUp, ChartLine, ChevronDown, ChevronRight, Copy, LoaderCircle, Pencil, Plus, RefreshCw, Replace, RotateCcw, Trash2, X } from "lucide-react";
import { Fragment, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bar, Empty, toast, TweenNum } from "../../components/ui";
import { api, errMsg, type Proc, type Sample, type SysInfo } from "../../lib/api";
import { fmtBytes, fmtPct, fmtRate, fmtUptime } from "../../lib/format";
import { onTauriEvent } from "../../lib/events";
import { pctColor } from "../../lib/level";
import { usePrivacy } from "../../lib/privacy";
import { useApp } from "../../store";
import { usePanelItems } from "../side/panelMenu";
import { ContextMenu, type MenuItem, useContextMenu } from "../terminal/ContextMenu";
import { useProcActions } from "./procMenu";
import { copyText } from "../../lib/clipboard";
import { Select } from "../../components/Select";
import { probeHosts, useProbe } from "../home/probe";
import { hideDiscard, hideSlot, showDiscard, showSlot } from "../../lib/dragSlot";
import { CardDialog } from "./CardDialog";
import { AppsCard, type CardCtx, CommandCard, DiskCard, DockerCard, Gauge, GpuCard, Go, isTile, linkProps, MetricCard, NicCard, NoteCard, ServiceCard } from "./CardViews";
import { type CardInst, cardTitle, DEFAULT_INFO_FIELDS, INFO_FIELDS, type InfoField, getCards, isDefaultLayout, moveCard, newUid, placeAfter, removeCard, resetCards, setCards, upsertCard, useCards } from "./cards";
import { type DetailKind, MonitorDetail } from "./MonitorDetail";
import { Sparkline } from "./Sparkline";
import "./monitor.css";

const MAX = 60;

interface MonitorEvent {
  hostId: string;
  sample?: Sample;
  info?: SysInfo | null;
  error?: string;
}

function useMonitor(hostId: string, gen: number) {
  const [history, setHistory] = useState<Sample[]>([]);
  const [info, setInfo] = useState<SysInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    const append = (s: Sample) =>
      setHistory((h) => {
        if (h.length && h[h.length - 1].ts >= s.ts) return h;
        const next = h.length >= MAX ? h.slice(h.length - MAX + 1) : h.slice();
        next.push(s);
        return next;
      });

    const unlisten = onTauriEvent<MonitorEvent>("monitor", (e) => {
      const p = e.payload;
      if (!alive || p.hostId !== hostId) return;
      if (p.error) {
        setError(p.error);
      } else {
        setError(null);
        if (p.info) setInfo(p.info);
        if (p.sample) append(p.sample);
      }
      setLoading(false);
    });

    api
      .monitorSubscribe(hostId)
      .then((snap) => {
        if (!alive) return;
        if (snap.info) setInfo(snap.info);
        if (snap.error) setError(snap.error);
        setHistory((h) => {
          // Merge: events that raced ahead of the snapshot are kept if newer.
          const last = snap.history.length ? snap.history[snap.history.length - 1].ts : 0;
          return [...snap.history, ...h.filter((s) => s.ts > last)].slice(-MAX);
        });
        if (snap.history.length || snap.error) setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(errMsg(e));
        setLoading(false);
      });

    return () => {
      alive = false;
      unlisten();
      api.monitorUnsubscribe(hostId).catch(() => {});
    };
  }, [hostId, gen]);

  return { history, info, error, loading };
}


/** Backend monitor error for a host without an SSH connection (monitors never connect on their own). */
const NOT_CONNECTED = "未连接";

export function MonitorPanel({ hostId }: { hostId: string }) {
  const [gen, setGen] = useState(0);
  const priv = usePrivacy();
  const { history, info, error: rawError } = useMonitor(hostId, gen);
  const error = rawError && priv.hostText(rawError, hostId);
  const cur = history[history.length - 1];
  const retry = () => setGen((g) => g + 1);
  const [detail, setDetail] = useState<DetailKind | null>(null);

  // The backend stops a host's monitor on disconnect: subscribe again once it is connected again.
  const connected = useApp((s) => s.conn[hostId]?.state === "connected");
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) setGen((g) => g + 1);
    wasConnected.current = connected;
  }, [connected]);

  const offline = error === NOT_CONNECTED;
  const connect = () => void api.connConnect(hostId).catch((e) => toast(errMsg(e), "error"));
  const errorAction = offline ? (
    <button className="btn sm" onClick={connect}>连接</button>
  ) : (
    <button className="btn sm" onClick={retry}>
      <RefreshCw /> 重试
    </button>
  );

  if (!cur && offline)
    return (
      <div className="panel-body">
        <Empty text="未连接" action={errorAction} />
      </div>
    );

  if (!cur && error)
    return (
      <div className="panel-body">
        <Empty
          icon={<AlertTriangle />}
          text={<span className="selectable">{error}</span>}
          action={errorAction}
        />
      </div>
    );

  // Before the first sample the same cards render as empty shells, so nothing jumps when data lands.
  const ctx: CardCtx = cur
    ? { hostId, history, cur, info, open: setDetail }
    : { hostId, history: [], cur: EMPTY_SAMPLE, info, open: () => {} };
  return (
    <div className="panel-body">
      <div className="mon">
        {error && (
          <div className="mon-alert">
            <AlertTriangle />
            <span className="grow ellipsis selectable" title={error}>{error}</span>
            <button className="btn ghost sm" onClick={offline ? connect : retry}>{offline ? "连接" : "重试"}</button>
          </div>
        )}
        <Cards hostId={hostId} ctx={ctx} render={(c) => (cur ? renderCard(c, ctx) : renderPending(c, ctx))} />
      </div>
      {detail && (
        <MonitorDetail kind={detail} hostId={hostId} history={history} info={info} onClose={() => setDetail(null)} />
      )}
    </div>
  );
}

/** Renders one card instance; null hides it (e.g. no data for that section on this host). */
function renderCard(c: CardInst, ctx: CardCtx): ReactNode {
  const { hostId, history, cur, info, open } = ctx;
  switch (c.type) {
    case "info":
      return info ? <HostInfo card={c} hostId={hostId} info={info} sample={cur} /> : null;
    case "metric":
      return <MetricCard card={c} ctx={ctx} />;
    case "load":
      return <LoadCard card={c} cur={cur} cores={cur.cores.length || info?.cores || 1} onOpen={() => open("cpu")} />;
    case "cores":
      return cur.cores.length > 1 ? <Cores title={cardTitle(c)} cores={cur.cores} onOpen={() => open("cpu")} /> : null;
    case "net":
      return <NetSection card={c} history={history} cur={cur} onOpen={() => open("net")} />;
    case "nic":
      return <NicCard card={c} ctx={ctx} />;
    case "io":
      return <DiskIoSection title={cardTitle(c)} history={history} cur={cur} onOpen={() => open("io")} />;
    case "disks":
      return cur.disks.length ? <DisksSection title={cardTitle(c)} cur={cur} onOpen={() => open("disk")} /> : null;
    case "disk":
      return <DiskCard card={c} ctx={ctx} />;
    case "procs":
      return <ProcSection card={c} hostId={hostId} procs={cur.procs} onOpen={() => open("proc")} />;
    case "gpu":
      return <GpuCard card={c} ctx={ctx} />;
    case "apps":
      return <AppsCard card={c} ctx={ctx} />;
    case "docker":
      return <DockerCard card={c} ctx={ctx} />;
    case "command":
      return <CommandCard card={c} ctx={ctx} />;
    case "service":
      return <ServiceCard card={c} ctx={ctx} />;
    case "note":
      return <NoteCard card={c} />;
  }
}

const EMPTY_SAMPLE: Sample = {
  ts: 0, cpu: 0, cores: [], memTotal: 0, memUsed: 0, swapTotal: 0, swapUsed: 0, load: [0, 0, 0], uptime: 0,
  rxRate: 0, txRate: 0, readRate: 0, writeRate: 0, tcpConns: 0, nets: [], disks: [], procs: [],
};
const EMPTY_INFO: SysInfo = { os: "", kernel: "", arch: "", hostname: "", cores: 0, cpu: "", ip: "" };
const DASH = <span className="mon-dash">–</span>;

/** Card shell shown before the first sample: same layout, values blank. */
function renderPending(c: CardInst, ctx: CardCtx): ReactNode {
  const title = cardTitle(c);
  switch (c.type) {
    case "info":
      return <HostInfo card={c} hostId={ctx.hostId} info={ctx.info ?? EMPTY_INFO} />;
    case "note":
      return <NoteCard card={c} />;
    case "command":
    case "service":
    case "gpu":
    case "apps":
    case "docker":
      // These poll on their own and don't need a sample.
      return renderCard(c, ctx);
  }
  const view = c.type === "metric" ? c.cfg.view ?? "trend" : c.type === "disk" ? "gauge" : null;
  if (view)
    return (
      <div className={"mon-tile v-" + view}>
        <span className="lbl">
          <span className={"ellipsis" + (c.type === "disk" ? " mono" : "")}>{title}</span>
        </span>
        {view === "gauge" ? (
          <Gauge value={0} max={1} color="var(--fg-2)">{DASH}</Gauge>
        ) : (
          <span className="big">{DASH}</span>
        )}
        {view === "trend" && <Sparkline series={[]} height={28} />}
      </div>
    );
  const rate = c.type === "net" || c.type === "nic" || c.type === "io";
  return (
    <div className="mon-sec">
      <div className={"section-title" + (c.type === "nic" ? " mono" : "")}>{title}</div>
      {rate ? (
        <>
          <div className="mon-rate">
            {c.type === "io" ? <span className="k c2">读</span> : <ArrowDown className="c2" />}
            {DASH}
            {c.type === "io" ? <span className="k c4">写</span> : <ArrowUp className="c1" />}
            {DASH}
          </div>
          <div className="mon-chart">
            <Sparkline series={[]} height={36} />
          </div>
        </>
      ) : (
        <div className="mon-muted">–</div>
      )}
    </div>
  );
}

function HostInfo({ card, hostId, info, sample }: { card: CardInst; hostId: string; info: SysInfo; sample?: Sample }) {
  const priv = usePrivacy();
  const host = useApp((s) => s.hosts.find((h) => h.id === hostId));
  const name = host?.name || info.hostname;
  const latency = useApp((s) => s.latency[hostId]);
  const probe = useProbe(hostId);
  const applied = useRef(probe?.result);
  useEffect(() => {
    // A finished manual test replaces the shown value until the next live ping.
    if (probe?.busy || !probe?.result || probe.result === applied.current) return;
    applied.current = probe.result;
    useApp.getState().setLatency(hostId, probe.result.ms);
  }, [probe, hostId]);
  const tier = latency === null ? "err" : latency === undefined ? "" : latency >= 200 ? "err" : latency >= 60 ? "warn" : "ok";
  const copyIp = () => {
    if (!info.ip) return;
    void copyText(info.ip, " IP");
  };
  const shown = new Set(card.cfg.fields ?? DEFAULT_INFO_FIELDS);
  const root = sample?.disks.find((d) => d.mount === "/") ?? sample?.disks[0];
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

  const cell = (f: InfoField): ReactNode => {
    switch (f) {
      case "hostname":
        return <dd className="ellipsis mono" title={info.hostname}>{info.hostname || "-"}</dd>;
      case "user":
        return (
          <dd className="ellipsis mono">
            {host ? <>{host.username}<span className="sep">:{host.port}</span></> : "-"}
          </dd>
        );
      case "kernel":
        return (
          <dd className="ellipsis" title={`${info.kernel} · ${info.arch}`}>
            {info.kernel || "-"} {info.arch && <><span className="sep">·</span> {info.arch}</>}
          </dd>
        );
      case "cpu":
        return (
          <dd className="ellipsis" title={info.cpu}>
            {info.cores ? <>{info.cores} 核 <span className="sep">· {info.cpu || "-"}</span></> : "-"}
          </dd>
        );
      case "ip":
        return (
          <dd className="mon-ip">
            {info.ip ? (
              <button type="button" className="mon-ip-copy mono ellipsis" title="点击复制" onClick={copyIp}>
                {priv.text(info.ip)}
              </button>
            ) : (
              "-"
            )}
            <button type="button" className={"mon-lat " + tier} title="点击测速" disabled={probe?.busy} onClick={() => probeHosts([hostId])}>
              {probe?.busy ? (
                <LoaderCircle className="spin" />
              ) : latency === undefined ? (
                "测速"
              ) : latency === null ? (
                "超时"
              ) : latency < 1 ? (
                "<1 ms"
              ) : (
                `${Math.round(latency)} ms`
              )}
            </button>
          </dd>
        );
      case "ssh":
        return <SshDuration hostId={hostId} />;
      case "uptime":
        return <dd>{sample ? fmtUptime(sample.uptime) : "-"}</dd>;
      case "load":
        return <dd title="1 / 5 / 15 分钟">{sample ? sample.load.map((l) => l.toFixed(2)).join("  ") : "-"}</dd>;
      case "mem":
        return (
          <dd className="ellipsis">
            {sample?.memTotal ? (
              <>
                <span style={{ color: pctColor(pct(sample.memUsed, sample.memTotal)) }}>{pct(sample.memUsed, sample.memTotal)}%</span>
                <span className="sep"> · {fmtBytes(sample.memUsed)} / {fmtBytes(sample.memTotal)}</span>
              </>
            ) : (
              "-"
            )}
          </dd>
        );
      case "disk":
        return (
          <dd className="ellipsis" title={root?.mount}>
            {root?.total ? (
              <>
                <span style={{ color: pctColor(pct(root.used, root.total)) }}>{pct(root.used, root.total)}%</span>
                <span className="sep"> · {fmtBytes(root.used)} / {fmtBytes(root.total)}</span>
              </>
            ) : (
              "-"
            )}
          </dd>
        );
      case "net":
        return (
          <dd className="ellipsis">
            {sample ? (
              <>
                ↓ {fmtRate(sample.rxRate)} <span className="sep">·</span> ↑ {fmtRate(sample.txRate)}
              </>
            ) : (
              "-"
            )}
          </dd>
        );
      case "tcp":
        return <dd>{sample ? sample.tcpConns : "-"}</dd>;
    }
  };

  return (
    <section className="mon-host selectable">
      {!card.cfg.noHead && (
        <div className="mon-host-title">
          <span className="mon-host-name ellipsis" title={name}>{name || "-"}</span>
          <span className="mon-host-os ellipsis" title={info.os}>{info.os || "-"}</span>
        </div>
      )}
      {shown.size > 0 && (
        <dl className="mon-info">
          {INFO_FIELDS.filter(([f]) => shown.has(f)).map(([f, label]) => (
            <Fragment key={f}>
              <dt>{label}</dt>
              {cell(f)}
            </Fragment>
          ))}
        </dl>
      )}
    </section>
  );
}

/** Time since the SSH connection was established, ticking every second. */
function SshDuration({ hostId }: { hostId: string }) {
  const since = useApp((s) => s.since[hostId]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [since]);
  if (!since) return <dd className="mon-dash">未连接</dd>;
  return (
    <dd title={`连接于 ${new Date(since).toLocaleString("zh-CN", { hour12: false })}`}>
      {fmtDuration(Math.max(0, Math.floor((now - since) / 1000)))}
    </dd>
  );
}

function fmtDuration(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}天 ${h}小时 ${p2(m)}分`;
  if (h > 0) return `${h}小时 ${p2(m)}分 ${p2(s)}秒`;
  return `${m}分 ${p2(s)}秒`;
}

function LoadCard({ card, cur, cores, onOpen }: { card: CardInst; cur: Sample; cores: number; onOpen: () => void }) {
  const title = cardTitle(card);
  return (
    <div className={"mon-sec link" + (card.size === "s" ? " mon-load-s" : "")} {...linkProps(onOpen)}>
      <div className="section-title">
        {title}
        <Go />
        <span className="meta">{cores} 核</span>
      </div>
      <div className="mon-load">
        {(["1 分钟", "5 分钟", "15 分钟"] as const).map((l, i) => {
          const pct = (cur.load[i] / cores) * 100;
          return (
            <div key={l}>
              <span className="lbl">{l}</span>
              <span className="val" style={{ color: pctColor(pct) }}>{cur.load[i].toFixed(2)}</span>
              <Bar value={pct} thin />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface DragState {
  uid: string;
  pointer: number;
  sx: number;
  sy: number;
  x: number;
  y: number;
  grabX: number;
  grabY: number;
  active: boolean;
  /** Text areas need a short hold first, so a plain drag there still selects text. */
  armed: boolean;
  holdTimer: number;
  /** Last card swapped with; ignored until the pointer leaves it, so big/small pairs don't flip-flop. */
  lastTarget: string | null;
  frame: number;
  scroll: number;
  /** Card that preceded the dragged one before the drag (null = first), for cancel / undo. */
  prevAfter: string | null;
  /** Pointer left the panel: the card is back home and a red "放弃" copy follows the pointer. */
  out: boolean;
}

const FLIP_MS = 200;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** Reorderable card list: drag to sort; right-click to edit, duplicate, remove or add. */
function Cards({ hostId, ctx, render }: { hostId: string; ctx: CardCtx; render: (c: CardInst) => ReactNode }) {
  const all = useCards();
  const ref = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLDivElement>());
  const [dragId, setDragId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; uid: string | null } | null>(null);
  const [dialog, setDialog] = useState<{ card?: CardInst; before?: string; replace?: CardInst } | null>(null);
  const drag = useRef<DragState | null>(null);
  /** Card rects captured just before a reorder, consumed by the FLIP layout effect. */
  const flip = useRef<Map<string, DOMRect> | null>(null);
  const swallowClick = useRef(false);

  const cardAt = (el: Element | null) => el?.closest<HTMLElement>("[data-card]") ?? null;

  const snapshot = () => {
    const rects = new Map<string, DOMRect>();
    els.current.forEach((el, uid) => rects.set(uid, el.getBoundingClientRect()));
    flip.current = rects;
  };

  /** Keep the dragged card under the pointer: offset from its layout slot to the pointer. */
  const place = () => {
    const d = drag.current;
    const box = ref.current;
    const el = d?.active ? els.current.get(d.uid) : undefined;
    if (!d || !box || !el || d.out) return;
    const r = box.getBoundingClientRect();
    // Stay inside the panel: the panel clips its content, so a card pulled past the edge would vanish.
    const view = box.closest<HTMLElement>(".panel-body")?.getBoundingClientRect() ?? r;
    const x = Math.max(r.left, Math.min(d.x - d.grabX, r.right - el.offsetWidth));
    const y = Math.max(view.top, Math.min(d.y - d.grabY, view.bottom - el.offsetHeight));
    const tx = x - (r.left + el.offsetLeft);
    const ty = y - (r.top + el.offsetTop);
    el.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(1.02)`;
    showSlot(el);
  };

  const hitTest = () => {
    const d = drag.current;
    if (!d?.active || d.out) return;
    const over = document
      .elementsFromPoint(d.x, d.y)
      .map(cardAt)
      .find((c) => c && c.dataset.card !== d.uid && ref.current?.contains(c));
    const target = over?.dataset.card ?? null;
    if (!target) {
      d.lastTarget = null;
      return;
    }
    if (target === d.lastTarget) return;
    d.lastTarget = target;
    const order = getCards();
    const from = order.findIndex((c) => c.uid === d.uid);
    const to = order.findIndex((c) => c.uid === target);
    snapshot();
    if (!moveCard(d.uid, target, to > from)) flip.current = null;
  };

  // FLIP: cards that moved slide from their old spot; the dragged card stays glued to the pointer.
  useLayoutEffect(() => {
    const rects = flip.current;
    flip.current = null;
    if (!rects) return;
    const dragging = drag.current?.active ? drag.current.uid : null;
    els.current.forEach((el, uid) => {
      if (uid === dragging) return;
      const old = rects.get(uid);
      if (!old) return;
      el.style.transition = "none";
      el.style.transform = "";
      const now = el.getBoundingClientRect();
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if (!dx && !dy) return;
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      void el.offsetWidth;
      el.style.transition = `transform ${FLIP_MS}ms ${EASE}`;
      el.style.transform = "";
    });
    place();
  }, [all]); // eslint-disable-line react-hooks/exhaustive-deps

  const autoScroll = () => {
    const d = drag.current;
    if (!d?.active) return;
    const scroller = ref.current?.closest<HTMLElement>(".panel-body");
    if (scroller && !d.out) {
      const r = scroller.getBoundingClientRect();
      const edge = 48;
      const dy = d.y < r.top + edge ? d.y - (r.top + edge) : d.y > r.bottom - edge ? d.y - (r.bottom - edge) : 0;
      if (dy) {
        const before = scroller.scrollTop;
        scroller.scrollTop += Math.max(-18, Math.min(18, dy / 2.5));
        if (scroller.scrollTop !== before) {
          place();
          hitTest();
        }
      }
    }
    d.scroll = requestAnimationFrame(autoScroll);
  };

  const activate = () => {
    const d = drag.current;
    const el = d && els.current.get(d.uid);
    if (!d || !el) return;
    const r = el.getBoundingClientRect();
    d.active = true;
    d.grabX = d.sx - r.left;
    d.grabY = d.sy - r.top;
    const order = getCards();
    const i = order.findIndex((c) => c.uid === d.uid);
    d.prevAfter = i > 0 ? order[i - 1].uid : null;
    el.style.transition = "none";
    try {
      ref.current?.setPointerCapture(d.pointer);
    } catch {
      /* pointer already gone */
    }
    window.getSelection()?.removeAllRanges();
    document.body.classList.add("mon-dragging");
    setDragId(d.uid);
    place();
    d.scroll = requestAnimationFrame(autoScroll);
  };

  const finish = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    window.clearTimeout(d.holdTimer);
    if (!d.active) return;
    cancelAnimationFrame(d.frame);
    cancelAnimationFrame(d.scroll);
    document.body.classList.remove("mon-dragging");
    hideSlot();
    hideDiscard();
    if (d.out) commit = false;
    const uid = d.uid;
    const order = getCards();
    const i = order.findIndex((c) => c.uid === uid);
    const moved = (i > 0 ? order[i - 1].uid : null) !== d.prevAfter;
    if (!commit && moved) {
      snapshot();
      placeAfter(uid, d.prevAfter);
    }
    // Settle the dropped card into its slot.
    const el = els.current.get(uid);
    if (el) {
      el.style.transition = `transform ${FLIP_MS}ms ${EASE}`;
      el.style.transform = "";
    }
    setDragId(null);
    swallowClick.current = true;
    window.setTimeout(() => (swallowClick.current = false), 0);
    if (commit && moved) {
      const prev = d.prevAfter;
      toast("已调整卡片顺序", "success", { label: "撤回", run: () => placeAfter(uid, prev) });
    }
  };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && drag.current?.active) {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      finish(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: ReactPointerEvent) => {
    const t = e.target as Element;
    // Portaled dialogs / menus of a card still bubble here through React: only drag from the cards' own DOM.
    if (e.defaultPrevented || !ref.current?.contains(t)) return;
    if (e.button !== 0 || t.closest("button, input, select, textarea, a")) return;
    const card = cardAt(t);
    if (!card) return;
    finish(false);
    const needHold = !!t.closest(".selectable");
    const d: DragState = {
      uid: card.dataset.card!,
      pointer: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      x: e.clientX,
      y: e.clientY,
      grabX: 0,
      grabY: 0,
      active: false,
      armed: !needHold,
      holdTimer: 0,
      lastTarget: null,
      frame: 0,
      scroll: 0,
      prevAfter: null,
      out: false,
    };
    if (needHold)
      d.holdTimer = window.setTimeout(() => {
        if (drag.current !== d) return;
        d.armed = true;
        activate();
      }, 300);
    drag.current = d;
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.active) {
      if (Math.hypot(d.x - d.sx, d.y - d.sy) < 5) return;
      if (!d.armed) {
        // Moved before the hold finished: this is a text selection, not a drag.
        window.clearTimeout(d.holdTimer);
        drag.current = null;
        return;
      }
      activate();
    }
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      const el = els.current.get(d.uid);
      const panel = ref.current?.closest<HTMLElement>(".panel-body")?.getBoundingClientRect();
      const out = !panel || d.x < panel.left || d.x > panel.right || d.y < panel.top || d.y > panel.bottom;
      if (out !== d.out) {
        d.out = out;
        if (out) {
          // Left the panel: put the card back where it started, a red copy follows the pointer.
          hideSlot();
          if (el) {
            showDiscard(el, d.x - d.grabX, d.y - d.grabY, "mon mon-cards");
            el.style.transition = `transform ${FLIP_MS}ms ${EASE}`;
            el.style.transform = "";
          }
          d.lastTarget = null;
          snapshot();
          placeAfter(d.uid, d.prevAfter);
        } else {
          hideDiscard();
          if (el) el.style.transition = "none";
        }
      }
      if (d.out) {
        if (el) showDiscard(el, d.x - d.grabX, d.y - d.grabY, "mon mon-cards");
        return;
      }
      place();
      hitTest();
    });
  };

  const panelExtra = usePanelItems();
  const visible = all.filter((c) => !c.host || c.host === hostId);
  const cards = visible.map((c) => [c, render(c)] as const).filter(([, node]) => node);
  const menuCard = menu?.uid ? all.find((c) => c.uid === menu.uid) : undefined;
  const nextOf = (uid: string) => all[all.findIndex((c) => c.uid === uid) + 1]?.uid;

  const remove = (c: CardInst) => {
    const before = nextOf(c.uid);
    removeCard(c.uid);
    toast(`已移除「${cardTitle(c)}」`, "success", { label: "撤回", run: () => upsertCard(c, before) });
  };
  const reset = () => {
    const prev = getCards();
    resetCards();
    toast("已恢复默认卡片", "success", { label: "撤回", run: () => setCards(prev) });
  };

  const items: MenuItem[] = [
    menuCard && { label: "编辑…", icon: <Pencil />, onSelect: () => setDialog({ card: menuCard }) },
    menuCard && { label: "替换…", icon: <Replace />, onSelect: () => setDialog({ replace: menuCard }) },
    menuCard && { label: "复制", icon: <Copy />, onSelect: () => upsertCard({ ...menuCard, uid: newUid() }, nextOf(menuCard.uid)) },
    menuCard && { label: "移除", icon: <Trash2 />, onSelect: () => remove(menuCard) },
    menuCard && "sep",
    { label: "添加卡片…", icon: <Plus />, onSelect: () => setDialog({ before: menuCard ? nextOf(menuCard.uid) : undefined }) },
    { label: "恢复默认", icon: <RotateCcw />, disabled: isDefaultLayout(all), onSelect: reset },
    ...panelExtra(),
  ];

  return (
    <>
      <div
        ref={ref}
        className={"mon-cards" + (dragId ? " sorting" : "")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => finish(true)}
        onPointerCancel={() => finish(false)}
        onLostPointerCapture={() => drag.current?.active && finish(true)}
        onClickCapture={(e) => {
          if (swallowClick.current) {
            e.stopPropagation();
            e.preventDefault();
          }
        }}
        onContextMenu={(e) => {
          if (e.defaultPrevented || !ref.current?.contains(e.target as Node)) return;
          e.preventDefault();
          finish(false);
          setMenu({ x: e.clientX, y: e.clientY, uid: cardAt(e.target as Element)?.dataset.card ?? null });
        }}
      >
        {cards.map(([c, node]) => (
          <div
            key={c.uid}
            data-card={c.uid}
            ref={(el) => {
              if (el) els.current.set(c.uid, el);
              else els.current.delete(c.uid);
            }}
            className={"mon-card size-" + c.size + (isTile(c) ? " tile" : "") + (dragId === c.uid ? " dragging" : "")}
          >
            {node}
          </div>
        ))}
        {cards.length === 0 && <Empty sm className="mon-cards-empty" text="暂无卡片" />}
      </div>
      <div className="mon-reset">
        <button className="btn sm" onClick={() => setDialog({})}>
          添加卡片
        </button>
        <button className="btn sm ghost" disabled={isDefaultLayout(all)} onClick={reset}>
          恢复默认
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {dialog && (
        <CardDialog
          initial={dialog.card}
          replace={dialog.replace}
          hostId={hostId}
          ctx={ctx}
          render={render}
          onClose={() => setDialog(null)}
          onSave={(c) => {
            upsertCard(c, dialog.before);
            setDialog(null);
          }}
        />
      )}
    </>
  );
}

const fmt0 = (v: number) => v.toFixed(0);
const fmtPct0 = (v: number) => `${v.toFixed(0)}%`;

function Cores({ title, cores, onOpen }: { title: string; cores: number[]; onOpen: () => void }) {
  return (
    <div className="mon-sec link" {...linkProps(onOpen)}>
      <div className="section-title">
        {title} <span className="count">{cores.length}</span>
        <Go />
      </div>
      <div className="mon-cores">
        {cores.map((c, i) => (
          <div className="mon-core" key={i} title={`CPU${i}: ${fmtPct(c, 1)}`}>
            <i className={c >= 90 ? "err" : c >= 75 ? "warn" : ""} style={{ height: `${Math.max(0, Math.min(100, c))}%` }} />
            <TweenNum value={c} fmt={fmt0} />
          </div>
        ))}
      </div>
    </div>
  );
}

function NetSection({ card, history, cur, onOpen }: { card: CardInst; history: Sample[]; cur: Sample; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const menu = useContextMenu();
  const nic = card.cfg.nic && cur.nets.some((n) => n.name === card.cfg.nic) ? card.cfg.nic : "";
  const pick = (name: string) => upsertCard({ ...card, cfg: { ...card.cfg, nic: name || undefined } });
  const rateOf = (s: Sample, k: "rxRate" | "txRate") => (nic ? s.nets.find((n) => n.name === nic)?.[k] ?? 0 : s[k]);
  const rx = useMemo(() => history.map((s) => rateOf(s, "rxRate")), [history, nic]); // eslint-disable-line react-hooks/exhaustive-deps
  const tx = useMemo(() => history.map((s) => rateOf(s, "txRate")), [history, nic]); // eslint-disable-line react-hooks/exhaustive-deps
  const nicMenu = (e: ReactMouseEvent, name: string) =>
    menu.open(e, [
      { label: nic === name ? "折线图显示全部" : "在折线图显示", icon: <ChartLine />, onSelect: () => pick(nic === name ? "" : name) },
      { label: "复制名称", icon: <Copy />, onSelect: () => copyText(name, "名称") },
    ]);
  return (
    <div className="mon-sec link" {...linkProps(onOpen)}>
      <div className="section-title">
        {cardTitle(card)}
        <Go />
        {cur.nets.length > 1 ? (
          <span className="mon-nic-pick" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Select
              size="sm"
              width={112}
              value={nic}
              options={[{ value: "", label: "全部网卡" }, ...cur.nets.map((n) => ({ value: n.name, label: n.name }))]}
              onChange={pick}
            />
          </span>
        ) : (
          <span className="meta">TCP {cur.tcpConns}</span>
        )}
      </div>
      <div className="mon-rate">
        <ArrowDown className="c2" />
        <TweenNum className="ellipsis" title="下行" value={rateOf(cur, "rxRate")} fmt={fmtRate} />
        <ArrowUp className="c1" />
        <TweenNum className="ellipsis" title="上行" value={rateOf(cur, "txRate")} fmt={fmtRate} />
      </div>
      <div className="mon-chart">
        <Sparkline
          series={[
            { values: rx, color: "var(--chart-2)" },
            { values: tx, color: "var(--chart-1)" },
          ]}
          floor={1024}
          height={40}
        />
      </div>
      {cur.nets.length > 0 && (
        <>
          <div
            className="list-row mon-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!open);
            }}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
            <span className="grow">
              网卡 <span className="count">{cur.nets.length}</span>
            </span>
          </div>
          {open && (
            <div>
              <div className="mon-grid-row head">
                <span>名称</span>
                <span className="num">下行</span>
                <span className="num">上行</span>
              </div>
              {cur.nets.map((n) => (
                <div
                  className={"mon-grid-row" + (n.name === nic ? " on" : "")}
                  key={n.name}
                  title={`累计 ↓${fmtBytes(n.rxTotal)} ↑${fmtBytes(n.txTotal)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    pick(nic === n.name ? "" : n.name);
                  }}
                  onContextMenu={(e) => nicMenu(e, n.name)}
                >
                  <span className="ellipsis mono">{n.name}</span>
                  <span className="num">{fmtRate(n.rxRate)}</span>
                  <span className="num">{fmtRate(n.txRate)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {menu.node}
    </div>
  );
}

function DiskIoSection({ title, history, cur, onOpen }: { title: string; history: Sample[]; cur: Sample; onOpen: () => void }) {
  const rd = useMemo(() => history.map((s) => s.readRate), [history]);
  const wr = useMemo(() => history.map((s) => s.writeRate), [history]);
  return (
    <div className="mon-sec link" {...linkProps(onOpen)}>
      <div className="section-title">
        {title}
        <Go />
      </div>
      <div className="mon-rate">
        <span className="k c2">读</span>
        <TweenNum className="ellipsis" value={cur.readRate} fmt={fmtRate} />
        <span className="k c4">写</span>
        <TweenNum className="ellipsis" value={cur.writeRate} fmt={fmtRate} />
      </div>
      <div className="mon-chart">
        <Sparkline
          series={[
            { values: rd, color: "var(--chart-2)" },
            { values: wr, color: "var(--chart-4)" },
          ]}
          floor={4096}
          height={40}
        />
      </div>
    </div>
  );
}

function DisksSection({ title, cur, onOpen }: { title: string; cur: Sample; onOpen: () => void }) {
  if (!cur.disks.length) return null;
  return (
    <div className="mon-sec link" {...linkProps(onOpen)}>
      <div className="section-title">
        {title}
        <Go />
      </div>
      <div>
        {cur.disks.map((d) => {
          const pct = d.total ? (d.used / d.total) * 100 : 0;
          return (
            <div className="mon-disk" key={d.mount + d.fs} title={d.fs}>
              <div className="mon-disk-head">
                <span className="ellipsis mono">{d.mount}</span>
                <span className="size">
                  {fmtBytes(d.used)} / {fmtBytes(d.total)}
                </span>
                <TweenNum className="pct" style={{ color: pctColor(pct) }} value={pct} fmt={fmtPct0} />
              </div>
              <Bar value={d.used} max={d.total || 1} thin />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProcSection({ card, hostId, procs, onOpen }: { card: CardInst; hostId: string; procs: Proc[]; onOpen: () => void }) {
  const [killed, setKilled] = useState<Set<number>>(new Set());
  const menu = useContextMenu();
  const acts = useProcActions(
    hostId,
    useCallback((pid: number, sig: string) => {
      if (sig === "TERM" || sig === "KILL") setKilled((k) => new Set(k).add(pid));
    }, []),
  );

  // Forget optimistic hides once the process is really gone from the latest sample.
  useEffect(() => {
    setKilled((k) => {
      if (k.size === 0) return k;
      const live = new Set(procs.map((p) => p.pid));
      const next = new Set([...k].filter((p) => live.has(p)));
      return next.size === k.size ? k : next;
    });
  }, [procs]);

  const { limit = 10, sort = "cpu", filter = "" } = card.cfg;
  const q = filter.trim().toLowerCase();
  const rows = procs
    .filter((p) => !killed.has(p.pid) && (!q || p.command.toLowerCase().includes(q) || p.user.toLowerCase().includes(q)))
    .sort((a, b) => (sort === "mem" ? b.rss - a.rss : b.cpu - a.cpu))
    .slice(0, limit);
  return (
    <div className="mon-sec">
      <div className="section-title link" {...linkProps(onOpen)}>
        {cardTitle(card)} <span className="count">{rows.length}</span>
        <Go />
      </div>
      <table className="table mon-procs">
        <colgroup>
          <col className="mon-w-60" />
          <col className="mon-w-64" />
          <col className="mon-w-48" />
          <col className="mon-w-64" />
          <col />
          <col className="mon-w-28" />
        </colgroup>
        <thead>
          <tr>
            <th className="num">PID</th>
            <th>用户</th>
            <th className="num">CPU</th>
            <th className="num">内存</th>
            <th>命令</th>
            <th className="act" />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.pid} onContextMenu={(e) => menu.open(e, acts.items(p))}>
              <td className="num mono pid">{p.pid}</td>
              <td className="user" title={p.user}>{p.user}</td>
              <td className={"num" + (p.cpu >= 90 ? " cpu-err" : p.cpu >= 75 ? " cpu-warn" : "")}>{p.cpu.toFixed(1)}</td>
              <td className="num" title={fmtPct(p.mem, 1)}>{fmtBytes(p.rss, 0)}</td>
              <td className="cmd mono" title={p.command}>{p.command}</td>
              <td className="act">
                <button className="icon-btn sm danger hover-reveal" title="结束进程" onClick={() => acts.confirmKill(p)}>
                  <X />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {menu.node}
      {acts.node}
    </div>
  );
}
