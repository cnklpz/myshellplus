// "Fill from 1Password" block at the top of the new-host dialog. Lists SSH key / server / login items
// through the `op` CLI (or only the agent's keys when the CLI is missing) and hands the parsed fields back.
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Select } from "../../components/Select";
import { api, errMsg, type OpHost, type OpItem, type OpStatus } from "../../lib/api";

const CATEGORY: Record<string, string> = { SSH_KEY: "SSH 密钥", AGENT: "SSH 密钥", SERVER: "服务器", LOGIN: "登录" };

export function OnePasswordImport(props: { status: OpStatus; onPick: (h: OpHost) => void }) {
  const { status } = props;
  const [account, setAccount] = useState(status.accounts[0]?.id ?? "");
  const [items, setItems] = useState<OpItem[] | null>(null);
  const [picked, setPicked] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState<"" | "list" | "item">("");
  const [msg, setMsg] = useState<{ err: boolean; text: string } | null>(null);

  const load = async (acc = account) => {
    setBusy("list");
    setMsg(null);
    try {
      setItems(await api.opItems(acc || undefined));
    } catch (e) {
      setMsg({ err: true, text: errMsg(e) });
    } finally {
      setBusy("");
    }
  };

  const apply = (h: OpHost) => {
    props.onPick(h);
    const got = [h.host && "地址", h.username && "用户名", h.keyFingerprint ? "密钥" : h.password ? "密码" : ""].filter(Boolean);
    setMsg(got.length ? { err: false, text: `已读取${got.join("、")}` } : { err: true, text: "条目中没有可用字段" });
  };

  const read = async (reference: string) => {
    if (!reference.trim()) return;
    setBusy("item");
    setMsg(null);
    try {
      apply(await api.opItem(reference.trim(), account || undefined));
    } catch (e) {
      setMsg({ err: true, text: errMsg(e) });
    } finally {
      setBusy("");
    }
  };

  const pick = (id: string) => {
    setPicked(id);
    const it = items?.find((x) => x.id === id);
    if (!it) return;
    // Agent-only fallback: the id is the key fingerprint, nothing else to read.
    if (it.category === "AGENT") apply({ title: it.title, host: "", username: "", keyFingerprint: it.id });
    else read(it.id);
  };

  return (
    <section className="he-sec">
      <h3 className="he-sec-title">1Password</h3>
      {status.accounts.length > 1 && (
        <div className="he-field">
          <div className="he-label">账号</div>
          <Select
            width="100%"
            value={account}
            options={status.accounts.map((a) => ({ value: a.id, label: a.email, hint: a.url }))}
            onChange={(v) => {
              setAccount(v);
              setPicked("");
              if (items) load(v);
            }}
          />
        </div>
      )}
      <div className="he-grid">
        <div className="he-field">
          <div className="he-label">
            <span>条目</span>
            {items && (
              <button type="button" className="link-btn" disabled={!!busy} onClick={() => load()}>
                刷新
              </button>
            )}
          </div>
          {items ? (
            <Select
              width="100%"
              value={picked}
              disabled={busy === "item"}
              options={[
                { value: "", label: items.length ? "选择条目" : "无可用条目" },
                ...items.map((it) => ({
                  value: it.id,
                  label: it.title || it.id,
                  text: it.title,
                  hint: [CATEGORY[it.category] ?? it.category, it.vault].filter(Boolean).join(" · "),
                })),
              ]}
              onChange={pick}
            />
          ) : (
            <button type="button" className="btn" disabled={!!busy} onClick={() => load()}>
              {busy === "list" ? <LoaderCircle className="spin" /> : <RefreshCw />}
              {busy === "list" ? "等待 1Password…" : "读取条目"}
            </button>
          )}
        </div>
        <div className="he-field">
          <div className="he-label">条目 ID</div>
          <div className="row">
            <input
              className="input mono"
              value={ref}
              disabled={!status.cli}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  read(ref);
                }
              }}
              placeholder={status.cli ? "op://Private/web-01" : "需要 1Password CLI"}
              spellCheck={false}
            />
            <button type="button" className="btn" style={{ flex: "none" }} disabled={!status.cli || !ref.trim() || !!busy} onClick={() => read(ref)}>
              {busy === "item" ? <LoaderCircle className="spin" /> : null}
              读取
            </button>
          </div>
        </div>
      </div>
      {msg ? (
        <div className={msg.err ? "he-err" : "he-note"}>{msg.text}</div>
      ) : (
        !status.cli && <div className="he-note">未安装 1Password CLI，只能读取密钥</div>
      )}
    </section>
  );
}
