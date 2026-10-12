// Visual renderings of read-only tool output. Each parser returns null when the text isn't what it expects,
// and the output falls back to raw text.
import { Fragment, type ReactNode } from "react";
import { Bar } from "../../components/ui";
import { pctColor } from "../../lib/level";
import { usePrivacy } from "../../lib/privacy";

type View = (stdout: string) => ReactNode | null;

const lines = (s: string) => s.split("\n").map((l) => l.trimEnd()).filter(Boolean);
const words = (l: string) => l.trim().split(/\s+/);

/** "== Title ==" sections. */
function sections(s: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur = "";
  for (const l of s.split("\n")) {
    const m = /^== (.+) ==$/.exec(l.trim());
    if (m) out[(cur = m[1])] = [];
    else if (l.trim() && cur) out[cur].push(l.trimEnd());
  }
  return out;
}
const sec = (all: Record<string, string[]>, prefix: string) => Object.entries(all).find(([k]) => k.startsWith(prefix))?.[1] ?? [];

/** "12G" / "1.5M" / "512K" / "0" → bytes. */
function bytes(s: string): number {
  const m = /^([\d.]+)([KMGTPE]?)i?B?$/i.exec(s.replace(",", "."));
  if (!m) return NaN;
  return +m[1] * 1024 ** " KMGTPE".indexOf((m[2] || " ").toUpperCase());
}

const ANY = new Set(["0.0.0.0", "*", "::", "[::]", ""]);

function Section(props: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="tv-sec">
      <div className="section-title">
        <span className="ellipsis">{props.title}</span>
        {props.extra && <span className="meta">{props.extra}</span>}
      </div>
      {props.children}
    </div>
  );
}

function Stat(props: { label: string; value: ReactNode; tone?: "ok" | "warn" | "err" }) {
  return (
    <div className="tv-stat">
      <span className="tv-stat-label">{props.label}</span>
      <span className={"tv-stat-value" + (props.tone ? " " + props.tone : "")}>{props.value}</span>
    </div>
  );
}

/** Count bars (uniq -c output). */
function CountBars(props: { rows: { key: string; n: number }[]; unit: string }) {
  const max = Math.max(...props.rows.map((r) => r.n), 1);
  return (
    <div className="tv-bars">
      {props.rows.map((r) => (
        <div key={r.key} className="tv-bar-row">
          <span className="mono ellipsis" title={r.key}>{r.key}</span>
          <Bar value={r.n} max={max} />
          <span className="num">{r.n} {props.unit}</span>
        </div>
      ))}
    </div>
  );
}

const uniqC = (ls: string[]) =>
  ls.map((l) => /^\s*(\d+)\s+(\S+)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ key: m[2], n: +m[1] }));

