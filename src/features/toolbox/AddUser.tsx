// Add a user: create the account, set up a key (1Password or the app's key store) or a password,
// optionally save the credentials to 1Password and the account as a new server entry.
import { useEffect, useState } from "react";
import { CommandPreview, ExecOutput, RunButton } from "../../components/CommandPreview";
import { toast, Toggle } from "../../components/ui";
import { api, errMsg, type ExecResult, type Host, type OpStatus, type OpVault } from "../../lib/api";
import { type RemoteEnv, runAsLabel, runScript, useNeedsSudoPassword } from "../../lib/remote";
import { useApp } from "../../store";
import { FieldInput } from "./ToolboxPanel";
import { CheckList, usePreCheck } from "./precheck";
import type { FieldDef, Issue, Values } from "./tools";

const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

// 1Password detection is a process spawn; once per app session is enough.
let opStatusP: Promise<OpStatus | null> | null = null;
const opStatus = () => (opStatusP ??= api.opStatus().catch(() => null));

/** Reads the public key and "user:password" from stdin so neither appears in the command line. */
function buildScript(u: string, admin: boolean, nopass: boolean, keyNote: string | null, pw: boolean): string {
  const s = [
    `U=${u}`,
    "read -r K; read -r P",
    'if id "$U" >/dev/null 2>&1; then echo "用户 $U 已存在，只更新登录方式"; else',
    '  SH=/bin/sh; [ -x /bin/bash ] && SH=/bin/bash',
    '  G=; getent group "$U" >/dev/null 2>&1 && G=1',
    '  if command -v useradd >/dev/null 2>&1; then useradd -m -s "$SH" ${G:+-g "$U"} "$U"; else adduser -D -s "$SH" ${G:+-G "$U"} "$U"; fi || exit 1',
    '  [ -n "$P" ] || usermod -p \'*\' "$U" 2>/dev/null || echo "$U:*" | chpasswd -e 2>/dev/null',
    "fi",
  ];
  if (admin) {
    s.push(
      'for g in sudo wheel; do getent group $g >/dev/null || continue; usermod -aG $g "$U" 2>/dev/null || addgroup "$U" $g; break; done',
    );
    if (nopass) s.push('echo "$U ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/$U && chmod 440 /etc/sudoers.d/$U');
  }
  if (keyNote)
    s.push(
      `# K = ${keyNote}`,
      'H=$(getent passwd "$U" | cut -d: -f6); G=$(id -gn "$U")',
      'mkdir -p "$H/.ssh" && echo "$K" >> "$H/.ssh/authorized_keys"',
      'chown -R "$U:$G" "$H/.ssh" && chmod 700 "$H/.ssh" && chmod 600 "$H/.ssh/authorized_keys"',
    );
  if (pw) s.push('echo "$U:$P" | chpasswd');
  s.push('echo "完成：$(id "$U")"');
  return s.join("\n");
}

/** Read-only probe for whatever already exists under this name (key=value lines). */
const checkScript = (u: string) => String.raw`U=${u}
if id "$U" >/dev/null 2>&1; then
  E=$(getent passwd "$U"); H=$(echo "$E" | cut -d: -f6)
  echo exists=1; echo uid=$(id -u "$U"); echo groups=$(id -nG "$U" | tr ' ' ,); echo home=$H
  [ -r "$H/.ssh/authorized_keys" ] && echo keys=$(grep -c '^ssh-\|^ecdsa-\|^sk-' "$H/.ssh/authorized_keys")
else
  getent group "$U" >/dev/null 2>&1 && echo group=1
  [ -e "/home/$U" ] && echo home=/home/$U
fi
[ -e "/etc/sudoers.d/$U" ] && echo sudoers=1
true`;


function issuesOf(c: Record<string, string>, u: string, admin: boolean, nopass: boolean, dupHost: Host | undefined, saveHost: boolean): Issue[] {
  const out: Issue[] = [];
  if (c.exists) {
    const isAdmin = (c.groups ?? "").split(",").some((g) => g === "sudo" || g === "wheel" || g === "admin");
    const parts = [`UID ${c.uid}`, isAdmin ? "管理员" : "普通用户", c.keys != null ? `${c.keys} 个公钥` : ""].filter(Boolean);
    out.push({ level: "err", text: `用户 ${u} 已存在（${parts.join("，")}）` });
    if (admin && !isAdmin) out.push({ level: "warn", text: "将加入 sudo 组" });
  } else {
    if (c.group) out.push({ level: "warn", text: `同名用户组 ${u} 已存在，将作为主组` });
    if (c.home) out.push({ level: "warn", text: `${c.home} 已存在，将沿用其中文件` });
  }
  if (c.sudoers && admin && nopass) out.push({ level: "warn", text: `将覆盖 /etc/sudoers.d/${u}` });
  if (saveHost && dupHost) out.push({ level: "warn", text: `服务器「${dupHost.name}」已存在，不再重复添加` });
  return out;
}

export function AddUserForm(props: { hostId: string; env: RemoteEnv }) {
  const { hostId, env } = props;
  const host = useApp((s) => s.hosts.find((h) => h.id === hostId));
  const [op, setOp] = useState<OpStatus | null>(null);
  const [vaults, setVaults] = useState<OpVault[]>([]);
  const [v, setV] = useState<Values>({ user: "", admin: true, nopass: true, auth: "appkey", pw: "", vault: "", save1p: true, saveHost: true });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const hosts = useApp((s) => s.hosts);
  const blocked = useNeedsSudoPassword(hostId, env);

  useEffect(() => {
    let alive = true;
    opStatus().then((s) => {
      if (!alive) return;
      setOp(s);
      if (s?.cli) {
        setV((x) => ({ ...x, auth: "opkey" }));
        api.opVaults(s.accounts[0]?.id).then((list) => {
          if (!alive) return;
          setVaults(list);
          setV((x) => ({ ...x, vault: list[0]?.id ?? "" }));
        }, () => {});
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const hasOp = !!op?.cli;
  const auth = String(v.auth);
  const isPw = auth === "password";
  const fields: FieldDef[] = [
    { key: "user", label: "用户名", type: "text", placeholder: "deploy" },
    { key: "admin", label: "管理员", type: "check" },
    ...(v.admin ? [{ key: "nopass", label: "sudo 免密", type: "check" } as FieldDef] : []),
    {
      key: "auth",
      label: "登录方式",
      type: "select",
      options: [
        ...(hasOp ? [{ value: "opkey", label: "1Password 生成密钥" }] : []),
        { value: "appkey", label: "生成密钥（本机保存）" },
        { value: "password", label: "密码" },
      ],
    },
    ...(isPw ? [{ key: "pw", label: "密码", type: "secret", gen: true } as FieldDef] : []),
    ...(hasOp && isPw ? [{ key: "save1p", label: "存入 1Password", type: "check" } as FieldDef] : []),
    ...(hasOp && (auth === "opkey" || (isPw && v.save1p)) && vaults.length > 1
      ? [{ key: "vault", label: "保管库", type: "select", options: vaults.map((x) => ({ value: x.id, label: x.name })) } as FieldDef]
      : []),
    { key: "saveHost", label: "添加为服务器", type: "check" },
  ];

  const u = String(v.user).trim();
  const pw = String(v.pw ?? "");
  const invalid = !u
    ? null
    : !USER_RE.test(u)
      ? "用户名：小写字母开头，可含数字、_ 和 -"
      : u === "root"
        ? "不能用 root"
        : isPw && !pw
          ? "请填写密码"
          : isPw && /[:\n]/.test(pw)
            ? "密码不能包含冒号或换行"
            : null;
  const keyNote = auth === "opkey" ? "执行时由 1Password 生成的公钥" : auth === "appkey" ? "执行时生成并保存在本机密钥库的公钥" : null;
  const script = buildScript(u || "<用户名>", !!v.admin, !!v.admin && !!v.nopass, keyNote, isPw);
  const label = `${u}@${host?.name ?? "server"}`;
  const url = host ? `ssh://${u}@${host.host}${host.port !== 22 ? `:${host.port}` : ""}` : "";
  const dupHost = host && hosts.find((h) => h.host === host.host && h.port === host.port && h.username === u);

  // Conflict check on the typed name.
  const checkable = !!u && USER_RE.test(u) && u !== "root";
  const chk = usePreCheck(hostId, env, checkable ? checkScript(u) : null);
  useEffect(() => setV((x) => ({ ...x, update: false })), [u]);
  const exists = !!chk.result?.exists;
  const issues = chk.result ? issuesOf(chk.result, u, !!v.admin, !!v.nopass, dupHost, !!v.saveHost) : [];
  const needAck = exists && !v.update;

  const run = async () => {
    if (!u || invalid || !host || chk.pending || needAck) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    const notes: string[] = [];
    try {
      // 1. Credentials.
      let pub = "";
      let keyId: string | null = null;
      let authType: Host["authType"] = "password";
      if (auth === "opkey") {
        const k = await api.opCreateSshKey(label, url, u, String(v.vault) || undefined, op?.accounts[0]?.id);
        pub = k.publicKey;
        keyId = k.fingerprint;
        authType = "agent";
        notes.push("已在 1Password 创建 SSH 密钥");
      } else if (auth === "appkey") {
        const k = await api.keyGenerate(label);
        pub = k.publicKey;
        keyId = k.id;
        authType = "key";
        notes.push(`已生成密钥「${k.name}」`);
      }
      // 2. Server side.
      const r = await runScript(hostId, env, script.replace("<用户名>", u), {
        priv: true,
        stdin: `${pub.trim()}\n${isPw ? pw : ""}\n`,
      });
      setResult(r);
      if (r.exitCode !== 0) throw new Error(notes.length ? `服务器执行失败（${notes.join("，")}）` : "服务器执行失败");
      // 3. Save.
      if (isPw && hasOp && v.save1p) {
        await api.opCreateLogin(label, url, u, pw, String(v.vault) || undefined, op?.accounts[0]?.id);
        notes.push("密码已存入 1Password");
      }
      if (v.saveHost && !dupHost) {
        await api.hostSave(
          {
            name: label,
            groupName: host.groupName,
            host: host.host,
            port: host.port,
            username: u,
            authType,
            keyId,
            jumpHostId: host.jumpHostId,
            proxyHost: host.proxyHost,
            proxyPort: host.proxyPort,
            proxyUser: host.proxyUser,
            tags: host.tags,
            color: host.color,
          },
          isPw ? pw : undefined,
        );
        await useApp.getState().refreshHosts();
        notes.push(`已添加服务器「${label}」`);
      }
      setResult({ ...r, stdout: `${r.stdout.trimEnd()}\n${notes.join("\n")}` });
      toast(exists ? `已更新用户 ${u}` : `已添加用户 ${u}`, "success");
      chk.retry();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tb-form">
      {fields.map((f) => (
        <FieldInput key={f.key} f={f} value={v[f.key]} onChange={(x) => setV({ ...v, [f.key]: x })} />
      ))}
      {invalid && <div className="tb-err">{invalid}</div>}
      {v.admin && !v.nopass && !isPw && <div className="tb-err">只用密钥登录时没有密码，sudo 将无法使用</div>}
      {checkable && (
        <CheckList issues={issues} pending={chk.pending} error={chk.error} onRetry={chk.retry}>
          {exists && (
            <label className="tb-check-row tb-check-ack">
              <Toggle on={!!v.update} onChange={(x) => setV({ ...v, update: x })} />
              更新已有用户：追加公钥{isPw ? "、重设密码" : ""}，不删除原有配置
            </label>
          )}
        </CheckList>
      )}
      <CommandPreview
        script={script}
        runAs={runAsLabel(env, true)}
        risk="change"
        note={v.admin ? "该用户将获得 root 权限" : undefined}
      />
      <div className="tb-actions">
        <RunButton
          risk="change"
          busy={busy}
          disabled={!u || !!invalid || blocked || !checkable || chk.pending || needAck}
          label={exists ? "更新用户" : undefined}
          onRun={run}
        />
        {blocked && <span className="faint tb-hint">先输入 sudo 密码</span>}
      </div>
      <ExecOutput result={result} error={err} />
    </div>
  );
}