// ---------- 磁盘分区 ----------
const disks: View = (s) => {
  const ls = lines(s);
  // df -P: the header has a "%" column; mount point is everything after it.
  const hi = ls.findIndex((l) => /%/.test(l) && !/\d%/.test(l));
  if (hi < 0) return null;
  const pi = words(ls[hi]).findIndex((w) => w.endsWith("%"));
  if (pi < 3) return null;
  const mounts = ls
    .slice(hi + 1)
    .map(words)
    .filter((w) => w.length > pi && /^\d+%$/.test(w[pi]))
    .map((w) => ({ fs: w[0], type: pi >= 5 ? w[1] : "", size: w[pi - 3], used: w[pi - 2], avail: w[pi - 1], pct: parseInt(w[pi]), mount: w.slice(pi + 1).join(" ") }));
  if (!mounts.length) return null;
  // lsblk: top-level disks and their partition count.
  const devs: { name: string; size: string; parts: number }[] = [];
  for (const l of ls.slice(0, hi)) {
    const w = words(l);
    if (w[2] === "disk") devs.push({ name: w[0], size: w[1], parts: 0 });
    else if (w[2] === "part" && devs.length) devs[devs.length - 1].parts++;
  }
  return (
    <>
      <Section title="挂载点">
        <div className="tv-grid tv-df">
          {mounts.map((m) => (
            <div key={m.mount + m.fs} className="tv-row" title={m.fs}>
              <span className="mono ellipsis">{m.mount}</span>
              <span className="faint ellipsis">{m.type}</span>
              <Bar value={m.pct} />
              <span className="num">{m.used} / {m.size}</span>
              <span className="num" style={{ color: pctColor(m.pct) }}>{m.pct}%</span>
            </div>
          ))}
        </div>
      </Section>
      {devs.length > 0 && (
        <Section title="磁盘">
          <div className="tv-grid tv-kv3">
            {devs.map((d) => (
              <div key={d.name} className="tv-row">
                <span className="mono">{d.name}</span>
                <span className="faint">{d.parts ? `${d.parts} 个分区` : "未分区"}</span>
                <span className="num">{d.size}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
};

// ---------- 目录占用 ----------
const du: View = (s) => {
  const rows = lines(s)
    .map((l) => /^(\S+)\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && !isNaN(bytes(m[1])))
    .map((m) => ({ size: m[1], b: bytes(m[1]), path: m[2] }));
  if (!rows.length) return null;
  // sort -rh puts the directory itself (the total) first.
  const total = rows.reduce((a, r) => (r.path.length < a.path.length ? r : a));
  const items = rows.filter((r) => r !== total);
  const base = total.path.replace(/\/$/, "");
  return (
    <Section title={total.path} extra={`共 ${total.size}`}>
      <div className="tv-bars">
        {items.map((r) => (
          <div key={r.path} className="tv-bar-row">
            <span className="mono ellipsis" title={r.path}>{r.path.startsWith(base + "/") ? r.path.slice(base.length + 1) : r.path}</span>
            <Bar value={r.b} max={total.b || 1} />
            <span className="num">{r.size}</span>
          </div>
        ))}
      </div>
    </Section>
  );
};

// ---------- 连通测试 ----------
const ping: View = (s) => {
  const head = /^PING\s+(\S+)\s+\(([^)]+)\)/m.exec(s);
  const replies = new Map<number, { ms: number; ttl: string }>();
  for (const m of s.matchAll(/(?:icmp_seq|seq)=(\d+).*?ttl=(\d+).*?time[=<]([\d.]+)\s*ms/g)) replies.set(+m[1], { ms: +m[3], ttl: m[2] });
  const sent = /(\d+) packets transmitted/.exec(s);
  const loss = /([\d.]+)% packet loss/.exec(s);
  const rtt = /=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(s);
  if (!head && !sent) return null;
  const n = sent ? +sent[1] : replies.size;
  const seqs = [...replies.keys()];
  const first = seqs.length ? Math.min(...seqs) : 1;
  const max = Math.max(...[...replies.values()].map((r) => r.ms), 1);
  const lossPct = loss ? +loss[1] : n ? ((n - replies.size) / n) * 100 : 100;
  return (
    <>
      <div className="tv-stats">
        <Stat label="目标" value={<span className="mono">{head ? (head[1] === head[2] ? head[1] : head[2]) : "-"}</span>} />
        <Stat label="丢包" value={`${+lossPct.toFixed(1)}%`} tone={lossPct === 0 ? "ok" : lossPct < 50 ? "warn" : "err"} />
        <Stat label="平均" value={rtt ? `${rtt[2]} ms` : "-"} />
        <Stat label="最小 / 最大" value={rtt ? `${rtt[1]} / ${rtt[3]}` : "-"} />
      </div>
      {n > 0 && (
        <div className="tv-bars">
          {Array.from({ length: n }, (_, i) => {
            const r = replies.get(first + i);
            return (
              <div key={i} className="tv-bar-row">
                <span className="faint tv-num-l">#{first + i}</span>
                {r ? <Bar value={r.ms} max={max} /> : <span className="tv-lost" />}
                <span className={"num" + (r ? "" : " tv-err")}>{r ? `${r.ms} ms` : "超时"}</span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
};

// ---------- 端口监听 ----------
const ports: View = (s) => {
  const ls = lines(s);
  const ss = /^Netid\b/.test(ls[0] ?? "");
  type P = { proto: string; port: number; addrs: Set<string>; procs: Set<string> };
  const map = new Map<string, P>();
  for (const l of ls) {
    const w = words(l);
    let proto: string, local: string, procs: string[];
    if (ss) {
      if (!/^(tcp|udp)/.test(w[0]) || w.length < 6) continue;
      proto = w[0];
      local = w[4];
      procs = [...l.matchAll(/\("([^"]+)",pid=\d+/g)].map((m) => m[1]);
    } else {
      if (!/^(tcp|udp)/.test(w[0]) || w.length < 6) continue;
      proto = w[0].replace(/6$/, "");
      local = w[3];
      const last = w[w.length - 1];
      procs = last.includes("/") ? [last.split("/").slice(1).join("/")] : [];
    }
    const i = local.lastIndexOf(":");
    const port = parseInt(local.slice(i + 1));
    if (isNaN(port)) continue;
    const addr = local.slice(0, i).replace(/%.*$/, "");
    const key = `${proto}/${port}/${procs.join(",")}`;
    const p = map.get(key) ?? { proto, port, addrs: new Set(), procs: new Set(procs) };
    p.addrs.add(ANY.has(addr) ? "全部" : addr.replace(/^\[|\]$/g, ""));
    map.set(key, p);
  }
  const list = [...map.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
  if (!list.length) return null;
  return (
    <table className="table tv-table">
      <thead>
        <tr>
          <th className="num">端口</th>
          <th>协议</th>
          <th>进程</th>
          <th>监听地址</th>
        </tr>
      </thead>
      <tbody>
        {list.map((p) => {
          const addrs = p.addrs.has("全部") ? ["全部"] : [...p.addrs];
          const local = addrs.every((a) => a === "127.0.0.1" || a === "::1" || a.startsWith("127."));
          return (
            <tr key={`${p.proto}/${p.port}/${[...p.procs]}`}>
              <td className="num mono">{p.port}</td>
              <td className="faint">{p.proto}</td>
              <td>{[...p.procs].join(", ") || <span className="faint">-</span>}</td>
              <td className={"mono ellipsis" + (local ? " faint" : "")}>{addrs.join(", ")}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

// ---------- 用户列表 ----------
const users: View = (s) => {
  const rows = lines(s)
    .slice(1)
    .map(words)
    .filter((w) => w.length >= 3 && /^\d+$/.test(w[1]))
    .map((w) => ({ name: w[0], uid: w[1], admin: w.length >= 4 && w[2] === "是", shell: w[w.length - 1] }));
  if (!rows.length) return null;
  return (
    <table className="table tv-table">
      <thead>
        <tr>
          <th>用户</th>
          <th className="num">UID</th>
          <th>权限</th>
          <th>Shell</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((u) => {
          const nologin = /nologin|false$/.test(u.shell);
          return (
            <tr key={u.name}>
              <td className="mono">{u.name}</td>
              <td className="num">{u.uid}</td>
              <td className={u.admin ? "" : "faint"}>{u.admin ? "管理员" : "普通"}</td>
              <td className={"mono" + (nologin ? " faint" : "")}>{nologin ? "禁止登录" : u.shell}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

// ---------- 登录记录 ----------
const logins: View = (s) => {
  const all = sections(s);
  const recent = sec(all, "最近登录")
    .filter((l) => !/^(wtmp|btmp|reboot|无记录)/.test(l))
    .map(words)
    .filter((w) => w.length >= 4)
    .map((w) => {
      const host = w[w.length - 1];
      const live = /still logged in/.test(w.join(" "));
      return { user: w[0], tty: w[1], host: /^[\d.:a-fA-F]+$/.test(host) || host.includes(".") ? host : "", time: w.slice(2, 6).join(" "), live };
    });
  const failed = uniqC(sec(all, "失败"));
  if (!recent.length && !Object.keys(all).length) return null;
  return (
    <>
      <Section title="最近登录">
        {recent.length ? (
          <div className="tv-grid tv-login">
            {recent.map((r, i) => (
              <div key={i} className="tv-row">
                <span className={"dot" + (r.live ? " ok" : "")} title={r.live ? "在线" : undefined} />
                <span className="mono ellipsis">{r.user}</span>
                <span className="mono ellipsis faint">{r.host || r.tty}</span>
                <span className="num ellipsis faint">{r.time}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="faint">无记录</div>
        )}
      </Section>
      <Section title="登录失败" extra={failed.length ? `${failed.reduce((a, r) => a + r.n, 0)} 次` : undefined}>
        {failed.length ? <CountBars rows={failed} unit="次" /> : <div className="faint">无失败记录</div>}
      </Section>
    </>
  );
};

// ---------- 当前连接 ----------
const conns: View = (s) => {
  const all = sections(s);
  if (!Object.keys(all).length) return null;
  const who = sec(all, "登录会话").map((l) => {
    const w = words(l);
    const from = /\(([^)]*)\)\s*$/.exec(l)?.[1] ?? "";
    return { user: w[0], tty: w[1], time: w.slice(2).join(" ").replace(/\s*\([^)]*\)\s*$/, ""), from };
  });
  const top = uniqC(sec(all, "连接数"));
  return (
    <>
      <Section title="登录会话" extra={who.length ? `${who.length} 个` : undefined}>
        {who.length ? (
          <div className="tv-grid tv-login">
            {who.map((r, i) => (
              <div key={i} className="tv-row">
                <span className="dot ok" />
                <span className="mono ellipsis">{r.user}</span>
                <span className="mono ellipsis faint">{r.from || r.tty}</span>
                <span className="num ellipsis faint">{r.time}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="faint">无</div>
        )}
      </Section>
      <Section title="连接来源" extra={top.length ? `${top.reduce((a, r) => a + r.n, 0)} 个连接` : undefined}>
        {top.length ? <CountBars rows={top} unit="个" /> : <div className="faint">无</div>}
      </Section>
    </>
  );
};

// ---------- 公网 IP ----------
const ipinfo: View = (s) => {
  const all = sections(s);
  const v4 = sec(all, "IPv4").join("\n");
  const v6 = sec(all, "IPv6")[0] ?? "";
  let j: Record<string, string> = {};
  try {
    j = JSON.parse(v4);
  } catch {
    if (!/^[\d.]+$/.test(v4.trim())) j = {};
    else j = { ip: v4.trim() };
  }
  if (!j.ip && !/[:\da-f]{4,}/i.test(v6)) return null;
  const place = [j.city, j.region, j.country].filter((x, i, a) => x && a.indexOf(x) === i).join(", ");
  const rows: [string, string | undefined][] = [
    ["IPv4", j.ip ?? "获取失败"],
    ["IPv6", /^[\da-f:]+$/i.test(v6.trim()) ? v6.trim() : "无"],
    ["位置", place],
    ["运营商", j.org],
    ["时区", j.timezone],
    ["主机名", j.hostname],
  ];
  return (
    <div className="kv loose">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <Fragment key={k}>
            <span>{k}</span>
            <span className={"selectable" + (k.startsWith("IP") ? " mono" : "")}>
              {k.startsWith("IP") || k === "主机名" ? <PrivAddr addr={v!} /> : v}
            </span>
          </Fragment>
        ))}
    </div>
  );
};

/** An address shown masked in privacy mode (views are plain functions, so the hook lives here). */
function PrivAddr(props: { addr: string }) {
  const priv = usePrivacy();
  return <>{/^(获取失败|无)$/.test(props.addr) ? props.addr : priv.addr(props.addr)}</>;
}

// ---------- 防火墙 ----------
const ACTION: Record<string, string> = { ALLOW: "放行", DENY: "拒绝", REJECT: "拒绝", LIMIT: "限速" };
const firewall: View = (s) => {
  const st = /^Status:\s*(\S+)/m.exec(s);
  if (st) return ufwView(s, st[1] === "active");
  // firewalld: "--list-ports" then "--list-services" are the last two lines.
  const ls = lines(s).filter((l) => !/^(success|warning|error)/i.test(l));
  const portRe = /^\d+(-\d+)?\/(tcp|udp|sctp)$/;
  const tail = ls.slice(-2).map(words);
  if (!tail.length || !tail.flat().every((w) => portRe.test(w) || /^[a-z][a-z0-9-]*$/.test(w))) return null;
  const ports = tail.flat().filter((w) => portRe.test(w));
  const svcs = (tail[tail.length - 1].every((w) => !portRe.test(w)) ? tail[tail.length - 1] : []).filter(Boolean);
  return (
    <>
      <Section title="开放端口" extra={`${ports.length} 个`}>
        {ports.length ? (
          <div className="tv-ips">
            {ports.map((p) => (
              <span key={p} className="badge mono">{p}</span>
            ))}
          </div>
        ) : (
          <div className="faint">无</div>
        )}
      </Section>
      <Section title="开放服务" extra={`${svcs.length} 个`}>
        {svcs.length ? (
          <div className="tv-ips">
            {svcs.map((p) => (
              <span key={p} className="badge mono">{p}</span>
            ))}
          </div>
        ) : (
          <div className="faint">无</div>
        )}
      </Section>
    </>
  );
};

function ufwView(s: string, active: boolean) {
  type R = { to: string; proto: string; action: string; dir: string; from: string; v4: boolean; v6: boolean };
  const map = new Map<string, R>();
  for (const l of s.split("\n")) {
    const m = /^(?:\[\s*\d+\]\s*)?(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)(?: (IN|OUT|FWD))?\s{2,}(.+?)\s*$/.exec(l);
    if (!m) continue;
    const v6 = /\(v6\)/.test(m[1]) || /\(v6\)/.test(m[4]);
    const to = m[1].replace(/\s*\(v6\)/, "");
    const from = m[4].replace(/\s*\(v6\)/, "").replace(/^Anywhere( on .*)?$/, "任意");
    const [port, proto] = to.split("/");
    const key = `${to}|${m[2]}|${m[3] ?? ""}|${from}`;
    const r = map.get(key) ?? { to: port.replace(/^Anywhere$/, "全部"), proto: proto ?? "全部", action: m[2], dir: m[3] ?? "IN", from, v4: false, v6: false };
    r[v6 ? "v6" : "v4"] = true;
    map.set(key, r);
  }
  const rows = [...map.values()];
  return (
    <>
      <div className="tv-status">
        <span className={"dot" + (active ? " ok" : "")} />
        <span>{active ? "已启用" : "未启用"}</span>
        <span className="faint tv-sec-extra">{rows.length} 条规则</span>
      </div>
      {rows.length > 0 && (
        <table className="table tv-table">
          <thead>
            <tr>
              <th className="num">端口</th>
              <th>协议</th>
              <th>动作</th>
              <th>来源</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="num mono">{r.to}</td>
                <td className="faint">{r.proto}</td>
                <td className={r.action === "ALLOW" ? "" : "tv-err"}>{(ACTION[r.action] ?? r.action) + (r.dir === "OUT" ? "（出）" : "")}</td>
                <td className={"mono ellipsis" + (r.from === "任意" ? " faint" : "")}>{r.from}</td>
                <td className="faint">{r.v4 && r.v6 ? "v4 + v6" : r.v6 ? "v6" : "v4"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---------- Fail2ban ----------
const fail2ban: View = (s) => {
  const jail = /Status for the jail:\s*(\S+)/.exec(s);
  if (!jail) return null;
  const num = (k: string) => new RegExp(`${k}:\\s*(\\d+)`).exec(s)?.[1] ?? "-";
  const ips = (/Banned IP list:\s*(.*)$/m.exec(s)?.[1] ?? "").split(/\s+/).filter(Boolean);
  const banned = num("Currently banned");
  return (
    <>
      <div className="tv-stats">
        <Stat label="当前失败" value={num("Currently failed")} />
        <Stat label="累计失败" value={num("Total failed")} />
        <Stat label="当前封禁" value={banned} tone={banned !== "-" && +banned > 0 ? "warn" : undefined} />
        <Stat label="累计封禁" value={num("Total banned")} />
      </div>
      <Section title={`已封禁 IP（${jail[1]}）`} extra={ips.length ? `${ips.length} 个` : undefined}>
        {ips.length ? (
          <div className="tv-ips">
            {ips.map((ip) => (
              <span key={ip} className="badge mono selectable">{ip}</span>
            ))}
          </div>
        ) : (
          <div className="faint">无</div>
        )}
      </Section>
    </>
  );
};

export const VIEWS: Record<string, View> = { disks, du, pingtest: ping, ports, firewall, fail2ban, users, logins, conns, ipinfo };
